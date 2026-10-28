// Agent-side tests (tsx): translator, PermissionBroker, billing guard and ClaudeRunner
// with a fake SDK query. Never calls Claude.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HookInput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunCallbacks, ToolEvent } from "../server/agents/AgentRunner.ts";
import { assertSubscriptionBilling, BillingGuardError, buildAgentEnv, ClaudeRunner } from "../server/agents/claude/ClaudeRunner.ts";
import { addNoteTool } from "../server/agents/claude/notesTool.ts";
import { describeTool } from "../server/agents/claude/toolSummary.ts";
import { NOT_LOGGED_IN, readHookEffort, translate, type TranslatorAction } from "../server/agents/claude/translate.ts";
import { buildRolePrompt, CHAT_ONLY_LINE, NO_NOTES_LINE, notesSection } from "../server/roles/rolePrompts.ts";
import { appendNoteLine, ensureNotesFile } from "../server/projects/notes.ts";
import { AGENT_ROLES, ROLE_DEFINITIONS } from "../src/shared/domain/roles.ts";
import { DENIED_BY_USER, PermissionBroker, STOPPED_BY_USER } from "../server/agents/PermissionBroker.ts";
import { silentLogger } from "../server/log.ts";
import { resolveRunnerKind, startServer } from "../server/startServer.ts";
import { World } from "../server/world/World.ts";
import { CONFIG } from "../src/shared/config.ts";
import type { AgentStatus } from "../src/shared/domain/agentTypes.ts";
import type { AgentEvent } from "../src/shared/events/eventTypes.ts";
import { makeAgentId } from "../src/shared/ids.ts";

let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ ${name}\n      ${message.split("\n").join("\n      ")}`);
  }
}

const ROOT = "D:\\agent-sandbox";
const ROLES_DIR = join(process.cwd(), "server", "roles");
const tmpDir = join(process.cwd(), ".tmp", `test-agents-${process.pid}`);
mkdirSync(tmpDir, { recursive: true });

function loadFixture(name: string): SDKMessage[] {
  return JSON.parse(readFileSync(join(process.cwd(), "scripts", "fixtures", name), "utf8")) as SDKMessage[];
}

/** Runs every message through translate, tracking tool names like ClaudeRunner does. */
function translateAll(messages: SDKMessage[]): TranslatorAction[] {
  const toolNames = new Map<string, string>();
  return messages.flatMap((message) => {
    const actions = translate(message, { rootPath: ROOT, toolNames, maxTurns: 15 });
    for (const a of actions) if (a.type === "toolStarted") toolNames.set(a.toolUseId, a.toolName);
    return actions;
  });
}

// ── Translator ──────────────────────────────────────────────────────────────
console.log("\nTranslator");
const fixture = loadFixture("sdk-handwritten.json");
const at = (i: number) => fixture[i] as SDKMessage;
const one = (m: SDKMessage) => translate(m, { rootPath: ROOT, toolNames: new Map(), maxTurns: 15 });

await check("init emits the session id, auth source and the model that runs, no status", () => {
  assert.deepEqual(one(at(0)), [
    { type: "session", id: "sess-1" },
    { type: "auth", source: "none" },
    { type: "model", model: "claude-sonnet-5-5" },
  ]);
});

await check("a recorded init reports the full model id", () => {
  const recorded = readFileSync(join(process.cwd(), "scripts", "fixtures", "sdk-recorded-drater.jsonl"), "utf8").split("\n")[0] ?? "";
  const actions = one(JSON.parse(recorded) as SDKMessage);
  assert.deepEqual(actions.find((a) => a.type === "model"), { type: "model", model: "claude-sonnet-5-5" });
});

await check("readHookEffort reads the applied effort from a hook input, null when absent", () => {
  assert.equal(readHookEffort({ hook_event_name: "Stop", effort: { level: "medium" } }), "medium");
  assert.equal(readHookEffort({ hook_event_name: "Stop" }), null);
  assert.equal(readHookEffort({ hook_event_name: "Stop", effort: { level: "" } }), null);
  assert.equal(readHookEffort(null), null);
});

await check("text deltas: communicating 'Typing...' + delta; subagent deltas ignored", () => {
  assert.deepEqual(one(at(1)), [
    { type: "status", status: "communicating", activity: "Typing..." },
    { type: "delta", text: "Let me " },
  ]);
  assert.deepEqual(one(at(3)), []);
});

await check("each tool kind maps to the right status, activity and tool line", () => {
  const actions = one(at(4));
  const statuses = actions.filter((a) => a.type === "status").map((a) => (a.type === "status" ? [a.status, a.activity] : []));
  assert.deepEqual(statuses, [
    ["thinking", "Reading src/app.ts"],
    ["thinking", "Searching TODO"],
    ["thinking", "Searching **/*.md"],
    ["thinking", "Searching: zod 4 discriminated union"],
    ["thinking", "Reading zod.dev"],
    ["working", "Editing README.md"],
    ["working", "Writing hello.txt"],
    ["working", "Running tests"],
    ["thinking", "Checking git"],
    ["working", `Running: node -e "console.log('a very long command that keeps going…`],
  ]);
  const lines = actions.filter((a) => a.type === "toolStarted").map((a) => (a.type === "toolStarted" ? a.summary : ""));
  assert.equal(lines[0], "Read src/app.ts");
  assert.equal(lines[6], "Wrote hello.txt");
  assert.equal(lines[7], "Ran: npm test");
  assert.ok(lines[9]?.startsWith("Ran: node -e"));
  assert.ok((lines[9] ?? "").length <= "Ran: ".length + 60);
});

