// Plain Node test script: `npm test`. Prints ✓/✗ per check, exits 1 on any failure.

import assert from "node:assert/strict";
import { CONFIG, type AppConfig } from "../src/shared/config.ts";
import { makeAgentId, newId, parseAgentId } from "../src/shared/ids.ts";
import {
  cancelQueued,
  EMPTY_QUEUE,
  enqueue,
  finishCurrent,
  isBusy,
  peek,
  startNext,
  type AgentInput,
  type MessageQueue,
} from "../src/shared/domain/messageQueue.ts";
import { evaluatePermission, type PermissionVerdict } from "../src/shared/domain/permissions.ts";
import { AGENT_ROLES, ROLE_DEFINITIONS, type AgentRole } from "../src/shared/domain/roles.ts";
import type { Task, WorkflowSignal } from "../src/shared/domain/taskTypes.ts";
import { applySignal, blockTask, canTransition, createTask, isTerminal, unblockTask } from "../src/shared/domain/workflow.ts";
import type { ClientCommand, ServerMessage, WorldSnapshot } from "../src/shared/protocol/protocol.ts";
import { parseClientMessage, parseCommandResult, parseServerMessage } from "../src/shared/protocol/schemas.ts";

let failures = 0;

function describe(name: string) {
  console.log(`\n${name}`);
}

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ ${name}\n      ${message.split("\n").join("\n      ")}`);
  }
}

// ── 1. Roles ────────────────────────────────────────────────────────────────
describe("1. Roles");

check("exactly 6 roles", () => {
  assert.equal(AGENT_ROLES.length, 6);
  assert.equal(Object.keys(ROLE_DEFINITIONS).length, 6);
});

check("names match the table exactly", () => {
  const expected: Record<AgentRole, string> = {
    orchestrator: "sONion Ring",
    researcher: "Drater",
    product_manager: "Pronelio Maximus",
    engineer: "STD Dren",
    qa: "Quantarino Archilles",
    reviewer: "Rabies",
  };
  for (const role of AGENT_ROLES) {
    assert.equal(ROLE_DEFINITIONS[role].name, expected[role], role);
    assert.equal(ROLE_DEFINITIONS[role].role, role);
  }
});

check("unique colours", () => {
  const colours = AGENT_ROLES.map((r) => ROLE_DEFINITIONS[r].color.toLowerCase());
  assert.equal(new Set(colours).size, 6);
});

check("only engineer has canEditCode and canCommit", () => {
  for (const role of AGENT_ROLES) {
    assert.equal(ROLE_DEFINITIONS[role].canEditCode, role === "engineer", `${role}.canEditCode`);
    assert.equal(ROLE_DEFINITIONS[role].canCommit, role === "engineer", `${role}.canCommit`);
  }
});

check("maxTurns 30 for engineer, 15 for the rest", () => {
  for (const role of AGENT_ROLES) {
    assert.equal(ROLE_DEFINITIONS[role].maxTurns, role === "engineer" ? 30 : 15, role);
  }
});

check("model defaults to config.defaultModel", () => {
  for (const role of AGENT_ROLES) assert.equal(ROLE_DEFINITIONS[role].model, CONFIG.defaultModel);
});

// ── 2. Ids ──────────────────────────────────────────────────────────────────
describe("2. Ids");

check("makeAgentId and parseAgentId round trip", () => {
  const projectId = newId("proj");
  for (const role of AGENT_ROLES) {
    const agentId = makeAgentId(projectId, role);
    assert.equal(agentId, `${projectId}:${role}`);
    assert.deepEqual(parseAgentId(agentId), { projectId, role });
  }
});

check("parseAgentId rejects malformed ids", () => {
  for (const bad of ["", "proj", ":engineer", "proj:janitor", "a:b:engineer"]) {
    assert.equal(parseAgentId(bad), null, bad);
  }
});

check("newId is prefixed and unique", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newId("task")));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^task_[0-9a-f]{16}$/);
});

// ── 3. Workflow ─────────────────────────────────────────────────────────────
describe("3. Workflow");

const wf = { maxIterations: CONFIG.maxIterations, phaseProgress: CONFIG.phaseProgress };
let clock = 1_700_000_000_000;

function newTask(): Task {
  return createTask("task_test", { projectId: "proj_test", title: "Add login" }, clock);
}

function signal(task: Task, s: WorkflowSignal): Task {
  const result = applySignal(task, s, ++clock, wf);
  if (!result.ok) throw new Error(result.error);
  return result.task;
}

function run(task: Task, signals: WorkflowSignal[]): Task {
  return signals.reduce(signal, task);
}

const TO_TESTING: WorkflowSignal[] = ["picked_up", "delegated", "plan_ready", "findings_published", "submitted"];

check("full happy path queued to done", () => {
  const task = run(newTask(), [...TO_TESTING, "tests_passed", "approved"]);
  assert.equal(task.phase, "done");
  assert.equal(task.status, "completed");
  assert.equal(task.progress, 1);
  assert.equal(task.iteration, 1);
  assert.equal(task.completedAt, clock);
  assert.deepEqual(
    task.history.map((h) => h.to),
    ["intake", "planning", "research", "implementation", "testing", "review", "done"],
  );
});

check("status is a projection of phase", () => {
  const statuses = [newTask(), ...TO_TESTING.map((_, i) => run(newTask(), TO_TESTING.slice(0, i + 1)))].map(
    (t) => t.status,
  );
  assert.deepEqual(statuses, ["queued", "assigned", "in_progress", "in_progress", "in_progress", "testing"]);
});

check("testing + tests_failed goes to implementation and bumps iteration", () => {
  const testing = run(newTask(), TO_TESTING);
  const reworked = signal(testing, "tests_failed");
  assert.equal(reworked.phase, "implementation");
  assert.equal(reworked.iteration, testing.iteration + 1);
  assert.equal(reworked.progress, CONFIG.phaseProgress.implementation[0]);
});

check("queued + approved is rejected", () => {
  const task = newTask();
  assert.equal(canTransition("queued", "approved"), false);
  const result = applySignal(task, "approved", clock, wf);
  assert.equal(result.ok, false);
  assert.equal(task.phase, "queued", "input must not be mutated");
});

check("done is terminal", () => {
  const done = run(newTask(), [...TO_TESTING, "tests_passed", "approved"]);
  assert.equal(isTerminal("done"), true);
  assert.equal(isTerminal("failed"), true);
  assert.equal(applySignal(done, "abort", clock, wf).ok, false);
});

check("rework beyond maxIterations ends in failed", () => {
  let task = run(newTask(), TO_TESTING);
  for (let i = 1; i < CONFIG.maxIterations; i++) task = run(task, ["tests_failed", "submitted"]);
  assert.equal(task.iteration, CONFIG.maxIterations);
  const result = applySignal(task, "tests_failed", ++clock, wf);
  assert.ok(result.ok);
  assert.equal(result.applied, "abort");
  assert.equal(result.task.phase, "failed");
  assert.equal(result.task.status, "failed");
  assert.equal(result.task.iteration, CONFIG.maxIterations);
});

check("review changes_requested also reworks", () => {
  const review = run(newTask(), [...TO_TESTING, "tests_passed"]);
  const reworked = signal(review, "changes_requested");
  assert.equal(reworked.phase, "implementation");
  assert.equal(reworked.iteration, 2);
});

check("blocked overrides status and clears on unblock or terminal", () => {
  const planning = run(newTask(), ["picked_up", "delegated"]);
  const blocked = blockTask(planning, "Usage limit reached", ++clock);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReason, "Usage limit reached");
  assert.equal(signal(blocked, "plan_ready").status, "blocked");
  assert.equal(unblockTask(blocked, ++clock).status, "in_progress");
  const aborted = signal(blocked, "abort");
  assert.equal(aborted.status, "failed");
  assert.equal(aborted.blockedReason, null);
});

// ── 4. Queue ────────────────────────────────────────────────────────────────
describe("4. Message queue");

function input(id: string): AgentInput {
  return { id, source: "user", text: id, taskId: null, fromAgentId: null, enqueuedAt: ++clock };
}

const busyQueue: MessageQueue = startNext(enqueue(EMPTY_QUEUE, input("m1")));

check("enqueue while busy queues", () => {
  assert.equal(isBusy(busyQueue), true);
  const q = enqueue(busyQueue, input("m2"));
  assert.equal(q.current?.id, "m1");
  assert.deepEqual(
    q.queued.map((i) => i.id),
    ["m2"],
  );
});

check("startNext does nothing while busy", () => {
  const q = enqueue(busyQueue, input("m2"));
  assert.equal(startNext(q), q);
});

check("FIFO order", () => {
  let q = ["m2", "m3", "m4"].reduce((acc, id) => enqueue(acc, input(id)), busyQueue);
  const order: string[] = [];
  while (isBusy(q)) {
    order.push(q.current?.id ?? "");
    q = startNext(finishCurrent(q));
  }
  assert.deepEqual(order, ["m1", "m2", "m3", "m4"]);
});

check("finishCurrent then startNext picks the next item", () => {
  const q = enqueue(enqueue(busyQueue, input("m2")), input("m3"));
  assert.equal(peek(q)?.id, "m2");
  const finished = finishCurrent(q);
  assert.equal(finished.current, null);
  const next = startNext(finished);
  assert.equal(next.current?.id, "m2");
  assert.deepEqual(
    next.queued.map((i) => i.id),
    ["m3"],
  );
});

check("cancelQueued removes only that item", () => {
  const q = ["m2", "m3", "m4"].reduce((acc, id) => enqueue(acc, input(id)), busyQueue);
  const cancelled = cancelQueued(q, "m3");
  assert.equal(cancelled.current?.id, "m1");
  assert.deepEqual(
    cancelled.queued.map((i) => i.id),
    ["m2", "m4"],
  );
  assert.equal(cancelQueued(q, "m1"), q, "current input is not cancellable");
  assert.equal(q.queued.length, 3, "input must not be mutated");
});

// ── 5. Permissions ──────────────────────────────────────────────────────────
describe("5. Permissions");

function bash(role: AgentRole, command: string, config: Pick<AppConfig, "git"> = CONFIG): PermissionVerdict {
  return evaluatePermission(role, "Bash", { command }, config);
}

function expectBash(role: AgentRole, command: string, expected: PermissionVerdict, config?: Pick<AppConfig, "git">) {
  check(`${role}: \`${command}\` → ${expected}`, () => assert.equal(bash(role, command, config), expected));
}

