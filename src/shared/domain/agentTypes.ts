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
  busy: boolean;
  queuedCount: number;
  lastError: string | null;
  updatedAt: number;
}
