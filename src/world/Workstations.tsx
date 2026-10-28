"use client";

// The furniture: desks with monitors and chairs, name plates, the hub console,
// the wall screen, the planning board, the collaboration table and the lounge.
// Repeated parts are instanced (one draw call per kind). Hover and the selected
// desk brighten the monitors and name plates from useFrame, without React renders.

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useShallow } from "zustand/react/shallow";
import { STATION_IDS, type StationId } from "@/shared/domain/agentTypes.ts";
import { parseAgentId } from "@/shared/ids.ts";
import { ROLE_DEFINITIONS, type AgentRole } from "@/shared/domain/roles.ts";
import {
  COLLAB_TABLE_RADIUS,
  DESK_SIZE,
  HUB_CENTER,
  HUB_RADIUS,
  MISSION_CONTROL,
  PLANNING_BOARD,
  STATIONS,
  stationOwner,
} from "@/shared/domain/worldLayout.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { canvasTexture, geometry, makeCanvas, material, mergedParts, roundedBox, sharedGeometry, sharedMaterial, texture, uiFontFamily } from "./sharedResources.ts";
import { StaticInstances, type Placement } from "./StaticInstances.tsx";

const DESK_STATIONS = STATION_IDS.filter((id) => STATIONS[id].kind === "desk");
const MONITOR = { width: 0.56, height: 0.34, screenWidth: 0.52, screenHeight: 0.3, y: 1.08, z: -0.2 };
const SCREEN_LEVEL = { base: 0.6, selected: 0.72, hovered: 0.9 };
const PLATE_LEVEL = { base: 0.82, hovered: 1 };
const PLATE_TILT = -0.75;

/** Monitor x offsets and turn for a desk: the ops console has two, the others three. */
function monitorsFor(station: StationId): { x: number; turn: number }[] {
  return station === "ops"
    ? [
        { x: -0.3, turn: 0.12 },
        { x: 0.3, turn: -0.12 },
      ]
    : [
        { x: -0.58, turn: 0.3 },
        { x: 0, turn: 0 },
        { x: 0.58, turn: -0.3 },
      ];
}

/** Which screen instances belong to which station (for hover brightening). */
const SCREEN_STATIONS: StationId[] = DESK_STATIONS.flatMap((id) => monitorsFor(id).map(() => id));

function chairGeometry(): THREE.BufferGeometry {
  return sharedGeometry("chair", () =>
    mergedParts([
      { geometry: new THREE.BoxGeometry(0.5, 0.07, 0.46), position: [0, 0.47, 0] },
      { geometry: new THREE.BoxGeometry(0.46, 0.48, 0.06), position: [0, 0.78, 0.22], rotation: [-0.12, 0, 0] },
      { geometry: new THREE.CylinderGeometry(0.03, 0.03, 0.4, 10), position: [0, 0.25, 0] },
      { geometry: new THREE.CylinderGeometry(0.27, 0.27, 0.035, 5), position: [0, 0.04, 0] },
    ]),
  );
}

function monitorBodyGeometry(): THREE.BufferGeometry {
  return sharedGeometry("monitorBody", () =>
    mergedParts([
      { geometry: new THREE.BoxGeometry(MONITOR.width, MONITOR.height, 0.03), position: [0, 0, 0] },
      // Neck and base, down to the desk top (the body is placed at MONITOR.y).
      { geometry: new THREE.BoxGeometry(0.04, 0.17, 0.03), position: [0, DESK_SIZE.height - MONITOR.y + 0.0925, -0.04] },
      { geometry: new THREE.BoxGeometry(0.2, 0.015, 0.14), position: [0, DESK_SIZE.height - MONITOR.y + 0.0075, -0.04] },
    ]),
  );
}

/** Screens: the shared code texture, each instance starting at its own line. */
function screenMaterial(): THREE.MeshBasicMaterial {
  return sharedMaterial("screen", () => {
    const m = new THREE.MeshBasicMaterial({ map: texture.codeScreen(), color: "#ffffff" });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
#if defined( USE_MAP ) && defined( USE_INSTANCING )
  vMapUv.y += fract( float( gl_InstanceID ) * 0.381 );
#endif`,
      );
    };
    return m;
  });
}

