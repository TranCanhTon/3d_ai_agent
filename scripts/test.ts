// Plain Node test script: `npm test`. Prints ✓/✗ per check, exits 1 on any failure.

import assert from "node:assert/strict";
import { CONFIG } from "../src/shared/config.ts";
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
import { evaluatePermission, explainPermission, type PermissionConfig, type PermissionVerdict } from "../src/shared/domain/permissions.ts";
import { ADD_NOTE_SDK_NAME, AGENT_ROLES, builtInToolsFor, canonicalToolName, ROLE_DEFINITIONS, type AgentRole } from "../src/shared/domain/roles.ts";
import type { Task, WorkflowSignal } from "../src/shared/domain/taskTypes.ts";
import { applySignal, blockTask, canTransition, createTask, isTerminal, unblockTask } from "../src/shared/domain/workflow.ts";
import {
  bulletItems,
  continueText,
  implementationHandoff,
  intakeHandoff,
  isNone,
  parseReply,
  planningHandoff,
  planSteps,
  readStepResult,
  reminderText,
  researchHandoff,
  reviewHandoff,
  reworkHandoff,
  summaryHandoff,
  testingHandoff,
  type TeamNames,
} from "../src/shared/domain/handoff.ts";
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

check("role model defaults: opus for engineer and reviewer, sonnet for the rest, all offered", () => {
  assert.deepEqual(CONFIG.roleModelDefaults, {
    orchestrator: { model: "sonnet", effort: "low" },
    product_manager: { model: "sonnet", effort: "medium" },
    researcher: { model: "sonnet", effort: "medium" },
    engineer: { model: "opus", effort: "high" },
    qa: { model: "sonnet", effort: "medium" },
    reviewer: { model: "opus", effort: "medium" },
  });
  assert.deepEqual(CONFIG.models.map((m) => m.id), ["opus", "sonnet", "haiku"]);
  assert.deepEqual([...CONFIG.effortLevels], ["low", "medium", "high", "xhigh", "max"]);
  for (const role of AGENT_ROLES) {
    const { model, effort } = CONFIG.roleModelDefaults[role];
    assert.ok(CONFIG.models.some((m) => m.id === model), model);
    assert.ok(effort === null || CONFIG.effortLevels.includes(effort), String(effort));
  }
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

check("planning + research_skipped goes straight to implementation (attempt 1)", () => {
  const planning = run(newTask(), ["picked_up", "delegated"]);
  const skipped = signal(planning, "research_skipped");
  assert.equal(skipped.phase, "implementation");
  assert.equal(skipped.iteration, 1);
  assert.equal(canTransition("research", "research_skipped"), false);
  assert.deepEqual(run(skipped, ["submitted", "tests_passed", "approved"]).phase, "done");
});

check("a new task has no sessions, outputs, question, end reason or summary", () => {
  const task = newTask();
  assert.deepEqual([task.sessions, task.outputs, task.question, task.endReason, task.summary], [{}, {}, null, null, null]);
});

// ── 3b. Handoff markers ─────────────────────────────────────────────────────
describe("3b. Handoff markers and texts");

check("markdown bold, headings and trailing spaces around markers", () => {
  const parsed = parseReply("Looks good.\n\n**VERDICT: PASS**   \n");
  assert.equal(parsed.values.VERDICT, "PASS");
  assert.equal(parseReply("VERDICT: APPROVED.").values.VERDICT, "APPROVED");
  const plan = parseReply("## PLAN:\n1. **Add** the toggle\n2. Save it  \n\n### RESEARCH QUESTIONS:\n- none\n");
  assert.equal(plan.sections.PLAN, "1. **Add** the toggle\n2. Save it");
  assert.equal(plan.sections["RESEARCH QUESTIONS"], "- none");
  assert.equal(parseReply("> `BRIEF:` Make it dark").sections.BRIEF, "Make it dark");
  assert.equal(parseReply("__SUMMARY:__ Added dark mode").sections.SUMMARY, "Added dark mode");
});

check("a marker word inside a sentence is not a marker; marker words are case sensitive", () => {
  const parsed = parseReply("I will write the PLAN: below.\nverdict: pass\n");
  assert.equal(parsed.sections.PLAN, undefined);
  assert.equal(parsed.values.VERDICT, undefined);
  assert.equal(readStepResult("testing", "All tests ran.\nverdict: PASS").kind, "missing");
});

check("sections run to the next marker; the last occurrence wins", () => {
  const reply = "CHANGES:\n- a.ts: old\nHOW TO TEST:\n- run it\n\nSorry, again:\nCHANGES:\n- b.ts: new\nHOW TO TEST:\n- npm test";
  const result = readStepResult("implementation", reply);
  assert.deepEqual(result, { kind: "changes", changes: "- b.ts: new", howToTest: "- npm test" });
});

check("two VERDICT lines: the last one wins; only the role's values count", () => {
  assert.deepEqual(readStepResult("testing", "VERDICT: FAIL\nRe-ran it, now fine.\nVERDICT: PASS"), { kind: "qa", verdict: "PASS" });
  assert.deepEqual(readStepResult("review", "VERDICT: CHANGES\n- a.ts: rename\n**VERDICT: APPROVED**"), { kind: "review", verdict: "APPROVED" });
  assert.deepEqual(readStepResult("testing", "VERDICT: APPROVED"), { kind: "missing", marker: "VERDICT:" });
  assert.deepEqual(readStepResult("review", "VERDICT: PASS"), { kind: "missing", marker: "VERDICT:" });
  assert.deepEqual(readStepResult("testing", "VERDICT: PASS, mostly"), { kind: "missing", marker: "VERDICT:" });
});

check("research questions none / None. / - none / empty skip research; real questions do not", () => {
  for (const none of ["none", "None.", "- none", "(none)", "", "  - **None**  "]) {
    assert.equal(isNone(none), true, JSON.stringify(none));
    const result = readStepResult("planning", `PLAN:\n1. Do it\nRESEARCH QUESTIONS:\n${none}`);
    assert.ok(result.kind === "plan" && result.skipResearch, JSON.stringify(none));
  }
  const asks = readStepResult("planning", "PLAN:\n1. Do it\nRESEARCH QUESTIONS:\n- Which icon set?\n- none of the above?");
  assert.ok(asks.kind === "plan" && !asks.skipResearch);
  assert.equal(isNone("No questions"), false);
});

check("plan steps become subtasks; findings bullets become findings", () => {
  const result = readStepResult("planning", "PLAN:\n1. Add the **toggle** in `Header.tsx`\n2) Save the choice\n   - detail line\n3. Test\nRESEARCH QUESTIONS:\nnone");
  assert.ok(result.kind === "plan");
  assert.deepEqual(result.subtasks, ["Add the toggle in Header.tsx", "Save the choice", "Test"]);
  assert.deepEqual(planSteps("no steps here"), []);
  const findings = readStepResult("research", "Checked the docs.\nFINDINGS:\n- Use `prefers-color-scheme`\n* Tailwind has a dark: variant\nPlain text line");
  assert.ok(findings.kind === "findings");
  assert.deepEqual(findings.items, ["Use prefers-color-scheme", "Tailwind has a dark: variant"]);
  assert.deepEqual(bulletItems(""), []);
});

check("missing markers name what is missing", () => {
  assert.deepEqual(readStepResult("intake", "Sure, I can help."), { kind: "missing", marker: "BRIEF:" });
  assert.deepEqual(readStepResult("planning", "PLAN:\n1. x"), { kind: "missing", marker: "RESEARCH QUESTIONS:" });
  assert.deepEqual(readStepResult("planning", "RESEARCH QUESTIONS:\nnone"), { kind: "missing", marker: "PLAN:" });
  assert.deepEqual(readStepResult("research", "FINDINGS:\n"), { kind: "missing", marker: "FINDINGS:" });
  assert.deepEqual(readStepResult("implementation", "CHANGES:\n- a.ts: x"), { kind: "missing", marker: "HOW TO TEST:" });
  assert.deepEqual(readStepResult("summary", "All done!"), { kind: "missing", marker: "SUMMARY:" });
});

check("intake: QUESTION or BRIEF, whichever comes last; no second question after my answer", () => {
  assert.deepEqual(readStepResult("intake", "QUESTION:\nWhich pages?"), { kind: "question", question: "Which pages?" });
  assert.deepEqual(readStepResult("intake", "BRIEF:\nDark mode everywhere"), { kind: "brief", brief: "Dark mode everywhere" });
  assert.equal(readStepResult("intake", "BRIEF:\nx\nQUESTION:\nWhich pages?").kind, "question");
  assert.equal(readStepResult("intake", "QUESTION:\nWhich pages?", false).kind, "missing");
  assert.deepEqual(readStepResult("summary", "Done.\nSUMMARY:\n- Added dark mode to all pages\n"), { kind: "summary", summary: "Added dark mode to all pages" });
});

const team: TeamNames = {
  orchestrator: "sONion Ring",
  product_manager: "Pronelio Maximus",
  researcher: "Drater",
  engineer: "STD Dren",
  qa: "Quantarino Archilles",
  reviewer: "Rabies",
};
const darkMode = { title: "Add dark mode", description: "All pages", priority: "high" as const };

check("every handoff starts with who it is from and the task", () => {
  const firstLines = [
    intakeHandoff(darkMode),
    planningHandoff(team, darkMode, "brief"),
    researchHandoff(team, darkMode, "brief", "plan", "- which?"),
    implementationHandoff(team, darkMode, "brief", "plan", null),
    implementationHandoff(team, darkMode, "brief", "plan", "- use X"),
    reworkHandoff(team, darkMode, 2, "qa", "VERDICT: FAIL"),
    reworkHandoff(team, darkMode, 3, "review", "VERDICT: CHANGES"),
    testingHandoff(team, darkMode, 2, "plan", "changes", "steps"),
    reviewHandoff(team, darkMode, 1, "brief", "plan", "changes"),
    summaryHandoff(team, darkMode, 1, "changes", "PASS", "APPROVED"),
  ].map((text) => text.split("\n")[0]);
  assert.deepEqual(firstLines, [
    'From you, task "Add dark mode":',
    'From sONion Ring, task "Add dark mode":',
    'From Pronelio Maximus, task "Add dark mode":',
    'From Pronelio Maximus, task "Add dark mode" (attempt 1):',
    'From Drater, task "Add dark mode" (attempt 1):',
    'From Quantarino Archilles, task "Add dark mode" (attempt 2):',
    'From Rabies, task "Add dark mode" (attempt 3):',
    'From STD Dren, task "Add dark mode" (attempt 2):',
    'From Quantarino Archilles, task "Add dark mode" (attempt 1):',
    'From Rabies, task "Add dark mode":',
  ]);
});

check("handoffs carry what the next agent needs and the required ending", () => {
  const intake = intakeHandoff(darkMode);
  assert.ok(intake.includes("Priority: high") && intake.includes("Description:\nAll pages") && intake.includes("QUESTION:"));
  assert.ok(planningHandoff(team, darkMode, "Make it dark").includes("BRIEF:\nMake it dark"));
  const research = researchHandoff(team, darkMode, "b", "1. x", "- Which icon set?");
  assert.ok(research.includes("PLAN:\n1. x") && research.includes("RESEARCH QUESTIONS:\n- Which icon set?") && research.endsWith("End with FINDINGS:."));
  assert.ok(implementationHandoff(team, darkMode, "b", "p", null).includes("FINDINGS:\nnone (no research needed)"));
  const rework = reworkHandoff(team, darkMode, 2, "qa", "npm test failed\nVERDICT: FAIL");
  assert.ok(rework.includes("QA failed. Report:\nnpm test failed") && rework.includes("Do not commit or push"));
  assert.ok(testingHandoff(team, darkMode, 2, "p", "- a.ts", "- run").includes("HOW TO TEST:\n- run"));
  assert.ok(reviewHandoff(team, darkMode, 1, "b", "p", "- a.ts").includes("QA passed."));
  assert.ok(summaryHandoff(team, darkMode, 2, "- a.ts", "PASS", "APPROVED").includes("after 2 attempts. QA: PASS. Review: APPROVED."));
  assert.equal(continueText("testing"), "Continue where you left off. Finish with the required ending: VERDICT: PASS or VERDICT: FAIL.");
  assert.ok(reminderText("planning").endsWith("PLAN: and RESEARCH QUESTIONS:"));
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

function bash(role: AgentRole, command: string, config: PermissionConfig = CONFIG): PermissionVerdict {
  return evaluatePermission(role, "Bash", { command }, config);
}

function expectBash(role: AgentRole, command: string, expected: PermissionVerdict, config?: PermissionConfig) {
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
expectBash("engineer", "git diff", "allow");
expectBash("reviewer", "git status", "allow");
expectBash("qa", "git log --oneline -n 5", "allow");
expectBash("engineer", "npm test", "allow");

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
expectBash("engineer", "git commit -m x && rm -rf build", "deny");
expectBash("engineer", 'git commit -m "say; git push -f"', "allow");
expectBash("engineer", "git -c core.hooksPath=/tmp commit -m x", "ask");
expectBash("engineer", "git status > out.txt", "ask");
expectBash("engineer", "git log | head", "allow");
expectBash("qa", "git commit -m x", "deny");
expectBash("qa", "git checkout -b fix", "ask");

check("read-only git runs without a card by default (config)", () => assert.equal(CONFIG.git.readOnlyRequiresApproval, false));
const strict: PermissionConfig = { ...CONFIG, git: { ...CONFIG.git, readOnlyRequiresApproval: true } };
expectBash("qa", "git status", "ask", strict);
expectBash("reviewer", "git status", "deny", strict);

const relaxed: PermissionConfig = {
  ...CONFIG,
  git: { ...CONFIG.git, readOnlyRequiresApproval: false, commitRequiresApproval: true },
};
expectBash("reviewer", "git diff HEAD~1", "allow", relaxed);
expectBash("reviewer", "git log --oneline -n 5", "allow", relaxed);
expectBash("qa", "git diff --output=/tmp/x", "ask", relaxed);
expectBash("engineer", "git commit -m x", "ask", relaxed);

check("add_note: Claude's prefixed name maps to add_note and is allowed for every role that lists it", () => {
  assert.equal(canonicalToolName(ADD_NOTE_SDK_NAME), "add_note");
  assert.equal(ADD_NOTE_SDK_NAME, "mcp__agentworld__add_note");
  for (const role of AGENT_ROLES) {
    assert.ok(ROLE_DEFINITIONS[role].allowedTools.includes("add_note"), role);
    assert.equal(evaluatePermission(role, ADD_NOTE_SDK_NAME, { text: "x" }, CONFIG), "allow", role);
  }
});
check("add_note: denied when the run's tool list does not have it; other MCP tools always denied", () => {
  assert.equal(evaluatePermission("engineer", ADD_NOTE_SDK_NAME, { text: "x" }, CONFIG, ["Read", "Bash"]), "deny");
  assert.equal(evaluatePermission("engineer", "mcp__agentworld__other", {}, CONFIG), "deny");
  assert.equal(evaluatePermission("engineer", "mcp__gmail__send", {}, CONFIG), "deny");
});
check("chat only: every tool is denied and no built-in tools are given", () => {
  for (const tool of ["Read", "Bash", "Edit", ADD_NOTE_SDK_NAME]) {
    const result = explainPermission("engineer", tool, { command: "ls", file_path: "a" }, CONFIG, []);
    assert.equal(result.verdict, "deny", tool);
    assert.match(result.reason, /chat only/);
  }
  assert.deepEqual(builtInToolsFor("engineer", true), []);
  assert.deepEqual(builtInToolsFor("engineer", false), ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
});

// Shell command rules: one row per rule, plus the tricky spellings.
const SHELL_TABLE: [AgentRole, string, PermissionVerdict][] = [
  // Allow: look around, search, versions
  ["qa", "ls -la src", "allow"],
  ["engineer", "dir", "allow"],
  ["qa", "pwd", "allow"],
  ["engineer", "cat package.json", "allow"],
  ["engineer", "type package.json", "allow"],
  ["qa", "head -n 20 src/app.ts", "allow"],
  ["qa", "tail -n 20 log.txt", "allow"],
  ["qa", "wc -l src/app.ts", "allow"],
  ["engineer", "tree src", "allow"],
  ["engineer", "which node", "allow"],
  ["engineer", "where node", "allow"],
  ["engineer", "echo hello", "allow"],
  ["qa", 'grep -rn "TODO" src', "allow"],
  ["qa", "rg useState src", "allow"],
  ["qa", 'find . -name "*.ts"', "allow"],
  ["qa", "find . -exec rm {} ;", "ask"],
  ["qa", 'find . -name "*.ts" -delete', "ask"],
  ["qa", "find . -fprint out.txt", "ask"],
  ["engineer", "node -v", "allow"],
  ["engineer", "node --version", "allow"],
  ["engineer", "npm -v", "allow"],
  ["engineer", "npm --version", "allow"],
  ["engineer", "git --version", "allow"],
  ["engineer", "python --version", "allow"],
  ["engineer", "python3 --version", "allow"],
  ["engineer", "node -v x", "ask"],
  // Allow: git read
  ["qa", "git status", "allow"],
  ["qa", "git diff HEAD~1", "allow"],
  ["qa", "git log --oneline", "allow"],
  ["qa", "git show HEAD", "allow"],
  ["engineer", "git blame src/a.ts", "allow"],
  ["engineer", "git branch", "allow"],
  ["engineer", "git branch -a", "allow"],
  ["engineer", "git branch -vv --all", "allow"],
  ["engineer", "git branch --show-current", "allow"],
  ["engineer", "git branch feature", "ask"],
  ["engineer", "git show --output=x HEAD", "ask"],
  ["engineer", "git -c core.pager=evil log", "ask"],
  // Allow: project checks
  ["qa", "npm test", "allow"],
  ["qa", "npm run test", "allow"],
  ["qa", "npm run typecheck", "allow"],
  ["qa", "npm run lint -- --fix", "allow"],
  ["qa", "npm run build", "allow"],
  ["qa", "tsc --noEmit", "allow"],
  ["qa", "npx tsc --noEmit -p .", "allow"],
  ["qa", "npm test > out.txt", "ask"],
  // Duplicating or closing a descriptor writes no file: not a redirect.
  ["qa", "npm test 2>&1", "allow"],
  ["engineer", "npm test 2>&1 | tail -15; git status --short", "allow"],
  ["qa", "npm run lint 2>&1 | head -30", "allow"],
  ["engineer", "echo oops >&2", "allow"],
  ["engineer", "npm test 1>&2", "allow"],
  ["engineer", "git status 2>&-", "allow"],
  ["reviewer", "git diff 2>&1 | head", "allow"],
  ["qa", "npm test 2>&1 > out.txt", "ask"],
  ["qa", "npm test 2> err.txt", "ask"],
  ["qa", "npm test 1>out.txt", "ask"],
  ["qa", "npm test >&out.txt", "ask"],
  ["qa", "npm test &>out.txt", "ask"],
  ["qa", "npm test 2>&1x", "ask"],
  ["qa", "cat < input.txt", "ask"],
  ["engineer", "rm -rf dist 2>&1", "deny"],
  ["engineer", "npm install 2>&1", "ask"],
  ["qa", 'echo "2>&1"', "allow"],
  ["qa", "npm run buildx", "ask"],
  // Ask
  ["engineer", "npm install", "ask"],
  ["engineer", "npm i lodash", "ask"],
  ["engineer", "npm ci", "ask"],
  ["engineer", "npm uninstall lodash", "ask"],
  ["engineer", "npm update", "ask"],
  ["engineer", "pip install requests", "ask"],
  ["engineer", "pip uninstall requests", "ask"],
  ["engineer", "npm run dev", "ask"],
  ["engineer", "npx prettier --write .", "ask"],
  ["engineer", "node script.js", "ask"],
  ["engineer", "python script.py", "ask"],
  ["engineer", "mkdir x", "ask"],
  ["engineer", "cp a b", "ask"],
  ["engineer", "mv a b", "ask"],
  ["engineer", "touch a", "ask"],
  ["qa", "rm notes.txt", "ask"],
  ["engineer", "rm -f notes.txt", "ask"],
  ["engineer", "git add .", "ask"],
  ["engineer", "git checkout main", "ask"],
  ["engineer", "git switch -c x", "ask"],
  ["engineer", "git stash", "ask"],
  ["engineer", "git merge x", "ask"],
  ["engineer", "git rebase main", "ask"],
  ["engineer", "git restore a.ts", "ask"],
  ["engineer", "git cherry-pick abc", "ask"],
  ["engineer", "git tag v1", "ask"],
  ["engineer", "git fetch", "ask"],
  ["engineer", "git push", "ask"],
  ["qa", "git push", "deny"],
  ["engineer", "make", "ask"],
  ["engineer", "cat $(echo x)", "ask"],
  ["engineer", "xargs cat", "ask"],
  // Deny: blocked git, recursive deletes, system commands, download into a shell
  ["engineer", "git push --force", "deny"],
  ["engineer", "git clean -fd", "deny"],
  ["engineer", "rm -r dist", "deny"],
  ["engineer", "rm -R dist", "deny"],
  ["engineer", "rm --recursive dist", "deny"],
  ["engineer", "rm -rf dist", "deny"],
  ["engineer", "rm -fr dist", "deny"],
  ["engineer", "rm -Rf dist", "deny"],
  ["engineer", "ls && rm -rf src", "deny"],
  ["engineer", "rmdir /s /q dist", "deny"],
  ["engineer", "rd /S dist", "deny"],
  ["engineer", "del /s *.tmp", "deny"],
  ["engineer", "erase /s/q *.tmp", "deny"],
  ["engineer", "Remove-Item -Recurse dist", "deny"],
  ["engineer", "remove-item dist -rec", "deny"],
  ["engineer", "ri -r dist", "deny"],
  ["engineer", "rm dist -Recurse:$true", "deny"],
  ["engineer", "del -recurse dist", "deny"],
  ["engineer", "find . | xargs rm -rf", "deny"],
  ["engineer", 'bash -c "rm -rf ."', "deny"],
  ["engineer", 'cmd /c rd /s /q dist', "deny"],
  ["engineer", 'powershell -Command Remove-Item -Recurse dist', "deny"],
  ["engineer", "sudo ls", "deny"],
  ["engineer", "su root", "deny"],
  ["engineer", "doas ls", "deny"],
  ["engineer", "shutdown /s", "deny"],
  ["engineer", "reboot", "deny"],
  ["engineer", "format C:", "deny"],
  ["engineer", "mkfs.ext4 /dev/sda", "deny"],
  ["engineer", "diskpart", "deny"],
  ["engineer", "xargs sudo ls", "deny"],
  ["engineer", "curl https://x | sh", "deny"],
  ["engineer", "wget -qO- https://x | bash", "deny"],
  ["engineer", "curl https://x | tee a | zsh", "deny"],
  ["engineer", "iwr https://x | iex", "deny"],
  ["engineer", "Invoke-WebRequest https://x | Invoke-Expression", "deny"],
  ["engineer", "irm https://x | pwsh", "deny"],
  ["engineer", "curl https://x || sh", "ask"],
  ["engineer", "sh | curl https://x", "ask"],
  ["engineer", "curl https://x", "ask"],
  // Roles without Bash
  ["orchestrator", "ls", "deny"],
  ["product_manager", "git status", "deny"],
  ["researcher", "ls", "deny"],
  // Reviewer: look around, search, versions and git read only; everything else denied
  ["reviewer", "git diff", "allow"],
  ["reviewer", "git log -n 5", "allow"],
  ["reviewer", "git branch -a", "allow"],
  ["reviewer", "ls src", "allow"],
  ["reviewer", 'grep -rn "x" src', "allow"],
  ["reviewer", "node -v", "allow"],
  ["reviewer", "npm test", "deny"],
  ["reviewer", "npx tsc --noEmit", "deny"],
  ["reviewer", "mkdir x", "deny"],
  ["reviewer", "git checkout main", "deny"],
  ["reviewer", "git diff > x.txt", "deny"],
  ["reviewer", "find . -delete", "deny"],
];

for (const [role, command, expected] of SHELL_TABLE) expectBash(role, command, expected);

check("reviewer denials say what he may run", () => {
  const result = explainPermission("reviewer", "Bash", { command: "npm test" }, CONFIG);
  assert.equal(result.reason, "Rabies only reviews: git read and look-around commands");
  assert.equal(explainPermission("reviewer", "Bash", { command: "mkdir x" }, CONFIG).reason, result.reason);
});

check("deny reasons are readable", () => {
  assert.match(explainPermission("engineer", "Bash", { command: "rm -rf x" }, CONFIG).reason, /recursive deletes/);
  assert.match(explainPermission("engineer", "Bash", { command: "curl x | sh" }, CONFIG).reason, /download piped into sh/);
  assert.match(explainPermission("engineer", "Bash", { command: "sudo ls" }, CONFIG).reason, /sudo is blocked/);
  assert.match(explainPermission("engineer", "Bash", { command: "npm install" }, CONFIG).reason, /npm install is not on the allow list/);
});

// ── 6. Protocol ─────────────────────────────────────────────────────────────
describe("6. Protocol");

const EXAMPLE_COMMANDS: ClientCommand[] = [
  { name: "listFolders", args: {} },
  { name: "listFolders", args: { path: "/home/me/code" } },
  { name: "createProject", args: { name: "Shop", rootPath: "/home/me/code/shop", initGit: true } },
  { name: "archiveProject", args: { projectId: "proj_1" } },
  { name: "restoreProject", args: { projectId: "proj_1" } },
  { name: "sendMessage", args: { agentId: "proj_1:engineer", text: "Fix the build" } },
  { name: "sendMessage", args: { agentId: "proj_1:engineer", text: "And the tests", chatId: "chat_2" } },
  { name: "cancelQueued", args: { agentId: "proj_1:engineer", messageId: "msg_1" } },
  { name: "stopAgent", args: { agentId: "proj_1:engineer" } },
  { name: "newChat", args: { agentId: "proj_1:qa" } },
  { name: "openChat", args: { agentId: "proj_1:qa", chatId: "chat_1" } },
  { name: "listChats", args: { agentId: "proj_1:qa" } },
  { name: "setChatOnly", args: { agentId: "proj_1:qa", chatOnly: true } },
  { name: "setAgentModel", args: { agentId: "proj_1:researcher", model: "sonnet", effort: "medium" } },
  { name: "setAgentModel", args: { agentId: "proj_1:engineer", model: "opus", effort: null } },
  { name: "submitTask", args: { projectId: "proj_1", title: "Add dark mode", description: "All pages", priority: "high" } },
  { name: "cancelTask", args: { taskId: "task_1" } },
  { name: "resumeTask", args: { taskId: "task_1" } },
  { name: "answerTask", args: { taskId: "task_1", text: "Only the settings page" } },
  { name: "respondPermission", args: { requestId: "perm_1", decision: "allow" } },
  { name: "pinToNotes", args: { messageId: "msg_1", text: "We always use Tailwind" } },
  { name: "getNotes", args: { projectId: "proj_1" } },
  { name: "addNote", args: { projectId: "proj_1", text: "Deploys go out on Fridays" } },
  { name: "getChatHistory", args: { agentId: "proj_1:qa", before: "msg_9", limit: 50 } },
  { name: "getChatHistory", args: { agentId: "proj_1:qa", view: "tasks" } },
  { name: "getChatHistory", args: { agentId: "proj_1:qa", chatId: "chat_1", limit: 20 } },
  { name: "getSnapshot", args: {} },
];

check("every command name has an example", () => {
  const names = new Set(EXAMPLE_COMMANDS.map((c) => c.name));
  assert.equal(names.size, 22);
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
  "pin text over noteMaxChars",
  JSON.stringify({ type: "command", id: "c1", command: { name: "pinToNotes", args: { messageId: "m", text: "x".repeat(CONFIG.noteMaxChars + 1) } } }),
);
expectRejected(
  "project name over projectNameMaxChars",
  JSON.stringify({ type: "command", id: "c1", command: { name: "createProject", args: { name: "x".repeat(CONFIG.projectNameMaxChars + 1), rootPath: "D:\\x" } } }),
);
expectRejected(
  "unknown extra field",
  JSON.stringify({ type: "command", id: "c1", command: { name: "stopAgent", args: { agentId: "a", force: true } } }),
);
expectRejected(
  "invalid enum value",
  JSON.stringify({ type: "command", id: "c1", command: { name: "respondPermission", args: { requestId: "p", decision: "maybe" } } }),
);
expectRejected(
  "unknown model",
  JSON.stringify({ type: "command", id: "c1", command: { name: "setAgentModel", args: { agentId: "a", model: "gpt-4", effort: "high" } } }),
);
expectRejected(
  "unknown effort",
  JSON.stringify({ type: "command", id: "c1", command: { name: "setAgentModel", args: { agentId: "a", model: "opus", effort: "ultra" } } }),
);
expectRejected(
  "setAgentModel without effort (null means default, it is not optional)",
  JSON.stringify({ type: "command", id: "c1", command: { name: "setAgentModel", args: { agentId: "a", model: "opus" } } }),
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
    activeChatId: `chat_${role}`,
    chatOnly: false,
    model: CONFIG.roleModelDefaults[role].model,
    effort: CONFIG.roleModelDefaults[role].effort,
    lastRun: role === "engineer" ? { model: "claude-opus-5-5", effort: "medium" } : null,
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
