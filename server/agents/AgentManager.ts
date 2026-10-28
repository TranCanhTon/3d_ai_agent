// Owns per-agent runtime state: the input queue, the runner, and the chat
// messages a run produces. Uses the pure queue functions from src/shared.
// Task inputs (pipeline handoffs) share the same FIFO queue as my chat messages;
// they run in the task's own Claude session and report how they ended to the TaskHooks.

import { CONFIG } from "../../src/shared/config.ts";
import type { AgentStatus, EffortLevel } from "../../src/shared/domain/agentTypes.ts";
import { ROLE_DEFINITIONS } from "../../src/shared/domain/roles.ts";
import type { Chat, ChatAuthor, ChatMessage, TokenUsage } from "../../src/shared/domain/chatTypes.ts";
import {
  cancelQueued,
  EMPTY_QUEUE,
  enqueue,
  finishCurrent,
  isBusy,
  startNext,
  type AgentInput,
  type MessageQueue,
} from "../../src/shared/domain/messageQueue.ts";
import type {
  AgentStatusPayload,
  ChatDeltaPayload,
  ChatPayload,
  ChatMessagePayload,
  QueueChangedPayload,
  ToolPayload,
  UsageLimitPayload,
} from "../../src/shared/events/eventPayloads.ts";
import { newId } from "../../src/shared/ids.ts";
import type { ChatHistoryPage, ChatView } from "../../src/shared/protocol/protocol.ts";
import type { World } from "../world/World.ts";
import type { AgentRunner, AgentRunnerFactory, ToolEvent } from "./AgentRunner.ts";

interface AgentSlot {
  queue: MessageQueue;
  runner: AgentRunner;
  /** Bumped whenever a run ends or is stopped; callbacks from older runs are ignored. */
  runId: number;
  /** The chat of the running chat input (null for task inputs): its replies and tool lines go there. */
  chatId: string | null;
  /** The agent text message currently receiving deltas. */
  streamingMessageId: string | null;
  /** The latest agent text message of the current run (gets the token usage). */
  lastReplyId: string | null;
  /** tool_use_id → chat message id of its tool line. */
  toolMessages: Map<string, string>;
  usage: TokenUsage | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
  /** The current run reported the Claude usage limit. */
  hitUsageLimit: boolean;
}

/** How an input ended, for the pipeline. */
export type InputResult =
  | { ok: true; text: string }
  | { ok: false; reason: "stopped" | "error" | "usage_limit" | "interrupted"; message: string };

/** The pipeline's side of task inputs. */
export interface TaskHooks {
  /** The task's Claude session for this agent, or null for a new one. */
  sessionFor(taskId: string, agentId: string): string | null;
  setSession(taskId: string, agentId: string, sessionId: string): void;
  /** The agent's activity while it reads the input, e.g. "Reading plan from Pronelio Maximus". */
  activityFor(input: AgentInput): string;
  onInputStarted(input: AgentInput): void;
  onInputEnded(input: AgentInput, result: InputResult): void;
}

export interface TaskInput {
  agentId: string;
  taskId: string;
  text: string;
  author: ChatAuthor;
  fromAgentId: string | null;
}

export interface AgentManagerOptions {
  /** How long a finished run shows its result before the next input starts (tests use 0). */
  resultHoldMs?: number;
}

/** Writes an agent's note (the add_note tool) and returns the line written. Throws on bad input. */
export type NoteWriter = (agentId: string, text: string) => string;

/** A chat's title: my first message on one line, cut to chatTitleMaxChars. */
export function chatTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CONFIG.chatTitleMaxChars ? `${line.slice(0, CONFIG.chatTitleMaxChars - 1).trimEnd()}…` : line;
}

/** "opus · high", or "opus · default" without an effort. */
export function modelLabel(model: string, effort: EffortLevel | null): string {
  return `${model} · ${effort ?? "default"}`;
}

export class AgentManager {
  private readonly slots = new Map<string, AgentSlot>();
  private readonly world: World;
  private readonly createRunner: AgentRunnerFactory;
  private readonly writeNote: NoteWriter;
  private readonly resultHoldMs: number;
  private taskHooks: TaskHooks | null = null;

