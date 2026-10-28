// Pipeline tests: `npm test`. Real World, AgentManager, Pipeline and DataStore in process,
// with a scripted fake runner per role (never Claude). Folders live under .tmp/.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
import type { AgentRole } from "../src/shared/domain/roles.ts";
import type { Task, TaskPriority } from "../src/shared/domain/taskTypes.ts";
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

const DEFAULT_REPLIES: Record<AgentRole, (call: Call) => Reply> = {
  orchestrator: (call) =>
    call.text.includes("The task finished") ? "All done, check the header.\nSUMMARY:\nAdded dark mode" : "BRIEF:\nMake every page dark.",
  product_manager: () => "Plan below.\nPLAN:\n1. Add the toggle\n2. Save the choice\nRESEARCH QUESTIONS:\n- Which storage?",
  researcher: () => "FINDINGS:\n- Use localStorage\n- Read it before first paint",
  engineer: () => "Done.\nCHANGES:\n- src/Header.tsx: toggle\nHOW TO TEST:\n- click the toggle",
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
}

let bootSeq = 0;

/** A fresh (or reloaded, with the same dataDir) server core without sockets. */
type RunnerOverride = (agent: { id: string; role: AgentRole }, broker: PermissionBroker) => AgentRunner;

function boot(dataDir: string, projectIds: string[] = ["proj_a"], makeRunner?: RunnerOverride): Boot {
  const events: AgentEvent[] = [];
  const store = new DataStore(dataDir, silentLogger);
  const world = new World({ onEvent: (e) => events.push(e), onChange: () => {} }, "echo", Date.now, store);
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
  return { world, agents, pipeline, projects, broker, runners, events, projectId, root: world.getProjectRoot(projectId) };
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

function submit(b: Boot, title = "Add dark mode", priority?: TaskPriority, projectId = b.projectId): string {
  return b.pipeline.submit({ projectId, title, description: "All pages", ...(priority ? { priority } : {}) }).id;
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
  assert.deepEqual(done.subtasks.map((s) => s.title), ["Add the toggle", "Save the choice"]);
  assert.deepEqual(done.findings, ["Use localStorage", "Read it before first paint"]);
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
  assert.equal(task(b, second).phase, "queued");
  const failed = await untilEnded(b, first);
  assert.equal(failed.endReason, "failed");
  assert.equal(failed.phase, "failed");
  assert.equal(failed.iteration, CONFIG.maxIterations);
  assert.equal(b.runners.calls.filter((c) => c.role === "engineer" && c.text.includes('task "First"')).length, CONFIG.maxIterations);
  assert.ok(readNotes(b.root).includes(`- Task "First" failed: QA failed after 3 attempts (task log, ${today})`), readNotes(b.root));
  assert.equal(b.events.find((e) => e.type === "task.failed")?.severity, "error");
  await untilEnded(b, second);
  assert.equal(task(b, second).endReason, "done");
});

await check("6. sONion asks a QUESTION → paused, answerTask → brief → continues", async () => {
  const b = fresh({ orchestrator: (c) => (c.n === 1 ? "Before I start:\nQUESTION:\nAll pages or only settings?" : c.text.includes("The task finished") ? "SUMMARY:\nDark settings page" : "BRIEF:\nDark settings page only.") });
  const id = submit(b);
  const paused = await untilPaused(b, id, PAUSE.question);
  assert.equal(paused.question, "All pages or only settings?");
  assert.equal(paused.status, "blocked");
  assert.throws(() => b.pipeline.resume(id), /question instead/);
  assert.ok(b.events.some((e) => e.type === "agent.waiting_user"));
  b.pipeline.answer(id, "Only the settings page");
  assert.equal(task(b, id).question, null);
  await untilEnded(b, id);
  const orchestratorCalls = b.runners.calls.filter((c) => c.role === "orchestrator");
  assert.ok(orchestratorCalls[1]?.text.includes("Answer to your question:\nOnly the settings page"));
  assert.equal(orchestratorCalls[1]?.sessionId, task(b, id).sessions.orchestrator);
  assert.ok(b.runners.calls.find((c) => c.role === "product_manager")?.text.includes("Dark settings page only."));
  assert.equal(task(b, id).endReason, "done");
  assert.throws(() => b.pipeline.answer(id, "again"), /already ended/);
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
  // The cancelled intake is gone; the next task's intake took its place; my chat keeps running.
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
});

