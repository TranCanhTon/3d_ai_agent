"use client";

// An agent's task messages (read only), grouped by task, newest task first.

import { useEffect } from "react";
import { ensureChatPage, openTask } from "@/client/backendClient.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import { chatKey, useWorldStore } from "@/state/useWorldStore.ts";
import { useConnected } from "../hooks.ts";
import { Empty } from "../ui.tsx";
import { MessageBubble } from "./Messages.tsx";

const NO_MESSAGES: ChatMessage[] = [];

function TaskHeader({ taskId }: { taskId: string }) {
  const task = useWorldStore((s) => s.snapshot?.tasks.find((t) => t.id === taskId) ?? null);
  return (
    <div className="sticky top-0 z-10 -mx-4 bg-ink-850/95 px-4 py-1.5 backdrop-blur">
      <button type="button" className="truncate text-xs font-semibold text-signal hover:underline" onClick={() => openTask(taskId)}>
        {task?.title ?? "A task"}
      </button>
    </div>
  );
}

export function TaskMessagesView({ agent }: { agent: AgentState }) {
  const key = chatKey(agent.id, "tasks");
  const messages = useWorldStore((s) => s.chats[key] ?? NO_MESSAGES);
  const loaded = useWorldStore((s) => s.chatPages[key]?.loaded ?? false);
  const connected = useConnected();

  useEffect(() => {
    if (connected) ensureChatPage(agent.id, "tasks", null);
  }, [agent.id, connected]);

  // Groups in order of each task's newest message, newest first; messages oldest first inside.
  const groups = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const id = message.taskId ?? "";
    groups.set(id, [...(groups.get(id) ?? []), message]);
  }
  const ordered = [...groups.entries()].sort(([, a], [, b]) => (b.at(-1)?.createdAt ?? 0) - (a.at(-1)?.createdAt ?? 0));
  // Newest task on top, so this list starts at the top (unlike a chat, which sticks to the bottom).
  return (
    <div className="scroll-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 pb-3">
      {loaded && messages.length === 0 && <Empty>{agent.name} has not worked on a task yet.</Empty>}
      {ordered.map(([taskId, list]) => (
        <section key={taskId} className="space-y-2.5 pb-3">
          <TaskHeader taskId={taskId} />
          {list.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </section>
      ))}
    </div>
  );
}
