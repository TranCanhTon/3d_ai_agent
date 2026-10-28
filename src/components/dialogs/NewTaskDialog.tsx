"use client";

import { useState } from "react";
import { getBackend } from "@/client/backendClient.ts";
import { CONFIG, type ModelSetting } from "@/shared/config.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import { AGENT_ROLES } from "@/shared/domain/roles.ts";
import { TASK_PRIORITIES, type TaskPriority, type TaskTeam } from "@/shared/domain/taskTypes.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useConnected, useProjectAgents, useSelectedProject } from "../hooks.ts";
import { ModelPicker, modelSettingLabel } from "../ModelPicker.tsx";
import { Avatar, ErrorLine, Segmented } from "../ui.tsx";
import { Modal } from "./Modal.tsx";

/** Each agent's chat picker setting when the dialog opens. */
function teamOf(agents: readonly AgentState[]): TaskTeam {
  const team = structuredClone(CONFIG.roleModelDefaults);
  for (const agent of agents) team[agent.role] = { model: agent.model, effort: agent.effort };
  return team;
}

/** Six columns: each agent's model and effort for this task (locked once the task is created). */
function TeamPicker({ agents, team, onChange }: { agents: AgentState[]; team: TaskTeam; onChange: (team: TaskTeam) => void }) {
  const byRole = new Map(agents.map((a) => [a.role, a]));
  const first = team[AGENT_ROLES[0]];
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Team</span>
        <ModelPicker
          value={first}
          up
          align="right"
          buttonClassName="text-xs text-mist-300 underline-offset-2 hover:text-mist-100 hover:underline"
          ariaLabel="Set all agents' model and effort"
          note="Applies to all six agents."
          onChange={(setting) => onChange(Object.fromEntries(AGENT_ROLES.map((role) => [role, { ...setting }])) as TaskTeam)}
        >
          Set all
        </ModelPicker>
      </div>
      <div className="grid grid-cols-6 gap-1.5">
        {AGENT_ROLES.map((role, index) => {
          const agent = byRole.get(role);
          const setting = team[role];
          const [model, effort] = modelSettingLabel(setting).split(" · ");
          return (
            <div key={role} className="flex min-w-0 flex-col items-center gap-1.5 rounded-lg bg-ink-850 px-1 py-2">
              {agent !== undefined && <Avatar agent={agent} size={28} />}
              <span className="w-full truncate text-center text-xs text-mist-300" title={agent?.name}>
                {agent?.name.split(" ")[0] ?? role}
              </span>
              <ModelPicker
                value={setting}
                up
                align={index < 2 ? "left" : index > 3 ? "right" : "center"}
                ariaLabel={`${agent?.name ?? role}: ${modelSettingLabel(setting)}`}
                buttonClassName="w-full rounded-md bg-ink-700 px-1 py-1 text-center text-xs leading-tight text-mist-100 hover:bg-ink-600"
                onChange={(next: ModelSetting) => onChange({ ...team, [role]: next })}
              >
                <span className="block truncate font-medium">{model}</span>
                <span className="block truncate text-mist-500">{effort}</span>
              </ModelPicker>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-mist-500">Locked for this task once it is created. Changing an agent later in the Agents tab does not change this task.</p>
    </div>
  );
}

export function NewTaskDialog() {
  const project = useSelectedProject();
  const agents = useProjectAgents();
  const connected = useConnected();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  // The defaults are read once, when the dialog opens.
  const [team, setTeam] = useState<TaskTeam>(() => teamOf(agents));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const orchestrator = agents.find((a) => a.role === "orchestrator") ?? null;

  const submit = () => {
    if (project === null || title.trim() === "") return;
    setSending(true);
    setError(null);
    getBackend()
      .submitTask({ projectId: project.id, title: title.trim(), description: description.trim(), priority, team })
      .then(
        () => {
          const store = useWorldStore.getState();
          store.setDialog(null);
          // sONion Ring confirms the task with me in his chat.
          if (orchestrator !== null) {
            store.setSelectedAgent(orchestrator.id);
            store.setAgentView("chat");
            store.setActiveTab("agents");
          }
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
      width={600}
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
        For <span className="text-mist-300">{project?.name ?? "no project"}</span>. {orchestrator?.name ?? "The orchestrator"} confirms it with you in the chat; the
        team starts when you press Start.
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
            className="field min-h-24 resize-y"
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
        <TeamPicker agents={agents} team={team} onChange={setTeam} />
        <ErrorLine error={error} />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
