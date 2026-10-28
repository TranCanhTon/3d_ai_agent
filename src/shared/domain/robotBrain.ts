// The robot brain: where each robot in the 3D office should be and what it is
// doing, decided on the client from the real agents' state and events. Pure
// (no React, no three): `stepBrain` takes the previous state and this tick's
// input and returns the next state plus one view per robot. Walks are paths
// over time (`walk`), so the renderer only follows them.
//
// Rules, highest first: needs me (a permission or a card) → working → emote
// after a result → handoff walk and talk → idle (desk, then lounge, nap or a
// walk after `idleDelayMs`). Offline overrides everything.

import type { RobotSettings } from "../config.ts";
import type { AgentStatus } from "./agentTypes.ts";
import { ROLE_DEFINITIONS, type AgentRole } from "./roles.ts";
import { homeSeat, IDLE_SPOTS, needsSpot, pathLength, pointAlong, rerouteFrom, visitorSpot, walkPath, type IdleSpot, type Place, type Vec2 } from "./worldLayout.ts";

export type RobotPose = "idle" | "work" | "think" | "talk" | "raise_hand" | "nap" | "lounge" | "look_around" | "offline";
export type EmoteKind = "success" | "error";
export type RingState = "idle" | "working" | "needs" | "offline";
export type BubbleTone = "normal" | "needs" | "success" | "error";
export type IdleActivity = "lounge" | "nap" | "wander";
/** Which rule decided a robot's view (for tests and debugging). */
export type RobotRule = "offline" | "needs" | "working" | "emote" | "handoff" | "idle";

export interface BrainAgent {
  id: string;
  role: AgentRole;
  name: string;
  status: AgentStatus;
  busy: boolean;
  activity: string;
}

/** The parts of an AgentEvent the brain reads. */
export interface BrainEvent {
  type: string;
  agentId?: string;
  targetAgentId?: string;
}

export interface BrainInput {
  now: number;
  /** The selected project's agents. */
  agents: readonly BrainAgent[];
  /** Agents with an open card for me (a question, a brief or a change). */
  askers: readonly string[];
  /** Events of this project that arrived since the last tick, oldest first. */
  events: readonly BrainEvent[];
  /** Disconnected, or the project is archived. */
  offline: boolean;
  reducedMotion: boolean;
  settings: RobotSettings;
}

export interface Walk {
  path: Vec2[];
  /** Epoch ms; the robot waits at path[0] until then. */
  startedAt: number;
  /** m/s */
  speed: number;
  length: number;
}

interface Talk {
  to: string;
  arriveAt: number;
  endsAt: number;
}

interface Emote {
  kind: EmoteKind;
  text: string;
  queuedAt: number;
  startedAt: number | null;
}

interface Activity {
  kind: IdleActivity;
  /** The spot (null for a nap at the desk). */
  spotId: string | null;
  until: number;
}

export interface RobotMind {
  agentId: string;
  role: AgentRole;
  /** Where the robot is or is heading. */
  place: Place;
  walk: Walk | null;
  /** Idle without interruption since (null while a higher rule applies). */
  idleSince: number | null;
  activity: Activity | null;
  /** The last idle spot ("nap" for a nap), never picked twice in a row. */
  lastSpot: string | null;
  /** Receivers of handoffs waiting to be walked over. */
  handoffs: string[];
  talk: Talk | null;
  emote: Emote | null;
  wakeUntil: number | null;
  /** Seeded random state. */
  rng: number;
}

export interface BrainState {
  projectId: string;
  minds: Record<string, RobotMind>;
  /** Shared spots (idle and visitor spots) → the agent heading there or using it. */
  reserved: Record<string, string>;
  /** Seed per agent id (defaults to a hash of the project id and the role). */
  seeds: Record<string, number>;
}

export interface RobotLink {
  from: string;
  to: string;
  startedAt: number;
  endsAt: number;
}

export interface RobotView {
  agentId: string;
  role: AgentRole;
  rule: RobotRule;
  place: Place;
  walk: Walk | null;
  pose: RobotPose;
  emote: { kind: EmoteKind; startedAt: number } | null;
  wakeUntil: number | null;
  bubble: string;
  tone: BubbleTone;
  ring: RingState;
  /** The robot turns toward this point (the receiver while talking, the sender while listening). */
  faceToward: Vec2 | null;
  link: RobotLink | null;
}

export interface BrainResult {
  state: BrainState;
  robots: RobotView[];
}

// ── Seeds ───────────────────────────────────────────────────────────────────

