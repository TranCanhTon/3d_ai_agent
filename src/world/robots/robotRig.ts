// A robot's joints (an Object3D tree that is never rendered) and the parts that
// hang off them. Every part kind is one InstancedMesh shared by all robots, so a
// robot costs no draw calls of its own: each frame the AgentsLayer poses the rig
// and copies each part's world matrix into its instance.

import * as THREE from "three";
import type { AgentRole } from "@/shared/domain/roles.ts";
import { sharedGeometry, sharedMaterial, mergedParts, roundedBox } from "../sharedResources.ts";
import type { Pose } from "./RobotAnimator.ts";

export const ROBOT_BODY_COLOR = "#c9d1dc";
export const ROBOT_OFFLINE_COLOR = "#6b7480";

/** Heights for bubbles, arcs and the hit capsule (scale 1). */
export const ROBOT_SIZE = { headTop: 1.34, chestStanding: 1.0, chestSitting: 0.96, hitHeight: 1.45, hitRadius: 0.32 } as const;

export const ROLE_SCALE: Record<AgentRole, number> = { orchestrator: 1.12, product_manager: 1, researcher: 1, engineer: 1, qa: 1, reviewer: 1 };

/** Accessory part per role (one silhouette each). */
export const ROLE_ACCESSORY: Record<AgentRole, PartKind> = {
  orchestrator: "crown",
  researcher: "lens",
  product_manager: "tablet",
  engineer: "headset",
  qa: "sensors",
  reviewer: "monocle",
};

export type PartKind =
  | "pelvis"
  | "torso"
  | "head"
  | "visor"
  | "eyes"
  | "chest"
  | "upperArm"
  | "foreArm"
  | "thigh"
  | "shin"
  | "crown"
  | "lens"
  | "tablet"
  | "headset"
  | "sensors"
  | "monocle";

export type PartMaterial = "body" | "dark" | "accent";

export const PART_KINDS: { kind: PartKind; material: PartMaterial; perRobot: number; accessoryOf?: AgentRole }[] = [
  { kind: "pelvis", material: "body", perRobot: 1 },
  { kind: "torso", material: "body", perRobot: 1 },
  { kind: "head", material: "body", perRobot: 1 },
  { kind: "visor", material: "dark", perRobot: 1 },
  { kind: "eyes", material: "accent", perRobot: 1 },
  { kind: "chest", material: "accent", perRobot: 1 },
  { kind: "upperArm", material: "body", perRobot: 2 },
  { kind: "foreArm", material: "body", perRobot: 2 },
  { kind: "thigh", material: "body", perRobot: 2 },
  { kind: "shin", material: "body", perRobot: 2 },
  { kind: "crown", material: "accent", perRobot: 1, accessoryOf: "orchestrator" },
  { kind: "lens", material: "accent", perRobot: 1, accessoryOf: "researcher" },
  { kind: "tablet", material: "accent", perRobot: 1, accessoryOf: "product_manager" },
  { kind: "headset", material: "accent", perRobot: 1, accessoryOf: "engineer" },
  { kind: "sensors", material: "accent", perRobot: 1, accessoryOf: "qa" },
  { kind: "monocle", material: "accent", perRobot: 1, accessoryOf: "reviewer" },
];

/** Robots are small on screen: low poly parts keep six of them (and their shadows) cheap. */
const capsule = (radius: number, length: number) => new THREE.CapsuleGeometry(radius, length, 3, 10);

