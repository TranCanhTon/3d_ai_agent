// Zustand mirror of the server's world for the HTML UI, plus UI state (selection,
// tabs, dialogs, the floating panels' insets). Snapshots reach React at most every
// snapshotThrottleMs unless something significant changed (an agent's status, busy
// flag or queue count, a task's phase or pause, a permission card).

import { create } from "zustand";
import { CONFIG } from "@/shared/config.ts";
import type { ConnectionStatus } from "@/shared/backend/AgentBackend.ts";
import type { Chat, ChatMessage } from "@/shared/domain/chatTypes.ts";
import { eventPayloadSchemas, readPayload } from "@/shared/events/eventPayloads.ts";
import type { AgentEvent } from "@/shared/events/eventTypes.ts";
import type { ChatView, WorldSnapshot } from "@/shared/protocol/protocol.ts";

/** Key in `chats`: one of my chats with an agent, or the agent's task messages (its Tasks tab). */
export function chatKey(agentId: string, view: ChatView, chatId: string | null = null): string {
  return view === "tasks" ? `${agentId}#tasks` : `${agentId}@${chatId ?? ""}`;
}

function messageKey(message: ChatMessage): string {
  return message.taskId !== null || message.chatId === null ? chatKey(message.agentId, "tasks") : chatKey(message.agentId, "chat", message.chatId);
}

export const SIDE_TABS = ["overview", "agents", "tasks", "activity", "notes", "settings"] as const;
export type SideTab = (typeof SIDE_TABS)[number];
export const AGENT_TABS = ["chat", "tasks", "activity"] as const;
export type AgentTab = (typeof AGENT_TABS)[number];
export type Dialog = "task" | "project" | null;

/** Pixels the floating UI covers on each side of the world area (for the 3D camera). */
export interface ViewInsets {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ChatPage {
  loaded: boolean;
  /** Older messages exist on the server ("Load older"). */
  hasMore: boolean;
}

const PROJECT_KEY = "aiw.selectedProject";

function readStoredProject(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(PROJECT_KEY);
  } catch {
    return null;
  }
}

function storeProject(projectId: string | null): void {
  try {
    if (projectId === null) window.localStorage.removeItem(PROJECT_KEY);
    else window.localStorage.setItem(PROJECT_KEY, projectId);
  } catch {
    // Storage blocked (private window): the choice just is not remembered.
  }
}

export interface WorldStore {
  connectionStatus: ConnectionStatus;
  /** Epoch ms of the first snapshot of this page load (the loading screen fades out then). */
  firstSnapshotAt: number | null;
  snapshot: WorldSnapshot | null;

  selectedProjectId: string | null;
  selectedAgentId: string | null;
  selectedTaskId: string | null;
  activeTab: SideTab;
  agentTab: AgentTab;
  panelCollapsed: boolean;
  dialog: Dialog;
  viewInsets: ViewInsets;
  /** Bumped to flash the permission stack (the top bar badge). */
  permissionFlash: number;

  /** Per chatKey, oldest first. */
  chats: Record<string, ChatMessage[]>;
  chatPages: Record<string, ChatPage>;
  /** Each agent's chats, newest first (loaded on demand, then kept current by chat.* events). */
  chatLists: Record<string, Chat[]>;
  /** Newest first, at most maxStoredEvents. */
  events: AgentEvent[];

  setConnectionStatus(status: ConnectionStatus): void;
  applySnapshot(snapshot: WorldSnapshot): void;
  applyEvent(event: AgentEvent): void;
  /** Clears the agent and task selection when they belong to another project; remembered in localStorage. */
  setSelectedProject(projectId: string | null): void;
  setSelectedAgent(agentId: string | null): void;
  setSelectedTask(taskId: string | null): void;
  setActiveTab(tab: SideTab): void;
  setAgentTab(tab: AgentTab): void;
  setPanelCollapsed(collapsed: boolean): void;
  setDialog(dialog: Dialog): void;
  setViewInsets(insets: ViewInsets): void;
  flashPermissions(): void;
  /** Merges a loaded history page (older messages first) with messages that arrived live. */
  setHistory(key: string, messages: ChatMessage[], hasMore: boolean): void;
  setChatList(agentId: string, chats: Chat[]): void;
  /** Forget chats (after a reconnect the server may have restarted). */
  resetChats(): void;
}

function snapshotSignature(snapshot: WorldSnapshot): string {
  const agents = snapshot.agents
    .map((a) => `${a.id}|${a.status}|${a.busy}|${a.queuedCount}|${a.chatOnly}|${a.activeChatId}|${a.model}|${a.effort ?? ""}|${a.lastError ?? ""}`)
    .join(";");
  const projects = snapshot.projects.map((p) => `${p.id}|${p.archived}|${p.name}`).join(";");
  const tasks = snapshot.tasks.map((t) => `${t.id}|${t.phase}|${t.blockedReason ?? ""}|${t.endReason ?? ""}|${t.assignedAgentId ?? ""}`).join(";");
  return `${agents}#${projects}#${tasks}#${snapshot.pendingPermissions.map((p) => p.id).join(",")}#${snapshot.usage.limited}`;
}

function upsert(list: ChatMessage[] | undefined, message: ChatMessage): ChatMessage[] {
  const current = list ?? [];
  const index = current.findIndex((m) => m.id === message.id);
  if (index === -1) return [...current, message];
  const next = [...current];
  next[index] = message;
  return next;
}

