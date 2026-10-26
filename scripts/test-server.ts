// Server integration tests: `npm test` (runs after scripts/test.ts).
// Starts the server in process on a random port and talks to it over real sockets.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { silentLogger } from "../server/log.ts";
import { startServer } from "../server/startServer.ts";
import { CONFIG } from "../src/shared/config.ts";
import type { ChatMessage } from "../src/shared/domain/chatTypes.ts";
import { eventPayloadSchemas, readPayload } from "../src/shared/events/eventPayloads.ts";
import type { AgentEvent } from "../src/shared/events/eventTypes.ts";
import { makeAgentId } from "../src/shared/ids.ts";
import type { AckMessage, ServerMessage, WorldSnapshot } from "../src/shared/protocol/protocol.ts";
import { parseServerMessage } from "../src/shared/protocol/schemas.ts";

const ORIGIN = CONFIG.allowedOrigins[0] ?? "http://localhost:3000";
const HELLO_TIMEOUT_MS = 300;
const UNAUTHORIZED = CONFIG.closeCodeUnauthorized;

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures++;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ✗ ${name}\n      ${message.split("\n").join("\n      ")}`);
  }
}

// Everything lives in the project (.tmp/), never in the OS temp folder, the real data folder or D:\agent-sandbox:
// a fake app folder, a folder browser root with the Sandbox in it, and a data folder.
const tmpDir = join(process.cwd(), ".tmp", `test-server-${process.pid}`);
const browseRoot = join(tmpDir, "drive");
mkdirSync(join(tmpDir, "app"), { recursive: true });
mkdirSync(browseRoot, { recursive: true });
const tokenPath = join(tmpDir, "session-token");

const server = await startServer({
  host: "127.0.0.1",
  port: 0,
  tokenPath,
  allowedOrigins: CONFIG.allowedOrigins,
  helloTimeoutMs: HELLO_TIMEOUT_MS,
  log: silentLogger,
  runner: "echo", // npm test never calls Claude
  appRoot: join(tmpDir, "app"),
  dataDir: join(tmpDir, "data"),
  folderBrowserRoot: browseRoot,
  sandboxRoot: join(browseRoot, "sandbox"),
});
const token = readFileSync(tokenPath, "utf8");
const url = `ws://127.0.0.1:${server.port}`;
const sockets = new Set<WebSocket>();

class TestClient {
  readonly messages: ServerMessage[] = [];
  closeCode: number | null = null;
  private readonly waiters = new Set<() => void>();
  private nextId = 1;
  readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const parsed = parseServerMessage(data.toString());
      if (parsed.ok) this.messages.push(parsed.value);
      this.notify();
    });
    ws.on("close", (code) => {
      this.closeCode = code;
      this.notify();
    });
  }

  static open(origin: string | null = ORIGIN): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, origin === null ? {} : { origin });
      sockets.add(ws);
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });
  }

  static async authed(): Promise<TestClient> {
    const client = await TestClient.open();
    client.send({ type: "hello", token });
    await client.waitFor((m) => (m.type === "snapshot" ? m : undefined));
    return client;
  }

  send(message: unknown) {
    this.ws.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  private notify() {
    for (const waiter of this.waiters) waiter();
  }

  /** Resolves with the first value `pick` returns for any message received so far or later. */
  waitFor<T>(pick: (m: ServerMessage) => T | undefined, timeoutMs = 5000, label = "message"): Promise<T> {
    return new Promise((resolve, reject) => {
      const scan = () => {
        for (const m of this.messages) {
          const value = pick(m);
          if (value !== undefined) {
            cleanup();
            resolve(value);
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${label}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(scan);
      };
      this.waiters.add(scan);
      scan();
    });
  }

  waitForEvent(match: (e: AgentEvent) => boolean, label: string, timeoutMs = 5000): Promise<AgentEvent> {
    return this.waitFor((m) => (m.type === "event" && match(m.event) ? m.event : undefined), timeoutMs, label);
  }

  waitClose(timeoutMs = 3000): Promise<number> {
    return new Promise((resolve, reject) => {
      const done = () => {
        if (this.closeCode === null) return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.closeCode);
      };
      const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs);
      this.waiters.add(done);
      done();
    });
  }

  async command(name: string, args: Record<string, unknown>): Promise<AckMessage> {
    const id = `c${this.nextId++}`;
    this.send({ type: "command", id, command: { name, args } });
    return this.waitFor((m) => (m.type === "ack" && m.id === id ? m : undefined), 5000, `ack ${name}`);
  }

  events(agentId?: string): AgentEvent[] {
    return this.messages.flatMap((m) =>
      m.type === "event" && (agentId === undefined || m.event.agentId === agentId) ? [m.event] : [],
    );
  }

  close() {
    this.ws.close();
  }
}

