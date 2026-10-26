export const WORKFLOW_PHASES = [
  "queued",
  "intake",
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
  "picked_up",
  "delegated",
  "plan_ready",
  "findings_published",
  "submitted",
  "tests_passed",
  "tests_failed",
  "approved",
  "changes_requested",
  "abort",
] as const;
export type WorkflowSignal = (typeof WORKFLOW_SIGNALS)[number];

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
}

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
  /** Implementation attempt counter, 1-based once implementation starts, 0 before. */
  iteration: number;
  subtasks: Subtask[];
  findings: string[];
  history: TaskTransition[];
  /** Set while the pipeline is paused: usage limit, waiting for permission, server restart. */
  blockedReason: string | null;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
}
