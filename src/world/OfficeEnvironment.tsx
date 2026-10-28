"use client";

// The room: tiled floor, the back window wall with a dusk sky and an instanced
// skyline behind it, dark side walls with a light strip, low glass partitions,
// potted plants and slowly drifting dust.

import { useFrame } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { CONFIG } from "@/shared/config.ts";
import { FLOOR, PARTITION_HEIGHT, PARTITION_THICKNESS, PARTITIONS, PLANTS } from "@/shared/domain/worldLayout.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { FLOOR_TILE_METRES, FLOOR_TILES_PER_TEXTURE, geometry, material, mergedParts, seeded, sharedGeometry, sharedMaterial, texture } from "./sharedResources.ts";
import { StaticInstances, type Placement } from "./StaticInstances.tsx";

const FLOOR_CENTER_Z = (FLOOR.minZ + FLOOR.maxZ) / 2;
export const WINDOW_HEIGHT = 4.4;
const SIDE_WALL_HEIGHT = 3.2;
const MULLION_STEP = 2.5;
/** The office is high up: the city's streets are this far below the floor. */
const CITY_BASE_Y = -30;

function Floor() {
  const span = FLOOR_TILE_METRES * FLOOR_TILES_PER_TEXTURE;
  const floorMaterial = useMemo(
    () =>
      sharedMaterial(
        "floor",
        () =>
          new THREE.MeshStandardMaterial({
            map: texture.floor(FLOOR.width / span, FLOOR.depth / span),
            roughnessMap: texture.floorRoughness(FLOOR.width / span, FLOOR.depth / span),
            roughness: 1,
            metalness: 0.12,
          }),
      ),
    [span],
  );
  return (
    <mesh geometry={geometry.plane()} material={floorMaterial} rotation-x={-Math.PI / 2} position={[0, 0, FLOOR_CENTER_Z]} scale={[FLOOR.width, FLOOR.depth, 1]} receiveShadow />
  );
}

function BackWall() {
  const frame = useMemo(() => {
    const parts: Parameters<typeof mergedParts>[0] = [];
    for (let x = FLOOR.minX; x <= FLOOR.maxX + 0.01; x += MULLION_STEP) {
      parts.push({ geometry: new THREE.BoxGeometry(0.08, WINDOW_HEIGHT, 0.12), position: [x, WINDOW_HEIGHT / 2, FLOOR.minZ] });
    }
    // Sill, a transom at door height and the header above the glass.
    parts.push({ geometry: new THREE.BoxGeometry(FLOOR.width, 0.12, 0.2), position: [0, 0.06, FLOOR.minZ] });
    parts.push({ geometry: new THREE.BoxGeometry(FLOOR.width, 0.05, 0.1), position: [0, 2.9, FLOOR.minZ] });
    parts.push({ geometry: new THREE.BoxGeometry(FLOOR.width + 0.3, 0.5, 0.3), position: [0, WINDOW_HEIGHT + 0.25, FLOOR.minZ] });
    return sharedGeometry("backWallFrame", () => mergedParts(parts));
  }, []);
  const sky = useMemo(() => sharedMaterial("sky", () => new THREE.MeshBasicMaterial({ map: texture.sky(), fog: false, toneMapped: false, depthWrite: false })), []);

  return (
    <group>
      <mesh geometry={frame} material={material.mullion()} castShadow receiveShadow />
      <mesh geometry={geometry.plane()} material={material.windowGlass()} position={[0, WINDOW_HEIGHT / 2, FLOOR.minZ + 0.01]} scale={[FLOOR.width, WINDOW_HEIGHT, 1]} />
      {/* The sky: far behind the skyline; its warm band sits on the horizon. */}
      <mesh geometry={geometry.plane()} material={sky} position={[0, CITY_BASE_Y + 40, -110]} scale={[340, 110, 1]} renderOrder={-1} />
    </group>
  );
}

function SideWalls() {
  const walls = useMemo(
    () =>
      sharedGeometry("sideWalls", () =>
        mergedParts(
          [-1, 1].map((side) => ({
            geometry: new THREE.BoxGeometry(0.2, SIDE_WALL_HEIGHT, FLOOR.depth),
            position: [side * (FLOOR.maxX + 0.1), SIDE_WALL_HEIGHT / 2, FLOOR_CENTER_Z] as [number, number, number],
          })),
        ),
      ),
    [],
  );
  const strips = useMemo(
    () =>
      sharedGeometry("sideStrips", () =>
        mergedParts(
          [-1, 1].map((side) => ({
            geometry: new THREE.BoxGeometry(0.02, 0.035, FLOOR.depth - 0.6),
            position: [side * (FLOOR.maxX - 0.01), 2.8, FLOOR_CENTER_Z] as [number, number, number],
          })),
        ),
      ),
    [],
  );
  return (
    <group>
      <mesh geometry={walls} material={material.wall()} receiveShadow />
      <mesh geometry={strips} material={material.lightStrip()} />
    </group>
  );
}

