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

// ── Robot places ────────────────────────────────────────────────────────────
// Every place a robot can stand or sit, with `via`: the waypoints from the
// corridor to the place (the first one is on the corridor). A walk leaves its
// place along `via` reversed, follows the corridor and arrives along the target's
// `via`, so it never cuts through furniture (the tests check every path).

/** How a robot uses a place: sits on a desk chair or a sofa, or stands. */
export type PlaceSeat = "chair" | "sofa" | "stand";
export type IdleSpotKind = "lounge" | "wander";

export interface Place extends Slot {
  /** Unique: `seat:<station>`, `visit:<station>`, `needs:<station>`, `spot:<name>`. */
  id: string;
  seat: PlaceSeat;
  via: Vec2[];
  /** The obstacle the robot sits in (ignored for its own last step). */
  furniture: string | null;
}

export interface IdleSpot extends Place {
  kind: IdleSpotKind;
}

/** A robot's footprint radius. */
export const ROBOT_RADIUS = 0.25;
/** The chair sits this far in front of its desk's centre. */
export const CHAIR_OFFSET = 0.78;
/** Seat heights (where the hips rest). */
export const SEAT_HEIGHT = { chair: 0.5, sofa: 0.42 } as const;

function corridorPoint(x: number): Vec2 {
  return { x, z: CORRIDOR_Z };
}

/** The side of a desk (−1 left, +1 right) away from the neighbours: visitors stand there. */
const VISITOR_SIDE: Partial<Record<StationId, number>> = { research: -1, product: 1, dev: -1, testing: 1, review: 1, ops: 1 };

/** Where an agent sits (desk chair) or stands (the hub console) at home. */
export function homeSeat(station: StationId): Place {
  const layout = STATIONS[station];
  const slot = layout.slots[0] as Slot;
  if (layout.kind === "console") return { id: `seat:${station}`, x: slot.x, z: slot.z, facing: slot.facing, seat: "stand", via: [corridorPoint(slot.x)], furniture: null };
  const chair = { x: layout.center.x, z: layout.center.z + CHAIR_OFFSET };
  return { id: `seat:${station}`, ...chair, facing: Math.PI, seat: "chair", via: [corridorPoint(slot.x), { x: slot.x, z: slot.z }], furniture: null };
}

/** Standing beside the chair (or at the console) with a raised hand: the side away from visitors. */
export function needsSpot(station: StationId): Place {
  const layout = STATIONS[station];
  const slot = layout.slots[0] as Slot;
  if (layout.kind === "console") return { ...homeSeat(station), id: `needs:${station}` };
  const side = -(VISITOR_SIDE[station] ?? 1);
  const point = { x: layout.center.x + side * 0.62, z: layout.center.z + CHAIR_OFFSET - 0.02 };
  return {
    id: `needs:${station}`,
    ...point,
    facing: Math.PI,
    seat: "stand",
    via: [corridorPoint(slot.x), { x: slot.x, z: slot.z }, { x: point.x, z: slot.z }],
    furniture: null,
  };
}

/** Where a robot handing work over stands: beside the receiver's chair (or console), facing it. */
export function visitorSpot(station: StationId): Place {
  const layout = STATIONS[station];
  const slot = layout.slots[0] as Slot;
  const seat = homeSeat(station);
  const point =
    layout.kind === "console" ? { x: slot.x + 0.95, z: slot.z + 0.25 } : { x: slot.x + (VISITOR_SIDE[station] ?? 1) * 0.85, z: slot.z - 0.3 };
  return { id: `visit:${station}`, ...point, facing: facingToward(point, seat), seat: "stand", via: [corridorPoint(point.x)], furniture: null };
}

/** Points on a circle after angle `from` up to `to` (radians), at most `step` apart. */
function arc(center: Vec2, radius: number, from: number, to: number, step = Math.PI / 6): Vec2[] {
  const count = Math.max(1, Math.ceil(Math.abs(to - from) / step - 1e-9));
  return Array.from({ length: count }, (_, i) => {
    const angle = from + ((to - from) * (i + 1)) / count;
    return { x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) };
  });
}

/** `to` moved by whole turns to be the short way round from `from`. */
function nearestTurn(from: number, to: number): number {
  let delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return from + delta;
}

/** The side of a ring that faces the corridor (−z). */
const FRONT = (3 * Math.PI) / 2;