/** FNV-1a of the text: a stable seed per project and role. */
export function seedFor(projectId: string, role: AgentRole): number {
  let hash = 0x811c9dc5;
  for (const char of `${projectId}:${role}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** Mulberry32 step: returns [0, 1) and advances the mind's state. */
function random(mind: RobotMind): number {
  mind.rng = (mind.rng + 0x6d2b79f5) >>> 0;
  let t = mind.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function createBrainState(projectId: string, seeds: Record<string, number> = {}): BrainState {
  return { projectId, minds: {}, reserved: {}, seeds };
}

function newMind(state: BrainState, agent: BrainAgent): RobotMind {
  return {
    agentId: agent.id,
    role: agent.role,
    place: homeSeat(ROLE_DEFINITIONS[agent.role].homeStation),
    walk: null,
    idleSince: null,
    activity: null,
    lastSpot: null,
    handoffs: [],
    talk: null,
    emote: null,
    wakeUntil: null,
    rng: state.seeds[agent.id] ?? seedFor(state.projectId, agent.role),
  };
}

// ── Walking ─────────────────────────────────────────────────────────────────

function walkEnds(walk: Walk): number {
  return walk.startedAt + (walk.length / walk.speed) * 1000;
}

/** Where a robot is at `now` (on its walk, or at its place). */
export function robotPosition(mind: Pick<RobotMind, "walk" | "place">, now: number): Vec2 {
  const { walk, place } = mind;
  if (walk === null) return { x: place.x, z: place.z };
  return pointAlong(walk.path, (Math.max(0, now - walk.startedAt) / 1000) * walk.speed).point;
}

export function arrived(mind: Pick<RobotMind, "walk">, now: number): boolean {
  return mind.walk === null || now >= walkEnds(mind.walk);
}

function isShared(place: Place): boolean {
  return place.id.startsWith("spot:") || place.id.startsWith("visit:");
}

/** Heads for `place` (from wherever it is now); a shared spot is reserved, the one it leaves freed. */
function goTo(state: BrainState, mind: RobotMind, place: Place, speed: number, now: number, startAt = now): void {
  if (mind.place.id === place.id) return;
  if (isShared(mind.place) && state.reserved[mind.place.id] === mind.agentId) delete state.reserved[mind.place.id];
  if (isShared(place)) state.reserved[place.id] = mind.agentId;
  let path: Vec2[];
  if (mind.walk !== null && !arrived(mind, now)) {
    const along = pointAlong(mind.walk.path, (Math.max(0, now - mind.walk.startedAt) / 1000) * mind.walk.speed);
    path = rerouteFrom(mind.walk.path, along.segment, along.point, place, place.via);
  } else {
    path = walkPath(mind.place, mind.place.via, place, place.via);
  }
  mind.place = place;
  mind.walk = { path, startedAt: Math.max(now, startAt), speed, length: pathLength(path) };
}

function freeFor(state: BrainState, placeId: string, agentId: string): boolean {
  const holder = state.reserved[placeId];
  return holder === undefined || holder === agentId;
}

// ── Events ──────────────────────────────────────────────────────────────────

const EMOTES: Record<string, { kind: EmoteKind; text: string; orchestrator?: true }> = {
  "qa.passed": { kind: "success", text: "Tests pass" },
  "review.approved": { kind: "success", text: "Approved" },
  "task.completed": { kind: "success", text: "Task done", orchestrator: true },
  "qa.failed": { kind: "error", text: "Tests failed" },
  "review.changes_requested": { kind: "error", text: "Changes requested" },
  "task.failed": { kind: "error", text: "Task failed", orchestrator: true },
  "task.cancelled": { kind: "error", text: "Task cancelled", orchestrator: true },
};

function readEvents(state: BrainState, events: readonly BrainEvent[], now: number, settings: RobotSettings): void {
  const orchestrator = Object.values(state.minds).find((m) => m.role === "orchestrator");
  for (const event of events) {
    if (event.type === "task.assigned") {
      const sender = event.agentId === undefined ? undefined : state.minds[event.agentId];
      const receiver = event.targetAgentId;
      if (sender === undefined || receiver === undefined || receiver === sender.agentId || state.minds[receiver] === undefined) continue;
      sender.handoffs.push(receiver);
      if (sender.handoffs.length > settings.maxQueuedHandoffs) sender.handoffs = [receiver];
      continue;
    }
    const emote = EMOTES[event.type];
    if (emote === undefined) continue;
    const mind = emote.orchestrator === true ? orchestrator : event.agentId === undefined ? undefined : state.minds[event.agentId];
    if (mind !== undefined) mind.emote = { kind: emote.kind, text: emote.text, queuedAt: now, startedAt: null };
  }
}

// ── Rules ───────────────────────────────────────────────────────────────────

/** A run that is going (not one showing its result for a moment before idling). */
export function isWorking(agent: BrainAgent): boolean {
  return agent.busy && agent.status !== "success" && agent.status !== "error";
}

function needsMe(agent: BrainAgent, askers: ReadonlySet<string>): "permission" | "card" | null {
  if (agent.status === "waiting_permission") return "permission";
  if (agent.status === "waiting_user" || askers.has(agent.id)) return "card";
  return null;
}

/** Leaves the idle activity (its spot is freed when the robot walks off). */
function stopActivity(mind: RobotMind): void {
  mind.activity = null;
  mind.idleSince = null;
}

function dropHandoffs(mind: RobotMind): void {
  mind.handoffs = [];
  mind.talk = null;
}

function pickActivity(state: BrainState, mind: RobotMind, now: number, settings: RobotSettings): Activity {
  const free = (kind: IdleSpot["kind"]) => IDLE_SPOTS.filter((s) => s.kind === kind && s.id !== mind.lastSpot && freeFor(state, s.id, mind.agentId));
  const options: { kind: IdleActivity; weight: number; spots: IdleSpot[] }[] = [];
  const lounge = free("lounge");
  const wander = free("wander");
  if (lounge.length > 0) options.push({ kind: "lounge", weight: settings.activityWeights.lounge, spots: lounge });
  if (mind.lastSpot !== "nap") options.push({ kind: "nap", weight: settings.activityWeights.nap, spots: [] });
  if (wander.length > 0) options.push({ kind: "wander", weight: settings.activityWeights.wander, spots: wander });
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let roll = random(mind) * total;
  const choice = options.find((o) => (roll -= o.weight) < 0) ?? options[options.length - 1]!;
  const spot = choice.spots.length === 0 ? null : choice.spots[Math.floor(random(mind) * choice.spots.length)]!;
  const { min, max } = settings.activityMs;
  return { kind: choice.kind, spotId: spot?.id ?? null, until: now + min + random(mind) * (max - min) };
}

const ACTIVITY_VIEW: Record<IdleActivity, { pose: RobotPose; bubble: string }> = {
  lounge: { pose: "lounge", bubble: "On a break" },
  nap: { pose: "nap", bubble: "Napping" },
  wander: { pose: "look_around", bubble: "Taking a walk" },
};

function baseView(mind: RobotMind, rule: RobotRule): RobotView {
  return {
    agentId: mind.agentId,
    role: mind.role,
    rule,
    place: mind.place,
    walk: mind.walk,
    pose: "idle",
    emote: null,
    wakeUntil: mind.wakeUntil,
    bubble: "",
    tone: "normal",
    ring: "idle",
    faceToward: null,
    link: null,
  };
}

function decide(state: BrainState, mind: RobotMind, agent: BrainAgent, input: BrainInput, askers: ReadonlySet<string>, names: Record<string, string>): RobotView {
  const { now, settings } = input;
  const station = ROLE_DEFINITIONS[agent.role].homeStation;
  const home = homeSeat(station);
  const hurry = settings.walkSpeed * settings.hurry;
  if (mind.wakeUntil !== null && now >= mind.wakeUntil) mind.wakeUntil = null;

  // 6. Offline: back at the desk, grey, still.
  if (input.offline) {
    stopActivity(mind);
    dropHandoffs(mind);
    mind.emote = null;
    goTo(state, mind, home, settings.walkSpeed, now);
    return { ...baseView(mind, "offline"), pose: "offline", ring: "offline", bubble: "Offline" };
  }

  // 1. Needs me: hurry home, stand by the chair, raise a hand.
  const needs = needsMe(agent, askers);
  if (needs !== null) {
    stopActivity(mind);
    dropHandoffs(mind);
    goTo(state, mind, needsSpot(station), hurry, now);
    return { ...baseView(mind, "needs"), pose: "raise_hand", ring: "needs", tone: "needs", bubble: needs === "permission" ? "Needs your OK" : "Waiting for you" };
  }

  // 2. Working: hurry home (a napping robot jolts awake first) and work.
  if (isWorking(agent)) {
    if (mind.activity?.kind === "nap" && mind.place.id === home.id) mind.wakeUntil = now + settings.wakeMs;
    stopActivity(mind);
    dropHandoffs(mind);
    goTo(state, mind, home, hurry, now, mind.wakeUntil ?? now);
    const thinking = agent.status === "thinking";
    const fallback = thinking ? "Thinking" : "Working";
    return { ...baseView(mind, "working"), wakeUntil: mind.wakeUntil, pose: thinking ? "think" : "work", ring: "working", bubble: agent.activity.trim() || fallback };
  }

  // 3. Emote after a result, where the robot stands.
  if (mind.emote !== null) {
    const emote = mind.emote;
    if (emote.startedAt === null && now - emote.queuedAt > settings.emoteMaxWaitMs) mind.emote = null;
    else {
      emote.startedAt ??= now;
      if (now - emote.startedAt < settings.emoteMs) {
        mind.idleSince = null;
        const pose = mind.activity === null ? "idle" : ACTIVITY_VIEW[mind.activity.kind].pose;
        return { ...baseView(mind, "emote"), pose, emote: { kind: emote.kind, startedAt: emote.startedAt }, tone: emote.kind, bubble: emote.text };
      }
      mind.emote = null;
    }
  }

  // 4. Handoff: walk to the receiver's desk, talk, then carry on.
  if (mind.talk !== null && now >= mind.talk.endsAt) mind.talk = null;
  if (mind.talk === null) {
    while (mind.handoffs.length > 0) {
      const to = mind.handoffs[0]!;
      const receiver = state.minds[to];
      if (receiver === undefined) {
        mind.handoffs.shift();
        continue;
      }
      const spot = visitorSpot(ROLE_DEFINITIONS[receiver.role].homeStation);
      if (!freeFor(state, spot.id, mind.agentId)) break;
      mind.handoffs.shift();
      stopActivity(mind);
      goTo(state, mind, spot, settings.walkSpeed, now);
      const arriveAt = mind.walk === null ? now : walkEnds(mind.walk);
      mind.talk = { to, arriveAt, endsAt: arriveAt + settings.talkMs };
      break;
    }
  }
  if (mind.talk !== null) {
    const talk = mind.talk;
    const receiver = state.minds[talk.to];
    mind.idleSince = null;
    const name = names[talk.to] ?? "the next agent";
    if (now < talk.arriveAt || receiver === undefined) return { ...baseView(mind, "handoff"), bubble: `Taking the task to ${name}` };
    return {
      ...baseView(mind, "handoff"),
      pose: "talk",
      bubble: `Handing over to ${name}`,
      faceToward: robotPosition(receiver, now),
      link: { from: mind.agentId, to: talk.to, startedAt: talk.arriveAt, endsAt: talk.endsAt },
    };
  }

  // 5. Idle: at the desk, then an idle activity after idleDelayMs (none with reduced motion).
  mind.idleSince ??= now;
  if (input.reducedMotion) mind.activity = null;
  else if (mind.activity !== null && now >= mind.activity.until) {
    mind.lastSpot = mind.activity.spotId ?? "nap";
    mind.activity = pickActivity(state, mind, now, settings);
  } else if (mind.activity === null && now - mind.idleSince >= settings.idleDelayMs) {
    mind.activity = pickActivity(state, mind, now, settings);
  }
  const activity = mind.activity;
  if (activity === null) {
    goTo(state, mind, home, settings.walkSpeed, now);
    return { ...baseView(mind, "idle"), bubble: "Idle" };
  }
  const spot = activity.spotId === null ? home : IDLE_SPOTS.find((s) => s.id === activity.spotId)!;
  goTo(state, mind, spot, settings.walkSpeed, now);
  const view = ACTIVITY_VIEW[activity.kind];
  return { ...baseView(mind, "idle"), pose: view.pose, bubble: view.bubble };
}

/** One tick: reads the new events, applies the rules per robot, returns the next state and the views. */
export function stepBrain(previous: BrainState, input: BrainInput): BrainResult {
  const state: BrainState = structuredClone(previous);
  const ids = new Set(input.agents.map((a) => a.id));
  for (const id of Object.keys(state.minds)) {
    if (!ids.has(id)) delete state.minds[id];
  }
  for (const [placeId, agentId] of Object.entries(state.reserved)) {
    if (!ids.has(agentId)) delete state.reserved[placeId];
  }
  for (const agent of input.agents) state.minds[agent.id] ??= newMind(state, agent);

  readEvents(state, input.events, input.now, input.settings);
  const askers = new Set(input.askers);
  const names = Object.fromEntries(input.agents.map((a) => [a.id, a.name]));
  const robots = input.agents.map((agent) => decide(state, state.minds[agent.id]!, agent, input, askers, names));

  // A receiver turns toward the robot talking to it.
  for (const view of robots) {
    if (view.link === null) continue;
    const receiver = robots.find((r) => r.agentId === view.link!.to);
    const sender = state.minds[view.agentId];
    if (receiver !== undefined && sender !== undefined && receiver.faceToward === null) receiver.faceToward = robotPosition(sender, input.now);
  }
  return { state, robots };
}
