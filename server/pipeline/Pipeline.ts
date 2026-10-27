// The task pipeline. Tasks start from the New task form and run through fixed steps:
//
//   intake (sONion Ring) → planning (Pronelio Maximus) → [research (Drater)] →
//   implementation (STD Dren) → testing (Quantarino) → review (Rabies) → summary (sONion Ring)
//
// Server code decides every handoff from the step's reply markers (handoff.ts) and the
// workflow state machine (workflow.ts); no agent chooses who goes next. One active task per
// project; others wait in line by priority, then age. Each task has its own Claude session
// per role. A step that cannot go on pauses the task (blockedReason) until I resume it.

import { CONFIG } from "../../src/shared/config.ts";
import type { ChatAuthor } from "../../src/shared/domain/chatTypes.ts";
import {
  answerHandoff,
  continueText,
  firstLine,
  implementationHandoff,
  intakeHandoff,
  parseReply,
  planningHandoff,
  readStepResult,
  reminderText,
  researchHandoff,
  reviewHandoff,
  reworkHandoff,
  STEP_ROLE,
  summaryHandoff,
  testingHandoff,
  type Marker,
  type PipelineStep,
  type TeamNames,
} from "../../src/shared/domain/handoff.ts";
import type { AgentInput } from "../../src/shared/domain/messageQueue.ts";
import { AGENT_ROLES, type AgentRole } from "../../src/shared/domain/roles.ts";
import { PRIORITY_ORDER, type Task, type TaskEndReason, type WorkflowSignal } from "../../src/shared/domain/taskTypes.ts";
import { applySignal, blockTask, createTask, isTerminal, unblockTask } from "../../src/shared/domain/workflow.ts";
import type { TaskPayload } from "../../src/shared/events/eventPayloads.ts";
import type { AgentEventType, EventSeverity } from "../../src/shared/events/eventTypes.ts";
import { makeAgentId, newId, parseAgentId } from "../../src/shared/ids.ts";
import type { CommandArgsMap } from "../../src/shared/protocol/protocol.ts";
import type { AgentManager, InputResult, TaskHooks } from "../agents/AgentManager.ts";
import type { DataStore, SavedHandoff, SavedTask } from "../store/DataStore.ts";
import type { World } from "../world/World.ts";

/** Pause reasons the pipeline sets itself (errors use the error line). */
export const PAUSE = {
  stopped: "Stopped by you",
  restarted: "Server restarted",
  archived: "Project archived",
  question: "Waiting for your answer",
  permission: "Waiting for your OK",
} as const;

export interface PipelineDeps {
  world: World;
  agents: AgentManager;
  store: DataStore | null;
  /** Appends the task log line to the project's notes (and emits notes.updated). */
  writeTaskLog(projectId: string, text: string): void;
  /** Number of open permission cards of an agent. */
  pendingPermissions(agentId: string): number;
}

const WORKFLOW = { maxIterations: CONFIG.maxIterations, phaseProgress: CONFIG.phaseProgress };