function loungeSeats(): IdleSpot[] {
  const center = STATIONS.lounge.center;
  const inner = 1.3;
  const entry = { x: center.x, z: center.z - inner };
  return STATIONS.lounge.slots.map((slot, i) => {
    const angle = (i * 2 * Math.PI) / RING_SEATS;
    return {
      id: `spot:lounge-${i}`,
      kind: "lounge",
      x: center.x + 2.15 * Math.cos(angle),
      z: center.z + 2.15 * Math.sin(angle),
      facing: slot.facing,
      seat: "sofa",
      via: [corridorPoint(center.x), entry, ...arc(center, inner, FRONT, nearestTurn(FRONT, angle))],
      furniture: `sofa-${i}`,
    };
  });
}

function collabSpots(): IdleSpot[] {
  const center = STATIONS.collab.center;
  const outer = 2.35;
  return [0, 1, 2, 3].map((k) => {
    const angle = (k * Math.PI) / 3;
    const point = { x: center.x + outer * Math.cos(angle), z: center.z + outer * Math.sin(angle) };
    return {
      id: `spot:collab-${k}`,
      kind: "wander",
      ...point,
      facing: facingToward(point, center),
      seat: "stand",
      via: [corridorPoint(center.x), { x: center.x, z: center.z - outer }, ...arc(center, outer, FRONT, nearestTurn(FRONT, angle))],
      furniture: null,
    };
  });
}

function standingSpot(name: string, point: Vec2, facing: number, via: Vec2[]): IdleSpot {
  return { id: `spot:${name}`, kind: "wander", ...point, facing, seat: "stand", via, furniture: null };
}

const PLANT_SPOT = { x: 11.7, z: 4.85 };
const CORNER_SPOT = { x: 13.2, z: 9.7 };

/** Spots for idle robots: six lounge sofas and standing places around the office. */
export const IDLE_SPOTS: IdleSpot[] = [
  ...loungeSeats(),
  ...collabSpots(),
  standingSpot("board-0", { x: -11.3, z: 4.3 }, -Math.PI / 2, [corridorPoint(-11.3)]),
  standingSpot("board-1", { x: -11.3, z: 5.6 }, -Math.PI / 2, [corridorPoint(-11.3)]),
  standingSpot("screen-0", { x: -1.2, z: -6.2 }, Math.PI, [corridorPoint(-2.2), { x: -2.2, z: -6.2 }]),
  standingSpot("screen-1", { x: 1.2, z: -6.2 }, Math.PI, [corridorPoint(2.2), { x: 2.2, z: -6.2 }]),
  standingSpot("window-0", { x: -8.25, z: -8.4 }, Math.PI, [corridorPoint(-4.4), { x: -4.4, z: -8.4 }]),
  standingSpot("window-1", { x: 8.25, z: -8.4 }, Math.PI, [corridorPoint(4.4), { x: 4.4, z: -8.4 }]),
  standingSpot("plant-0", PLANT_SPOT, facingToward(PLANT_SPOT, { x: 12.6, z: 3.9 }), [corridorPoint(PLANT_SPOT.x)]),
  standingSpot("plant-1", CORNER_SPOT, facingToward(CORNER_SPOT, { x: 14.2, z: 10.7 }), [corridorPoint(PLANT_SPOT.x), { x: PLANT_SPOT.x, z: CORNER_SPOT.z }]),
];

/** A walk from one place to another: out along `fromVia` reversed, along the corridor, in along `toVia`. */
export function walkPath(from: Vec2, fromVia: readonly Vec2[], to: Vec2, toVia: readonly Vec2[]): Vec2[] {
  return dedupe([from, ...[...fromVia].reverse(), ...toVia, to]);
}

/**
 * A new walk from `position`, somewhere on `path` between points `segment` and
 * `segment + 1`: first to the corridor (on along the way out if it was still
 * leaving, back the way it came if it was arriving), then in along `toVia`.
 */
export function rerouteFrom(path: readonly Vec2[], segment: number, position: Vec2, to: Vec2, toVia: readonly Vec2[]): Vec2[] {
  const onCorridor = path.flatMap((p, i) => (Math.abs(p.z - CORRIDOR_Z) < 1e-6 ? [i] : []));
  if (onCorridor.length === 0 || Math.abs(position.z - CORRIDOR_Z) < 1e-6) return dedupe([position, ...toVia, to]);
  const first = onCorridor[0]!;
  const last = onCorridor[onCorridor.length - 1]!;
  let exit: Vec2[];
  if (segment < first) exit = path.slice(segment + 1, first + 1);
  else if (segment < last) exit = [];
  else exit = path.slice(last, segment + 1).reverse();
  return dedupe([position, ...exit, ...toVia, to]);
}

