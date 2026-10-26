// Browser implementation of AgentBackend over the local WebSocket server.

import type { AgentBackend, CommandReturn, ConnectionStatus } from "@/shared/backend/AgentBackend.ts";
import { CONFIG } from "@/shared/config.ts";
import type { AgentEvent } from "@/shared/events/eventTypes.ts";
import type {
  ClientCommand,
  CommandArgsMap,
  CommandName,
  CommandResultMap,
  WorldSnapshot,
} from "@/shared/protocol/protocol.ts";
import { parseCommandResult, parseServerMessage } from "@/shared/protocol/schemas.ts";

interface PendingCommand {
  name: CommandName;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface WebSocketAgentBackendOptions {
  url?: string;
  /** Used for every reconnect: the server makes a new token each time it starts. */
  getToken: () => Promise<string>;
}

export const DEFAULT_WS_URL = `ws://${CONFIG.serverHost}:${CONFIG.serverPort}`;

/** Reads the session token from the Next route (same origin). */
export async function fetchSessionToken(): Promise<string> {
  const response = await fetch("/api/session-token", { cache: "no-store" });
  if (!response.ok) throw new Error(`Session token unavailable (${response.status})`);
  const body: unknown = await response.json();
  if (typeof body === "object" && body !== null && "token" in body && typeof body.token === "string") return body.token;
  throw new Error("Malformed session token response");
}

export class WebSocketAgentBackend implements AgentBackend {
  connectionStatus: ConnectionStatus = "closed";

  private readonly url: string;
  private readonly getToken: () => Promise<string>;
  private socket: WebSocket | null = null;
  private snapshot: WorldSnapshot | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly eventListeners = new Set<(event: AgentEvent) => void>();
  private readonly snapshotListeners = new Set<(snapshot: WorldSnapshot) => void>();
  private readonly statusListeners = new Set<(status: ConnectionStatus) => void>();

  /** True between connect and disconnect: closes trigger reconnects. */
  private wanted = false;
  /** Bumped on every open/disconnect so handlers of old sockets are ignored. */
  private generation = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WebSocketAgentBackendOptions) {
    this.url = options.url ?? DEFAULT_WS_URL;
    this.getToken = options.getToken;
  }

  // ── Connection ──

  connect(token: string): Promise<void> {
    this.wanted = true;
    this.clearReconnect();
    return this.open(token);
  }

  /** Fetches a token and connects, retrying with backoff until disconnect(). */
  connectAuto(): void {
    this.wanted = true;
    this.clearReconnect();
    void this.attemptReconnect();
  }

