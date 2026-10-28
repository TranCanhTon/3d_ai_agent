// Camera presets for the 3D office, the orbit limits that keep the camera inside
// it, and the fit that keeps a preset's view inside the part of the screen the
// floating UI leaves free. Framework free (tested by scripts/test.ts).

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const CAMERA_PRESET_IDS = ["overview", "hub", "development", "research", "collaboration"] as const;
export type CameraPresetId = (typeof CAMERA_PRESET_IDS)[number];

export interface CameraPreset {
  id: CameraPresetId;
  label: string;
  position: Vec3;
  target: Vec3;
}

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const CAMERA_PRESETS: Record<CameraPresetId, CameraPreset> = {
  overview: { id: "overview", label: "Overview", position: v(-1.2, 20, 25), target: v(-1.2, 0, 0.8) },
  hub: { id: "hub", label: "Operations Hub", position: v(0.6, 7.2, 9.6), target: v(0, 1, -2.4) },
  development: { id: "development", label: "Development", position: v(8.2, 6.2, 5.6), target: v(8.25, 0.6, -2.8) },
  research: { id: "research", label: "Research", position: v(-8.2, 6.2, 5.6), target: v(-8.25, 0.6, -2.8) },
  collaboration: { id: "collaboration", label: "Collaboration", position: v(-3.2, 8.4, 15), target: v(-6.8, 0.5, 4.6) },
};

export const CAMERA_LIMITS = {
  minDistance: 3.5,
  maxDistance: 70,
  minPolarAngle: 0.18,
  maxPolarAngle: 1.36,
  target: { minX: -14, maxX: 14, minY: 0, maxY: 3, minZ: -8, maxZ: 10 },
} as const;

export function targetInLimits(target: Vec3): boolean {
  const t = CAMERA_LIMITS.target;
  return target.x >= t.minX && target.x <= t.maxX && target.y >= t.minY && target.y <= t.maxY && target.z >= t.minZ && target.z <= t.maxZ;
}

export function clampTarget(target: Vec3): Vec3 {
  const t = CAMERA_LIMITS.target;
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return { x: clamp(target.x, t.minX, t.maxX), y: clamp(target.y, t.minY, t.maxY), z: clamp(target.z, t.minZ, t.maxZ) };
}

/** Pixels the floating UI covers on each side of the canvas. */
export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const FIT = { widthWeight: 1.17, heightWeight: 0.96, min: 1, max: 2.2 } as const;

/** How much farther than authored a preset sits so its view fits the free area. */
export function fitFactor(width: number, height: number, insets: Insets): number {
  const freeW = Math.max(1, width - insets.left - insets.right);
  const freeH = Math.max(1, height - insets.top - insets.bottom);
  const factor = Math.max((FIT.widthWeight * height) / freeW, (FIT.heightWeight * height) / freeH);
  return Math.min(FIT.max, Math.max(FIT.min, factor));
}

/** The free area's centre minus the canvas centre, in pixels (where the target should land). */
export function freeAreaShift(width: number, height: number, insets: Insets): { x: number; y: number } {
  const freeW = Math.max(1, width - insets.left - insets.right);
  const freeH = Math.max(1, height - insets.top - insets.bottom);
  return { x: insets.left + freeW / 2 - width / 2, y: insets.top + freeH / 2 - height / 2 };
}