await check("tool results finish the matching tools (ok / error), unknown ids ignored", () => {
  const actions = translateAll([at(4), at(5)]).filter((a) => a.type === "toolFinished");
  assert.deepEqual(actions, [
    { type: "toolFinished", toolUseId: "t-read", toolName: "Read", ok: true },
    { type: "toolFinished", toolUseId: "t-bash", toolName: "Bash", ok: false },
  ]);
});

await check("success result: status success 'Done' + result with usage (cache tokens counted as input)", () => {
  assert.deepEqual(one(at(6)), [
    { type: "status", status: "success", activity: "Done" },
    { type: "result", text: "All done.", usage: { inputTokens: 123, outputTokens: 45 }, isError: false },
  ]);
});

await check("turn cap result: error 'Stopped after N turns (cap)'", () => {
  const line = "Stopped after 15 turns (cap). Send another message to continue.";
  assert.deepEqual(one(at(7)), [
    { type: "status", status: "error", activity: line },
    { type: "result", text: line, usage: { inputTokens: 10, outputTokens: 5 }, isError: true, errorKind: "max_turns" },
  ]);
});

await check("not-logged-in result maps to the login hint; other errors keep their first line", () => {
  const login = one(at(8)).find((a) => a.type === "result");
  assert.deepEqual(login, { type: "result", text: NOT_LOGGED_IN, usage: { inputTokens: 0, outputTokens: 0 }, isError: true, errorKind: "auth" });
  const other = one(at(9)).find((a) => a.type === "result");
  assert.ok(other?.type === "result" && other.text === "Something went wrong" && other.errorKind === "execution");
});

await check("rate_limit_event rejected → usageLimit with resetsAt in ms; allowed → nothing", () => {
  assert.deepEqual(one(at(10)), [{ type: "usageLimit", resetsAt: 1793030400 * 1000 }]);
  assert.deepEqual(one(at(11)), []);
});

