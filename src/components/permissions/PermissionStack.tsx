"use client";

// Floating permission cards (every project), newest at the bottom, at most 3 shown.

import { ChevronRight, FilePen, Globe, ShieldAlert, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getBackend, openAgent } from "@/client/backendClient.ts";
import type { PermissionRequest } from "@/shared/domain/permissions.ts";
import { permissionPreview } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useAgent, useConnected } from "../hooks.ts";

const NO_REQUESTS: PermissionRequest[] = [];
import { Avatar, cx, ErrorLine, RelativeTime } from "../ui.tsx";

const VISIBLE = 3;

function ToolIcon({ toolName }: { toolName: string }) {
  const Icon = toolName === "Bash" ? Terminal : toolName === "Edit" || toolName === "Write" ? FilePen : toolName.startsWith("Web") ? Globe : ShieldAlert;
  return <Icon size={14} className="shrink-0 text-warn" aria-label={toolName} />;
}

function Details({ request }: { request: PermissionRequest }) {
  const preview = permissionPreview(request);
  const pre = "scroll-thin max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-ink-950/80 p-2 font-mono text-xs leading-relaxed";
  return (
    <div className="space-y-1.5">
      {preview.command !== null && <pre className={pre}>{preview.command}</pre>}
      {preview.filePath !== null && <p className="break-all font-mono text-xs text-mist-300">{preview.filePath}</p>}
      {preview.edit !== null && (
        <div className="space-y-1">
          <pre className={cx(pre, "text-bad/90")}>{preview.edit.oldText}</pre>
          <pre className={cx(pre, "text-ok/90")}>{preview.edit.newText}</pre>
        </div>
      )}
      {preview.content !== null && <pre className={pre}>{preview.content}</pre>}
      {preview.json !== null && <pre className={pre}>{preview.json}</pre>}
    </div>
  );
}

function PermissionCard({ request }: { request: PermissionRequest }) {
  const agent = useAgent(request.agentId);
  const selectedProject = useWorldStore((s) => s.selectedProjectId);
  const projectName = useWorldStore((s) => s.snapshot?.projects.find((p) => p.id === request.projectId)?.name ?? "");
  const task = useWorldStore((s) => (agent?.currentTaskId == null ? null : (s.snapshot?.tasks.find((t) => t.id === agent.currentTaskId) ?? null)));
  const connected = useConnected();
  const [open, setOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = (decision: "allow" | "deny") => {
    setError(null);
    setLeaving(true);
    getBackend()
      .respondPermission({ requestId: request.id, decision })
      .catch((e: unknown) => {
        setLeaving(false);
        setError(errorText(e));
      });
  };

  return (
    <li className={cx("pointer-events-auto w-[360px] space-y-2.5 rounded-xl border border-warn/40 bg-ink-800 p-3 shadow-lg shadow-black/40", leaving ? "card-out" : "card-in")}>
      <div className="flex items-center gap-2">
        {agent !== null && <Avatar agent={agent} size={24} />}
        <div className="min-w-0 flex-1 leading-tight">
          <button type="button" className="truncate text-sm font-medium hover:underline" onClick={() => openAgent(request.agentId)}>
            {agent?.name ?? "An agent"}
          </button>
          <p className="truncate text-xs text-mist-500">
            {request.projectId !== selectedProject && <span className="text-mist-300">{projectName} · </span>}
            {task !== null ? `Task: ${task.title}` : "Direct chat"}
          </p>
        </div>
        <span className="shrink-0 text-xs text-mist-500">
          <RelativeTime at={request.createdAt} />
        </span>
      </div>
      <div className="flex items-start gap-2">
        <ToolIcon toolName={request.toolName} />
        <p className="min-w-0 flex-1 break-words text-xs text-mist-100">{request.summary}</p>
      </div>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs text-mist-500 hover:text-mist-300">
        <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        Details
      </button>
      {open && <Details request={request} />}
      <ErrorLine error={error} />
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="btn btn-sm btn-ghost" disabled={!connected || leaving} onClick={() => answer("deny")}>
          Deny
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!connected || leaving} onClick={() => answer("allow")}>
          Allow
        </button>
      </div>
    </li>
  );
}

export function PermissionStack() {
  const requests = useWorldStore((s) => s.snapshot?.pendingPermissions ?? NO_REQUESTS);
  const flash = useWorldStore((s) => s.permissionFlash);
  const stack = useRef<HTMLElement>(null);

  // The top bar badge was clicked: replay the flash animation on the stack.
  useEffect(() => {
    const el = stack.current;
    if (flash === 0 || el === null) return;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
  }, [flash]);

  if (requests.length === 0) return null;
  // Oldest first in the snapshot; show the newest VISIBLE with the newest at the bottom.
  const shown = requests.slice(-VISIBLE);
  const hidden = requests.length - shown.length;
  return (
    <section ref={stack} aria-label="Permission requests" className="absolute right-4 top-4 z-20 rounded-xl">
      <ul className="flex flex-col gap-2">
        {hidden > 0 && (
          <li className="pointer-events-auto self-end rounded-md bg-ink-800 px-2 py-1 text-xs text-warn ring-1 ring-warn/30">
            {hidden} more waiting
          </li>
        )}
        {shown.map((request) => (
          <PermissionCard key={request.id} request={request} />
        ))}
      </ul>
    </section>
  );
}
