"use client";

import { openTask } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import type { Task, TaskPriority } from "@/shared/domain/taskTypes.ts";
import { PAUSE } from "@/shared/domain/handoff.ts";
import { phaseLabel, taskTone, type TaskTone } from "@/shared/ui/present.ts";
import { useAgent } from "../hooks.ts";
import { Avatar, Badge, cx, ProgressBar, RelativeTime, type BadgeTone } from "../ui.tsx";

const TONE: Record<TaskTone, { label: string; badge: BadgeTone }> = {
  running: { label: "Running", badge: "signal" },
  paused: { label: "Paused", badge: "warn" },
  waiting: { label: "Waiting", badge: "neutral" },
  done: { label: "Done", badge: "ok" },
  failed: { label: "Failed", badge: "bad" },
};

export function toneOf(task: Task): { label: string; badge: BadgeTone } {
  if (task.endReason === "cancelled") return { label: "Cancelled", badge: "bad" };
  // A permission card is not a pause: the step goes on as soon as I answer it.
  if (task.endReason === null && task.blockedReason === PAUSE.permission) return { label: "Needs your OK", badge: "warn" };
  return TONE[taskTone(task)];
}

const PRIORITY_TONE: Record<TaskPriority, BadgeTone> = { low: "neutral", medium: "neutral", high: "warn", critical: "bad" };

export function PriorityTag({ priority }: { priority: TaskPriority }) {
  return <Badge tone={PRIORITY_TONE[priority]}>{priority.charAt(0).toUpperCase() + priority.slice(1)}</Badge>;
}

/** Progress colour: the working agent's, green when done, amber paused, red failed or cancelled. */
export function progressColor(task: Task, agentColor: string | null): string {
  const tone = taskTone(task);
  if (tone === "done") return "var(--color-ok)";
  if (tone === "paused") return "var(--color-warn)";
  if (tone === "failed") return "var(--color-bad)";
  return agentColor ?? "var(--color-signal)";
}

export function TaskCard({ task, selected = false }: { task: Task; selected?: boolean }) {
  const agent = useAgent(task.assignedAgentId);
  const tone = toneOf(task);
  const needsAnswer = task.question !== null && task.endReason === null;
  return (
    <button
      type="button"
      onClick={() => openTask(task.id)}
      className={cx(
        "well block w-full space-y-2 rounded-xl p-3 text-left transition-colors hover:border-mist-500/25",
        selected && "border-signal/50",
        needsAnswer && "border-warn/50",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Badge tone={tone.badge}>{tone.label}</Badge>
        <PriorityTag priority={task.priority} />
        <span className="ml-auto text-xs text-mist-500">
          <RelativeTime at={task.updatedAt} />
        </span>
      </div>
      <div>
        <p className="truncate text-sm font-medium">{task.title}</p>
        {task.description !== "" && <p className="mt-0.5 line-clamp-2 text-xs text-mist-500">{task.description}</p>}
      </div>
      <ProgressBar value={task.progress} color={progressColor(task, agent === null ? null : ROLE_DEFINITIONS[agent.role].color)} label={`${task.title} progress`} />
      <div className="flex items-center gap-2 text-xs text-mist-300">
        {agent !== null && task.endReason === null && <Avatar agent={agent} size={18} />}
        <span>
          {phaseLabel(task)}
          {agent !== null && task.endReason === null && ` · ${agent.name}`}
        </span>
        {task.iteration > 1 && (
          <span className="ml-auto text-warn">
            Attempt {task.iteration}/{CONFIG.maxIterations}
          </span>
        )}
      </div>
      {needsAnswer ? (
        <p className="rounded-md bg-warn/15 px-2 py-1 text-xs font-medium text-warn">Needs your answer</p>
      ) : (
        task.blockedReason !== null &&
        task.endReason === null && <p className="truncate text-xs text-warn">{task.blockedReason}</p>
      )}
    </button>
  );
}