  async disconnect(): Promise<void> {
    this.wanted = false;
    this.generation++;
    this.clearReconnect();
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "Client disconnect");
    this.rejectAllPending("Disconnected");
    this.setStatus("closed");
  }

  subscribeConnectionStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private open(token: string): Promise<void> {
    const generation = ++this.generation;
    const previous = this.socket;
    this.socket = null;
    previous?.close(1000, "Reconnecting");
    this.setStatus("connecting");

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new WebSocket(this.url);
      this.socket = socket;
      const current = () => generation === this.generation;

      socket.onopen = () => {
        if (current()) socket.send(JSON.stringify({ type: "hello", token }));
      };
      socket.onmessage = (event: MessageEvent) => {
        if (!current()) return;
        this.onMessage(event.data);
        if (!settled && this.connectionStatus === "open") {
          settled = true;
          resolve();
        }
      };
      socket.onclose = (event: CloseEvent) => {
        if (!current()) return;
        this.socket = null;
        this.rejectAllPending("Connection closed");
        this.setStatus("closed");
        if (!settled) {
          settled = true;
          reject(new Error(`Connection closed (${event.code})`));
        }
        this.scheduleReconnect();
      };
    });
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.reconnectTimer !== null) return;
    const steps = CONFIG.reconnectBackoffMs;
    const delay = steps[Math.min(this.attempt, steps.length - 1)] ?? 5000;
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  private async attemptReconnect(): Promise<void> {
    let token: string;
    try {
      token = await this.getToken();
    } catch {
      this.scheduleReconnect();
      return;
    }
    if (!this.wanted) return;
    // A failed open closes the socket, and onclose schedules the next attempt.
    this.open(token).catch(() => {});
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private setStatus(status: ConnectionStatus): void {
    if (status === this.connectionStatus) return;
    this.connectionStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  // ── Messages ──

  private onMessage(data: unknown): void {
    if (typeof data !== "string") {
      console.warn("[backend] dropped non-text message");
      return;
    }
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      console.warn(`[backend] dropped invalid server message: ${parsed.error}`);
      return;
    }
    const message = parsed.value;
    switch (message.type) {
      case "snapshot":
        this.snapshot = message.snapshot;
        if (this.connectionStatus !== "open") {
          this.attempt = 0;
          this.setStatus("open");
        }
        for (const listener of this.snapshotListeners) listener(message.snapshot);
        break;
      case "event":
        for (const listener of this.eventListeners) listener(message.event);
        break;
      case "ack": {
        const pending = this.pending.get(message.id);
        if (pending === undefined) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (!message.ok) {
          pending.reject(new Error(message.error));
          return;
        }
        const result = parseCommandResult(pending.name, message.result);
        if (result.ok) pending.resolve(result.value);
        else pending.reject(new Error(`Invalid ${pending.name} result: ${result.error}`));
        break;
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private send<N extends CommandName>(name: N, args: CommandArgsMap[N]): Promise<CommandResultMap[N]> {
    const socket = this.socket;
    if (socket === null || this.connectionStatus !== "open") return Promise.reject(new Error("Not connected"));
    const id = crypto.randomUUID();
    const command = { name, args } as ClientCommand;
    return new Promise<CommandResultMap[N]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${name} timed out`));
      }, CONFIG.commandTimeoutMs);
      this.pending.set(id, { name, resolve: (value) => resolve(value as CommandResultMap[N]), reject, timer });
      socket.send(JSON.stringify({ type: "command", id, command }));
    });
  }

  private async run<N extends CommandName>(name: N, args: CommandArgsMap[N]): Promise<CommandReturn<N>> {
    const result = await this.send(name, args);
    return (result === null ? undefined : result) as CommandReturn<N>;
  }

  // ── Commands ──

  listFolders(args: CommandArgsMap["listFolders"]) {
    return this.run("listFolders", args);
  }
  createProject(args: CommandArgsMap["createProject"]) {
    return this.run("createProject", args);
  }
  archiveProject(args: CommandArgsMap["archiveProject"]) {
    return this.run("archiveProject", args);
  }
  sendMessage(args: CommandArgsMap["sendMessage"]) {
    return this.run("sendMessage", args);
  }
  cancelQueued(args: CommandArgsMap["cancelQueued"]) {
    return this.run("cancelQueued", args);
  }
  stopAgent(args: CommandArgsMap["stopAgent"]) {
    return this.run("stopAgent", args);
  }
  resetAgentSession(args: CommandArgsMap["resetAgentSession"]) {
    return this.run("resetAgentSession", args);
  }
  submitTask(args: CommandArgsMap["submitTask"]) {
    return this.run("submitTask", args);
  }
  cancelTask(args: CommandArgsMap["cancelTask"]) {
    return this.run("cancelTask", args);
  }
  resumeTask(args: CommandArgsMap["resumeTask"]) {
    return this.run("resumeTask", args);
  }
  respondPermission(args: CommandArgsMap["respondPermission"]) {
    return this.run("respondPermission", args);
  }
  pinToNotes(args: CommandArgsMap["pinToNotes"]) {
    return this.run("pinToNotes", args);
  }
  getChatHistory(args: CommandArgsMap["getChatHistory"]) {
    return this.run("getChatHistory", args);
  }
  requestSnapshot() {
    return this.run("getSnapshot", {});
  }

  // ── State ──

  getSnapshot(): WorldSnapshot | null {
    return this.snapshot;
  }

  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeSnapshot(listener: (snapshot: WorldSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
}
