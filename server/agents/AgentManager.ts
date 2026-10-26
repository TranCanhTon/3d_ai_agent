// Owns per-agent runtime state: the input queue, the runner, and the chat
// messages a run produces. Uses the pure queue functions from src/shared.

import { CONFIG } from "../../src/shared/config.ts";
import type { AgentStatus } from "../../src/shared/domain/agentTypes.ts";
import type { ChatAuthor, ChatMessage } from "../../src/shared/domain/chatTypes.ts";
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
} from "../../src/shared/events/eventPayloads.ts";
import { newId } from "../../src/shared/ids.ts";
import type { ChatHistoryPage } from "../../src/shared/protocol/protocol.ts";
import type { World } from "../world/World.ts";
import type { AgentRunner, AgentRunnerFactory } from "./AgentRunner.ts";

interface AgentSlot {
  queue: MessageQueue;
  runner: AgentRunner;
  /** Bumped whenever a run ends or is stopped; callbacks from older runs are ignored. */
  runId: number;
  streamingMessageId: string | null;
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
    this.world.emit({
      type: "chat.message_created",
      projectId: agent.projectId,
      agentId,
      message: `You → ${agent.name}`,
      feed: false,
      metadata: { message } satisfies ChatMessagePayload,
    });

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
    if (slot.streamingMessageId !== null) {
      const current = this.world.findMessage(agentId, slot.streamingMessageId);
      const message = this.world.updateMessage(agentId, slot.streamingMessageId, {
        text: `${current?.text ?? ""} [stopped]`,
        status: "error",
      });
      this.emitMessageCompleted(agentId, message);
      slot.streamingMessageId = null;
    }
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
        runner: this.createRunner({ id: agent.id, name: agent.name }),
        runId: 0,
        streamingMessageId: null,
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
    this.world.updateAgent(agentId, { busy: true, currentTaskId: input.taskId, lastError: null });
    this.syncQueueFields(agentId);

    slot.runner.run(
      { agentId, text: input.text },
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
            projectId: this.world.getAgent(agentId).projectId,
            agentId,
            message: "",
            feed: false,
            metadata: { messageId: message.id, delta: chunk } satisfies ChatDeltaPayload,
          });
        },
        onComplete: (fullText) => {
          if (!live()) return;
          const streaming = this.ensureStreamingMessage(agentId, input.taskId);
          const message = this.world.updateMessage(agentId, streaming.id, { text: fullText, status: "complete" });
          this.emitMessageCompleted(agentId, message);
          this.finishRun(agentId, "success", "Done");
        },
        onError: (error) => {
          if (!live()) return;
          const agent = this.world.getAgent(agentId);
          if (slot.streamingMessageId !== null) {
            const message = this.world.updateMessage(agentId, slot.streamingMessageId, { status: "error" });
            this.emitMessageCompleted(agentId, message);
          }
          this.world.updateAgent(agentId, { lastError: error });
          this.world.emit({ type: "agent.error", projectId: agent.projectId, agentId, message: `${agent.name}: ${error}`, severity: "error" });
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

  private ensureStreamingMessage(agentId: string, taskId: string | null): ChatMessage {
    const slot = this.slot(agentId);
    if (slot.streamingMessageId !== null) {
      const existing = this.world.findMessage(agentId, slot.streamingMessageId);
      if (existing !== undefined) return existing;
    }
    const agent = this.world.getAgent(agentId);
    const message = this.createMessage(agentId, { kind: "agent" }, "", "streaming", taskId);
    slot.streamingMessageId = message.id;
    this.world.emit({
      type: "chat.message_created",
      projectId: agent.projectId,
      agentId,
      message: `${agent.name} is replying`,
      feed: false,
      metadata: { message } satisfies ChatMessagePayload,
    });
    return message;
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

  private setStatus(agentId: string, status: AgentStatus, activity: string): void {
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

  private emitMessageCompleted(agentId: string, message: ChatMessage): void {
    this.world.emit({
      type: "chat.message_completed",
      projectId: message.projectId,
      agentId,
      message: message.status === "error" ? "Reply ended with an error" : "Reply complete",
      feed: false,
      metadata: { message } satisfies ChatMessagePayload,
    });
  }

  private clearHold(slot: AgentSlot): void {
    if (slot.holdTimer !== null) clearTimeout(slot.holdTimer);
    slot.holdTimer = null;
  }
}
