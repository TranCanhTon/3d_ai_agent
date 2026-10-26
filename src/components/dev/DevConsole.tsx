"use client";

// Temporary dev page. Replaced by the real UI in phase 6.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectBackend, getBackend, selectAgent } from "@/client/backendClient.ts";
import type { ConnectionStatus } from "@/shared/backend/AgentBackend.ts";
import { CONFIG } from "@/shared/config.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import type { PermissionRequest } from "@/shared/domain/permissions.ts";
import type { Project } from "@/shared/domain/projectTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import type { FolderEntry, FolderListing } from "@/shared/protocol/protocol.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";

const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_REQUESTS: PermissionRequest[] = [];
const EMPTY_PROJECTS: Project[] = [];
const API_BILLING_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"]);

const STATUS_STYLE: Record<ConnectionStatus, { dot: string; label: string }> = {
  open: { dot: "bg-ok", label: "Connected" },
  connecting: { dot: "bg-warn", label: "Connecting…" },
  closed: { dot: "bg-bad", label: "Disconnected" },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
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

function RunnerInfo() {
  const runner = useWorldStore((s) => s.snapshot?.runner ?? null);
  const authSource = useWorldStore((s) => s.snapshot?.auth.source ?? null);
  if (runner === null) return null;
  const auth =
    authSource === null ? "auth: not checked yet" : authSource === "none" ? "auth: Claude subscription" : `auth: ${authSource}`;
  const billing = authSource !== null && API_BILLING_SOURCES.has(authSource);
  return (
    <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
      <span className="rounded border border-ink-600 px-1.5 py-0.5 text-mist-300">runner: {runner}</span>
      {runner === "claude" && (
        <span className={`rounded border px-1.5 py-0.5 ${billing ? "border-bad text-bad" : "border-ink-600 text-mist-300"}`}>
          {auth}
        </span>
      )}
    </div>
  );
}

function UsageBanner() {
  const usage = useWorldStore((s) => s.snapshot?.usage ?? null);
  if (usage === null || !usage.limited) return null;
  return (
    <div className="rounded-lg border border-bad/50 bg-bad/10 px-4 py-2 text-sm text-bad" role="alert">
      Claude usage limit reached
      {usage.resetsAt !== null ? `, resets at ${new Date(usage.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}.
    </div>
  );
}

/** The selected project, falling back to the first active one. */
function useSelectedProject(): Project | null {
  const projects = useWorldStore((s) => s.snapshot?.projects ?? EMPTY_PROJECTS);
  const selectedProjectId = useWorldStore((s) => s.selectedProjectId);
  return projects.find((p) => p.id === selectedProjectId) ?? projects.find((p) => !p.archived) ?? null;
}

const BUTTON = "rounded-md border border-ink-600 px-3 py-1.5 text-sm text-mist-100 hover:border-signal disabled:opacity-40";

function ProjectBar({ project, onNewProject }: { project: Project | null; onNewProject: () => void }) {
  const projects = useWorldStore((s) => s.snapshot?.projects ?? EMPTY_PROJECTS);
  const setSelectedProject = useWorldStore((s) => s.setSelectedProject);
  const connected = useWorldStore((s) => s.connectionStatus === "open");
  const [error, setError] = useState<string | null>(null);
  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);

  const run = (action: Promise<unknown>) => {
    setError(null);
    action.catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <section className="surface flex flex-col gap-2 rounded-xl p-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="eyebrow" htmlFor="project-select">
          Project
        </label>
        <select
          id="project-select"
          className="min-w-0 rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-sm"
          value={project?.archived === false ? project.id : ""}
          onChange={(e) => setSelectedProject(e.target.value)}
        >
          {active.length === 0 && <option value="">No active projects</option>}
          {active.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {project !== null && !project.archived && (
          <span className="truncate font-mono text-[11px] text-mist-500" title={project.rootPath}>
            {project.rootPath}
            {project.isGitRepo ? " · git" : " · no git"}
          </span>
        )}
        <span className="flex-1" />
        <button type="button" className={BUTTON} disabled={!connected} onClick={onNewProject}>
          New project
        </button>
        <button
          type="button"
          className="rounded-md border border-bad/50 px-3 py-1.5 text-sm text-bad disabled:opacity-40"
          disabled={!connected || project === null || project.archived}
          onClick={() => {
            if (project === null) return;
            if (!window.confirm(`Archive "${project.name}"? Running agents stop; its data is kept and you can restore it.`)) return;
            run(getBackend().archiveProject({ projectId: project.id }));
          }}
        >
          Archive
        </button>
      </div>
      {archived.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-mist-500">Archived ({archived.length})</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {archived.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <span className="truncate">{p.name}</span>
                <span className="truncate font-mono text-[11px] text-mist-500">{p.rootPath}</span>
                <span className="flex-1" />
                <button
                  type="button"
                  className="text-xs text-signal hover:underline disabled:opacity-40"
                  disabled={!connected}
                  onClick={() => {
                    run(getBackend().restoreProject({ projectId: p.id }));
                    setSelectedProject(p.id);
                  }}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error !== null && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}

/** Path prefixes from the browser root down to `path`, for the breadcrumb. */
function breadcrumb(path: string): { label: string; path: string }[] {
  const root = CONFIG.folderBrowserRoot.replace(/[\\/]+$/, "").toLowerCase();
  const parts = path.split(/[\\/]+/).filter((p) => p !== "");
  const crumbs: { label: string; path: string }[] = [];
  let current = "";
  for (const part of parts) {
    current = current === "" ? (/^[a-zA-Z]:$/.test(part) ? `${part}\\` : part) : `${current.replace(/\\$/, "")}\\${part}`;
    if (current.replace(/[\\/]+$/, "").toLowerCase().length >= root.length) crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function NewProjectPanel({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [chosen, setChosen] = useState<FolderEntry | null>(null);
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((path?: string) => {
    getBackend()
      .listFolders(path === undefined ? {} : { path })
      .then((next) => {
        setListing(next);
        setError(null);
      })
      .catch((e: unknown) => setError(errorText(e)));
  }, []);
  const open = (path?: string) => load(path);

  useEffect(() => load(), [load]);

  const choose = (entry: FolderEntry) => {
    setChosen(entry);
    setName(entry.name.slice(0, CONFIG.projectNameMaxChars));
    setInitGit(true);
  };

  const create = () => {
    if (chosen === null) return;
    setBusy(true);
    setError(null);
    getBackend()
      .createProject({ name: name.trim(), rootPath: chosen.path, ...(chosen.isGitRepo ? {} : { initGit }) })
      .then(onCreated)
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="surface flex flex-col gap-3 rounded-xl p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="font-medium">New project</h2>
        <button type="button" className="text-sm text-mist-500 hover:text-mist-100" onClick={onClose}>
          Close
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-1 font-mono text-xs">
        <button
          type="button"
          className={BUTTON}
          disabled={listing?.parent == null}
          onClick={() => listing?.parent != null && open(listing.parent)}
          aria-label="Up one folder"
        >
          ↑ Up
        </button>
        {listing !== null &&
          breadcrumb(listing.path).map((crumb, i, all) => (
            <span key={crumb.path} className="flex items-center gap-1">
              <button type="button" className="text-signal hover:underline" onClick={() => open(crumb.path)}>
                {crumb.label}
              </button>
              {i < all.length - 1 && <span className="text-mist-500">\</span>}
            </span>
          ))}
      </div>

      <ul className="scroll-thin flex max-h-72 flex-col gap-1 overflow-y-auto">
        {listing !== null && listing.entries.length === 0 && <li className="text-sm text-mist-500">No folders here.</li>}
        {listing?.entries.map((entry) => (
          <li
            key={entry.path}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
              chosen?.path === entry.path ? "bg-ink-700 outline outline-signal" : "hover:bg-ink-800"
            } ${entry.blocked !== null ? "opacity-50" : ""}`}
          >
            <button type="button" className="min-w-0 truncate text-left hover:underline" onClick={() => open(entry.path)} title="Open folder">
              📁 {entry.name}
            </button>
            {entry.isGitRepo && <span className="rounded border border-ok/50 px-1 text-[10px] text-ok">git</span>}
            {entry.hasProject && <span className="rounded border border-warn/50 px-1 text-[10px] text-warn">used</span>}
            {entry.blocked !== null && <span className="truncate text-[11px] text-mist-500">{entry.blocked}</span>}
            <span className="flex-1" />
            <button
              type="button"
              className="shrink-0 text-xs text-signal hover:underline disabled:text-mist-500 disabled:no-underline"
              disabled={entry.blocked !== null}
              onClick={() => choose(entry)}
            >
              Choose
            </button>
          </li>
        ))}
      </ul>

      {chosen !== null && (
        <form
          className="flex flex-col gap-2 border-t border-ink-600 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
        >
          <div className="font-mono text-xs text-mist-300">{chosen.path}</div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="eyebrow">Name</span>
            <input
              className="rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm outline-none focus:border-signal"
              value={name}
              maxLength={CONFIG.projectNameMaxChars}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {!chosen.isGitRepo && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
              Run git init in this folder
            </label>
          )}
          <div>
            <button
              type="submit"
              className="rounded-md bg-signal px-4 py-2 text-sm font-medium text-ink-950 disabled:opacity-40"
              disabled={busy || name.trim().length === 0}
            >
              Create
            </button>
          </div>
        </form>
      )}
      {error !== null && <p className="text-xs text-bad">{error}</p>}
    </section>
  );
}