function okResult<T>(ack: AckMessage): T {
  if (!ack.ok) throw new Error(`ack failed: ${ack.error}`);
  return ack.result as T;
}

function messageOf(event: AgentEvent): ChatMessage | null {
  return readPayload(event, ["chat.message_created", "chat.message_completed"], eventPayloadSchemas.chatMessage)?.message ?? null;
}

const isStatus = (agentId: string, status: string) => (e: AgentEvent) =>
  e.type === "agent.status_changed" && e.agentId === agentId && e.metadata?.status === status;

const projectId = CONFIG.sandboxProjectId;
const engineer = makeAgentId(projectId, "engineer");
const qa = makeAgentId(projectId, "qa");
const researcher = makeAgentId(projectId, "researcher");
const reviewer = makeAgentId(projectId, "reviewer");

console.log("\nServer");

await check("1. connection with a wrong or missing Origin is rejected (403)", async () => {
  await assert.rejects(TestClient.open("http://evil.example"), /403/);
  await assert.rejects(TestClient.open(null), /403/);
});

await check("2. no hello in time: closed with 4401", async () => {
  const client = await TestClient.open();
  assert.equal(await client.waitClose(HELLO_TIMEOUT_MS + 2000), UNAUTHORIZED);
});

await check("3. wrong token: closed with 4401", async () => {
  const wrong = await TestClient.open();
  wrong.send({ type: "hello", token: "0".repeat(token.length) });
  assert.equal(await wrong.waitClose(), UNAUTHORIZED);
  const short = await TestClient.open();
  short.send({ type: "hello", token: "nope" });
  assert.equal(await short.waitClose(), UNAUTHORIZED);
});

await check("4. a command before hello: closed with 4401", async () => {
  const client = await TestClient.open();
  client.send({ type: "command", id: "c1", command: { name: "getSnapshot", args: {} } });
  assert.equal(await client.waitClose(), UNAUTHORIZED);
});

await check("5. valid hello: snapshot with 1 project and 6 agents", async () => {
  const client = await TestClient.authed();
  const snapshot = client.messages.find((m) => m.type === "snapshot");
  assert.ok(snapshot?.type === "snapshot");
  assert.equal(snapshot.snapshot.projects.length, 1);
  assert.equal(snapshot.snapshot.projects[0]?.name, "Sandbox");
  assert.equal(snapshot.snapshot.agents.length, 6);
  assert.ok(snapshot.snapshot.agents.every((a) => a.status === "idle"));
  assert.equal(snapshot.snapshot.runner, "echo");
  client.close();
});

await check("6. sendMessage to the engineer streams an echo and ends idle", async () => {
  const client = await TestClient.authed();
  const otherTab = await TestClient.authed();
  const ack = await client.command("sendMessage", { agentId: engineer, text: "hello world" });
  const userMessage = okResult<ChatMessage>(ack);
  assert.equal(userMessage.author.kind, "user");

  await client.waitForEvent(isStatus(engineer, "idle"), "engineer idle", 8000);
  const events = client.events(engineer);
  const created = events.filter((e) => e.type === "chat.message_created").map(messageOf);
  assert.ok(created.some((m) => m?.author.kind === "user" && m.text === "hello world"), "user message created");
  assert.ok(events.some(isStatus(engineer, "thinking")), "thinking");
  assert.ok(events.some(isStatus(engineer, "communicating")), "communicating");
  assert.ok(events.filter((e) => e.type === "chat.message_delta").length >= 2, "at least 2 deltas");
  const completed = events.filter((e) => e.type === "chat.message_completed").map(messageOf);
  assert.ok(completed.some((m) => m?.status === "complete" && m.text === "Echo from STD Dren: hello world"), "completed echo");

  const statuses = events.filter((e) => e.type === "agent.status_changed").map((e) => e.metadata?.status);
  assert.equal(statuses.at(-1), "idle");
  assert.equal(statuses.at(-2), "success");

  // A second tab sees the same events live.
  await otherTab.waitForEvent(
    (e) => e.type === "chat.message_completed" && messageOf(e)?.text === "Echo from STD Dren: hello world",
    "second tab completion",
  );

  const snapshot = await client.waitFor((m) =>
    m.type === "snapshot" && m.snapshot.agents.find((a) => a.id === engineer)?.status === "idle" ? m.snapshot : undefined,
  );
  const agent = snapshot.agents.find((a) => a.id === engineer);
  assert.equal(agent?.busy, false);

  const history = okResult<{ messages: ChatMessage[]; hasMore: boolean }>(
    await client.command("getChatHistory", { agentId: engineer }),
  );
  assert.deepEqual(
    history.messages.map((m) => m.author.kind),
    ["user", "agent"],
  );
  client.close();
  otherTab.close();
});