function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class Pipeline implements TaskHooks {
  private readonly records = new Map<string, SavedTask>();
  /** Agent activity per input id while it is queued or running (not saved: task inputs do not survive a restart). */
  private readonly activities = new Map<string, string>();
  private readonly deps: PipelineDeps;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
  }

  // ── Loading ──

  /** Saved tasks from World.load. A step that was queued or running is paused "Server restarted". */
  load(saved: ReadonlyMap<string, readonly SavedTask[]>): void {
    const now = this.deps.world.now();
    for (const [projectId, list] of saved) {
      let changed = false;
      for (const loaded of list) {
        const record: SavedTask = { ...loaded };
        if (record.inputId !== null) {
          record.inputId = null;
          record.task = blockTask(record.task, PAUSE.restarted, now);
          changed = true;
        }
        this.records.set(record.task.id, record);
        this.deps.world.tasks.set(record.task.id, record.task);
      }
      if (changed) this.save(projectId);
    }
    this.deps.world.changed();
  }

  /** Starts waiting tasks in projects without an active one (once the server owns its port). */
  start(): void {
    for (const projectId of this.deps.world.projects.keys()) this.startNext(projectId);
  }

  // ── Commands ──

  submit(args: CommandArgsMap["submitTask"]): Task {
    const { world } = this.deps;
    const project = world.getProject(args.projectId);
    if (project.archived) throw new Error("Project is archived");
    const title = args.title.trim();
    if (title.length === 0 || title.length > CONFIG.maxTaskTitleChars) {
      throw new Error(`Task title must be 1 to ${CONFIG.maxTaskTitleChars} characters`);
    }
    const task = createTask(
      newId("task"),
      { projectId: project.id, title, description: args.description?.trim() ?? "", priority: args.priority ?? "medium" },
      world.now(),
    );
    const record: SavedTask = { task, step: null, inputId: null, started: false, reminderSent: false, questionAnswered: false, handoff: null };
    this.put(record);
    this.emitTask("task.created", record, `New task "${title}"`);
    this.startNext(project.id);
    return this.get(task.id).task;
  }

  /** Resumes a paused task: the step's agent continues in its task session, or gets the handoff again. */
  resume(taskId: string): void {
    const record = this.get(taskId);
    const { task } = record;
    if (task.endReason !== null) throw new Error("Task has already ended");
    if (task.question !== null) throw new Error(`Answer ${this.names(task.projectId).orchestrator}'s question instead`);
    if (record.inputId !== null) {
      throw new Error(task.blockedReason === PAUSE.permission ? "Task is waiting for your OK on a permission card" : "Task is not paused");
    }
    if (task.blockedReason === null || record.step === null || record.handoff === null) throw new Error("Task is not paused");
    if (this.deps.world.getProject(task.projectId).archived) throw new Error("Project is archived");

    record.task = unblockTask(task, this.deps.world.now());
    this.emitTask("task.resumed", record, `Task "${task.title}" resumed`);
    const role = STEP_ROLE[record.step];
    if (record.started && record.task.sessions[role] !== undefined) {
      this.deliver(record, this.systemInput(continueText(record.step), "Continuing the task"), false);
    } else {
      this.deliver(record, record.handoff, true);
    }
  }

  /** My answer to sONion Ring's question; he writes the brief in his task session. */
  answer(taskId: string, text: string): void {
    const record = this.get(taskId);
    const { task } = record;
    if (task.endReason !== null) throw new Error("Task has already ended");
    if (task.question === null) throw new Error("Task has no question to answer");
    if (this.deps.world.getProject(task.projectId).archived) throw new Error("Project is archived");

    record.task = { ...unblockTask(task, this.deps.world.now()), question: null };
    record.questionAnswered = true;
    this.emitTask("task.resumed", record, `You answered: ${firstLine(text)}`);
    const handoff: SavedHandoff = {
      text: answerHandoff(task, text),
      fromAgentId: null,
      author: { kind: "user" },
      activity: "Reading your answer",
      linkKind: "assign",
    };
    this.startStep(record, "intake", handoff, true);
  }

  /** Stops the running step, removes the task's waiting inputs and ends it as cancelled. */
  cancel(taskId: string): void {
    const record = this.get(taskId);
    if (record.task.endReason !== null) throw new Error("Task has already ended");
    // Forget the input first, so its stop is not taken for "Stopped by you".
    record.inputId = null;
    this.deps.agents.removeTaskInputs(taskId);
    const running = this.deps.agents.runningTaskAgent(taskId);
    if (running !== null) this.deps.agents.stopAgent(running);
    this.end(record, "cancelled", "cancelled by you");
  }

  /** Archiving: a queued step is taken out of its agent's queue; a running one is stopped by the archive itself. */
  onArchive(projectId: string): void {
    const record = this.active(projectId);
    if (record === null || record.inputId === null || this.deps.agents.runningTaskAgent(record.task.id) !== null) return;
    record.inputId = null;
    this.deps.agents.removeTaskInputs(record.task.id);
    this.pause(record, PAUSE.archived);
  }

  /** Restoring does not resume a paused task, but a waiting one may start when none is active. */
  onRestore(projectId: string): void {
    this.startNext(projectId);
  }

  /** A permission card for an agent was opened or answered. */
  onPermissionChange(agentId: string): void {
    for (const record of this.records.values()) {
      if (record.inputId === null || this.deps.agents.runningTaskAgent(record.task.id) !== agentId) continue;
      const waiting = this.deps.pendingPermissions(agentId) > 0;
      const now = this.deps.world.now();
      if (waiting && record.task.blockedReason === null) {
        record.task = blockTask(record.task, PAUSE.permission, now);
      } else if (!waiting && record.task.blockedReason === PAUSE.permission) {
        record.task = unblockTask(record.task, now);
      } else {
        continue;
      }
      this.put(record);
      this.emitTask("task.status_changed", record, `Task "${record.task.title}": ${record.task.blockedReason ?? "continuing"}`, { feed: false });
    }
  }

  // ── TaskHooks (called by the AgentManager) ──

  sessionFor(taskId: string, agentId: string): string | null {
    const role = parseAgentId(agentId)?.role;
    return role === undefined ? null : (this.records.get(taskId)?.task.sessions[role] ?? null);
  }

  setSession(taskId: string, agentId: string, sessionId: string): void {
    const record = this.records.get(taskId);
    const role = parseAgentId(agentId)?.role;
    if (record === undefined || role === undefined || record.task.sessions[role] === sessionId) return;
    record.task = { ...record.task, sessions: { ...record.task.sessions, [role]: sessionId } };
    this.put(record);
  }

  activityFor(input: AgentInput): string {
    return this.activities.get(input.id) ?? "Working on a task";
  }

  onInputStarted(input: AgentInput): void {
    const record = input.taskId === null ? undefined : this.records.get(input.taskId);
    if (record === undefined || record.inputId !== input.id || record.started) return;
    record.started = true;
    this.put(record);
  }

  onInputEnded(input: AgentInput, result: InputResult): void {
    this.activities.delete(input.id);
    const record = input.taskId === null ? undefined : this.records.get(input.taskId);
    if (record === undefined || record.inputId !== input.id || record.task.endReason !== null || record.step === null) return;
    record.inputId = null;
    if (record.task.blockedReason === PAUSE.permission) record.task = unblockTask(record.task, this.deps.world.now());

    if (!result.ok) {
      this.pause(record, this.pauseReason(record, result));
      return;
    }
    const role = STEP_ROLE[record.step];
    record.task = { ...record.task, outputs: { ...record.task.outputs, [role]: result.text } };
    this.handleReply(record, record.step, result.text);
  }

  // ── Steps ──

  private handleReply(record: SavedTask, step: PipelineStep, text: string): void {
    const result = readStepResult(step, text, !record.questionAnswered);
    const { task } = record;
    const names = this.names(task.projectId);
    const id = (role: AgentRole) => makeAgentId(task.projectId, role);
    const handoff = (from: AgentRole, what: string, body: string, linkKind: SavedHandoff["linkKind"] = "assign"): SavedHandoff => ({
      text: body,
      fromAgentId: id(from),
      author: { kind: "handoff", fromAgentId: id(from) },
      activity: `Reading ${what} from ${names[from]}`,
      linkKind,
    });

    switch (result.kind) {
      case "missing":
        this.missingEnding(record, step, result.marker);
        return;
      case "question":
        record.task = { ...task, question: result.question };
        this.deps.world.emit({
          type: "agent.waiting_user",
          projectId: task.projectId,
          agentId: id("orchestrator"),
          taskId: task.id,
          message: `${names.orchestrator} asks: ${firstLine(result.question)}`,
          severity: "warning",
        });
        this.pause(record, PAUSE.question);
        return;
      case "brief":
        this.signal(record, "delegated");
        this.startStep(record, "planning", handoff("orchestrator", "brief", planningHandoff(names, task, result.brief)));
        return;
      case "plan": {
        record.task = { ...task, subtasks: result.subtasks.map((title) => ({ id: newId("sub"), title, done: false })) };
        this.emitTask("plan.created", record, `${names.product_manager} made a plan with ${result.subtasks.length} steps`, { agentId: id("product_manager") });
        const brief = this.section(record, "orchestrator", "BRIEF");
        if (result.skipResearch) {
          this.signal(record, "research_skipped");
          this.emitTask("implementation.started", record, `${names.engineer} starts attempt ${record.task.iteration}`, { agentId: id("engineer") });
          this.startStep(record, "implementation", handoff("product_manager", "plan", implementationHandoff(names, task, brief, result.plan, null)));
        } else {
          this.signal(record, "plan_ready");
          this.startStep(record, "research", handoff("product_manager", "plan", researchHandoff(names, task, brief, result.plan, result.researchQuestions)));
        }
        return;
      }
      case "findings": {
        record.task = { ...task, findings: result.items };
        this.emitTask("research.completed", record, `${names.researcher} published ${result.items.length} findings`, { agentId: id("researcher") });
        this.signal(record, "findings_published");
        this.emitTask("implementation.started", record, `${names.engineer} starts attempt ${record.task.iteration}`, { agentId: id("engineer") });
        const body = implementationHandoff(names, task, this.section(record, "orchestrator", "BRIEF"), this.section(record, "product_manager", "PLAN"), result.findings);
        this.startStep(record, "implementation", handoff("researcher", "findings", body));
        return;
      }
      case "changes":
        this.emitTask("implementation.submitted", record, `${names.engineer} submitted attempt ${task.iteration}`, { agentId: id("engineer") });
        this.signal(record, "submitted");
        this.emitTask("qa.started", record, `${names.qa} tests attempt ${task.iteration}`, { agentId: id("qa") });
        this.startStep(
          record,
          "testing",
          handoff("engineer", "changes", testingHandoff(names, task, task.iteration, this.section(record, "product_manager", "PLAN"), result.changes, result.howToTest)),
        );
        return;
      case "qa":
        if (result.verdict === "FAIL") {
          this.emitTask("qa.failed", record, `QA failed attempt ${task.iteration}`, { agentId: id("qa"), severity: "warning" });
          this.rework(record, "qa");
          return;
        }
        this.emitTask("qa.passed", record, `QA passed attempt ${task.iteration}`, { agentId: id("qa"), severity: "success" });
        this.signal(record, "tests_passed");
        this.emitTask("review.started", record, `${names.reviewer} reviews attempt ${task.iteration}`, { agentId: id("reviewer") });
        this.startStep(
          record,
          "review",
          handoff(
            "qa",
            "QA result",
            reviewHandoff(names, task, task.iteration, this.section(record, "orchestrator", "BRIEF"), this.section(record, "product_manager", "PLAN"), this.section(record, "engineer", "CHANGES")),
          ),
        );
        return;
      case "review":
        if (result.verdict === "CHANGES") {
          this.emitTask("review.changes_requested", record, `${names.reviewer} asked for changes`, { agentId: id("reviewer"), severity: "warning" });
          this.rework(record, "review");
          return;
        }
        this.emitTask("review.approved", record, `${names.reviewer} approved attempt ${task.iteration}`, { agentId: id("reviewer"), severity: "success" });
        // The phase stays "review" until the summary arrives.
        this.startStep(
          record,
          "summary",
          handoff("reviewer", "results", summaryHandoff(names, task, task.iteration, this.section(record, "engineer", "CHANGES"), "PASS", "APPROVED"), "report"),
        );
        return;
      case "summary":
        record.task = { ...task, summary: result.summary };
        this.end(record, "done", result.summary);
        return;
    }
  }

  /** QA failed or review asked for changes: STD Dren again, or the task fails past maxIterations. */
  private rework(record: SavedTask, source: "qa" | "review"): void {
    const { task } = record;
    const names = this.names(task.projectId);
    const applied = this.signal(record, source === "qa" ? "tests_failed" : "changes_requested");
    if (applied === "abort") {
      const what = source === "qa" ? "QA failed" : "review asked for changes";
      this.end(record, "failed", `${what} after ${task.iteration} attempts`);
      return;
    }
    const role: AgentRole = source === "qa" ? "qa" : "reviewer";
    const from = makeAgentId(task.projectId, role);
    this.emitTask("implementation.started", record, `${names.engineer} starts attempt ${record.task.iteration}`, { agentId: makeAgentId(task.projectId, "engineer") });
    this.startStep(record, "implementation", {
      text: reworkHandoff(names, task, record.task.iteration, source, task.outputs[role] ?? ""),
      fromAgentId: from,
      author: { kind: "handoff", fromAgentId: from },
      activity: `Reading ${source === "qa" ? "QA report" : "review"} from ${names[role]}`,
      linkKind: "report",
    });
  }

  /** One reminder in the same session; then pause (the summary step ends the task done instead). */
  private missingEnding(record: SavedTask, step: PipelineStep, marker: string): void {
    if (!record.reminderSent) {
      record.reminderSent = true;
      this.deliver(record, this.systemInput(reminderText(step), "Reading a reminder"), false);
      return;
    }
    if (step === "summary") {
      const review = firstLine(record.task.outputs.reviewer ?? "") || "approved";
      record.task = { ...record.task, summary: review };
      this.end(record, "done", review);
      return;
    }
    const name = this.names(record.task.projectId)[STEP_ROLE[step]];
    this.pause(record, `${name} did not finish with ${marker}`);
  }

  /** Begins a step with its handoff. While the usage limit is on, the task pauses instead (unless I asked: force). */
  private startStep(record: SavedTask, step: PipelineStep, handoff: SavedHandoff, force = false): void {
    record.step = step;
    record.handoff = handoff;
    record.reminderSent = false;
    record.started = false;
    record.task = { ...record.task, assignedAgentId: makeAgentId(record.task.projectId, STEP_ROLE[step]) };
    if (!force && this.deps.world.usage.limited) {
      this.pause(record, this.usageReason());
      return;
    }
    this.deliver(record, handoff, true);
  }

  /** Puts an input in the step's agent's queue. Handoffs also emit task.assigned, agent.message and a link. */
  private deliver(record: SavedTask, input: SavedHandoff, isHandoff: boolean): void {
    const { world, agents } = this.deps;
    const { task } = record;
    if (record.step === null) return;
    if (world.getProject(task.projectId).archived) {
      this.pause(record, PAUSE.archived);
      return;
    }
    const agentId = makeAgentId(task.projectId, STEP_ROLE[record.step]);
    agents.enqueueTaskInput({ agentId, taskId: task.id, text: input.text, author: input.author, fromAgentId: input.fromAgentId }, (message) => {
      record.inputId = message.id;
      this.activities.set(message.id, input.activity);
      this.put(record);
    });
    if (!isHandoff) return;

    const to = world.getAgent(agentId).name;
    const from = input.fromAgentId === null ? null : world.getAgent(input.fromAgentId);
    this.emitTask("task.assigned", record, from === null ? `${to} got task "${task.title}"` : `${from.name} → ${to}`, {
      ...(from === null ? {} : { agentId: from.id }),
      targetAgentId: agentId,
    });
    if (from !== null) {
      world.emit({
        type: "agent.message",
        projectId: task.projectId,
        agentId: from.id,
        targetAgentId: agentId,
        taskId: task.id,
        message: `${from.name} → ${to}: ${input.activity}`,
        feed: false,
      });
      world.addLink(from.id, agentId, input.linkKind);
    }
  }

  private systemInput(text: string, activity: string): SavedHandoff {
    const author: ChatAuthor = { kind: "system" };
    return { text, fromAgentId: null, author, activity, linkKind: "assign" };
  }

  // ── Task state ──

  /** Applies a workflow signal; returns the signal applied ("abort" when rework went past the limit). */
  private signal(record: SavedTask, signal: WorkflowSignal): WorkflowSignal {
    const result = applySignal(record.task, signal, this.deps.world.now(), WORKFLOW);
    if (!result.ok) throw new Error(result.error);
    const from = record.task.phase;
    record.task = result.task;
    this.emitTask("task.status_changed", record, `Task "${record.task.title}": ${from} → ${record.task.phase}`, { feed: false });
    return result.applied;
  }

  private pause(record: SavedTask, reason: string): void {
    record.task = blockTask(record.task, reason, this.deps.world.now());
    this.put(record);
    this.emitTask("task.paused", record, `Task "${record.task.title}" paused: ${reason}`, { severity: "warning" });
  }

  /** Ends the task, writes the task log line and starts the next waiting task of the project. */
  private end(record: SavedTask, reason: TaskEndReason, detail: string): void {
    const now = this.deps.world.now();
    let task = record.task;
    if (!isTerminal(task.phase)) {
      const result = applySignal(task, reason === "done" ? "approved" : "abort", now, WORKFLOW);
      if (result.ok) task = result.task;
    }
    record.task = { ...task, endReason: reason, assignedAgentId: null, question: null };
    record.step = null;
    record.inputId = null;
    record.handoff = null;
    this.put(record);

    const title = record.task.title;
    const log = reason === "done" ? `Task "${title}" done: ${detail}` : reason === "failed" ? `Task "${title}" failed: ${detail}` : `Task "${title}" cancelled`;
    try {
      this.deps.writeTaskLog(record.task.projectId, log);
    } catch {
      // The notes file could not be written; the task still ends.
    }
    if (reason === "done") this.emitTask("task.completed", record, `Task "${title}" done: ${detail}`, { severity: "success" });
    else if (reason === "failed") this.emitTask("task.failed", record, `Task "${title}" failed: ${detail}`, { severity: "error" });
    else this.emitTask("task.cancelled", record, `Task "${title}" cancelled`, { severity: "warning" });
    this.startNext(record.task.projectId);
  }

  /** The project's task that holds its slot (started, not ended; paused included). */
  private active(projectId: string): SavedTask | null {
    for (const record of this.records.values()) {
      if (record.task.projectId === projectId && record.task.endReason === null && record.task.phase !== "queued") return record;
    }
    return null;
  }

  /** Starts the first waiting task (priority, then age) when the project has no active one. */
  private startNext(projectId: string): void {
    if (this.active(projectId) !== null) return;
    if (this.deps.world.projects.get(projectId)?.archived !== false) return;
    const waiting = [...this.records.values()]
      .filter((r) => r.task.projectId === projectId && r.task.endReason === null && r.task.phase === "queued")
      .sort((a, b) => PRIORITY_ORDER[a.task.priority] - PRIORITY_ORDER[b.task.priority] || a.task.createdAt - b.task.createdAt);
    const next = waiting[0];
    if (next === undefined) return;
    this.signal(next, "picked_up");
    this.startStep(next, "intake", {
      text: intakeHandoff(next.task),
      fromAgentId: null,
      author: { kind: "user" },
      activity: "Reading a new task",
      linkKind: "assign",
    });
  }

  private pauseReason(record: SavedTask, result: Extract<InputResult, { ok: false }>): string {
    switch (result.reason) {
      case "stopped":
        return this.deps.world.getProject(record.task.projectId).archived ? PAUSE.archived : PAUSE.stopped;
      case "usage_limit":
        return this.usageReason();
      case "interrupted":
        return PAUSE.restarted;
      case "error":
        return firstLine(result.message) || "The step failed";
    }
  }

  private usageReason(): string {
    const { resetsAt } = this.deps.world.usage;
    return resetsAt === null ? "Usage limit" : `Usage limit, resets ${clockTime(resetsAt)}`;
  }

  /** A marker's section in a role's latest reply of this task. */
  private section(record: SavedTask, role: AgentRole, marker: Marker): string {
    return parseReply(record.task.outputs[role] ?? "").sections[marker] ?? "";
  }

  private names(projectId: string): TeamNames {
    const names = {} as TeamNames;
    for (const role of AGENT_ROLES) names[role] = this.deps.world.getAgent(makeAgentId(projectId, role)).name;
    return names;
  }

  private get(taskId: string): SavedTask {
    const record = this.records.get(taskId);
    if (record === undefined) throw new Error(`Unknown task: ${taskId}`);
    return record;
  }

  private put(record: SavedTask): void {
    record.task = { ...record.task, updatedAt: this.deps.world.now() };
    this.records.set(record.task.id, record);
    this.deps.world.setTask(record.task);
    this.save(record.task.projectId);
  }

  private save(projectId: string): void {
    this.deps.store?.saveTasks(
      projectId,
      [...this.records.values()].filter((r) => r.task.projectId === projectId),
    );
  }

  private emitTask(
    type: AgentEventType,
    record: SavedTask,
    message: string,
    extra: { agentId?: string; targetAgentId?: string; severity?: EventSeverity; feed?: boolean } = {},
  ): void {
    this.put(record);
    this.deps.world.emit({
      type,
      projectId: record.task.projectId,
      taskId: record.task.id,
      message,
      ...extra,
      metadata: { task: record.task } satisfies TaskPayload,
    });
  }
}
