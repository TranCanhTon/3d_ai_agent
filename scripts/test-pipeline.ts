// Pipeline tests: `npm test`. Real World, AgentManager, Pipeline and DataStore in process,
// with a scripted fake runner per role (never Claude). Folders live under .tmp/.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentManager } from "../server/agents/AgentManager.ts";
import type { AgentRunCallbacks, AgentRunInput, AgentRunner } from "../server/agents/AgentRunner.ts";
import { PermissionBroker } from "../server/agents/PermissionBroker.ts";
import { ScriptedRunner } from "../server/agents/ScriptedRunner.ts";
import { silentLogger } from "../server/log.ts";
import { Pipeline } from "../server/pipeline/Pipeline.ts";
import { ensureNotesFile, noteDate, readNotes } from "../server/projects/notes.ts";
import { ProjectService } from "../server/projects/ProjectService.ts";
import { DataStore } from "../server/store/DataStore.ts";
import { World } from "../server/world/World.ts";
import { CONFIG } from "../src/shared/config.ts";
import { continueText, PAUSE, reminderText } from "../src/shared/domain/handoff.ts";
import { parseAgentId } from "../src/shared/ids.ts";
import { AGENT_ROLES, type AgentRole } from "../src/shared/domain/roles.ts";
import type { Task, TaskPriority, TaskTeam } from "../src/shared/domain/taskTypes.ts";
import type { AgentEvent } from "../src/shared/events/eventTypes.ts";
import { makeAgentId } from "../src/shared/ids.ts";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    console.log(`  ✗ ${name}\n      ${message.split("\n").slice(0, 8).join("\n      ")}`);
  }
}

