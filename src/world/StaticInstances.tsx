"use client";

// One InstancedMesh (one draw call) for many copies of the same piece of furniture.

import { useLayoutEffect, useRef } from "react";
import * as THREE from "three";

export interface Placement {
  position: [number, number, number];
  rotationY?: number;
  rotationX?: number;
  scale?: [number, number, number] | number;
  /** Per instance colour (multiplies the material colour). */
  color?: THREE.ColorRepresentation;
}

const matrix = new THREE.Matrix4();
const quaternion = new THREE.Quaternion();
const euler = new THREE.Euler();
const position = new THREE.Vector3();
const scale = new THREE.Vector3();
const color = new THREE.Color();

export function writePlacement(mesh: THREE.InstancedMesh, index: number, placement: Placement): void {
  position.set(...placement.position);
  euler.set(placement.rotationX ?? 0, placement.rotationY ?? 0, 0);
  quaternion.setFromEuler(euler);
  const s = placement.scale ?? 1;
  if (typeof s === "number") scale.set(s, s, s);
  else scale.set(...s);
  mesh.setMatrixAt(index, matrix.compose(position, quaternion, scale));
  if (placement.color !== undefined) mesh.setColorAt(index, color.set(placement.color));
}

export function StaticInstances({
  placements,
  geometry,
  material,
  shadows = false,
  receiveShadow = shadows,
  meshRef,
}: {
  placements: Placement[];
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Casts (and receives) shadows when the quality has them. */
  shadows?: boolean;
  receiveShadow?: boolean;
  meshRef?: React.RefObject<THREE.InstancedMesh | null>;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (mesh === null) return;
    placements.forEach((placement, index) => writePlacement(mesh, index, placement));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    if (meshRef !== undefined) meshRef.current = mesh;
  }, [placements, meshRef]);

  return <instancedMesh ref={ref} args={[geometry, material, placements.length]} castShadow={shadows} receiveShadow={receiveShadow} />;
}
