"use client";

import { ChevronLeft, Plus } from "lucide-react";
import { useState } from "react";
import { matchesTaskFilter, sortTasks, TASK_FILTERS, taskFilterCounts, type TaskFilter } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { useArchived, useProjectTasks } from "../hooks.ts";
import { Empty, Segmented } from "../ui.tsx";
import { PanelBody } from "./SidePanel.tsx";
import { TaskCard } from "./TaskCard.tsx";
import { TaskDetails } from "./TaskDetails.tsx";

const LABELS: Record<TaskFilter, string> = { all: "All", active: "Active", waiting: "Waiting", done: "Done" };

export function TasksPanel() {
  const tasks = useProjectTasks();
  const archived = useArchived();
  const selectedId = useWorldStore((s) => s.selectedTaskId);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  if (selected !== null) {
    return (
      <PanelBody>
        <button type="button" className="btn btn-sm btn-quiet -ml-2" onClick={() => useWorldStore.getState().setSelectedTask(null)}>
          <ChevronLeft size={14} />
          All tasks
        </button>
        <TaskDetails task={selected} />
      </PanelBody>
    );
  }

  const counts = taskFilterCounts(tasks);
  const shown = sortTasks(tasks).filter((t) => matchesTaskFilter(t, filter));
  return (
    <PanelBody>
      <div className="flex items-center justify-between gap-2">
        <Segmented
          label="Filter tasks"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={TASK_FILTERS.map((f) => ({ value: f, label: `${LABELS[f]} ${counts[f]}` }))}
        />
        <button type="button" className="btn btn-sm btn-primary" disabled={archived} onClick={() => useWorldStore.getState().setDialog("task")}>
          <Plus size={13} />
          New task
        </button>
      </div>
      {shown.length === 0 ? (
        <Empty>{tasks.length === 0 ? "No tasks yet. Give the team one with New task." : `No ${LABELS[filter].toLowerCase()} tasks.`}</Empty>
      ) : (
        <div className="space-y-2">
          {shown.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      )}
    </PanelBody>
  );
}