// ── Skyline ─────────────────────────────────────────────────────────────────

const MAX_TOWERS = Math.max(CONFIG.world.skylineTowers.high, CONFIG.world.skylineTowers.low);

/** Window cells scale with each tower's size; emissive light dims with distance (instance colour). */
function skylineMaterial(): THREE.MeshStandardMaterial {
  return sharedMaterial("skyline", () => {
    const m = new THREE.MeshStandardMaterial({
      color: "#0d131c",
      roughness: 0.75,
      metalness: 0.25,
      emissive: "#ffffff",
      emissiveMap: texture.skylineWindows(),
      emissiveIntensity: 1.1,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        "#include <uv_vertex>",
        `#include <uv_vertex>
#if defined( USE_EMISSIVEMAP ) && defined( USE_INSTANCING )
  vec2 towerSize = vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 1 ].xyz ) );
  vEmissiveMapUv = uv * towerSize / vec2( 4.0, 8.0 );
#endif`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
#ifdef USE_INSTANCING_COLOR
  totalEmissiveRadiance *= vColor;
#endif`,
      );
    };
    return m;
  });
}

function towerGeometry(): THREE.BufferGeometry {
  return sharedGeometry("tower", () => {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    // Roofs and bottoms sample the texture's dark corner, so they show no windows.
    const uv = box.getAttribute("uv") as THREE.BufferAttribute;
    for (let i = 8; i < 16; i++) uv.setXY(i, 0, 0);
    return box;
  });
}

function towerPlacements(): Placement[] {
  const random = seeded(21);
  const placements: Placement[] = [];
  for (let i = 0; i < MAX_TOWERS; i++) {
    const z = -14 - random() * 26;
    const depthShare = (-z - 14) / 26;
    const x = (random() * 2 - 1) * (60 + depthShare * 40);
    const height = 6 + Math.pow(random(), 1.6) * 34;
    const width = 3 + random() * 5;
    const shade = 1 - depthShare * 0.6;
    placements.push({
      position: [x, CITY_BASE_Y, z],
      rotationY: random() < 0.2 ? Math.PI / 4 : 0,
      scale: [width, height, 3 + random() * 5],
      color: new THREE.Color(shade, shade, shade),
    });
  }
  return placements;
}

function Skyline() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const quality = useWorldStore((s) => s.quality);
  const placements = useMemo(() => towerPlacements(), []);
  useLayoutEffect(() => {
    if (ref.current !== null) ref.current.count = CONFIG.world.skylineTowers[quality];
  }, [quality]);
  return <StaticInstances placements={placements} geometry={towerGeometry()} material={skylineMaterial()} meshRef={ref} />;
}

// ── Partitions ──────────────────────────────────────────────────────────────

function Partitions() {
  const [glass, frames] = useMemo(() => {
    const glassParts: Parameters<typeof mergedParts>[0] = [];
    const frameParts: Parameters<typeof mergedParts>[0] = [];
    for (const { from, to } of PARTITIONS) {
      const length = Math.hypot(to.x - from.x, to.z - from.z);
      const mid: [number, number, number] = [(from.x + to.x) / 2, 0, (from.z + to.z) / 2];
      const rotation: [number, number, number] = [0, Math.atan2(to.x - from.x, to.z - from.z) - Math.PI / 2, 0];
      glassParts.push({ geometry: new THREE.BoxGeometry(length, PARTITION_HEIGHT - 0.1, PARTITION_THICKNESS / 2), position: [mid[0], 0.07 + (PARTITION_HEIGHT - 0.1) / 2, mid[2]], rotation });
      frameParts.push({ geometry: new THREE.BoxGeometry(length + 0.04, 0.035, PARTITION_THICKNESS), position: [mid[0], PARTITION_HEIGHT, mid[2]], rotation });
      frameParts.push({ geometry: new THREE.BoxGeometry(length + 0.04, 0.06, PARTITION_THICKNESS), position: [mid[0], 0.03, mid[2]], rotation });
      for (const end of [from, to]) {
        frameParts.push({ geometry: new THREE.BoxGeometry(0.045, PARTITION_HEIGHT, 0.045), position: [end.x, PARTITION_HEIGHT / 2, end.z] });
      }
    }
    return [sharedGeometry("partitionGlass", () => mergedParts(glassParts)), sharedGeometry("partitionFrames", () => mergedParts(frameParts))];
  }, []);
  return (
    <group>
      <mesh geometry={frames} material={material.metal()} castShadow />
      <mesh geometry={glass} material={material.glass()} renderOrder={1} />
    </group>
  );
}

