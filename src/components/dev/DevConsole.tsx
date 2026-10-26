"use client";

// Temporary dev page (phase 2). Replaced by the real UI in phase 6.

import { useEffect, useMemo, useRef, useState } from "react";
import { connectBackend, getBackend, selectAgent } from "@/client/backendClient.ts";
import type { ConnectionStatus } from "@/shared/backend/AgentBackend.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";

const EMPTY: ChatMessage[] = [];

const STATUS_STYLE: Record<ConnectionStatus, { dot: string; label: string }> = {
  open: { dot: "bg-ok", label: "Connected" },
  connecting: { dot: "bg-warn", label: "Connecting…" },
  closed: { dot: "bg-bad", label: "Disconnected" },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ConnectionDot() {
  const status = useWorldStore((s) => s.connectionStatus);
  const style = STATUS_STYLE[status];
  return (
    <div className="flex items-center gap-2 text-sm text-mist-300" role="status">
      <span className={`size-2.5 rounded-full ${style.dot}`} aria-hidden />
      {style.label}
    </div>
  );
}

function AgentList() {
  const snapshot = useWorldStore((s) => s.snapshot);
  const selectedAgentId = useWorldStore((s) => s.selectedAgentId);
  if (snapshot === null) return <p className="text-sm text-mist-500">No snapshot yet.</p>;

  return (
    <div className="flex flex-col gap-4">
      {snapshot.projects.map((project) => (
        <section key={project.id} className="flex flex-col gap-2">
          <h2 className="eyebrow">{project.name}</h2>
          <ul className="flex flex-col gap-1.5">
            {snapshot.agents
              .filter((a) => a.projectId === project.id)
              .map((agent) => (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => selectAgent(agent.id)}
                    className={`surface flex w-full items-start gap-3 rounded-lg p-3 text-left ${
                      agent.id === selectedAgentId ? "outline outline-signal" : ""
                    }`}
                  >
                    <span
                      className="mt-1.5 size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: ROLE_DEFINITIONS[agent.role].color }}
                      aria-hidden
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium">{agent.name}</span>
                        <span className="font-mono text-xs text-mist-300">{agent.status}</span>
                      </span>
                      <span className="eyebrow">{ROLE_DEFINITIONS[agent.role].roleLabel}</span>
                      <span className="truncate text-xs text-mist-500">
                        {agent.activity || "—"}
                        {agent.queuedCount > 0 ? ` · ${agent.queuedCount} queued` : ""}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ChatPanel({ agent }: { agent: AgentState }) {
  const messages = useWorldStore((s) => s.chats[agent.id] ?? EMPTY);
  const connected = useWorldStore((s) => s.connectionStatus === "open");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const send = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    setError(null);
    getBackend()
      .sendMessage({ agentId: agent.id, text })
      .catch((e: unknown) => setError(errorText(e)));
  };

  const run = (action: () => Promise<void>) => {
    setError(null);
    action().catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <div className="surface flex min-h-0 flex-1 flex-col rounded-xl">
      <header className="flex items-center justify-between gap-3 border-b border-ink-600 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{agent.name}</div>
          <div className="eyebrow">
            {agent.status}
            {agent.activity ? ` · ${agent.activity}` : ""}
          </div>
        </div>
        <button
          type="button"
          className="rounded-md border border-bad/50 px-3 py-1.5 text-sm text-bad disabled:opacity-40"
          disabled={!agent.busy || !connected}
          onClick={() => run(() => getBackend().stopAgent({ agentId: agent.id }))}
        >
          Stop
        </button>
      </header>

      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {messages.length === 0 && <p className="text-sm text-mist-500">No messages yet.</p>}
        {messages.map((m) => {
          const mine = m.author.kind === "user";
          return (
            <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                  mine ? "bg-ink-600 text-mist-100" : "bg-ink-800 text-mist-100"
                } ${m.status === "error" ? "border border-bad/60" : ""}`}
              >
                {m.text || (m.status === "streaming" ? "…" : "")}
              </div>
              <div className="mt-0.5 flex items-center gap-2 font-mono text-[10.5px] text-mist-500">
                <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
                {m.status !== "complete" && m.status !== "delivered" && <span>{m.status}</span>}
                {m.status === "queued" && (
                  <button
                    type="button"
                    aria-label="Cancel queued message"
                    className="text-bad hover:underline"
                    onClick={() => run(() => getBackend().cancelQueued({ agentId: agent.id, messageId: m.id }))}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form
        className="flex gap-2 border-t border-ink-600 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          className="min-w-0 flex-1 rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-signal"
          placeholder={`Message ${agent.name}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className="rounded-md bg-signal px-4 py-2 text-sm font-medium text-ink-950 disabled:opacity-40"
          disabled={!connected || draft.trim().length === 0}
        >
          Send
        </button>
      </form>
      {error !== null && <p className="px-4 pb-3 text-xs text-bad">{error}</p>}
    </div>
  );
}

function EventLog() {
  const events = useWorldStore((s) => s.events);
  const latest = useMemo(() => events.slice(0, 50), [events]);
  return (
    <div className="surface scroll-thin max-h-72 overflow-x-hidden overflow-y-auto rounded-xl p-3 font-mono text-[11px] leading-relaxed">
      {latest.length === 0 && <p className="text-mist-500">No events yet.</p>}
      {latest.map((e) => (
        <div key={e.id} className="flex min-w-0 gap-2 whitespace-nowrap">
          <span className="text-mist-500">{new Date(e.timestamp).toISOString().slice(11, 23)}</span>
          <span className="text-signal">{e.type}</span>
          <span className="truncate text-mist-300">{e.agentId ?? ""}</span>
          <span className="truncate text-mist-100">{e.message}</span>
        </div>
      ))}
    </div>
  );
}

export function DevConsole() {
  useEffect(() => connectBackend(), []);
  const selectedAgent = useWorldStore((s) => s.snapshot?.agents.find((a) => a.id === s.selectedAgentId) ?? null);

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <p className="eyebrow">Phase 2 · dev console</p>
          <h1 className="text-xl font-semibold">AI Agent World</h1>
        </div>
        <ConnectionDot />
      </header>

      <div className="grid min-h-[28rem] gap-4 md:grid-cols-[18rem_1fr]">
        <AgentList />
        {selectedAgent !== null ? (
          <ChatPanel agent={selectedAgent} />
        ) : (
          <div className="surface flex items-center justify-center rounded-xl p-6 text-sm text-mist-500">
            Select an agent to chat.
          </div>
        )}
      </div>

      <section className="flex flex-col gap-2">
        <h2 className="eyebrow">Events (newest first)</h2>
        <EventLog />
      </section>
    </main>
  );
}