function Desks() {
  const screens = useRef<THREE.InstancedMesh>(null);
  const reducedMotion = useWorldStore((s) => s.reducedMotion);

  const parts = useMemo(() => {
    const slabs: Placement[] = [];
    const legs: Placement[] = [];
    const chairs: Placement[] = [];
    const bodies: Placement[] = [];
    const screenList: Placement[] = [];
    for (const id of DESK_STATIONS) {
      const { x, z } = STATIONS[id].center;
      slabs.push({ position: [x, DESK_SIZE.height - 0.025, z] });
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          legs.push({ position: [x + sx * (DESK_SIZE.width / 2 - 0.08), 0, z + sz * (DESK_SIZE.depth / 2 - 0.08)], scale: [0.04, DESK_SIZE.height - 0.05, 0.04] });
        }
      }
      chairs.push({ position: [x, 0, z + 0.78], rotationY: 0 });
      for (const monitor of monitorsFor(id)) {
        const mx = x + monitor.x;
        const mz = z + MONITOR.z;
        bodies.push({ position: [mx, MONITOR.y, mz], rotationY: monitor.turn });
        screenList.push({
          position: [mx + Math.sin(monitor.turn) * 0.017, MONITOR.y, mz + Math.cos(monitor.turn) * 0.017],
          rotationY: monitor.turn,
          color: new THREE.Color().setScalar(SCREEN_LEVEL.base),
        });
      }
    }
    return { slabs, legs, chairs, bodies, screenList };
  }, []);

  const slab = useMemo(() => sharedGeometry("deskSlab", () => roundedBox(DESK_SIZE.width, 0.05, DESK_SIZE.depth, 0.02)), []);
  const leg = useMemo(() => sharedGeometry("deskLeg", () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0)), []);
  const screenGeometry = useMemo(() => sharedGeometry("screenPlane", () => new THREE.PlaneGeometry(MONITOR.screenWidth, MONITOR.screenHeight)), []);

  // Brighten the hovered (and the selected) desk's screens; scroll the code.
  const lastKey = useRef("");
  const color = useMemo(() => new THREE.Color(), []);
  useFrame((_, delta) => {
    const mesh = screens.current;
    if (mesh === null) return;
    if (!reducedMotion) {
      const map = (mesh.material as THREE.MeshBasicMaterial).map;
      if (map !== null) map.offset.y = (map.offset.y - delta * 0.012) % 1;
    }
    const { hovered, deskHighlight } = useWorldStore.getState();
    const highlightStation = deskHighlight === null ? null : stationOfAgentId(deskHighlight);
    const key = `${hovered}|${highlightStation}`;
    if (key === lastKey.current) return;
    lastKey.current = key;
    SCREEN_STATIONS.forEach((station, index) => {
      const level = hovered === `station:${station}` ? SCREEN_LEVEL.hovered : station === highlightStation ? SCREEN_LEVEL.selected : SCREEN_LEVEL.base;
      mesh.setColorAt(index, color.setScalar(level));
    });
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      <StaticInstances placements={parts.slabs} geometry={slab} material={material.desk()} shadows />
      <StaticInstances placements={parts.legs} geometry={leg} material={material.metal()} shadows />
      <StaticInstances placements={parts.chairs} geometry={chairGeometry()} material={material.chair()} shadows />
      <StaticInstances placements={parts.bodies} geometry={monitorBodyGeometry()} material={material.monitor()} shadows />
      <StaticInstances placements={parts.screenList} geometry={screenGeometry} material={screenMaterial()} meshRef={screens} />
    </group>
  );
}

/** The station of an agent id (`${projectId}:${role}`). */
export function stationOfAgentId(agentId: string): StationId | null {
  const parsed = parseAgentId(agentId);
  return parsed === null ? null : ROLE_DEFINITIONS[parsed.role].homeStation;
}

// ── Name plates ─────────────────────────────────────────────────────────────

const PLATE = { width: 0.9, height: 0.22, px: [768, 188] as const };

function drawPlate(ctx: CanvasRenderingContext2D, name: string, roleLabel: string, color: string): void {
  const [w, h] = PLATE.px;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e131b";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(183, 193, 207, 0.18)";
  ctx.fillRect(0, 0, w, 3);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 22, h);
  const family = uiFontFamily();
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#eef2f7";
  let size = 74;
  ctx.font = `700 ${size}px ${family}`;
  while (ctx.measureText(name).width > w - 70 && size > 30) {
    size -= 2;
    ctx.font = `700 ${size}px ${family}`;
  }
  ctx.fillText(name, 50, 98);
  ctx.fillStyle = "#8d98a8";
  ctx.font = `500 44px ${family}`;
  ctx.fillText(roleLabel, 50, 158);
}

