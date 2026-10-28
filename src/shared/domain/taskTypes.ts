import type { ModelSetting } from "../config.ts";
import type { AgentRole } from "./roles.ts";

/** intake and awaiting_approval run at once for any number of tasks; the project's one active task is planning to review. */
export const WORKFLOW_PHASES = [
  "intake",
  "awaiting_approval",
  "queued",
  "planning",
  "research",
  "implementation",
  "testing",
  "review",
  "done",
  "failed",
] as const;
export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const TASK_STATUSES = [
  "queued",
  "assigned",
  "awaiting_approval",
  "in_progress",
  "testing",
  "review",
  "blocked",
  "completed",
  "failed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Lower sorts first. */
export const PRIORITY_ORDER: Record<TaskPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export const WORKFLOW_SIGNALS = [
  /** sONion Ring wrote a brief: intake → awaiting_approval. */
  "brief_ready",
  /** I pressed Start: awaiting_approval → queued (the project's waiting line). */
  "approved_by_user",
  /** I asked for changes to the brief: awaiting_approval → intake. */
  "brief_changes_requested",
  /** The project's slot is free: queued → planning. */
  "picked_up",
  "plan_ready",
  /** The plan has no research questions: planning goes straight to implementation. */
  "research_skipped",
  "findings_published",
  "submitted",
  "tests_passed",
  "tests_failed",
  "approved",
  "changes_requested",
  /** I asked to change a running task (the phase stays). */
  "change_requested",
  /** I applied the change: the pipeline goes on from the restart phase, attempt 1. */
  "change_applied",
  /** I discarded the change (the phase stays). */
  "change_discarded",
  "abort",
  /** Only in the history of tasks from before I confirmed tasks (intake → planning); never applied now. */
  "delegated",
] as const;
export type WorkflowSignal = (typeof WORKFLOW_SIGNALS)[number];

/** How a task ended: done, failed (an error or too many attempts) or cancelled by me. */
export const TASK_END_REASONS = ["done", "failed", "cancelled"] as const;
export type TaskEndReason = (typeof TASK_END_REASONS)[number];

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

/** Where a change to a running task restarts the pipeline (RESTART FROM:). */
export const RESTART_STEPS = ["planning", "research", "implementation", "testing"] as const;
export type RestartStep = (typeof RESTART_STEPS)[number];

/**
 * A card in my chat with sONion Ring: his questions or brief at intake, his updated
 * brief for a change, or any agent's question during the task.
 */
export const ASK_KINDS = ["question", "brief", "change"] as const;
export type AskKind = (typeof ASK_KINDS)[number];

/** "task": the pipeline's own step (intake or a step's question); "change": sONion working on a change. */
export const ASK_LANES = ["task", "change"] as const;
export type AskLane = (typeof ASK_LANES)[number];

/** open until I act; then what happened to it. "dropped": no longer needed (a change replaced it, the task ended). */
export const ASK_OUTCOMES = ["open", "answered", "started", "revised", "applied", "discarded", "cancelled", "dropped"] as const;
export type AskOutcome = (typeof ASK_OUTCOMES)[number];

export interface TaskAsk {
  id: string;
  kind: AskKind;
  lane: AskLane;
  /** Who asks: sONion Ring for briefs and changes, the step's agent for a question. */
  agentId: string;
  /** sONion Ring's restatement of what I asked (YOU ASKED:); null for other agents' questions. */
  youAsked: string | null;
  /** The question(s), or the brief. */
  text: string;
  /** Change cards: where the pipeline goes on from, and why. */
  restartFrom: RestartStep | null;
  restartWhy: string | null;
  createdAt: number;
  outcome: AskOutcome;
  /** My answer or change request. */
  reply: string | null;
  closedAt: number | null;
}

/** pending: sONion is on it or the card waits for me; approved: applies when the running step ends. */
export const CHANGE_OUTCOMES = ["pending", "approved", "applied", "discarded", "failed", "cancelled"] as const;
export type ChangeOutcome = (typeof CHANGE_OUTCOMES)[number];

/** My change to a running task (Change task). */
export interface TaskChange {
  id: string;
  text: string;
  requestedAt: number;
  outcome: ChangeOutcome;
  /** Where the pipeline went on from once applied. */
  restartFrom: RestartStep | null;
  /** Why it failed (sONion could not answer). */
  detail: string | null;
  closedAt: number | null;
}

/** Each agent's model and effort for one task, chosen in New task and locked after. */
export type TaskTeam = Record<AgentRole, ModelSetting>;

export interface TaskTransition {
  from: WorkflowPhase;
  to: WorkflowPhase;
  signal: WorkflowSignal;
  at: number;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  /** Projection of `phase`, or "blocked" while `blockedReason` is set. */
  status: TaskStatus;
  phase: WorkflowPhase;
  assignedAgentId: string | null;
  /** 0..1 */
  progress: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  /** Implementation attempt counter, 1-based once implementation starts, 0 before; a change resets it. */
  iteration: number;
  /** The PLAN steps; ticked when QA passes the attempt that reported them. */
  subtasks: Subtask[];
  /** Plan step numbers (1-based) STD Dren reported done (STEPS DONE:) that QA has not passed yet. */
  claimedSteps: number[];
  findings: string[];
  history: TaskTransition[];
  /** Set while the pipeline is paused: usage limit, waiting for permission, server restart. */
  blockedReason: string | null;
  /** Claude session per role for this task (separate from each agent's chat session). */
  sessions: Partial<Record<AgentRole, string>>;
  /** Latest reply text per role in this task. */
  outputs: Partial<Record<AgentRole, string>>;
  /** A step's question to me while the task waits for my answer; asked by the step's agent (assignedAgentId). */
  question: string | null;
  /** The brief I started (or changed) the task with; null until Start. */
  approvedBrief: string | null;
  /** Cards in my chat with sONion Ring, oldest first. */
  asks: TaskAsk[];
  /** My changes to the running task, oldest first; at most one pending or approved. */
  changes: TaskChange[];
  team: TaskTeam;
  endReason: TaskEndReason | null;
  /** The SUMMARY line written to the task log; for a failed task, why it failed. */
  summary: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  team: TaskTeam;
}
