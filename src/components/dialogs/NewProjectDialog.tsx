"use client";

import { ArrowUp, Folder, GitBranch, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { getBackend } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { FolderEntry, FolderListing } from "@/shared/protocol/protocol.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useConnected } from "../hooks.ts";
import { cx, ErrorLine } from "../ui.tsx";
import { Modal } from "./Modal.tsx";

/** "D:\work\shop" → D:\, D:\work, D:\work\shop (each crumb with its path). */
function crumbs(path: string): { label: string; path: string }[] {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter((p) => p !== "");
  return parts.map((label, index) => {
    const joined = parts.slice(0, index + 1).join(sep);
    return { label, path: sep === "\\" ? (index === 0 ? `${joined}\\` : joined) : `/${joined}` };
  });
}

export function NewProjectDialog() {
  const connected = useConnected();
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<FolderEntry | null>(null);
  const [name, setName] = useState("");
  const [initGit, setInitGit] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  /** Lists a folder; state changes only when the answer arrives. */
  const load = useCallback((path?: string) => {
    getBackend()
      .listFolders(path === undefined ? {} : { path })
      .then(
        (result) => {
          setListing(result);
          setChosen(null);
          setError(null);
        },
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setLoading(false));
  }, []);

  const browse = (path?: string) => {
    setLoading(true);
    load(path);
  };

  useEffect(() => {
    if (connected) load();
  }, [connected, load]);

  const choose = (entry: FolderEntry) => {
    setChosen(entry);
    setName(entry.name.slice(0, CONFIG.projectNameMaxChars));
  };

  const create = () => {
    if (chosen === null || name.trim() === "") return;
    setCreating(true);
    setError(null);
    getBackend()
      .createProject({ name: name.trim(), rootPath: chosen.path, ...(chosen.isGitRepo ? {} : { initGit }) })
      .then(
        (project) => {
          const store = useWorldStore.getState();
          store.setSelectedProject(project.id);
          store.setDialog(null);
          store.setActiveTab("overview");
        },
        (e: unknown) => {
          setError(errorText(e));
          setCreating(false);
        },
      );
  };

  return (
    <Modal
      title="New project"
      width={600}
      footer={
        <div className="flex items-center gap-3">
          <p className="text-[11px] text-mist-500">A project gets its own team of six agents and a notes file in .agentworld/.</p>
          <button type="button" className="btn btn-quiet ml-auto" onClick={() => useWorldStore.getState().setDialog(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!connected || creating || chosen === null || name.trim() === ""} onClick={create}>
            Create project
          </button>
        </div>
      }
    >
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <button type="button" className="btn btn-sm btn-ghost" aria-label="Up one folder" disabled={listing?.parent == null || loading} onClick={() => browse(listing?.parent ?? undefined)}>
            <ArrowUp size={13} />
            Up
          </button>
          <nav aria-label="Folder path" className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-[11.5px] text-mist-300">
            {listing !== null &&
              crumbs(listing.path).map((crumb, index, all) => (
                <span key={crumb.path} className="flex items-center gap-0.5">
                  <button type="button" className="rounded px-1 hover:bg-ink-700 hover:text-mist-100" onClick={() => browse(crumb.path)}>
                    {crumb.label}
                  </button>
                  {index < all.length - 1 && <span className="text-mist-500">/</span>}
                </span>
              ))}
          </nav>
          {loading && <LoaderCircle size={14} className="animate-spin text-signal" />}
        </div>
        <ul className="well scroll-thin h-64 overflow-y-auto rounded-xl p-1" aria-label="Folders">
          {listing?.entries.length === 0 && <li className="px-3 py-6 text-center text-xs text-mist-500">No folders here.</li>}
          {listing?.entries.map((entry) => {
            const reason = entry.hasProject ? "Already a project" : entry.blocked;
            return (
              <li key={entry.path}>
                <div
                  className={cx(
                    "flex items-center gap-2 rounded-lg px-2.5 py-1.5",
                    chosen?.path === entry.path ? "bg-signal/15 ring-1 ring-signal/40" : "hover:bg-ink-700/60",
                    reason !== null && "opacity-50",
                  )}
                >
                  <Folder size={14} className="shrink-0 text-mist-500" />
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    disabled={reason !== null}
                    title={reason ?? `Use ${entry.path}`}
                    onClick={() => choose(entry)}
                  >
                    {entry.name}
                  </button>
                  {entry.isGitRepo && (
                    <span className="inline-flex items-center gap-1 rounded bg-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-ok">
                      <GitBranch size={10} />
                      git
                    </span>
                  )}
                  {reason !== null && <span className="shrink-0 text-[10.5px] text-mist-500">{reason}</span>}
                  <button type="button" className="btn btn-sm btn-quiet shrink-0" aria-label={`Open ${entry.name}`} onClick={() => browse(entry.path)}>
                    Open
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {chosen !== null && (
        <div className="space-y-3">
          <p className="break-all font-mono text-[11.5px] text-mist-300">{chosen.path}</p>
          <label className="block space-y-1.5">
            <span className="eyebrow">Name</span>
            <input className="field" maxLength={CONFIG.projectNameMaxChars} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {!chosen.isGitRepo && (
            <label className="flex items-center gap-2 text-xs text-mist-300">
              <input type="checkbox" className="accent-[var(--color-signal)]" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
              Initialise git (so the reviewer can see a diff)
            </label>
          )}
        </div>
      )}
      <ErrorLine error={error} />
    </Modal>
  );
}
