"use client";

// The office camera: a fixed angle that never rotates. Dragging (left or right
// button) slides the view over the floor like a map, the wheel zooms, both damped
// and kept inside the limits from cameraView.ts (which follow the free area left
// of the side panel). Requests from the store move it back to the overview or to
// an agent's desk.

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { CONFIG } from "@/shared/config.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { STATIONS } from "@/shared/domain/worldLayout.ts";
import { parseAgentId } from "@/shared/ids.ts";
import { CAMERA, cameraPosition, clampDistance, clampTarget, floorOffset, freeAreaShift, overview, type FloorPoint, type ViewSize } from "@/shared/ui/cameraView.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";

interface Pose {
  target: FloorPoint;
  distance: number;
}

/** Wheel notches to zoom: one notch (100) is about 12%. */
const ZOOM_PER_DELTA = 0.0012;
const SETTLED = 0.001;

/** Focus the desk (or hub console) of an agent of the selected project; `keepZoom` only pans (Locate). */
export function focusAgentDesk(agentId: string, keepZoom = false): void {
  const store = useWorldStore.getState();
  const agent = store.snapshot?.agents.find((a) => a.id === agentId);
  if (agent === undefined || agent.projectId !== store.selectedProjectId) return;
  const parsed = parseAgentId(agentId);
  if (parsed === null) return;
  const { center } = STATIONS[ROLE_DEFINITIONS[parsed.role].homeStation];
  const point = { x: center.x, y: 0, z: center.z };
  store.requestCamera(keepZoom ? { pan: point } : { focus: point });
}

export function CameraController() {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const current = useRef<Pose | null>(null);
  const goal = useRef<Pose | null>(null);
  const handledNonce = useRef(useWorldStore.getState().cameraRequest?.nonce ?? 0);
  const lastView = useRef("");

  const view = (): ViewSize => ({ width: size.width, height: size.height, insets: useWorldStore.getState().viewInsets });

  // Choosing an agent anywhere (avatar, activity, permission card, a desk) focuses its desk.
  useEffect(
    () =>
      useWorldStore.subscribe((state, previous) => {
        if (state.selectedAgentId !== null && state.selectedAgentId !== previous.selectedAgentId) focusAgentDesk(state.selectedAgentId);
      }),
    [],
  );

  // Drag to pan (left or right button), wheel to zoom. No rotation anywhere.
  useEffect(() => {
    const element = gl.domElement;
    let drag: { id: number; x: number; y: number } | null = null;

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    };
    const onMove = (event: PointerEvent) => {
      if (drag === null || drag.id !== event.pointerId || current.current === null || goal.current === null) return;
      const rect = element.getBoundingClientRect();
      const v = view();
      const from = floorOffset(v, drag.x - rect.left, drag.y - rect.top, current.current.distance);
      const to = floorOffset(v, event.clientX - rect.left, event.clientY - rect.top, current.current.distance);
      drag = { ...drag, x: event.clientX, y: event.clientY };
      if (from === null || to === null) return;
      // The floor point under the pointer stays under it.
      const dx = from.x - to.x;
      const dz = from.z - to.z;
      for (const pose of [current.current, goal.current]) {
        pose.target = clampTarget(v, { x: pose.target.x + dx, z: pose.target.z + dz }, pose.distance);
      }
    };
    const onUp = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) drag = null;
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (goal.current === null) return;
      goal.current.distance = clampDistance(view(), goal.current.distance * Math.exp(event.deltaY * ZOOM_PER_DELTA));
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();

    element.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("contextmenu", onContextMenu);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("contextmenu", onContextMenu);
    };
    // view() reads the latest size and insets when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, size.width, size.height]);

  useFrame((_, delta) => {
    const v = view();
    const insets = v.insets;

    // The target sits in the middle of the free area.
    const key = `${v.width}x${v.height}|${insets.left},${insets.top},${insets.right},${insets.bottom}`;
    if (key !== lastView.current) {
      lastView.current = key;
      const shift = freeAreaShift(v.width, v.height, insets);
      camera.fov = CAMERA.fov;
      camera.setViewOffset(v.width, v.height, -shift.x, -shift.y, v.width, v.height);
      camera.updateProjectionMatrix();
    }

    if (current.current === null || goal.current === null) {
      const start = overview(v);
      current.current = { target: { ...start.target }, distance: start.distance };
      goal.current = { target: { ...start.target }, distance: start.distance };
    }

    const request = useWorldStore.getState().cameraRequest;
    if (request !== null && request.nonce !== handledNonce.current) {
      handledNonce.current = request.nonce;
      if (request.overview === true) goal.current = overview(v);
      else if (request.focus !== undefined) {
        const distance = clampDistance(v, CONFIG.world.focusDistance);
        goal.current = { target: clampTarget(v, request.focus, distance), distance };
      } else if (request.pan !== undefined) {
        // Locate: slide to the point at the zoom I have now.
        const distance = goal.current.distance;
        goal.current = { target: clampTarget(v, request.pan, distance), distance };
      }
    }

    // The limits follow the free area (the panel may have opened or closed).
    const target = goal.current;
    target.distance = clampDistance(v, target.distance);
    target.target = clampTarget(v, target.target, target.distance);

    const now = current.current;
    const dt = Math.min(delta, 0.1);
    const { target: lambdaTarget, distance: lambdaDistance } = CONFIG.world.cameraDamping;
    const distance = THREE.MathUtils.damp(now.distance, target.distance, lambdaDistance, dt);
    now.distance = Math.abs(distance - target.distance) < SETTLED ? target.distance : distance;
    const moved = {
      x: THREE.MathUtils.damp(now.target.x, target.target.x, lambdaTarget, dt),
      z: THREE.MathUtils.damp(now.target.z, target.target.z, lambdaTarget, dt),
    };
    now.target = clampTarget(v, moved, now.distance);

    const position = cameraPosition(now.target, now.distance);
    camera.position.set(position.x, position.y, position.z);
    camera.rotation.set(-CAMERA.pitch, 0, 0);
  });

  return null;
}
