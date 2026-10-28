// Pure workflow state machine (reference section 3.3). No timers, no I/O.
//
// intake ──brief_ready──▶ awaiting_approval ──approved_by_user──▶ queued ──picked_up──▶ planning
// awaiting_approval ──brief_changes_requested──▶ intake
// planning ──plan_ready──▶ research
// planning ──research_skipped──▶ implementation   (no research questions)
// research ──findings_published──▶ implementation ──submitted──▶ testing
// testing ──tests_passed──▶ review ──approved──▶ done
// testing ──tests_failed──▶ implementation        (rework)
// review  ──changes_requested──▶ implementation   (rework)
// planning…review ──change_requested / change_discarded──▶ same phase
// planning…review ──change_applied(restart)──▶ planning | research | implementation | testing (attempt 1)
// any non-terminal ──abort──▶ failed              (errors, too many attempts, cancel)
//
// intake, awaiting_approval and queued do not hold the project's slot: the one active
// task per project is the one in planning to review. Rework when `iteration >= maxIterations`
// applies `abort` instead and ends in failed. The pipeline's summary step (sONion Ring)
// runs while the phase is still "review": it applies `approved` only when the summary arrives.

import { parseAgentId } from "../ids.ts";
import type { CreateTaskInput, RestartStep, Task, TaskStatus, WorkflowPhase, WorkflowSignal } from "./taskTypes.ts";

export const PHASE_STATUS: Record<WorkflowPhase, TaskStatus> = {
  intake: "assigned",
  awaiting_approval: "awaiting_approval",
  queued: "queued",
  planning: "in_progress",
  research: "in_progress",
  implementation: "in_progress",
  testing: "testing",
  review: "review",
  done: "completed",
  failed: "failed",
};

/** The phases a running task can be changed in (Change task). */
export const CHANGEABLE_PHASES: ReadonlySet<WorkflowPhase> = new Set(["planning", "research", "implementation", "testing", "review"]);

const STAY = (phase: WorkflowPhase) => ({ change_requested: phase, change_discarded: phase });

const TRANSITIONS: Partial<Record<WorkflowPhase, Partial<Record<WorkflowSignal, WorkflowPhase>>>> = {
  intake: { brief_ready: "awaiting_approval" },
  awaiting_approval: { approved_by_user: "queued", brief_changes_requested: "intake" },
  queued: { picked_up: "planning" },
  planning: { plan_ready: "research", research_skipped: "implementation", ...STAY("planning") },
  research: { findings_published: "implementation", ...STAY("research") },
  implementation: { submitted: "testing", ...STAY("implementation") },
  testing: { tests_passed: "review", tests_failed: "implementation", ...STAY("testing") },
  review: { approved: "done", changes_requested: "implementation", ...STAY("review") },
};

const REWORK_SIGNALS: ReadonlySet<WorkflowSignal> = new Set(["tests_failed", "changes_requested"]);

export function isTerminal(phase: WorkflowPhase): boolean {
  return phase === "done" || phase === "failed";
}

/** Holds the project's slot: one task per project from planning to the end of review. */
export function holdsSlot(task: Pick<Task, "phase" | "endReason">): boolean {
  return task.endReason === null && CHANGEABLE_PHASES.has(task.phase);
}

/** `restart` is only used by change_applied. */
export function nextPhase(phase: WorkflowPhase, signal: WorkflowSignal, restart?: RestartStep): WorkflowPhase | null {
  if (isTerminal(phase)) return null;
  if (signal === "abort") return "failed";
  if (signal === "change_applied") return CHANGEABLE_PHASES.has(phase) && restart !== undefined ? restart : null;
  return TRANSITIONS[phase]?.[signal] ?? null;
}

export function canTransition(phase: WorkflowPhase, signal: WorkflowSignal, restart?: RestartStep): boolean {
  return nextPhase(phase, signal, restart) !== null;
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
}