function NotesPanel({ project }: { project: Project }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connected = useWorldStore((s) => s.connectionStatus === "open");
  // The newest notes.updated event for this project; a new one triggers a reload.
  const lastUpdate = useWorldStore((s) => s.events.find((e) => e.type === "notes.updated" && e.projectId === project.id)?.id ?? null);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    getBackend()
      .getNotes({ projectId: project.id })
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, lastUpdate, connected]);

  return (
    <section className="flex flex-col gap-2">
      <h2 className="eyebrow">Team notes · {project.name}</h2>
      <pre className="surface scroll-thin max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-xl p-3 font-mono text-xs text-mist-300">
        {error ?? (content === null ? "Loading…" : content.trim() === "" ? "No notes yet." : content)}
      </pre>
    </section>
  );
}

function AgentList({ project }: { project: Project | null }) {
  const snapshot = useWorldStore((s) => s.snapshot);
  const selectedAgentId = useWorldStore((s) => s.selectedAgentId);
  if (snapshot === null) return <p className="text-sm text-mist-500">No snapshot yet.</p>;
  if (project === null) return <p className="text-sm text-mist-500">No active project.</p>;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="eyebrow">{project.name}</h2>
      <ul className="flex flex-col gap-1.5">
        {snapshot.agents
          .filter((a) => a.projectId === project.id)
          .map((agent) => {
            const pending = snapshot.pendingPermissions.filter((p) => p.agentId === agent.id).length;
            return (
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
                      <span className="flex shrink-0 items-center gap-1.5">
                        {pending > 0 && (
                          <span
                            className="rounded-full bg-warn px-1.5 text-[11px] font-semibold text-ink-950"
                            aria-label={`${pending} permission requests`}
                          >
                            {pending}
                          </span>
                        )}
                        <span className="font-mono text-xs text-mist-300">{agent.status}</span>
                      </span>
                    </span>
                    <span className="eyebrow">
                      {ROLE_DEFINITIONS[agent.role].roleLabel}
                      {agent.chatOnly ? " · chat only" : ""}
                    </span>
                    <span className="truncate text-xs text-mist-500">
                      {agent.activity || "—"}
                      {agent.queuedCount > 0 ? ` · ${agent.queuedCount} queued` : ""}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
      </ul>
    </section>
  );
}

function PermissionCard({ request, onError }: { request: PermissionRequest; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const answer = (decision: "allow" | "deny") => {
    setBusy(true);
    getBackend()
      .respondPermission({ requestId: request.id, decision })
      .catch((e: unknown) => {
        setBusy(false);
        onError(errorText(e));
      });
  };
  return (
    <div className="rounded-lg border border-warn/60 bg-warn/5 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow text-warn">Needs your OK · {request.toolName}</span>
      </div>
      <p className="mt-1 break-words text-mist-100">{request.summary}</p>
      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-mist-500">Raw input</summary>
        <pre className="scroll-thin mt-1 max-h-48 overflow-auto rounded bg-ink-900 p-2 font-mono text-[11px] text-mist-300">
          {JSON.stringify(request.input, null, 2)}
        </pre>
      </details>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("allow")}
          className="rounded-md bg-ok px-3 py-1.5 text-sm font-medium text-ink-950 disabled:opacity-40"
        >
          Allow
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => answer("deny")}
          className="rounded-md border border-bad/60 px-3 py-1.5 text-sm text-bad disabled:opacity-40"
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function PinBox({ message, onDone, onError }: { message: ChatMessage; onDone: () => void; onError: (m: string) => void }) {
  const [text, setText] = useState(message.text.slice(0, CONFIG.noteMaxChars));
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    getBackend()
      .pinToNotes({ messageId: message.id, text: text.trim() })
      .then(onDone)
      .catch((e: unknown) => {
        setBusy(false);
        onError(errorText(e));
      });
  };
  return (
    <form
      className="mt-1 flex w-full max-w-[85%] flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <textarea
        className="rounded-md border border-ink-600 bg-ink-900 px-2 py-1.5 text-xs outline-none focus:border-signal"
        rows={2}
        maxLength={CONFIG.noteMaxChars}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Note text"
      />
      <div className="flex items-center gap-2 text-xs">
        <button type="submit" className="rounded bg-signal px-2 py-1 font-medium text-ink-950 disabled:opacity-40" disabled={busy || text.trim() === ""}>
          Save
        </button>
        <button type="button" className="text-mist-500 hover:text-mist-100" onClick={onDone}>
          Cancel
        </button>
        <span className="text-mist-500">
          {text.length}/{CONFIG.noteMaxChars}
        </span>
      </div>
    </form>
  );
}

function MessageView({ message, agentId, onError }: { message: ChatMessage; agentId: string; onError: (m: string) => void }) {
  const kind = message.author.kind;
  const [pinning, setPinning] = useState(false);

  if (kind === "tool") {
    const icon = message.status === "streaming" ? "…" : message.status === "error" ? "✗" : "✓";
    return (
      <div className="flex items-center gap-2 pl-1 font-mono text-[11px] text-mist-500">
        <span aria-hidden>{icon}</span>
        <span className="truncate">{message.text}</span>
      </div>
    );
  }

  if (kind === "system") {
    if (message.status !== "error") {
      return <div className="py-1 text-center font-mono text-[11px] text-mist-500">— {message.text} —</div>;
    }
    return (
      <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad" role="alert">
        {message.text}
      </div>
    );
  }

  const mine = kind === "user";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
          mine ? "bg-ink-600 text-mist-100" : "bg-ink-800 text-mist-100"
        } ${message.status === "error" ? "border border-bad/60" : ""}`}
      >
        {message.text || (message.status === "streaming" ? "…" : "")}
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-mist-500">
        <span>{new Date(message.createdAt).toLocaleTimeString()}</span>
        {message.status !== "complete" && message.status !== "delivered" && <span>{message.status}</span>}
        {message.usage !== undefined && (
          <span title="Tokens used by this run">
            {formatTokens(message.usage.inputTokens)} in · {formatTokens(message.usage.outputTokens)} out
          </span>
        )}
        {message.status === "queued" && (
          <button
            type="button"
            aria-label="Cancel queued message"
            className="text-bad hover:underline"
            onClick={() => getBackend().cancelQueued({ agentId, messageId: message.id }).catch((e: unknown) => onError(errorText(e)))}
          >
            ✕
          </button>
        )}
        {message.pinned && <span className="text-warn">pinned</span>}
        {!pinning && message.text.trim() !== "" && message.status !== "streaming" && (
          <button type="button" className="text-signal hover:underline" onClick={() => setPinning(true)}>
            Pin
          </button>
        )}
      </div>
      {pinning && <PinBox message={message} onDone={() => setPinning(false)} onError={onError} />}
    </div>
  );
}

function ChatPanel({ agent }: { agent: AgentState }) {
  const messages = useWorldStore((s) => s.chats[agent.id] ?? EMPTY_MESSAGES);
  const allRequests = useWorldStore((s) => s.snapshot?.pendingPermissions ?? EMPTY_REQUESTS);
  const requests = useMemo(() => allRequests.filter((r) => r.agentId === agent.id), [allRequests, agent.id]);
  const connected = useWorldStore((s) => s.connectionStatus === "open");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll only the chat pane (scrollIntoView would also scroll the page and move the Stop button).
  useEffect(() => {
    const pane = scrollRef.current;
    if (pane !== null) pane.scrollTop = pane.scrollHeight;
  }, [messages, requests]);

  const send = () => {
    const text = draft.trim();
    if (text.length === 0) return;
    setDraft("");
    setError(null);
    getBackend()
      .sendMessage({ agentId: agent.id, text })
      .catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <div className="surface flex min-h-0 flex-1 flex-col rounded-xl">
      <header className="flex items-center justify-between gap-3 border-b border-ink-600 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{agent.name}</div>
          <div className="eyebrow truncate">
            {agent.status}
            {agent.activity ? ` · ${agent.activity}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          <label className="flex items-center gap-1.5 text-xs text-mist-300" title="No tools at all from the next message">
            <input
              type="checkbox"
              checked={agent.chatOnly}
              disabled={!connected}
              onChange={(e) => {
                setError(null);
                getBackend()
                  .setChatOnly({ agentId: agent.id, chatOnly: e.target.checked })
                  .catch((err: unknown) => setError(errorText(err)));
              }}
            />
            Chat only
          </label>
          <button
            type="button"
            className={BUTTON}
            disabled={agent.busy || !connected}
            title={agent.busy ? "Stop the agent first" : "The next message starts a new Claude session"}
            onClick={() => {
              if (!window.confirm(`Start a new session for ${agent.name}? It forgets this conversation (the team notes still apply).`)) return;
              setError(null);
              getBackend()
                .resetAgentSession({ agentId: agent.id })
                .catch((e: unknown) => setError(errorText(e)));
            }}
          >
            Reset session
          </button>
          <button
            type="button"
            className="rounded-md border border-bad/50 px-3 py-1.5 text-sm text-bad disabled:opacity-40"
            disabled={!agent.busy || !connected}
            onClick={() => {
              setError(null);
              getBackend()
                .stopAgent({ agentId: agent.id })
                .catch((e: unknown) => setError(errorText(e)));
            }}
          >
            Stop
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="scroll-thin flex max-h-[60vh] min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {messages.length === 0 && requests.length === 0 && <p className="text-sm text-mist-500">No messages yet.</p>}
        {messages.map((m) => (
          <MessageView key={m.id} message={m} agentId={agent.id} onError={setError} />
        ))}
        {requests.map((r) => (
          <PermissionCard key={r.id} request={r} onError={setError} />
        ))}
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
  const project = useSelectedProject();
  const setSelectedProject = useWorldStore((s) => s.setSelectedProject);
  const [creating, setCreating] = useState(false);
  const selectedAgent = useWorldStore(
    (s) => s.snapshot?.agents.find((a) => a.id === s.selectedAgentId && a.projectId === project?.id) ?? null,
  );

  return (
    <main className="mx-auto flex min-h-dvh max-w-6xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="eyebrow">Dev console</p>
          <h1 className="text-xl font-semibold">AI Agent World</h1>
          <RunnerInfo />
        </div>
        <ConnectionDot />
      </header>

      <UsageBanner />

      <ProjectBar project={project} onNewProject={() => setCreating(true)} />
      {creating && (
        <NewProjectPanel
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false);
            setSelectedProject(created.id);
          }}
        />
      )}

      <div className="grid min-h-[28rem] gap-4 md:grid-cols-[18rem_1fr]">
        <AgentList project={project} />
        {selectedAgent !== null ? (
          <ChatPanel agent={selectedAgent} />
        ) : (
          <div className="surface flex items-center justify-center rounded-xl p-6 text-sm text-mist-500">
            Select an agent to chat.
          </div>
        )}
      </div>

      {project !== null && <NotesPanel project={project} />}

      <section className="flex flex-col gap-2">
        <h2 className="eyebrow">Events (newest first)</h2>
        <EventLog />
      </section>
    </main>
  );
}
