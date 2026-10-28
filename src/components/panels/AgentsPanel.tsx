"use client";

// The team: six avatars, then the chosen agent's model and what it did in tasks.
// The orchestrator is the one agent I talk to: its view has my chat with it (task
// cards included) and its task work; every other agent shows only its task work.

import { Square } from "lucide-react";
import { useState } from "react";
import { getBackend, openAgent } from "@/client/backendClient.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { hasOpenAsk } from "@/shared/ui/present.ts";
import { useWorldStore, type AgentView } from "@/state/useWorldStore.ts";
import { errorText, useAgent, useConnected, useProjectAgents, useProjectTasks } from "../hooks.ts";
import { ModelPicker } from "../ModelPicker.tsx";
import { Avatar, cx, ErrorLine, Segmented } from "../ui.tsx";
import { OrchestratorChat } from "./OrchestratorChat.tsx";
import { TaskMessagesView } from "./TaskMessagesView.tsx";

/** A dot on the avatar: working pulses in signal, waiting for me in warn, idle shows none. */
function statusDot(agent: AgentState, cardWaiting: boolean): string | null {
  if (agent.status === "waiting_permission" || agent.status === "waiting_user" || cardWaiting) return "bg-warn";
  if (agent.busy || agent.status === "thinking" || agent.status === "working" || agent.status === "communicating") return "bg-signal pulse-dot text-signal";
  return null;
}

function AvatarRow({ selectedId }: { selectedId: string | null }) {
  const agents = useProjectAgents();
  // Every card waits in my chat with the orchestrator.
  const cardWaiting = useProjectTasks().some(hasOpenAsk);
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--hairline)] px-4" role="tablist" aria-label="Agents">
      {agents.map((agent) => {
        const selected = agent.id === selectedId;
        const color = ROLE_DEFINITIONS[agent.role].color;
        const dot = statusDot(agent, agent.role === "orchestrator" && cardWaiting);
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

/** "Opus · High" with a menu for the model and effort (they apply from the agent's next run, not to running tasks). */
function ModelMenu({ agent }: { agent: AgentState }) {
  const connected = useConnected();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <ModelPicker
        value={{ model: agent.model, effort: agent.effort }}
        disabled={!connected}
        note={`Applies to ${agent.name}'s chat and new tasks. A task keeps the setting it was created with.`}
        onChange={(setting) => {
          setError(null);
          getBackend()
            .setAgentModel({ agentId: agent.id, model: setting.model, effort: setting.effort })
            .catch((e: unknown) => setError(errorText(e)));
        }}
      />
      <ErrorLine error={error} />
    </>
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
  const view = useWorldStore((s) => s.agentView);
  // The orchestrator until I pick someone.
  const agent = useAgent(selectedId) ?? agents[0] ?? null;
  const isOrchestrator = agent?.role === "orchestrator";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AvatarRow selectedId={agent?.id ?? null} />
      {agent !== null && (
        <>
          <AgentHeader agent={agent} />
          {isOrchestrator && (
            <div className="shrink-0 border-b border-[var(--hairline)] px-4 py-2">
              <Segmented
                label={`${agent.name} view`}
                size="sm"
                value={view}
                onChange={(next: AgentView) => useWorldStore.getState().setAgentView(next)}
                options={[
                  { value: "chat", label: "Chat" },
                  { value: "tasks", label: "Tasks" },
                ]}
              />
            </div>
          )}
          {isOrchestrator && view === "chat" ? <OrchestratorChat agent={agent} /> : <TaskMessagesView agent={agent} />}
        </>
      )}
    </div>
  );
}