await check("11. second task waits; a higher priority waiting task goes first", async () => {
  const b = fresh();
  const first = submit(b, "First", "low");
  const low = submit(b, "Low", "low");
  const critical = submit(b, "Critical", "critical");
  const high = submit(b, "High", "high");
  assert.deepEqual([low, critical, high].map((t) => task(b, t).phase), ["queued", "queued", "queued"]);
  for (const t of [first, critical, high, low]) await untilEnded(b, t);
  const started = (t: string) => task(b, t).history[0]?.at ?? 0;
  assert.ok(started(first) <= started(critical) && started(critical) <= started(high) && started(high) <= started(low));
  const order = b.events.filter((e) => e.type === "task.assigned" && e.agentId === undefined).map((e) => e.taskId);
  assert.deepEqual(order, [first, critical, high, low]);
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
  assert.equal(tasks.messages[0]?.author.kind, "handoff");
  const last = tasks.messages.at(-1);
  assert.ok(last !== undefined);
  const page = b.agents.getChatHistory(engineer, last.id, 1, "tasks");
  assert.deepEqual(page.messages.map((m) => m.id), [tasks.messages.at(-2)?.id]);
  assert.throws(() => b.agents.getChatHistory(engineer, last.id, 1, "chat"), /Unknown message/);
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
    orchestrator: (c) => (c.text.includes("The task finished") || c.text === reminderText("summary") ? "Thanks all!" : "BRIEF:\nx"),
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

await check("a step runs with its agent's model at step start; a change mid step affects the next step only", async () => {
  const b = fresh({ engineer: (call) => (call.n === 1 ? { hang: true } : DEFAULT_REPLIES.engineer(call)) });
  const engineer = agentOf(b, "engineer");
  b.agents.setAgentModel(agentOf(b, "product_manager"), "haiku", "low");
  const id = submit(b);
  await until(() => b.runners.isHanging(engineer), "engineer step running");
  assert.deepEqual(
    b.runners.calls.filter((c) => c.role === "product_manager").map((c) => [c.model, c.effort]),
    [["haiku", "low"]],
    "planning used the PM's setting",
  );
  const first = b.runners.calls.find((c) => c.role === "engineer");
  assert.deepEqual([first?.model, first?.effort], ["opus", "high"]);
  // Changed while the engineer works: QA and review must not be affected, only his next run.
  b.agents.setAgentModel(engineer, "sonnet", null);
  b.runners.script.qa = (call) => (call.n === 1 ? "broken\nVERDICT: FAIL" : "VERDICT: PASS");
  b.runners.release(engineer, DEFAULT_REPLIES.engineer(first as Call) as string);
  await untilEnded(b, id);
  const engineerRuns = b.runners.calls.filter((c) => c.role === "engineer").map((c) => [c.model, c.effort]);
  assert.deepEqual(engineerRuns, [["opus", "high"], ["sonnet", null]], "rework attempt uses the new setting");
  assert.ok(b.runners.calls.filter((c) => c.role === "qa").every((c) => c.model === "sonnet" && c.effort === "medium"));
});

await check("scripted runner: a full task runs to done with real cards, QA failing the first attempt", async () => {
  const timing = { thinkMs: 1, wordMs: 0, toolMs: 1 };
  const b = boot(join(tmpDir, `case-${++caseSeq}`, "data"), ["proj_a"], (agent, broker) => new ScriptedRunner({ agent, broker, timing }));
  const answered: string[] = [];
  // Answer every card like I would in the UI.
  const answer = setInterval(() => {
    for (const request of b.world.pendingPermissions) {
      answered.push(`${request.toolName}:${request.summary}`);
      b.broker.respond(request.id, "allow");
    }
  }, 2);
  try {
    const id = submit(b, "Add dark mode");
    const done = await untilEnded(b, id);
    assert.equal(done.endReason, "done", done.blockedReason ?? "");
    assert.equal(done.iteration, 2, "QA failed attempt 1, passed attempt 2");
    assert.deepEqual(done.subtasks.map((s) => s.title), ["Add src/add-dark-mode.ts", "Cover it with a test", "Mention it in the README"]);
    assert.equal(done.findings.length, 2);
    assert.equal(done.summary, "Add dark mode: added src/add-dark-mode.ts with a test (scripted run)");
    assert.deepEqual(answered, ["Write:Writing src/add-dark-mode.ts", "Write:Writing src/add-dark-mode.ts"], "one Write card per build step");
    assert.ok(!existsSync(join(b.root, "src", "add-dark-mode.ts")), "an allowed scripted Write writes nothing");
    assert.ok(readNotes(b.root).includes(`- Task "Add dark mode" done: Add dark mode: added src/add-dark-mode.ts`));
  } finally {
    clearInterval(answer);
  }
});

await check("submit refuses an empty or too long title", async () => {
  const b = fresh();
  assert.throws(() => submit(b, "   "), /1 to 200 characters/);
  assert.throws(() => submit(b, "x".repeat(CONFIG.maxTaskTitleChars + 1)), /characters/);
});

rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll pipeline checks passed." : `\n${failures} pipeline check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
