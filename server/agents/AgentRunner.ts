import type { AgentStatus } from "../../src/shared/domain/agentTypes.ts";
import type { TokenUsage } from "../../src/shared/domain/chatTypes.ts";
import type { AgentRole } from "../../src/shared/domain/roles.ts";

export interface AgentRunInput {
  agentId: string;
  text: string;
  /** Session to resume, or null for a new one. */
  sessionId: string | null;
  /** The project folder the agent works in. */
  cwd: string;
}

export type ToolEvent =
  | { phase: "started"; toolUseId: string; toolName: string; summary: string }
  | { phase: "finished"; toolUseId: string; toolName: string; ok: boolean };

export interface AgentRunCallbacks {
  onStatus(status: AgentStatus, activity: string): void;
  onDelta(textChunk: string): void;
  onComplete(fullText: string): void;
  onError(message: string): void;
  /** The run's session id, to resume next time. */
  onSession(sessionId: string): void;
  onUsage(usage: TokenUsage): void;
  onTool(event: ToolEvent): void;
  /** Where the credential comes from ("none" = subscription login). */
  onAuth(source: string): void;
  /** Subscription usage limit hit; resetsAt in epoch ms when known. */
  onUsageLimit(resetsAt: number | null): void;
}

/**
 * Runs one input for one agent at a time. AgentManager owns queueing and state;
 * a runner only turns an input into status changes, streamed text and tool events.
 * After stop() a runner must not call any callback for the stopped run.
 */
export interface AgentRunner {
  run(input: AgentRunInput, callbacks: AgentRunCallbacks): void;
  stop(): void;
}

export type AgentRunnerFactory = (agent: { id: string; name: string; role: AgentRole }) => AgentRunner;
