"use client";

// Blue hour outside, warm inside: cool moonlight with the only shadow map, a
// hemisphere fill, warm point lights over the desk clusters and the hub, and
// (high quality only) a procedural environment for reflections.

import { Environment, Lightformer } from "@react-three/drei";
import { useLayoutEffect, useRef } from "react";
import type * as THREE from "three";
import { CONFIG } from "@/shared/config.ts";
import { HUB_CENTER, STATIONS } from "@/shared/domain/worldLayout.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";

const WARM = "#ffb877";

/** Over each desk cluster, the hub and the shared places. */
const WARM_LIGHTS: { position: [number, number, number]; intensity: number; distance: number }[] = [
  { position: [-8.25, 2.8, -3.4], intensity: 16, distance: 10 },
  { position: [8.25, 2.8, -3.4], intensity: 16, distance: 10 },
  { position: [HUB_CENTER.x, 2.8, HUB_CENTER.z], intensity: 10, distance: 8 },
  { position: [STATIONS.collab.center.x, 2.6, STATIONS.collab.center.z], intensity: 9, distance: 7.5 },
  { position: [STATIONS.lounge.center.x, 2.6, STATIONS.lounge.center.z], intensity: 9, distance: 7.5 },
];

export function Lighting() {
  const quality = useWorldStore((s) => s.quality);
  const high = quality === "high";
  const moon = useRef<THREE.DirectionalLight>(null);

  useLayoutEffect(() => {
    const light = moon.current;
    if (light === null) return;
    const camera = light.shadow.camera;
    camera.left = -16;
    camera.right = 16;
    camera.top = 12;
    camera.bottom = -11;
    camera.near = 1;
    camera.far = 70;
    camera.updateProjectionMatrix();
  }, []);

  return (
    <>
      <hemisphereLight args={["#7a98d8", "#3a2a1c", 1.1]} />
      <directionalLight
        ref={moon}
        color="#b9cdf5"
        intensity={1.8}
        position={[-14, 24, 16]}
        castShadow={high}
        shadow-mapSize={[CONFIG.world.shadowMapSize, CONFIG.world.shadowMapSize]}
        shadow-radius={4}
        shadow-bias={-0.0004}
        shadow-normalBias={0.025}
      />
      {WARM_LIGHTS.map((light) => (
        <pointLight key={light.position.join(",")} color={WARM} position={light.position} intensity={light.intensity} distance={light.distance} decay={1.6} />
      ))}
      {high && (
        <Environment resolution={256} frames={1} environmentIntensity={0.45}>
          <Lightformer form="rect" intensity={2.2} color="#ffd2a1" position={[0, 6, 1]} rotation-x={Math.PI / 2} scale={[18, 10, 1]} />
          <Lightformer form="rect" intensity={1.6} color="#7f9de0" position={[0, 2.5, -12]} scale={[30, 5, 1]} />
          <Lightformer form="rect" intensity={0.6} color="#c9774f" position={[0, 0.8, -12]} scale={[30, 1.2, 1]} />
        </Environment>
      )}
    </>
  );
}
