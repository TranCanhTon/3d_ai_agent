import type { AgentStatus } from "../../src/shared/domain/agentTypes.ts";

export interface AgentRunCallbacks {
  onStatus(status: AgentStatus, activity: string): void;
  onDelta(textChunk: string): void;
  onComplete(fullText: string): void;
  onError(message: string): void;
}

/**
 * Runs one input for one agent at a time. AgentManager owns queueing and state;
 * a runner only turns an input into status changes and streamed text.
 * After stop() a runner must not call any callback for the stopped run.
 */
export interface AgentRunner {
  run(input: { agentId: string; text: string }, callbacks: AgentRunCallbacks): void;
  stop(): void;
}

export type AgentRunnerFactory = (agent: { id: string; name: string }) => AgentRunner;
