// Projects, folder rules, notes and persistence (tsx): `npm test`. Never calls Claude.
// Folder rules run against a temp folder tree; the rest talks to real servers over
// sockets, with a scripted fake runner, restarting them on the same data folder.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import type { AgentRunner, AgentRunCallbacks, AgentRunInput } from "../server/agents/AgentRunner.ts";
import { silentLogger } from "../server/log.ts";
import { checkProjectFolder, listFolders, realPath, type FolderRules } from "../server/projects/folders.ts";
import { cleanNoteText, ensureGitignoreEntry, NOTES_HEADER } from "../server/projects/notes.ts";
import { startServer, type RunningServer } from "../server/startServer.ts";
import { CONFIG } from "../src/shared/config.ts";
import type { AgentState } from "../src/shared/domain/agentTypes.ts";
import type { Chat, ChatMessage } from "../src/shared/domain/chatTypes.ts";
import type { Project } from "../src/shared/domain/projectTypes.ts";
import { AGENT_ROLES } from "../src/shared/domain/roles.ts";
import { eventPayloadSchemas, readPayload } from "../src/shared/events/eventPayloads.ts";
import type { AgentEvent } from "../src/shared/events/eventTypes.ts";
import { makeAgentId } from "../src/shared/ids.ts";
import type { AckMessage, FolderListing, ServerMessage, WorldSnapshot } from "../src/shared/protocol/protocol.ts";
import { parseServerMessage } from "../src/shared/protocol/schemas.ts";

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

// ── Temp folder tree ────────────────────────────────────────────────────────
//   <tmp>/drive            the folder browser root ("D:\")
//   <tmp>/drive/app        this app's folder (blocked)
//   <tmp>/drive/sandbox    the Sandbox, created on first start
//   <tmp>/outside          outside the root
//   <tmp>/data             the server's data folder

const tmpDir = join(process.cwd(), ".tmp", `test-projects-${process.pid}`);
const drive = join(tmpDir, "drive");
const appDir = join(drive, "app");
const outside = join(tmpDir, "outside");
const dataDir = join(tmpDir, "data");
for (const dir of [appDir, outside, join(drive, "work", "shop"), join(drive, "work", "blog", ".git")]) {
  mkdirSync(dir, { recursive: true });
}
for (const hidden of [".hidden", "$RECYCLE.BIN", "System Volume Information"]) mkdirSync(join(drive, hidden), { recursive: true });
writeFileSync(join(drive, "file.txt"), "not a folder");

const real = (path: string) => realPath(path) ?? path;

function rules(projects: FolderRules["projects"] = []): FolderRules {
  return { root: real(drive), blockedRoots: [real(appDir)], projects };
}

function refused(path: string, r: FolderRules, pattern: RegExp) {
  const result = checkProjectFolder(path, r);
  assert.equal(result.ok, false, `${path} should be refused`);
  if (!result.ok) assert.match(result.reason, pattern);
}

console.log("\nFolder rules");

await check("a folder inside the root is accepted (real path returned)", () => {
  const result = checkProjectFolder(join(drive, "work", "shop"), rules());
  assert.ok(result.ok);
  assert.equal(result.path, real(join(drive, "work", "shop")));
});

