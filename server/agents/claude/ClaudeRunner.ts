// Runs an agent's input as a real Claude Code session through the Claude Agent SDK,
// on the user's Claude subscription. One instance per agent.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  query as sdkQuery,
  type HookInput,
  type HookJSONOutput,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { CONFIG } from "../../../src/shared/config.ts";
import { explainPermission } from "../../../src/shared/domain/permissions.ts";
import { builtInToolsFor, NOTES_TOOL_SERVER, ROLE_DEFINITIONS, type AgentRole } from "../../../src/shared/domain/roles.ts";
import type { Logger } from "../../log.ts";
import { buildRolePrompt } from "../../roles/rolePrompts.ts";
import type { AgentRunCallbacks, AgentRunInput, AgentRunner } from "../AgentRunner.ts";
import type { PermissionBroker } from "../PermissionBroker.ts";
import { createNotesServer } from "./notesTool.ts";
import { classifyErrorText, isApiKeyBilling, translate, type TranslatorAction } from "./translate.ts";

/** If any of these is set, Claude would bill an API key or a cloud account instead of the subscription. */
export const BILLING_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

/** Inherited variables we keep even though they match the CLAUDE/ANTHROPIC prefixes. */
const KEEP_ENV = new Set(["CLAUDE_CODE_GIT_BASH_PATH"]);

export class BillingGuardError extends Error {}

type Env = Record<string, string | undefined>;

/** Throws when the environment would bill anything other than the Claude subscription. */
export function assertSubscriptionBilling(env: Env): void {
  const set = BILLING_ENV_VARS.filter((name) => (env[name] ?? "") !== "");
  if (set.length > 0) {
    throw new BillingGuardError(
      `Refusing to start Claude agents: ${set.join(", ")} is set. AI Agent World only runs on your Claude subscription; remove it from the environment and restart.`,
    );
  }
}

/**
 * Environment for the Claude Code subprocess: drops every inherited variable starting with
 * CLAUDE or ANTHROPIC (billing switches, and a parent Claude session's own settings such as
 * ANTHROPIC_BASE_URL), then points config and temp folders where we want them.
 */
export function buildAgentEnv(env: Env, paths: { configDir: string | null; tempDir: string }): Env {
  const result: Env = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(CLAUDE|ANTHROPIC)/i.test(key) && !KEEP_ENV.has(key.toUpperCase())) continue;
    result[key] = value;
  }
  if (paths.configDir !== null) result.CLAUDE_CONFIG_DIR = paths.configDir;
  result.TEMP = paths.tempDir;
  result.TMP = paths.tempDir;
  result.TMPDIR = paths.tempDir;
  result.CLAUDE_AGENT_SDK_CLIENT_APP = "ai-agent-world/0.1";
  return result;
}

function timestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function clockTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** One JSONL file per run: <dir>/<agentId with ":" → "_">/<YYYYMMDD-HHmmss>.jsonl. */
function recordingPath(dir: string, agentId: string, now: Date): string {
  const folder = join(dir, agentId.replace(/[:\\/]/g, "_"));
  mkdirSync(folder, { recursive: true });
  let path = join(folder, `${timestamp(now)}.jsonl`);
  for (let i = 2; existsSync(path); i++) path = join(folder, `${timestamp(now)}-${i}.jsonl`);
  return path;
}

export interface ClaudeRunnerOptions {
  agent: { id: string; name: string; role: AgentRole };
  broker: PermissionBroker;
  log: Logger;
  /** Absolute folders. */
  recordingsDir: string;
  tempDir: string;
  /** Folder with the role prompt files. */
  rolesDir: string;
  configDir: string | null;
  executablePath: string | null;
  env?: Env;
  /** Injected in tests. */
  query?: typeof sdkQuery;
}

export class ClaudeRunner implements AgentRunner {
  private readonly options: ClaudeRunnerOptions;
  private readonly env: Env;
  private abort: AbortController | null = null;
  /** Bumped by stop() and each run; callbacks from older runs are dropped. */
  private generation = 0;

  constructor(options: ClaudeRunnerOptions) {
    const env = options.env ?? process.env;
    assertSubscriptionBilling(env);
    this.options = options;
    this.env = buildAgentEnv(env, { configDir: options.configDir, tempDir: options.tempDir });
  }

