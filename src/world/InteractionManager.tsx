"use client";

// Hover and click on the owned desks and the hub (invisible hit boxes), and the
// glowing outline on the floor around the highlighted agent's desk. A pointer
// that moved more than clickTolerancePx between down and up was an orbit drag.

import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { openAgent } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import { STATION_IDS, type StationId } from "@/shared/domain/agentTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { DESK_SIZE, HUB_RADIUS, STATIONS, stationOwner } from "@/shared/domain/worldLayout.ts";
import { makeAgentId } from "@/shared/ids.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { focusAgentDesk } from "./CameraController.tsx";
import { geometry, material, sharedGeometry, texture } from "./sharedResources.ts";
import { stationOfAgentId } from "./Workstations.tsx";

/** Stations you can click: the owned desks and the hub. */
const CLICKABLE: StationId[] = STATION_IDS.filter((id) => stationOwner(id) !== null);

/** Where the pointer went down (canvas pixels), to tell clicks from drags. */
const pointerDown = { x: 0, y: 0 };

export function rememberPointerDown(event: { clientX: number; clientY: number }): void {
  pointerDown.x = event.clientX;
  pointerDown.y = event.clientY;
}

function wasClick(event: { clientX: number; clientY: number }): boolean {
  return Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) <= CONFIG.world.clickTolerancePx;
}

/** Canvas onPointerMissed: a real click on empty space clears the 3D highlight (the side panel stays). */
export function handlePointerMissed(event: MouseEvent): void {
  if (event.type !== "click" || event.button !== 0 || !wasClick(event)) return;
  useWorldStore.getState().setDeskHighlight(null);
}

function selectStation(station: StationId): void {
  const store = useWorldStore.getState();
  const role = stationOwner(station);
  if (role === null || store.selectedProjectId === null) return;
  const agentId = makeAgentId(store.selectedProjectId, role);
  openAgent(agentId);
  store.setDeskHighlight(agentId);
  focusAgentDesk(agentId);
}

function HitBox({ station }: { station: StationId }) {
  const gl = useThree((s) => s.gl);
  const { center, kind } = STATIONS[station];
  const hub = kind === "console";
  const hitGeometry = useMemo(
    () =>
      hub
        ? sharedGeometry("hitHub", () => new THREE.CylinderGeometry(HUB_RADIUS + 0.15, HUB_RADIUS + 0.15, 1.3, 16).translate(0, 0.65, 0))
        : sharedGeometry("hitDesk", () => new THREE.BoxGeometry(DESK_SIZE.width + 0.2, 1.5, DESK_SIZE.depth + 1.0).translate(0, 0.75, 0.3)),
    [hub],
  );

  const over = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    useWorldStore.getState().setHovered(`station:${station}`);
    gl.domElement.style.cursor = "pointer";
  };
  const out = () => {
    if (useWorldStore.getState().hovered === `station:${station}`) useWorldStore.getState().setHovered(null);
    gl.domElement.style.cursor = "";
  };
  const click = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    if (event.button !== 0 || !wasClick(event.nativeEvent)) return;
    selectStation(station);
  };

  return <mesh geometry={hitGeometry} material={material.hit()} position={[center.x, 0, center.z]} onPointerOver={over} onPointerOut={out} onClick={click} />;
}

/** The highlighted desk's outline: a soft ring on the floor in the agent's colour. */
function SelectionRing() {
  const highlight = useWorldStore((s) => s.deskHighlight);
  const reducedMotion = useWorldStore((s) => s.reducedMotion);
  const mesh = useRef<THREE.Mesh>(null);
  const ringMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ map: texture.glowRing(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    [],
  );
  useEffect(() => () => ringMaterial.dispose(), [ringMaterial]);

  const station = highlight === null ? null : stationOfAgentId(highlight);
  const role = station === null ? null : stationOwner(station);
  useEffect(() => {
    if (role !== null) ringMaterial.color.set(ROLE_DEFINITIONS[role].color);
  }, [role, ringMaterial]);

  useFrame(({ clock }) => {
    if (mesh.current === null) return;
    ringMaterial.opacity = reducedMotion ? 0.9 : 0.75 + Math.sin(clock.elapsedTime * 2.2) * 0.2;
  });

  if (station === null) return null;
  const { center, kind } = STATIONS[station];
  const radius = kind === "console" ? HUB_RADIUS + 0.55 : 1.5;
  // Desks: centred between the desk and its chair.
  const z = kind === "console" ? center.z : center.z + 0.25;
  return <mesh ref={mesh} geometry={geometry.plane()} material={ringMaterial} rotation-x={-Math.PI / 2} position={[center.x, 0.012, z]} scale={[radius * 2, radius * 2, 1]} renderOrder={2} />;
}

export function InteractionManager() {
  return (
    <group>
      {CLICKABLE.map((station) => (
        <HitBox key={station} station={station} />
      ))}
      <SelectionRing />
    </group>
  );
}
