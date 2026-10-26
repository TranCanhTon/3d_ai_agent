// Local WebSocket server. Binds to loopback only, checks Origin on upgrade,
// requires a per-start token in the first message, and validates every message.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { CONFIG } from "../src/shared/config.ts";
import type { AgentEvent } from "../src/shared/events/eventTypes.ts";
import type { ServerMessage } from "../src/shared/protocol/protocol.ts";
import { parseClientMessage } from "../src/shared/protocol/schemas.ts";
import { AgentManager } from "./agents/AgentManager.ts";
import type { AgentRunnerFactory } from "./agents/AgentRunner.ts";
import { EchoRunner } from "./agents/EchoRunner.ts";
import { handleCommand } from "./commands.ts";
import { consoleLogger, type Logger } from "./log.ts";
import { World } from "./world/World.ts";

export interface ServerOptions {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  tokenPath: string;
  allowedOrigins: string[];
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
  createRunner?: AgentRunnerFactory;
  log?: Logger;
  /** Root folder of the seeded Sandbox project. */
  sandboxRoot?: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

interface Client {
  id: number;
  socket: WebSocket;
  authenticated: boolean;
  alive: boolean;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const log = options.log ?? consoleLogger;
  const helloTimeoutMs = options.helloTimeoutMs ?? CONFIG.helloTimeoutMs;
  const pingIntervalMs = options.pingIntervalMs ?? CONFIG.pingIntervalMs;
  const createRunner = options.createRunner ?? ((agent) => new EchoRunner(agent.name));

  if (!LOOPBACK_HOSTS.has(options.host)) throw new Error(`Refusing to bind to non-loopback host ${options.host}`);

  // Fresh token on every start. Written for the Next token route; never logged.
  const token = randomBytes(32).toString("hex");
  mkdirSync(dirname(options.tokenPath), { recursive: true });
  writeFileSync(options.tokenPath, token, { encoding: "utf8", mode: 0o600 });
  const tokenBuffer = Buffer.from(token, "utf8");

  const clients = new Set<Client>();
  let nextClientId = 1;

  // ── Broadcasting ──
  const send = (client: Client, message: ServerMessage) => {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(JSON.stringify(message));
  };
  const broadcast = (message: ServerMessage) => {
    const raw = JSON.stringify(message);
    for (const client of clients) {
      if (client.authenticated && client.socket.readyState === client.socket.OPEN) client.socket.send(raw);
    }
  };

  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
  let lastSnapshotAt = 0;
  const publishSnapshot = () => {
    snapshotTimer = null;
    lastSnapshotAt = Date.now();
    broadcast({ type: "snapshot", snapshot: world.snapshot() });
  };
  const scheduleSnapshot = () => {
    if (snapshotTimer !== null) return;
    const wait = Math.max(0, lastSnapshotAt + CONFIG.snapshotCoalesceMs - Date.now());
    snapshotTimer = setTimeout(publishSnapshot, wait);
  };

  const world = new World({
    onEvent: (event: AgentEvent) => broadcast({ type: "event", event }),
    onChange: scheduleSnapshot,
  });
  world.seedSandbox(options.sandboxRoot ?? process.cwd());
  const agents = new AgentManager(world, createRunner);

  // ── Connections ──
  const unauthorized = (client: Client, reason: string) => {
    log(`client #${client.id} rejected: ${reason}`);
    client.socket.close(CONFIG.closeCodeUnauthorized, "Unauthorized");
  };

  const tokenMatches = (candidate: string) => {
    const buffer = Buffer.from(candidate, "utf8");
    return buffer.length === tokenBuffer.length && timingSafeEqual(buffer, tokenBuffer);
  };

