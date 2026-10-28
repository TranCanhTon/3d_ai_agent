"use client";

// The team: six avatars, then the chosen agent's model and what it did in tasks.
// There is no direct chat: work goes through New task, and agents ask me inside the task.

import { ChevronDown, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getBackend, openAgent } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { AgentState, EffortLevel } from "@/shared/domain/agentTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useAgent, useConnected, useProjectAgents } from "../hooks.ts";
import { Avatar, cx, ErrorLine } from "../ui.tsx";
import { TaskMessagesView } from "./TaskMessagesView.tsx";

/** A dot on the avatar: working pulses in signal, waiting for me in warn, idle shows none. */
function statusDot(agent: AgentState): string | null {
  if (agent.status === "waiting_permission" || agent.status === "waiting_user") return "bg-warn";
  if (agent.busy || agent.status === "thinking" || agent.status === "working" || agent.status === "communicating") return "bg-signal pulse-dot text-signal";
  return null;
}

function AvatarRow({ selectedId }: { selectedId: string | null }) {
  const agents = useProjectAgents();
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-4" role="tablist" aria-label="Agents">
      {agents.map((agent) => {
        const selected = agent.id === selectedId;
        const color = ROLE_DEFINITIONS[agent.role].color;
        const dot = statusDot(agent);
        return (
          <button
            key={agent.id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={agent.name}
            title={agent.name}
            onClick={() => openAgent(agent.id)}
            className="relative rounded-full"
            style={selected ? { boxShadow: `0 0 0 2px var(--color-ink-900), 0 0 0 4px ${color}` } : undefined}
          >
            <Avatar agent={agent} size={32} />
            {dot !== null && <span className={cx("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-ink-900", dot)} />}
          </button>
        );
      })}
    </div>
  );
}

/** "Opus · High" with a menu for the model and effort (they apply from the agent's next run). */
function ModelMenu({ agent }: { agent: AgentState }) {
  const connected = useConnected();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const label = CONFIG.models.find((m) => m.id === agent.model)?.label ?? agent.model;

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  const set = (model: string, effort: EffortLevel | null) => {
    setError(null);
    getBackend()
      .setAgentModel({ agentId: agent.id, model, effort })
      .catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <div ref={root} className="relative">
      <button type="button" aria-haspopup="dialog" aria-expanded={open} className="btn btn-sm btn-quiet" onClick={() => setOpen(!open)}>
        {label} · {agent.effort === null ? "Default" : agent.effort[0]?.toUpperCase() + agent.effort.slice(1)}
        <ChevronDown size={13} className={cx("transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="surface absolute right-0 top-full z-20 mt-1 w-60 space-y-3 rounded-xl p-3 shadow-lg shadow-black/40" role="dialog" aria-label="Model and effort">
          <label className="block space-y-1 text-xs text-mist-300">
            Model
            <select className="field" value={agent.model} disabled={!connected} onChange={(e) => set(e.target.value, agent.effort)}>
              {CONFIG.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs text-mist-300">
            Effort
            <select
              className="field"
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
          <p className="text-xs text-mist-500">Applies from {agent.name}&apos;s next step.</p>
          <ErrorLine error={error} />
        </div>
      )}
    </div>
  );
}

function AgentHeader({ agent }: { agent: AgentState }) {
  const connected = useConnected();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="shrink-0 border-b border-[var(--hairline)] px-4 py-2">
      <div className="flex h-8 items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-semibold text-mist-100">{agent.name}</h3>
        </div>
        {agent.busy && (
          <button
            type="button"
            className="btn btn-sm btn-danger"
            disabled={!connected}
            onClick={() => {
              setError(null);
              getBackend()
                .stopAgent({ agentId: agent.id })
                .catch((e: unknown) => setError(errorText(e)));
            }}
          >
            <Square size={11} />
            Stop
          </button>
        )}
        <ModelMenu agent={agent} />
      </div>
      <p className="truncate text-xs text-mist-500">
        {ROLE_DEFINITIONS[agent.role].roleLabel}
        {agent.busy && agent.activity !== "" && <span className="text-mist-300"> · {agent.activity}</span>}
      </p>
      {agent.lastError !== null && <p className="mt-1 text-xs text-bad">{agent.lastError}</p>}
      <ErrorLine error={error} />
    </div>
  );
}

export function AgentsPanel() {
  const agents = useProjectAgents();
  const selectedId = useWorldStore((s) => s.selectedAgentId);
  // The orchestrator until I pick someone.
  const agent = useAgent(selectedId) ?? agents[0] ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AvatarRow selectedId={agent?.id ?? null} />
      {agent !== null && (
        <>
          <AgentHeader agent={agent} />
          <TaskMessagesView agent={agent} />
        </>
      )}
    </div>
  );
}