  constructor(
    world: World,
    createRunner: AgentRunnerFactory,
    writeNote: NoteWriter = () => { throw new Error("Notes are not available"); },
    options: AgentManagerOptions = {},
  ) {
    this.world = world;
    this.createRunner = createRunner;
    this.writeNote = writeNote;
    this.resultHoldMs = options.resultHoldMs ?? CONFIG.resultHoldMs;
  }

  /** The pipeline registers itself here (it is created after the manager). */
  setTaskHooks(hooks: TaskHooks): void {
    this.taskHooks = hooks;
  }

  /** Puts saved inputs back in their agents' queues (after a restart) and starts them. */
  restoreQueues(queues: ReadonlyMap<string, readonly AgentInput[]>): void {
    for (const [agentId, inputs] of queues) {
      const slot = this.slot(agentId);
      slot.queue = { current: null, queued: [...inputs] };
      this.syncQueueFields(agentId);
      this.startNextIfIdle(agentId);
    }
  }

  /** Archiving: ends every running input of the project. Queued inputs wait until it is restored. */
  stopProject(projectId: string): void {
    for (const agent of this.world.agents.values()) {
      if (agent.projectId === projectId) this.stopAgent(agent.id);
    }
  }

  /** Restoring: agents pick up their queued inputs again. */
  resumeProject(projectId: string): void {
    for (const agent of [...this.world.agents.values()]) {
      if (agent.projectId === projectId) this.startNextIfIdle(agent.id);
    }
  }

  /**
   * Starts a new chat (its own Claude session) and makes it active. The active chat is
   * returned as it is when it is still empty. A running or queued input keeps its chat.
   */
  newChat(agentId: string): Chat {
    const agent = this.world.getAgent(agentId);
    if (this.world.getProject(agent.projectId).archived) throw new Error("Project is archived");
    const active = this.world.getChat(agent.activeChatId);
    if (active.messageCount === 0) return active;
    const chat = this.world.addChat(agentId);
    this.world.updateAgent(agentId, { activeChatId: chat.id });
    this.world.emit({
      type: "chat.started",
      projectId: agent.projectId,
      agentId,
      message: `New chat with ${agent.name}`,
      metadata: { chat } satisfies ChatPayload,
    });
    return chat;
  }

  /** Makes an earlier chat active: my next message resumes its Claude session. */
  openChat(agentId: string, chatId: string): void {
    this.chatOf(agentId, chatId);
    if (this.world.getAgent(agentId).activeChatId !== chatId) this.world.updateAgent(agentId, { activeChatId: chatId });
  }

  /** Newest first. */
  listChats(agentId: string): Chat[] {
    this.world.getAgent(agentId);
    return this.world.chatsOf(agentId);
  }

  /** The chat, checked to be this agent's. */
  private chatOf(agentId: string, chatId: string): Chat {
    const chat = this.world.getChat(chatId);
    if (chat.agentId !== agentId) throw new Error(`Chat ${chatId} is not ${this.world.getAgent(agentId).name}'s`);
    return chat;
  }

  private emitChatUpdated(chat: Chat): void {
    this.world.emit({ type: "chat.updated", projectId: chat.projectId, agentId: chat.agentId, message: "", feed: false, metadata: { chat } satisfies ChatPayload });
  }

  /** Takes effect from the next input. */
  setChatOnly(agentId: string, chatOnly: boolean): void {
    this.world.updateAgent(agentId, { chatOnly });
  }