function NamePlate({ station, role, name, position, tilt = PLATE_TILT }: { station: StationId; role: AgentRole; name: string; position: [number, number, number]; tilt?: number }) {
  const definition = ROLE_DEFINITIONS[role];
  const { canvas, ctx, plateTexture, plateMaterial } = useMemo(() => {
    const [c, context] = makeCanvas(PLATE.px[0], PLATE.px[1]);
    const t = canvasTexture(c);
    t.anisotropy = 8;
    const m = new THREE.MeshBasicMaterial({ map: t, toneMapped: false, color: new THREE.Color().setScalar(PLATE_LEVEL.base) });
    return { canvas: c, ctx: context, plateTexture: t, plateMaterial: m };
  }, []);

  useEffect(() => {
    let live = true;
    const draw = () => {
      if (!live) return;
      drawPlate(ctx, name, definition.roleLabel, definition.color);
      plateTexture.needsUpdate = true;
    };
    draw();
    // The UI font may still be loading: draw again once it is there.
    void document.fonts?.ready.then(draw);
    return () => {
      live = false;
    };
  }, [ctx, canvas, plateTexture, name, definition]);

  useEffect(
    () => () => {
      plateTexture.dispose();
      plateMaterial.dispose();
    },
    [plateTexture, plateMaterial],
  );

  useFrame(() => {
    const hovered = useWorldStore.getState().hovered === `station:${station}`;
    plateMaterial.color.setScalar(hovered ? PLATE_LEVEL.hovered : PLATE_LEVEL.base);
  });

  return (
    <group position={position} rotation-x={tilt}>
      <mesh geometry={plateGeometry()} material={material.darkMetal()} position-z={-0.021} />
      <mesh geometry={geometry.plane()} material={plateMaterial} scale={[PLATE.width, PLATE.height, 1]} />
    </group>
  );
}

/** The wedge behind a name plate. */
function plateGeometry(): THREE.BufferGeometry {
  return sharedGeometry("plateWedge", () => new THREE.BoxGeometry(PLATE.width + 0.03, PLATE.height + 0.03, 0.04));
}

function NamePlates() {
  const projectId = useWorldStore((s) => s.selectedProjectId);
  const names = useWorldStore(useShallow((s) => s.snapshot?.agents.filter((a) => a.projectId === projectId).map((a) => `${a.role}=${a.name}`) ?? []));
  const nameOf = (role: AgentRole) => names.find((entry) => entry.startsWith(`${role}=`))?.slice(role.length + 1) ?? ROLE_DEFINITIONS[role].name;

  return (
    <group>
      {DESK_STATIONS.map((id) => {
        const role = stationOwner(id);
        if (role === null) return null;
        const { x, z } = STATIONS[id].center;
        return <NamePlate key={id} station={id} role={role} name={nameOf(role)} position={[x, DESK_SIZE.height + 0.085, z + DESK_SIZE.depth / 2 - 0.1]} />;
      })}
      <NamePlate
        station="hub"
        role="orchestrator"
        name={nameOf("orchestrator")}
        position={[HUB_CENTER.x, 0.55, HUB_CENTER.z + HUB_RADIUS - 0.04]}
        tilt={-0.14}
      />
    </group>
  );
}

// ── Operations hub ──────────────────────────────────────────────────────────

function OperationsHub() {
  const reducedMotion = useWorldStore((s) => s.reducedMotion);
  const color = ROLE_DEFINITIONS.orchestrator.color;
  const body = useMemo(
    () =>
      sharedGeometry("hubBody", () =>
        mergedParts([
          { geometry: new THREE.CylinderGeometry(HUB_RADIUS - 0.12, HUB_RADIUS, 0.85, 48), position: [0, 0.425, 0] },
          { geometry: new THREE.CylinderGeometry(HUB_RADIUS + 0.05, HUB_RADIUS + 0.05, 0.06, 48), position: [0, 0.88, 0] },
        ]),
      ),
    [],
  );
  const ring = useMemo(() => sharedGeometry("hubRing", () => new THREE.RingGeometry(0.82, 0.98, 64).rotateX(-Math.PI / 2)), []);
  const inner = useMemo(() => sharedGeometry("hubInner", () => new THREE.CircleGeometry(0.72, 48).rotateX(-Math.PI / 2)), []);
  const ringMaterial = useMemo(() => sharedMaterial("hubRing", () => new THREE.MeshStandardMaterial({ color: "#000000", emissive: color, emissiveIntensity: 1.6, roughness: 0.4 })), [color]);
  const innerMaterial = useMemo(() => sharedMaterial("hubInner", () => new THREE.MeshStandardMaterial({ color: "#070b11", emissive: color, emissiveIntensity: 0.05, roughness: 0.3, metalness: 0.2, envMapIntensity: 0.3 })), [color]);

  useFrame(({ clock }) => {
    ringMaterial.emissiveIntensity = reducedMotion ? 1.6 : 1.45 + Math.sin(clock.elapsedTime * 1.4) * 0.35;
  });

  return (
    <group position={[HUB_CENTER.x, 0, HUB_CENTER.z]}>
      <mesh geometry={body} material={material.hub()} castShadow receiveShadow />
      <mesh geometry={ring} material={ringMaterial} position-y={0.915} />
      <mesh geometry={inner} material={innerMaterial} position-y={0.913} />
    </group>
  );
}

