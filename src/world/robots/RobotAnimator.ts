// Robot poses as plain numbers (joint angles in radians, heights in metres) and
// a weighted blend between them (reference 6.4). No three: RobotCharacter turns
// a pose into joint rotations. Weights are damped toward the wanted pose with the
// frame's delta time, so poses blend and never pop.
//
// Angles follow three's right hand rule with the robot facing +z: a negative x
// rotation swings an arm or a leg forward, a positive x rotation leans the torso
// or tips the head forward, and a positive z rotation moves the arm on +x outward.

export interface Pose {
  /** Height of the hip joint. */
  hipY: number;
  /** Extra height of the whole robot (bounces). */
  bob: number;
  lean: number;
  twist: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  /** "l" is the arm and leg on +x. */
  lShoulderX: number;
  lShoulderZ: number;
  lElbow: number;
  rShoulderX: number;
  rShoulderZ: number;
  rElbow: number;
  lHip: number;
  lKnee: number;
  rHip: number;
  rKnee: number;
}

export const POSE_KEYS = [
  "hipY",
  "bob",
  "lean",
  "twist",
  "headPitch",
  "headYaw",
  "headRoll",
  "lShoulderX",
  "lShoulderZ",
  "lElbow",
  "rShoulderX",
  "rShoulderZ",
  "rElbow",
  "lHip",
  "lKnee",
  "rHip",
  "rKnee",
] as const satisfies readonly (keyof Pose)[];

/** The upper body: what an emote or a wake up jolt takes over (the legs keep sitting or standing). */
export const UPPER_KEYS = ["lean", "twist", "headPitch", "headYaw", "headRoll", "lShoulderX", "lShoulderZ", "lElbow", "rShoulderX", "rShoulderZ", "rElbow"] as const satisfies readonly (keyof Pose)[];

export const STAND_HIP = 0.57;
/** Hip joint above the seat it sits on. */
export const SIT_LIFT = 0.05;

export interface PoseContext {
  /** Seconds, this robot's own clock (offset per robot so they never move in sync). */
  t: number;
  /** 0 = no breathing (reduced motion, offline). */
  breath: number;
  /** Hip height when sitting on this seat. */
  seatHip: number;
}

export function emptyPose(): Pose {
  return Object.fromEntries(POSE_KEYS.map((k) => [k, 0])) as unknown as Pose;
}

const standBase = (): Pose => ({ ...emptyPose(), hipY: STAND_HIP, lShoulderZ: 0.08, rShoulderZ: -0.08, lElbow: -0.12, rElbow: -0.12 });
const sitBase = (c: PoseContext): Pose => ({ ...emptyPose(), hipY: c.seatHip, lHip: -1.5, rHip: -1.5, lKnee: 1.35, rKnee: 1.35, lShoulderZ: 0.06, rShoulderZ: -0.06 });
const breathe = (c: PoseContext, rate = 1.6, depth = 0.02) => c.breath * Math.sin(c.t * rate) * depth;

/** Typing: both forearms on the desk, hands bobbing out of step. */
function typing(pose: Pose, c: PoseContext, reach: number): Pose {
  return {
    ...pose,
    lShoulderX: -reach + Math.sin(c.t * 15) * 0.05,
    rShoulderX: -reach + Math.sin(c.t * 15 + 2.1) * 0.05,
    lElbow: -0.75 + Math.sin(c.t * 17) * 0.1,
    rElbow: -0.75 + Math.sin(c.t * 17 + 1.7) * 0.1,
  };
}