check("Read allow for all", () => {
  for (const role of AGENT_ROLES) assert.equal(evaluatePermission(role, "Read", { file_path: "a" }, CONFIG), "allow", role);
});
check("Edit ask for engineer, deny for reviewer", () => {
  assert.equal(evaluatePermission("engineer", "Edit", {}, CONFIG), "ask");
  assert.equal(evaluatePermission("reviewer", "Edit", {}, CONFIG), "deny");
});
check("WebSearch allow for researcher, deny for engineer", () => {
  assert.equal(evaluatePermission("researcher", "WebSearch", { query: "x" }, CONFIG), "allow");
  assert.equal(evaluatePermission("engineer", "WebSearch", { query: "x" }, CONFIG), "deny");
});
check("unknown tool and Bash for a role without it are denied", () => {
  assert.equal(evaluatePermission("engineer", "NotebookEdit", {}, CONFIG), "deny");
  assert.equal(evaluatePermission("orchestrator", "Bash", { command: "ls" }, CONFIG), "deny");
});
check("Bash without a string command is denied", () => {
  assert.equal(evaluatePermission("engineer", "Bash", { cmd: "ls" }, CONFIG), "deny");
  assert.equal(evaluatePermission("engineer", "Bash", null, CONFIG), "deny");
});

expectBash("engineer", 'git commit -m "x"', "allow");
expectBash("engineer", "git push", "ask");
expectBash("reviewer", "git push", "deny");
expectBash("reviewer", 'git commit -m "x"', "deny");
expectBash("engineer", "git push --force", "deny");
expectBash("engineer", "git reset --hard", "deny");
expectBash("engineer", "git push origin --delete main", "deny");
expectBash("engineer", "git status && git push -f", "deny");
expectBash("engineer", "git diff", "ask");
expectBash("engineer", "npm test", "ask");