// ── Mission control (wall screen) ───────────────────────────────────────────

const SCREEN = { width: 8, height: 3, bottom: 1.4, px: [2048, 768] as const };

function drawMissionControl(ctx: CanvasRenderingContext2D, projectName: string): void {
  const [w, h] = SCREEN.px;
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, "#0c1422");
  gradient.addColorStop(1, "#070b12");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(124, 196, 214, 0.07)";
  ctx.lineWidth = 2;
  for (let x = 0; x <= w; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += 64) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  const family = uiFontFamily();
  ctx.textAlign = "center";
  ctx.fillStyle = "#7cc4d6";
  ctx.font = `600 52px ${family}`;
  ctx.fillText("OPERATIONS", w / 2, 250);
  ctx.fillStyle = "#eef2f7";
  ctx.font = `700 150px ${family}`;
  ctx.fillText("AI Agent World", w / 2, 410);
  ctx.fillStyle = "#b7c1cf";
  ctx.font = `500 76px ${family}`;
  ctx.fillText(projectName, w / 2, 530);
  ctx.fillStyle = "rgba(124, 196, 214, 0.5)";
  ctx.fillRect(w / 2 - 120, 580, 240, 4);
  ctx.textAlign = "start";
}

function MissionControl() {
  const projectName = useWorldStore((s) => s.snapshot?.projects.find((p) => p.id === s.selectedProjectId)?.name ?? "No project");
  const { ctx, screenTexture, screenMat } = useMemo(() => {
    const [c, context] = makeCanvas(SCREEN.px[0], SCREEN.px[1]);
    const t = canvasTexture(c);
    t.anisotropy = 8;
    return { ctx: context, screenTexture: t, screenMat: new THREE.MeshBasicMaterial({ map: t, toneMapped: false, color: new THREE.Color().setScalar(0.85) }) };
  }, []);
  useEffect(() => {
    let live = true;
    const draw = () => {
      if (!live) return;
      drawMissionControl(ctx, projectName);
      screenTexture.needsUpdate = true;
    };
    draw();
    void document.fonts?.ready.then(draw);
    return () => {
      live = false;
    };
  }, [ctx, screenTexture, projectName]);
  useEffect(
    () => () => {
      screenTexture.dispose();
      screenMat.dispose();
    },
    [screenTexture, screenMat],
  );

  const frame = useMemo(
    () =>
      sharedGeometry("missionFrame", () =>
        mergedParts([
          { geometry: new THREE.BoxGeometry(SCREEN.width + 0.24, SCREEN.height + 0.24, 0.12), position: [0, SCREEN.bottom + SCREEN.height / 2, -0.07] },
          { geometry: new THREE.BoxGeometry(0.14, SCREEN.bottom + 0.2, 0.14), position: [-2.6, (SCREEN.bottom + 0.2) / 2, -0.12] },
          { geometry: new THREE.BoxGeometry(0.14, SCREEN.bottom + 0.2, 0.14), position: [2.6, (SCREEN.bottom + 0.2) / 2, -0.12] },
          { geometry: new THREE.BoxGeometry(0.7, 0.05, 0.5), position: [-2.6, 0.025, -0.12] },
          { geometry: new THREE.BoxGeometry(0.7, 0.05, 0.5), position: [2.6, 0.025, -0.12] },
        ]),
      ),
    [],
  );

  return (
    <group position={[MISSION_CONTROL.x, 0, MISSION_CONTROL.z]}>
      <mesh geometry={frame} material={material.darkMetal()} castShadow />
      <mesh geometry={geometry.plane()} material={screenMat} position={[0, SCREEN.bottom + SCREEN.height / 2, 0]} scale={[SCREEN.width, SCREEN.height, 1]} />
    </group>
  );
}

// ── Planning board, collaboration table, lounge ─────────────────────────────