// ── Plants ──────────────────────────────────────────────────────────────────

function Plants() {
  const potGeometry = useMemo(() => sharedGeometry("pot", () => new THREE.CylinderGeometry(0.24, 0.18, 0.5, 20).translate(0, 0.25, 0)), []);
  const [pots, leaves] = useMemo(() => {
    const random = seeded(9);
    const leafColors = ["#2f6b4a", "#3d8158", "#285c42", "#4a8f5f"];
    const potList: Placement[] = [];
    const leafList: Placement[] = [];
    for (const plant of PLANTS) {
      const s = plant.scale;
      potList.push({ position: [plant.x, 0, plant.z], scale: s });
      const clumps = 5 + Math.floor(random() * 3);
      for (let i = 0; i < clumps; i++) {
        const angle = random() * Math.PI * 2;
        const spread = (0.05 + random() * 0.16) * s;
        const height = (0.6 + i * 0.13 + random() * 0.1) * s;
        const size = (0.2 + random() * 0.12) * s * (1 - i * 0.06);
        leafList.push({
          position: [plant.x + Math.cos(angle) * spread, height, plant.z + Math.sin(angle) * spread],
          rotationY: random() * Math.PI,
          scale: [size, size * (1.2 + random() * 0.5), size],
          color: leafColors[Math.floor(random() * leafColors.length)] as string,
        });
      }
    }
    return [potList, leafList];
  }, []);
  return (
    <group>
      <StaticInstances placements={pots} geometry={potGeometry} material={material.pot()} shadows />
      <StaticInstances placements={leaves} geometry={geometry.sphere()} material={material.leaf()} shadows />
    </group>
  );
}

// ── Dust ────────────────────────────────────────────────────────────────────

const MAX_MOTES = Math.max(CONFIG.world.dustMotes.high, CONFIG.world.dustMotes.low);

function Dust() {
  const quality = useWorldStore((s) => s.quality);
  const reducedMotion = useWorldStore((s) => s.reducedMotion);
  const points = useRef<THREE.Points>(null);
  const { base, positions } = useMemo(() => {
    const random = seeded(17);
    const start = new Float32Array(MAX_MOTES * 4);
    for (let i = 0; i < MAX_MOTES; i++) {
      start[i * 4] = FLOOR.minX + 1 + random() * (FLOOR.width - 2);
      start[i * 4 + 1] = 0.3 + random() * 3.2;
      start[i * 4 + 2] = FLOOR.minZ + 1 + random() * (FLOOR.depth - 2);
      start[i * 4 + 3] = random() * Math.PI * 2;
    }
    const current = new Float32Array(MAX_MOTES * 3);
    for (let i = 0; i < MAX_MOTES; i++) current.set([start[i * 4]!, start[i * 4 + 1]!, start[i * 4 + 2]!], i * 3);
    return { base: start, positions: current };
  }, []);
  const dustGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.5, FLOOR_CENTER_Z), 20);
    return g;
  }, [positions]);
  const dustMaterial = useMemo(
    () =>
      sharedMaterial(
        "dust",
        () =>
          new THREE.PointsMaterial({
            map: texture.dot(),
            color: "#cfe0ff",
            size: 0.05,
            sizeAttenuation: true,
            transparent: true,
            opacity: 0.22,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
      ),
    [],
  );
  useLayoutEffect(() => {
    dustGeometry.setDrawRange(0, CONFIG.world.dustMotes[quality]);
  }, [dustGeometry, quality]);
  useLayoutEffect(() => () => dustGeometry.dispose(), [dustGeometry]);

  useFrame(({ clock }) => {
    if (reducedMotion) return;
    const t = clock.elapsedTime;
    const count = CONFIG.world.dustMotes[useWorldStore.getState().quality];
    for (let i = 0; i < count; i++) {
      const phase = base[i * 4 + 3]!;
      positions[i * 3] = base[i * 4]! + Math.sin(t * 0.05 + phase) * 0.6;
      positions[i * 3 + 1] = base[i * 4 + 1]! + Math.sin(t * 0.11 + phase * 2) * 0.25;
      positions[i * 3 + 2] = base[i * 4 + 2]! + Math.cos(t * 0.04 + phase) * 0.6;
    }
    (dustGeometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  });

  return <points ref={points} geometry={dustGeometry} material={dustMaterial} />;
}

export function OfficeEnvironment() {
  return (
    <group>
      <Floor />
      <BackWall />
      <SideWalls />
      <Skyline />
      <Partitions />
      <Plants />
      <Dust />
    </group>
  );
}