  run(input: AgentRunInput, callbacks: AgentRunCallbacks): void {
    this.stop();
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    const abort = new AbortController();
    this.abort = abort;

    const { agent, broker, log } = this.options;
    const role = ROLE_DEFINITIONS[agent.role];
    const recording = recordingPath(this.options.recordingsDir, agent.id, new Date());
    const toolNames = new Map<string, string>();
    const stderrTail: string[] = [];
    let finished = false;
    let resetsAt: number | null = null;

    const fail = (message: string) => {
      if (finished || !live()) return;
      finished = true;
      callbacks.onError(message);
    };

    // Chat only: no built-in tools, no tool server, and the rules deny anything that slips through.
    const toolOverride = input.chatOnly ? [] : undefined;
    let rolePrompt: string;
    try {
      rolePrompt = buildRolePrompt(this.options.rolesDir, agent.role, input.cwd, input.chatOnly);
    } catch (error) {
      log(`${agent.id} role prompt missing: ${error instanceof Error ? error.message : String(error)}`);
      queueMicrotask(() => fail(`Role prompt could not be read from ${this.options.rolesDir}`));
      return;
    }

    // Every tool call goes through our rules first. "ask" forces Claude Code to route
    // the call to canUseTool even when it would otherwise auto-approve it.
    const preToolUse = async (hookInput: HookInput): Promise<HookJSONOutput> => {
      if (hookInput.hook_event_name !== "PreToolUse") return {};
      const outcome = explainPermission(agent.role, hookInput.tool_name, hookInput.tool_input, CONFIG, toolOverride);
      if (outcome.verdict === "allow") return {};
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: outcome.verdict,
          permissionDecisionReason:
            outcome.verdict === "deny" ? `Blocked by AI Agent World rules: ${outcome.reason}` : "AI Agent World asks the user first",
        },
      };
    };

    const options: Options = {
      cwd: input.cwd,
      model: role.model,
      maxTurns: role.maxTurns,
      resume: input.sessionId ?? undefined,
      includePartialMessages: true,
      // Claude Code's own prompt (keeps its tool instructions) plus the role prompt.
      // snapshot: false re-renders it every run, so prompt edits and the chat only switch
      // also reach resumed sessions (a recorded prompt would ignore a new append).
      systemPrompt: { type: "preset", preset: "claude_code", append: rolePrompt, snapshot: false },
      // Restricts which built-in tools exist; it does not approve them (unlike allowedTools).
      tools: builtInToolsFor(agent.role, input.chatOnly),
      permissionMode: "default",
      // Project settings only (loads the project's CLAUDE.md); never the user's settings or allow rules.
      settingSources: ["project"],
      // Our in-process notes server is the only tool server: not the login's claude.ai connectors
      // (Gmail, Notion, Drive, ...), not plugin or .mcp.json servers. They add huge tool lists to
      // every prompt and are not ours to use.
      mcpServers: input.chatOnly ? {} : { [NOTES_TOOL_SERVER]: createNotesServer((text) => callbacks.addNote(text)) },
      strictMcpConfig: true,
      settings: { disableClaudeAiConnectors: true },
      // Hide skills from the model; the role prompt says what to do.
      skills: [],
      hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
      canUseTool: (toolName, toolInput, { signal }) => broker.decide(agent.id, toolName, toolInput, signal, toolOverride),
      abortController: abort,
      env: this.env,
      pathToClaudeCodeExecutable: this.options.executablePath ?? undefined,
      stderr: (data) => {
        stderrTail.push(data);
        if (stderrTail.length > 20) stderrTail.shift();
      },
    };

    const apply = (action: TranslatorAction) => {
      switch (action.type) {
        case "status":
          callbacks.onStatus(action.status, action.activity);
          break;
        case "delta":
          callbacks.onDelta(action.text);
          break;
        case "toolStarted":
          toolNames.set(action.toolUseId, action.toolName);
          callbacks.onTool({ phase: "started", toolUseId: action.toolUseId, toolName: action.toolName, summary: action.summary });
          break;
        case "toolFinished":
          callbacks.onTool({ phase: "finished", toolUseId: action.toolUseId, toolName: action.toolName, ok: action.ok });
          break;
        case "session":
          callbacks.onSession(action.id);
          break;
        case "auth":
          log(`${agent.id} auth source: ${action.source}`);
          callbacks.onAuth(action.source);
          if (isApiKeyBilling(action.source)) {
            abort.abort();
            fail(`Refusing to run: Claude reported API key billing (${action.source}). Log in with your Pro account instead.`);
          }
          break;
        case "usageLimit":
          if (action.resetsAt !== null) resetsAt = action.resetsAt;
          callbacks.onUsageLimit(resetsAt);
          break;
        case "result":
          if (finished) break;
          if (action.usage !== null) callbacks.onUsage(action.usage);
          if (!action.isError) {
            finished = true;
            callbacks.onComplete(action.text);
          } else if (action.errorKind === "usage_limit") {
            fail(resetsAt !== null ? `Usage limit, resets at ${clockTime(resetsAt)}` : "Usage limit reached");
          } else {
            fail(action.text);
          }
          break;
      }
    };

    const runQuery = this.options.query ?? sdkQuery;
    void (async () => {
      try {
        const stream = runQuery({ prompt: input.text, options });
        for await (const message of stream) {
          if (!live()) break;
          appendFileSync(recording, `${JSON.stringify(message)}\n`);
          const sdkMessage = message as SDKMessage;
          if (sdkMessage.type === "rate_limit_event" || (sdkMessage.type === "result" && sdkMessage.is_error)) {
            log(`${agent.id} raw ${sdkMessage.type}: ${JSON.stringify(sdkMessage).slice(0, 2000)}`);
          }
          const ctx = { rootPath: input.cwd, toolNames, maxTurns: role.maxTurns };
          for (const action of translate(sdkMessage, ctx)) {
            if (!live()) break;
            apply(action);
          }
        }
        if (live()) fail("Claude ended without a result.");
      } catch (error) {
        if (!live() || abort.signal.aborted) return;
        const text = `${error instanceof Error ? error.message : String(error)}\n${stderrTail.join("")}`;
        log(`${agent.id} run failed: ${text.slice(0, 2000)}`);
        fail(classifyErrorText(text).line);
      } finally {
        if (this.abort === abort) this.abort = null;
      }
    })();
  }

  stop(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.options.broker.denyAllFor(this.options.agent.id);
  }
}