/** Applies `update` to the message wherever it is among the agent's lists (deltas only name the message). */
function updateAgentMessage(
  chats: Record<string, ChatMessage[]>,
  agentId: string,
  messageId: string,
  update: (message: ChatMessage) => ChatMessage | null,
): Record<string, ChatMessage[]> {
  for (const [key, list] of Object.entries(chats)) {
    if (!key.startsWith(`${agentId}@`) && key !== chatKey(agentId, "tasks")) continue;
    if (!list.some((m) => m.id === messageId)) continue;
    const next = list.flatMap((m) => {
      if (m.id !== messageId) return [m];
      const updated = update(m);
      return updated === null ? [] : [updated];
    });
    return { ...chats, [key]: next };
  }
  return chats;
}

function applyChatEvent(chats: Record<string, ChatMessage[]>, event: AgentEvent): Record<string, ChatMessage[]> {
  const created = readPayload(event, ["chat.message_created", "chat.message_completed"], eventPayloadSchemas.chatMessage);
  if (created !== null) {
    const key = messageKey(created.message);
    return { ...chats, [key]: upsert(chats[key], created.message) };
  }
  const agentId = event.agentId;
  if (agentId === undefined) return chats;

  const delta = readPayload(event, "chat.message_delta", eventPayloadSchemas.chatDelta);
  if (delta !== null) return updateAgentMessage(chats, agentId, delta.messageId, (m) => ({ ...m, text: m.text + delta.delta }));

  const queue = readPayload(event, "agent.queue_changed", eventPayloadSchemas.queueChanged);
  if (queue !== null) {
    let next = chats;
    if (queue.cancelledMessageId !== undefined) next = updateAgentMessage(next, agentId, queue.cancelledMessageId, () => null);
    if (queue.startedMessageId !== undefined) next = updateAgentMessage(next, agentId, queue.startedMessageId, (m) => ({ ...m, status: "delivered" }));
    return next;
  }
  return chats;
}

function sortChats(chats: Chat[]): Chat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

function applyChatListEvent(lists: Record<string, Chat[]>, event: AgentEvent): Record<string, Chat[]> {
  const payload = readPayload(event, ["chat.started", "chat.updated"], eventPayloadSchemas.chat);
  if (payload === null) return lists;
  const { chat } = payload;
  const current = lists[chat.agentId];
  // Not loaded yet: the list is fetched whole when the agent is opened.
  if (current === undefined) return lists;
  return { ...lists, [chat.agentId]: sortChats([chat, ...current.filter((c) => c.id !== chat.id)]) };
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
    set((state) => {
      // Keep the selection valid: a project that exists (stored, else the first active one).
      const projects = snapshot.projects;
      const wanted = state.selectedProjectId ?? readStoredProject();
      const selected = projects.find((p) => p.id === wanted) ?? projects.find((p) => !p.archived) ?? projects[0] ?? null;
      return { snapshot, firstSnapshotAt: state.firstSnapshotAt ?? Date.now(), selectedProjectId: selected?.id ?? null };
    });
  };

  return {
    connectionStatus: "closed",
    firstSnapshotAt: null,
    snapshot: null,
    selectedProjectId: null,
    selectedAgentId: null,
    selectedTaskId: null,
    activeTab: "overview",
    agentTab: "chat",
    panelCollapsed: false,
    dialog: null,
    viewInsets: { left: 0, top: 0, right: 0, bottom: 0 },
    permissionFlash: 0,
    chats: {},
    chatPages: {},
    chatLists: {},
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
        chatLists: applyChatListEvent(state.chatLists, event),
      })),

    setSelectedProject: (selectedProjectId) => {
      storeProject(selectedProjectId);
      set((state) => {
        const agent = state.snapshot?.agents.find((a) => a.id === state.selectedAgentId);
        const task = state.snapshot?.tasks.find((t) => t.id === state.selectedTaskId);
        return {
          selectedProjectId,
          selectedAgentId: agent?.projectId === selectedProjectId ? state.selectedAgentId : null,
          selectedTaskId: task?.projectId === selectedProjectId ? state.selectedTaskId : null,
        };
      });
    },

    setSelectedAgent: (selectedAgentId) => set({ selectedAgentId }),
    setSelectedTask: (selectedTaskId) => set({ selectedTaskId }),
    setActiveTab: (activeTab) => set({ activeTab, panelCollapsed: false }),
    setAgentTab: (agentTab) => set({ agentTab }),
    setPanelCollapsed: (panelCollapsed) => set({ panelCollapsed }),
    setDialog: (dialog) => set({ dialog }),
    setViewInsets: (viewInsets) => {
      const current = get().viewInsets;
      if (current.left === viewInsets.left && current.top === viewInsets.top && current.right === viewInsets.right && current.bottom === viewInsets.bottom) return;
      set({ viewInsets });
    },
    flashPermissions: () => set((state) => ({ permissionFlash: state.permissionFlash + 1 })),

    setHistory: (key, messages, hasMore) =>
      set((state) => {
        const current = state.chats[key] ?? [];
        const known = new Set(current.map((m) => m.id));
        const merged = [...messages.filter((m) => !known.has(m.id)), ...current].sort((a, b) => a.createdAt - b.createdAt);
        return {
          chats: { ...state.chats, [key]: merged },
          chatPages: { ...state.chatPages, [key]: { loaded: true, hasMore } },
        };
      }),

    setChatList: (agentId, chats) => set((state) => ({ chatLists: { ...state.chatLists, [agentId]: sortChats(chats) } })),

    resetChats: () => set({ chats: {}, chatPages: {}, chatLists: {} }),
  };
});