const recorded = existsSync(join(process.cwd(), "scripts", "fixtures", "sdk-recorded-drater.jsonl"));
if (recorded) {
  await check("replay of a real recording: session, tools, text and a successful result", () => {
    const lines = readFileSync(join(process.cwd(), "scripts", "fixtures", "sdk-recorded-drater.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as SDKMessage);
    const actions = translateAll(lines);
    assert.ok(actions.some((a) => a.type === "session"), "session");
    assert.ok(actions.some((a) => a.type === "auth" && a.source === "none"), "subscription auth");
    assert.ok(actions.some((a) => a.type === "toolStarted"), "tool started");
    assert.ok(actions.some((a) => a.type === "toolFinished" && a.ok), "tool finished");
    assert.ok(actions.filter((a) => a.type === "delta").length >= 2, "streamed text");
    const result = actions.find((a) => a.type === "result");
    assert.ok(result?.type === "result" && !result.isError && result.usage !== null && result.usage.outputTokens > 0);
  });
}

// ── PermissionBroker ────────────────────────────────────────────────────────
console.log("\nPermissionBroker");

function fakeWorld() {
  const events: AgentEvent[] = [];
  const statuses: Array<[string, AgentStatus, string]> = [];
  const world = new World({ onEvent: (e) => events.push(e), onChange: () => {} }, "claude");
  world.seedSandbox(ROOT, true);
  const broker = new PermissionBroker({ world, setStatus: (id, s, a) => statuses.push([id, s, a]) });
  return { world, broker, events, statuses };
}
const engineer = makeAgentId(CONFIG.sandboxProjectId, "engineer");
const reviewer = makeAgentId(CONFIG.sandboxProjectId, "reviewer");
const flush = () => new Promise((r) => setImmediate(r));

await check("allow path: Read is allowed with no card", async () => {
  const { world, broker, events } = fakeWorld();
  assert.deepEqual(await broker.decide(engineer, "Read", { file_path: "a" }), { behavior: "allow" });
  assert.equal(world.pendingPermissions.length, 0);
  assert.equal(events.length, 0);
});

await check("automatic deny: git push --force, with the rule's reason and no card", async () => {
  const { world, broker, events } = fakeWorld();
  const result = await broker.decide(engineer, "Bash", { command: "git push --force" });
  assert.equal(result.behavior, "deny");
  assert.ok(result.behavior === "deny" && result.message.startsWith("Blocked by AI Agent World rules: "), JSON.stringify(result));
  assert.ok(result.behavior === "deny" && result.message.includes("push --force"));
  assert.equal(world.pendingPermissions.length, 0);
  assert.equal(events.length, 0);
  const notAllowed = await broker.decide(reviewer, "Write", { file_path: "x" });
  assert.ok(notAllowed.behavior === "deny" && /not available to the Code Reviewer/.test(notAllowed.message));
});

await check("ask path: card in the snapshot, waiting_permission, resolved by allow", async () => {
  const { world, broker, events, statuses } = fakeWorld();
  const pending = broker.decide(engineer, "Write", { file_path: `${ROOT}\\hello.txt`, content: "hi" });
  await flush();
  const snapshot = world.snapshot();
  assert.equal(snapshot.pendingPermissions.length, 1);
  const request = snapshot.pendingPermissions[0];
  assert.ok(request !== undefined);
  assert.equal(request.summary, "Writing hello.txt");
  assert.ok(events.some((e) => e.type === "permission.requested"));
  assert.deepEqual(statuses.at(-1), [engineer, "waiting_permission", "Needs your OK: Writing hello.txt"]);

  broker.respond(request.id, "allow");
  assert.deepEqual(await pending, { behavior: "allow" });
  assert.equal(world.pendingPermissions.length, 0);
  assert.ok(events.some((e) => e.type === "permission.resolved" && e.metadata?.decision === "allow"));
  assert.equal(statuses.at(-1)?.[1], "thinking");
  assert.throws(() => broker.respond(request.id, "allow"), /already answered/);
});

await check("ask path resolved by deny tells Claude the user denied it", async () => {
  const { world, broker } = fakeWorld();
  const pending = broker.decide(engineer, "Edit", { file_path: "README.md" });
  await flush();
  broker.respond(world.pendingPermissions[0]?.id ?? "", "deny");
  assert.deepEqual(await pending, { behavior: "deny", message: DENIED_BY_USER });
});

await check("stop denies every pending request of that agent only", async () => {
  const { world, broker } = fakeWorld();
  const a = broker.decide(engineer, "Write", { file_path: "a" });
  const b = broker.decide(engineer, "Bash", { command: "npm install" });
  const other = broker.decide(makeAgentId(CONFIG.sandboxProjectId, "qa"), "Bash", { command: "npm install" });
  await flush();
  assert.equal(world.pendingPermissions.length, 3);
  broker.denyAllFor(engineer);
  assert.deepEqual(await a, { behavior: "deny", message: STOPPED_BY_USER });
  assert.deepEqual(await b, { behavior: "deny", message: STOPPED_BY_USER });
  assert.equal(world.pendingPermissions.length, 1);
  broker.denyAllFor(makeAgentId(CONFIG.sandboxProjectId, "qa"));
  assert.equal((await other).behavior, "deny");
});

await check("an aborted signal denies a waiting request", async () => {
  const { world, broker } = fakeWorld();
  const controller = new AbortController();
  const pending = broker.decide(engineer, "Write", { file_path: "a" }, controller.signal);
  await flush();
  controller.abort();
  assert.deepEqual(await pending, { behavior: "deny", message: STOPPED_BY_USER });
  assert.equal(world.pendingPermissions.length, 0);
});

// ── Runner kind ─────────────────────────────────────────────────────────────
console.log("\nRunner kind");

await check("--runner= wins over AGENT_RUNNER, which wins over config; an unknown flag throws", () => {
  assert.equal(resolveRunnerKind({ AGENT_RUNNER: "echo" }, ["--runner=scripted"]), "scripted");
  assert.equal(resolveRunnerKind({ AGENT_RUNNER: "echo" }, []), "echo");
  assert.equal(resolveRunnerKind({ AGENT_RUNNER: "nonsense" }), CONFIG.agentRunner);
  assert.throws(() => resolveRunnerKind({}, ["--runner=gpt"]), /Unknown runner "gpt"/);
});

// ── Billing guard ───────────────────────────────────────────────────────────
console.log("\nBilling guard");

function runnerOptions(env: Record<string, string | undefined>, query?: unknown) {
  const { broker } = fakeWorld();
  return {
    agent: { id: engineer, name: "STD Dren", role: "engineer" as const },
    broker,
    log: silentLogger,
    recordingsDir: join(tmpDir, "recordings"),
    tempDir: tmpDir,
    rolesDir: ROLES_DIR,
    configDir: "D:\\claude-home-test",
    executablePath: null,
    env,
    ...(query === undefined ? {} : { query: query as never }),
  };
}

await check("with ANTHROPIC_API_KEY set, the Claude runner refuses to start", () => {
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"]) {
    assert.throws(() => assertSubscriptionBilling({ [name]: "x" }), BillingGuardError, name);
  }
  assert.throws(() => new ClaudeRunner(runnerOptions({ ANTHROPIC_API_KEY: "sk-test" })), BillingGuardError);
  assert.doesNotThrow(() => assertSubscriptionBilling({ ANTHROPIC_API_KEY: "" }));
});

await check("the server refuses to start the claude runner with ANTHROPIC_API_KEY set", async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-test";
  try {
    await assert.rejects(
      startServer({
        host: "127.0.0.1",
        port: 0,
        tokenPath: join(tmpDir, "token"),
        allowedOrigins: CONFIG.allowedOrigins,
        runner: "claude",
        log: silentLogger,
      }),
      BillingGuardError,
    );
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

await check("agent env drops inherited CLAUDE*/ANTHROPIC* vars and sets config + temp dirs", () => {
  const env = buildAgentEnv(
    { PATH: "p", ANTHROPIC_BASE_URL: "http://proxy", CLAUDECODE: "1", CLAUDE_CODE_OAUTH_TOKEN: "t", CLAUDE_CODE_GIT_BASH_PATH: "bash" },
    { configDir: "D:\\home", tempDir: "D:\\tmp" },
  );
  assert.equal(env.PATH, "p");
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, "bash");
  assert.equal(env.CLAUDE_CONFIG_DIR, "D:\\home");
  assert.equal(env.TEMP, "D:\\tmp");
  assert.equal(env.TMP, "D:\\tmp");
});

// ── ClaudeRunner with a fake SDK ────────────────────────────────────────────
console.log("\nClaudeRunner (fake SDK)");

interface Captured {
  options: Options | null;
}

function fakeQuery(messages: SDKMessage[], captured: Captured, holdOpen = false) {
  return ({ options }: { prompt: string; options?: Options }) => {
    captured.options = options ?? null;
    return (async function* () {
      for (const m of messages) {
        await flush();
        yield m;
      }
      if (holdOpen) {
        await new Promise<void>((_, reject) =>
          options?.abortController?.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      }
    })();
  };
}

function recordingCallbacks() {
  const log: string[] = [];
  const tools: ToolEvent[] = [];
  const callbacks: AgentRunCallbacks = {
    onStatus: (s, a) => log.push(`status:${s}:${a}`),
    onDelta: (t) => log.push(`delta:${t}`),
    onComplete: (t) => log.push(`complete:${t}`),
    onError: (e) => log.push(`error:${e}`),
    onSession: (id) => log.push(`session:${id}`),
    onUsage: (u) => log.push(`usage:${u.inputTokens}/${u.outputTokens}`),
    onTool: (e) => tools.push(e),
    onAuth: (s) => log.push(`auth:${s}`),
    onUsageLimit: (r) => log.push(`limit:${r}`),
    onRunInfo: (i) => log.push(`ran:${i.model}/${i.effort ?? "-"}`),
    addNote: (text) => {
      log.push(`note:${text}`);
      return `- ${text} (STD Dren, 2026-01-01)`;
    },
  };
  return { log, tools, callbacks };
}

async function waitFor(predicate: () => boolean, ms = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

await check("passes safe SDK options and maps a run to callbacks, recording every message", async () => {
  const captured: Captured = { options: null };
  const messages = [at(0), at(1), at(2), at(4), at(5), at(6)];
  const runner = new ClaudeRunner(runnerOptions({ PATH: "p" }, fakeQuery(messages, captured)));
  const { log, tools, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "hi", sessionId: "prev-session", cwd: ROOT, chatOnly: false, model: "opus", effort: "high" }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("complete:")));

  const o = captured.options;
  assert.ok(o !== null);
  assert.equal(o.cwd, ROOT);
  assert.equal(o.resume, "prev-session");
  assert.equal(o.model, "opus", "the run input's model, not a role constant");
  assert.equal(o.effort, "high");
  assert.equal(o.maxTurns, 30);
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.permissionMode, "default");
  assert.deepEqual(o.settingSources, ["project"]);
  assert.deepEqual(o.tools, ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
  assert.equal(o.allowedTools, undefined, "allowedTools would auto-approve tools");
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(Object.keys(o.mcpServers ?? {}), ["agentworld"], "our notes server is the only tool server");
  assert.equal((o.mcpServers?.agentworld as { type?: string } | undefined)?.type, "sdk");
  const prompt = o.systemPrompt as { type: string; preset: string; append: string; snapshot: boolean };
  assert.equal(prompt.type, "preset");
  assert.equal(prompt.preset, "claude_code");
  assert.equal(prompt.snapshot, false, "re-rendered each run so prompt edits reach resumed sessions");
  assert.ok(prompt.append.startsWith("You are STD Dren"), prompt.append.slice(0, 40));
  assert.ok(prompt.append.includes(`Project folder: ${ROOT}`));
  assert.ok(!prompt.append.includes(CHAT_ONLY_LINE));
  assert.deepEqual(o.settings, { disableClaudeAiConnectors: true });
  assert.deepEqual(o.skills, []);
  assert.equal(o.env?.CLAUDE_CONFIG_DIR, "D:\\claude-home-test");
  assert.equal(typeof o.canUseTool, "function");

  assert.ok(log.includes("session:sess-1"));
  assert.ok(log.includes("auth:none"));
  assert.ok(log.includes("ran:claude-sonnet-5-5/-"), "init reports the model; no hook ran yet, so no effort");
  assert.ok(log.includes("delta:Let me ") && log.includes("delta:look."));
  assert.ok(log.includes("usage:123/45"));
  assert.ok(log.includes("complete:All done."));
  assert.equal(tools.filter((t) => t.phase === "started").length, 10);
  assert.deepEqual(
    tools.filter((t) => t.phase === "finished").map((t) => (t.phase === "finished" ? t.ok : null)),
    [true, false],
  );

  const folder = join(tmpDir, "recordings", engineer.replace(":", "_"));
  const files = readdirSync(folder);
  assert.equal(files.length, 1);
  assert.match(files[0] ?? "", /^\d{8}-\d{6}\.jsonl$/);
  assert.equal(readFileSync(join(folder, files[0] ?? ""), "utf8").trim().split("\n").length, messages.length);
});

await check("PreToolUse hook applies our rules to every call: deny, ask (→ canUseTool), allow", async () => {
  const captured: Captured = { options: null };
  const runner = new ClaudeRunner(runnerOptions({}, fakeQuery([at(0), at(6)], captured)));
  const { log, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT, chatOnly: false, model: "sonnet", effort: "medium" }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("complete:")));
  const hook = captured.options?.hooks?.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook !== undefined);
  const call = (tool_name: string, tool_input: unknown) =>
    hook(
      { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: ROOT } as HookInput,
      "t",
      { signal: new AbortController().signal },
    );
  const decision = async (tool: string, input: unknown) => {
    const out = (await call(tool, input)) as { hookSpecificOutput?: { permissionDecision?: string } };
    return out.hookSpecificOutput?.permissionDecision ?? "none";
  };
  assert.equal(await decision("Bash", { command: "git push --force" }), "deny");
  assert.equal(await decision("Bash", { command: "git status" }), "none", "read-only git runs without a card");
  assert.equal(await decision("Bash", { command: "npm install" }), "ask");
  assert.equal(await decision("mcp__agentworld__add_note", { text: "x" }), "none");
  assert.equal(await decision("Write", { file_path: "a" }), "ask");
  assert.equal(await decision("WebSearch", { query: "x" }), "deny", "not an engineer tool");
  assert.equal(await decision("Read", { file_path: "a" }), "none");
});