/** Returns a new task; never mutates the input and never throws. `restart` is for change_applied. */
export function applySignal(task: Task, signal: WorkflowSignal, at: number, options: WorkflowOptions, restart?: RestartStep): ApplySignalResult {
  let applied = signal;
  if (REWORK_SIGNALS.has(signal) && canTransition(task.phase, signal) && task.iteration >= options.maxIterations) {
    applied = "abort";
  }

  const to = nextPhase(task.phase, applied, restart);
  if (to === null) {
    return { ok: false, error: `Cannot apply "${signal}" to a task in phase "${task.phase}"` };
  }

  let iteration = task.iteration;
  if (applied === "change_applied") {
    // A change starts the attempts over: attempt 1 from implementation on, none before it.
    iteration = to === "planning" || to === "research" ? 0 : 1;
  } else if (to === "implementation" && to !== task.phase) {
    iteration = task.iteration + 1;
  }

  const terminal = isTerminal(to);
  const blockedReason = terminal ? null : task.blockedReason;
  const next: Task = {
    ...task,
    phase: to,
    status: projectStatus(to, blockedReason),
    iteration,
    history: [...task.history, { from: task.phase, to, signal: applied, at }],
    updatedAt: at,
    completedAt: terminal ? at : task.completedAt,
    blockedReason,
  };
  return { ok: true, applied, task: { ...next, progress: taskProgress(next) } };
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

/** A new task starts at intake: sONion Ring confirms it with me before it joins the waiting line. */
export function createTask(id: string, input: CreateTaskInput, at: number): Task {
  return {
    id,
    projectId: input.projectId,
    title: input.title,
    description: input.description ?? "",
    priority: input.priority ?? "medium",
    status: PHASE_STATUS.intake,
    phase: "intake",
    assignedAgentId: null,
    progress: 0,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    iteration: 0,
    subtasks: [],
    claimedSteps: [],
    findings: [],
    history: [],
    blockedReason: null,
    sessions: {},
    outputs: {},
    question: null,
    approvedBrief: null,
    asks: [],
    changes: [],
    team: input.team,
    endReason: null,
    summary: null,
  };
}

// ── Checklist ───────────────────────────────────────────────────────────────

/** STD Dren reported these plan steps done (STEPS DONE:); kept until QA passes an attempt. Unknown numbers are ignored. */
export function claimSteps(task: Task, steps: readonly number[]): Task {
  const valid = steps.filter((n) => Number.isInteger(n) && n >= 1 && n <= task.subtasks.length);
  const claimed = [...new Set([...task.claimedSteps, ...valid])].sort((a, b) => a - b);
  return { ...task, claimedSteps: claimed };
}

/** QA passed: every reported step ticks (ticks are kept from then on). A FAIL ticks nothing. */
export function tickClaimedSteps(task: Task): Task {
  if (task.claimedSteps.length === 0) return task;
  const ticked = new Set(task.claimedSteps);
  return { ...task, subtasks: task.subtasks.map((s, i) => (ticked.has(i + 1) ? { ...s, done: true } : s)), claimedSteps: [] };
}

// ── Workflow rows and progress ──────────────────────────────────────────────

/** The rows of the task's workflow, in order; "summary" is the Done row (sONion Ring). */
export const WORKFLOW_ROWS = ["intake", "planning", "research", "implementation", "testing", "review", "summary"] as const;
export type WorkflowRow = (typeof WORKFLOW_ROWS)[number];
export type RowState = "done" | "current" | "upcoming" | "skipped";

const ROW_OF_PHASE: Partial<Record<WorkflowPhase, WorkflowRow>> = {
  intake: "intake",
  awaiting_approval: "intake",
  planning: "planning",
  research: "research",
  implementation: "implementation",
  testing: "testing",
  review: "review",
};

/** Where the task is: the row being worked on, or (ended or waiting in line) null. */
export function currentRow(task: Task): WorkflowRow | null {
  if (task.endReason === "done") return null;
  // A failed or cancelled task stopped where it was when it ended.
  const phase = task.phase === "failed" ? (task.history.at(-1)?.from ?? "intake") : task.phase;
  if (phase === "review" && task.assignedAgentId !== null && parseAgentId(task.assignedAgentId)?.role === "orchestrator") return "summary";
  return ROW_OF_PHASE[phase] ?? null;
}

/** Research was skipped in the latest plan (no research questions). */
function researchSkipped(task: Task): boolean {
  const fromPlanning = task.history.filter((t) => t.from === "planning" && (t.signal === "plan_ready" || t.signal === "research_skipped")).at(-1);
  return fromPlanning?.signal === "research_skipped";
}

export function workflowRowStates(task: Task): Record<WorkflowRow, RowState> {
  const states = {} as Record<WorkflowRow, RowState>;
  const current = currentRow(task);
  // Waiting in line after Start: the brief is done, planning is next.
  const index = task.endReason === "done" ? WORKFLOW_ROWS.length : current === null ? (task.phase === "queued" ? 1 : 0) : WORKFLOW_ROWS.indexOf(current);
  const skipped = researchSkipped(task);
  WORKFLOW_ROWS.forEach((row, i) => {
    if (row === "research" && skipped && i < index) states[row] = "skipped";
    else if (i < index) states[row] = "done";
    else if (i === index && current !== null) states[row] = "current";
    else states[row] = "upcoming";
  });
  return states;
}

/** 0..1: each workflow row an equal share, the current one half, skipped ones count as done. */
export function taskProgress(task: Task): number {
  if (task.endReason === "done" || task.phase === "done") return 1;
  const states = Object.values(workflowRowStates(task));
  const score = states.reduce((sum, state) => sum + (state === "done" || state === "skipped" ? 1 : state === "current" ? 0.5 : 0), 0);
  return score / states.length;
}
