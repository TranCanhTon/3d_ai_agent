// The office floor plan (reference section 5): stations, their stand slots, the
// desks, the glass partitions and the plants, plus the walking helpers the robots
// use. Pure data in metres: x is left/right, z is back (−) / front (+), y is up.
// A facing angle θ looks along (sin θ, cos θ) in x/z: 0 is +z, π is −z.

import type { StationId } from "./agentTypes.ts";
import { AGENT_ROLES, ROLE_DEFINITIONS, type AgentRole } from "./roles.ts";

export interface Vec2 {
  x: number;
  z: number;
}

export interface Slot extends Vec2 {
  /** Where someone standing here looks (radians, see the file comment). */
  facing: number;
}

export const FLOOR = { width: 30, depth: 21, minX: -15, maxX: 15, minZ: -9.5, maxZ: 11.5 } as const;
/** Robots walk along this line between zones. */
export const CORRIDOR_Z = 2.8;
/** The corridor's walkable stretch (no partition may cross it). */
export const CORRIDOR_X = { min: -12, max: 12 } as const;
export const HUB_CENTER: Vec2 = { x: 0, z: -0.6 };
export const HUB_RADIUS = 1.2;
/** The large wall screen in front of the back windows. */
export const MISSION_CONTROL: Vec2 = { x: 0, z: -7.4 };

export const ZONE_IDS = ["operations", "research", "development", "collaboration"] as const;
export type ZoneId = (typeof ZONE_IDS)[number];

/** desk: a work desk with monitors; console: the hub; board, table, lounge: shared places. */
export type StationKind = "desk" | "console" | "board" | "table" | "lounge";

export interface StationLayout {
  id: StationId;
  label: string;
  zone: ZoneId;
  kind: StationKind;
  /** The furniture's centre: a desk, the hub console, the board, the table or the lounge. */
  center: Vec2;
  /** Desks and the board: rotation about y (desks 0, monitor facing +z). */
  rotation: number;
  /** Ring stations: the ring's radius around `center`. */
  ringRadius: number | null;
  slots: Slot[];
}

/** Desks sit this far behind their stand slot. */
export const DESK_TO_SLOT = 1.2;
export const DESK_SIZE = { width: 1.8, depth: 0.8, height: 0.75 } as const;
export const RING_SEATS = 6;
export const COLLAB_TABLE_RADIUS = 0.75;
export const PLANNING_BOARD: Vec2 & { rotation: number } = { x: -12.6, z: 4.9, rotation: Math.PI / 2 };

/** A slot looking toward `center`. */
function facingToward(from: Vec2, center: Vec2): number {
  return Math.atan2(center.x - from.x, center.z - from.z);
}

function ringSlots(center: Vec2, radius: number): Slot[] {
  return Array.from({ length: RING_SEATS }, (_, i) => {
    const angle = (i * 2 * Math.PI) / RING_SEATS;
    const point = { x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) };
    return { ...point, facing: facingToward(point, center) };
  });
}

function deskStation(id: StationId, label: string, zone: ZoneId, slot: Vec2): StationLayout {
  return {
    id,
    label,
    zone,
    kind: "desk",
    center: { x: slot.x, z: slot.z - DESK_TO_SLOT },
    rotation: 0,
    ringRadius: null,
    slots: [{ ...slot, facing: Math.PI }],
  };
}

const COLLAB_CENTER: Vec2 = { x: -5, z: 5.6 };
const LOUNGE_CENTER: Vec2 = { x: 7.5, z: 6.2 };

export const STATIONS: Record<StationId, StationLayout> = {
  hub: {
    id: "hub",
    label: "Operations Hub",
    zone: "operations",
    kind: "console",
    center: HUB_CENTER,
    rotation: 0,
    ringRadius: null,
    slots: [{ x: 0, z: 1.15, facing: Math.PI }],
  },
  ops: deskStation("ops", "Ops Console", "research", { x: -8.25, z: 0.05 }),
  research: deskStation("research", "Research Station", "research", { x: -10, z: -3.75 }),
  product: deskStation("product", "Product Station", "research", { x: -6.5, z: -3.75 }),
  dev: deskStation("dev", "Engineering Station", "development", { x: 6.5, z: -3.75 }),
  testing: deskStation("testing", "QA Lab", "development", { x: 10, z: -3.75 }),
  review: deskStation("review", "Review Station", "development", { x: 8.25, z: 0.05 }),
  planning: {
    id: "planning",
    label: "Planning Board",
    zone: "collaboration",
    kind: "board",
    center: { x: PLANNING_BOARD.x, z: PLANNING_BOARD.z },
    rotation: PLANNING_BOARD.rotation,
    ringRadius: null,
    slots: [
      { x: -11.4, z: 4.2, facing: -Math.PI / 2 },
      { x: -11.0, z: 5.6, facing: -Math.PI / 2 },
    ],
  },
  collab: {
    id: "collab",
    label: "Collaboration Table",
    zone: "collaboration",
    kind: "table",
    center: COLLAB_CENTER,
    rotation: 0,
    ringRadius: 1.75,
    slots: ringSlots(COLLAB_CENTER, 1.75),
  },
  lounge: {
    id: "lounge",
    label: "Meeting Lounge",
    zone: "collaboration",
    kind: "lounge",
    center: LOUNGE_CENTER,
    rotation: 0,
    ringRadius: 2.1,
    slots: ringSlots(LOUNGE_CENTER, 2.1),
  },
};