await check("effort: sent when set, no effort key when null; hooks report the applied (downgraded) effort", async () => {
  const captured: Captured = { options: null };
  const runner = new ClaudeRunner(runnerOptions({}, fakeQuery([at(0), at(6)], captured, true)));
  const { log, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT, chatOnly: false, model: "haiku", effort: null }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("ran:")));
  const o = captured.options;
  assert.ok(o !== null);
  assert.equal(o.model, "haiku");
  assert.ok(!("effort" in o), "null effort sends no effort option");
  const signal = { signal: new AbortController().signal };
  const preToolUse = o.hooks?.PreToolUse?.[0]?.hooks[0];
  const stop = o.hooks?.Stop?.[0]?.hooks[0];
  assert.ok(preToolUse !== undefined && stop !== undefined);
  await preToolUse(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: ROOT, effort: { level: "medium" } } as HookInput,
    "t",
    signal,
  );
  assert.ok(log.includes("ran:claude-sonnet-5-5/medium"), log.join(" | "));
  assert.deepEqual(await stop({ hook_event_name: "Stop", session_id: "s", transcript_path: "", cwd: ROOT, stop_hook_active: false, effort: { level: "low" } } as HookInput, undefined, signal), {});
  assert.ok(log.includes("ran:claude-sonnet-5-5/low"), "the Stop hook reports it too (runs without tool calls)");
  runner.stop();
});

