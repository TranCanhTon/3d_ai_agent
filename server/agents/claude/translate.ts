// Maps Claude Agent SDK messages to AI Agent World actions. Pure: no I/O.
// The only place (with ClaudeRunner) that knows SDK message shapes; domain
// types stay free of SDK types (hard rule 4).

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentStatus } from "../../../src/shared/domain/agentTypes.ts";
import type { TokenUsage } from "../../../src/shared/domain/chatTypes.ts";
import { describeTool } from "./toolSummary.ts";

export type ResultErrorKind = "max_turns" | "auth" | "usage_limit" | "execution";

export type TranslatorAction =
  | { type: "status"; status: AgentStatus; activity: string }
  | { type: "delta"; text: string }
  | { type: "toolStarted"; toolUseId: string; toolName: string; summary: string }
  | { type: "toolFinished"; toolUseId: string; toolName: string; ok: boolean }
  | { type: "session"; id: string }
  /** Where Claude Code got its credential ("none" = claude.ai subscription login). */
  | { type: "auth"; source: string }
  /** The subscription usage limit was hit; resetsAt in epoch ms when known. */
  | { type: "usageLimit"; resetsAt: number | null }
  | { type: "result"; text: string; usage: TokenUsage | null; isError: boolean; errorKind?: ResultErrorKind };

export interface TranslateContext {
  rootPath: string;
  /** tool_use_id → tool name, for tool calls started earlier in this run. */
  toolNames: ReadonlyMap<string, string>;
  maxTurns: number;
}

export const NOT_LOGGED_IN = "Not logged in. Run claude in a terminal and use /login with your Pro account.";

/** apiKeySource values that mean the run would be billed to an API key instead of the subscription. */
const API_BILLING_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

export function isApiKeyBilling(source: string): boolean {
  return API_BILLING_SOURCES.has(source);
}

export function turnCapMessage(turns: number): string {
  return `Stopped after ${turns} turns (cap). Send another message to continue.`;
}

/** Epoch ms; the SDK's resetsAt may be in seconds. */
export function toEpochMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === "object" && value !== null ? (value as Json) : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readUsage(value: unknown): TokenUsage | null {
  const usage = obj(value);
  if (usage === null) return null;
  return {
    inputTokens:
      num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
  };
}

export function classifyErrorText(text: string): { kind: ResultErrorKind; line: string } {
  if (/usage limit|rate.?limit|limit reached|\b429\b/i.test(text)) return { kind: "usage_limit", line: "Usage limit reached" };
  if (/not logged in|log ?in|authenticat|invalid api key|oauth|credential|unauthori[sz]ed|\b401\b/i.test(text)) {
    return { kind: "auth", line: NOT_LOGGED_IN };
  }
  const firstLine = text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "Claude stopped with an error";
  return { kind: "execution", line: firstLine.length > 300 ? `${firstLine.slice(0, 299)}…` : firstLine };
}

export function translate(message: SDKMessage, ctx: TranslateContext): TranslatorAction[] {
  const m = message as unknown as Json;
  switch (m.type) {
    case "system": {
      if (m.subtype !== "init") return [];
      const actions: TranslatorAction[] = [];
      if (typeof m.session_id === "string") actions.push({ type: "session", id: m.session_id });
      if (typeof m.apiKeySource === "string") actions.push({ type: "auth", source: m.apiKeySource });
      return actions;
    }

    case "stream_event": {
      if (m.parent_tool_use_id) return []; // subagent output
      const event = obj(m.event);
      const delta = obj(event?.delta);
      if (event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        return [
          { type: "status", status: "communicating", activity: "Typing..." },
          { type: "delta", text: delta.text },
        ];
      }
      return [];
    }

    case "assistant": {
      if (m.parent_tool_use_id) return [];
      const actions: TranslatorAction[] = [];
      const content = obj(m.message)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = obj(block);
        if (b?.type !== "tool_use" || typeof b.id !== "string" || typeof b.name !== "string") continue;
        const description = describeTool(b.name, b.input, ctx.rootPath);
        actions.push({ type: "status", status: description.status, activity: description.activity });
        actions.push({ type: "toolStarted", toolUseId: b.id, toolName: b.name, summary: description.line });
      }
      if (m.error === "rate_limit") actions.push({ type: "usageLimit", resetsAt: null });
      return actions;
    }

    case "user": {
      if (m.parent_tool_use_id) return [];
      const actions: TranslatorAction[] = [];
      const content = obj(m.message)?.content;
      for (const block of Array.isArray(content) ? content : []) {
        const b = obj(block);
        if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
        const toolName = ctx.toolNames.get(b.tool_use_id);
        if (toolName === undefined) continue;
        actions.push({ type: "toolFinished", toolUseId: b.tool_use_id, toolName, ok: b.is_error !== true });
      }
      return actions;
    }

    case "rate_limit_event": {
      const info = obj(m.rate_limit_info);
      if (info?.status !== "rejected") return [];
      return [{ type: "usageLimit", resetsAt: typeof info.resetsAt === "number" ? toEpochMs(info.resetsAt) : null }];
    }

    case "result": {
      const usage = readUsage(m.usage);
      if (m.subtype === "success" && m.is_error !== true) {
        const text = typeof m.result === "string" ? m.result : "";
        return [
          { type: "status", status: "success", activity: "Done" },
          { type: "result", text, usage, isError: false },
        ];
      }
      let kind: ResultErrorKind;
      let line: string;
      if (m.subtype === "error_max_turns") {
        kind = "max_turns";
        line = turnCapMessage(num(m.num_turns) || ctx.maxTurns);
      } else {
        const errors = Array.isArray(m.errors) ? m.errors.filter((e): e is string => typeof e === "string") : [];
        const text = typeof m.result === "string" && m.result !== "" ? m.result : errors.join("\n");
        ({ kind, line } = classifyErrorText(text || `Claude stopped with an error (${String(m.subtype)})`));
      }
      const actions: TranslatorAction[] = [{ type: "status", status: "error", activity: line }];
      if (kind === "usage_limit") actions.push({ type: "usageLimit", resetsAt: null });
      actions.push({ type: "result", text: line, usage, isError: true, errorKind: kind });
      return actions;
    }

    default:
      return [];
  }
}
