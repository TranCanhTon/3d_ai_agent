"use client";

import { Plus, Sparkles } from "lucide-react";
import { openAgent } from "@/client/backendClient.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { sortTasks, taskGroup } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { useArchived, useProjectAgents, useProjectTasks } from "../hooks.ts";
import { Avatar, Section, StatusPill } from "../ui.tsx";
import { ActivityList, useFeed } from "./ActivityPanel.tsx";
import { PanelBody } from "./SidePanel.tsx";
import { TaskCard } from "./TaskCard.tsx";

export function Roster({ compact = false }: { compact?: boolean }) {
  const agents = useProjectAgents();
  const selected = useWorldStore((s) => s.selectedAgentId);
  return (
    <ul className="space-y-1">
      {agents.map((agent) => (
        <li key={agent.id}>
          <button
            type="button"
            onClick={() => openAgent(agent.id)}
            className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-ink-700/60 ${selected === agent.id && !compact ? "bg-ink-700/70" : ""}`}
          >
            <Avatar agent={agent} size={compact ? 26 : 30} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{agent.name}</span>
              <span className="block truncate text-[11px] text-mist-500">
                {ROLE_DEFINITIONS[agent.role].roleLabel}
                {!compact && ` · ${agent.model} · ${agent.effort ?? "default"}`}
              </span>
            </span>
            {agent.queuedCount > 0 && (
              <span className="rounded-md bg-ink-700 px-1.5 py-0.5 text-[10.5px] text-mist-300" title="Messages waiting">
                +{agent.queuedCount}
              </span>
            )}
            <StatusPill status={agent.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function OverviewPanel() {
  const tasks = useProjectTasks();
  const agents = useProjectAgents();
  const archived = useArchived();
  const feed = useFeed().slice(0, 8);
  const sorted = sortTasks(tasks);
  const current = sorted.find((t) => taskGroup(t) === "active") ?? null;
  const waiting = sorted.filter((t) => taskGroup(t) === "waiting").length;
  const names = agents.map((a) => a.name);

  return (
    <PanelBody>
      {tasks.length === 0 && (
        <div className="rounded-xl bg-gradient-to-br from-signal/15 to-transparent p-4 ring-1 ring-signal/20">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <Sparkles size={15} className="text-signal" />
            Give the team a task
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-mist-300">
            {names.length === 6
              ? `${names[0]} briefs it, ${names[1]} plans it, ${names[2]} researches, ${names[3]} builds, ${names[4]} tests and ${names[5]} reviews, handing the work along until it is done.`
              : "The orchestrator briefs it, then the team plans, researches, builds, tests and reviews it."}
          </p>
          <button type="button" className="btn btn-primary mt-3" disabled={archived} onClick={() => useWorldStore.getState().setDialog("task")}>
            <Plus size={15} />
            New task
          </button>
        </div>
      )}

      <Section title="Team">
        <Roster compact />
      </Section>

      {tasks.length > 0 && (
        <Section title="Current task" aside={waiting > 0 && <span className="text-[11px] text-mist-500">{waiting} waiting</span>}>
          {current !== null ? <TaskCard task={current} /> : <p className="text-xs text-mist-500">No task running.</p>}
        </Section>
      )}

      <Section title="Latest activity">
        <ActivityList events={feed} empty="Activity shows up here as the team works." />
      </Section>
    </PanelBody>
  );
}
