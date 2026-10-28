"use client";

import { useState } from "react";
import { getBackend, openTask } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import { TASK_PRIORITIES, type TaskPriority } from "@/shared/domain/taskTypes.ts";
import { taskGroup } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useConnected, useProjectTasks, useSelectedProject } from "../hooks.ts";
import { ErrorLine, Segmented } from "../ui.tsx";
import { Modal } from "./Modal.tsx";

export function NewTaskDialog() {
  const project = useSelectedProject();
  const tasks = useProjectTasks();
  const connected = useConnected();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = tasks.some((t) => taskGroup(t) === "active");

  const submit = () => {
    if (project === null || title.trim() === "") return;
    setSending(true);
    setError(null);
    getBackend()
      .submitTask({ projectId: project.id, title: title.trim(), description: description.trim(), priority })
      .then(
        (task) => {
          useWorldStore.getState().setDialog(null);
          openTask(task.id);
        },
        (e: unknown) => {
          setError(errorText(e));
          setSending(false);
        },
      );
  };

  return (
    <Modal
      title="New task"
      footer={
        <div className="flex items-center gap-3">
          <p className="text-xs leading-snug text-mist-500">Runs on your Claude Pro plan. Agents ask before editing files or running commands.</p>
          <button type="button" className="btn btn-quiet ml-auto" onClick={() => useWorldStore.getState().setDialog(null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!connected || sending || title.trim() === "" || project === null} onClick={submit}>
            Give it to the team
          </button>
        </div>
      }
    >
      <p className="text-xs text-mist-500">
        For <span className="text-mist-300">{project?.name ?? "no project"}</span>. The orchestrator turns it into a brief, then the team plans, builds, tests and
        reviews it.
      </p>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="block space-y-1.5">
          <span className="eyebrow">Title</span>
          <input
            className="field"
            required
            maxLength={CONFIG.maxTaskTitleChars}
            placeholder="Add a dark mode toggle to the header"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="eyebrow">Description</span>
          <textarea
            className="field min-h-28 resize-y"
            maxLength={CONFIG.maxMessageChars}
            placeholder="What should change, where, and how you will know it works"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <div className="space-y-1.5">
          <span className="eyebrow block">Priority</span>
          <Segmented label="Priority" value={priority} onChange={setPriority} options={TASK_PRIORITIES.map((p) => ({ value: p, label: p[0]?.toUpperCase() + p.slice(1) }))} />
        </div>
        {busy && <p className="rounded-lg bg-ink-800 px-3 py-2 text-xs text-mist-300">A task is already running. This one will wait until the current task finishes.</p>}
        <ErrorLine error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