  const onMessage = (client: Client, data: RawData, isBinary: boolean) => {
    const raw = isBinary ? "" : data.toString();
    const parsed = parseClientMessage(raw);

    if (!client.authenticated) {
      if (!parsed.ok) return unauthorized(client, "invalid first message");
      if (parsed.value.type !== "hello") return unauthorized(client, "message before hello");
      if (!tokenMatches(parsed.value.token)) return unauthorized(client, "wrong token");
      client.authenticated = true;
      if (client.helloTimer !== null) clearTimeout(client.helloTimer);
      client.helloTimer = null;
      log(`client #${client.id} authenticated`);
      send(client, { type: "snapshot", snapshot: world.snapshot() });
      return;
    }

    if (!parsed.ok) {
      const id = readCommandId(raw);
      log(`client #${client.id} sent an invalid message: ${parsed.error.slice(0, 200)}`);
      if (id !== null) send(client, { type: "ack", id, ok: false, error: parsed.error });
      return;
    }
    if (parsed.value.type === "hello") return;

    const { id, command } = parsed.value;
    log(`client #${client.id} → ${command.name}${"agentId" in command.args ? ` ${command.args.agentId}` : ""}`);
    try {
      const result = handleCommand(command, { world, agents });
      send(client, { type: "ack", id, ok: true, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`client #${client.id} ✗ ${command.name}: ${message}`);
      send(client, { type: "ack", id, ok: false, error: message });
    }
  };

  const onConnection = (socket: WebSocket, request: IncomingMessage) => {
    const client: Client = { id: nextClientId++, socket, authenticated: false, alive: true, helloTimer: null };
    clients.add(client);
    log(`client #${client.id} connected from ${request.headers.origin ?? "?"}`);

    client.helloTimer = setTimeout(() => {
      client.helloTimer = null;
      if (!client.authenticated) unauthorized(client, "no hello in time");
    }, helloTimeoutMs);

    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      try {
        onMessage(client, data, isBinary);
      } catch (error) {
        log(`client #${client.id} message handler failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    socket.on("error", (error) => log(`client #${client.id} socket error: ${error.message}`));
    socket.on("close", (code) => {
      if (client.helloTimer !== null) clearTimeout(client.helloTimer);
      clients.delete(client);
      log(`client #${client.id} disconnected (${code})`);
    });
  };

  // ── HTTP + upgrade ──
  const http = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: CONFIG.maxPayloadBytes });

  http.on("upgrade", (request, socket, head) => {
    const origin = request.headers.origin;
    const reject = (reason: string) => {
      log(`upgrade rejected: ${reason}`);
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
    };
    if (origin === undefined) return reject("missing Origin");
    if (!options.allowedOrigins.includes(origin)) return reject(`origin ${origin} not allowed`);
    const hostHeader = request.headers.host ?? "";
    const hostName = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    if (!LOOPBACK_HOSTS.has(hostName)) return reject(`host ${hostHeader} not allowed`);
    wss.handleUpgrade(request, socket, head, (ws) => onConnection(ws, request));
  });

  const pingTimer = setInterval(() => {
    for (const client of clients) {
      if (!client.alive) {
        log(`client #${client.id} did not answer ping; terminating`);
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }, pingIntervalMs);

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => {
      http.off("error", reject);
      resolve();
    });
  });
  const port = (http.address() as AddressInfo).port;
  log(`server listening on ws://${options.host}:${port}`);

  let closed: Promise<void> | null = null;
  const close = () => {
    closed ??= (async () => {
      clearInterval(pingTimer);
      if (snapshotTimer !== null) clearTimeout(snapshotTimer);
      agents.dispose();
      for (const client of clients) {
        if (client.helloTimer !== null) clearTimeout(client.helloTimer);
        client.socket.close(1001, "Server shutting down");
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      for (const client of clients) client.socket.terminate();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      http.closeAllConnections();
      log("server closed");
    })();
    return closed;
  };

  return { port, close };
}

/** Best effort: the `id` of a message that failed validation, so it can still be acked. */
function readCommandId(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "id" in value) {
      const id = (value as { id: unknown }).id;
      if (typeof id === "string" && id.length > 0) return id;
    }
  } catch {
    // not JSON
  }
  return null;
}