  /** Takes effect from the next run (chat or task step); a running one keeps what it started with. */
  setAgentModel(agentId: string, model: string, effort: EffortLevel | null): void {
    if (!CONFIG.models.some((choice) => choice.id === model)) throw new Error(`Unknown model: ${model}`);
    if (effort !== null && !CONFIG.effortLevels.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
    const current = this.world.getAgent(agentId);
    if (current.model === model && current.effort === effort) return;
    const agent = this.world.updateAgent(agentId, { model, effort });
    this.world.emit({
      type: "agent.settings_changed",
      projectId: agent.projectId,
      agentId,
      message: `${agent.name}: ${modelLabel(model, effort)}`,
    });
  }

  /**
   * Creates my message in `chatId` (default: the active chat, which it becomes) and runs it
   * now, or queues it while the agent is busy. My first message in a chat becomes its title.
   */
  sendMessage(agentId: string, text: string, chatId?: string): ChatMessage {
    const agent = this.world.getAgent(agentId);
    if (this.world.getProject(agent.projectId).archived) throw new Error("Project is archived");
    const chat = this.chatOf(agentId, chatId ?? agent.activeChatId);
    if (agent.activeChatId !== chat.id) this.world.updateAgent(agentId, { activeChatId: chat.id });
    if (chat.title === "") this.emitChatUpdated(this.world.updateChat(chat.id, { title: chatTitle(text) }));
    return this.enqueueInput(agentId, { kind: "user" }, text, null, null, `You → ${agent.name}`, undefined, chat.id);
  }

  /**
   * A pipeline step's input (handoff, answer, reminder): same queue as chat, in the task's session.
   * `beforeStart` gets the message before the input can start (an idle agent starts it at once).
   */
  enqueueTaskInput(input: TaskInput, beforeStart?: (message: ChatMessage) => void): ChatMessage {
    const from = input.fromAgentId === null ? "You" : this.world.getAgent(input.fromAgentId).name;
    const feed = `${from} → ${this.world.getAgent(input.agentId).name}`;
    return this.enqueueInput(input.agentId, input.author, input.text, input.taskId, input.fromAgentId, feed, beforeStart);
  }

  /** Removes a task's waiting inputs (and their messages) from every queue. Returns their ids. */
  removeTaskInputs(taskId: string): string[] {
    const removed: string[] = [];
    for (const [agentId, slot] of this.slots) {
      for (const input of slot.queue.queued) {
        if (input.taskId !== taskId) continue;
        this.cancelQueued(agentId, input.id);
        removed.push(input.id);
      }
    }
    return removed;
  }

  /** The agent running an input of this task, or null. */
  runningTaskAgent(taskId: string): string | null {
    for (const [agentId, slot] of this.slots) if (slot.queue.current?.taskId === taskId) return agentId;
    return null;
  }

  private enqueueInput(
    agentId: string,
    author: ChatAuthor,
    text: string,
    taskId: string | null,
    fromAgentId: string | null,
    feedText: string,
    beforeStart?: (message: ChatMessage) => void,
    chatId: string | null = null,
  ): ChatMessage {
    const agent = this.world.getAgent(agentId);
    const project = this.world.projects.get(agent.projectId);
    if (project?.archived) throw new Error("Project is archived");

    const slot = this.slot(agentId);
    const busy = isBusy(slot.queue);
    const message = this.createMessage(agentId, author, text, busy ? "queued" : "delivered", taskId, chatId);
    this.emitMessageCreated(agentId, message, feedText);
    beforeStart?.(message);

    const input: AgentInput = {
      id: message.id,
      source: author.kind === "user" && taskId === null ? "user" : "handoff",
      text,
      taskId,
      fromAgentId,
      enqueuedAt: message.createdAt,
    };
    slot.queue = enqueue(slot.queue, input);
    if (busy) {
      this.syncQueueFields(agentId);
      this.emitQueueChanged(agentId, {});
    } else {
      this.startNextIfIdle(agentId);
    }
    return message;
  }

  /** Ends the current input only; queued inputs continue afterwards. Returns false when idle. */
  stopAgent(agentId: string): boolean {
    const agent = this.world.getAgent(agentId);
    const slot = this.slot(agentId);
    if (!isBusy(slot.queue)) return false;

    slot.runner.stop();
    slot.runId++;
    this.clearHold(slot);
    this.endStreamingSegment(agentId, " [stopped]", "error");
    this.endOpenToolLines(agentId);
    const stopped = slot.queue.current;
    this.completeInputMessage(agentId, stopped);
    slot.queue = finishCurrent(slot.queue);
    this.world.emit({ type: "agent.stopped", projectId: agent.projectId, agentId, message: `${agent.name} was stopped`, severity: "warning" });
    this.setIdle(agentId);
    if (stopped !== null) this.reportEnded(stopped, { ok: false, reason: "stopped", message: `${agent.name} was stopped` });
    this.startNextIfIdle(agentId);
    return true;
  }

  cancelQueued(agentId: string, messageId: string): void {
    const slot = this.slot(agentId);
    if (!slot.queue.queued.some((input) => input.id === messageId)) throw new Error("Message is not queued");
    slot.queue = cancelQueued(slot.queue, messageId);
    this.world.removeMessage(agentId, messageId);
    this.syncQueueFields(agentId);
    this.emitQueueChanged(agentId, { cancelledMessageId: messageId });
  }

  /**
   * Oldest first. `before` is a message id; returns up to `limit` messages older than it.
   * view "chat": one of my chats (default the active one); "tasks": messages of pipeline tasks.
   */
  getChatHistory(
    agentId: string,
    before?: string,
    limit: number = CONFIG.chatHistoryDefaultLimit,
    view: ChatView = "chat",
    chatId?: string,
  ): ChatHistoryPage {
    const chat = view === "chat" ? this.chatOf(agentId, chatId ?? this.world.getAgent(agentId).activeChatId).id : null;
    const list = this.world.chatFor(agentId).filter((m) => (view === "tasks" ? m.taskId !== null : m.chatId === chat));
    let end = list.length;
    if (before !== undefined) {
      end = list.findIndex((m) => m.id === before);
      if (end === -1) throw new Error(`Unknown message: ${before}`);
    }
    const start = Math.max(0, end - limit);
    return { messages: list.slice(start, end), hasMore: start > 0 };
  }

  /** Changes an agent's status and emits agent.status_changed (skipped when nothing changes). */
  setStatus(agentId: string, status: AgentStatus, activity: string): void {
    const current = this.world.getAgent(agentId);
    if (current.status === status && current.activity === activity) return;
    const agent = this.world.updateAgent(agentId, { status, activity });
    this.world.emit({
      type: "agent.status_changed",
      projectId: agent.projectId,
      agentId,
      message: activity ? `${agent.name}: ${status} · ${activity}` : `${agent.name}: ${status}`,
      feed: false,
      metadata: { status, activity } satisfies AgentStatusPayload,
    });
  }

  /** Server shutdown: stops every run. Streamed text is saved so the reply shows what arrived before "[interrupted]". */
  dispose(): void {
    for (const [agentId, slot] of this.slots) {
      slot.runner.stop();
      slot.runId++;
      this.clearHold(slot);
      if (slot.streamingMessageId !== null && this.world.findMessage(agentId, slot.streamingMessageId) !== undefined) {
        this.world.updateMessage(agentId, slot.streamingMessageId, {});
      }
      const current = slot.queue.current;
      if (current !== null) this.reportEnded(current, { ok: false, reason: "interrupted", message: "Server stopped" });
    }
  }

  // ── Internals ──

  private slot(agentId: string): AgentSlot {
    let slot = this.slots.get(agentId);
    if (slot === undefined) {
      const agent = this.world.getAgent(agentId);
      slot = {
        queue: EMPTY_QUEUE,
        runner: this.createRunner({ id: agent.id, name: agent.name, role: agent.role }),
        runId: 0,
        chatId: null,
        streamingMessageId: null,
        lastReplyId: null,
        toolMessages: new Map(),
        usage: null,
        holdTimer: null,
        hitUsageLimit: false,
      };
      this.slots.set(agentId, slot);
    }
    return slot;
  }

  private startNextIfIdle(agentId: string): void {
    const slot = this.slot(agentId);
    if (isBusy(slot.queue)) return;
    if (this.world.getProject(this.world.getAgent(agentId).projectId).archived) return;
    slot.queue = startNext(slot.queue);
    const input = slot.queue.current;
    if (input === null) return;

    const userMessage = this.world.findMessage(agentId, input.id);
    if (userMessage?.status === "queued") {
      this.world.updateMessage(agentId, input.id, { status: "delivered" });
      this.syncQueueFields(agentId);
      this.emitQueueChanged(agentId, { startedMessageId: input.id });
    }
    this.begin(agentId, input);
    if (input.taskId !== null) this.taskHooks?.onInputStarted(input);
  }

  private begin(agentId: string, input: AgentInput): void {
    const slot = this.slot(agentId);
    const runId = ++slot.runId;
    const live = () => slot.runId === runId;
    slot.streamingMessageId = null;
    slot.lastReplyId = null;
    slot.toolMessages = new Map();
    slot.usage = null;
    slot.hitUsageLimit = false;

    const agent = this.world.updateAgent(agentId, { busy: true, currentTaskId: input.taskId, lastError: null });
    this.syncQueueFields(agentId);
    // Task inputs run in the task's own session, with the role's tools (chat only is for direct chat).
    // A chat input runs in the session of the chat its message was sent to.
    const taskId = input.taskId;
    const hooks = taskId === null ? null : this.taskHooks;
    const chatId = taskId === null ? (this.world.findMessage(agentId, input.id)?.chatId ?? agent.activeChatId) : null;
    slot.chatId = chatId;
    // Runners may take seconds before their first status (model thinking); never look idle while busy.
    this.setStatus(agentId, "thinking", hooks === null ? "Reading your message" : hooks.activityFor(input));

    slot.runner.run(
      {
        agentId,
        text: input.text,
        sessionId:
          taskId !== null && hooks !== null ? hooks.sessionFor(taskId, agentId) : chatId === null ? null : this.world.getChat(chatId).claudeSessionId,
        cwd: this.world.getProjectRoot(agent.projectId),
        chatOnly: taskId === null ? agent.chatOnly : false,
        model: agent.model,
        effort: agent.effort,
      },
      {
        addNote: (text) => {
          if (!live()) throw new Error("This run has ended");
          return this.writeNote(agentId, text);
        },
        onStatus: (status, activity) => {
          if (live()) this.setStatus(agentId, status, activity);
        },
        onDelta: (chunk) => {
          if (!live()) return;
          const message = this.ensureStreamingMessage(agentId, input.taskId);
          this.world.updateMessage(agentId, message.id, { text: message.text + chunk }, false);
          this.world.emit({
            type: "chat.message_delta",
            projectId: message.projectId,
            agentId,
            message: "",
            feed: false,
            metadata: { messageId: message.id, delta: chunk } satisfies ChatDeltaPayload,
          });
        },
        onTool: (event) => {
          if (live()) this.applyToolEvent(agentId, input.taskId, event);
        },
        onSession: (sessionId) => {
          if (!live()) return;
          if (taskId !== null && hooks !== null) hooks.setSession(taskId, agentId, sessionId);
          else if (chatId !== null && this.world.getChat(chatId).claudeSessionId !== sessionId) {
            this.emitChatUpdated(this.world.updateChat(chatId, { claudeSessionId: sessionId }));
          }
        },
        onAuth: (source) => {
          if (!live() || this.world.auth.source === source) return;
          this.world.auth = { source };
          this.world.changed();
        },
        onRunInfo: (info) => {
          if (!live()) return;
          const lastRun = this.world.getAgent(agentId).lastRun;
          if (lastRun?.model !== info.model || lastRun.effort !== info.effort) this.world.updateAgent(agentId, { lastRun: info });
        },
        onUsage: (usage) => {
          if (live()) slot.usage = usage;
        },
        onUsageLimit: (resetsAt) => {
          if (!live()) return;
          slot.hitUsageLimit = true;
          this.world.usage = { limited: true, resetsAt };
          this.world.changed();
          this.world.emit({
            type: "usage.limit_reached",
            projectId: this.world.getAgent(agentId).projectId,
            agentId,
            message: resetsAt !== null ? `Claude usage limit reached, resets ${new Date(resetsAt).toLocaleTimeString()}` : "Claude usage limit reached",
            severity: "error",
            metadata: { resetsAt } satisfies UsageLimitPayload,
          });
        },
        onComplete: (fullText) => {
          if (!live()) return;
          this.endOpenToolLines(agentId);
          if (slot.streamingMessageId !== null) {
            this.endStreamingSegment(agentId, "", "complete");
          } else if (slot.lastReplyId === null || fullText.trim() !== "") {
            // Nothing streamed (or only tool calls): show the final text as the reply.
            const reply = this.createMessage(agentId, { kind: "agent" }, fullText, "complete", input.taskId);
            slot.lastReplyId = reply.id;
            this.emitMessageCreated(agentId, reply, "Reply");
          }
          this.attachUsage(agentId);
          if (this.world.usage.limited) {
            this.world.usage = { limited: false, resetsAt: null };
            this.world.changed();
          }
          this.finishRun(agentId, "success", "Done");
          this.reportEnded(input, { ok: true, text: fullText });
        },
        onError: (error) => {
          if (!live()) return;
          const current = this.world.getAgent(agentId);
          this.endStreamingSegment(agentId, "", "error");
          this.endOpenToolLines(agentId);
          this.attachUsage(agentId);
          const system = this.createMessage(agentId, { kind: "system" }, error, "error", input.taskId);
          this.emitMessageCreated(agentId, system, error);
          this.world.updateAgent(agentId, { lastError: error });
          this.world.emit({ type: "agent.error", projectId: current.projectId, agentId, message: `${current.name}: ${error}`, severity: "error" });
          this.finishRun(agentId, "error", error);
          this.reportEnded(input, { ok: false, reason: slot.hitUsageLimit ? "usage_limit" : "error", message: error });
        },
      },
    );
  }

  /** Shows the result for resultHoldMs, then idles and starts the next queued input. */
  private finishRun(agentId: string, status: AgentStatus, activity: string): void {
    const slot = this.slot(agentId);
    slot.runId++;
    slot.streamingMessageId = null;
    this.setStatus(agentId, status, activity);
    slot.holdTimer = setTimeout(() => {
      slot.holdTimer = null;
      this.completeInputMessage(agentId, slot.queue.current);
      slot.queue = finishCurrent(slot.queue);
      this.setIdle(agentId);
      this.startNextIfIdle(agentId);
    }, this.resultHoldMs);
  }

  /** Tells the pipeline how a task input ended (chat inputs have no listener). */
  private reportEnded(input: AgentInput, result: InputResult): void {
    if (input.taskId !== null) this.taskHooks?.onInputEnded(input, result);
  }

  /** A tool line in the chat: created when the tool starts, completed (or errored) when it finishes. */
  private applyToolEvent(agentId: string, taskId: string | null, event: ToolEvent): void {
    const slot = this.slot(agentId);
    const agent = this.world.getAgent(agentId);
    // Pinning a note happens at the planning board.
    if (event.toolName === "add_note") {
      this.world.updateAgent(agentId, { location: event.phase === "started" ? "planning" : ROLE_DEFINITIONS[agent.role].homeStation });
    }
    if (event.phase === "started") {
      // Text after the tool call goes into a new reply bubble, below the tool line.
      this.endStreamingSegment(agentId, "", "complete");
      const line = this.createMessage(agentId, { kind: "tool", toolName: event.toolName }, event.summary, "streaming", taskId);
      slot.toolMessages.set(event.toolUseId, line.id);
      this.emitMessageCreated(agentId, line, event.summary);
      this.world.emit({
        type: "agent.tool_started",
        projectId: agent.projectId,
        agentId,
        message: `${agent.name}: ${event.summary}`,
        feed: false,
        metadata: { toolUseId: event.toolUseId, toolName: event.toolName, summary: event.summary } satisfies ToolPayload,
      });
      return;
    }
    const messageId = slot.toolMessages.get(event.toolUseId);
    if (messageId === undefined) return;
    slot.toolMessages.delete(event.toolUseId);
    const started = this.world.findMessage(agentId, messageId);
    const line = this.world.updateMessage(agentId, messageId, {
      status: event.ok ? "complete" : "error",
      // The line is past tense ("Wrote hello.txt"); say so when it did not happen (denied or failed).
      ...(event.ok || started === undefined ? {} : { text: `${started.text} (not done)` }),
    });
    this.emitMessageCompleted(agentId, line);
    this.world.emit({
      type: "agent.tool_finished",
      projectId: agent.projectId,
      agentId,
      message: `${agent.name}: ${line.text} ${event.ok ? "✓" : "✗"}`,
      feed: false,
      metadata: { toolUseId: event.toolUseId, toolName: event.toolName, summary: line.text, ok: event.ok } satisfies ToolPayload,
    });
  }

  private ensureStreamingMessage(agentId: string, taskId: string | null): ChatMessage {
    const slot = this.slot(agentId);
    if (slot.streamingMessageId !== null) {
      const existing = this.world.findMessage(agentId, slot.streamingMessageId);
      if (existing !== undefined) return existing;
    }
    const agent = this.world.getAgent(agentId);
    const message = this.createMessage(agentId, { kind: "agent" }, "", "streaming", taskId);
    slot.streamingMessageId = message.id;
    slot.lastReplyId = message.id;
    this.emitMessageCreated(agentId, message, `${agent.name} is replying`);
    return message;
  }

  /** Finishes the bubble receiving deltas, if any. */
  private endStreamingSegment(agentId: string, suffix: string, status: "complete" | "error"): void {
    const slot = this.slot(agentId);
    if (slot.streamingMessageId === null) return;
    const current = this.world.findMessage(agentId, slot.streamingMessageId);
    slot.streamingMessageId = null;
    if (current === undefined) return;
    const message = this.world.updateMessage(agentId, current.id, { text: current.text + suffix, status });
    this.emitMessageCompleted(agentId, message);
  }

  /** Tool lines still running when a run ends are marked as errors. */
  private endOpenToolLines(agentId: string): void {
    const slot = this.slot(agentId);
    for (const messageId of slot.toolMessages.values()) {
      const line = this.world.updateMessage(agentId, messageId, { status: "error" });
      this.emitMessageCompleted(agentId, line);
    }
    slot.toolMessages.clear();
  }

  /** The run's tokens go on its last reply; a chat's context size is the run's prompt tokens. */
  private attachUsage(agentId: string): void {
    const slot = this.slot(agentId);
    if (slot.usage === null) return;
    if (slot.chatId !== null) this.emitChatUpdated(this.world.updateChat(slot.chatId, { contextTokens: slot.usage.inputTokens }));
    if (slot.lastReplyId === null) return;
    const message = this.world.updateMessage(agentId, slot.lastReplyId, { usage: slot.usage });
    this.emitMessageCompleted(agentId, message);
  }

  private createMessage(
    agentId: string,
    author: ChatAuthor,
    text: string,
    status: ChatMessage["status"],
    taskId: string | null,
    /** Default: the running chat input's chat (task messages have none). */
    chatId: string | null = taskId === null ? this.slot(agentId).chatId : null,
  ): ChatMessage {
    const agent = this.world.getAgent(agentId);
    const message: ChatMessage = {
      id: newId("msg"),
      projectId: agent.projectId,
      agentId,
      author,
      text,
      taskId,
      chatId: taskId === null ? (chatId ?? agent.activeChatId) : null,
      pinned: false,
      status,
      createdAt: this.world.now(),
    };
    const chat = this.world.addMessage(message);
    if (chat !== null) this.emitChatUpdated(chat);
    return message;
  }

  private setIdle(agentId: string): void {
    const home = ROLE_DEFINITIONS[this.world.getAgent(agentId).role].homeStation;
    this.world.updateAgent(agentId, { busy: isBusy(this.slot(agentId).queue), currentTaskId: null, location: home });
    this.setStatus(agentId, "idle", "");
  }

  /** The input's chat message was handled (a "delivered" message after a restart means it was cut off). */
  private completeInputMessage(agentId: string, input: AgentInput | null): void {
    if (input === null) return;
    const message = this.world.findMessage(agentId, input.id);
    if (message?.status === "delivered") this.world.updateMessage(agentId, input.id, { status: "complete" });
  }

  private syncQueueFields(agentId: string): void {
    const queue = this.slot(agentId).queue;
    this.world.setSavedQueue(agentId, queue.queued);
    this.world.updateAgent(agentId, { busy: isBusy(queue), queuedCount: queue.queued.length });
  }

  private emitQueueChanged(agentId: string, change: Omit<QueueChangedPayload, "queuedMessageIds">): void {
    const agent = this.world.getAgent(agentId);
    const queuedMessageIds = this.slot(agentId).queue.queued.map((input) => input.id);
    this.world.emit({
      type: "agent.queue_changed",
      projectId: agent.projectId,
      agentId,
      message: `${agent.name}: ${queuedMessageIds.length} waiting`,
      feed: false,
      metadata: { queuedMessageIds, ...change } satisfies QueueChangedPayload,
    });
  }

  private emitMessageCreated(agentId: string, message: ChatMessage, text: string): void {
    this.world.emit({
      type: "chat.message_created",
      projectId: message.projectId,
      agentId,
      message: text,
      feed: false,
      metadata: { message } satisfies ChatMessagePayload,
    });
  }

  private emitMessageCompleted(agentId: string, message: ChatMessage): void {
    this.world.emit({
      type: "chat.message_completed",
      projectId: message.projectId,
      agentId,
      message: message.status === "error" ? "Message ended with an error" : "Message complete",
      feed: false,
      metadata: { message } satisfies ChatMessagePayload,
    });
  }

  private clearHold(slot: AgentSlot): void {
    if (slot.holdTimer !== null) clearTimeout(slot.holdTimer);
    slot.holdTimer = null;
  }
}
