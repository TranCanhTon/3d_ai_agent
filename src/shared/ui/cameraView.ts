// The office camera: a fixed angle (looking at the back wall, tilted down) that
// pans over the floor and zooms, never rotates. Its limits come from where the
// corners of the free screen area (left of the side panel, below the top bar)
// land on the floor. Framework free (tested by scripts/test.ts).

import { DESK_SIZE, FLOOR } from "../domain/worldLayout.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface FloorPoint {
  x: number;
  z: number;
}

/** Pixels the floating UI covers on each side of the canvas. */
export interface Insets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The canvas size and what the UI covers. */
export interface ViewSize {
  width: number;
  height: number;
  insets: Insets;
}

export const CAMERA = {
  /** Vertical field of view, degrees. */
  fov: 40,
  /** Looking down from the horizontal, radians (about 35°). */
  pitch: (35 * Math.PI) / 180,
  /** The camera's target may go this far back (the back desks and the wall screen stay reachable). */
  targetMinZ: -7,
  /** At the closest zoom one desk is about this share of the free width. */
  deskShareAtClosest: 1 / 3,
} as const;

/** The free area's centre minus the canvas centre, in pixels (where the target should land). */
export function freeAreaShift(width: number, height: number, insets: Insets): { x: number; y: number } {
  const freeW = Math.max(1, width - insets.left - insets.right);
  const freeH = Math.max(1, height - insets.top - insets.bottom);
  return { x: insets.left + freeW / 2 - width / 2, y: insets.top + freeH / 2 - height / 2 };
}

/** The camera's position for a target on the floor and a distance along the view. */
export function cameraPosition(target: FloorPoint, distance: number): Vec3 {
  return { x: target.x, y: distance * Math.sin(CAMERA.pitch), z: target.z + distance * Math.cos(CAMERA.pitch) };
}

/**
 * Where the canvas pixel (px, py) looks at the floor, relative to the target, for a
 * camera `distance` away. The view offset puts the target at the free area's centre.
 * Null when the ray does not reach the floor (it points at or above the horizon).
 */
export function floorOffset(view: ViewSize, px: number, py: number, distance: number): FloorPoint | null {
  const shift = freeAreaShift(view.width, view.height, view.insets);
  const t = Math.tan((CAMERA.fov * Math.PI) / 360);
  const half = view.height / 2;
  const xc = ((px - shift.x - view.width / 2) / half) * t;
  const yc = (-(py - shift.y - view.height / 2) / half) * t;
  const sin = Math.sin(CAMERA.pitch);
  const cos = Math.cos(CAMERA.pitch);
  // Camera space → world: right (1,0,0), up (0,cos,−sin), forward (0,−sin,−cos).
  const dirY = yc * cos - sin;
  const dirZ = -yc * sin - cos;
  if (dirY >= -1e-6) return null;
  const s = (-distance * sin) / dirY;
  return { x: s * xc, z: distance * cos + s * dirZ };
}

/** Free area corners and middle row, in canvas pixels. */
function freeEdges(view: ViewSize) {
  const { insets } = view;
  return {
    left: insets.left,
    right: view.width - insets.right,
    top: insets.top,
    bottom: view.height - insets.bottom,
    middle: insets.top + (view.height - insets.top - insets.bottom) / 2,
  };
}

/** The bottom corners of the free area on the floor, relative to the target, at distance 1 (offsets scale with distance). */
function bottomCorners(view: ViewSize): { left: FloorPoint; right: FloorPoint } {
  const edge = freeEdges(view);
  const left = floorOffset(view, edge.left, edge.bottom, 1) ?? { x: 0, z: 0 };
  const right = floorOffset(view, edge.right, edge.bottom, 1) ?? { x: 0, z: 0 };
  return { left, right };
}

export interface ZoomRange {
  min: number;
  max: number;
}

/**
 * Closest: a desk fills about a third of the free width at the target. Furthest:
 * the bottom edge of the free area spans the floor's width (and stays on it), so
 * the whole floor is in view with the back wall and skyline above it.
 */
export function zoomRange(view: ViewSize): ZoomRange {
  const edge = freeEdges(view);
  const bottom = bottomCorners(view);
  const widthAtOne = Math.max(1e-6, bottom.right.x - bottom.left.x);
  const depthAtOne = Math.max(1e-6, bottom.left.z);
  const max = Math.min(FLOOR.width / widthAtOne, (FLOOR.maxZ - CAMERA.targetMinZ) / depthAtOne);
  const midLeft = floorOffset(view, edge.left, edge.middle, 1);
  const midRight = floorOffset(view, edge.right, edge.middle, 1);
  const midWidth = midLeft === null || midRight === null ? widthAtOne : Math.max(1e-6, midRight.x - midLeft.x);
  const min = Math.min(max, DESK_SIZE.width / CAMERA.deskShareAtClosest / midWidth);
  return { min, max };
}

export function clampDistance(view: ViewSize, distance: number): number {
  const range = zoomRange(view);
  return Math.min(range.max, Math.max(range.min, distance));
}

/** Keeps the free area's bottom corners on the floor and the target in front of the back wall. */
export function clampTarget(view: ViewSize, target: FloorPoint, distance: number): FloorPoint {
  const bottom = bottomCorners(view);
  const minX = FLOOR.minX - bottom.left.x * distance;
  const maxX = FLOOR.maxX - bottom.right.x * distance;
  const maxZ = FLOOR.maxZ - bottom.left.z * distance;
  const minZ = CAMERA.targetMinZ;
  const x = minX > maxX ? (minX + maxX) / 2 : Math.min(maxX, Math.max(minX, target.x));
  const z = minZ > maxZ ? maxZ : Math.min(maxZ, Math.max(minZ, target.z));
  return { x, z };
}

/** Furthest zoom, centred, with the floor's front edge along the bottom of the free area. */
export function overview(view: ViewSize): { target: FloorPoint; distance: number } {
  const distance = zoomRange(view).max;
  return { target: clampTarget(view, { x: 0, z: FLOOR.maxZ }, distance), distance };
}