await check("API key billing reported at init aborts the run with an error", async () => {
  const captured: Captured = { options: null };
  const init = { ...(at(0) as object), apiKeySource: "ANTHROPIC_API_KEY" } as SDKMessage;
  const runner = new ClaudeRunner(runnerOptions({}, fakeQuery([init, at(1), at(6)], captured, true)));
  const { log, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT, chatOnly: false, model: "sonnet", effort: "medium" }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("error:")));
  await flush();
  assert.ok(captured.options?.abortController?.signal.aborted, "aborted");
  assert.ok(log.some((l) => l.startsWith("error:Refusing to run: Claude reported API key billing")));
  assert.ok(!log.some((l) => l.startsWith("complete:")));
});

await check("usage limit: onUsageLimit with the reset time and a 'resets at HH:MM' error", async () => {
  const captured: Captured = { options: null };
  const limitResult = { ...(at(9) as object), result: "Claude AI usage limit reached" } as SDKMessage;
  const runner = new ClaudeRunner(runnerOptions({}, fakeQuery([at(0), at(10), limitResult], captured)));
  const { log, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT, chatOnly: false, model: "sonnet", effort: "medium" }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("error:")));
  assert.ok(log.includes(`limit:${1793030400 * 1000}`));
  assert.ok(log.some((l) => /^error:Usage limit, resets at \d\d:\d\d$/.test(l)), log.join(" | "));
});

