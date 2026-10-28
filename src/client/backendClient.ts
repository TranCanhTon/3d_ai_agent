// Singleton backend + wiring into the Zustand store. Components call these
// helpers or getBackend() commands; nothing else touches the WebSocket.

import type { AgentBackend } from "@/shared/backend/AgentBackend.ts";
import { CONFIG } from "@/shared/config.ts";
import type { ChatView } from "@/shared/protocol/protocol.ts";
import { chatKey, useWorldStore } from "@/state/useWorldStore.ts";
import { fetchSessionToken, WebSocketAgentBackend } from "./WebSocketAgentBackend.ts";

let backend: WebSocketAgentBackend | null = null;

export function getBackend(): AgentBackend {
  backend ??= new WebSocketAgentBackend({ getToken: fetchSessionToken });
  return backend;
}

function warn(what: string) {
  return (error: unknown) => console.warn(`[backend] ${what}`, error);
}

/**
 * Loads a page of a chat (or the agent's task messages) into the store. Without
 * `older` it loads the latest page; with it, the page before the oldest loaded message.
 */
export async function loadChatPage(agentId: string, view: ChatView, chatId: string | null, older = false): Promise<void> {
  const key = chatKey(agentId, view, chatId);
  const oldest = useWorldStore.getState().chats[key]?.[0];
  const page = await getBackend().getChatHistory({
    agentId,
    view,
    ...(view === "chat" && chatId !== null ? { chatId } : {}),
    ...(older && oldest !== undefined ? { before: oldest.id } : {}),
    limit: view === "tasks" ? CONFIG.chatHistoryMaxLimit : CONFIG.chatHistoryDefaultLimit,
  });
  useWorldStore.getState().setHistory(key, page.messages, page.hasMore);
}

/** Loads a chat or task view once per connection. */
export function ensureChatPage(agentId: string, view: ChatView, chatId: string | null): void {
  if (useWorldStore.getState().chatPages[chatKey(agentId, view, chatId)]?.loaded) return;
  loadChatPage(agentId, view, chatId).catch(warn("history load failed"));
}

export async function loadChatList(agentId: string): Promise<void> {
  const chats = await getBackend().listChats({ agentId });
  useWorldStore.getState().setChatList(agentId, chats);
}

/** Selects an agent (anywhere in the UI) and opens it in the Agents tab. */
export function openAgent(agentId: string): void {
  const store = useWorldStore.getState();
  const agent = store.snapshot?.agents.find((a) => a.id === agentId);
  if (agent !== undefined && agent.projectId !== store.selectedProjectId) store.setSelectedProject(agent.projectId);
  store.setSelectedAgent(agentId);
  store.setActiveTab("agents");
  if (store.chatLists[agentId] === undefined) loadChatList(agentId).catch(warn("chat list load failed"));
}

export function openTask(taskId: string): void {
  const store = useWorldStore.getState();
  const task = store.snapshot?.tasks.find((t) => t.id === taskId);
  if (task !== undefined && task.projectId !== store.selectedProjectId) store.setSelectedProject(task.projectId);
  store.setSelectedTask(taskId);
  store.setActiveTab("tasks");
}

/** Goes back to an earlier chat: the server makes it active so my next message resumes its session. */
export async function switchChat(agentId: string, chatId: string): Promise<void> {
  await getBackend().openChat({ agentId, chatId });
  ensureChatPage(agentId, "chat", chatId);
}

export async function startNewChat(agentId: string): Promise<void> {
  const chat = await getBackend().newChat({ agentId });
  await loadChatList(agentId);
  ensureChatPage(agentId, "chat", chat.id);
}

/** Connects (with automatic reconnects) and mirrors events/snapshots into the store. Returns a disposer. */
export function connectBackend(): () => void {
  getBackend();
  const instance = backend as WebSocketAgentBackend;
  const store = useWorldStore.getState;

  const unsubscribers = [
    instance.subscribe((event) => store().applyEvent(event)),
    instance.subscribeSnapshot((snapshot) => store().applySnapshot(snapshot)),
    instance.subscribeConnectionStatus((status) => {
      store().setConnectionStatus(status);
      if (status === "open") {
        // The server may have restarted with an empty memory: reload what is on screen.
        store().resetChats();
        const selected = store().selectedAgentId;
        if (selected !== null) loadChatList(selected).catch(warn("chat list load failed"));
      }
    }),
  ];

  store().setConnectionStatus(instance.connectionStatus);
  instance.connectAuto();

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    void instance.disconnect();
  };
}
