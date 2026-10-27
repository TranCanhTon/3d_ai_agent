// Pure workflow state machine (reference section 3.3). No timers, no I/O.
//
// queued ──picked_up──▶ intake ──delegated──▶ planning ──plan_ready──▶ research
// planning ──research_skipped──▶ implementation   (no research questions)
// research ──findings_published──▶ implementation ──submitted──▶ testing
// testing ──tests_passed──▶ review ──approved──▶ done
// testing ──tests_failed──▶ implementation        (rework)
// review  ──changes_requested──▶ implementation   (rework)
// any non-terminal ──abort──▶ failed              (errors, too many attempts, cancel)
//
// Rework when `iteration >= maxIterations` applies `abort` instead and ends in failed.
// The pipeline's summary step (sONion Ring) runs while the phase is still "review":
// it applies `approved` only when the summary arrives.

import type { AppConfig } from "../config.ts";
import type { CreateTaskInput, Task, TaskStatus, WorkflowPhase, WorkflowSignal } from "./taskTypes.ts";

type PhaseProgress = AppConfig["phaseProgress"];

export const PHASE_STATUS: Record<WorkflowPhase, TaskStatus> = {
  queued: "queued",
  intake: "assigned",
  planning: "in_progress",
  research: "in_progress",
  implementation: "in_progress",
  testing: "testing",
  review: "review",
  done: "completed",
  failed: "failed",
};

const TRANSITIONS: Partial<Record<WorkflowPhase, Partial<Record<WorkflowSignal, WorkflowPhase>>>> = {
  queued: { picked_up: "intake" },
  intake: { delegated: "planning" },
  planning: { plan_ready: "research", research_skipped: "implementation" },
  research: { findings_published: "implementation" },
  implementation: { submitted: "testing" },
  testing: { tests_passed: "review", tests_failed: "implementation" },
  review: { approved: "done", changes_requested: "implementation" },
};

const REWORK_SIGNALS: ReadonlySet<WorkflowSignal> = new Set(["tests_failed", "changes_requested"]);

export function isTerminal(phase: WorkflowPhase): boolean {
  return phase === "done" || phase === "failed";
}

export function nextPhase(phase: WorkflowPhase, signal: WorkflowSignal): WorkflowPhase | null {
  if (isTerminal(phase)) return null;
  if (signal === "abort") return "failed";
  return TRANSITIONS[phase]?.[signal] ?? null;
}

export function canTransition(phase: WorkflowPhase, signal: WorkflowSignal): boolean {
  return nextPhase(phase, signal) !== null;
}

export function projectStatus(phase: WorkflowPhase, blockedReason: string | null): TaskStatus {
  if (blockedReason !== null && !isTerminal(phase)) return "blocked";
  return PHASE_STATUS[phase];
}

export type ApplySignalResult =
  | { ok: true; task: Task; /** The signal actually applied (rework past the limit becomes "abort"). */ applied: WorkflowSignal }
  | { ok: false; error: string };

export interface WorkflowOptions {
  maxIterations: number;
  phaseProgress: PhaseProgress;
}

/** Returns a new task; never mutates the input and never throws. */
export function applySignal(task: Task, signal: WorkflowSignal, at: number, options: WorkflowOptions): ApplySignalResult {
  let applied = signal;
  if (REWORK_SIGNALS.has(signal) && canTransition(task.phase, signal) && task.iteration >= options.maxIterations) {
    applied = "abort";
  }

  const to = nextPhase(task.phase, applied);
  if (to === null) {
    return { ok: false, error: `Cannot apply "${signal}" to a task in phase "${task.phase}"` };
  }

  const isRework = REWORK_SIGNALS.has(applied);
  const phaseStart = options.phaseProgress[to][0];
  let progress: number;
  if (to === "done") progress = 1;
  else if (to === "failed") progress = task.progress;
  else if (isRework) progress = phaseStart;
  else progress = Math.max(task.progress, phaseStart);

  const terminal = isTerminal(to);
  const blockedReason = terminal ? null : task.blockedReason;

  return {
    ok: true,
    applied,
    task: {
      ...task,
      phase: to,
      status: projectStatus(to, blockedReason),
      progress,
      iteration: to === "implementation" ? task.iteration + 1 : task.iteration,
      history: [...task.history, { from: task.phase, to, signal: applied, at }],
      updatedAt: at,
      completedAt: terminal ? at : task.completedAt,
      blockedReason,
    },
  };
}

/** Pauses the pipeline for this task. No-op on terminal tasks. */
export function blockTask(task: Task, reason: string, at: number): Task {
  if (isTerminal(task.phase)) return task;
  return { ...task, blockedReason: reason, status: projectStatus(task.phase, reason), updatedAt: at };
}

export function unblockTask(task: Task, at: number): Task {
  if (task.blockedReason === null) return task;
  return { ...task, blockedReason: null, status: projectStatus(task.phase, null), updatedAt: at };
}

export function createTask(id: string, input: CreateTaskInput, at: number): Task {
  return {
    id,
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? "",
    priority: input.priority ?? "medium",
    status: "queued",
    phase: "queued",
    assignedAgentId: null,
    progress: 0,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    iteration: 0,
    subtasks: [],
    findings: [],
    history: [],
    blockedReason: null,
    sessions: {},
    outputs: {},
    question: null,
    endReason: null,
    summary: null,
  };
}