await check("7. two quick messages: the second is queued, then both run in order", async () => {
  const client = await TestClient.authed();
  const first = okResult<ChatMessage>(await client.command("sendMessage", { agentId: qa, text: "first" }));
  const second = okResult<ChatMessage>(await client.command("sendMessage", { agentId: qa, text: "second" }));
  assert.equal(first.status, "delivered");
  assert.equal(second.status, "queued");

  const queued = await client.waitForEvent(
    (e) => readPayload(e, "agent.queue_changed", eventPayloadSchemas.queueChanged)?.queuedMessageIds.includes(second.id) === true,
    "queue_changed with the second message",
  );
  assert.equal(queued.agentId, qa);

  await client.waitForEvent(
    (e) => readPayload(e, "agent.queue_changed", eventPayloadSchemas.queueChanged)?.startedMessageId === second.id,
    "second message started",
    8000,
  );
  await client.waitForEvent(
    (e) => e.type === "chat.message_completed" && messageOf(e)?.text.endsWith(": second") === true,
    "second echo",
    8000,
  );
  const echoes = client
    .events(qa)
    .filter((e) => e.type === "chat.message_completed")
    .map((e) => messageOf(e)?.text);
  assert.deepEqual(echoes, ["Echo from Quantarino Archilles: first", "Echo from Quantarino Archilles: second"]);
  await client.waitForEvent((e) => isStatus(qa, "idle")(e) && client.events(qa).filter(isStatus(qa, "idle")).length >= 2, "qa idle twice", 5000);
  client.close();
});

await check("7b. cancelQueued removes only that queued message", async () => {
  const client = await TestClient.authed();
  okResult(await client.command("sendMessage", { agentId: reviewer, text: "one" }));
  const two = okResult<ChatMessage>(await client.command("sendMessage", { agentId: reviewer, text: "two" }));
  const three = okResult<ChatMessage>(await client.command("sendMessage", { agentId: reviewer, text: "three" }));
  assert.ok((await client.command("cancelQueued", { agentId: reviewer, messageId: two.id })).ok);
  const change = await client.waitForEvent(
    (e) => readPayload(e, "agent.queue_changed", eventPayloadSchemas.queueChanged)?.cancelledMessageId === two.id,
    "cancel event",
  );
  assert.deepEqual(readPayload(change, "agent.queue_changed", eventPayloadSchemas.queueChanged)?.queuedMessageIds, [three.id]);
  assert.equal((await client.command("cancelQueued", { agentId: reviewer, messageId: two.id })).ok, false);
  okResult(await client.command("stopAgent", { agentId: reviewer }));
  okResult(await client.command("stopAgent", { agentId: reviewer }));
  client.close();
});

await check("8. stopAgent during streaming: agent.stopped, message error, agent idle", async () => {
  const client = await TestClient.authed();
  const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  okResult(await client.command("sendMessage", { agentId: researcher, text: long }));
  await client.waitForEvent((e) => e.type === "chat.message_delta" && e.agentId === researcher, "first delta", 5000);
  okResult(await client.command("stopAgent", { agentId: researcher }));

  await client.waitForEvent((e) => e.type === "agent.stopped" && e.agentId === researcher, "agent.stopped");
  const completed = await client.waitForEvent(
    (e) => e.type === "chat.message_completed" && e.agentId === researcher,
    "stopped message",
  );
  const message = messageOf(completed);
  assert.equal(message?.status, "error");
  assert.ok(message?.text.endsWith("[stopped]"), message?.text);
  await client.waitForEvent(isStatus(researcher, "idle"), "researcher idle");

  // No more deltas arrive after the stop.
  const deltasAfterStop = () =>
    client.events(researcher).filter((e) => e.type === "chat.message_delta" && e.timestamp > completed.timestamp).length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(deltasAfterStop(), 0);
  client.close();
});

await check("9. invalid JSON and an unknown command do not take the server down", async () => {
  const client = await TestClient.authed();
  client.send("{ not json");
  client.send(Buffer.from([0xff, 0x00]));
  const unknown = await client.command("rmRf", {});
  assert.equal(unknown.ok, false);
  const snapshot = okResult<WorldSnapshot>(await client.command("getSnapshot", {}));
  assert.equal(snapshot.agents.length, 6);
  assert.equal(client.closeCode, null);
  client.close();
});

await check("10. an unimplemented command (submitTask) mentions phase 5", async () => {
  const client = await TestClient.authed();
  const submit = await client.command("submitTask", { projectId, title: "x" });
  assert.ok(!submit.ok && /phase 5/.test(submit.error));
  const permission = await client.command("respondPermission", { requestId: "p", decision: "allow" });
  assert.ok(!permission.ok && /already answered/.test(permission.error), "respondPermission is implemented");
  client.close();
});

for (const socket of sockets) socket.terminate();
await server.close();
rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll server checks passed." : `\n${failures} server check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