export function partGeometry(kind: PartKind): THREE.BufferGeometry {
  return sharedGeometry(`robot:${kind}`, () => {
    switch (kind) {
      case "pelvis":
        return roundedBox(0.3, 0.13, 0.2, 0.05, 1).translate(0, 0.03, 0);
      case "torso":
        return capsule(0.17, 0.2).scale(1, 1, 0.82).translate(0, 0.25, 0);
      case "head":
        return roundedBox(0.3, 0.25, 0.27, 0.07, 2).translate(0, 0.13, 0);
      case "visor":
        return roundedBox(0.25, 0.12, 0.03, 0.02, 1).translate(0, 0.14, 0.126);
      case "eyes":
        return mergedParts([
          { geometry: new THREE.BoxGeometry(0.065, 0.026, 0.012), position: [-0.055, 0.145, 0.143] },
          { geometry: new THREE.BoxGeometry(0.065, 0.026, 0.012), position: [0.055, 0.145, 0.143] },
        ]);
      case "chest":
        return roundedBox(0.15, 0.065, 0.03, 0.012, 1).translate(0, 0.3, 0.135);
      case "upperArm":
        return capsule(0.05, 0.12).translate(0, -0.11, 0);
      case "foreArm":
        return mergedParts([
          { geometry: capsule(0.045, 0.1), position: [0, -0.1, 0] },
          { geometry: new THREE.SphereGeometry(0.055, 10, 6), position: [0, -0.215, 0] },
        ]);
      case "thigh":
        return capsule(0.065, 0.14).translate(0, -0.135, 0);
      case "shin":
        return mergedParts([
          { geometry: capsule(0.058, 0.14), position: [0, -0.13, 0] },
          { geometry: roundedBox(0.11, 0.06, 0.19, 0.025, 1), position: [0, -0.27, 0.035] },
        ]);
      case "crown": {
        const spikes = Array.from({ length: 5 }, (_, i) => {
          const angle = (i / 5) * Math.PI * 2;
          return { geometry: new THREE.ConeGeometry(0.026, 0.08, 6), position: [Math.sin(angle) * 0.105, 0.315, Math.cos(angle) * 0.105] as [number, number, number] };
        });
        return mergedParts([{ geometry: new THREE.CylinderGeometry(0.125, 0.12, 0.045, 16, 1, true), position: [0, 0.27, 0] }, ...spikes]);
      }
      case "lens":
        return mergedParts([
          { geometry: new THREE.CylinderGeometry(0.05, 0.055, 0.07, 14), position: [0.075, 0.2, 0.165], rotation: [Math.PI / 2, 0, 0] },
          { geometry: new THREE.TorusGeometry(0.06, 0.012, 6, 16), position: [0.075, 0.2, 0.2] },
        ]);
      case "tablet":
        return roundedBox(0.2, 0.015, 0.14, 0.01, 1).translate(0, -0.2, 0.09);
      case "headset":
        return mergedParts([
          { geometry: new THREE.TorusGeometry(0.162, 0.016, 6, 20, Math.PI), position: [0, 0.14, 0] },
          { geometry: new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14), position: [-0.162, 0.13, 0], rotation: [0, 0, Math.PI / 2] },
          { geometry: new THREE.CylinderGeometry(0.05, 0.05, 0.04, 14), position: [0.162, 0.13, 0], rotation: [0, 0, Math.PI / 2] },
          { geometry: new THREE.BoxGeometry(0.014, 0.014, 0.14), position: [0.17, 0.08, 0.07], rotation: [0, 0.35, 0] },
        ]);
      case "sensors":
        return mergedParts([
          { geometry: new THREE.CylinderGeometry(0.01, 0.01, 0.12, 6), position: [-0.08, 0.3, 0], rotation: [0, 0, 0.2] },
          { geometry: new THREE.CylinderGeometry(0.01, 0.01, 0.12, 6), position: [0.08, 0.3, 0], rotation: [0, 0, -0.2] },
          { geometry: new THREE.SphereGeometry(0.03, 10, 8), position: [-0.092, 0.365, 0] },
          { geometry: new THREE.SphereGeometry(0.03, 10, 8), position: [0.092, 0.365, 0] },
        ]);
      case "monocle":
        return mergedParts([
          { geometry: new THREE.TorusGeometry(0.048, 0.011, 6, 18), position: [-0.055, 0.145, 0.16] },
          { geometry: new THREE.BoxGeometry(0.008, 0.11, 0.008), position: [-0.1, 0.07, 0.14], rotation: [0, 0, 0.35] },
        ]);
    }
  });
}