// Robustness: spacing, global options, chains, and spellings of the same command.
expectBash("engineer", "  git   -C  /tmp/repo   commit   -m 'x'  ", "allow");
expectBash("engineer", "git -C ../other push origin main -f", "deny");
expectBash("engineer", "git push origin +main", "deny");
expectBash("engineer", "git push origin :feature", "deny");
expectBash("engineer", "git push upstream :feature", "deny");
expectBash("engineer", "git push --force-with-lease=main origin", "deny");
expectBash("engineer", "git push --forc", "deny");
expectBash("engineer", "git clean -fdx", "deny");
expectBash("engineer", "git branch -d --force old", "deny");
expectBash("engineer", "git commit -m x; git reset --hard HEAD~1", "deny");
expectBash("engineer", 'git commit -m "$(git push -f)"', "deny");
expectBash("engineer", "git commit -m x `git push -f`", "deny");
expectBash("engineer", 'bash -c "git push --force"', "deny");
expectBash("engineer", "sudo git push -f", "deny");
expectBash("engineer", "git commit -m x && rm -rf build", "ask");
expectBash("engineer", 'git commit -m "say; git push -f"', "allow");
expectBash("engineer", "git -c core.hooksPath=/tmp commit -m x", "ask");
expectBash("engineer", "git status > out.txt", "ask");
expectBash("engineer", "git log | head", "ask");
expectBash("qa", "git commit -m x", "deny");
expectBash("qa", "git checkout -b fix", "ask");

