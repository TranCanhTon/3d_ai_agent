"use client";

// My chats with one agent: pick or start a chat, read it, write in it. Each chat is
// its own Claude session; all of them share the project folder and the team notes.

import { ChevronDown, MessageSquarePlus, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ensureChatPage, getBackend, loadChatPage, startNewChat, switchChat } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import type { Chat, ChatMessage } from "@/shared/domain/chatTypes.ts";
import { formatTokens, isLongChat } from "@/shared/ui/present.ts";
import { chatKey, useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useConnected } from "../hooks.ts";
import { cx, Empty, ErrorLine, RelativeTime } from "../ui.tsx";
import { LoadOlder, MessageBubble, MessageList } from "./Messages.tsx";

const NO_MESSAGES: ChatMessage[] = [];
const NO_CHATS: Chat[] = [];

function chatName(chat: Chat): string {
  return chat.title === "" ? "New chat" : chat.title;
}

function ChatPicker({ agent, chats, active }: { agent: AgentState; chats: Chat[]; active: Chat | null }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connected = useConnected();
  const root = useRef<HTMLDivElement>(null);
  const archived = useWorldStore((s) => s.snapshot?.projects.find((p) => p.id === agent.projectId)?.archived ?? false);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (promise: Promise<unknown>) => {
    setError(null);
    promise.catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <div className="shrink-0 border-b border-mist-500/10 px-3 py-2">
      <div ref={root} className="relative flex items-center gap-2">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 py-1 text-left hover:bg-ink-700/60"
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{active === null ? "Chat" : chatName(active)}</span>
          <span className="shrink-0 text-[11px] text-mist-500">{chats.length > 1 ? `${chats.length} chats` : ""}</span>
          <ChevronDown size={13} className="shrink-0 text-mist-500" />
        </button>
        {active?.contextTokens != null && (
          <span
            className={cx("shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] tabular-nums", isLongChat(active.contextTokens) ? "bg-warn/15 text-warn" : "bg-ink-700 text-mist-500")}
            title="Context size of this chat (prompt tokens of its latest run)"
          >
            {formatTokens(active.contextTokens)} ctx
          </span>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost shrink-0"
          disabled={!connected || archived}
          title="Start a new chat with a fresh Claude session (files and notes still apply)"
          onClick={() => run(startNewChat(agent.id))}
        >
          <MessageSquarePlus size={13} />
          New chat
        </button>

        {open && (
          <ul role="listbox" aria-label={`${agent.name}'s chats`} className="scroll-thin absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded-xl bg-ink-850 p-1 shadow-2xl ring-1 ring-mist-500/15">
            {chats.map((chat) => (
              <li key={chat.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={chat.id === active?.id}
                  onClick={() => {
                    setOpen(false);
                    if (chat.id !== active?.id) run(switchChat(agent.id, chat.id));
                  }}
                  className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-ink-700/70", chat.id === active?.id && "bg-ink-700/60")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs">{chatName(chat)}</span>
                    <span className="block text-[10.5px] text-mist-500">
                      <RelativeTime at={chat.updatedAt} /> · {chat.messageCount} message{chat.messageCount === 1 ? "" : "s"}
                      {chat.contextTokens !== null && ` · ${formatTokens(chat.contextTokens)} ctx`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {active !== null && isLongChat(active.contextTokens) && (
        <p className="mt-1.5 rounded-md bg-warn/10 px-2 py-1 text-[11px] text-warn">
          This chat is getting long. A new chat starts fresh and uses less of your limit per message.
        </p>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function ChatInput({ agent, chatId }: { agent: AgentState; chatId: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connected = useConnected();
  const archived = useWorldStore((s) => s.snapshot?.projects.find((p) => p.id === agent.projectId)?.archived ?? false);
  const area = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = () => {
    const value = text.trim();
    if (value === "" || !connected || archived) return;
    setError(null);
    getBackend()
      .sendMessage({ agentId: agent.id, text: value, chatId })
      .then(
        () => setText(""),
        (e: unknown) => setError(errorText(e)),
      );
  };
  const near = text.length > CONFIG.maxMessageChars * 0.9;

  return (
    <div className="shrink-0 border-t border-mist-500/10 p-3">
      {agent.busy && !archived && <p className="mb-1.5 text-[11px] text-mist-500">{agent.name} is busy, your message will wait.</p>}
      <div className="flex items-end gap-2">
        <textarea
          ref={area}
          rows={1}
          className="field scroll-thin max-h-40 resize-none"
          placeholder={archived ? "This project is archived" : `Message ${agent.name}`}
          aria-label={`Message ${agent.name}`}
          value={text}
          maxLength={CONFIG.maxMessageChars}
          disabled={archived}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="btn btn-primary !h-9 !px-3" aria-label="Send" disabled={!connected || archived || text.trim() === ""} onClick={send}>
          <Send size={14} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2">
        <ErrorLine error={error} />
        {near && (
          <span className="ml-auto text-[11px] tabular-nums text-warn">
            {text.length}/{CONFIG.maxMessageChars}
          </span>
        )}
      </div>
    </div>
  );
}

export function ChatView({ agent }: { agent: AgentState }) {
  const chatId = agent.activeChatId;
  const key = chatKey(agent.id, "chat", chatId);
  const messages = useWorldStore((s) => s.chats[key] ?? NO_MESSAGES);
  const page = useWorldStore((s) => s.chatPages[key]);
  const chats = useWorldStore((s) => s.chatLists[agent.id] ?? NO_CHATS);
  const connected = useConnected();
  const active = chats.find((c) => c.id === chatId) ?? null;

  useEffect(() => {
    if (connected) ensureChatPage(agent.id, "chat", chatId);
  }, [agent.id, chatId, connected]);

  const last = messages.at(-1);
  return (
    <>
      <ChatPicker agent={agent} chats={chats} active={active} />
      <MessageList
        resetKey={key}
        contentKey={`${last?.id ?? ""}:${last?.text.length ?? 0}:${last?.status ?? ""}`}
        top={page?.hasMore ? <LoadOlder onLoad={() => loadChatPage(agent.id, "chat", chatId, true)} /> : null}
      >
        {page?.loaded && messages.length === 0 && (
          <Empty>
            A fresh chat with {agent.name}. It knows the project folder and the team notes, not your other chats.
          </Empty>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </MessageList>
      <ChatInput agent={agent} chatId={chatId} />
    </>
  );
}