await check("stop() aborts the query, drops later callbacks and denies pending permissions", async () => {
  const captured: Captured = { options: null };
  const { broker, world } = fakeWorld();
  const options = { ...runnerOptions({}, fakeQuery([at(0), at(1)], captured, true)), broker };
  const runner = new ClaudeRunner(options);
  const { log, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT, chatOnly: false, model: "sonnet", effort: "medium" }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("delta:")));
  const pending = broker.decide(engineer, "Write", { file_path: "a" });
  await flush();
  assert.equal(world.pendingPermissions.length, 1);
  runner.stop();
  assert.ok(captured.options?.abortController?.signal.aborted);
  assert.deepEqual(await pending, { behavior: "deny", message: STOPPED_BY_USER });
  const before = log.length;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(log.length, before, "no callbacks after stop");
});

await check("chat only: no tools, no tool server, the chat only line, and the hook denies everything", async () => {
  const captured: Captured = { options: null };
  const runner = new ClaudeRunner(runnerOptions({}, fakeQuery([at(0), at(6)], captured)));
  const { log, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT, chatOnly: true, model: "sonnet", effort: "medium" }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("complete:")));
  const o = captured.options;
  assert.ok(o !== null);
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.mcpServers, {});
  assert.ok((o.systemPrompt as { append: string }).append.endsWith(CHAT_ONLY_LINE));
  const hook = o.hooks?.PreToolUse?.[0]?.hooks[0];
  assert.ok(hook !== undefined);
  const out = (await hook(
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "a" }, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: ROOT } as HookInput,
    "t",
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, "deny");
});

