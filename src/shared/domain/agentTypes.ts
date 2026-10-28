import type { AgentRole } from "./roles.ts";

/** Locations in the office (reference section 5). */
export const STATION_IDS = [
  "hub",
  "ops",
  "research",
  "product",
  "dev",
  "testing",
  "review",
  "planning",
  "collab",
  "lounge",
] as const;
export type StationId = (typeof STATION_IDS)[number];

/**
 * There is no "walking" status: walking is a client side animation
 * derived from a change of `location`.
 */
export const AGENT_STATUSES = [
  "idle",
  "thinking",
  "working",
  "communicating",
  "waiting_user",
  "waiting_permission",
  "success",
  "error",
  "offline",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Claude reasoning effort levels (our own type; the SDK has a matching one). */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** What a run actually used, as Claude Code reported it (the effort may be lowered silently). */
export interface RunModelInfo {
  /** Full model id, e.g. "claude-opus-5-5". */
  model: string;
  /** null when Claude reported no effort (a model without effort support, or not reported yet). */
  effort: string | null;
}

export interface AgentState {
  /** `${projectId}:${role}`, see ids.ts. */
  id: string;
  projectId: string;
  role: AgentRole;
  /** Display name. Data only; never used as a key. */
  name: string;
  status: AgentStatus;
  /** Short human readable text, e.g. "Reading src/app/page.tsx". */
  activity: string;
  location: StationId;
  currentTaskId: string | null;
  claudeSessionId: string | null;
  /** No tools at all: the agent only answers from what it knows and the conversation. */
  chatOnly: boolean;
  /** Claude model alias for this agent's next runs (one of config.models). */
  model: string;
  /** null = the model's default effort. */
  effort: EffortLevel | null;
  /** The model and effort of the latest run, or null before the first run since the server started. */
  lastRun: RunModelInfo | null;
  busy: boolean;
  queuedCount: number;
  lastError: string | null;
  updatedAt: number;
}
