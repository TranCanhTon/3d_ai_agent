"use client";

import { Plus, ShieldAlert } from "lucide-react";
import { forwardRef } from "react";
import type { AgentRunnerKind } from "@/shared/config.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { useProjectAgents, useProjectTasks, useSelectedProject } from "../hooks.ts";
import { cx } from "../ui.tsx";
import { ProjectMenu } from "./ProjectMenu.tsx";

/** Shown only for the fakes, so a fake reply is never mistaken for Claude's. */
const RUNNER_LABEL: Record<AgentRunnerKind, string | null> = {
  claude: null,
  echo: "Echo runner",
  scripted: "Scripted runner",
};

function Metric({ label, value, title }: { label: string; value: React.ReactNode; title: string }) {
  return (
    <div className="px-3" title={title}>
      <span className="block text-xs leading-none text-mist-500">{label}</span>
      <span className="mt-1.5 block text-sm font-semibold tabular-nums leading-none text-mist-100">{value}</span>
    </div>
  );
}

function ConnectionDot() {
  const status = useWorldStore((s) => s.connectionStatus);
  const ever = useWorldStore((s) => s.firstSnapshotAt !== null);
  const [label, tone] =
    status === "open" ? ["Connected", "text-ok"] : status === "connecting" || ever ? ["Reconnecting", "text-warn"] : ["Offline", "text-bad"];
  return (
    <span className={cx("inline-flex items-center gap-2 text-xs", tone)} title={`Server ${label.toLowerCase()}`} aria-label={`Server ${label.toLowerCase()}`}>
      <span className={cx("size-2 rounded-full bg-current", status !== "open" && "pulse-dot")} />
      {/* The word only when it is news, or when there is room. */}
      <span className={cx("text-mist-300", status === "open" && "hidden @[72rem]:inline")}>{label}</span>
    </span>
  );
}

/** Across the top between the nav rail and the side panel. The usage limit lives in Settings. */
export const TopBar = forwardRef<HTMLElement>(function TopBar(_props, ref) {
  const project = useSelectedProject();
  const agents = useProjectAgents();
  const tasks = useProjectTasks();
  const runner = useWorldStore((s) => s.snapshot?.runner ?? "claude");
  const runnerLabel = RUNNER_LABEL[runner];
  const pending = useWorldStore((s) => s.snapshot?.pendingPermissions.length ?? 0);
  const active = agents.filter((a) => a.busy).length;
  const open = tasks.filter((t) => t.endReason === null).length;
  const complete = tasks.filter((t) => t.endReason === "done").length;

  return (
    <header ref={ref} className="@container pointer-events-auto flex h-14 min-w-0 shrink-0 items-center gap-3 border-b border-[var(--hairline)] bg-ink-900 px-4">
      <ProjectMenu />
      {runnerLabel !== null && (
        <span className="shrink-0 rounded-md bg-warn/15 px-2 py-1 text-xs font-medium text-warn" title="No Claude calls: fake replies for trying the app">
          {runnerLabel}
        </span>
      )}

      <div className="hidden min-w-0 items-center divide-x divide-[var(--hairline)] @[46rem]:flex">
        <Metric label="Agents" value={agents.length} title="Agents in this project" />
        <Metric label="Active" value={active} title="Agents working right now" />
        <Metric label="Pending" value={open} title="Tasks not finished yet (running, paused or waiting)" />
        <Metric label="Complete" value={complete} title="Tasks the team finished" />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {pending > 0 && (
          <button
            type="button"
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-warn/15 px-2 text-xs font-semibold text-warn hover:bg-warn/25"
            onClick={() => useWorldStore.getState().flashPermissions()}
            aria-label={`${pending} permission request${pending === 1 ? "" : "s"} waiting`}
          >
            <ShieldAlert size={14} />
            {pending}
          </button>
        )}
        <ConnectionDot />
        <button
          type="button"
          className="btn btn-primary"
          disabled={project === null || project.archived}
          title={project?.archived ? "This project is archived" : "New task (N)"}
          onClick={() => useWorldStore.getState().setDialog("task")}
        >
          <Plus size={15} />
          New task
        </button>
      </div>
    </header>
  );
});