export const POSES = {
  standIdle: (c: PoseContext): Pose => ({ ...standBase(), lean: 0.02 + breathe(c), headPitch: 0.04 + breathe(c, 1.6, 0.015) }),
  sitIdle: (c: PoseContext): Pose => ({ ...sitBase(c), lean: 0.06 + breathe(c), headPitch: 0.08, lShoulderX: -0.45, rShoulderX: -0.45, lElbow: -0.55, rElbow: -0.55 }),
  sitWork: (c: PoseContext): Pose => typing({ ...sitBase(c), lean: 0.22 + breathe(c, 1.6, 0.01), headPitch: 0.22 + Math.sin(c.t * 0.7) * 0.04, headYaw: Math.sin(c.t * 0.45) * 0.12 }, c, 0.95),
  sitThink: (c: PoseContext): Pose => ({
    ...sitBase(c),
    lean: 0.04 + breathe(c),
    headPitch: -0.06,
    headRoll: 0.18 + Math.sin(c.t * 0.8) * 0.04,
    headYaw: Math.sin(c.t * 0.5) * 0.15,
    // Hand to chin.
    rShoulderX: -1.25,
    rShoulderZ: -0.2,
    rElbow: -2.15,
    lShoulderX: -0.5,
    lElbow: -0.6,
  }),
  standWork: (c: PoseContext): Pose => typing({ ...standBase(), lean: 0.14 + breathe(c, 1.6, 0.01), headPitch: 0.25 }, c, 0.8),
  standThink: (c: PoseContext): Pose => ({ ...standBase(), lean: 0.02 + breathe(c), headPitch: -0.05, headRoll: 0.18, headYaw: Math.sin(c.t * 0.5) * 0.15, rShoulderX: -1.25, rShoulderZ: -0.2, rElbow: -2.15 }),
  talk: (c: PoseContext): Pose => ({
    ...standBase(),
    lean: 0.04,
    headPitch: Math.sin(c.t * 3.4) * 0.08,
    headYaw: Math.sin(c.t * 1.3) * 0.08,
    rShoulderX: -0.95 + Math.sin(c.t * 4) * 0.25,
    rShoulderZ: -0.25,
    rElbow: -0.9 + Math.sin(c.t * 4 + 1) * 0.2,
    lShoulderX: -0.35 + Math.sin(c.t * 2.6) * 0.15,
    lElbow: -0.5,
  }),
  raiseHand: (c: PoseContext): Pose => ({
    ...standBase(),
    lean: -0.04 + breathe(c),
    headPitch: -0.18,
    rShoulderX: -2.85,
    rShoulderZ: -0.12 + Math.sin(c.t * 5) * 0.14,
    rElbow: -0.25,
  }),
  nap: (c: PoseContext): Pose => ({
    ...sitBase(c),
    // Forward onto folded arms on the desk.
    lean: 0.72 + breathe(c, 0.9, 0.025),
    headPitch: 0.5,
    headRoll: 0.25,
    lShoulderX: -1.35,
    rShoulderX: -1.35,
    lShoulderZ: -0.35,
    rShoulderZ: 0.35,
    lElbow: -1.7,
    rElbow: -1.7,
  }),
  standNap: (c: PoseContext): Pose => ({ ...standBase(), lean: 0.12 + breathe(c, 0.9, 0.025), headPitch: 0.55, headRoll: 0.15 }),
  lounge: (c: PoseContext): Pose => ({
    ...sitBase(c),
    lHip: -1.25,
    rHip: -1.25,
    lKnee: 1.05,
    rKnee: 1.15,
    lean: -0.28 + breathe(c),
    headPitch: -0.1,
    headYaw: Math.sin(c.t * 0.35) * 0.35,
    // Arms along the back of the sofa.
    lShoulderX: 0.25,
    rShoulderX: 0.25,
    lShoulderZ: 0.75,
    rShoulderZ: -0.75,
    lElbow: -0.35,
    rElbow: -0.35,
  }),
  lookAround: (c: PoseContext): Pose => ({
    ...standBase(),
    lean: breathe(c),
    twist: Math.sin(c.t * 0.55 + 0.6) * 0.18,
    headYaw: Math.sin(c.t * 0.55) * 0.65,
    headPitch: -0.05 + Math.sin(c.t * 0.3) * 0.06,
    // Hands behind the back.
    lShoulderX: 0.35,
    rShoulderX: 0.35,
    lElbow: -0.9,
    rElbow: -0.9,
  }),
  offlineSit: (c: PoseContext): Pose => ({ ...sitBase(c), lean: 0.2, headPitch: 0.4, lShoulderX: -0.4, rShoulderX: -0.4, lElbow: -0.5, rElbow: -0.5 }),
  offlineStand: (): Pose => ({ ...standBase(), lean: 0.1, headPitch: 0.4 }),
} as const;

