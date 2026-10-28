"use client";

// Chat message rendering shared by the Chat and Tasks views of an agent:
// bubbles, tool lines, the pin editor and a list that sticks to the bottom.

import {
  ArrowDown,
  Ban,
  Check,
  CircleX,
  FilePen,
  FileText,
  Globe,
  LoaderCircle,
  Pin,
  Search,
  StickyNote,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getBackend } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import { formatTokens } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useConnected } from "../hooks.ts";
import { Avatar, ClockTime, cx, ErrorLine, Markdown } from "../ui.tsx";

const TOOL_ICON: Record<string, LucideIcon> = {
  Read: FileText,
  Grep: Search,
  Glob: Search,
  Edit: FilePen,
  Write: FilePen,
  Bash: Terminal,
  WebSearch: Globe,
  WebFetch: Globe,
  add_note: StickyNote,
};

export function ToolRow({ message }: { message: ChatMessage }) {
  const toolName = message.author.kind === "tool" ? message.author.toolName : "";
  const Icon = TOOL_ICON[toolName] ?? Terminal;
  return (
    <div className="flex items-center gap-2 px-1 py-0.5 text-[11.5px] text-mist-500">
      <Icon size={12} className="shrink-0" aria-label={toolName} />
      <span className={cx("min-w-0 flex-1 truncate font-mono", message.status === "error" && "text-mist-500/70")} title={message.text}>
        {message.text}
      </span>
      {message.status === "streaming" ? (
        <LoaderCircle size={12} className="shrink-0 animate-spin text-signal" aria-label="Running" />
      ) : message.status === "error" ? (
        <X size={12} className="shrink-0 text-bad" aria-label="Not done" />
      ) : (
        <Check size={12} className="shrink-0 text-ok" aria-label="Done" />
      )}
    </div>
  );
}

function PinBox({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const [text, setText] = useState(message.text.replace(/\s+/g, " ").trim().slice(0, CONFIG.noteMaxChars));
  const [error, setError] = useState<string | null>(null);
  const connected = useConnected();
  const save = () => {
    setError(null);
    getBackend()
      .pinToNotes({ messageId: message.id, text: text.trim() })
      .then(onClose, (e: unknown) => setError(errorText(e)));
  };
  return (
    <div className="mt-1.5 space-y-1.5 rounded-lg bg-ink-900/90 p-2 ring-1 ring-signal/30">
      <p className="text-[11px] text-mist-500">Pin to the team notes (every agent reads them)</p>
      <textarea
        className="field min-h-14 resize-y text-xs"
        value={text}
        maxLength={CONFIG.noteMaxChars}
        aria-label="Note text"
        autoFocus
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <span className={cx("text-[11px] tabular-nums", text.length >= CONFIG.noteMaxChars ? "text-warn" : "text-mist-500")}>
          {text.length}/{CONFIG.noteMaxChars}
        </span>
        <ErrorLine error={error} />
        <button type="button" className="btn btn-sm btn-quiet ml-auto" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!connected || text.trim() === ""} onClick={save}>
          <Pin size={12} />
          Pin
        </button>
      </div>
    </div>
  );
}

function Usage({ message }: { message: ChatMessage }) {
  if (message.usage === undefined) return null;
  return (
    <span title={`${message.usage.inputTokens} prompt tokens (cache included), ${message.usage.outputTokens} output tokens`}>
      {formatTokens(message.usage.inputTokens)} in · {formatTokens(message.usage.outputTokens)} out
    </span>
  );
}