// ── Role prompts and add_note ───────────────────────────────────────────────
console.log("\nRole prompts and add_note");

const SHOP = "D:\\shop";

await check("each role's prompt has its name, the team line with Rabies and the project folder", () => {
  for (const role of AGENT_ROLES) {
    const prompt = buildRolePrompt(ROLES_DIR, role, SHOP, false);
    assert.ok(prompt.startsWith(`You are ${ROLE_DEFINITIONS[role].name}`), role);
    assert.ok(prompt.includes("Team: sONion Ring (Orchestrator)") && prompt.includes("Rabies (Code Reviewer)."), role);
    assert.ok(prompt.includes("Shared rules:\nIf the user makes a decision"), role);
    assert.ok(!prompt.includes("Read .agentworld/notes.md"), role);
    assert.ok(prompt.endsWith(`\n\nProject folder: ${SHOP}`), role);
    assert.ok(!prompt.includes(CHAT_ONLY_LINE));
  }
});

await check("chat only adds the chat only line at the end", () => {
  const prompt = buildRolePrompt(ROLES_DIR, "researcher", SHOP, true);
  assert.ok(prompt.endsWith(`Project folder: ${SHOP}\n\n${CHAT_ONLY_LINE}`));
});

await check("team notes come after the shared rules, without the header", () => {
  const root = join(tmpDir, "notes-prompt");
  appendNoteLine(root, "- We use Tailwind (STD Dren, 2026-01-01)");
  appendNoteLine(root, "- Keep the API stable (pinned by you, 2026-01-02)");
  const prompt = buildRolePrompt(ROLES_DIR, "engineer", root, false);
  const notes = "Team notes (.agentworld/notes.md):\n- We use Tailwind (STD Dren, 2026-01-01)\n- Keep the API stable (pinned by you, 2026-01-02)";
  assert.ok(prompt.indexOf("Team: sONion Ring") < prompt.indexOf(notes), prompt);
  assert.ok(prompt.endsWith(`${notes}\n\nProject folder: ${root}`), prompt);
  assert.ok(!prompt.includes("# Team notes"));
});

await check("missing or empty notes: 'Team notes: none yet.'", () => {
  assert.ok(buildRolePrompt(ROLES_DIR, "qa", join(tmpDir, "no-such-project"), false).includes(`\n\n${NO_NOTES_LINE}\n\n`));
  const empty = join(tmpDir, "empty-notes");
  ensureNotesFile(empty);
  assert.ok(buildRolePrompt(ROLES_DIR, "qa", empty, false).includes(NO_NOTES_LINE));
  assert.equal(notesSection("# Team notes\n\n   \n"), NO_NOTES_LINE);
});

