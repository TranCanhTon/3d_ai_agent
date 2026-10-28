"use client";

// An agent's task messages (read only), grouped by task and read like a chat:
// oldest task at the top, the newest at the bottom, oldest message first inside each.

import { useEffect } from "react";
import { ensureChatPage, loadChatPage, openTask } from "@/client/backendClient.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import { chatKey, useWorldStore } from "@/state/useWorldStore.ts";
import { useConnected } from "../hooks.ts";
import { Empty } from "../ui.tsx";
import { LoadOlder, MessageBubble, MessageList } from "./Messages.tsx";

const NO_MESSAGES: ChatMessage[] = [];

function TaskHeader({ taskId }: { taskId: string }) {
  const task = useWorldStore((s) => s.snapshot?.tasks.find((t) => t.id === taskId) ?? null);
  return (
    <div className="sticky -top-3 z-10 -mx-4 border-b border-[var(--hairline)] bg-ink-900 px-4 py-2">
      <button type="button" className="max-w-full truncate text-[13px] font-semibold text-signal hover:underline" onClick={() => openTask(taskId)}>
        {task?.title ?? "A task"}
      </button>
    </div>
  );
}

/** Messages grouped by task, groups ordered by each task's first message (oldest first). */
function groupByTask(messages: readonly ChatMessage[]): [string, ChatMessage[]][] {
  const groups = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const id = message.taskId ?? "";
    groups.set(id, [...(groups.get(id) ?? []), message]);
  }
  return [...groups.entries()].sort(([, a], [, b]) => (a[0]?.createdAt ?? 0) - (b[0]?.createdAt ?? 0));
}

export function TaskMessagesView({ agent }: { agent: AgentState }) {
  const key = chatKey(agent.id, "tasks");
  const messages = useWorldStore((s) => s.chats[key] ?? NO_MESSAGES);
  const page = useWorldStore((s) => s.chatPages[key]);
  const connected = useConnected();

  useEffect(() => {
    if (connected) ensureChatPage(agent.id, "tasks", null);
  }, [agent.id, connected]);

  const last = messages.at(-1);
  return (
    <MessageList
      resetKey={agent.id}
      contentKey={`${messages.length}:${last?.id ?? ""}:${last?.text.length ?? 0}`}
      top={page?.hasMore === true ? <LoadOlder onLoad={() => loadChatPage(agent.id, "tasks", null, true)} /> : undefined}
    >
      {page?.loaded === true && messages.length === 0 && <Empty>{agent.name} has not worked on a task yet.</Empty>}
      {groupByTask(messages).map(([taskId, list]) => (
        <section key={taskId} className="space-y-4 pb-4">
          <TaskHeader taskId={taskId} />
          {list.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </section>
      ))}
    </MessageList>
  );
}
