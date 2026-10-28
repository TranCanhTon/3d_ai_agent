"use client";

// Evening outside, a clearly lit office inside: cool moonlight with the only
// shadow map, a bright hemisphere and ambient fill, soft daylight from the ceiling
// panels (a light from straight above, no shadows), warm lights over the desk
// clusters, the hub and the walkway, and (high quality only) a procedural
// environment for reflections.

import { useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef } from "react";
import * as THREE from "three";
import { CONFIG } from "@/shared/config.ts";
import { HUB_CENTER, STATIONS } from "@/shared/domain/worldLayout.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";

const WARM = "#ffb877";

/** Over each desk cluster, the hub, the shared places and the walkway. */
const WARM_LIGHTS: { position: [number, number, number]; intensity: number; distance: number }[] = [
  { position: [-8.25, 2.8, -3.4], intensity: 16, distance: 10 },
  { position: [8.25, 2.8, -3.4], intensity: 16, distance: 10 },
  { position: [HUB_CENTER.x, 2.8, HUB_CENTER.z], intensity: 10, distance: 8 },
  { position: [STATIONS.collab.center.x, 2.6, STATIONS.collab.center.z], intensity: 9, distance: 7.5 },
  { position: [STATIONS.lounge.center.x, 2.6, STATIONS.lounge.center.z], intensity: 9, distance: 7.5 },
  { position: [-6, 3, 2.8], intensity: 8, distance: 9 },
  { position: [6, 3, 2.8], intensity: 8, distance: 9 },
];

/** Light panels for reflections: a warm one overhead, a cool one and a warm band at the window side. */
const LIGHT_PANELS: { color: string; intensity: number; position: [number, number, number]; rotationX: number; size: [number, number] }[] = [
  { color: "#ffd2a1", intensity: 2.2, position: [0, 6, 1], rotationX: Math.PI / 2, size: [18, 10] },
  { color: "#7f9de0", intensity: 1.6, position: [0, 2.5, -12], rotationX: 0, size: [30, 5] },
  { color: "#c9774f", intensity: 0.6, position: [0, 0.8, -12], rotationX: 0, size: [30, 1.2] },
];
const ENVIRONMENT_INTENSITY = 0.45;

let environment: THREE.Texture | null = null;

/**
 * The reflection map, prefiltered once and kept for the page's life. Building it
 * here rather than mounting drei's Environment per quality switch matters: the
 * renderer keeps a prefiltered copy of a mounted environment that is never freed.
 */
function officeEnvironment(gl: THREE.WebGLRenderer): THREE.Texture {
  if (environment !== null) return environment;
  const scene = new THREE.Scene();
  const geometry = new THREE.PlaneGeometry(1, 1);
  const materials: THREE.Material[] = [];
  for (const panel of LIGHT_PANELS) {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(panel.color).multiplyScalar(panel.intensity), side: THREE.DoubleSide, toneMapped: false });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...panel.position);
    mesh.rotation.x = panel.rotationX;
    mesh.scale.set(panel.size[0], panel.size[1], 1);
    scene.add(mesh);
  }
  const generator = new THREE.PMREMGenerator(gl);
  environment = generator.fromScene(scene, 0, 0.1, 100).texture;
  generator.dispose();
  geometry.dispose();
  for (const material of materials) material.dispose();
  return environment;
}

export function Lighting() {
  const quality = useWorldStore((s) => s.quality);
  const high = quality === "high";
  const moon = useRef<THREE.DirectionalLight>(null);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  // Reflections in high quality only.
  useEffect(() => {
    scene.environment = high ? officeEnvironment(gl) : null;
    scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    return () => {
      scene.environment = null;
    };
  }, [high, gl, scene]);

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
      <hemisphereLight args={["#dfe7f5", "#5a4a3a", 1.6]} />
      <ambientLight color="#f3efe8" intensity={0.5} />
      {/* The ceiling panels: soft light from straight above. */}
      <directionalLight color="#fff4e6" intensity={1.1} position={[0, 20, 0.5]} />
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
    </>
  );
}
