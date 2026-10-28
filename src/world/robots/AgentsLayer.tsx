"use client";

// The robots of the selected project. The brain (robotBrain.ts) runs every
// tickMs on the store's state and the new events; every frame each robot follows
// its walk (position damped λ 12, heading λ 9), blends its pose (RobotAnimator)
// and writes its parts into the shared instanced meshes, its floor rings and its
// shadow blob. Hit capsules make robots clickable. Nothing here renders React
// per frame: the store is read with getState() inside useFrame.

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";
import { CONFIG, type RobotSettings } from "@/shared/config.ts";
import { ROLE_DEFINITIONS, type AgentRole } from "@/shared/domain/roles.ts";
import { arrived, createBrainState, stepBrain, type BrainEvent, type BrainState, type RobotView } from "@/shared/domain/robotBrain.ts";
import { pointAlong, SEAT_HEIGHT } from "@/shared/domain/worldLayout.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { openAgentQuietly } from "../CameraController.tsx";
import { ROBOT_HIT_KEY, wasClick } from "../InteractionManager.tsx";
import { geometry, material, sharedGeometry, sharedMaterial, texture } from "../sharedResources.ts";
import { angleDelta, blendPoses, damp, dampAngle, dampWeights, EMOTE_POSES, emptyPose, overlayUpper, POSE_KEYS, POSES, SIT_LIFT, walkPose, type Pose, type PoseContext, type PoseName } from "./RobotAnimator.ts";
import { robotFrames, robotViews } from "./robotFrame.ts";
import { PART_KINDS, partGeometry, partMaterial, ROBOT_BODY_COLOR, ROBOT_OFFLINE_COLOR, ROBOT_SIZE, ROLE_SCALE, RobotRig, type PartKind } from "./robotRig.ts";

const MAX_ROBOTS = 6;
const RINGS_PER_ROBOT = 4;
const AMBER = new THREE.Color("#f2b46a");
const GREEN = new THREE.Color("#6fe3a4");
const OFFLINE_RING = new THREE.Color("#5b6573");
const PULSE_MS = 900;
const SNAP_DISTANCE = 4;

/** ?idle=<seconds> shortens the idle delay (for testing). */
function robotSettings(): RobotSettings {
  const settings = CONFIG.world.robots;
  if (typeof window === "undefined") return settings;
  const idle = Number(new URLSearchParams(window.location.search).get("idle"));
  return Number.isFinite(idle) && idle > 0 ? { ...settings, idleDelayMs: idle * 1000 } : settings;
}

interface Motion {
  x: number;
  z: number;
  heading: number;
  speed: number;
  phase: number;
  listen: number;
  placed: boolean;
  weights: Partial<Record<PoseName, number>>;
  pose: Pose;
  clockOffset: number;
}

interface Robot {
  agentId: string;
  role: AgentRole;
  rig: RobotRig;
  motion: Motion;
  color: THREE.Color;
}

/** What a robot does at its place, as a pose name (sitting or standing). */
function poseName(view: RobotView, seated: boolean): PoseName {
  if (seated) {
    switch (view.pose) {
      case "work":
        return "sitWork";
      case "think":
        return "sitThink";
      case "nap":
        return "nap";
      case "offline":
        return "offlineSit";
      case "lounge":
        return "lounge";
      default:
        return view.place.seat === "sofa" ? "lounge" : "sitIdle";
    }
  }
  switch (view.pose) {
    case "work":
      return "standWork";
    case "think":
      return "standThink";
    case "nap":
      return "standNap";
    case "offline":
      return "offlineStand";
    case "talk":
      return "talk";
    case "raise_hand":
      return "raiseHand";
    case "look_around":
      return "lookAround";
    default:
      return "standIdle";
  }
}

function newMotion(index: number): Motion {
  return { x: 0, z: 0, heading: 0, speed: 0, phase: 0, listen: 0, placed: false, weights: {}, pose: emptyPose(), clockOffset: index * 1.37 };
}

/** Events of this project newer than `lastId` (the store keeps them newest first), oldest first. */
function newEvents(lastId: string | null, projectId: string): { events: BrainEvent[]; lastId: string | null } {
  const all = useWorldStore.getState().events;
  const fresh: BrainEvent[] = [];
  for (const event of all) {
    if (event.id === lastId) break;
    if (event.projectId === projectId) fresh.push({ type: event.type, agentId: event.agentId, targetAgentId: event.targetAgentId });
  }
  return { events: fresh.reverse(), lastId: all[0]?.id ?? lastId };
}

function ringMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterial(
    "robotRing",
    () => new THREE.MeshBasicMaterial({ map: texture.glowRing(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
  );
}

function blobMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterial("robotBlob", () => new THREE.MeshBasicMaterial({ color: "#000000", map: texture.dot(), transparent: true, opacity: 0.55, depthWrite: false }));
}

function hitGeometry(): THREE.BufferGeometry {
  return sharedGeometry("robotHit", () =>
    new THREE.CapsuleGeometry(ROBOT_SIZE.hitRadius, ROBOT_SIZE.hitHeight - ROBOT_SIZE.hitRadius * 2, 2, 8).translate(0, ROBOT_SIZE.hitHeight / 2, 0),
  );
}

// Scratch objects (one frame at a time).
const matrix = new THREE.Matrix4();
const ringRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchColor = new THREE.Color();
const anchor = new THREE.Vector3();
const projected = new THREE.Vector3();
const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

function writeFlat(mesh: THREE.InstancedMesh, index: number, x: number, y: number, z: number, size: number, color: THREE.Color): void {
  scratchPosition.set(x, y, z);
  scratchScale.set(size, size, size);
  mesh.setMatrixAt(index, size <= 0 ? hiddenMatrix : matrix.compose(scratchPosition, ringRotation, scratchScale));
  mesh.setColorAt(index, color);
}

export function AgentsLayer() {
  const projectId = useWorldStore((s) => s.selectedProjectId);
  const quality = useWorldStore((s) => s.quality);
  const roster = useWorldStore(
    useShallow((s) => s.snapshot?.agents.filter((a) => a.projectId === s.selectedProjectId).map((a) => `${a.id}|${a.role}`) ?? []),
  );
  const rosterKey = roster.join(",");

  const robots = useMemo<Robot[]>(
    () =>
      rosterKey === ""
        ? []
        : rosterKey
            .split(",")
            .slice(0, MAX_ROBOTS)
            .map((entry, index) => {
              const [agentId, role] = entry.split("|") as [string, AgentRole];
              return { agentId, role, rig: new RobotRig(role), motion: newMotion(index), color: new THREE.Color(ROLE_DEFINITIONS[role].color) };
            }),
    [rosterKey],
  );

  const settings = useMemo(() => robotSettings(), []);
  const brain = useRef<{ state: BrainState; lastTick: number; lastEventId: string | null; views: Map<string, RobotView> } | null>(null);
  const meshes = useRef(new Map<PartKind, THREE.InstancedMesh>());
  const rings = useRef<THREE.InstancedMesh>(null);
  const blobs = useRef<THREE.InstancedMesh>(null);
  const hits = useRef(new Map<string, THREE.Mesh>());
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);

  // A new project (or roster) starts a new brain; history is not replayed.
  useEffect(() => {
    brain.current = projectId === null ? null : { state: createBrainState(projectId), lastTick: 0, lastEventId: useWorldStore.getState().events[0]?.id ?? null, views: new Map() };
    robotFrames.clear();
    robotViews.list = [];
    return () => {
      robotFrames.clear();
      robotViews.list = [];
    };
  }, [projectId, rosterKey]);

  // Follow the reduced motion setting while the page is open.
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (query === undefined) return;
    const onChange = () => useWorldStore.getState().setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Instance colours: body grey, accents in the agent's colour (both exist before the first frame).
  useLayoutEffect(() => {
    for (const { kind, material: kindMaterial } of PART_KINDS) {
      const mesh = meshes.current.get(kind);
      if (mesh === undefined) continue;
      for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.setColorAt(i, scratchColor.set(kindMaterial === "accent" ? "#ffffff" : ROBOT_BODY_COLOR));
      mesh.count = 0;
    }
    for (const mesh of [rings.current, blobs.current]) {
      if (mesh === null) continue;
      for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.setColorAt(i, scratchColor.set("#ffffff"));
      mesh.count = 0;
    }
  }, [robots]);

  useFrame(({ clock }, delta) => {
    const memory = brain.current;
    const store = useWorldStore.getState();
    const snapshot = store.snapshot;
    if (memory === null || snapshot === null || projectId === null) return;
    const now = Date.now();
    const dt = Math.min(delta, 0.1);

    // ── Brain tick ──
    const project = snapshot.projects.find((p) => p.id === projectId);
    const offline = store.connectionStatus !== "open" || project?.archived === true;
    if (now - memory.lastTick >= settings.tickMs) {
      memory.lastTick = now;
      const { events, lastId } = newEvents(memory.lastEventId, projectId);
      memory.lastEventId = lastId;
      const agents = snapshot.agents.filter((a) => a.projectId === projectId);
      const askers = snapshot.tasks
        .filter((t) => t.projectId === projectId && t.endReason === null)
        .flatMap((t) => t.asks.filter((a) => a.outcome === "open").map((a) => a.agentId));
      const result = stepBrain(memory.state, {
        now,
        agents: agents.map((a) => ({ id: a.id, role: a.role, name: a.name, status: a.status, busy: a.busy, activity: a.activity })),
        askers,
        events,
        offline,
        reducedMotion: store.reducedMotion,
        settings,
      });
      memory.state = result.state;
      memory.views = new Map(result.robots.map((r) => [r.agentId, r]));
      robotViews.list = result.robots;
    }

    const reduced = store.reducedMotion;
    const lambdaPose = quality === "high" ? 8 : 14;
    const hoveredId = store.hovered?.startsWith("robot:") ? store.hovered.slice(6) : null;
    const insets = store.viewInsets;
    const fovScale = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const counts = new Map<PartKind, number>();
    const ringMesh = rings.current;
    const blobMesh = blobs.current;

    robots.forEach((robot, index) => {
      const view = memory.views.get(robot.agentId);
      const m = robot.motion;
      if (view === undefined) return;
      const agent = snapshot.agents.find((a) => a.id === robot.agentId);
      const scale = ROLE_SCALE[robot.role];

      // ── Movement: follow the walk ──
      const walk = view.walk;
      const walking = walk !== null && !arrived(view, now);
      let target = { x: view.place.x, z: view.place.z };
      let travel: number | null = null;
      if (walk !== null && walking) {
        const distance = (Math.max(0, now - walk.startedAt) / 1000) * walk.speed;
        target = pointAlong(walk.path, distance).point;
        // Turn toward a point a little ahead on the path (the next waypoint), never by snapping.
        const ahead = pointAlong(walk.path, distance + 0.45).point;
        if (Math.hypot(ahead.x - m.x, ahead.z - m.z) > 0.05) travel = Math.atan2(ahead.x - m.x, ahead.z - m.z);
      }
      if (!m.placed || Math.hypot(target.x - m.x, target.z - m.z) > SNAP_DISTANCE) {
        m.x = target.x;
        m.z = target.z;
        m.heading = view.place.facing;
        m.placed = true;
      }
      const px = m.x;
      const pz = m.z;
      m.x = damp(m.x, target.x, 12, dt);
      m.z = damp(m.z, target.z, 12, dt);
      const moved = Math.hypot(m.x - px, m.z - pz);
      m.speed = damp(m.speed, dt > 0 ? moved / dt : 0, 10, dt);
      const settled = !walking && Math.hypot(view.place.x - m.x, view.place.z - m.z) < 0.12;

      let facing = view.place.facing;
      if (travel !== null && m.speed > 0.15) facing = travel;
      else if (view.pose === "talk" && view.faceToward !== null) facing = Math.atan2(view.faceToward.x - m.x, view.faceToward.z - m.z);
      m.heading = dampAngle(m.heading, facing, 9, dt);

      // ── Pose ──
      const seated = settled && (view.place.seat === "chair" || view.place.seat === "sofa");
      const context: PoseContext = {
        t: clock.elapsedTime + m.clockOffset,
        breath: reduced || view.pose === "offline" ? 0 : 1,
        seatHip: (view.place.seat === "sofa" ? SEAT_HEIGHT.sofa : SEAT_HEIGHT.chair) + SIT_LIFT,
      };
      const weights = dampWeights(m.weights, settled ? poseName(view, seated) : "standIdle", lambdaPose, dt);
      blendPoses(
        m.pose,
        weights.map(([name, weight]) => [POSES[name](context), weight]),
      );
      // Legs swing with the real speed.
      m.phase += (m.speed * dt * Math.PI) / 0.42;
      const walkWeight = seated ? 0 : Math.min(1, m.speed / 1.2);
      if (walkWeight > 0.01) {
        const step = walkPose(m.phase);
        for (const key of POSE_KEYS) m.pose[key] += (step[key] - m.pose[key]) * walkWeight;
      }
      // Emotes and the wake up jolt over the upper body (reduced motion: the ring flash only).
      if (view.emote !== null && !reduced) {
        const p = Math.min(1, (now - view.emote.startedAt) / settings.emoteMs);
        overlayUpper(m.pose, EMOTE_POSES[view.emote.kind](p), Math.max(0, Math.min(1, p / 0.1, (1 - p) / 0.15)));
      }
      if (view.wakeUntil !== null && now < view.wakeUntil && !reduced) {
        const p = 1 - (view.wakeUntil - now) / settings.wakeMs;
        overlayUpper(m.pose, EMOTE_POSES.wake(p), Math.sin(p * Math.PI));
      }
      // A receiver turns its head and upper body toward the robot talking to it.
      const listenTarget = view.faceToward !== null && view.pose !== "talk" ? angleDelta(m.heading, Math.atan2(view.faceToward.x - m.x, view.faceToward.z - m.z)) : 0;
      m.listen = damp(m.listen, listenTarget, 5, dt);
      m.pose.twist += THREE.MathUtils.clamp(m.listen * 0.45, -0.55, 0.55);
      m.pose.headYaw += THREE.MathUtils.clamp(m.listen * 0.6, -0.85, 0.85);

      robot.rig.apply(m.pose, m.x, m.z, m.heading, scale);

      // ── Parts into their instanced meshes ──
      const greyed = view.ring === "offline";
      for (const part of robot.rig.parts) {
        const mesh = meshes.current.get(part.kind);
        if (mesh === undefined) continue;
        const i = counts.get(part.kind) ?? 0;
        counts.set(part.kind, i + 1);
        mesh.setMatrixAt(i, part.node.matrixWorld);
        const kind = PART_KINDS.find((p) => p.kind === part.kind)!;
        if (kind.material === "accent") mesh.setColorAt(i, greyed ? scratchColor.set(ROBOT_OFFLINE_COLOR) : robot.color);
        else if (kind.material === "body") mesh.setColorAt(i, scratchColor.set(greyed ? ROBOT_OFFLINE_COLOR : ROBOT_BODY_COLOR));
      }

      // ── Floor rings and the shadow blob ──
      if (ringMesh !== null) {
        const base = index * RINGS_PER_ROBOT;
        const t = clock.elapsedTime;
        const status = view.ring === "offline" ? scratchColor.copy(OFFLINE_RING).multiplyScalar(0.25) : scratchColor.copy(robot.color).multiplyScalar(view.ring === "working" ? 0.95 + (reduced ? 0 : Math.sin(t * 3) * 0.1) : 0.4);
        writeFlat(ringMesh, base, m.x, 0.014, m.z, 1.05 * scale, status);
        const needs = view.ring === "needs";
        writeFlat(ringMesh, base + 1, m.x, 0.016, m.z, needs ? 1.45 * scale : 0, scratchColor.copy(AMBER).multiplyScalar(reduced ? 0.9 : 0.55 + 0.45 * Math.sin(t * 4.2)));
        const selected = hoveredId === robot.agentId || store.deskHighlight === robot.agentId;
        writeFlat(ringMesh, base + 2, m.x, 0.018, m.z, selected ? 1.3 * scale : 0, scratchColor.setScalar(0.85));
        const pulse = view.emote === null ? 1 : (now - view.emote.startedAt) / PULSE_MS;
        const pulseColor = view.emote?.kind === "success" ? GREEN : AMBER;
        if (pulse < 1) {
          const strength = reduced ? Math.sin(pulse * Math.PI) : 1 - pulse;
          writeFlat(ringMesh, base + 3, m.x, 0.02, m.z, (reduced ? 1.25 : 1 + pulse * 1.6) * scale, scratchColor.copy(pulseColor).multiplyScalar(strength));
        } else writeFlat(ringMesh, base + 3, m.x, 0.02, m.z, 0, pulseColor);
      }
      if (blobMesh !== null) writeFlat(blobMesh, index, m.x, 0.011, m.z, 0.8 * scale, scratchColor.setScalar(1));

      // ── Hit capsule ──
      const hit = hits.current.get(robot.agentId);
      if (hit !== undefined) {
        hit.position.set(m.x, 0, m.z);
        hit.scale.setScalar(scale);
      }

      // ── Bubble anchor and the shared frame ──
      robot.rig.head.getWorldPosition(anchor);
      anchor.y += 0.34 * scale;
      const distance = camera.position.distanceTo(anchor);
      projected.copy(anchor).project(camera);
      const screenX = ((projected.x + 1) / 2) * size.width;
      const screenY = ((1 - projected.y) / 2) * size.height;
      const visible = projected.z > -1 && projected.z < 1 && screenX > insets.left + 8 && screenX < size.width - insets.right - 8 && screenY > insets.top + 8 && screenY < size.height - insets.bottom;
      robotFrames.set(robot.agentId, {
        agentId: robot.agentId,
        name: agent?.name ?? ROLE_DEFINITIONS[robot.role].name,
        color: ROLE_DEFINITIONS[robot.role].color,
        bubble: view.bubble,
        tone: view.tone,
        x: m.x,
        z: m.z,
        heading: m.heading,
        chestY: (seated ? ROBOT_SIZE.chestSitting : ROBOT_SIZE.chestStanding) * scale + m.pose.bob,
        screenX,
        screenY,
        scale: THREE.MathUtils.clamp(6.5 / (fovScale * distance), 0.72, 1.05),
        distance,
        visible,
      });
    });

    for (const { kind } of PART_KINDS) {
      const mesh = meshes.current.get(kind);
      if (mesh === undefined) continue;
      mesh.count = counts.get(kind) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
    for (const mesh of [ringMesh, blobMesh]) {
      if (mesh === null) continue;
      mesh.count = mesh === ringMesh ? robots.length * RINGS_PER_ROBOT : robots.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    }
  });

  const shadows = quality === "high";
  return (
    <group name="AgentsLayer">
      {PART_KINDS.map(({ kind, material: kindMaterial, perRobot, accessoryOf }) => (
        <instancedMesh
          key={kind}
          ref={(mesh) => {
            if (mesh === null) meshes.current.delete(kind);
            else meshes.current.set(kind, mesh);
          }}
          args={[partGeometry(kind), partMaterial(kindMaterial), accessoryOf === undefined ? MAX_ROBOTS * perRobot : 1]}
          castShadow={shadows}
          frustumCulled={false}
        />
      ))}
      <instancedMesh ref={rings} args={[geometry.plane(), ringMaterial(), MAX_ROBOTS * RINGS_PER_ROBOT]} frustumCulled={false} renderOrder={2} />
      <instancedMesh ref={blobs} args={[geometry.plane(), blobMaterial(), MAX_ROBOTS]} frustumCulled={false} renderOrder={1} />
      {robots.map((robot) => (
        <RobotHit key={robot.agentId} agentId={robot.agentId} hits={hits} />
      ))}
    </group>
  );
}

function RobotHit({ agentId, hits }: { agentId: string; hits: RefObject<Map<string, THREE.Mesh>> }) {
  const gl = useThree((s) => s.gl);
  const key = `robot:${agentId}`;
  const over = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    useWorldStore.getState().setHovered(key);
    gl.domElement.style.cursor = "pointer";
  };
  const out = () => {
    if (useWorldStore.getState().hovered === key) useWorldStore.getState().setHovered(null);
    gl.domElement.style.cursor = "";
  };
  const click = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.button !== 0 || !wasClick(event.nativeEvent)) return;
    // Selecting a robot opens its chat; the camera stays where it is.
    openAgentQuietly(agentId);
  };
  return (
    <mesh
      ref={(mesh) => {
        if (mesh === null) hits.current.delete(agentId);
        else hits.current.set(agentId, mesh);
      }}
      geometry={hitGeometry()}
      material={material.hit()}
      userData={{ [ROBOT_HIT_KEY]: agentId }}
      onPointerOver={over}
      onPointerOut={out}
      onClick={click}
    />
  );
}
