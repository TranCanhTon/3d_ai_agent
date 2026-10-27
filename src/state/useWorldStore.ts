// Zustand mirror of the server's world for the HTML UI.
// Snapshots reach React at most every snapshotThrottleMs unless something
// significant changed (an agent's status, busy flag or queue count).

import { create } from "zustand";
import { CONFIG } from "@/shared/config.ts";
import type { ConnectionStatus } from "@/shared/backend/AgentBackend.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import { eventPayloadSchemas, readPayload } from "@/shared/events/eventPayloads.ts";
import type { AgentEvent } from "@/shared/events/eventTypes.ts";
import type { ChatView, WorldSnapshot } from "@/shared/protocol/protocol.ts";

/** Key in `chats`: an agent's direct chat, or its task messages (the Tasks tab). */
export function chatKey(agentId: string, view: ChatView = "chat"): string {
  return view === "chat" ? agentId : `${agentId}#tasks`;
}

function messageKey(message: ChatMessage): string {
  return chatKey(message.agentId, message.taskId === null ? "chat" : "tasks");
}

export interface WorldStore {
  connectionStatus: ConnectionStatus;
  snapshot: WorldSnapshot | null;
  selectedProjectId: string | null;
  selectedAgentId: string | null;
  /** Per chatKey (direct chat or task messages of an agent), oldest first. */
  chats: Record<string, ChatMessage[]>;
  /** Per chatKey. */
  historyLoaded: Record<string, boolean>;
  /** Newest first, at most maxStoredEvents. */
  events: AgentEvent[];

  setConnectionStatus(status: ConnectionStatus): void;
  applySnapshot(snapshot: WorldSnapshot): void;
  applyEvent(event: AgentEvent): void;
  /** Also clears the selected agent when it belongs to another project. */
  setSelectedProject(projectId: string | null): void;
  setSelectedAgent(agentId: string | null): void;
  /** Merges a loaded history page with messages that arrived live. `key` is a chatKey. */
  setHistory(key: string, messages: ChatMessage[]): void;
  /** Forget chats (after a reconnect the server may have restarted). */
  resetChats(): void;
}

function snapshotSignature(snapshot: WorldSnapshot): string {
  const agents = snapshot.agents.map((a) => `${a.id}|${a.status}|${a.busy}|${a.queuedCount}|${a.chatOnly}`).join(";");
  const projects = snapshot.projects.map((p) => `${p.id}|${p.archived}`).join(";");
  const tasks = snapshot.tasks.map((t) => `${t.id}|${t.phase}|${t.blockedReason ?? ""}|${t.endReason ?? ""}`).join(";");
  return `${agents}#${projects}#${tasks}#${snapshot.pendingPermissions.length}`;
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
    const key = messageKey(message);
    return { ...chats, [key]: upsert(chats[key], message) };
  }

  const agentId = event.agentId;
  if (agentId === undefined) return chats;
  // Deltas and queue changes only name the message: it is in one of the agent's two lists.
  const keys = [chatKey(agentId, "chat"), chatKey(agentId, "tasks")];

  const delta = readPayload(event, "chat.message_delta", eventPayloadSchemas.chatDelta);
  if (delta !== null) {
    return keys.reduce((next, key) => updateMessage(next, key, delta.messageId, (m) => ({ ...m, text: m.text + delta.delta })), chats);
  }

  const queue = readPayload(event, "agent.queue_changed", eventPayloadSchemas.queueChanged);
  if (queue !== null) {
    let next = chats;
    for (const key of keys) {
      if (queue.cancelledMessageId !== undefined) next = updateMessage(next, key, queue.cancelledMessageId, () => null);
      if (queue.startedMessageId !== undefined) {
        next = updateMessage(next, key, queue.startedMessageId, (m) => ({ ...m, status: "delivered" }));
      }
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
    selectedProjectId: null,
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

    setSelectedProject: (selectedProjectId) =>
      set((state) => {
        const agent = state.snapshot?.agents.find((a) => a.id === state.selectedAgentId);
        return { selectedProjectId, selectedAgentId: agent?.projectId === selectedProjectId ? state.selectedAgentId : null };
      }),

    setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),

    setHistory: (key, messages) =>
      set((state) => {
        const live = state.chats[key] ?? [];
        const liveIds = new Set(live.map((m) => m.id));
        const merged = [...messages.filter((m) => !liveIds.has(m.id)), ...live].sort((a, b) => a.createdAt - b.createdAt);
        return {
          chats: { ...state.chats, [key]: merged },
          historyLoaded: { ...state.historyLoaded, [key]: true },
        };
      }),

    resetChats: () => set({ chats: {}, historyLoaded: {} }),
  };
});