function PlanningBoard() {
  const stand = useMemo(
    () =>
      sharedGeometry("boardStand", () =>
        mergedParts([
          { geometry: new THREE.BoxGeometry(2.56, 1.56, 0.06), position: [0, 1.5, -0.03] },
          { geometry: new THREE.BoxGeometry(0.06, 1.9, 0.06), position: [-1.2, 0.95, -0.08] },
          { geometry: new THREE.BoxGeometry(0.06, 1.9, 0.06), position: [1.2, 0.95, -0.08] },
          { geometry: new THREE.BoxGeometry(0.08, 0.04, 0.7), position: [-1.2, 0.02, -0.08] },
          { geometry: new THREE.BoxGeometry(0.08, 0.04, 0.7), position: [1.2, 0.02, -0.08] },
          { geometry: new THREE.BoxGeometry(2.3, 0.04, 0.08), position: [0, 0.68, 0.02] },
        ]),
      ),
    [],
  );
  return (
    <group position={[PLANNING_BOARD.x, 0, PLANNING_BOARD.z]} rotation-y={PLANNING_BOARD.rotation}>
      <mesh geometry={stand} material={material.darkMetal()} castShadow receiveShadow />
      <mesh geometry={geometry.plane()} material={material.board()} position={[0, 1.5, 0.002]} scale={[2.4, 1.4, 1]} receiveShadow />
    </group>
  );
}

function CollabTable() {
  const { center, slots } = STATIONS.collab;
  const table = useMemo(
    () =>
      sharedGeometry("collabTable", () =>
        mergedParts([
          { geometry: new THREE.CylinderGeometry(COLLAB_TABLE_RADIUS, COLLAB_TABLE_RADIUS, 0.05, 48), position: [0, 0.745, 0] },
          { geometry: new THREE.CylinderGeometry(0.08, 0.1, 0.72, 16), position: [0, 0.36, 0] },
          { geometry: new THREE.CylinderGeometry(0.4, 0.42, 0.03, 32), position: [0, 0.015, 0] },
        ]),
      ),
    [],
  );
  const stool = useMemo(
    () =>
      sharedGeometry("stool", () =>
        mergedParts([
          { geometry: new THREE.CylinderGeometry(0.2, 0.19, 0.06, 24), position: [0, 0.47, 0] },
          { geometry: new THREE.CylinderGeometry(0.03, 0.03, 0.44, 10), position: [0, 0.22, 0] },
          { geometry: new THREE.CylinderGeometry(0.18, 0.2, 0.025, 24), position: [0, 0.0125, 0] },
        ]),
      ),
    [],
  );
  const stools = useMemo<Placement[]>(() => slots.map((slot) => ({ position: [slot.x, 0, slot.z] })), [slots]);
  return (
    <group>
      <mesh geometry={table} material={material.desk()} position={[center.x, 0, center.z]} castShadow receiveShadow />
      <StaticInstances placements={stools} geometry={stool} material={material.chair()} shadows />
    </group>
  );
}

function Lounge() {
  const { center, slots } = STATIONS.lounge;
  // Built facing +z (the sitter looks along +z), placed with each slot's facing.
  const sofa = useMemo(
    () =>
      sharedGeometry("sofa", () =>
        mergedParts([
          { geometry: roundedBox(0.95, 0.36, 0.78, 0.06), position: [0, 0.22, 0] },
          { geometry: roundedBox(0.95, 0.42, 0.16, 0.06), position: [0, 0.52, -0.33] },
          { geometry: roundedBox(0.14, 0.5, 0.78, 0.05), position: [-0.47, 0.27, 0] },
          { geometry: roundedBox(0.14, 0.5, 0.78, 0.05), position: [0.47, 0.27, 0] },
        ]),
      ),
    [],
  );
  const coffeeTable = useMemo(
    () =>
      sharedGeometry("coffeeTable", () =>
        mergedParts([
          { geometry: new THREE.CylinderGeometry(0.7, 0.7, 0.05, 40), position: [0, 0.4, 0] },
          { geometry: new THREE.CylinderGeometry(0.5, 0.55, 0.36, 32, 1, true), position: [0, 0.19, 0] },
        ]),
      ),
    [],
  );
  const sofas = useMemo<Placement[]>(
    () => slots.map((slot) => ({ position: [slot.x - Math.sin(slot.facing) * 0.1, 0, slot.z - Math.cos(slot.facing) * 0.1], rotationY: slot.facing })),
    [slots],
  );
  return (
    <group>
      <StaticInstances placements={sofas} geometry={sofa} material={material.sofa()} shadows />
      <mesh geometry={coffeeTable} material={material.wood()} position={[center.x, 0, center.z]} castShadow receiveShadow />
    </group>
  );
}

export function Workstations() {
  return (
    <group>
      <Desks />
      <NamePlates />
      <OperationsHub />
      <MissionControl />
      <PlanningBoard />
      <CollabTable />
      <Lounge />
      {/* The robots go here. */}
      <group name="AgentsLayer" />
    </group>
  );
}