export function MessageBubble({ message, header }: { message: ChatMessage; header?: ReactNode }) {
  const [pinning, setPinning] = useState(false);
  const connected = useConnected();
  const archived = useWorldStore((s) => s.snapshot?.projects.find((p) => p.id === message.projectId)?.archived ?? false);
  const fromAgent = useWorldStore((s) =>
    message.author.kind === "handoff" ? (s.snapshot?.agents.find((a) => a.id === (message.author as { fromAgentId: string }).fromAgentId) ?? null) : null,
  );

  if (message.author.kind === "tool") return <ToolRow message={message} />;
  if (message.author.kind === "system") {
    return <p className={cx("px-4 py-1 text-center text-[11.5px]", message.status === "error" ? "text-bad/90" : "text-mist-500")}>{message.text}</p>;
  }

  const mine = message.author.kind === "user";
  const queued = message.status === "queued";
  const streaming = message.status === "streaming";
  const canPin = !archived && connected && !queued && !streaming && message.text.trim() !== "";

  return (
    <div className={cx("group flex flex-col", mine ? "items-end" : "items-start")}>
      {header}
      {fromAgent !== null && (
        <span className="mb-1 flex items-center gap-1.5 text-[11px] text-mist-500">
          <Avatar agent={fromAgent} size={16} />
          From {fromAgent.name}
        </span>
      )}
      <div className="relative max-w-[92%]">
        <div
          className={cx(
            "rounded-2xl px-3 py-2 text-[13px]",
            mine ? "rounded-br-md bg-signal/15 text-mist-100" : "rounded-bl-md bg-ink-800/90 ring-1 ring-mist-500/10",
            queued && "opacity-70",
            message.status === "error" && !mine && "ring-bad/30",
          )}
        >
          {mine ? (
            <p className="whitespace-pre-wrap break-words leading-relaxed">{message.text}</p>
          ) : message.text === "" && streaming ? (
            <span className="caret text-mist-500" aria-label="Typing" />
          ) : (
            <>
              <Markdown text={message.text} />
              {streaming && <span className="caret text-mist-500" aria-label="Typing" />}
            </>
          )}
        </div>
        {canPin && !pinning && (
          <button
            type="button"
            aria-label={message.pinned ? "Pinned to notes; pin again" : "Pin to notes"}
            title={message.pinned ? "Pinned to notes" : "Pin to notes"}
            onClick={() => setPinning(true)}
            className={cx(
              "absolute -top-2 inline-flex size-6 items-center justify-center rounded-full bg-ink-700 text-mist-300 ring-1 ring-mist-500/20 transition-opacity hover:text-signal focus:opacity-100",
              mine ? "-left-2" : "-right-2",
              message.pinned ? "text-signal opacity-100" : "opacity-0 group-hover:opacity-100",
            )}
          >
            <Pin size={11} />
          </button>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-2 px-1 text-[10.5px] text-mist-500">
        {queued ? (
          <>
            <span className="text-warn">Waiting</span>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 hover:text-bad"
              onClick={() => getBackend().cancelQueued({ agentId: message.agentId, messageId: message.id }).catch(() => undefined)}
            >
              <Ban size={10} />
              Cancel
            </button>
          </>
        ) : (
          <ClockTime at={message.createdAt} />
        )}
        {message.status === "error" && mine && (
          <span className="inline-flex items-center gap-0.5 text-bad/80">
            <CircleX size={10} />
            not finished
          </span>
        )}
        {!mine && <Usage message={message} />}
      </div>
      {pinning && (
        <div className="w-full">
          <PinBox message={message} onClose={() => setPinning(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * A scrolling message list that stays at the bottom while I am there; when I scroll
 * up and something new arrives it shows a "New messages" pill instead.
 */
export function MessageList({
  children,
  contentKey,
  resetKey,
  top,
}: {
  children: ReactNode;
  /** Changes whenever the content grows (message count, last text length). */
  contentKey: string;
  /** Changes when a different conversation is shown: jump to its bottom. */
  resetKey: string;
  top?: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);

  const toBottom = () => {
    const el = scroller.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(false);
  };

  useLayoutEffect(() => {
    toBottom();
  }, [resetKey]);

  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
    else setUnseen(true);
  }, [contentKey]);

  useEffect(() => {
    const el = scroller.current;
    if (el === null) return;
    const onScroll = () => {
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      if (atBottom.current) setUnseen(false);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} className="scroll-thin absolute inset-0 space-y-2.5 overflow-y-auto px-4 py-3" aria-live="polite">
        {top}
        {children}
      </div>
      {unseen && (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-signal px-3 py-1 text-xs font-semibold text-ink-950 shadow-lg"
        >
          <ArrowDown size={12} />
          New messages
        </button>
      )}
    </div>
  );
}

/** "Load older" at the top of a list that has more on the server. */
export function LoadOlder({ onLoad }: { onLoad: () => Promise<void> }) {
  const [loading, setLoading] = useState(false);
  return (
    <div className="flex justify-center">
      <button
        type="button"
        className="btn btn-sm btn-quiet"
        disabled={loading}
        onClick={() => {
          setLoading(true);
          onLoad().finally(() => setLoading(false));
        }}
      >
        {loading && <LoaderCircle size={12} className="animate-spin" />}
        Load older
      </button>
    </div>
  );
}