await check("the root itself (drive root) is refused", () => refused(drive, rules(), /drive root/));
await check("this app's folder, a folder inside it and a parent of it are refused", () => {
  mkdirSync(join(appDir, "src"), { recursive: true });
  refused(appDir, rules(), /own folder/);
  refused(join(appDir, "src"), rules(), /Inside AI Agent World's own folder/);
  const parentRules = { ...rules(), blockedRoots: [real(join(drive, "work", "shop"))] };
  refused(join(drive, "work"), parentRules, /Contains AI Agent World's own folder/);
});
await check("outside the root, a `..` escape and a missing folder are refused", () => {
  refused(outside, rules(), /Outside the folder browser root/);
  refused(join(drive, "work", "..", "..", "outside"), rules(), /Outside the folder browser root/);
  refused(join(drive, "nope"), rules(), /does not exist/);
  refused(join(drive, "file.txt"), rules(), /Not a folder/);
});
await check("a junction that points outside the root is refused and not listed", () => {
  const link = join(drive, "escape");
  symlinkSync(outside, link, "junction");
  refused(link, rules(), /Outside the folder browser root/);
  assert.ok(!listFolders(undefined, rules()).entries.some((e) => e.name === "escape"));
  rmSync(link, { force: true, recursive: false });
});
await check("a folder already used, nested in a used one, or containing one is refused", () => {
  const used = rules([{ name: "Shop", rootPath: join(drive, "work", "shop") }]);
  refused(join(drive, "work", "shop"), used, /Already used by project "Shop"/);
  mkdirSync(join(drive, "work", "shop", "web"), { recursive: true });
  refused(join(drive, "work", "shop", "web"), used, /Inside the folder of project "Shop"/);
  refused(join(drive, "work"), used, /Contains the folder of project "Shop"/);
});
await check("listFolders: hides hidden and system folders, marks git, used and blocked, parent null at root", () => {
  const used = rules([{ name: "Shop", rootPath: join(drive, "work", "shop") }]);
  const top = listFolders(undefined, used);
  assert.equal(top.parent, null);
  assert.deepEqual(
    top.entries.map((e) => e.name),
    ["app", "work"],
  );
  assert.match(top.entries.find((e) => e.name === "app")?.blocked ?? "", /own folder/);
  const work = listFolders(join(drive, "work"), used);
  assert.equal(work.parent, real(drive));
  const blog = work.entries.find((e) => e.name === "blog");
  const shop = work.entries.find((e) => e.name === "shop");
  assert.equal(blog?.isGitRepo, true);
  assert.equal(blog?.blocked, null);
  assert.equal(shop?.hasProject, true);
  assert.match(shop?.blocked ?? "", /Already used/);
  assert.throws(() => listFolders(outside, used), /Outside the folder browser root/);
  assert.throws(() => listFolders(join(drive, "..", "outside"), used), /Outside the folder browser root/);
});

console.log("\nNotes helpers");

await check(".gitignore gets .agentworld/ exactly once, keeping what was there", () => {
  const dir = join(tmpDir, "gitignore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "node_modules/");
  assert.equal(ensureGitignoreEntry(dir), true);
  assert.equal(ensureGitignoreEntry(dir), false);
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "node_modules/\n.agentworld/\n");
});
await check("note text: trimmed to one line, capped at noteMaxChars, empty rejected", () => {
  assert.equal(cleanNoteText("  we use\nTailwind  "), "we use Tailwind");
  assert.equal(cleanNoteText("x".repeat(CONFIG.noteMaxChars + 50)).length, CONFIG.noteMaxChars);
  assert.throws(() => cleanNoteText(" \n "), /empty/);
});

// ── Server with a scripted runner ───────────────────────────────────────────

/** Every run input the fake runner received, in order. */
const runs: AgentRunInput[] = [];
let sessionCounter = 0;

/**
 * "hold ..."     streams one chunk and never finishes (until stopped)
 * "note: <text>" calls the add_note tool and replies with its result
 * anything else  replies "ok: <text>", reusing or creating a session id
 */
class ScriptedRunner implements AgentRunner {
  private timers: ReturnType<typeof setTimeout>[] = [];

  run(input: AgentRunInput, callbacks: AgentRunCallbacks): void {
    this.stop();
    runs.push(input);
    const later = (ms: number, fn: () => void) => this.timers.push(setTimeout(fn, ms));
    later(5, () => {
      callbacks.onSession(input.sessionId ?? `sess_${++sessionCounter}`);
      if (input.text.startsWith("hold")) {
        callbacks.onDelta("partial");
        return;
      }
      if (input.text.startsWith("note:")) {
        callbacks.onTool({ phase: "started", toolUseId: "t1", toolName: "add_note", summary: "Pinned a note" });
        let reply: string;
        try {
          reply = callbacks.addNote(input.text.slice("note:".length));
        } catch (error) {
          reply = error instanceof Error ? error.message : String(error);
        }
        callbacks.onTool({ phase: "finished", toolUseId: "t1", toolName: "add_note", ok: true });
        later(5, () => callbacks.onComplete(reply));
        return;
      }
      callbacks.onDelta(`ok: ${input.text}`);
      callbacks.onUsage({ inputTokens: 1000 + input.text.length, outputTokens: 10 });
      later(5, () => callbacks.onComplete(`ok: ${input.text}`));
    });
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
}

const ORIGIN = CONFIG.allowedOrigins[0] ?? "http://localhost:3000";

async function boot(): Promise<{ server: RunningServer; client: Client }> {
  const tokenPath = join(tmpDir, "session-token");
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    tokenPath,
    allowedOrigins: CONFIG.allowedOrigins,
    log: silentLogger,
    runner: "echo",
    createRunner: () => new ScriptedRunner(),
    appRoot: appDir,
    dataDir,
    folderBrowserRoot: drive,
    sandboxRoot: join(drive, "sandbox"),
  });
  const client = await Client.open(server.port, readFileSync(tokenPath, "utf8"));
  return { server, client };
}

class Client {
  readonly messages: ServerMessage[] = [];
  private readonly waiters = new Set<() => void>();
  private nextId = 1;
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const parsed = parseServerMessage(data.toString());
      if (parsed.ok) this.messages.push(parsed.value);
      for (const waiter of this.waiters) waiter();
    });
  }

  static async open(port: number, token: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: ORIGIN });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const client = new Client(ws);
    ws.send(JSON.stringify({ type: "hello", token }));
    await client.waitFor((m) => (m.type === "snapshot" ? m : undefined), "snapshot");
    return client;
  }

  waitFor<T>(pick: (m: ServerMessage) => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
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

  waitForEvent(match: (e: AgentEvent) => boolean, label: string): Promise<AgentEvent> {
    return this.waitFor((m) => (m.type === "event" && match(m.event) ? m.event : undefined), label);
  }

  /** Waits for the agent's first streamed text after `messageId` (my message) was created. */
  async waitStreaming(agentId: string, messageId: string): Promise<void> {
    const sent = this.messages.findIndex((m) => m.type === "ack" && m.ok && (m.result as { id?: string } | undefined)?.id === messageId);
    await this.waitFor(
      (m) => (m.type === "event" && m.event.type === "chat.message_delta" && m.event.agentId === agentId && this.messages.indexOf(m) > sent ? m : undefined),
      `${agentId} streaming`,
    );
  }

  async command(name: string, args: Record<string, unknown>): Promise<AckMessage> {
    const id = `c${this.nextId++}`;
    this.ws.send(JSON.stringify({ type: "command", id, command: { name, args } }));
    return this.waitFor((m) => (m.type === "ack" && m.id === id ? m : undefined), `ack ${name}`);
  }

  async ok<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const ack = await this.command(name, args);
    if (!ack.ok) throw new Error(`${name} failed: ${ack.error}`);
    return ack.result as T;
  }

  async error(name: string, args: Record<string, unknown>): Promise<string> {
    const ack = await this.command(name, args);
    if (ack.ok) throw new Error(`${name} should have failed`);
    return ack.error;
  }

  snapshot(): Promise<WorldSnapshot> {
    return this.ok<WorldSnapshot>("getSnapshot", {});
  }

  async agent(agentId: string): Promise<AgentState> {
    const agent = (await this.snapshot()).agents.find((a) => a.id === agentId);
    if (agent === undefined) throw new Error(`no agent ${agentId}`);
    return agent;
  }

  async history(agentId: string, chatId?: string): Promise<ChatMessage[]> {
    return (await this.ok<{ messages: ChatMessage[] }>("getChatHistory", { agentId, ...(chatId === undefined ? {} : { chatId }) })).messages;
  }

  chats(agentId: string): Promise<Chat[]> {
    return this.ok<Chat[]>("listChats", { agentId });
  }

  /** The Claude session of the agent's active chat. */
  async session(agentId: string): Promise<string | null> {
    const agent = await this.agent(agentId);
    return (await this.chats(agentId)).find((c) => c.id === agent.activeChatId)?.claudeSessionId ?? null;
  }

  /** Waits until the agent's reply to `text` is complete and the agent is idle again. */
  async waitReplied(agentId: string, text: string): Promise<void> {
    // A streamed reply completes later; a reply without streaming is created complete.
    await this.waitForEvent((e) => {
      if (e.agentId !== agentId) return false;
      const message = readPayload(e, ["chat.message_created", "chat.message_completed"], eventPayloadSchemas.chatMessage)?.message;
      return message?.author.kind === "agent" && message.status === "complete" && message.text === text;
    }, `reply "${text}"`);
    await this.waitIdle(agentId);
  }

  async waitIdle(agentId: string): Promise<void> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const agent = await this.agent(agentId);
      if (!agent.busy && agent.status === "idle") return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${agentId} did not go idle`);
  }

  close() {
    this.ws.terminate();
  }
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

console.log("\nProjects");

let { server, client } = await boot();
const sandboxDir = real(join(drive, "sandbox"));
const shopDir = join(drive, "work", "shop");
let shop: Project | null = null;

await check("first start: the Sandbox is a saved project with notes, .gitignore and git", async () => {
  const snapshot = await client.snapshot();
  assert.equal(snapshot.projects.length, 1);
  assert.equal(snapshot.projects[0]?.id, CONFIG.sandboxProjectId);
  assert.equal(snapshot.projects[0]?.rootPath, sandboxDir);
  assert.ok(readFileSync(join(sandboxDir, ".agentworld", "notes.md"), "utf8").startsWith(NOTES_HEADER));
  assert.match(readFileSync(join(sandboxDir, ".gitignore"), "utf8"), /^\.agentworld\/$/m);
  assert.ok(existsSync(join(sandboxDir, ".git")));
  assert.ok(existsSync(join(dataDir, "projects.json")));
});

await check("createProject without git init: notes, .gitignore line once, 6 idle agents, no .git", async () => {
  writeFileSync(join(shopDir, ".gitignore"), "dist/\n.agentworld/\n");
  shop = await client.ok<Project>("createProject", { name: "Shop", rootPath: shopDir, initGit: false });
  assert.equal(shop.isGitRepo, false);
  assert.ok(!existsSync(join(shopDir, ".git")), "no git init when not asked");
  assert.equal(readFileSync(join(shopDir, ".agentworld", "notes.md"), "utf8"), `${NOTES_HEADER}\n\n`);
  assert.equal(readFileSync(join(shopDir, ".gitignore"), "utf8"), "dist/\n.agentworld/\n");
  const agents = (await client.snapshot()).agents.filter((a) => a.projectId === shop?.id);
  assert.deepEqual(
    agents.map((a) => a.role),
    [...AGENT_ROLES],
  );
  assert.ok(agents.every((a) => a.status === "idle" && !a.chatOnly && a.activeChatId !== ""));
  const chats = await client.chats(makeAgentId(shop?.id ?? "", "qa"));
  assert.equal(chats.length, 1, "every agent starts with one empty chat");
  assert.deepEqual([chats[0]?.title, chats[0]?.messageCount, chats[0]?.claudeSessionId], ["", 0, null]);
  await client.waitForEvent((e) => e.type === "project.created" && e.projectId === shop?.id, "project.created");
});

await check("createProject with git init on a non-git folder runs git init", async () => {
  const dir = join(drive, "fresh");
  mkdirSync(dir);
  const project = await client.ok<Project>("createProject", { name: "Fresh", rootPath: dir, initGit: true });
  assert.equal(project.isGitRepo, true);
  assert.ok(existsSync(join(dir, ".git")));
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ".agentworld/\n");
});

await check("createProject refuses the root, this app, a used folder, a bad name; listFolders marks them", async () => {
  assert.match(await client.error("createProject", { name: "Root", rootPath: drive }), /drive root/);
  assert.match(await client.error("createProject", { name: "App", rootPath: appDir }), /own folder/);
  assert.match(await client.error("createProject", { name: "Again", rootPath: sandboxDir }), /Already used by project "Sandbox"/);
  assert.match(await client.error("createProject", { name: "Inner", rootPath: join(shopDir, "web") }), /Inside the folder of project "Shop"/);
  assert.match(await client.error("createProject", { name: " ", rootPath: join(drive, "work", "blog") }), /name/);
  const listing = await client.ok<FolderListing>("listFolders", {});
  assert.equal(listing.path, real(drive));
  assert.equal(listing.entries.find((e) => e.name === "sandbox")?.hasProject, true);
  assert.match(await client.error("listFolders", { path: outside }), /Outside/);
});

const shopId = () => {
  if (shop === null) throw new Error("no shop project");
  return shop.id;
};
const shopAgent = (role: (typeof AGENT_ROLES)[number]) => makeAgentId(shopId(), role);

console.log("\nNotes, sessions and chat only");

await check("add_note: appends with the agent's name and date, caps length, rejects empty, emits notes.updated", async () => {
  const engineer = shopAgent("engineer");
  await client.ok("sendMessage", { agentId: engineer, text: "note:  We always use Tailwind  " });
  const line = `- We always use Tailwind (STD Dren, ${today()})`;
  await client.waitReplied(engineer, line);
  const event = await client.waitForEvent((e) => e.type === "notes.updated" && e.projectId === shopId(), "notes.updated");
  assert.equal(readPayload(event, "notes.updated", eventPayloadSchemas.notesUpdated)?.line, line);
  assert.ok((await client.ok<string>("getNotes", { projectId: shopId() })).includes(line));

  await client.ok("sendMessage", { agentId: engineer, text: `note:${"y".repeat(CONFIG.noteMaxChars + 40)}` });
  await client.waitReplied(engineer, `- ${"y".repeat(CONFIG.noteMaxChars)} (STD Dren, ${today()})`);
  await client.ok("sendMessage", { agentId: engineer, text: "note:   " });
  await client.waitReplied(engineer, "A note cannot be empty");
  const notes = await client.ok<string>("getNotes", { projectId: shopId() });
  assert.equal(notes.split("\n").filter((l) => l.startsWith("- ")).length, 2);
  assert.equal((await client.agent(engineer)).location, "dev", "back at its home station after pinning");
});

await check("pinToNotes: my edited text is appended and the message is marked pinned", async () => {
  const qa = shopAgent("qa");
  const mine = await client.ok<ChatMessage>("sendMessage", { agentId: qa, text: "Please check the cart page on mobile" });
  await client.waitReplied(qa, "ok: Please check the cart page on mobile");
  await client.ok("pinToNotes", { messageId: mine.id, text: "Check the cart page on mobile" });
  const notes = await client.ok<string>("getNotes", { projectId: shopId() });
  assert.ok(notes.includes(`- Check the cart page on mobile (pinned by you, ${today()})`), notes);
  assert.equal((await client.history(qa)).find((m) => m.id === mine.id)?.pinned, true);
  assert.match(await client.error("pinToNotes", { messageId: "msg_nope", text: "x" }), /Unknown message/);
});

let firstResearcherChat = "";

await check("chats: my first message is the title; the reply counts and sets the session and context size", async () => {
  const researcher = shopAgent("researcher");
  await client.ok("sendMessage", { agentId: researcher, text: "  What   does the cart do?\nAnd the checkout?" });
  await client.waitReplied(researcher, "ok:   What   does the cart do?\nAnd the checkout?");
  const [chat] = await client.chats(researcher);
  assert.ok(chat !== undefined);
  firstResearcherChat = chat.id;
  assert.equal(chat.title, "What does the cart do? And the checkout?");
  assert.equal(chat.messageCount, 2);
  assert.notEqual(chat.claudeSessionId, null);
  assert.equal(chat.contextTokens, 1000 + "  What   does the cart do?\nAnd the checkout?".length);
  assert.ok((await client.history(researcher)).every((m) => m.chatId === chat.id));
});

await check("newChat: a fresh session, its own history; an empty active chat is reused", async () => {
  const researcher = shopAgent("researcher");
  const second = await client.ok<Chat>("newChat", { agentId: researcher });
  assert.notEqual(second.id, firstResearcherChat);
  assert.equal((await client.agent(researcher)).activeChatId, second.id);
  const started = await client.waitForEvent((e) => e.type === "chat.started" && e.agentId === researcher, "chat.started");
  assert.equal(started.feed, true);
  assert.equal((await client.ok<Chat>("newChat", { agentId: researcher })).id, second.id, "still empty: no second empty chat");
  await client.ok("sendMessage", { agentId: researcher, text: "fresh topic" });
  await client.waitReplied(researcher, "ok: fresh topic");
  assert.equal(runs.at(-1)?.sessionId, null, "a new chat starts a new Claude session");
  assert.deepEqual((await client.history(researcher)).map((m) => m.text), ["fresh topic", "ok: fresh topic"]);
  assert.equal((await client.history(researcher, firstResearcherChat)).length, 2, "the first chat keeps its messages");
  assert.deepEqual((await client.chats(researcher)).map((c) => c.id), [second.id, firstResearcherChat], "newest first");
});

await check("openChat: an earlier chat resumes its own session; sendMessage to a chat makes it active", async () => {
  const researcher = shopAgent("researcher");
  const first = (await client.chats(researcher)).find((c) => c.id === firstResearcherChat);
  await client.ok("openChat", { agentId: researcher, chatId: firstResearcherChat });
  assert.equal((await client.agent(researcher)).activeChatId, firstResearcherChat);
  await client.ok("sendMessage", { agentId: researcher, text: "back to the cart" });
  await client.waitReplied(researcher, "ok: back to the cart");
  assert.equal(runs.at(-1)?.sessionId, first?.claudeSessionId);
  const [newest, older] = await client.chats(researcher);
  assert.equal(newest?.id, firstResearcherChat, "the chat with the latest message comes first");
  await client.ok("sendMessage", { agentId: researcher, text: "and this one", chatId: older?.id });
  await client.waitReplied(researcher, "ok: and this one");
  assert.equal((await client.agent(researcher)).activeChatId, older?.id);
  assert.match(await client.error("openChat", { agentId: shopAgent("qa"), chatId: firstResearcherChat }), /is not/);
  assert.match(await client.error("openChat", { agentId: researcher, chatId: "chat_nope" }), /Unknown chat/);
});

await check("newChat while busy: the running reply stays in its own chat", async () => {
  const researcher = shopAgent("researcher");
  const before = (await client.agent(researcher)).activeChatId;
  const held = await client.ok<ChatMessage>("sendMessage", { agentId: researcher, text: "hold on" });
  await client.waitStreaming(researcher, held.id);
  const next = await client.ok<Chat>("newChat", { agentId: researcher });
  await client.ok("stopAgent", { agentId: researcher });
  await client.waitIdle(researcher);
  assert.equal((await client.history(researcher, next.id)).length, 0);
  assert.ok((await client.history(researcher, before)).some((m) => m.text === "partial [stopped]"));
});

await check("setChatOnly is saved on the agent and passed to the next run", async () => {
  const pm = shopAgent("product_manager");
  await client.ok("setChatOnly", { agentId: pm, chatOnly: true });
  assert.equal((await client.agent(pm)).chatOnly, true);
  await client.ok("sendMessage", { agentId: pm, text: "plan it" });
  await client.waitReplied(pm, "ok: plan it");
  assert.equal(runs.at(-1)?.chatOnly, true);
});

await check("setAgentModel: role defaults, saved on the agent, passed to the next run, bad values refused", async () => {
  const engineerId = shopAgent("engineer");
  const before = await client.agent(engineerId);
  assert.deepEqual([before.model, before.effort], ["opus", "high"], "the engineer's role default");
  assert.deepEqual([(await client.agent(shopAgent("researcher"))).model, (await client.agent(shopAgent("researcher"))).effort], ["sonnet", "medium"]);
  await client.ok("setAgentModel", { agentId: engineerId, model: "haiku", effort: null });
  const changed = await client.waitForEvent((e) => e.type === "agent.settings_changed" && e.agentId === engineerId, "settings_changed");
  assert.equal(changed.message, "STD Dren: haiku · default");
  assert.equal(changed.feed, true);
  assert.deepEqual([(await client.agent(engineerId)).model, (await client.agent(engineerId)).effort], ["haiku", null]);
  await client.ok("sendMessage", { agentId: engineerId, text: "which model?" });
  await client.waitReplied(engineerId, "ok: which model?");
  assert.deepEqual([runs.at(-1)?.model, runs.at(-1)?.effort], ["haiku", null]);
  assert.match(await client.error("setAgentModel", { agentId: engineerId, model: "gpt-4", effort: "high" }), /Unknown model/);
  assert.match(await client.error("setAgentModel", { agentId: engineerId, model: "opus", effort: "ultra" }), /effort/);
  assert.match(await client.error("setAgentModel", { agentId: "proj_nope:qa", model: "opus", effort: "high" }), /Unknown agent/);
});

await check("setAgentModel while busy: the running input keeps its model, the next one gets the new one", async () => {
  const qa = shopAgent("qa");
  const held = await client.ok<ChatMessage>("sendMessage", { agentId: qa, text: "hold the line" });
  await client.waitStreaming(qa, held.id);
  assert.deepEqual([runs.at(-1)?.model, runs.at(-1)?.effort], ["sonnet", "medium"]);
  await client.ok("setAgentModel", { agentId: qa, model: "opus", effort: "max" });
  await client.ok("stopAgent", { agentId: qa });
  await client.waitIdle(qa);
  await client.ok("sendMessage", { agentId: qa, text: "now" });
  await client.waitReplied(qa, "ok: now");
  assert.deepEqual([runs.at(-1)?.model, runs.at(-1)?.effort], ["opus", "max"]);
});

await check("archive: agents refuse messages, the project stays listed; restore brings them back", async () => {
  const fresh = (await client.snapshot()).projects.find((p) => p.name === "Fresh");
  assert.ok(fresh !== undefined);
  const orchestrator = makeAgentId(fresh.id, "orchestrator");
  await client.ok("archiveProject", { projectId: fresh.id });
  assert.equal((await client.snapshot()).projects.find((p) => p.id === fresh.id)?.archived, true);
  assert.match(await client.error("sendMessage", { agentId: orchestrator, text: "hi" }), /archived/);
  assert.match(await client.error("archiveProject", { projectId: fresh.id }), /already archived/);
  assert.match(await client.error("createProject", { name: "Again", rootPath: join(drive, "fresh") }), /Already used/);
  await client.ok("restoreProject", { projectId: fresh.id });
  assert.equal((await client.snapshot()).projects.find((p) => p.id === fresh.id)?.archived, false);
  await client.ok("sendMessage", { agentId: orchestrator, text: "back" });
  await client.waitReplied(orchestrator, "ok: back");
});

console.log("\nPersistence");

// Before the restart: one agent mid-reply with two messages queued behind it.
const reviewer = () => shopAgent("reviewer");
let interruptedId = "";
let queuedIds: string[] = [];
const sessionsBefore = new Map<string, string | null>();
const chatsBefore = new Map<string, Chat[]>();

await check("before restart: a streaming reply with two queued messages", async () => {
  const first = await client.ok<ChatMessage>("sendMessage", { agentId: reviewer(), text: "hold this" });
  interruptedId = first.id;
  await client.waitStreaming(reviewer(), first.id);
  const a = await client.ok<ChatMessage>("sendMessage", { agentId: reviewer(), text: "queued one" });
  const b = await client.ok<ChatMessage>("sendMessage", { agentId: reviewer(), text: "queued two" });
  queuedIds = [a.id, b.id];
  assert.equal((await client.agent(reviewer())).queuedCount, 2);
  for (const agent of (await client.snapshot()).agents) {
    sessionsBefore.set(agent.id, await client.session(agent.id));
    chatsBefore.set(agent.id, await client.chats(agent.id));
  }
});

client.close();
await server.close();
runs.length = 0;
// The Fresh project's agents file as an older version saved it: no model or effort.
const freshFile = () => {
  const projects = JSON.parse(readFileSync(join(dataDir, "projects.json"), "utf8")) as Project[];
  const fresh = projects.find((p) => p.name === "Fresh");
  assert.ok(fresh !== undefined);
  return { id: fresh.id, path: join(dataDir, "agents", `${fresh.id}.json`) };
};
{
  const { path } = freshFile();
  const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
  // ...and from before chats: one session on the agent, messages without a chatId.
  for (const agent of saved) {
    delete agent.model;
    delete agent.effort;
    delete agent.chats;
    delete agent.activeChatId;
    agent.claudeSessionId = agent.role === "orchestrator" ? "sess_legacy" : null;
  }
  writeFileSync(path, JSON.stringify(saved), "utf8");
  const chatFile = join(dataDir, "chats", `${makeAgentId(freshFile().id, "orchestrator").replace(":", "_")}.jsonl`);
  const lines = readFileSync(chatFile, "utf8").split("\n").filter((l) => l.trim() !== "");
  writeFileSync(chatFile, lines.map((l) => JSON.stringify({ ...(JSON.parse(l) as object), chatId: undefined })).join("\n") + "\n", "utf8");
}
({ server, client } = await boot());

await check("after restart: projects, agents, session ids and chat only are back", async () => {
  const snapshot = await client.snapshot();
  assert.deepEqual(
    snapshot.projects.map((p) => p.name),
    ["Sandbox", "Shop", "Fresh"],
  );
  assert.equal(snapshot.agents.length, 18);
  for (const agent of snapshot.agents) {
    if (agent.id === reviewer() || agent.projectId === freshFile().id) continue;
    assert.equal(await client.session(agent.id), sessionsBefore.get(agent.id), agent.id);
    const chats = (await client.chats(agent.id)).map(({ id, title, claudeSessionId, messageCount, contextTokens }) => ({ id, title, claudeSessionId, messageCount, contextTokens }));
    const before = (chatsBefore.get(agent.id) ?? []).map(({ id, title, claudeSessionId, messageCount, contextTokens }) => ({ id, title, claudeSessionId, messageCount, contextTokens }));
    assert.deepEqual(chats, before, `${agent.id} chats are back`);
  }
  assert.equal((await client.agent(shopAgent("product_manager"))).chatOnly, true);
  const engineerAfter = await client.agent(shopAgent("engineer"));
  assert.deepEqual([engineerAfter.model, engineerAfter.effort], ["haiku", null], "model settings survive a restart");
  const qaAfter = await client.agent(shopAgent("qa"));
  assert.deepEqual([qaAfter.model, qaAfter.effort], ["opus", "max"]);
  for (const role of AGENT_ROLES) {
    const agent = await client.agent(makeAgentId(freshFile().id, role));
    assert.deepEqual([agent.model, agent.effort], [CONFIG.roleModelDefaults[role].model, CONFIG.roleModelDefaults[role].effort], `old saved ${role} gets the role default`);
  }
  assert.equal((await client.session(shopAgent("engineer"))) !== null, true);
  const legacy = makeAgentId(freshFile().id, "orchestrator");
  const legacyChats = await client.chats(legacy);
  assert.equal(legacyChats.length, 1, "an agent saved before chats gets one chat");
  assert.equal(legacyChats[0]?.claudeSessionId, "sess_legacy", "with its old session");
  assert.equal(legacyChats[0]?.messageCount, 2);
  assert.deepEqual((await client.history(legacy)).map((m) => m.text), ["back", "ok: back"], "old messages are in that chat");
});

await check("after restart: the cut-off reply is [interrupted] and the queued messages run in order", async () => {
  await client.waitReplied(reviewer(), "ok: queued two");
  const history = await client.history(reviewer());
  const user = history.find((m) => m.id === interruptedId);
  assert.equal(user?.status, "error");
  assert.ok(user?.text.endsWith("[interrupted]"), user?.text);
  const cutReply = history.find((m) => m.author.kind === "agent" && m.text.startsWith("partial"));
  assert.equal(cutReply?.status, "error");
  assert.equal(cutReply?.text, "partial [interrupted]");
  assert.deepEqual(
    runs.filter((r) => r.agentId === reviewer()).map((r) => r.text),
    ["queued one", "queued two"],
  );
  for (const id of queuedIds) assert.equal(history.find((m) => m.id === id)?.status, "complete", id);
});

await check("after restart: chat history is complete and a resumed run gets the saved session id", async () => {
  const engineer = shopAgent("engineer");
  const history = await client.history(engineer);
  assert.ok(history.some((m) => m.text.includes("We always use Tailwind")));
  assert.ok(history.some((m) => m.author.kind === "tool" && m.text === "Pinned a note"));
  const qaHistory = await client.history(shopAgent("qa"));
  assert.equal(qaHistory.find((m) => m.author.kind === "user")?.pinned, true);
  await client.ok("sendMessage", { agentId: engineer, text: "what did I ask you before?" });
  await client.waitReplied(engineer, "ok: what did I ask you before?");
  assert.equal(runs.at(-1)?.sessionId, sessionsBefore.get(engineer));
});

client.close();
await server.close();
rmSync(tmpDir, { recursive: true, force: true });

console.log(failures === 0 ? "\nAll project checks passed." : `\n${failures} project check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
