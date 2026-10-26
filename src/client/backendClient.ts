// Singleton backend + wiring into the Zustand store.

import type { AgentBackend } from "@/shared/backend/AgentBackend.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { fetchSessionToken, WebSocketAgentBackend } from "./WebSocketAgentBackend.ts";

let backend: WebSocketAgentBackend | null = null;

export function getBackend(): AgentBackend {
  backend ??= new WebSocketAgentBackend({ getToken: fetchSessionToken });
  return backend;
}

/** Loads an agent's chat history into the store (once per connection). */
export async function loadChatHistory(agentId: string): Promise<void> {
  const page = await getBackend().getChatHistory({ agentId });
  useWorldStore.getState().setHistory(agentId, page.messages);
}

export function selectAgent(agentId: string | null): void {
  const store = useWorldStore.getState();
  store.setSelectedAgent(agentId);
  if (agentId !== null && !store.historyLoaded[agentId]) {
    loadChatHistory(agentId).catch((error: unknown) => console.warn("[backend] history load failed", error));
  }
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
        if (selected !== null) selectAgent(selected);
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