/** The point `distance` metres along a path, the segment it is on and the direction of travel there. */
export function pointAlong(path: readonly Vec2[], distance: number): { point: Vec2; segment: number; heading: number | null } {
  let left = Math.max(0, distance);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    if (left <= length || i === path.length - 1) {
      const t = length === 0 ? 1 : Math.min(1, left / length);
      return { point: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, segment: i - 1, heading: length === 0 ? null : Math.atan2(b.x - a.x, b.z - a.z) };
    }
    left -= length;
  }
  const only = path[0] ?? { x: 0, z: 0 };
  return { point: { x: only.x, z: only.z }, segment: 0, heading: null };
}

function dedupe(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last === undefined || Math.hypot(p.x - last.x, p.z - last.z) > 1e-6) out.push({ x: p.x, z: p.z });
  }
  return out;
}

// ── Obstacles (robots keep clear of them; the layout tests check every walk) ─

export type Obstacle =
  | { id: string; shape: "circle"; center: Vec2; radius: number }
  | { id: string; shape: "rect"; center: Vec2; halfX: number; halfZ: number; rotation: number };

const DESK_STATION_IDS: StationId[] = ["ops", "research", "product", "dev", "testing", "review"];

/** Furniture footprints (desk chairs and stools are left out: robots sit in chairs, stools sit outside every walk). */
export function obstacles(): Obstacle[] {
  const list: Obstacle[] = [];
  for (const id of DESK_STATION_IDS) {
    list.push({ id: `desk-${id}`, shape: "rect", center: STATIONS[id].center, halfX: DESK_SIZE.width / 2, halfZ: DESK_SIZE.depth / 2, rotation: 0 });
  }
  list.push({ id: "hub", shape: "circle", center: HUB_CENTER, radius: HUB_RADIUS + 0.05 });
  list.push({ id: "collab-table", shape: "circle", center: STATIONS.collab.center, radius: COLLAB_TABLE_RADIUS });
  STATIONS.collab.slots.forEach((slot, i) => list.push({ id: `stool-${i}`, shape: "circle", center: slot, radius: 0.2 }));
  list.push({ id: "coffee-table", shape: "circle", center: STATIONS.lounge.center, radius: 0.7 });
  STATIONS.lounge.slots.forEach((slot, i) => {
    const center = { x: slot.x - Math.sin(slot.facing) * 0.1, z: slot.z - Math.cos(slot.facing) * 0.1 };
    list.push({ id: `sofa-${i}`, shape: "rect", center, halfX: 0.54, halfZ: 0.39, rotation: slot.facing });
  });
  PLANTS.forEach((plant, i) => list.push({ id: `plant-${i}`, shape: "circle", center: plant, radius: 0.42 * plant.scale }));
  PARTITIONS.forEach((segment, i) => {
    const center = { x: (segment.from.x + segment.to.x) / 2, z: (segment.from.z + segment.to.z) / 2 };
    const length = Math.hypot(segment.to.x - segment.from.x, segment.to.z - segment.from.z);
    const rotation = Math.atan2(segment.to.x - segment.from.x, segment.to.z - segment.from.z);
    list.push({ id: `partition-${i}`, shape: "rect", center, halfX: PARTITION_THICKNESS / 2, halfZ: length / 2, rotation });
  });
  list.push({ id: "board", shape: "rect", center: PLANNING_BOARD, halfX: 1.3, halfZ: 0.4, rotation: PLANNING_BOARD.rotation });
  for (const dx of [-2.6, 2.6]) {
    list.push({ id: `screen-foot-${dx}`, shape: "rect", center: { x: MISSION_CONTROL.x + dx, z: MISSION_CONTROL.z - 0.12 }, halfX: 0.35, halfZ: 0.25, rotation: 0 });
  }
  return list;
}

/** How far a point is from an obstacle's footprint (0 inside). Rectangles: local z along `rotation`. */
export function distanceToObstacle(point: Vec2, obstacle: Obstacle): number {
  if (obstacle.shape === "circle") return Math.max(0, Math.hypot(point.x - obstacle.center.x, point.z - obstacle.center.z) - obstacle.radius);
  const dx = point.x - obstacle.center.x;
  const dz = point.z - obstacle.center.z;
  const cos = Math.cos(obstacle.rotation);
  const sin = Math.sin(obstacle.rotation);
  const lx = dx * cos - dz * sin;
  const lz = dx * sin + dz * cos;
  return Math.hypot(Math.max(0, Math.abs(lx) - obstacle.halfX), Math.max(0, Math.abs(lz) - obstacle.halfZ));
}
