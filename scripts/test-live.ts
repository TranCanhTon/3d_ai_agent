// `npm run test:live` (NOT part of npm test): one real Claude call on your subscription.
// Needs a one-time `npm run claude:login`.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { isApiKeyBilling } from "../server/agents/claude/translate.ts";
import { consoleLogger } from "../server/log.ts";
import { startServer } from "../server/startServer.ts";
import { CONFIG } from "../src/shared/config.ts";
import { eventPayloadSchemas, readPayload } from "../src/shared/events/eventPayloads.ts";
import { makeAgentId } from "../src/shared/ids.ts";
import type { ServerMessage, WorldSnapshot } from "../src/shared/protocol/protocol.ts";
import { parseServerMessage } from "../src/shared/protocol/schemas.ts";

const TIMEOUT_MS = 180_000;
const PROMPT = "Reply with the single word pong. Do not use any tools.";
const agentId = makeAgentId(CONFIG.sandboxProjectId, "orchestrator");

const tmpDir = join(process.cwd(), ".tmp");
mkdirSync(tmpDir, { recursive: true });
const tokenPath = join(tmpDir, `live-session-token-${process.pid}`);

const server = await startServer({
  host: "127.0.0.1",
  port: 0,
  tokenPath,
  allowedOrigins: CONFIG.allowedOrigins,
  runner: "claude",
  log: consoleLogger,
});

const messages: ServerMessage[] = [];
let latest: WorldSnapshot | null = null;
let failed = false;

try {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { origin: CONFIG.allowedOrigins[0] });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.on("message", (data) => {
    const parsed = parseServerMessage(data.toString());
    if (!parsed.ok) return;
    messages.push(parsed.value);
    if (parsed.value.type === "snapshot") latest = parsed.value.snapshot;
  });
  ws.send(JSON.stringify({ type: "hello", token: readFileSync(tokenPath, "utf8") }));
  ws.send(JSON.stringify({ type: "command", id: "c1", command: { name: "sendMessage", args: { agentId, text: PROMPT } } }));
  console.log(`Sent to ${agentId}: "${PROMPT}"`);

  const reply = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("No reply within 3 minutes")), TIMEOUT_MS);
    const poll = setInterval(() => {
      for (const m of messages) {
        if (m.type !== "event" || m.event.agentId !== agentId) continue;
        if (m.event.type === "agent.error") {
          clearTimeout(timer);
          clearInterval(poll);
          reject(new Error(m.event.message));
          return;
        }
        const payload = readPayload(m.event, "chat.message_completed", eventPayloadSchemas.chatMessage);
        if (payload?.message.author.kind === "agent" && payload.message.status === "complete" && payload.message.usage) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve(payload.message.text);
          return;
        }
      }
    }, 100);
  });
  await new Promise((r) => setTimeout(r, 300)); // let the next snapshot arrive

  const snapshot = latest as WorldSnapshot | null;
  const agent = snapshot?.agents.find((a) => a.id === agentId);
  const auth = snapshot?.auth.source ?? null;
  console.log(`Reply: ${JSON.stringify(reply)}`);
  console.log(`Session: ${agent?.claudeSessionId ?? "none"}, auth source: ${auth}`);

  assert.ok(agent?.claudeSessionId, "a session id arrives");
  assert.match(reply, /pong/i, "the reply contains pong");
  assert.ok(auth !== null, "auth source reported");
  assert.ok(!isApiKeyBilling(auth), `auth source is not an API key (${auth})`);
  console.log("\n✓ live test passed");
  ws.close();
} catch (error) {
  failed = true;
  console.log(`\n✗ live test failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await server.close();
  rmSync(tokenPath, { force: true });
}
process.exit(failed ? 1 : 0);
