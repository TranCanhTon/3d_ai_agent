"use client";

import { Bot, Plus, ShieldAlert } from "lucide-react";
import { forwardRef } from "react";
import { openTask } from "@/client/backendClient.ts";
import type { AgentRunnerKind } from "@/shared/config.ts";
import { clockTime, phaseLabel, taskGroup } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { useProjectAgents, useProjectTasks, useSelectedProject } from "../hooks.ts";
import { cx } from "../ui.tsx";
import { ProjectMenu } from "./ProjectMenu.tsx";

const RUNNER_LABEL: Record<AgentRunnerKind, string> = {
  claude: "Live · Claude Pro",
  echo: "Echo runner · no Claude calls",
  scripted: "Scripted runner · no Claude calls",
};

function Metric({ label, value, title, onClick }: { label: string; value: React.ReactNode; title?: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="eyebrow block leading-none">{label}</span>
      <span className="mt-1 block max-w-44 truncate text-sm font-medium">{value}</span>
    </>
  );
  return onClick === undefined ? (
    <div className="px-3" title={title}>
      {body}
    </div>
  ) : (
    <button type="button" className="rounded-lg px-3 py-0.5 text-left hover:bg-ink-700/60" title={title} onClick={onClick}>
      {body}
    </button>
  );
}

function ConnectionDot() {
  const status = useWorldStore((s) => s.connectionStatus);
  const ever = useWorldStore((s) => s.firstSnapshotAt !== null);
  const [label, tone] =
    status === "open" ? ["Connected", "text-ok"] : status === "connecting" || ever ? ["Reconnecting", "text-warn"] : ["Offline", "text-bad"];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-xs", tone)} title={`Server ${label.toLowerCase()}`}>
      <span className={cx("size-2 rounded-full bg-current", status !== "open" && "pulse-dot")} />
      <span className="text-mist-300">{label}</span>
    </span>
  );
}

export const TopBar = forwardRef<HTMLElement>(function TopBar(_props, ref) {
  const project = useSelectedProject();
  const agents = useProjectAgents();
  const tasks = useProjectTasks();
  const runner = useWorldStore((s) => s.snapshot?.runner ?? "claude");
  const usage = useWorldStore((s) => s.snapshot?.usage ?? null);
  const pending = useWorldStore((s) => s.snapshot?.pendingPermissions.length ?? 0);
  const busy = agents.filter((a) => a.busy).length;
  const current = tasks.find((t) => taskGroup(t) === "active") ?? null;
  const waiting = tasks.filter((t) => taskGroup(t) === "waiting").length;
  const done = tasks.filter((t) => t.endReason === "done").length;

  return (
    <header ref={ref} className="surface pointer-events-auto flex h-16 shrink-0 items-center gap-3 rounded-2xl px-4">
      <div className="flex shrink-0 items-center gap-2.5">
        <span className="inline-flex size-8 items-center justify-center rounded-lg bg-signal/15 text-signal" aria-hidden>
          <Bot size={18} />
        </span>
        <div className="leading-tight">
          <p className="text-sm font-semibold">AI Agent World</p>
          <p className={cx("text-[11px]", runner === "claude" ? "text-mist-500" : "text-warn")}>{RUNNER_LABEL[runner]}</p>
        </div>
      </div>

      <div className="mx-1 h-8 w-px bg-mist-500/15" />
      <ProjectMenu />

      <div className="hidden min-w-0 items-center divide-x divide-mist-500/15 xl:flex">
        <Metric label="Busy" value={`${busy} / ${agents.length}`} title="Agents working right now" />
        <Metric
          label="Current task"
          value={current === null ? <span className="text-mist-500">None</span> : `${current.title} · ${phaseLabel(current)}`}
          title={current?.title}
          onClick={current === null ? undefined : () => openTask(current.id)}
        />
        <Metric label="Waiting" value={waiting} />
        <Metric label="Done" value={done} />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-3">
        {usage?.limited ? (
          <span className="rounded-md bg-bad/15 px-2 py-1 text-xs font-medium text-bad">
            Limit reached{usage.resetsAt !== null ? `, resets ${clockTime(usage.resetsAt)}` : ""}
          </span>
        ) : (
          runner === "claude" && <span className="text-xs text-mist-500">Pro limit OK</span>
        )}
        {pending > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-warn/15 px-2 py-1 text-xs font-semibold text-warn hover:bg-warn/25"
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
          <kbd className="ml-0.5 rounded bg-ink-950/20 px-1 font-mono text-[10px]">N</kbd>
        </button>
      </div>
    </header>
  );
});
