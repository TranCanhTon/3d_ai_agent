"use client";

import { Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, FolderPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getBackend } from "@/client/backendClient.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useConnected, useSelectedProject } from "../hooks.ts";
import type { Project } from "@/shared/domain/projectTypes.ts";

const NO_PROJECTS: Project[] = [];
import { ConfirmButton, cx, ErrorLine } from "../ui.tsx";

export function ProjectMenu() {
  const project = useSelectedProject();
  const projects = useWorldStore((s) => s.snapshot?.projects ?? NO_PROJECTS);
  const connected = useConnected();
  const [open, setOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

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

  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  const select = (id: string) => {
    useWorldStore.getState().setSelectedProject(id);
    setOpen(false);
  };
  const run = (promise: Promise<unknown>, then?: () => void) => {
    setError(null);
    promise.then(then, (e: unknown) => setError(errorText(e)));
  };

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={project?.rootPath}
        onClick={() => setOpen(!open)}
        className="flex max-w-60 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-ink-700/60"
      >
        <span className="min-w-0">
          <span className="eyebrow block leading-none">Project</span>
          <span className="mt-1 flex items-center gap-1.5 truncate text-sm font-medium">
            {project?.name ?? "No project"}
            {project?.archived && <span className="text-xs font-semibold uppercase text-warn">Archived</span>}
          </span>
        </span>
        <ChevronDown size={14} className="shrink-0 text-mist-500" />
      </button>

      {open && (
        <div role="menu" className="surface absolute left-0 top-full z-40 mt-2 w-80 rounded-xl p-1.5">
          <p className="eyebrow px-2.5 pb-1 pt-1.5">Projects</p>
          {active.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              onClick={() => select(p.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-ink-700/70"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{p.name}</span>
                <span className="block truncate font-mono text-xs text-mist-500">{p.rootPath}</span>
              </span>
              {p.id === project?.id && <Check size={14} className="shrink-0 text-signal" />}
            </button>
          ))}

          {archived.length > 0 && (
            <div className="mt-1 border-t border-mist-500/10 pt-1">
              <button
                type="button"
                aria-expanded={showArchived}
                onClick={() => setShowArchived(!showArchived)}
                className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-mist-500 hover:text-mist-300"
              >
                <ChevronRight size={13} className={cx("transition-transform", showArchived && "rotate-90")} />
                Archived ({archived.length})
              </button>
              {showArchived &&
                archived.map((p) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
                    <button type="button" role="menuitem" className="min-w-0 flex-1 truncate text-left text-sm text-mist-300 hover:text-mist-100" onClick={() => select(p.id)}>
                      {p.name}
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={!connected}
                      onClick={() => run(getBackend().restoreProject({ projectId: p.id }), () => select(p.id))}
                    >
                      <ArchiveRestore size={13} />
                      Restore
                    </button>
                  </div>
                ))}
            </div>
          )}

          <div className="mt-1 space-y-0.5 border-t border-mist-500/10 pt-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                useWorldStore.getState().setDialog("project");
              }}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-ink-700/70"
            >
              <FolderPlus size={15} className="text-signal" />
              New project…
            </button>
            {project !== null && !project.archived && (
              <div className="flex items-center gap-2 px-2.5 py-1.5">
                <Archive size={15} className="text-mist-500" />
                <span className="flex-1 text-sm text-mist-300">Archive this project</span>
                <ConfirmButton
                  confirmLabel="Archive"
                  disabled={!connected}
                  title="Stops its agents and hides it; nothing is deleted"
                  onConfirm={() => run(getBackend().archiveProject({ projectId: project.id }))}
                >
                  Archive…
                </ConfirmButton>
              </div>
            )}
            <div className="px-2.5">
              <ErrorLine error={error} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