const tmpDir = join(process.cwd(), ".tmp", `test-pipeline-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });

// ── Scripted runner ─────────────────────────────────────────────────────────

/** What a scripted agent does with one input. */
type Reply = string | { error: string } | { usageLimit: number | null } | { hang: true };

interface Call {
  agentId: string;
  role: AgentRole;
  text: string;
  sessionId: string | null;
  model: string;
  effort: string | null;
  /** 1-based count of this role's calls in this boot. */
  n: number;
}

type Script = Partial<Record<AgentRole, (call: Call) => Reply>>;

const CHANGE_REPLY = "YOU ASKED:\nPut the toggle in settings\nBRIEF:\nDark mode, toggle in settings.\nRESTART FROM: implementation - the toggle moves";

const DEFAULT_REPLIES: Record<AgentRole, (call: Call) => Reply> = {
  orchestrator: (call) =>
    call.text.includes("The task finished")
      ? "All done, check the header.\nSUMMARY:\nAdded dark mode"
      : call.text.includes("Change request:")
        ? CHANGE_REPLY
        : "YOU ASKED:\nDark mode on every page\nBRIEF:\nMake every page dark.",
  product_manager: () => "Plan below.\nPLAN:\n1. Add the toggle\n2. Save the choice\nRESEARCH QUESTIONS:\n- Which storage?",
  researcher: () => "FINDINGS:\n- Use localStorage\n- Read it before first paint",
  engineer: () => "Done.\nCHANGES:\n- src/Header.tsx: toggle\nHOW TO TEST:\n- click the toggle\nSTEPS DONE: 1, 2",
  qa: () => "Ran npm test.\n**VERDICT: PASS**",
  reviewer: () => "Clean.\nVERDICT: APPROVED",
};

class Runners {
  readonly calls: Call[] = [];
  script: Script = {};
  private readonly counts = new Map<AgentRole, number>();
  /** Inputs that hang until released or stopped, by agent id. */
  private readonly hanging = new Map<string, AgentRunCallbacks>();
  private sessionSeq = 0;
  private readonly prefix: string;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  create(agent: { id: string; role: AgentRole }): AgentRunner {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return {
      run: (input: AgentRunInput, callbacks: AgentRunCallbacks) => {
        const n = (this.counts.get(agent.role) ?? 0) + 1;
        this.counts.set(agent.role, n);
        const call: Call = { agentId: agent.id, role: agent.role, text: input.text, sessionId: input.sessionId, model: input.model, effort: input.effort, n };
        this.calls.push(call);
        timer = setTimeout(() => {
          timer = null;
          callbacks.onSession(input.sessionId ?? `${this.prefix}-${agent.role}-${++this.sessionSeq}`);
          const reply = (this.script[agent.role] ?? DEFAULT_REPLIES[agent.role])(call);
          if (typeof reply === "string") callbacks.onComplete(reply);
          else if ("error" in reply) callbacks.onError(reply.error);
          else if ("usageLimit" in reply) {
            callbacks.onUsageLimit(reply.usageLimit);
            callbacks.onError("Usage limit reached");
          } else this.hanging.set(agent.id, callbacks);
        }, 1);
      },
      stop: () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        this.hanging.delete(agent.id);
      },
    };
  }

  isHanging(agentId: string): boolean {
    return this.hanging.has(agentId);
  }

  /** Finishes a hanging input with this reply. */
  release(agentId: string, text: string): void {
    const callbacks = this.hanging.get(agentId);
    if (callbacks === undefined) throw new Error(`${agentId} is not hanging`);
    this.hanging.delete(agentId);
    callbacks.onComplete(text);
  }

  roles(): AgentRole[] {
    return this.calls.map((c) => c.role);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────

interface Boot {
  world: World;
  agents: AgentManager;
  pipeline: Pipeline;
  projects: ProjectService;
  broker: PermissionBroker;
  runners: Runners;
  events: AgentEvent[];
  projectId: string;
  root: string;
  /** Press Start on every brief as soon as it arrives (most tests are not about confirming). */
  autoStart: boolean;
}

let bootSeq = 0;

/** A fresh (or reloaded, with the same dataDir) server core without sockets. */
type RunnerOverride = (agent: { id: string; role: AgentRole }, broker: PermissionBroker) => AgentRunner;

function boot(dataDir: string, projectIds: string[] = ["proj_a"], makeRunner?: RunnerOverride): Boot {
  const events: AgentEvent[] = [];
  const store = new DataStore(dataDir, silentLogger);
  let b: Boot | null = null;
  const onEvent = (e: AgentEvent) => {
    events.push(e);
    // A brief is ready: press Start like I would (on the next tick, outside the pipeline's call).
    if (b?.autoStart === true && e.type === "agent.waiting_user" && e.taskId !== undefined) {
      const id = e.taskId;
      setTimeout(() => {
        if (b !== null && b.world.tasks.get(id)?.phase === "awaiting_approval") b.pipeline.approve(id);
      }, 0);
    }
  };
  const world = new World({ onEvent, onChange: () => {} }, "echo", Date.now, store);
  const saved = world.load();
  const runners = new Runners(`b${++bootSeq}`);
  let pipeline: Pipeline | null = null;
  let projects: ProjectService | null = null;
  const agents = new AgentManager(
    world,
    (agent) => (makeRunner === undefined ? runners.create(agent) : makeRunner(agent, broker)),
    (agentId, text) => {
      if (projects === null) throw new Error("no notes");
      return projects.addAgentNote(agentId, text);
    },
    { resultHoldMs: 0 },
  );
  projects = new ProjectService({
    world,
    agents,
    browserRoot: tmpDir,
    blockedRoots: [],
    onArchive: (id) => pipeline?.onArchive(id),
    onRestore: (id) => pipeline?.onRestore(id),
  });
  const broker = new PermissionBroker({
    world,
    setStatus: (id, status, activity) => agents.setStatus(id, status, activity),
    onPendingChange: (id) => pipeline?.onPermissionChange(id),
  });
  const service = projects;
  pipeline = new Pipeline({
    world,
    agents,
    store,
    writeTaskLog: (id, text) => service.addTaskLog(id, text),
    pendingPermissions: (id) => broker.pendingFor(id).length,
  });
  agents.setTaskHooks(pipeline);
  pipeline.load(saved.tasks);

  for (const id of projectIds) {
    if (world.projects.has(id)) continue;
    const root = join(dataDir, "..", `root-${id}`);
    ensureNotesFile(root);
    world.addProject({ id, name: id, rootPath: root, isGitRepo: false, archived: false, createdAt: Date.now() });
  }
  agents.restoreQueues(saved.queues);
  pipeline.start();
  const projectId = projectIds[0] ?? "proj_a";
  b = { world, agents, pipeline, projects, broker, runners, events, projectId, root: world.getProjectRoot(projectId), autoStart: true };
  return b;
}

let caseSeq = 0;
function fresh(script: Script = {}, projectIds?: string[]): Boot {
  const b = boot(join(tmpDir, `case-${++caseSeq}`, "data"), projectIds);
  b.runners.script = script;
  return b;
}

async function until(cond: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

const agentOf = (b: Boot, role: AgentRole, projectId = b.projectId) => makeAgentId(projectId, role);
const task = (b: Boot, id: string): Task => b.world.getTask(id);

/** Each agent's current chat picker setting, as the New task dialog starts with. */
function currentTeam(b: Boot, projectId = b.projectId): TaskTeam {
  const team = {} as TaskTeam;
  for (const role of AGENT_ROLES) {
    const agent = b.world.getAgent(makeAgentId(projectId, role));
    team[role] = { model: agent.model, effort: agent.effort };
  }
  return team;
}

function submit(b: Boot, title = "Add dark mode", priority?: TaskPriority, projectId = b.projectId, team?: TaskTeam): string {
  return b.pipeline.submit({ projectId, title, description: "All pages", ...(priority ? { priority } : {}), team: team ?? currentTeam(b, projectId) }).id;
}

async function untilEnded(b: Boot, id: string): Promise<Task> {
  await until(() => task(b, id).endReason !== null, `task "${task(b, id).title}" to end (phase ${task(b, id).phase}, ${task(b, id).blockedReason ?? "-"})`);
  return task(b, id);
}

async function untilPaused(b: Boot, id: string, reason?: string): Promise<Task> {
  await until(
    () => task(b, id).blockedReason !== null && (reason === undefined || task(b, id).blockedReason === reason),
    `task pause ${reason ?? ""} (now ${task(b, id).blockedReason ?? "running"}, phase ${task(b, id).phase})`,
  );
  return task(b, id);
}

const openAsk = (b: Boot, id: string) => task(b, id).asks.find((a) => a.outcome === "open");

async function untilAsk(b: Boot, id: string, kind: "question" | "brief" | "change") {
  await until(() => openAsk(b, id)?.kind === kind, `an open ${kind} card (now ${openAsk(b, id)?.kind ?? "none"}, phase ${task(b, id).phase})`);
  const ask = openAsk(b, id);
  assert.ok(ask !== undefined);
  return ask;
}

const PIPELINE_EVENTS = new Set([
  "task.created",
  "task.assigned",
  "task.paused",
  "task.resumed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "plan.created",
  "research.completed",
  "implementation.started",
  "implementation.submitted",
  "qa.started",
  "qa.passed",
  "qa.failed",
  "review.started",
  "review.approved",
  "review.changes_requested",
  "notes.updated",
]);

const today = noteDate(Date.now());

/** Planning handoffs (sONion Ring → Pronelio Maximus), in the order tasks started. */
const planningOrder = (b: Boot) =>
  b.events
    .filter((e) => e.type === "task.assigned" && e.agentId !== undefined && parseAgentId(e.agentId)?.role === "orchestrator" && parseAgentId(e.targetAgentId ?? "")?.role === "product_manager")
    .map((e) => e.taskId);

// ── Tests ───────────────────────────────────────────────────────────────────
console.log("\nPipeline");

await check("1. happy path through all 7 steps, events in order, task log line, ends done", async () => {
  const b = fresh();
  const id = submit(b);
  const done = await untilEnded(b, id);
  assert.equal(done.endReason, "done");
  assert.equal(done.phase, "done");
  assert.equal(done.status, "completed");
  assert.equal(done.progress, 1);
  assert.equal(done.summary, "Added dark mode");
  assert.equal(done.iteration, 1);
  assert.equal(done.approvedBrief, "Make every page dark.");
  assert.deepEqual(done.subtasks.map((s) => [s.title, s.done]), [["Add the toggle", true], ["Save the choice", true]]);
  assert.deepEqual(done.findings, ["Use localStorage", "Read it before first paint"]);
  assert.deepEqual(done.asks.map((a) => [a.kind, a.outcome]), [["brief", "started"]]);
  assert.deepEqual(b.runners.roles(), ["orchestrator", "product_manager", "researcher", "engineer", "qa", "reviewer", "orchestrator"]);
  assert.deepEqual(
    b.events.filter((e) => PIPELINE_EVENTS.has(e.type)).map((e) => e.type),
    [
      "task.created",
      "task.assigned",
      "task.assigned",
      "plan.created",
      "task.assigned",
      "research.completed",
      "implementation.started",
      "task.assigned",
      "implementation.submitted",
      "qa.started",
      "task.assigned",
      "qa.passed",
      "review.started",
      "task.assigned",
      "review.approved",
      "task.assigned",
      "notes.updated",
      "task.completed",
    ],
  );
  const assigned = b.events.filter((e) => e.type === "task.assigned");
  assert.deepEqual(
    assigned.map((e) => [e.agentId && parseAgentId(e.agentId)?.role, e.targetAgentId && parseAgentId(e.targetAgentId)?.role]),
    [
      [undefined, "orchestrator"],
      ["orchestrator", "product_manager"],
      ["product_manager", "researcher"],
      ["researcher", "engineer"],
      ["engineer", "qa"],
      ["qa", "reviewer"],
      ["reviewer", "orchestrator"],
    ],
  );
  assert.equal(b.events.filter((e) => e.type === "agent.message" && e.targetAgentId !== undefined).length, 6);
  assert.equal(b.events.find((e) => e.type === "task.completed")?.severity, "success");
  assert.ok(readNotes(b.root).includes(`- Task "Add dark mode" done: Added dark mode (task log, ${today})\n`), readNotes(b.root));

  // Handoff messages: the first one is mine, the others come from the previous agent; all carry the task id.
  const intake = b.world.chatFor(agentOf(b, "orchestrator"))[0];
  assert.deepEqual(intake?.author, { kind: "user" });
  assert.ok(intake?.text.startsWith('From you, task "Add dark mode":'));
  const plan = b.world.chatFor(agentOf(b, "researcher"))[0];
  assert.deepEqual(plan?.author, { kind: "handoff", fromAgentId: agentOf(b, "product_manager") });
  assert.equal(plan?.taskId, id);
  assert.ok(plan?.text.includes("RESEARCH QUESTIONS:\n- Which storage?"));
  const summary = b.world.chatFor(agentOf(b, "orchestrator")).find((m) => m.author.kind === "handoff");
  assert.ok(summary?.text.includes("QA: PASS. Review: APPROVED."));
  // Every handoff after Start carries the approved brief.
  for (const role of ["product_manager", "researcher", "engineer", "qa", "reviewer"] as const) {
    assert.ok(b.runners.calls.find((c) => c.role === role)?.text.includes("BRIEF:\nMake every page dark."), role);
  }
  // Activity while reading, and links (the summary request is a report).
  assert.ok(b.events.some((e) => e.type === "agent.status_changed" && e.agentId === agentOf(b, "researcher") && e.metadata?.activity === "Reading plan from Pronelio Maximus"));
  assert.deepEqual(b.world.links.map((l) => l.kind), ["assign", "assign", "assign", "assign", "assign", "report"]);
});

await check("2. RESEARCH QUESTIONS none skips Drater", async () => {
  const b = fresh({ product_manager: () => "PLAN:\n1. Add the toggle\n\nRESEARCH QUESTIONS:\nNone." });
  const id = submit(b);
  await untilEnded(b, id);
  assert.deepEqual(b.runners.roles(), ["orchestrator", "product_manager", "engineer", "qa", "reviewer", "orchestrator"]);
  assert.equal(task(b, id).endReason, "done");
  assert.ok(task(b, id).history.some((h) => h.signal === "research_skipped"));
  const handoff = b.world.chatFor(agentOf(b, "engineer"))[0];
  assert.deepEqual(handoff?.author, { kind: "handoff", fromAgentId: agentOf(b, "product_manager") });
  assert.ok(handoff?.text.includes("FINDINGS:\nnone (no research needed)"));
});

await check("3. QA FAIL → STD Dren in the same task session → QA → review", async () => {
  const b = fresh({ qa: (c) => (c.n === 1 ? "npm test: 2 failing\nVERDICT: FAIL" : "VERDICT: PASS") });
  const id = submit(b);
  await untilEnded(b, id);
  assert.deepEqual(b.runners.roles().slice(3), ["engineer", "qa", "engineer", "qa", "reviewer", "orchestrator"]);
  const engineerCalls = b.runners.calls.filter((c) => c.role === "engineer");
  assert.equal(engineerCalls[0]?.sessionId, null);
  assert.equal(engineerCalls[1]?.sessionId, task(b, id).sessions.engineer);
  assert.ok(engineerCalls[1]?.text.startsWith('From Quantarino Archilles, task "Add dark mode" (attempt 2):'));
  assert.ok(engineerCalls[1]?.text.includes("npm test: 2 failing"));
  assert.ok(b.runners.calls.filter((c) => c.role === "qa")[1]?.text.includes("(attempt 2)"));
  assert.equal(task(b, id).iteration, 2);
  assert.equal(b.events.find((e) => e.type === "qa.failed")?.severity, "warning");
  assert.ok(b.world.links.some((l) => l.kind === "report" && l.to === agentOf(b, "engineer")));
});

await check("4. review CHANGES → STD Dren → QA again → review again", async () => {
  const b = fresh({ reviewer: (c) => (c.n === 1 ? "- Header.tsx: remove the console.log\nVERDICT: CHANGES" : "VERDICT: APPROVED") });
  const id = submit(b);
  await untilEnded(b, id);
  assert.deepEqual(b.runners.roles().slice(3), ["engineer", "qa", "reviewer", "engineer", "qa", "reviewer", "orchestrator"]);
  const rework = b.runners.calls.filter((c) => c.role === "engineer")[1];
  assert.ok(rework?.text.includes("The review asked for changes. Report:\n- Header.tsx: remove the console.log"));
  assert.equal(rework?.sessionId, task(b, id).sessions.engineer);
  assert.equal(task(b, id).endReason, "done");
  assert.ok(b.events.some((e) => e.type === "review.changes_requested"));
});

await check("5. third failed attempt → task failed, task log 'failed' line, next waiting task starts", async () => {
  // QA fails every attempt of "First" (a rework handoff comes from QA or STD Dren, so match the title).
  const b = fresh({ qa: (c) => (c.text.includes('task "Second"') ? "VERDICT: PASS" : "VERDICT: FAIL") });
  const first = submit(b, "First");
  const second = submit(b, "Second");
  await until(() => task(b, second).phase === "queued", "Second waits in line after Start");
  const failed = await untilEnded(b, first);
  assert.equal(failed.endReason, "failed");
  assert.equal(failed.phase, "failed");
  assert.equal(failed.iteration, CONFIG.maxIterations);
  assert.equal(b.runners.calls.filter((c) => c.role === "engineer" && c.text.includes('task "First"')).length, CONFIG.maxIterations);
  assert.ok(readNotes(b.root).includes(`- Task "First" failed: QA failed after 3 attempts (task log, ${today})`), readNotes(b.root));
  assert.equal(failed.summary, "QA failed after 3 attempts", "a failed task keeps why it failed");
  assert.equal(b.events.find((e) => e.type === "task.failed")?.severity, "error");
  await untilEnded(b, second);
  assert.equal(task(b, second).endReason, "done");
  assert.ok((task(b, second).history.find((h) => h.signal === "picked_up")?.at ?? 0) >= (failed.completedAt ?? Infinity));
});

await check("6. intake: sONion asks two rounds, writes a brief, nothing starts until Start; Request changes rewrites it", async () => {
  const b = fresh({
    orchestrator: (c) =>
      c.text.includes("The task finished")
        ? "SUMMARY:\nDark settings page"
        : c.n === 1
          ? "YOU ASKED:\nDark mode\nQUESTION:\n1. All pages or only settings?\n2. Which shade?"
          : c.n === 2
            ? "YOU ASKED:\nDark mode, settings only\nQUESTION:\n1. Keep the toggle?"
            : c.text.includes("Changes to the brief:")
              ? "YOU ASKED:\nDark settings, no toggle\nBRIEF:\nDark settings page, no toggle."
              : "YOU ASKED:\nDark settings with a toggle\nBRIEF:\nDark settings page with a toggle.",
  });
  b.autoStart = false;
  const id = submit(b);
  let ask = await untilAsk(b, id, "question");
  assert.deepEqual([ask.youAsked, ask.text, ask.agentId], ["Dark mode", "1. All pages or only settings?\n2. Which shade?", agentOf(b, "orchestrator")]);
  assert.equal(task(b, id).blockedReason, PAUSE.question);
  assert.equal(task(b, id).question, "1. All pages or only settings?\n2. Which shade?");
  assert.throws(() => b.pipeline.resume(id), /question instead/);
  assert.ok(b.events.some((e) => e.type === "agent.waiting_user"));
  b.pipeline.answer(id, "Only settings, dark grey");
  // A second round of questions is fine at intake.
  ask = await untilAsk(b, id, "question");
  assert.equal(ask.text, "1. Keep the toggle?");
  b.pipeline.answer(id, "Yes");
  ask = await untilAsk(b, id, "brief");
  assert.deepEqual([ask.youAsked, ask.text], ["Dark settings with a toggle", "Dark settings page with a toggle."]);
  const awaiting = task(b, id);
  assert.equal(awaiting.phase, "awaiting_approval");
  assert.equal(awaiting.status, "awaiting_approval");
  assert.equal(awaiting.blockedReason, null);
  assert.deepEqual(awaiting.asks.map((a) => [a.kind, a.outcome, a.reply]), [
    ["question", "answered", "Only settings, dark grey"],
    ["question", "answered", "Yes"],
    ["brief", "open", null],
  ]);
  const orchestratorCalls = b.runners.calls.filter((c) => c.role === "orchestrator");
  assert.ok(orchestratorCalls[1]?.text.includes("Answer to your question:\nOnly settings, dark grey"));
  assert.equal(orchestratorCalls[1]?.sessionId, task(b, id).sessions.orchestrator);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!b.runners.calls.some((c) => c.role === "product_manager"), "nothing starts before Start");

  // Request changes: a new brief, still nothing starts.
  assert.throws(() => b.pipeline.reviseBrief(id, "  "), /what to change/);
  b.pipeline.reviseBrief(id, "No toggle");
  assert.equal(task(b, id).phase, "intake");
  ask = await untilAsk(b, id, "brief");
  assert.equal(ask.text, "Dark settings page, no toggle.");
  assert.ok(b.runners.calls.filter((c) => c.role === "orchestrator").at(-1)?.text.includes("Changes to the brief:\nNo toggle"));
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!b.runners.calls.some((c) => c.role === "product_manager"));
  assert.equal(task(b, id).asks[2]?.outcome, "revised");

  b.pipeline.approve(id);
  assert.equal(task(b, id).approvedBrief, "Dark settings page, no toggle.");
  assert.throws(() => b.pipeline.approve(id), /no brief waiting/);
  await untilEnded(b, id);
  assert.ok(b.runners.calls.find((c) => c.role === "product_manager")?.text.includes("BRIEF:\nDark settings page, no toggle."));
  assert.equal(task(b, id).endReason, "done");
  assert.throws(() => b.pipeline.answer(id, "again"), /already ended/);
});

await check("6b. STD Dren asks mid-implementation → paused on him → my answer goes to his session → he finishes", async () => {
  const b = fresh({
    engineer: (c) => (c.n === 1 ? "Before I build it:\nQUESTION:\nToggle in the header or in settings?" : c.n === 2 ? "QUESTION:\nAnd which colour?" : DEFAULT_REPLIES.engineer(c)),
  });
  const id = submit(b);
  const paused = await untilPaused(b, id, PAUSE.question);
  assert.equal(paused.question, "Toggle in the header or in settings?");
  assert.equal(paused.assignedAgentId, agentOf(b, "engineer"), "the task waits on the agent that asked");
  const ask = openAsk(b, id);
  assert.deepEqual([ask?.kind, ask?.agentId, ask?.youAsked], ["question", agentOf(b, "engineer"), null], "his question is a card in my chat with sONion");
  assert.ok(b.events.some((e) => e.type === "agent.waiting_user" && e.agentId === agentOf(b, "engineer") && e.message.startsWith("STD Dren asks:")));
  assert.throws(() => b.pipeline.resume(id), /STD Dren's question instead/);
  b.pipeline.answer(id, "In the header");
  // His second reply asks again: one question per step, so it counts as a missing ending (reminder, then his normal reply).
  await untilEnded(b, id);
  const engineerCalls = b.runners.calls.filter((c) => c.role === "engineer");
  assert.ok(engineerCalls[1]?.text.includes("Answer to your question:\nIn the header") && engineerCalls[1]?.text.endsWith("end with CHANGES:, HOW TO TEST: and STEPS DONE:."));
  assert.equal(engineerCalls[1]?.sessionId, task(b, id).sessions.engineer, "same task session");
  assert.ok(engineerCalls[2]?.text.startsWith("Your reply did not end"), "the second question was not taken");
  assert.equal(task(b, id).endReason, "done");
});

await check("7. missing VERDICT → one reminder → still missing → paused; Resume continues", async () => {
  const b = fresh({ qa: () => "Everything looks fine to me." });
  const id = submit(b);
  const paused = await untilPaused(b, id, "Quantarino Archilles did not finish with VERDICT:");
  const qaCalls = b.runners.calls.filter((c) => c.role === "qa");
  assert.equal(qaCalls.length, 2);
  assert.equal(qaCalls[1]?.text, reminderText("testing"));
  assert.equal(qaCalls[1]?.sessionId, task(b, id).sessions.qa);
  assert.equal(paused.phase, "testing");
  b.runners.script = { qa: () => "VERDICT: PASS" };
  b.pipeline.resume(id);
  await untilEnded(b, id);
  const resumed = b.runners.calls.filter((c) => c.role === "qa")[2];
  assert.equal(resumed?.text, continueText("testing"));
  assert.equal(resumed?.sessionId, task(b, id).sessions.qa);
  assert.equal(task(b, id).endReason, "done");
  assert.throws(() => b.pipeline.resume(id), /already ended/);
});

await check("7b. intake without YOU ASKED → one reminder → still missing → paused", async () => {
  const b = fresh({ orchestrator: () => "BRIEF:\nMake it dark." });
  const id = submit(b);
  const paused = await untilPaused(b, id, "sONion Ring did not finish with YOU ASKED:");
  assert.equal(paused.phase, "intake");
  assert.equal(b.runners.calls.filter((c) => c.role === "orchestrator")[1]?.text, reminderText("intake"));
});

await check("8. usage limit mid step → paused, no new steps start anywhere; Resume continues", async () => {
  const resetsAt = new Date(2026, 0, 1, 14, 5).getTime();
  const b = fresh({ engineer: (c) => (c.n === 1 ? { usageLimit: resetsAt } : DEFAULT_REPLIES.engineer(c)) }, ["proj_a", "proj_b"]);
  const id = submit(b);
  const paused = await untilPaused(b, id);
  assert.equal(paused.blockedReason, "Usage limit, resets 14:05");
  assert.equal(b.world.usage.limited, true);
  // Another project's new task does not start a step while the limit is on.
  const other = submit(b, "Other", undefined, "proj_b");
  assert.equal(task(b, other).blockedReason, "Usage limit, resets 14:05");
  assert.equal(task(b, other).phase, "intake");
  assert.equal(b.runners.calls.filter((c) => c.agentId === agentOf(b, "orchestrator", "proj_b")).length, 0);
  b.pipeline.resume(id);
  await untilEnded(b, id);
  assert.equal(task(b, id).endReason, "done");
  assert.equal(b.world.usage.limited, false);
  // The paused one waits for its own Resume.
  assert.equal(task(b, other).blockedReason, "Usage limit, resets 14:05");
  b.pipeline.resume(other);
  await untilEnded(b, other);
});

await check("9. Stop during a step → paused 'Stopped by you'; Resume continues", async () => {
  const b = fresh({ engineer: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(c)) });
  const id = submit(b);
  const engineer = agentOf(b, "engineer");
  await until(() => b.runners.isHanging(engineer), "engineer running");
  assert.equal(b.agents.stopAgent(engineer), true);
  const paused = await untilPaused(b, id, PAUSE.stopped);
  assert.equal(paused.phase, "implementation");
  assert.throws(() => b.pipeline.answer(id, "x"), /no question/);
  b.pipeline.resume(id);
  assert.throws(() => b.pipeline.resume(id), /not paused/);
  await untilEnded(b, id);
  const calls = b.runners.calls.filter((c) => c.role === "engineer");
  assert.equal(calls[1]?.text, continueText("implementation"));
  assert.equal(calls[1]?.sessionId, task(b, id).sessions.engineer);
  assert.equal(task(b, id).endReason, "done");
});

await check("10. Cancel removes queued task inputs and ends cancelled", async () => {
  const b = fresh({ orchestrator: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.orchestrator(c)) });
  const orchestrator = agentOf(b, "orchestrator");
  b.agents.sendMessage(orchestrator, "Hi, how is it going?");
  await until(() => b.runners.isHanging(orchestrator), "chat running");
  const id = submit(b);
  assert.equal(b.world.getAgent(orchestrator).queuedCount, 1, "intake waits behind my chat message");
  const waiting = submit(b, "Waiting");
  b.pipeline.cancel(id);
  assert.equal(task(b, id).endReason, "cancelled");
  assert.equal(task(b, id).phase, "failed");
  assert.ok(readNotes(b.root).includes(`- Task "Add dark mode" cancelled (task log, ${today})`));
  assert.ok(b.events.some((e) => e.type === "task.cancelled"));
  // The cancelled intake is gone; the other task's intake waits; my chat keeps running.
  assert.ok(b.world.chatFor(orchestrator).every((m) => m.taskId !== id));
  assert.equal(task(b, waiting).phase, "intake");
  assert.equal(b.runners.isHanging(orchestrator), true);
  assert.throws(() => b.pipeline.cancel(id), /already ended/);

  // Cancelling while a step runs stops it, without a "Stopped by you" pause.
  b.runners.release(orchestrator, "Fine.");
  b.runners.script = { engineer: () => ({ hang: true }) };
  await until(() => b.runners.isHanging(agentOf(b, "engineer")), "engineer running");
  b.pipeline.cancel(waiting);
  assert.equal(task(b, waiting).endReason, "cancelled");
  assert.equal(b.runners.isHanging(agentOf(b, "engineer")), false);
  assert.ok(!b.events.some((e) => e.type === "task.paused"));

  // Cancel on a brief card: the card closes as cancelled.
  b.autoStart = false;
  const third = submit(b, "Third");
  await untilAsk(b, third, "brief");
  b.pipeline.cancel(third);
  assert.deepEqual(task(b, third).asks.map((a) => a.outcome), ["cancelled"]);
});

await check("11. intake and Start happen at once while a task runs; waiting tasks go by priority after Start", async () => {
  const b = fresh();
  const first = submit(b, "First", "low");
  const low = submit(b, "Low", "low");
  const critical = submit(b, "Critical", "critical");
  const high = submit(b, "High", "high");
  for (const t of [first, critical, high, low]) await untilEnded(b, t);
  assert.deepEqual(planningOrder(b), [first, critical, high, low]);
});

await check("11b. a second task is confirmed right away while one runs; after Start it waits and begins when the first ends", async () => {
  const b = fresh({ engineer: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(c)) });
  const first = submit(b, "First");
  await until(() => b.runners.isHanging(agentOf(b, "engineer")), "first task building");
  b.autoStart = false;
  const second = submit(b, "Second");
  await untilAsk(b, second, "brief");
  assert.equal(task(b, second).phase, "awaiting_approval", "intake ran while First holds the slot");
  b.pipeline.approve(second);
  assert.equal(task(b, second).phase, "queued");
  assert.equal(task(b, second).status, "queued");
  assert.equal(task(b, second).assignedAgentId, null, "nobody works on a task waiting in line");
  b.runners.release(agentOf(b, "engineer"), DEFAULT_REPLIES.engineer({} as Call) as string);
  await untilEnded(b, first);
  await untilEnded(b, second);
  assert.deepEqual(planningOrder(b), [first, second]);
});

await check("12. restart mid task (persisted data) → paused 'Server restarted'; Resume continues", async () => {
  const dataDir = join(tmpDir, "restart", "data");
  const before = boot(dataDir);
  before.runners.script = { engineer: () => ({ hang: true }) };
  const id = submit(before);
  const engineer = agentOf(before, "engineer");
  await until(() => before.runners.isHanging(engineer), "engineer running");
  const session = task(before, id).sessions.engineer;
  assert.ok(session !== undefined);
  // Waits behind the running step, so it is saved in STD Dren's queue.
  assert.equal(before.agents.sendMessage(engineer, "A chat message survives").status, "queued");

  // The process dies here; a new server loads the same data folder.
  const after = boot(dataDir);
  const paused = task(after, id);
  assert.equal(paused.blockedReason, PAUSE.restarted);
  assert.equal(paused.phase, "implementation");
  assert.equal(paused.sessions.engineer, session);
  assert.ok(paused.outputs.product_manager?.includes("PLAN:"));
  await until(() => after.runners.calls.length > 0, "the queued chat message to run");
  assert.deepEqual(after.runners.calls.map((c) => c.text), ["A chat message survives"], "no task step runs on its own");
  await until(() => !after.world.getAgent(engineer).busy, "chat done");
  after.pipeline.resume(id);
  await untilEnded(after, id);
  const resumed = after.runners.calls.find((c) => c.role === "engineer" && c.text !== "A chat message survives");
  assert.equal(resumed?.text, continueText("implementation"));
  assert.equal(resumed?.sessionId, session);
  assert.equal(task(after, id).endReason, "done");
});

await check("12b. restart while a task awaits approval: its brief card is still there and Start works", async () => {
  const dataDir = join(tmpDir, "restart-brief", "data");
  const before = boot(dataDir);
  before.autoStart = false;
  const id = submit(before);
  await untilAsk(before, id, "brief");
  const after = boot(dataDir);
  after.autoStart = false;
  const loaded = task(after, id);
  assert.equal(loaded.phase, "awaiting_approval");
  assert.equal(loaded.blockedReason, null);
  assert.deepEqual(loaded.asks.map((a) => [a.kind, a.outcome, a.text]), [["brief", "open", "Make every page dark."]]);
  assert.deepEqual(loaded.team, currentTeam(before));
  after.pipeline.approve(id);
  await untilEnded(after, id);
  assert.equal(task(after, id).endReason, "done");
});

await check("13. task sessions are separate from chat sessions; a new chat leaves them alone", async () => {
  const b = fresh();
  const engineer = agentOf(b, "engineer");
  const chatSessionOf = () => b.world.getChat(b.world.getAgent(engineer).activeChatId).claudeSessionId;
  b.agents.sendMessage(engineer, "What does this repo do?");
  await until(() => chatSessionOf() !== null && !b.world.getAgent(engineer).busy, "chat done");
  const chatSession = chatSessionOf();
  const id = submit(b);
  await untilEnded(b, id);
  const taskCall = b.runners.calls.find((c) => c.role === "engineer" && c.text.includes("Add dark mode"));
  assert.equal(taskCall?.sessionId, null, "a task starts a fresh session");
  const taskSession = task(b, id).sessions.engineer;
  assert.ok(taskSession !== undefined && taskSession !== chatSession);
  assert.equal(chatSessionOf(), chatSession, "the task did not touch the chat session");
  assert.ok(b.agents.getChatHistory(engineer).messages.every((m) => m.taskId === null), "task messages are not in the chat");
  b.agents.newChat(engineer);
  assert.equal(chatSessionOf(), null, "the new chat has no session yet");
  assert.equal(task(b, id).sessions.engineer, taskSession);
  // A second task gets its own sessions again.
  const second = submit(b, "Second");
  await untilEnded(b, second);
  assert.notEqual(task(b, second).sessions.engineer, taskSession);
});

await check("14. a chat message to STD Dren during a task waits in his queue and runs after the current step", async () => {
  const b = fresh({ engineer: (c) => (c.n === 1 ? { hang: true } : c.text === "Quick question" ? "Sure." : DEFAULT_REPLIES.engineer(c)) });
  const engineer = agentOf(b, "engineer");
  const id = submit(b);
  await until(() => b.runners.isHanging(engineer), "engineer step running");
  const chat = b.agents.sendMessage(engineer, "Quick question");
  assert.equal(chat.status, "queued");
  assert.equal(b.world.getAgent(engineer).queuedCount, 1);
  b.runners.release(engineer, DEFAULT_REPLIES.engineer({} as Call) as string);
  await untilEnded(b, id);
  const engineerTexts = b.runners.calls.filter((c) => c.role === "engineer").map((c) => (c.text === "Quick question" ? "chat" : "task"));
  assert.deepEqual(engineerTexts, ["task", "chat"]);
  const chatCall = b.runners.calls.find((c) => c.text === "Quick question");
  assert.equal(chatCall?.sessionId, null, "chat uses the chat session, not the task's");
});

await check("15. getChatHistory: chat view vs tasks view", async () => {
  const b = fresh();
  const engineer = agentOf(b, "engineer");
  b.agents.sendMessage(engineer, "Hello");
  await until(() => !b.world.getAgent(engineer).busy, "chat done");
  const id = submit(b);
  await untilEnded(b, id);
  const chat = b.agents.getChatHistory(engineer);
  assert.deepEqual(chat.messages.map((m) => [m.author.kind, m.taskId]), [["user", null], ["agent", null]]);
  const tasks = b.agents.getChatHistory(engineer, undefined, undefined, "tasks");
  assert.ok(tasks.messages.length >= 2 && tasks.messages.every((m) => m.taskId === id));
  assert.equal(tasks.messages[0]?.author.kind, "handoff", "the handoff is still stored (the UI does not show it)");
  const last = tasks.messages.at(-1);
  assert.ok(last !== undefined);
  const page = b.agents.getChatHistory(engineer, last.id, 1, "tasks");
  assert.deepEqual(page.messages.map((m) => m.id), [tasks.messages.at(-2)?.id]);
  assert.throws(() => b.agents.getChatHistory(engineer, last.id, 1, "chat"), /Unknown message/);
});

// ── Changing a running task ──

await check("16. Change task during implementation: STD Dren finishes, the task holds, Apply restarts from implementation, attempt 1", async () => {
  const b = fresh({
    engineer: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(c)),
    qa: (c) => (c.n === 1 ? "VERDICT: FAIL" : "VERDICT: PASS"),
  });
  const engineer = agentOf(b, "engineer");
  const id = submit(b);
  await until(() => b.runners.isHanging(engineer), "engineer running");
  assert.throws(() => b.pipeline.requestChange(id, " "), /what to change/);
  b.pipeline.requestChange(id, "Put the toggle in settings");
  assert.throws(() => b.pipeline.requestChange(id, "again"), /already has a change/);
  const card = await untilAsk(b, id, "change");
  assert.deepEqual([card.youAsked, card.text, card.restartFrom, card.restartWhy], ["Put the toggle in settings", "Dark mode, toggle in settings.", "implementation", "the toggle moves"]);
  const changeCall = b.runners.calls.filter((c) => c.role === "orchestrator").at(-1);
  assert.ok(changeCall?.text.includes("Change request:\nPut the toggle in settings") && changeCall.text.includes("Approved brief:\nMake every page dark."));
  assert.ok(changeCall?.text.includes("Current step: Implementation (STD Dren)"));
  assert.equal(changeCall?.sessionId, task(b, id).sessions.orchestrator, "sONion's task session");
  assert.equal(task(b, id).blockedReason, null, "STD Dren is still working");

  // He finishes his step normally; the pipeline holds instead of handing off to QA.
  b.runners.release(engineer, "Built it.\nCHANGES:\n- Header.tsx\nHOW TO TEST:\n- click\nSTEPS DONE: 1");
  await untilPaused(b, id, PAUSE.change);
  assert.ok(!b.runners.calls.some((c) => c.role === "qa"), "no handoff while the change waits");
  assert.throws(() => b.pipeline.resume(id), /Apply or discard/);

  b.pipeline.applyChange(id);
  const applied = task(b, id);
  assert.equal(applied.approvedBrief, "Dark mode, toggle in settings.");
  assert.deepEqual([applied.phase, applied.iteration, applied.blockedReason], ["implementation", 1, null]);
  assert.deepEqual(applied.changes.map((c) => [c.outcome, c.restartFrom]), [["applied", "implementation"]]);
  await untilEnded(b, id);
  const engineerCalls = b.runners.calls.filter((c) => c.role === "engineer");
  assert.ok(engineerCalls[1]?.text.startsWith("Ton changed the task:\nPut the toggle in settings\n\nFrom "), engineerCalls[1]?.text.slice(0, 80));
  assert.ok(engineerCalls[1]?.text.includes("(attempt 1)") && engineerCalls[1]?.text.includes("BRIEF:\nDark mode, toggle in settings."));
  assert.ok(!(engineerCalls[2]?.text ?? "").includes("changed the task"), "only the first handoff after the change");
  assert.ok(b.runners.calls.filter((c) => c.role === "qa").every((c) => c.text.includes("BRIEF:\nDark mode, toggle in settings.")));
  const done = task(b, id);
  assert.equal(done.iteration, 2, "attempt counting started over at the change");
  assert.ok(readNotes(b.root).includes(`- Task "Add dark mode" done: Added dark mode (1 change applied) (task log, ${today})`), readNotes(b.root));
});

await check("16b. Apply before the step ends waits for it; Discard hands the held reply on as if nothing happened", async () => {
  const b = fresh({ engineer: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(c)) });
  const engineer = agentOf(b, "engineer");
  const id = submit(b);
  await until(() => b.runners.isHanging(engineer), "engineer running");
  b.pipeline.requestChange(id, "Put the toggle in settings");
  await untilAsk(b, id, "change");
  b.pipeline.applyChange(id);
  assert.equal(task(b, id).changes[0]?.outcome, "approved");
  assert.equal(task(b, id).blockedReason, null);
  b.runners.release(engineer, DEFAULT_REPLIES.engineer({} as Call) as string);
  await until(() => b.runners.calls.filter((c) => c.role === "engineer").length === 2, "the restart");
  assert.ok(b.runners.calls.filter((c) => c.role === "engineer")[1]?.text.startsWith("Ton changed the task:"));
  await untilEnded(b, id);

  // Discard: the held reply goes on to QA unchanged.
  const c = fresh({ engineer: (call) => (call.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(call)) });
  const id2 = submit(c);
  await until(() => c.runners.isHanging(agentOf(c, "engineer")), "engineer running");
  c.pipeline.requestChange(id2, "Put the toggle in settings");
  await untilAsk(c, id2, "change");
  c.runners.release(agentOf(c, "engineer"), "Held reply.\nCHANGES:\n- held.ts\nHOW TO TEST:\n- held\nSTEPS DONE: 1");
  await untilPaused(c, id2, PAUSE.change);
  c.pipeline.discardChange(id2);
  assert.deepEqual(task(c, id2).changes.map((x) => x.outcome), ["discarded"]);
  assert.deepEqual(task(c, id2).asks.map((a) => [a.kind, a.outcome]), [["brief", "started"], ["change", "discarded"]]);
  await untilEnded(c, id2);
  assert.ok(c.runners.calls.find((x) => x.role === "qa")?.text.includes("CHANGES:\n- held.ts"));
  assert.ok(c.runners.calls.every((x) => !x.text.includes("changed the task")));
  assert.equal(task(c, id2).approvedBrief, "Make every page dark.");
  assert.equal(c.runners.calls.filter((x) => x.role === "engineer").length, 1);
});

await check("16c. Change a paused task: Apply resumes it; sONion may ask about the change first", async () => {
  const b = fresh({
    engineer: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(c)),
    orchestrator: (c) =>
      c.text.includes("Change request:")
        ? "YOU ASKED:\nMove the toggle\nQUESTION:\n1. Settings page or profile page?"
        : c.text.includes("about the change")
          ? CHANGE_REPLY
          : DEFAULT_REPLIES.orchestrator(c),
  });
  const engineer = agentOf(b, "engineer");
  const id = submit(b);
  await until(() => b.runners.isHanging(engineer), "engineer running");
  b.agents.stopAgent(engineer);
  await untilPaused(b, id, PAUSE.stopped);
  b.pipeline.requestChange(id, "Move the toggle");
  const question = await untilAsk(b, id, "question");
  assert.deepEqual([question.lane, question.agentId], ["change", agentOf(b, "orchestrator")]);
  assert.equal(task(b, id).blockedReason, PAUSE.stopped, "a paused task stays paused");
  b.pipeline.answer(id, "Settings page");
  await untilAsk(b, id, "change");
  assert.ok(b.runners.calls.filter((c) => c.role === "orchestrator").at(-1)?.text.includes("Answer to your question about the change:\nSettings page"));
  b.pipeline.applyChange(id);
  assert.equal(task(b, id).blockedReason, null, "applying counts as Resume");
  await untilEnded(b, id);
  assert.ok(b.runners.calls.filter((c) => c.role === "engineer")[1]?.text.startsWith("Ton changed the task:\nMove the toggle"));
});

await check("16d. RESTART FROM later than the held step: the held reply goes on with the new brief", async () => {
  const b = fresh({
    product_manager: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.product_manager(c)),
    orchestrator: (c) => (c.text.includes("Change request:") ? CHANGE_REPLY.replace("implementation", "testing") : DEFAULT_REPLIES.orchestrator(c)),
  });
  const pm = agentOf(b, "product_manager");
  const id = submit(b);
  await until(() => b.runners.isHanging(pm), "planning");
  b.pipeline.requestChange(id, "Put the toggle in settings");
  await untilAsk(b, id, "change");
  b.runners.release(pm, DEFAULT_REPLIES.product_manager({} as Call) as string);
  await untilPaused(b, id, PAUSE.change);
  b.pipeline.applyChange(id);
  await untilEnded(b, id);
  // Nothing to test yet, so it goes on from where it held: the plan goes to Drater with the change line.
  assert.equal(b.runners.calls.filter((c) => c.role === "product_manager").length, 1, "the plan was kept");
  assert.ok(b.runners.calls.find((c) => c.role === "researcher")?.text.startsWith("Ton changed the task:"));
  assert.equal(task(b, id).changes[0]?.restartFrom, "implementation", "testing needs changes first");
});

await check("16e. Cancel while a change is pending stops sONion and the step", async () => {
  const b = fresh({ engineer: () => ({ hang: true }), orchestrator: (c) => (c.text.includes("Change request:") ? { hang: true } : DEFAULT_REPLIES.orchestrator(c)) });
  const id = submit(b);
  await until(() => b.runners.isHanging(agentOf(b, "engineer")), "engineer running");
  b.pipeline.requestChange(id, "Move it");
  await until(() => b.runners.isHanging(agentOf(b, "orchestrator")), "sONion on the change");
  b.pipeline.cancel(id);
  assert.equal(task(b, id).endReason, "cancelled");
  assert.deepEqual(task(b, id).changes.map((c) => c.outcome), ["cancelled"]);
  assert.equal(b.runners.isHanging(agentOf(b, "engineer")), false);
  assert.equal(b.runners.isHanging(agentOf(b, "orchestrator")), false);
  assert.ok(!b.events.some((e) => e.type === "task.paused"));
});

await check("17. checklist: nothing ticks on a QA FAIL; reported steps tick together when QA passes", async () => {
  const b = fresh({
    product_manager: () => "PLAN:\n1. a\n2. b\n3. c\n4. d\n5. e\nRESEARCH QUESTIONS:\nnone",
    engineer: (c) => `CHANGES:\n- x\nHOW TO TEST:\n- y\nSTEPS DONE: ${c.n === 1 ? "1, 2, 3, 9" : "4, 5"}`,
    qa: (c) => (c.n === 1 ? "VERDICT: FAIL" : { hang: true }),
  });
  const id = submit(b);
  await until(() => b.runners.isHanging(agentOf(b, "qa")), "QA on attempt 2");
  const rework = task(b, id);
  assert.ok(rework.subtasks.every((s) => !s.done), "attempt 1 failed: nothing ticked");
  assert.deepEqual(rework.claimedSteps, [1, 2, 3, 4, 5]);
  b.runners.release(agentOf(b, "qa"), "VERDICT: PASS");
  await untilEnded(b, id);
  assert.deepEqual(task(b, id).subtasks.map((s) => s.done), [true, true, true, true, true]);
});

await check("18. each task run uses the task's model and effort; the chat picker is untouched and a later change does not count", async () => {
  const b = fresh({ engineer: (call) => (call.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(call)) });
  const engineer = agentOf(b, "engineer");
  const team = { ...currentTeam(b), engineer: { model: "haiku", effort: "low" as const }, orchestrator: { model: "opus", effort: null } };
  const before = b.world.getAgent(engineer);
  const id = submit(b, "Add dark mode", undefined, b.projectId, team);
  assert.throws(
    () => b.pipeline.submit({ projectId: b.projectId, title: "x", team: { ...team, qa: { model: "gpt", effort: null } } }),
    /Unknown model/,
  );
  await until(() => b.runners.isHanging(engineer), "engineer step running");
  // Changed in the chat picker while he works: the task does not follow.
  b.agents.setAgentModel(engineer, "sonnet", null);
  b.runners.script.qa = (call) => (call.n === 1 ? "broken\nVERDICT: FAIL" : "VERDICT: PASS");
  b.runners.release(engineer, DEFAULT_REPLIES.engineer({} as Call) as string);
  await untilEnded(b, id);
  const runs = (role: AgentRole) => b.runners.calls.filter((c) => c.role === role).map((c) => [c.model, c.effort]);
  assert.deepEqual(runs("engineer"), [["haiku", "low"], ["haiku", "low"]]);
  assert.ok(runs("orchestrator").every(([model, effort]) => model === "opus" && effort === null), "intake and summary too");
  assert.deepEqual(task(b, id).team.engineer, { model: "haiku", effort: "low" });
  assert.deepEqual([b.world.getAgent(engineer).model, before.model], ["sonnet", "opus"], "the task never set the chat picker");
});

await check("archive pauses the task 'Project archived'; restore does not resume; Resume does", async () => {
  const b = fresh({ engineer: (c) => (c.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(c)) });
  const id = submit(b);
  await until(() => b.runners.isHanging(agentOf(b, "engineer")), "engineer running");
  b.projects.archiveProject(b.projectId);
  await untilPaused(b, id, PAUSE.archived);
  assert.throws(() => b.pipeline.resume(id), /archived/);
  assert.throws(() => submit(b, "x"), /archived/);
  b.projects.restoreProject(b.projectId);
  assert.equal(task(b, id).blockedReason, PAUSE.archived);
  b.pipeline.resume(id);
  await untilEnded(b, id);
});

await check("a step error (turn cap) pauses with the error line; summary without SUMMARY still ends done", async () => {
  const b = fresh({
    researcher: (c) => (c.n === 1 ? { error: "Stopped after 15 turns (the turn limit).\nmore detail" } : DEFAULT_REPLIES.researcher(c)),
    orchestrator: (c) => (c.text.includes("The task finished") || c.text === reminderText("summary") ? "Thanks all!" : "YOU ASKED:\nx\nBRIEF:\nx"),
  });
  const id = submit(b);
  await untilPaused(b, id, "Stopped after 15 turns (the turn limit).");
  b.pipeline.resume(id);
  const done = await untilEnded(b, id);
  assert.equal(done.endReason, "done");
  assert.equal(done.summary, "Clean.");
  assert.ok(readNotes(b.root).includes(`- Task "Add dark mode" done: Clean. (task log, ${today})`));
});

await check("a permission card during a step: 'Waiting for your OK' until answered, no Resume needed", async () => {
  const b = fresh({ engineer: () => ({ hang: true }) });
  const engineer = agentOf(b, "engineer");
  const id = submit(b);
  await until(() => b.runners.isHanging(engineer), "engineer running");
  const decision = b.broker.decide(engineer, "Edit", { file_path: join(b.root, "a.ts") });
  assert.equal(task(b, id).blockedReason, PAUSE.permission);
  assert.equal(task(b, id).status, "blocked");
  assert.throws(() => b.pipeline.resume(id), /waiting for your OK/);
  const request = b.world.pendingPermissions[0];
  assert.ok(request !== undefined);
  b.broker.respond(request.id, "allow");
  assert.deepEqual(await decision, { behavior: "allow" });
  assert.equal(task(b, id).blockedReason, null);
  assert.equal(task(b, id).status, "in_progress");
  b.runners.release(engineer, DEFAULT_REPLIES.engineer({} as Call) as string);
  b.runners.script = {};
  await untilEnded(b, id);
});

await check("scripted runner: questions, brief, Start, a 5 step plan ticked over two attempts, real cards, a change", async () => {
  const timing = { thinkMs: 1, wordMs: 0, toolMs: 1 };
  const b = boot(join(tmpDir, `case-${++caseSeq}`, "data"), ["proj_a"], (agent, broker) => new ScriptedRunner({ agent, broker, timing }));
  b.autoStart = false;
  const answered: string[] = [];
  const asked: string[] = [];
  // Answer every card like I would in the UI: permission cards, sONion's questions, Start.
  const answer = setInterval(() => {
    for (const request of b.world.pendingPermissions) {
      answered.push(`${request.toolName}:${request.summary}`);
      b.broker.respond(request.id, "allow");
    }
    for (const t of b.world.tasks.values()) {
      const ask = t.asks.find((a) => a.outcome === "open");
      if (ask?.kind === "question") {
        asked.push(ask.text);
        b.pipeline.answer(t.id, "Only the settings page; a test");
      } else if (ask?.kind === "brief") b.pipeline.approve(t.id);
    }
  }, 2);
  try {
    // Short description (under 40 characters): one round of two questions first.
    const id = submit(b, "Add dark mode");
    const done = await untilEnded(b, id);
    assert.equal(done.endReason, "done", done.blockedReason ?? "");
    assert.deepEqual(asked, ["1. Should this cover every page, or only the settings page?\n2. How will you check it is done: a test, or a look in the app?"]);
    assert.equal(done.iteration, 2, "QA failed attempt 1, passed attempt 2");
    assert.equal(done.subtasks.length, 5);
    assert.ok(done.subtasks.every((s) => s.done), "steps 1-3 from attempt 1 and 4-5 from attempt 2 tick when attempt 2 passes");
    assert.equal(done.findings.length, 3);
    assert.equal(done.summary, "Add dark mode: added src/add-dark-mode.ts with a test (scripted run)");
    assert.deepEqual(answered, ["Write:Writing src/add-dark-mode.ts", "Write:Writing src/add-dark-mode.ts"], "one Write card per build step");
    assert.ok(!existsSync(join(b.root, "src", "add-dark-mode.ts")), "an allowed scripted Write writes nothing");
    assert.ok(readNotes(b.root).includes(`- Task "Add dark mode" done: Add dark mode: added src/add-dark-mode.ts`));

    // A long description gets a brief at once; a change returns an updated brief from implementation.
    const long = b.pipeline.submit({ projectId: b.projectId, title: "Add a footer", description: "A footer with the version number and a link to the docs", team: currentTeam(b) }).id;
    await until(() => task(b, long).phase === "implementation", "the long task building");
    b.pipeline.requestChange(long, "Also show the year");
    await untilAsk(b, long, "change");
    assert.equal(openAsk(b, long)?.restartFrom, "implementation");
    b.pipeline.applyChange(long);
    await untilEnded(b, long);
    assert.equal(task(b, long).endReason, "done");
    assert.equal(asked.length, 1, "no questions for the long description");
  } finally {
    clearInterval(answer);
  }
});

await check("task files from before confirming still load: old history, no team; a never started task goes back to intake", async () => {
  const dataDir = join(tmpDir, "legacy", "data");
  const first = boot(dataDir);
  const at = Date.now();
  const old = (id: string, phase: string, endReason: string | null, history: { from: string; to: string; signal: string; at: number }[]) => ({
    task: {
      id, projectId: "proj_a", title: id, description: "", priority: "medium", status: phase === "done" ? "completed" : "queued", phase,
      assignedAgentId: null, progress: 0, createdAt: at, updatedAt: at, completedAt: null, iteration: 0, subtasks: [], findings: [], history,
      blockedReason: null, sessions: {}, outputs: {}, question: null, endReason, summary: null,
    },
    step: null, inputId: null, started: false, reminderSent: false, questionAnswered: false, handoff: null,
  });
  mkdirSync(join(dataDir, "tasks"), { recursive: true });
  writeFileSync(
    join(dataDir, "tasks", "proj_a.json"),
    JSON.stringify([
      old("Old done", "done", "done", [{ from: "queued", to: "intake", signal: "picked_up", at }, { from: "intake", to: "planning", signal: "delegated", at }]),
      old("Old waiting", "queued", null, []),
    ]),
  );
  void first;
  const after = boot(dataDir);
  after.autoStart = false;
  const tasks = [...after.world.tasks.values()];
  const done = tasks.find((t) => t.title === "Old done");
  const waiting = tasks.find((t) => t.title === "Old waiting");
  assert.equal(done?.history[1]?.signal, "delegated");
  assert.deepEqual(done?.team, CONFIG.roleModelDefaults);
  assert.deepEqual([waiting?.phase, waiting?.blockedReason], ["intake", PAUSE.restarted]);
  assert.ok(waiting !== undefined);
  after.pipeline.resume(waiting.id);
  await untilAsk(after, waiting.id, "brief");
});

await check("submit refuses an empty or too long title", async () => {
  const b = fresh();
  assert.throws(() => submit(b, "   "), /1 to 200 characters/);
  assert.throws(() => submit(b, "x".repeat(CONFIG.maxTaskTitleChars + 1)), /characters/);
});

rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll pipeline checks passed." : `\n${failures} pipeline check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
