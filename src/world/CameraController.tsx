"use client";

// Orbit controls inside CAMERA_LIMITS plus requested moves (a preset or a desk
// focus) damped toward their goal. The view is fitted to the area the floating
// UI leaves free: the distance grows by fitFactor and a view offset puts the
// target in that area's centre. A drag or zoom cancels a move.

import { OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type ComponentRef } from "react";
import * as THREE from "three";
import { CONFIG } from "@/shared/config.ts";
import { parseAgentId } from "@/shared/ids.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { STATIONS } from "@/shared/domain/worldLayout.ts";
import { CAMERA_LIMITS, CAMERA_PRESETS, clampTarget, fitFactor, freeAreaShift } from "@/shared/ui/cameraPresets.ts";
import { useWorldStore, type CameraRequest } from "@/state/useWorldStore.ts";

interface Goal {
  target: THREE.Vector3;
  distance: number;
  polar: number;
  azimuth: number;
}

const EPSILON = 0.002;
const FOCUS_HEIGHT = 0.8;
/** A focus keeps the current horizontal angle and looks down at least / at most this much. */
const FOCUS_POLAR = { min: 0.75, max: 1.05 };

const offset = new THREE.Vector3();
const spherical = new THREE.Spherical();

function clampDistance(distance: number): number {
  return THREE.MathUtils.clamp(distance, CAMERA_LIMITS.minDistance, CAMERA_LIMITS.maxDistance);
}

function clampPolar(polar: number): number {
  return THREE.MathUtils.clamp(polar, CAMERA_LIMITS.minPolarAngle, CAMERA_LIMITS.maxPolarAngle);
}

/** Shortest signed angle from `from` to `to`. */
function angleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

/** Focus the desk (or hub console) of an agent of the selected project. */
export function focusAgentDesk(agentId: string): void {
  const store = useWorldStore.getState();
  const agent = store.snapshot?.agents.find((a) => a.id === agentId);
  if (agent === undefined || agent.projectId !== store.selectedProjectId) return;
  const parsed = parseAgentId(agentId);
  if (parsed === null) return;
  const { center } = STATIONS[ROLE_DEFINITIONS[parsed.role].homeStation];
  store.requestCamera({ focus: { x: center.x, y: FOCUS_HEIGHT, z: center.z }, distance: CONFIG.world.focusDistance });
}

