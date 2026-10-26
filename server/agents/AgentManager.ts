// Owns per-agent runtime state: the input queue, the runner, and the chat
// messages a run produces. Uses the pure queue functions from src/shared.

import { CONFIG } from "../../src/shared/config.ts";
import type { AgentStatus } from "../../src/shared/domain/agentTypes.ts";
import type { ChatAuthor, ChatMessage, TokenUsage } from "../../src/shared/domain/chatTypes.ts";
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
  ChatMessagePayload,
  QueueChangedPayload,
  ToolPayload,
  UsageLimitPayload,
} from "../../src/shared/events/eventPayloads.ts";
import { newId } from "../../src/shared/ids.ts";
import type { ChatHistoryPage } from "../../src/shared/protocol/protocol.ts";
import type { World } from "../world/World.ts";
import type { AgentRunner, AgentRunnerFactory, ToolEvent } from "./AgentRunner.ts";

interface AgentSlot {
  queue: MessageQueue;
  runner: AgentRunner;
  /** Bumped whenever a run ends or is stopped; callbacks from older runs are ignored. */
  runId: number;
  /** The agent text message currently receiving deltas. */
  streamingMessageId: string | null;
  /** The latest agent text message of the current run (gets the token usage). */
  lastReplyId: string | null;
  /** tool_use_id → chat message id of its tool line. */
  toolMessages: Map<string, string>;
  usage: TokenUsage | null;
  holdTimer: ReturnType<typeof setTimeout> | null;
}

export class AgentManager {
  private readonly slots = new Map<string, AgentSlot>();
  private readonly world: World;
  private readonly createRunner: AgentRunnerFactory;

  constructor(world: World, createRunner: AgentRunnerFactory) {
    this.world = world;
    this.createRunner = createRunner;
  }

  /** Creates the user's message and runs it now, or queues it while the agent is busy. */
  sendMessage(agentId: string, text: string): ChatMessage {
    const agent = this.world.getAgent(agentId);
    const project = this.world.projects.get(agent.projectId);
    if (project?.archived) throw new Error("Project is archived");

    const slot = this.slot(agentId);
    const busy = isBusy(slot.queue);
    const message = this.createMessage(agentId, { kind: "user" }, text, busy ? "queued" : "delivered", null);
    this.emitMessageCreated(agentId, message, `You → ${agent.name}`);

    const input: AgentInput = {
      id: message.id,
      source: "user",
      text,
      taskId: null,
      fromAgentId: null,
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
    slot.queue = finishCurrent(slot.queue);
    this.world.emit({ type: "agent.stopped", projectId: agent.projectId, agentId, message: `${agent.name} was stopped`, severity: "warning" });
    this.setIdle(agentId);
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

  /** Oldest first. `before` is a message id; returns up to `limit` messages older than it. */
  getChatHistory(agentId: string, before?: string, limit: number = CONFIG.chatHistoryDefaultLimit): ChatHistoryPage {
    const list = this.world.chatFor(agentId);
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

  dispose(): void {
    for (const slot of this.slots.values()) {
      slot.runner.stop();
      slot.runId++;
      this.clearHold(slot);
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
        streamingMessageId: null,
        lastReplyId: null,
        toolMessages: new Map(),
        usage: null,
        holdTimer: null,
      };
      this.slots.set(agentId, slot);
    }
    return slot;
  }

  private startNextIfIdle(agentId: string): void {
    const slot = this.slot(agentId);
    if (isBusy(slot.queue)) return;
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
  }

  private begin(agentId: string, input: AgentInput): void {
    const slot = this.slot(agentId);
    const runId = ++slot.runId;
    const live = () => slot.runId === runId;
    slot.streamingMessageId = null;
    slot.lastReplyId = null;
    slot.toolMessages = new Map();
    slot.usage = null;

    const agent = this.world.updateAgent(agentId, { busy: true, currentTaskId: input.taskId, lastError: null });
    this.syncQueueFields(agentId);
    // Runners may take seconds before their first status (model thinking); never look idle while busy.
    this.setStatus(agentId, "thinking", "Reading your message");

    slot.runner.run(
      {
        agentId,
        text: input.text,
        sessionId: agent.claudeSessionId,
        cwd: this.world.getProjectRoot(agent.projectId),
      },
      {
        onStatus: (status, activity) => {
          if (live()) this.setStatus(agentId, status, activity);
        },
        onDelta: (chunk) => {
          if (!live()) return;
          const message = this.ensureStreamingMessage(agentId, input.taskId);
          this.world.updateMessage(agentId, message.id, { text: message.text + chunk });
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
          if (live() && this.world.getAgent(agentId).claudeSessionId !== sessionId) {
            this.world.updateAgent(agentId, { claudeSessionId: sessionId });
          }
        },
        onAuth: (source) => {
          if (!live() || this.world.auth.source === source) return;
          this.world.auth = { source };
          this.world.changed();
        },
        onUsage: (usage) => {
          if (live()) slot.usage = usage;
        },
        onUsageLimit: (resetsAt) => {
          if (!live()) return;
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
      slot.queue = finishCurrent(slot.queue);
      this.setIdle(agentId);
      this.startNextIfIdle(agentId);
    }, CONFIG.resultHoldMs);
  }

  /** A tool line in the chat: created when the tool starts, completed (or errored) when it finishes. */
  private applyToolEvent(agentId: string, taskId: string | null, event: ToolEvent): void {
    const slot = this.slot(agentId);
    const agent = this.world.getAgent(agentId);
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

  private attachUsage(agentId: string): void {
    const slot = this.slot(agentId);
    if (slot.usage === null || slot.lastReplyId === null) return;
    const message = this.world.updateMessage(agentId, slot.lastReplyId, { usage: slot.usage });
    this.emitMessageCompleted(agentId, message);
  }

  private createMessage(
    agentId: string,
    author: ChatAuthor,
    text: string,
    status: ChatMessage["status"],
    taskId: string | null,
  ): ChatMessage {
    const agent = this.world.getAgent(agentId);
    const message: ChatMessage = {
      id: newId("msg"),
      projectId: agent.projectId,
      agentId,
      author,
      text,
      taskId,
      pinned: false,
      status,
      createdAt: this.world.now(),
    };
    this.world.addMessage(message);
    return message;
  }

  private setIdle(agentId: string): void {
    this.world.updateAgent(agentId, { busy: isBusy(this.slot(agentId).queue), currentTaskId: null });
    this.setStatus(agentId, "idle", "");
  }

  private syncQueueFields(agentId: string): void {
    const queue = this.slot(agentId).queue;
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