export type PoseName = keyof typeof POSES;

/** Walking, driven by `phase` (advanced by the distance actually covered). */
export function walkPose(phase: number): Pose {
  const s = Math.sin(phase);
  return {
    ...standBase(),
    bob: Math.abs(Math.cos(phase)) * 0.035,
    lean: 0.08,
    lHip: -s * 0.55,
    rHip: s * 0.55,
    lKnee: Math.max(0, s) * 0.75,
    rKnee: Math.max(0, -s) * 0.75,
    lShoulderX: s * 0.45,
    rShoulderX: -s * 0.45,
    lElbow: -0.3,
    rElbow: -0.3,
  };
}

/** Emotes over the upper body (`p` is 0..1 through the emote). */
export const EMOTE_POSES = {
  success: (p: number): Pose => ({
    ...emptyPose(),
    bob: Math.abs(Math.sin(p * Math.PI * 3)) * 0.16 * (1 - p * 0.4),
    lean: -0.12,
    headPitch: -0.25,
    lShoulderX: -2.7,
    rShoulderX: -2.7,
    lShoulderZ: 0.45,
    rShoulderZ: -0.45,
    lElbow: -0.2,
    rElbow: -0.2,
  }),
  error: (p: number): Pose => ({
    ...emptyPose(),
    bob: -0.03 * Math.min(1, p * 4),
    lean: 0.38,
    headPitch: 0.5,
    headRoll: Math.sin(p * Math.PI * 4) * 0.08,
    lShoulderX: 0.05,
    rShoulderX: 0.05,
    lShoulderZ: 0.02,
    rShoulderZ: -0.02,
    lElbow: 0,
    rElbow: 0,
  }),
  /** Startled awake: the head snaps up. */
  wake: (p: number): Pose => ({
    ...emptyPose(),
    bob: Math.sin(p * Math.PI) * 0.05,
    lean: 0.1,
    headPitch: -0.3 + p * 0.3,
    headRoll: Math.sin(p * Math.PI * 6) * 0.12,
    lShoulderX: -0.9,
    rShoulderX: -0.9,
    lShoulderZ: 0.6,
    rShoulderZ: -0.6,
    lElbow: -0.4,
    rElbow: -0.4,
  }),
};

/** Exponential damping (frame rate independent). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-lambda * dt));
}

/** Damps every weight toward 1 for `target` and 0 for the rest; returns the weights normalised. */
export function dampWeights(weights: Partial<Record<PoseName, number>>, target: PoseName, lambda: number, dt: number): [PoseName, number][] {
  weights[target] ??= 0;
  let total = 0;
  for (const name of Object.keys(weights) as PoseName[]) {
    const next = damp(weights[name]!, name === target ? 1 : 0, lambda, dt);
    if (next < 0.002 && name !== target) delete weights[name];
    else {
      weights[name] = next;
      total += next;
    }
  }
  return (Object.entries(weights) as [PoseName, number][]).map(([name, w]) => [name, w / total]);
}

/** out = Σ weight · pose. */
export function blendPoses(out: Pose, parts: readonly [Pose, number][]): Pose {
  for (const key of POSE_KEYS) {
    let value = 0;
    for (const [pose, weight] of parts) value += pose[key] * weight;
    out[key] = value;
  }
  return out;
}

/** Moves the upper body toward `overlay` by `weight`; its bob adds on top. */
export function overlayUpper(out: Pose, overlay: Pose, weight: number): Pose {
  if (weight <= 0) return out;
  for (const key of UPPER_KEYS) out[key] += (overlay[key] - out[key]) * weight;
  out.bob += overlay.bob * weight;
  return out;
}

/** The shortest signed angle from `a` to `b`. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}
