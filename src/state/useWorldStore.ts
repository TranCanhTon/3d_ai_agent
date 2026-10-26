// Zustand mirror of the server's world for the HTML UI.
// Snapshots reach React at most every snapshotThrottleMs unless something
// significant changed (an agent's status, busy flag or queue count).

import { create } from "zustand";
import { CONFIG } from "@/shared/config.ts";
import type { ConnectionStatus } from "@/shared/backend/AgentBackend.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import { eventPayloadSchemas, readPayload } from "@/shared/events/eventPayloads.ts";
import type { AgentEvent } from "@/shared/events/eventTypes.ts";
import type { WorldSnapshot } from "@/shared/protocol/protocol.ts";

export interface WorldStore {
  connectionStatus: ConnectionStatus;
  snapshot: WorldSnapshot | null;
  selectedAgentId: string | null;
  /** Per agent, oldest first. */
  chats: Record<string, ChatMessage[]>;
  historyLoaded: Record<string, boolean>;
  /** Newest first, at most maxStoredEvents. */
  events: AgentEvent[];

  setConnectionStatus(status: ConnectionStatus): void;
  applySnapshot(snapshot: WorldSnapshot): void;
  applyEvent(event: AgentEvent): void;
  setSelectedAgent(agentId: string | null): void;
  /** Merges a loaded history page with messages that arrived live. */
  setHistory(agentId: string, messages: ChatMessage[]): void;
  /** Forget chats (after a reconnect the server may have restarted). */
  resetChats(): void;
}

function snapshotSignature(snapshot: WorldSnapshot): string {
  const agents = snapshot.agents.map((a) => `${a.id}|${a.status}|${a.busy}|${a.queuedCount}`).join(";");
  return `${agents}#${snapshot.projects.length}#${snapshot.tasks.length}#${snapshot.pendingPermissions.length}`;
}

function upsert(list: ChatMessage[] | undefined, message: ChatMessage): ChatMessage[] {
  const current = list ?? [];
  const index = current.findIndex((m) => m.id === message.id);
  if (index === -1) return [...current, message];
  const next = [...current];
  next[index] = message;
  return next;
}

function updateMessage(
  chats: Record<string, ChatMessage[]>,
  agentId: string,
  messageId: string,
  update: (message: ChatMessage) => ChatMessage | null,
): Record<string, ChatMessage[]> {
  const list = chats[agentId];
  if (list === undefined || !list.some((m) => m.id === messageId)) return chats;
  const next = list.flatMap((m) => {
    if (m.id !== messageId) return [m];
    const updated = update(m);
    return updated === null ? [] : [updated];
  });
  return { ...chats, [agentId]: next };
}

function applyChatEvent(chats: Record<string, ChatMessage[]>, event: AgentEvent): Record<string, ChatMessage[]> {
  const created = readPayload(event, ["chat.message_created", "chat.message_completed"], eventPayloadSchemas.chatMessage);
  if (created !== null) {
    const { message } = created;
    return { ...chats, [message.agentId]: upsert(chats[message.agentId], message) };
  }

  const agentId = event.agentId;
  if (agentId === undefined) return chats;

  const delta = readPayload(event, "chat.message_delta", eventPayloadSchemas.chatDelta);
  if (delta !== null) {
    return updateMessage(chats, agentId, delta.messageId, (m) => ({ ...m, text: m.text + delta.delta }));
  }

  const queue = readPayload(event, "agent.queue_changed", eventPayloadSchemas.queueChanged);
  if (queue !== null) {
    let next = chats;
    if (queue.cancelledMessageId !== undefined) next = updateMessage(next, agentId, queue.cancelledMessageId, () => null);
    if (queue.startedMessageId !== undefined) {
      next = updateMessage(next, agentId, queue.startedMessageId, (m) => ({ ...m, status: "delivered" }));
    }
    return next;
  }
  return chats;
}

// Snapshot throttling state lives outside React.
let lastCommitAt = 0;
let pendingSnapshot: WorldSnapshot | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

export const useWorldStore = create<WorldStore>()((set, get) => {
  const commitSnapshot = (snapshot: WorldSnapshot) => {
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = null;
    pendingSnapshot = null;
    lastCommitAt = Date.now();
    set({ snapshot });
  };

  return {
    connectionStatus: "closed",
    snapshot: null,
    selectedAgentId: null,
    chats: {},
    historyLoaded: {},
    events: [],

    setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

    applySnapshot: (snapshot) => {
      const previous = get().snapshot;
      const significant = previous === null || snapshotSignature(previous) !== snapshotSignature(snapshot);
      const elapsed = Date.now() - lastCommitAt;
      if (significant || elapsed >= CONFIG.snapshotThrottleMs) {
        commitSnapshot(snapshot);
        return;
      }
      pendingSnapshot = snapshot;
      pendingTimer ??= setTimeout(() => {
        if (pendingSnapshot !== null) commitSnapshot(pendingSnapshot);
      }, CONFIG.snapshotThrottleMs - elapsed);
    },

    applyEvent: (event) =>
      set((state) => ({
        events: [event, ...state.events].slice(0, CONFIG.maxStoredEvents),
        chats: applyChatEvent(state.chats, event),
      })),

    setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),

    setHistory: (agentId, messages) =>
      set((state) => {
        const live = state.chats[agentId] ?? [];
        const liveIds = new Set(live.map((m) => m.id));
        const merged = [...messages.filter((m) => !liveIds.has(m.id)), ...live].sort((a, b) => a.createdAt - b.createdAt);
        return {
          chats: { ...state.chats, [agentId]: merged },
          historyLoaded: { ...state.historyLoaded, [agentId]: true },
        };
      }),

    resetChats: () => set({ chats: {}, historyLoaded: {} }),
  };
});
