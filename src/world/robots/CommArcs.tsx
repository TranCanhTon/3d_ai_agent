"use client";

// The glowing arc of a handoff talk: a quadratic bezier between the two robots'
// chests, rising about 0.8 m, as a thin tube in the sender's colour, with three
// packets travelling from sender to receiver over the talk. Fades in and out over
// 0.3 s. At most `maxArcs` at once; their tube geometry is rebuilt in place.

import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CONFIG } from "@/shared/config.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { parseAgentId } from "@/shared/ids.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { sharedGeometry, sharedMaterial } from "../sharedResources.ts";
import { robotFrames, robotViews } from "./robotFrame.ts";

const SEGMENTS = 40;
const SIDES = 6;
const RADIUS = 0.018;
const RISE = 0.8;
const FADE_MS = 300;
const PACKETS = 3;

/** A tube with fixed topology; positions are written every frame. */
function makeTube(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array((SEGMENTS + 1) * SIDES * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const index: number[] = [];
  for (let i = 0; i < SEGMENTS; i++) {
    for (let j = 0; j < SIDES; j++) {
      const a = i * SIDES + j;
      const b = i * SIDES + ((j + 1) % SIDES);
      const c = (i + 1) * SIDES + j;
      const d = (i + 1) * SIDES + ((j + 1) % SIDES);
      index.push(a, c, b, b, c, d);
    }
  }
  geometry.setIndex(index);
  return geometry;
}

const from = new THREE.Vector3();
const to = new THREE.Vector3();
const control = new THREE.Vector3();
const point = new THREE.Vector3();
const tangent = new THREE.Vector3();
const side = new THREE.Vector3();
const normal = new THREE.Vector3();
const up = new THREE.Vector3(0, 1, 0);
const matrix = new THREE.Matrix4();
const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const color = new THREE.Color();
const white = new THREE.Color("#ffffff");

function bezier(t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  return out.set(u * u * from.x + 2 * u * t * control.x + t * t * to.x, u * u * from.y + 2 * u * t * control.y + t * t * to.y, u * u * from.z + 2 * u * t * control.z + t * t * to.z);
}

function writeTube(geometry: THREE.BufferGeometry): void {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    bezier(t, point);
    // Derivative of the quadratic bezier.
    tangent.set(
      2 * (1 - t) * (control.x - from.x) + 2 * t * (to.x - control.x),
      2 * (1 - t) * (control.y - from.y) + 2 * t * (to.y - control.y),
      2 * (1 - t) * (control.z - from.z) + 2 * t * (to.z - control.z),
    ).normalize();
    side.crossVectors(tangent, up).normalize();
    normal.crossVectors(side, tangent).normalize();
    for (let j = 0; j < SIDES; j++) {
      const angle = (j / SIDES) * Math.PI * 2;
      const c = Math.cos(angle) * RADIUS;
      const s = Math.sin(angle) * RADIUS;
      positions.setXYZ(i * SIDES + j, point.x + side.x * c + normal.x * s, point.y + side.y * c + normal.y * s, point.z + side.z * c + normal.z * s);
    }
  }
  positions.needsUpdate = true;
  geometry.computeBoundingSphere();
}

export function CommArcs() {
  const maxArcs = CONFIG.world.robots.maxArcs;
  const tubes = useMemo(() => Array.from({ length: maxArcs }, makeTube), [maxArcs]);
  const tubeMaterials = useMemo(
    () => Array.from({ length: maxArcs }, () => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })),
    [maxArcs],
  );
  useEffect(
    () => () => {
      for (const tube of tubes) tube.dispose();
      for (const m of tubeMaterials) m.dispose();
    },
    [tubes, tubeMaterials],
  );
  const meshes = useRef<(THREE.Mesh | null)[]>([]);
  const packets = useRef<THREE.InstancedMesh>(null);
  const packetGeometry = useMemo(() => sharedGeometry("arcPacket", () => new THREE.SphereGeometry(0.055, 10, 8)), []);
  const packetMaterial = useMemo(
    () => sharedMaterial("arcPacket", () => new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })),
    [],
  );

  useEffect(() => {
    const mesh = packets.current;
    if (mesh === null) return;
    for (let i = 0; i < mesh.instanceMatrix.count; i++) {
      mesh.setMatrixAt(i, hidden);
      mesh.setColorAt(i, white);
    }
  }, []);

  useFrame(() => {
    const now = Date.now();
    const reduced = useWorldStore.getState().reducedMotion;
    const links = robotViews.list.flatMap((view) => (view.link !== null && now >= view.link.startedAt && now < view.link.endsAt ? [view.link] : [])).slice(0, maxArcs);
    const packetMesh = packets.current;
    for (let k = 0; k < maxArcs; k++) {
      const mesh = meshes.current[k];
      const link = links[k];
      const sender = link === undefined ? undefined : robotFrames.get(link.from);
      const receiver = link === undefined ? undefined : robotFrames.get(link.to);
      if (mesh === null || mesh === undefined) continue;
      if (link === undefined || sender === undefined || receiver === undefined) {
        mesh.visible = false;
        if (packetMesh !== null) for (let p = 0; p < PACKETS; p++) packetMesh.setMatrixAt(k * PACKETS + p, hidden);
        continue;
      }
      from.set(sender.x, sender.chestY, sender.z);
      to.set(receiver.x, receiver.chestY, receiver.z);
      control.addVectors(from, to).multiplyScalar(0.5);
      // A quadratic peaks halfway to its control point: lift the control 2 × RISE above the chords' middle.
      control.y = (from.y + to.y) / 2 + RISE * 2;
      writeTube(tubes[k]!);
      const elapsed = now - link.startedAt;
      const fade = Math.max(0, Math.min(1, elapsed / FADE_MS, (link.endsAt - now) / FADE_MS));
      const tubeMaterial = tubeMaterials[k]!;
      const parsed = parseAgentId(link.from);
      tubeMaterial.color.set(parsed === null ? "#ffffff" : ROLE_DEFINITIONS[parsed.role].color);
      tubeMaterial.opacity = 0.85 * fade;
      mesh.visible = true;
      if (packetMesh === null) continue;
      const duration = link.endsAt - link.startedAt;
      for (let p = 0; p < PACKETS; p++) {
        // Staggered starts; each packet crosses in 60% of the talk. Reduced motion: no travelling packets.
        const t = (elapsed / duration - p * 0.2) / 0.6;
        if (reduced || t <= 0 || t >= 1) {
          packetMesh.setMatrixAt(k * PACKETS + p, hidden);
          continue;
        }
        bezier(t, point);
        packetMesh.setMatrixAt(k * PACKETS + p, matrix.makeTranslation(point.x, point.y, point.z));
        packetMesh.setColorAt(k * PACKETS + p, color.copy(tubeMaterial.color).lerp(white, 0.5).multiplyScalar(fade));
      }
    }
    if (packetMesh !== null) {
      packetMesh.instanceMatrix.needsUpdate = true;
      if (packetMesh.instanceColor !== null) packetMesh.instanceColor.needsUpdate = true;
    }
  });

  return (
    <group name="CommArcs">
      {tubes.map((tube, k) => (
        <mesh
          key={k}
          ref={(mesh) => {
            meshes.current[k] = mesh;
          }}
          geometry={tube}
          material={tubeMaterials[k]}
          visible={false}
          frustumCulled={false}
          renderOrder={3}
        />
      ))}
      <instancedMesh ref={packets} args={[packetGeometry, packetMaterial, maxArcs * PACKETS]} frustumCulled={false} renderOrder={3} />
    </group>
  );
}