export function partMaterial(kind: PartMaterial): THREE.Material {
  switch (kind) {
    case "body":
      return sharedMaterial("robotBody", () => new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.42, metalness: 0.25 }));
    case "dark":
      return sharedMaterial("robotVisor", () => new THREE.MeshStandardMaterial({ color: "#0b1018", roughness: 0.18, metalness: 0.6 }));
    case "accent":
      // White times the instance colour: one material for every agent colour.
      return sharedMaterial("robotAccent", () => new THREE.MeshBasicMaterial({ color: "#ffffff", toneMapped: false }));
  }
}

/** The joints of one robot. */
export class RobotRig {
  readonly root = new THREE.Group();
  readonly hips = new THREE.Group();
  readonly torso = new THREE.Group();
  readonly head = new THREE.Group();
  readonly shoulders = [new THREE.Group(), new THREE.Group()] as const;
  readonly elbows = [new THREE.Group(), new THREE.Group()] as const;
  readonly legs = [new THREE.Group(), new THREE.Group()] as const;
  readonly knees = [new THREE.Group(), new THREE.Group()] as const;
  /** Each part's node (the instance matrix is the node's world matrix). */
  readonly parts: { kind: PartKind; node: THREE.Object3D }[];

  constructor(readonly role: AgentRole) {
    this.root.add(this.hips);
    this.hips.add(this.torso);
    this.torso.position.y = 0.06;
    this.torso.add(this.head);
    this.head.position.y = 0.5;
    // Index 0 is the arm and leg on +x ("l" in a Pose).
    [0.215, -0.215].forEach((x, i) => {
      const shoulder = this.shoulders[i]!;
      shoulder.position.set(x, 0.4, 0);
      this.torso.add(shoulder);
      shoulder.add(this.elbows[i]!);
      this.elbows[i]!.position.y = -0.22;
    });
    [0.095, -0.095].forEach((x, i) => {
      const leg = this.legs[i]!;
      leg.position.x = x;
      this.hips.add(leg);
      leg.add(this.knees[i]!);
      this.knees[i]!.position.y = -0.27;
    });
    const accessory = ROLE_ACCESSORY[role];
    this.parts = [
      { kind: "pelvis", node: this.hips },
      { kind: "torso", node: this.torso },
      { kind: "chest", node: this.torso },
      { kind: "head", node: this.head },
      { kind: "visor", node: this.head },
      { kind: "eyes", node: this.head },
      { kind: "upperArm", node: this.shoulders[0] },
      { kind: "upperArm", node: this.shoulders[1] },
      { kind: "foreArm", node: this.elbows[0] },
      { kind: "foreArm", node: this.elbows[1] },
      { kind: "thigh", node: this.legs[0] },
      { kind: "thigh", node: this.legs[1] },
      { kind: "shin", node: this.knees[0] },
      { kind: "shin", node: this.knees[1] },
      // The tablet sits in the hand on +x; everything else is on the head.
      { kind: accessory, node: accessory === "tablet" ? this.elbows[0] : this.head },
    ];
  }

  /** Places the robot and sets every joint from the pose. */
  apply(pose: Pose, x: number, z: number, heading: number, scale: number): void {
    this.root.position.set(x, pose.bob * scale, z);
    this.root.rotation.set(0, heading, 0);
    this.root.scale.setScalar(scale);
    this.hips.position.y = pose.hipY;
    this.torso.rotation.set(pose.lean, pose.twist, 0);
    this.head.rotation.set(pose.headPitch, pose.headYaw, pose.headRoll, "YXZ");
    this.shoulders[0].rotation.set(pose.lShoulderX, 0, pose.lShoulderZ);
    this.shoulders[1].rotation.set(pose.rShoulderX, 0, pose.rShoulderZ);
    this.elbows[0].rotation.set(pose.lElbow, 0, 0);
    this.elbows[1].rotation.set(pose.rElbow, 0, 0);
    this.legs[0].rotation.set(pose.lHip, 0, 0);
    this.legs[1].rotation.set(pose.rHip, 0, 0);
    this.knees[0].rotation.set(pose.lKnee, 0, 0);
    this.knees[1].rotation.set(pose.rKnee, 0, 0);
    this.root.updateMatrixWorld(true);
  }
}