export function CameraController() {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const size = useThree((s) => s.size);
  const goal = useRef<Goal | null>(null);
  const handledNonce = useRef(0);
  const lastFit = useRef<number | null>(null);
  const lastView = useRef("");

  const fitNow = () => fitFactor(size.width, size.height, useWorldStore.getState().viewInsets);

  /** Goal for a request, from where the camera is now. */
  const goalFor = (request: CameraRequest, fit: number): Goal | null => {
    const orbit = controls.current;
    if (orbit === null) return null;
    if (request.preset !== undefined) {
      const preset = CAMERA_PRESETS[request.preset];
      offset.set(preset.position.x - preset.target.x, preset.position.y - preset.target.y, preset.position.z - preset.target.z);
      spherical.setFromVector3(offset);
      const target = clampTarget(preset.target);
      return { target: new THREE.Vector3(target.x, target.y, target.z), distance: clampDistance(spherical.radius * fit), polar: clampPolar(spherical.phi), azimuth: spherical.theta };
    }
    if (request.focus !== undefined) {
      spherical.setFromVector3(offset.copy(camera.position).sub(orbit.target));
      const target = clampTarget(request.focus);
      return {
        target: new THREE.Vector3(target.x, target.y, target.z),
        distance: clampDistance((request.distance ?? CONFIG.world.focusDistance) * fit),
        polar: THREE.MathUtils.clamp(spherical.phi, FOCUS_POLAR.min, FOCUS_POLAR.max),
        azimuth: spherical.theta,
      };
    }
    return null;
  };

  // Start at the overview, fitted, without a move.
  useEffect(() => {
    const orbit = controls.current;
    if (orbit === null) return;
    const start = goalFor({ nonce: 0, preset: "overview" }, fitNow());
    if (start === null) return;
    orbit.target.copy(start.target);
    camera.position.copy(start.target).add(offset.setFromSphericalCoords(start.distance, start.polar, start.azimuth));
    orbit.update();
    lastFit.current = fitNow();
    handledNonce.current = useWorldStore.getState().cameraRequest?.nonce ?? 0;
    // Only once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Choosing an agent anywhere (roster, activity, permission card, a desk) focuses its desk.
  useEffect(
    () =>
      useWorldStore.subscribe((state, previous) => {
        if (state.selectedAgentId !== null && state.selectedAgentId !== previous.selectedAgentId) focusAgentDesk(state.selectedAgentId);
      }),
    [],
  );

  // Fit the view offset to the free area when the canvas or the floating UI changes size.
  const applyViewOffset = () => {
    const insets = useWorldStore.getState().viewInsets;
    const key = `${size.width}x${size.height}|${insets.left},${insets.top},${insets.right},${insets.bottom}`;
    if (key === lastView.current) return;
    lastView.current = key;
    const shift = freeAreaShift(size.width, size.height, insets);
    camera.setViewOffset(size.width, size.height, -shift.x, -shift.y, size.width, size.height);
    camera.updateProjectionMatrix();
  };

  useFrame((_, delta) => {
    const orbit = controls.current;
    if (orbit === null) return;
    applyViewOffset();
    const dt = Math.min(delta, 0.1);

    const fit = fitNow();
    const request = useWorldStore.getState().cameraRequest;
    if (request !== null && request.nonce !== handledNonce.current) {
      handledNonce.current = request.nonce;
      goal.current = goalFor(request, fit);
    } else if (lastFit.current !== null && Math.abs(fit - lastFit.current) > 1e-3) {
      // The panel opened or closed: keep the view, scaled to the new free area.
      const ratio = fit / lastFit.current;
      if (goal.current !== null) goal.current.distance = clampDistance(goal.current.distance * ratio);
      else {
        spherical.setFromVector3(offset.copy(camera.position).sub(orbit.target));
        goal.current = { target: orbit.target.clone(), distance: clampDistance(spherical.radius * ratio), polar: spherical.phi, azimuth: spherical.theta };
      }
    }
    lastFit.current = fit;

    const move = goal.current;
    if (move !== null) {
      const { target: lambdaTarget, distance: lambdaDistance, angle: lambdaAngle } = CONFIG.world.cameraDamping;
      spherical.setFromVector3(offset.copy(camera.position).sub(orbit.target));
      const target = orbit.target;
      target.set(
        THREE.MathUtils.damp(target.x, move.target.x, lambdaTarget, dt),
        THREE.MathUtils.damp(target.y, move.target.y, lambdaTarget, dt),
        THREE.MathUtils.damp(target.z, move.target.z, lambdaTarget, dt),
      );
      const radius = THREE.MathUtils.damp(spherical.radius, move.distance, lambdaDistance, dt);
      const polar = THREE.MathUtils.damp(spherical.phi, move.polar, lambdaAngle, dt);
      const turn = angleDelta(spherical.theta, move.azimuth);
      const azimuth = spherical.theta + turn * (1 - Math.exp(-lambdaAngle * dt));
      camera.position.copy(target).add(offset.setFromSphericalCoords(radius, polar, azimuth));
      const settled =
        target.distanceTo(move.target) < EPSILON * 10 && Math.abs(radius - move.distance) < EPSILON * 20 && Math.abs(polar - move.polar) < EPSILON && Math.abs(angleDelta(azimuth, move.azimuth)) < EPSILON;
      if (settled) goal.current = null;
    }

    // Keep the orbit target inside the office (panning cannot leave it).
    const t = orbit.target;
    const clamped = clampTarget(t);
    if (clamped.x !== t.x || clamped.y !== t.y || clamped.z !== t.z) {
      camera.position.add(offset.set(clamped.x - t.x, clamped.y - t.y, clamped.z - t.z));
      t.set(clamped.x, clamped.y, clamped.z);
    }
  });

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={CAMERA_LIMITS.minDistance}
      maxDistance={CAMERA_LIMITS.maxDistance}
      minPolarAngle={CAMERA_LIMITS.minPolarAngle}
      maxPolarAngle={CAMERA_LIMITS.maxPolarAngle}
      onStart={() => {
        goal.current = null;
        useWorldStore.getState().setActivePreset(null);
      }}
    />
  );
}
