"use client";

import { ChevronDown, ChevronLeft, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { getBackend, loadChatList, openTask } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { AgentState, EffortLevel } from "@/shared/domain/agentTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { AGENT_TABS, useWorldStore, type AgentTab } from "@/state/useWorldStore.ts";
import { errorText, useConnected } from "../hooks.ts";
import { Avatar, cx, ErrorLine, StatusPill } from "../ui.tsx";
import { ActivityList, useFeed } from "./ActivityPanel.tsx";
import { ChatView } from "./ChatView.tsx";
import { TaskMessagesView } from "./TaskMessagesView.tsx";

const TAB_LABEL: Record<AgentTab, string> = { chat: "Chat", tasks: "Tasks", activity: "Activity" };

/** "ran medium" when what ran differs from what was asked (Claude Code may lower effort silently). */
function ranNote(agent: AgentState): string | null {
  const ran = agent.lastRun;
  if (ran === null) return null;
  const parts: string[] = [];
  if (!ran.model.includes(agent.model)) parts.push(ran.model);
  if (agent.effort !== null && ran.effort !== null && ran.effort !== agent.effort) parts.push(`at ${ran.effort}`);
  return parts.length === 0 ? null : `last run: ${parts.join(" ")}`;
}

function ModelControls({ agent }: { agent: AgentState }) {
  const connected = useConnected();
  const [error, setError] = useState<string | null>(null);
  const set = (model: string, effort: EffortLevel | null) => {
    setError(null);
    getBackend()
      .setAgentModel({ agentId: agent.id, model, effort })
      .catch((e: unknown) => setError(errorText(e)));
  };
  const note = ranNote(agent);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs text-mist-500">
          Model
          <select className="field !w-auto !py-1 text-xs" value={agent.model} disabled={!connected} onChange={(e) => set(e.target.value, agent.effort)}>
            {CONFIG.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-mist-500">
          Effort
          <select
            className="field !w-auto !py-1 text-xs"
            value={agent.effort ?? ""}
            disabled={!connected}
            onChange={(e) => set(agent.model, e.target.value === "" ? null : (e.target.value as EffortLevel))}
          >
            <option value="">Default</option>
            {CONFIG.effortLevels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-mist-500">
        Applies from the next run{note !== null && <span className="text-warn"> · {note}</span>}
      </p>
      <ErrorLine error={error} />
    </div>
  );
}

function NowBox({ agent }: { agent: AgentState }) {
  const task = useWorldStore((s) => (agent.currentTaskId === null ? null : (s.snapshot?.tasks.find((t) => t.id === agent.currentTaskId) ?? null)));
  const rows: [string, React.ReactNode][] = [
    ["Doing", agent.activity || (agent.busy ? "Working" : "Nothing right now")],
    [
      "Task",
      task === null ? (
        <span className="text-mist-500">None</span>
      ) : (
        <button type="button" className="truncate text-signal hover:underline" onClick={() => openTask(task.id)}>
          {task.title}
        </button>
      ),
    ],
    ["Waiting", agent.queuedCount === 0 ? "No messages" : `${agent.queuedCount} message${agent.queuedCount === 1 ? "" : "s"}`],
    ["Chat only", agent.chatOnly ? "On: no tools in direct chat" : "Off"],
  ];
  return (
    <div className="well space-y-1 rounded-xl p-3 text-xs">
      <p className="eyebrow mb-1.5">Now</p>
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3">
          <span className="w-16 shrink-0 text-mist-500">{label}</span>
          <span className="min-w-0 flex-1 truncate text-mist-300">{value}</span>
        </div>
      ))}
      {agent.lastError !== null && (
        <div className="flex gap-3">
          <span className="w-16 shrink-0 text-mist-500">Last error</span>
          <span className="min-w-0 flex-1 text-bad">{agent.lastError}</span>
        </div>
      )}
    </div>
  );
}

export function AgentDetails({ agent }: { agent: AgentState }) {
  const tab = useWorldStore((s) => s.agentTab);
  const connected = useConnected();
  const [error, setError] = useState<string | null>(null);
  // Folded by default so the chat gets the room; the model line stays visible.
  const [showDetails, setShowDetails] = useState(false);
  const role = ROLE_DEFINITIONS[agent.role];
  const events = useFeed((e) => e.agentId === agent.id || e.targetAgentId === agent.id);
  const chatsLoaded = useWorldStore((s) => s.chatLists[agent.id] !== undefined);

  useEffect(() => {
    if (!chatsLoaded && connected) loadChatList(agent.id).catch((e: unknown) => setError(errorText(e)));
  }, [agent.id, chatsLoaded, connected]);

  const run = (promise: Promise<unknown>) => {
    setError(null);
    promise.catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin max-h-[55%] shrink-0 space-y-3 overflow-y-auto border-b border-mist-500/10 p-4">
        <button type="button" className="btn btn-sm btn-quiet -ml-2" onClick={() => useWorldStore.getState().setSelectedAgent(null)}>
          <ChevronLeft size={14} />
          All agents
        </button>
        <div className="flex items-start gap-3">
          <Avatar agent={agent} size={42} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold">{agent.name}</h3>
              <StatusPill status={agent.status} />
            </div>
            <p className="text-xs text-mist-300">{role.roleLabel}</p>
            <p className="truncate text-[11px] text-mist-500">{agent.activity || role.tagline}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-expanded={showDetails}
            className="btn btn-sm btn-ghost"
            title="Activity, model, effort and chat only"
            onClick={() => setShowDetails(!showDetails)}
          >
            {agent.model} · {agent.effort ?? "default"}
            {agent.chatOnly && " · chat only"}
            <ChevronDown size={12} className={cx("transition-transform", showDetails && "rotate-180")} />
          </button>
          {agent.busy && (
            <button type="button" className="btn btn-sm btn-danger" disabled={!connected} onClick={() => run(getBackend().stopAgent({ agentId: agent.id }))}>
              <Square size={11} />
              Stop
            </button>
          )}
        </div>
        {showDetails && (
          <>
            <NowBox agent={agent} />
            <ModelControls agent={agent} />
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-mist-300" title="Direct chat without any tools (tasks always use the role's tools)">
              <input
                type="checkbox"
                className="accent-[var(--color-signal)]"
                checked={agent.chatOnly}
                disabled={!connected}
                onChange={(e) => run(getBackend().setChatOnly({ agentId: agent.id, chatOnly: e.target.checked }))}
              />
              Chat only
            </label>
          </>
        )}
        <ErrorLine error={error} />
      </div>

      <div className="flex shrink-0 items-center gap-1 border-b border-mist-500/10 px-3" role="tablist" aria-label={`${agent.name} views`}>
        {AGENT_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => useWorldStore.getState().setAgentTab(t)}
            className={cx("-mb-px border-b-2 px-2.5 py-2 text-xs font-medium", tab === t ? "border-signal text-mist-100" : "border-transparent text-mist-500 hover:text-mist-300")}
          >
            {TAB_LABEL[t]}
            {t === "activity" && events.length > 0 && <span className="ml-1 text-mist-500">{events.length}</span>}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "chat" && <ChatView agent={agent} />}
        {tab === "tasks" && <TaskMessagesView agent={agent} />}
        {tab === "activity" && (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
            <ActivityList events={events} empty={`Nothing from ${agent.name} since this page opened.`} />
          </div>
        )}
      </div>
    </div>
  );
}
