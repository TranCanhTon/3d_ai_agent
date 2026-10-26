// Agent-side tests (tsx): translator, PermissionBroker, billing guard and ClaudeRunner
// with a fake SDK query. Never calls Claude.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HookInput, Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunCallbacks, ToolEvent } from "../server/agents/AgentRunner.ts";
import { assertSubscriptionBilling, BillingGuardError, buildAgentEnv, ClaudeRunner } from "../server/agents/claude/ClaudeRunner.ts";
import { NOT_LOGGED_IN, translate, type TranslatorAction } from "../server/agents/claude/translate.ts";
import { DENIED_BY_USER, PermissionBroker, STOPPED_BY_USER } from "../server/agents/PermissionBroker.ts";
import { silentLogger } from "../server/log.ts";
import { startServer } from "../server/startServer.ts";
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

await check("init emits the session id and auth source, no status", () => {
  assert.deepEqual(one(at(0)), [
    { type: "session", id: "sess-1" },
    { type: "auth", source: "none" },
  ]);
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
  const b = broker.decide(engineer, "Bash", { command: "npm test" });
  const other = broker.decide(makeAgentId(CONFIG.sandboxProjectId, "qa"), "Bash", { command: "npm test" });
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
  runner.run({ agentId: engineer, text: "hi", sessionId: "prev-session", cwd: ROOT }, callbacks);
  await waitFor(() => log.some((l) => l.startsWith("complete:")));

  const o = captured.options;
  assert.ok(o !== null);
  assert.equal(o.cwd, ROOT);
  assert.equal(o.resume, "prev-session");
  assert.equal(o.model, CONFIG.defaultModel);
  assert.equal(o.maxTurns, 30);
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.permissionMode, "default");
  assert.deepEqual(o.settingSources, ["project"]);
  assert.deepEqual(o.tools, ["Read", "Grep", "Glob", "Edit", "Write", "Bash"]);
  assert.equal(o.allowedTools, undefined, "allowedTools would auto-approve tools");
  assert.equal(o.allowDangerouslySkipPermissions, undefined);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.mcpServers, {});
  assert.deepEqual(o.settings, { disableClaudeAiConnectors: true });
  assert.deepEqual(o.skills, []);
  assert.equal(o.env?.CLAUDE_CONFIG_DIR, "D:\\claude-home-test");
  assert.equal(typeof o.canUseTool, "function");

  assert.ok(log.includes("session:sess-1"));
  assert.ok(log.includes("auth:none"));
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
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT }, callbacks);
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
  assert.equal(await decision("Bash", { command: "git status" }), "ask");
  assert.equal(await decision("Write", { file_path: "a" }), "ask");
  assert.equal(await decision("WebSearch", { query: "x" }), "deny", "not an engineer tool");
  assert.equal(await decision("Read", { file_path: "a" }), "none");
});

await check("API key billing reported at init aborts the run with an error", async () => {
  const captured: Captured = { options: null };
  const init = { ...(at(0) as object), apiKeySource: "ANTHROPIC_API_KEY" } as SDKMessage;
  const runner = new ClaudeRunner(runnerOptions({}, fakeQuery([init, at(1), at(6)], captured, true)));
  const { log, callbacks } = recordingCallbacks();
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT }, callbacks);
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
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT }, callbacks);
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
  runner.run({ agentId: engineer, text: "x", sessionId: null, cwd: ROOT }, callbacks);
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

rmSync(tmpDir, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll agent checks passed." : `\n${failures} agent check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
