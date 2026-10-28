// The task pipeline. Tasks start from the New task form and run through fixed steps:
//
//   intake (sONion Ring, with me until I press Start) → [waiting line] → planning (Pronelio Maximus) →
//   [research (Drater)] → implementation (STD Dren) → testing (Quantarino) → review (Rabies) → summary (sONion Ring)
//
// Server code decides every handoff from the step's reply markers (handoff.ts) and the
// workflow state machine (workflow.ts); no agent chooses who goes next. Intake starts at
// once for every new task: sONion Ring restates it and asks (QUESTION:) or writes a brief
// (BRIEF:), and nothing else happens until I press Start. Only then does the task join
// the project's waiting line; one task per project runs from planning to the end. Each
// task has its own Claude session per role. A step that cannot go on pauses the task
// (blockedReason) until I resume it.
//
// Changing a running task: my change goes to sONion Ring's task session beside the
// running step (the "side" lane). The step finishes normally; its reply is held until I
// apply the updated brief (the pipeline goes on from RESTART FROM, attempt 1) or discard
// the change (the held reply is handed on as if nothing happened).

import { CONFIG, type ModelSetting } from "../../src/shared/config.ts";
import type { ChatAuthor } from "../../src/shared/domain/chatTypes.ts";
import {
  answerHandoff,
  changeAnswerHandoff,
  changedTaskLine,
  changeHandoff,
  changeReminderText,
  continueText,
  firstLine,
  implementationHandoff,
  intakeHandoff,
  isNone,
  parseReply,
  PAUSE,
  planningHandoff,
  readChangeResult,
  readStepResult,
  reminderText,
  researchHandoff,
  reviewHandoff,
  reviseBriefHandoff,
  reviseChangeHandoff,
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
import {
  PRIORITY_ORDER,
  type RestartStep,
  type Task,
  type TaskAsk,
  type TaskChange,
  type TaskEndReason,
  type WorkflowSignal,
} from "../../src/shared/domain/taskTypes.ts";
import {
  applySignal,
  blockTask,
  CHANGEABLE_PHASES,
  claimSteps,
  createTask,
  holdsSlot,
  isTerminal,
  taskProgress,
  tickClaimedSteps,
  unblockTask,
} from "../../src/shared/domain/workflow.ts";
import type { TaskPayload } from "../../src/shared/events/eventPayloads.ts";
import type { AgentEventType, EventSeverity } from "../../src/shared/events/eventTypes.ts";
import { makeAgentId, newId, parseAgentId } from "../../src/shared/ids.ts";
import type { CommandArgsMap } from "../../src/shared/protocol/protocol.ts";
import type { AgentManager, InputResult, TaskHooks } from "../agents/AgentManager.ts";
import type { DataStore, SavedHandoff, SavedTask } from "../store/DataStore.ts";
import type { World } from "../world/World.ts";

export interface PipelineDeps {
  world: World;
  agents: AgentManager;
  store: DataStore | null;
  /** Appends the task log line to the project's notes (and emits notes.updated). */
  writeTaskLog(projectId: string, text: string): void;
  /** Number of open permission cards of an agent. */
  pendingPermissions(agentId: string): number;
}

const WORKFLOW = { maxIterations: CONFIG.maxIterations };

/** Restart order: a change goes on from the earliest step it affects. */
const RESTART_ORDER: readonly RestartStep[] = ["planning", "research", "implementation", "testing"];

const STEP_LABEL: Record<PipelineStep, string> = {
  intake: "Intake",
  planning: "Planning",
  research: "Research",
  implementation: "Implementation",
  testing: "Testing",
  review: "Code review",
  summary: "Done",
};

function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The change waiting for sONion Ring or for me (at most one per task). */
function openChange(task: Task): TaskChange | null {
  return task.changes.find((c) => c.outcome === "pending" || c.outcome === "approved") ?? null;
}

function openAsk(task: Task, lane: TaskAsk["lane"], kind?: TaskAsk["kind"]): TaskAsk | null {
  return task.asks.find((a) => a.outcome === "open" && a.lane === lane && (kind === undefined || a.kind === kind)) ?? null;
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
        if (record.task.endReason === null && record.task.phase === "queued" && record.task.approvedBrief === null) {
          // Saved before tasks were confirmed with me: back to intake, run again by Resume.
          record.task = { ...record.task, phase: "intake" };
          record.step = "intake";
          record.handoff = this.intakeInput(record.task);
          record.started = false;
          record.task = blockTask(record.task, PAUSE.restarted, now);
          changed = true;
        }
        if (record.inputId !== null) {
          record.inputId = null;
          record.task = blockTask(record.task, PAUSE.restarted, now);
          changed = true;
        }
        if (record.side !== null && record.side.inputId !== null) {
          // sONion Ring was working on a change: it is lost; a held reply waits for Resume.
          this.closeChange(record, "failed", "Server restarted");
          if (record.held !== null) record.task = blockTask(unblockTask(record.task, now), PAUSE.restarted, now);
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

  /** A new task: sONion Ring's intake starts at once, whatever else runs in the project. */
  submit(args: CommandArgsMap["submitTask"]): Task {
    const { world } = this.deps;
    const project = world.getProject(args.projectId);
    if (project.archived) throw new Error("Project is archived");
    const title = args.title.trim();
    if (title.length === 0 || title.length > CONFIG.maxTaskTitleChars) {
      throw new Error(`Task title must be 1 to ${CONFIG.maxTaskTitleChars} characters`);
    }
    for (const role of AGENT_ROLES) {
      if (!CONFIG.models.some((m) => m.id === args.team[role].model)) throw new Error(`Unknown model: ${args.team[role].model}`);
    }
    const task = createTask(
      newId("task"),
      { projectId: project.id, title, description: args.description?.trim() ?? "", priority: args.priority ?? "medium", team: structuredClone(args.team) },
      world.now(),
    );
    const record: SavedTask = {
      task,
      step: null,
      inputId: null,
      started: false,
      reminderSent: false,
      questionAnswered: false,
      handoff: null,
      held: null,
      side: null,
      changeNote: null,
    };
    this.put(record);
    this.emitTask("task.created", record, `New task "${title}"`);
    this.startStep(record, "intake", this.intakeInput(task));
    return this.get(task.id).task;
  }

  /** Start on a brief card: the brief is locked and the task joins the project's waiting line. */
  approve(taskId: string): void {
    const record = this.get(taskId);
    const ask = this.briefAsk(record);
    const now = this.deps.world.now();
    record.task = {
      ...record.task,
      approvedBrief: ask.text,
      // Nobody works on it while it waits in line.
      assignedAgentId: null,
      asks: this.closeAsk(record.task.asks, ask.id, "started", null, now),
    };
    record.step = null;
    record.handoff = null;
    this.signal(record, "approved_by_user");
    this.emitTask("task.status_changed", record, `You started task "${record.task.title}"`, { severity: "success" });
    this.startNext(record.task.projectId);
  }

  /** Request changes on a brief card (or a change card): sONion Ring writes it again in the task's session. */
  reviseBrief(taskId: string, text: string): void {
    const record = this.get(taskId);
    const request = text.trim();
    if (request === "") throw new Error("Say what to change");
    const changeAsk = openAsk(record.task, "change", "change");
    if (record.task.endReason === null && changeAsk !== null) {
      if (openChange(record.task)?.outcome !== "pending") throw new Error("The change is already applied when the step ends");
      record.task = { ...record.task, asks: this.closeAsk(record.task.asks, changeAsk.id, "revised", request, this.deps.world.now()) };
      this.emitTask("task.status_changed", record, `You asked ${this.names(record.task.projectId).orchestrator} to rework the change`);
      if (record.side !== null) record.side.reminderSent = false;
      this.deliverSide(record, this.myInput(reviseChangeHandoff(record.task, request), "Reading your changes"));
      return;
    }
    const ask = this.briefAsk(record);
    record.task = { ...record.task, asks: this.closeAsk(record.task.asks, ask.id, "revised", request, this.deps.world.now()) };
    this.signal(record, "brief_changes_requested");
    this.startStep(record, "intake", this.myInput(reviseBriefHandoff(record.task, request), "Reading your changes"), true);
  }

  /** Resumes a paused task: the step's agent continues in its task session, or gets the handoff again. */
  resume(taskId: string): void {
    const record = this.get(taskId);
    const { task } = record;
    if (task.endReason !== null) throw new Error("Task has already ended");
    if (task.question !== null) throw new Error(`Answer ${this.askerName(record)}'s question instead`);
    if (task.blockedReason === PAUSE.change) throw new Error("Apply or discard the change first");
    if (record.inputId !== null) {
      throw new Error(task.blockedReason === PAUSE.permission ? "Task is waiting for your OK on a permission card" : "Task is not paused");
    }
    if (task.blockedReason === null || record.step === null || (record.handoff === null && record.held === null)) throw new Error("Task is not paused");
    if (this.deps.world.getProject(task.projectId).archived) throw new Error("Project is archived");

    record.task = unblockTask(task, this.deps.world.now());
    this.emitTask("task.resumed", record, `Task "${task.title}" resumed`);
    this.continueStep(record);
  }

  /** My answer to the task's open question card: back to the agent that asked, in its task session. */
  answer(taskId: string, text: string): void {
    const record = this.get(taskId);
    const { task } = record;
    if (task.endReason !== null) throw new Error("Task has already ended");
    if (this.deps.world.getProject(task.projectId).archived) throw new Error("Project is archived");
    const now = this.deps.world.now();

    const changeQuestion = openAsk(task, "change", "question");
    if (changeQuestion !== null && record.side !== null) {
      record.task = { ...task, asks: this.closeAsk(task.asks, changeQuestion.id, "answered", text, now) };
      this.emitTask("task.status_changed", record, `You answered: ${firstLine(text)}`);
      this.deliverSide(record, this.myInput(changeAnswerHandoff(task, text), "Reading your answer"));
      return;
    }

    const question = openAsk(task, "task", "question");
    if (task.question === null || record.step === null) throw new Error("Task has no question to answer");
    const step = record.step;
    record.task = {
      ...unblockTask(task, now),
      question: null,
      asks: question === null ? task.asks : this.closeAsk(task.asks, question.id, "answered", text, now),
    };
    this.emitTask("task.resumed", record, `You answered: ${firstLine(text)}`);
    this.startStep(record, step, this.myInput(answerHandoff(task, step, text), "Reading your answer"), true);
    // One question per step (intake may ask until sONion Ring is sure).
    record.questionAnswered = step !== "intake";
    this.put(record);
  }

  /** Change task: my change goes to sONion Ring's task session; the pipeline holds after the current step. */
  requestChange(taskId: string, text: string): void {
    const record = this.get(taskId);
    const { task } = record;
    const request = text.trim();
    if (task.endReason !== null) throw new Error("Task has already ended");
    if (!CHANGEABLE_PHASES.has(task.phase) || record.step === null || record.step === "summary") {
      throw new Error("Only a running task can be changed (planning to review)");
    }
    if (openChange(task) !== null) throw new Error("This task already has a change waiting");
    if (request === "") throw new Error("Say what to change");
    if (this.deps.world.getProject(task.projectId).archived) throw new Error("Project is archived");

    const now = this.deps.world.now();
    const change: TaskChange = { id: newId("change"), text: request, requestedAt: now, outcome: "pending", restartFrom: null, detail: null, closedAt: null };
    record.task = { ...task, changes: [...task.changes, change] };
    this.signal(record, "change_requested");
    this.emitTask("task.status_changed", record, `You asked to change "${task.title}"`);
    record.side = { inputId: null, started: false, reminderSent: false };
    this.deliverSide(record, this.myInput(changeHandoff(task, request, this.changeContext(record)), "Reading your change"));
  }

  /** Apply change: now when no step runs, else as soon as the running step ends. */
  applyChange(taskId: string): void {
    const record = this.get(taskId);
    const change = openChange(record.task);
    const ask = openAsk(record.task, "change", "change");
    if (record.task.endReason !== null) throw new Error("Task has already ended");
    if (change === null || ask === null) throw new Error("There is no updated brief to apply");
    if (change.outcome === "approved") throw new Error("The change is already applied when the step ends");
    if (record.inputId !== null) {
      record.task = { ...record.task, changes: record.task.changes.map((c) => (c.id === change.id ? { ...c, outcome: "approved" } : c)) };
      const name = this.names(record.task.projectId)[STEP_ROLE[record.step ?? "intake"]];
      this.emitTask("task.status_changed", record, `The change applies when ${name} finishes`);
      return;
    }
    this.performApply(record);
  }

  /** Discard change: the pipeline goes on where it held. */
  discardChange(taskId: string): void {
    const record = this.get(taskId);
    if (record.task.endReason !== null) throw new Error("Task has already ended");
    if (openChange(record.task) === null) throw new Error("There is no change to discard");
    this.stopSide(record);
    this.closeChange(record, "discarded", null);
    this.signal(record, "change_discarded");
    this.emitTask("task.status_changed", record, `You discarded the change to "${record.task.title}"`);
    this.releaseHold(record);
  }

  /** Stops the running inputs, removes the task's waiting ones and ends it as cancelled. */
  cancel(taskId: string): void {
    const record = this.get(taskId);
    if (record.task.endReason !== null) throw new Error("Task has already ended");
    // Forget the inputs first, so their stop is not taken for "Stopped by you".
    record.inputId = null;
    record.side = null;
    this.deps.agents.removeTaskInputs(taskId);
    for (const agentId of this.deps.agents.runningTaskAgents(taskId)) this.deps.agents.stopAgent(agentId);
    this.end(record, "cancelled", "cancelled by you");
  }

  /** Archiving: queued inputs are taken out of their agents' queues; running ones are stopped by the archive itself. */
  onArchive(projectId: string): void {
    const running = new Set<string>();
    for (const record of this.records.values()) {
      if (record.task.projectId !== projectId || record.task.endReason !== null) continue;
      for (const agentId of this.deps.agents.runningTaskAgents(record.task.id)) running.add(`${record.task.id}|${agentId}`);
      const stepAgent = record.step === null ? null : makeAgentId(projectId, STEP_ROLE[record.step]);
      if (record.inputId !== null && stepAgent !== null && !running.has(`${record.task.id}|${stepAgent}`)) {
        this.cancelQueued(stepAgent, record.inputId);
        record.inputId = null;
        this.pause(record, PAUSE.archived);
      }
      const orchestrator = makeAgentId(projectId, "orchestrator");
      const sideInput = record.side?.inputId ?? null;
      if (sideInput !== null && !running.has(`${record.task.id}|${orchestrator}`)) {
        this.cancelQueued(orchestrator, sideInput);
        this.failChange(record, PAUSE.archived);
      }
    }
  }

  /** Restoring does not resume a paused task, but a waiting one may start when none is active. */
  onRestore(projectId: string): void {
    this.startNext(projectId);
  }

  /** A permission card for an agent was opened or answered. */
  onPermissionChange(agentId: string): void {
    for (const record of this.records.values()) {
      if (record.inputId === null || record.step === null) continue;
      const stepAgent = makeAgentId(record.task.projectId, STEP_ROLE[record.step]);
      if (stepAgent !== agentId || !this.deps.agents.isRunning(agentId, record.inputId)) continue;
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

  modelFor(taskId: string, agentId: string): ModelSetting | null {
    const role = parseAgentId(agentId)?.role;
    const team = this.records.get(taskId)?.task.team;
    return role === undefined || team === undefined ? null : { ...team[role] };
  }

  activityFor(input: AgentInput): string {
    return this.activities.get(input.id) ?? "Working on a task";
  }

  onInputStarted(input: AgentInput): void {
    const record = input.taskId === null ? undefined : this.records.get(input.taskId);
    if (record === undefined) return;
    if (record.side !== null && record.side.inputId === input.id && !record.side.started) {
      record.side.started = true;
      this.put(record);
    } else if (record.inputId === input.id && !record.started) {
      record.started = true;
      this.put(record);
    }
  }

  onInputEnded(input: AgentInput, result: InputResult): void {
    this.activities.delete(input.id);
    const record = input.taskId === null ? undefined : this.records.get(input.taskId);
    if (record === undefined || record.task.endReason !== null) return;
    if (record.side !== null && record.side.inputId === input.id) {
      record.side.inputId = null;
      this.handleChangeReply(record, result);
      return;
    }
    if (record.inputId !== input.id || record.step === null) return;
    record.inputId = null;
    if (record.task.blockedReason === PAUSE.permission) record.task = unblockTask(record.task, this.deps.world.now());

    if (!result.ok) {
      this.pause(record, this.pauseReason(record, result));
      return;
    }
    const step = record.step;
    const role = STEP_ROLE[step];
    record.task = { ...record.task, outputs: { ...record.task.outputs, [role]: result.text } };
    const change = openChange(record.task);
    if (change !== null) {
      // The step finished; hold its result until I apply or discard the change.
      record.held = { step, text: result.text };
      if (change.outcome === "approved") {
        this.performApply(record);
        return;
      }
      this.pause(record, PAUSE.change);
      return;
    }
    this.handleReply(record, step, result.text);
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
    const now = this.deps.world.now();

    switch (result.kind) {
      case "missing":
        this.missingEnding(record, step, result.marker);
        return;
      case "question":
        record.task = {
          ...task,
          question: result.question,
          asks: [...task.asks, this.newAsk("question", "task", id(STEP_ROLE[step]), result.youAsked, result.question, now)],
        };
        this.deps.world.emit({
          type: "agent.waiting_user",
          projectId: task.projectId,
          agentId: id(STEP_ROLE[step]),
          taskId: task.id,
          message: `${names[STEP_ROLE[step]]} asks: ${firstLine(result.question)}`,
          severity: "warning",
        });
        this.pause(record, PAUSE.question);
        return;
      case "brief":
        record.task = { ...task, asks: [...task.asks, this.newAsk("brief", "task", id("orchestrator"), result.youAsked, result.brief, now)] };
        record.step = null;
        record.handoff = null;
        this.signal(record, "brief_ready");
        this.deps.world.emit({
          type: "agent.waiting_user",
          projectId: task.projectId,
          agentId: id("orchestrator"),
          taskId: task.id,
          message: `${names.orchestrator} wrote the brief for "${task.title}": press Start when it is right`,
          severity: "warning",
        });
        this.put(record);
        return;
      case "plan": {
        record.task = { ...task, subtasks: result.subtasks.map((title) => ({ id: newId("sub"), title, done: false })), claimedSteps: [] };
        this.emitTask("plan.created", record, `${names.product_manager} made a plan with ${result.subtasks.length} steps`, { agentId: id("product_manager") });
        const brief = this.brief(record);
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
        const body = implementationHandoff(names, task, this.brief(record), this.section(record, "product_manager", "PLAN"), result.findings);
        this.startStep(record, "implementation", handoff("researcher", "findings", body));
        return;
      }
      case "changes":
        record.task = claimSteps(task, result.stepsDone);
        this.emitTask("implementation.submitted", record, `${names.engineer} submitted attempt ${task.iteration}`, { agentId: id("engineer") });
        this.signal(record, "submitted");
        this.emitTask("qa.started", record, `${names.qa} tests attempt ${task.iteration}`, { agentId: id("qa") });
        this.startStep(
          record,
          "testing",
          handoff(
            "engineer",
            "changes",
            testingHandoff(names, task, task.iteration, this.brief(record), this.section(record, "product_manager", "PLAN"), result.changes, result.howToTest),
          ),
        );
        return;
      case "qa":
        if (result.verdict === "FAIL") {
          this.emitTask("qa.failed", record, `QA failed attempt ${task.iteration}`, { agentId: id("qa"), severity: "warning" });
          this.rework(record, "qa");
          return;
        }
        record.task = tickClaimedSteps(task);
        this.emitTask("qa.passed", record, `QA passed attempt ${task.iteration}`, { agentId: id("qa"), severity: "success" });
        this.signal(record, "tests_passed");
        this.emitTask("review.started", record, `${names.reviewer} reviews attempt ${task.iteration}`, { agentId: id("reviewer") });
        this.startStep(
          record,
          "review",
          handoff(
            "qa",
            "QA result",
            reviewHandoff(names, task, task.iteration, this.brief(record), this.section(record, "product_manager", "PLAN"), this.section(record, "engineer", "CHANGES")),
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
          handoff(
            "reviewer",
            "results",
            summaryHandoff(names, task, task.iteration, this.brief(record), this.section(record, "engineer", "CHANGES"), "PASS", "APPROVED"),
            "report",
          ),
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
      text: reworkHandoff(names, task, record.task.iteration, source, task.outputs[role] ?? "", this.brief(record)),
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

  /** After a pause: the held reply is handed on, else the step's agent continues (or gets the handoff again). */
  private continueStep(record: SavedTask): void {
    if (record.held !== null) {
      const held = record.held;
      record.held = null;
      this.handleReply(record, held.step, held.text);
      return;
    }
    if (record.step === null || record.handoff === null) return;
    const role = STEP_ROLE[record.step];
    if (record.started && record.task.sessions[role] !== undefined) {
      this.deliver(record, this.systemInput(this.withChangeNote(record, continueText(record.step)), "Continuing the task"), false);
    } else {
      this.deliver(record, record.handoff, true);
    }
  }

  /** Begins a step with its handoff. While the usage limit is on, the task pauses instead (unless I asked: force). */
  private startStep(record: SavedTask, step: PipelineStep, handoff: SavedHandoff, force = false): void {
    const input = { ...handoff, text: this.withChangeNote(record, handoff.text) };
    record.step = step;
    record.handoff = input;
    record.reminderSent = false;
    record.started = false;
    record.questionAnswered = false;
    record.task = { ...record.task, assignedAgentId: makeAgentId(record.task.projectId, STEP_ROLE[step]) };
    if (!force && this.deps.world.usage.limited) {
      this.pause(record, this.usageReason());
      return;
    }
    this.deliver(record, input, true);
  }

  /** The first handoff after a change starts with "Ton changed the task:" and my change. */
  private withChangeNote(record: SavedTask, text: string): string {
    if (record.changeNote === null) return text;
    const note = record.changeNote;
    record.changeNote = null;
    return `${changedTaskLine(CONFIG.userName, note)}\n\n${text}`;
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

  /** Something I wrote (an answer, changes), wrapped in what the agent needs with it. */
  private myInput(text: string, activity: string): SavedHandoff {
    return { text, fromAgentId: null, author: { kind: "user" }, activity, linkKind: "assign" };
  }

  private intakeInput(task: Task): SavedHandoff {
    return this.myInput(intakeHandoff(task), "Reading a new task");
  }

  // ── Changes ──

  /** sONion Ring's change input, beside the running step. */
  private deliverSide(record: SavedTask, input: SavedHandoff): void {
    const { world, agents } = this.deps;
    const { task } = record;
    if (record.side === null) record.side = { inputId: null, started: false, reminderSent: false };
    if (world.getProject(task.projectId).archived) {
      this.failChange(record, PAUSE.archived);
      return;
    }
    const side = record.side;
    const agentId = makeAgentId(task.projectId, "orchestrator");
    agents.enqueueTaskInput({ agentId, taskId: task.id, text: input.text, author: input.author, fromAgentId: null }, (message) => {
      side.inputId = message.id;
      this.activities.set(message.id, input.activity);
      this.put(record);
    });
  }

  private handleChangeReply(record: SavedTask, result: InputResult): void {
    if (!result.ok) {
      this.failChange(record, this.pauseReason(record, result));
      return;
    }
    const { task } = record;
    const names = this.names(task.projectId);
    const orchestrator = makeAgentId(task.projectId, "orchestrator");
    const now = this.deps.world.now();
    const reply = readChangeResult(result.text);
    switch (reply.kind) {
      case "missing":
        if (record.side !== null && !record.side.reminderSent) {
          record.side.reminderSent = true;
          this.deliverSide(record, this.systemInput(changeReminderText(), "Reading a reminder"));
          return;
        }
        this.failChange(record, `${names.orchestrator} did not finish with ${reply.marker}`);
        return;
      case "question":
        record.task = { ...task, asks: [...task.asks, this.newAsk("question", "change", orchestrator, reply.youAsked, reply.question, now)] };
        this.deps.world.emit({
          type: "agent.waiting_user",
          projectId: task.projectId,
          agentId: orchestrator,
          taskId: task.id,
          message: `${names.orchestrator} asks about your change: ${firstLine(reply.question)}`,
          severity: "warning",
        });
        this.put(record);
        return;
      case "change": {
        const ask = { ...this.newAsk("change", "change", orchestrator, reply.youAsked, reply.brief, now), restartFrom: reply.restartFrom, restartWhy: reply.why || null };
        record.task = { ...task, asks: [...task.asks, ask] };
        this.deps.world.emit({
          type: "agent.waiting_user",
          projectId: task.projectId,
          agentId: orchestrator,
          taskId: task.id,
          message: `${names.orchestrator} updated the brief of "${task.title}": apply or discard the change`,
          severity: "warning",
        });
        this.put(record);
        return;
      }
    }
  }

  /** sONion Ring could not answer the change: it is dropped and the pipeline goes on where it held. */
  private failChange(record: SavedTask, detail: string): void {
    record.side = null;
    this.closeChange(record, "failed", detail);
    this.emitTask("task.status_changed", record, `The change to "${record.task.title}" was dropped: ${detail}`, { severity: "warning" });
    this.releaseHold(record);
  }

  /** The pipeline goes on where it held (a paused task stays paused). */
  private releaseHold(record: SavedTask): void {
    if (record.held === null) {
      if (record.task.blockedReason === PAUSE.change) record.task = unblockTask(record.task, this.deps.world.now());
      this.put(record);
      return;
    }
    if (record.task.blockedReason !== PAUSE.change) {
      // Paused for another reason (a restart): Resume hands the held reply on.
      this.put(record);
      return;
    }
    record.task = unblockTask(record.task, this.deps.world.now());
    const held = record.held;
    record.held = null;
    this.handleReply(record, held.step, held.text);
  }

  /** Stops sONion Ring's change input (queued or running) without ending the change as failed. */
  private stopSide(record: SavedTask): void {
    const inputId = record.side?.inputId ?? null;
    record.side = null;
    if (inputId === null) return;
    const orchestrator = makeAgentId(record.task.projectId, "orchestrator");
    if (this.deps.agents.isRunning(orchestrator, inputId)) this.deps.agents.stopAgent(orchestrator);
    else this.cancelQueued(orchestrator, inputId);
  }

  /** The updated brief replaces the approved one; the pipeline goes on from RESTART FROM with attempt 1. */
  private performApply(record: SavedTask): void {
    const change = openChange(record.task);
    const ask = openAsk(record.task, "change", "change");
    if (change === null || ask === null || record.step === null) return;
    const now = this.deps.world.now();
    const held = record.held;
    record.held = null;
    const current = record.step as RestartStep | "review";
    const wanted = this.reachableRestart(record, ask.restartFrom ?? "planning");
    const continueHere = current !== "review" && RESTART_ORDER.indexOf(wanted) > RESTART_ORDER.indexOf(current);
    const restart: RestartStep = continueHere ? (current as RestartStep) : wanted;

    const mainQuestion = openAsk(record.task, "task", "question");
    record.task = {
      ...record.task,
      approvedBrief: ask.text,
      question: null,
      claimedSteps: [],
      asks: mainQuestion === null ? record.task.asks : this.closeAsk(record.task.asks, mainQuestion.id, "dropped", null, now),
    };
    record.task = { ...record.task, asks: this.closeAsk(record.task.asks, ask.id, "applied", null, now) };
    record.task = {
      ...record.task,
      changes: record.task.changes.map((c) => (c.id === change.id ? { ...c, outcome: "applied", restartFrom: wanted, closedAt: now } : c)),
    };
    record.side = null;
    record.changeNote = change.text;
    record.task = unblockTask(record.task, now);
    this.deps.agents.removeTaskInputs(record.task.id);
    this.signal(record, "change_applied", restart);
    const names = this.names(record.task.projectId);
    this.emitTask("task.status_changed", record, `You changed "${record.task.title}": the team goes on from ${STEP_LABEL[wanted].toLowerCase()}`, { severity: "success" });

    if (continueHere) {
      // The change only affects later steps: the held reply (or the paused step) goes on with the new brief.
      if (held !== null) this.handleReply(record, held.step, held.text);
      else this.continueStep(record);
      return;
    }
    if (restart === "implementation") {
      this.emitTask("implementation.started", record, `${names.engineer} starts attempt ${record.task.iteration}`, {
        agentId: makeAgentId(record.task.projectId, "engineer"),
      });
    }
    this.startStep(record, restart, this.restartInput(record, restart), true);
  }

  /** RESTART FROM moved back to a step that has what it needs (testing needs CHANGES, research needs questions). */
  private reachableRestart(record: SavedTask, wanted: RestartStep): RestartStep {
    const plan = this.section(record, "product_manager", "PLAN");
    const questions = parseReply(record.task.outputs.product_manager ?? "").sections["RESEARCH QUESTIONS"];
    let step = wanted;
    if (step === "testing" && this.section(record, "engineer", "CHANGES") === "") step = "implementation";
    if (step === "research" && isNone(questions)) step = "implementation";
    if ((step === "implementation" || step === "research") && plan === "") step = "planning";
    return step;
  }

  /** What the restart step receives (the change line is put in front by startStep). */
  private restartInput(record: SavedTask, step: RestartStep): SavedHandoff {
    const { task } = record;
    const names = this.names(task.projectId);
    const brief = this.brief(record);
    const plan = this.section(record, "product_manager", "PLAN");
    const from = (role: AgentRole, what: string): Omit<SavedHandoff, "text"> => {
      const agentId = makeAgentId(task.projectId, role);
      return { fromAgentId: agentId, author: { kind: "handoff", fromAgentId: agentId }, activity: `Reading ${what} from ${names[role]}`, linkKind: "assign" };
    };
    switch (step) {
      case "planning":
        return { ...from("orchestrator", "the changed brief"), text: planningHandoff(names, task, brief) };
      case "research": {
        const questions = parseReply(task.outputs.product_manager ?? "").sections["RESEARCH QUESTIONS"] ?? "";
        return { ...from("product_manager", "plan"), text: researchHandoff(names, task, brief, plan, questions) };
      }
      case "implementation": {
        const researched = task.history.filter((t) => t.signal === "findings_published" || t.signal === "research_skipped").at(-1)?.signal === "findings_published";
        const findings = researched ? this.section(record, "researcher", "FINDINGS") : null;
        return { ...from(findings === null ? "product_manager" : "researcher", findings === null ? "plan" : "findings"), text: implementationHandoff(names, task, brief, plan, findings) };
      }
      case "testing": {
        const engineer = parseReply(task.outputs.engineer ?? "").sections;
        return {
          ...from("engineer", "changes"),
          text: testingHandoff(names, task, task.iteration, brief, plan, engineer.CHANGES ?? "", engineer["HOW TO TEST"] ?? ""),
        };
      }
    }
  }

  /** What sONion Ring gets with my change. */
  private changeContext(record: SavedTask): Parameters<typeof changeHandoff>[2] {
    const { task } = record;
    const names = this.names(task.projectId);
    const verdicts: string[] = [];
    let attempt = 0;
    for (const t of task.history) {
      if (t.signal === "change_applied") attempt = t.to === "planning" || t.to === "research" ? 0 : 1;
      else if (t.to === "implementation" && t.from !== "implementation") attempt++;
      if (t.signal === "tests_passed" || t.signal === "tests_failed") verdicts.push(`QA, attempt ${attempt}: ${t.signal === "tests_passed" ? "PASS" : "FAIL"}`);
      if (t.signal === "changes_requested") verdicts.push(`Review, attempt ${attempt}: CHANGES`);
    }
    const changes = this.section(record, "engineer", "CHANGES");
    const step = record.step ?? "planning";
    return {
      approvedBrief: this.brief(record),
      plan: this.section(record, "product_manager", "PLAN"),
      changes: changes === "" ? null : changes,
      verdicts,
      currentStep: `${STEP_LABEL[step]} (${names[STEP_ROLE[step]]})`,
    };
  }

  /** Closes the open change and its open cards. */
  private closeChange(record: SavedTask, outcome: "discarded" | "failed" | "cancelled", detail: string | null): void {
    const now = this.deps.world.now();
    const askOutcome = outcome === "discarded" ? "discarded" : outcome === "cancelled" ? "cancelled" : "dropped";
    record.task = {
      ...record.task,
      changes: record.task.changes.map((c) => (c.outcome === "pending" || c.outcome === "approved" ? { ...c, outcome, detail, closedAt: now } : c)),
      asks: record.task.asks.map((a) => (a.lane === "change" && a.outcome === "open" ? { ...a, outcome: askOutcome, closedAt: now } : a)),
    };
  }

  // ── Task state ──

  private newAsk(kind: TaskAsk["kind"], lane: TaskAsk["lane"], agentId: string, youAsked: string | null, text: string, at: number): TaskAsk {
    return { id: newId("ask"), kind, lane, agentId, youAsked, text, restartFrom: null, restartWhy: null, createdAt: at, outcome: "open", reply: null, closedAt: null };
  }

  private closeAsk(asks: TaskAsk[], askId: string, outcome: TaskAsk["outcome"], reply: string | null, at: number): TaskAsk[] {
    return asks.map((a) => (a.id === askId ? { ...a, outcome, reply, closedAt: at } : a));
  }

  /** The open brief card of a task waiting for my OK. */
  private briefAsk(record: SavedTask): TaskAsk {
    const { task } = record;
    if (task.endReason !== null) throw new Error("Task has already ended");
    const ask = openAsk(task, "task", "brief");
    if (task.phase !== "awaiting_approval" || ask === null) throw new Error("This task has no brief waiting for your OK");
    if (this.deps.world.getProject(task.projectId).archived) throw new Error("Project is archived");
    return ask;
  }

  /** Applies a workflow signal; returns the signal applied ("abort" when rework went past the limit). */
  private signal(record: SavedTask, signal: WorkflowSignal, restart?: RestartStep): WorkflowSignal {
    const result = applySignal(record.task, signal, this.deps.world.now(), WORKFLOW, restart);
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
    record.task = task;
    this.closeChange(record, "cancelled", null);
    // Cards still open are closed: Start or answers are no longer possible.
    const askOutcome = reason === "cancelled" ? "cancelled" : "dropped";
    // A failed task keeps its reason (the text of its task log line) where a done one keeps its summary.
    record.task = {
      ...record.task,
      endReason: reason,
      assignedAgentId: null,
      question: null,
      asks: record.task.asks.map((a) => (a.outcome === "open" ? { ...a, outcome: askOutcome, closedAt: now } : a)),
      ...(reason === "failed" ? { summary: detail } : {}),
    };
    record.step = null;
    record.inputId = null;
    record.handoff = null;
    record.held = null;
    record.side = null;
    record.changeNote = null;
    this.put(record);

    const title = record.task.title;
    const applied = record.task.changes.filter((c) => c.outcome === "applied").length;
    const changes = applied === 0 ? "" : ` (${applied} change${applied === 1 ? "" : "s"} applied)`;
    const log =
      reason === "done" ? `Task "${title}" done: ${detail}${changes}` : reason === "failed" ? `Task "${title}" failed: ${detail}${changes}` : `Task "${title}" cancelled${changes}`;
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

  /** The project's task that holds its slot (planning to review, paused included). */
  private active(projectId: string): SavedTask | null {
    for (const record of this.records.values()) {
      if (record.task.projectId === projectId && holdsSlot(record.task)) return record;
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
    const names = this.names(projectId);
    const orchestrator = makeAgentId(projectId, "orchestrator");
    this.startStep(next, "planning", {
      text: planningHandoff(names, next.task, this.brief(next)),
      fromAgentId: orchestrator,
      author: { kind: "handoff", fromAgentId: orchestrator },
      activity: `Reading brief from ${names.orchestrator}`,
      linkKind: "assign",
    });
  }

  /** Takes an input out of its agent's queue; it may have left the queue already. */
  private cancelQueued(agentId: string, inputId: string): void {
    try {
      this.deps.agents.cancelQueued(agentId, inputId);
    } catch {
      // Not queued any more.
    }
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

  /** The brief the team works from: the one I started (or changed) the task with. */
  private brief(record: SavedTask): string {
    return record.task.approvedBrief ?? this.section(record, "orchestrator", "BRIEF");
  }

  /** A marker's section in a role's latest reply of this task. */
  private section(record: SavedTask, role: AgentRole, marker: Marker): string {
    return parseReply(record.task.outputs[role] ?? "").sections[marker] ?? "";
  }

  /** The agent whose step asked the open question. */
  private askerName(record: SavedTask): string {
    return this.names(record.task.projectId)[STEP_ROLE[record.step ?? "intake"]];
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
    record.task = { ...record.task, progress: taskProgress(record.task), updatedAt: this.deps.world.now() };
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