await check("notes over notesPromptMaxChars keep the newest lines that fit", () => {
  const lines = Array.from({ length: 400 }, (_, i) => `- note number ${i} with some padding text (STD Dren, 2026-01-01)`);
  const section = notesSection(`# Team notes\n\n${lines.join("\n")}\n`);
  const body = section.slice(section.indexOf("\n") + 1);
  assert.ok(section.startsWith("Team notes (.agentworld/notes.md):\n(Older notes are in .agentworld/notes.md.)\n"));
  assert.ok(body.length <= CONFIG.notesPromptMaxChars, String(body.length));
  assert.ok(body.endsWith(lines[399] ?? "x"));
  assert.ok(!body.includes("note number 0 "));
  const kept = body.split("\n").slice(1);
  assert.deepEqual(kept, lines.slice(lines.length - kept.length), "a run of the newest lines");
  assert.ok(body.length + (lines[0]?.length ?? 0) + 1 > CONFIG.notesPromptMaxChars, "as many lines as fit");
  assert.equal(notesSection("# Team notes\n\n- short\n", 10_000), "Team notes (.agentworld/notes.md):\n- short");
});

await check("chat only prompts get the notes too", () => {
  const root = join(tmpDir, "notes-prompt");
  const prompt = buildRolePrompt(ROLES_DIR, "researcher", root, true);
  assert.ok(prompt.includes("- We use Tailwind (STD Dren, 2026-01-01)"));
  assert.ok(prompt.endsWith(`Project folder: ${root}\n\n${CHAT_ONLY_LINE}`));
});

await check("role files are copied as given (verdict lines and section markers)", () => {
  assert.ok(buildRolePrompt(ROLES_DIR, "qa", "x", false).includes("Your last line must be exactly one of:\nVERDICT: PASS\nVERDICT: FAIL"));
  assert.ok(buildRolePrompt(ROLES_DIR, "reviewer", "x", false).includes("VERDICT: APPROVED\nVERDICT: CHANGES"));
  const orchestrator = buildRolePrompt(ROLES_DIR, "orchestrator", "x", false);
  assert.ok(orchestrator.includes("Always start with:\nYOU ASKED:\n"));
  assert.ok(orchestrator.includes("and end with:\nQUESTION:\n1. <question>\n2. <question>"));
  assert.ok(orchestrator.includes("RESTART FROM: <planning, research, implementation or testing> - <one line why>"));
  assert.ok(buildRolePrompt(ROLES_DIR, "engineer", "x", false).includes("STEPS DONE: <the numbers of the plan steps"));
  assert.ok(orchestrator.includes("SUMMARY:\n<one line for the team notes, under 150 characters>"));
  assert.ok(buildRolePrompt(ROLES_DIR, "engineer", "x", false).includes("Never commit unless the user explicitly asks you to."));
});

await check("add_note tool: returns the written line, or an error result Claude can read", async () => {
  const written: string[] = [];
  const ok = addNoteTool((text) => {
    written.push(text);
    return `- ${text} (STD Dren, 2026-01-01)`;
  });
  assert.equal(ok.name, "add_note");
  const result = await ok.handler({ text: "We use Tailwind" }, {});
  assert.deepEqual(written, ["We use Tailwind"]);
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result.content), /Noted: - We use Tailwind/);
  const failing = addNoteTool(() => {
    throw new Error("A note cannot be empty");
  });
  const error = await failing.handler({ text: " " }, {});
  assert.equal(error.isError, true);
  assert.match(JSON.stringify(error.content), /cannot be empty/);
});

await check("translator and tool summary: mcp__agentworld__add_note is 'Pinning a note' as add_note", () => {
  assert.deepEqual(describeTool("mcp__agentworld__add_note", { text: "x" }, ROOT), {
    status: "working",
    activity: "Pinning a note",
    line: "Pinned a note",
  });
  const actions = one({
    type: "assistant",
    parent_tool_use_id: null,
    message: { content: [{ type: "tool_use", id: "tn", name: "mcp__agentworld__add_note", input: { text: "x" } }] },
  } as unknown as SDKMessage);
  assert.deepEqual(actions, [
    { type: "status", status: "working", activity: "Pinning a note" },
    { type: "toolStarted", toolUseId: "tn", toolName: "add_note", summary: "Pinned a note" },
  ]);
});

rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll agent checks passed." : `\n${failures} agent check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
