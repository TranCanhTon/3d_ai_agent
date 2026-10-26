// The contract the browser uses to talk to the server. Interface only; the
// WebSocket implementation comes in a later phase. Nothing here talks to Claude.

import type { AgentEvent } from "../events/eventTypes.ts";
import type { CommandArgsMap, CommandName, CommandResultMap, WorldSnapshot } from "../protocol/protocol.ts";

export type ConnectionStatus = "connecting" | "open" | "closed";

/** Commands without a result resolve to void. */
export type CommandReturn<N extends CommandName> = CommandResultMap[N] extends null ? void : CommandResultMap[N];

/** One async method per command; each resolves with the ack result or rejects with the ack error. */
export type AgentBackendCommands = {
  [N in Exclude<CommandName, "getSnapshot">]: (args: CommandArgsMap[N]) => Promise<CommandReturn<N>>;
};

export interface AgentBackend extends AgentBackendCommands {
  readonly connectionStatus: ConnectionStatus;
  /** Opens the socket and sends `hello` with the token. */
  connect(token: string): Promise<void>;
  disconnect(): Promise<void>;
  subscribeConnectionStatus(listener: (status: ConnectionStatus) => void): () => void;

  /** The getSnapshot command. Named differently because getSnapshot() is the cached read below. */
  requestSnapshot(): Promise<WorldSnapshot>;
  /** The last snapshot received, without a round trip. */
  getSnapshot(): WorldSnapshot | null;

  subscribe(listener: (event: AgentEvent) => void): () => void;
  subscribeSnapshot(listener: (snapshot: WorldSnapshot) => void): () => void;
}