/** The role whose home this station is, or null (ops, the board, the table, the lounge). */
export function stationOwner(station: StationId): AgentRole | null {
  return AGENT_ROLES.find((role) => ROLE_DEFINITIONS[role].homeStation === station) ?? null;
}

/** Ring stations take the seat index (0..5, wrapped); the others use their first slot. */
export function slotFor(station: StationId, seatIndex = 0): Slot {
  const { slots } = STATIONS[station];
  const index = slots.length === RING_SEATS ? ((seatIndex % RING_SEATS) + RING_SEATS) % RING_SEATS : 0;
  return slots[index] as Slot;
}

/** Straight to the corridor, along it, then to the destination. Repeated points are dropped. */
export function route(from: Vec2, to: Vec2): Vec2[] {
  const points: Vec2[] = [
    { x: from.x, z: from.z },
    { x: from.x, z: CORRIDOR_Z },
    { x: to.x, z: CORRIDOR_Z },
    { x: to.x, z: to.z },
  ];
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1]!.x || p.z !== points[i - 1]!.z);
}

export function pathLength(path: readonly Vec2[]): number {
  let length = 0;
  for (let i = 1; i < path.length; i++) length += Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.z - path[i - 1]!.z);
  return length;
}

// ── Partitions and decor ───────────────────────────────────────────────────

export interface Segment {
  from: Vec2;
  to: Vec2;
}

export const PARTITION_HEIGHT = 1.1;
export const PARTITION_THICKNESS = 0.06;
/** Room kept free around a partition (a robot's half width). */
export const PARTITION_CLEARANCE = 0.25;

/**
 * Low glass walls between zones. In front of the collaboration area the run is
 * split in two, leaving the way from the corridor to the table and the board open.
 */
export const PARTITIONS: Segment[] = [
  { from: { x: -3.2, z: -6 }, to: { x: -3.2, z: -1.6 } },
  { from: { x: 3.2, z: -6 }, to: { x: 3.2, z: -1.6 } },
  { from: { x: -9.6, z: 3.8 }, to: { x: -7.4, z: 3.8 } },
  { from: { x: -2.6, z: 3.8 }, to: { x: -1.0, z: 3.8 } },
];

export function distanceToSegment(point: Vec2, segment: Segment): number {
  const dx = segment.to.x - segment.from.x;
  const dz = segment.to.z - segment.from.z;
  const lengthSq = dx * dx + dz * dz;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - segment.from.x) * dx + (point.z - segment.from.z) * dz) / lengthSq));
  return Math.hypot(point.x - (segment.from.x + t * dx), point.z - (segment.from.z + t * dz));
}

/** The point is inside a partition's footprint (its thickness plus the clearance). */
export function insidePartition(point: Vec2): boolean {
  return PARTITIONS.some((segment) => distanceToSegment(point, segment) < PARTITION_THICKNESS / 2 + PARTITION_CLEARANCE);
}

/** Potted plants: corners and beside the partitions, never on a walkway. */
export const PLANTS: (Vec2 & { scale: number })[] = [
  { x: -14.2, z: -8.7, scale: 1.25 },
  { x: 14.2, z: -8.7, scale: 1.25 },
  { x: -14.2, z: 10.7, scale: 1.1 },
  { x: 14.2, z: 10.7, scale: 1.1 },
  { x: -3.2, z: -6.6, scale: 0.9 },
  { x: 3.2, z: -6.6, scale: 0.9 },
  { x: -10.2, z: 3.8, scale: 0.85 },
  { x: -0.4, z: 3.8, scale: 0.85 },
  { x: 12.6, z: 3.9, scale: 0.95 },
];