const relaxed: Pick<AppConfig, "git"> = {
  git: { ...CONFIG.git, readOnlyRequiresApproval: false, commitRequiresApproval: true },
};
expectBash("reviewer", "git diff HEAD~1", "allow", relaxed);
expectBash("reviewer", "git log --oneline -n 5", "allow", relaxed);
expectBash("reviewer", "git diff --output=/tmp/x", "ask", relaxed);
expectBash("engineer", "git commit -m x", "ask", relaxed);

// ── 6. Protocol ─────────────────────────────────────────────────────────────
describe("6. Protocol");

const EXAMPLE_COMMANDS: ClientCommand[] = [
  { name: "listFolders", args: {} },
  { name: "listFolders", args: { path: "/home/me/code" } },
  { name: "createProject", args: { name: "Shop", rootPath: "/home/me/code/shop", initGit: true } },
  { name: "archiveProject", args: { projectId: "proj_1" } },
  { name: "sendMessage", args: { agentId: "proj_1:engineer", text: "Fix the build" } },
  { name: "cancelQueued", args: { agentId: "proj_1:engineer", messageId: "msg_1" } },
  { name: "stopAgent", args: { agentId: "proj_1:engineer" } },
  { name: "resetAgentSession", args: { agentId: "proj_1:qa" } },
  { name: "submitTask", args: { projectId: "proj_1", title: "Add dark mode", description: "All pages", priority: "high" } },
  { name: "cancelTask", args: { taskId: "task_1" } },
  { name: "resumeTask", args: { taskId: "task_1" } },
  { name: "respondPermission", args: { requestId: "perm_1", decision: "allow" } },
  { name: "pinToNotes", args: { messageId: "msg_1" } },
  { name: "getChatHistory", args: { agentId: "proj_1:qa", before: "msg_9", limit: 50 } },
  { name: "getSnapshot", args: {} },
];

check("every command name has an example", () => {
  const names = new Set(EXAMPLE_COMMANDS.map((c) => c.name));
  assert.equal(names.size, 14);
});

for (const command of EXAMPLE_COMMANDS) {
  check(`command ${command.name} ${JSON.stringify(command.args)} parses`, () => {
    const result = parseClientMessage(JSON.stringify({ type: "command", id: "c1", command }));
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.deepEqual(result.value, { type: "command", id: "c1", command });
  });
}

check("hello parses", () => {
  const result = parseClientMessage(JSON.stringify({ type: "hello", token: "secret" }));
  assert.ok(result.ok);
  assert.deepEqual(result.value, { type: "hello", token: "secret" });
});

function expectRejected(label: string, raw: string) {
  check(`${label} → ok: false without throwing`, () => {
    const result = parseClientMessage(raw);
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.error.length > 0);
  });
}

expectRejected("malformed JSON", "{ not json");
expectRejected("empty string", "");
expectRejected("JSON null", "null");
expectRejected("unknown command name", JSON.stringify({ type: "command", id: "c1", command: { name: "rmRf", args: {} } }));
expectRejected(
  "missing required field",
  JSON.stringify({ type: "command", id: "c1", command: { name: "sendMessage", args: { agentId: "a" } } }),
);
expectRejected("hello without token", JSON.stringify({ type: "hello" }));
expectRejected(
  "unknown extra field",
  JSON.stringify({ type: "command", id: "c1", command: { name: "stopAgent", args: { agentId: "a", force: true } } }),
);
expectRejected(
  "invalid enum value",
  JSON.stringify({ type: "command", id: "c1", command: { name: "respondPermission", args: { requestId: "p", decision: "maybe" } } }),
);
expectRejected(
  "message over maxMessageChars",
  JSON.stringify({
    type: "command",
    id: "c1",
    command: { name: "sendMessage", args: { agentId: "a", text: "x".repeat(CONFIG.maxMessageChars + 1) } },
  }),
);

const now = 1_700_000_000_000;
const projectId = "proj_1";
const engineerId = makeAgentId(projectId, "engineer");
const snapshot: WorldSnapshot = {
  serverTime: now,
  projects: [{ id: projectId, name: "Shop", rootPath: "/home/me/shop", isGitRepo: true, archived: false, createdAt: now }],
  agents: AGENT_ROLES.map((role) => ({
    id: makeAgentId(projectId, role),
    projectId,
    role,
    name: ROLE_DEFINITIONS[role].name,
    status: "idle",
    activity: "",
    location: ROLE_DEFINITIONS[role].homeStation,
    currentTaskId: null,
    claudeSessionId: null,
    busy: false,
    queuedCount: 0,
    lastError: null,
    updatedAt: now,
  })),
  tasks: [run(createTask("task_1", { projectId, title: "Add dark mode" }, now), ["picked_up"])],
  links: [{ id: "link_1", from: makeAgentId(projectId, "orchestrator"), to: engineerId, kind: "assign", startedAt: now, endsAt: now + 2400 }],
  pendingPermissions: [
    { id: "perm_1", projectId, agentId: engineerId, toolName: "Bash", summary: "git push", input: { command: "git push" }, createdAt: now },
  ],
  usage: { limited: false, resetsAt: null },
  auth: { source: "none" },
  runner: "claude",
};

const EXAMPLE_SERVER_MESSAGES: ServerMessage[] = [
  { type: "snapshot", snapshot },
  {
    type: "event",
    event: {
      id: "evt_1",
      type: "task.assigned",
      timestamp: now,
      projectId,
      agentId: makeAgentId(projectId, "orchestrator"),
      targetAgentId: makeAgentId(projectId, "product_manager"),
      taskId: "task_1",
      message: "Delegated to Pronelio Maximus",
      severity: "info",
      feed: true,
    },
  },
  {
    type: "event",
    event: { id: "evt_2", type: "chat.message_delta", timestamp: now, message: "", severity: "info", feed: false, metadata: { messageId: "msg_1", delta: "Hel" } },
  },
  { type: "ack", id: "c1", ok: true },
  { type: "ack", id: "c2", ok: true, result: { anything: 1 } },
  { type: "ack", id: "c3", ok: false, error: "Unknown agent" },
];

for (const message of EXAMPLE_SERVER_MESSAGES) {
  const label = message.type === "event" ? `event ${message.event.type}` : message.type === "ack" ? `ack ok=${message.ok}` : message.type;
  check(`server ${label} parses`, () => {
    const result = parseServerMessage(JSON.stringify(message));
    assert.ok(result.ok, result.ok ? "" : result.error);
    assert.deepEqual(result.value, message);
  });
}

check("invalid server messages return ok: false", () => {
  assert.equal(parseServerMessage("nope").ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ type: "event", event: { id: "e", type: "agent.walking" } })).ok, false);
  assert.equal(parseServerMessage(JSON.stringify({ type: "ack", id: "c", ok: false })).ok, false);
});

check("command results validate", () => {
  assert.ok(parseCommandResult("getSnapshot", snapshot).ok);
  assert.ok(parseCommandResult("stopAgent", undefined).ok);
  assert.equal(parseCommandResult("submitTask", { id: "x" }).ok, false);
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
