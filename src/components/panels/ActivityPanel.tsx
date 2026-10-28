"use client";

import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { openAgent } from "@/client/backendClient.ts";
import type { AgentEvent, EventSeverity } from "@/shared/events/eventTypes.ts";
import { ACTIVITY_FILTERS, matchesActivityFilter, type ActivityFilter } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { Avatar, ClockTime, cx, Empty, Segmented } from "../ui.tsx";
import { PanelBody } from "./SidePanel.tsx";

const SEVERITY: Record<EventSeverity, string> = {
  info: "bg-signal/70",
  success: "bg-ok",
  warning: "bg-warn",
  error: "bg-bad",
};

function AgentChip({ agentId }: { agentId: string }) {
  const agent = useWorldStore((s) => s.snapshot?.agents.find((a) => a.id === agentId) ?? null);
  if (agent === null) return null;
  return (
    <button type="button" onClick={() => openAgent(agent.id)} title={`Open ${agent.name}`} aria-label={`Open ${agent.name}`} className="rounded-full">
      <Avatar agent={agent} size={20} />
    </button>
  );
}

export function ActivityRow({ event }: { event: AgentEvent }) {
  return (
    <li className="flex items-start gap-2.5 py-1.5">
      <span className={cx("mt-1.5 size-1.5 shrink-0 rounded-full", SEVERITY[event.severity])} aria-label={event.severity} />
      <span className="w-10 shrink-0 pt-px text-[11px] text-mist-500">
        <ClockTime at={event.timestamp} />
      </span>
      {(event.agentId !== undefined || event.targetAgentId !== undefined) && (
        <span className="flex shrink-0 items-center gap-0.5">
          {event.agentId !== undefined && <AgentChip agentId={event.agentId} />}
          {event.targetAgentId !== undefined && (
            <>
              <ArrowRight size={11} className="text-mist-500" aria-label="to" />
              <AgentChip agentId={event.targetAgentId} />
            </>
          )}
        </span>
      )}
      <span className="min-w-0 flex-1 text-xs leading-relaxed text-mist-300">{event.message}</span>
    </li>
  );
}

/** Feed events of the selected project (and app wide ones), newest first. */
export function useFeed(match: (event: AgentEvent) => boolean = () => true): AgentEvent[] {
  const events = useWorldStore((s) => s.events);
  const projectId = useWorldStore((s) => s.selectedProjectId);
  return events.filter((e) => e.feed && (e.projectId === undefined || e.projectId === projectId) && match(e));
}

export function ActivityList({ events, empty }: { events: AgentEvent[]; empty: string }) {
  if (events.length === 0) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-mist-500/5">
      {events.map((event) => (
        <ActivityRow key={event.id} event={event} />
      ))}
    </ul>
  );
}

const LABELS: Record<ActivityFilter, string> = { all: "All", handoffs: "Handoffs", permissions: "Permissions", problems: "Problems" };

export function ActivityPanel() {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const events = useFeed((e) => matchesActivityFilter(e, filter));
  return (
    <PanelBody>
      <Segmented label="Show" value={filter} onChange={setFilter} options={ACTIVITY_FILTERS.map((f) => ({ value: f, label: LABELS[f] }))} />
      <ActivityList events={events} empty={filter === "all" ? "Nothing has happened yet since this page opened." : `No ${LABELS[filter].toLowerCase()} yet.`} />
    </PanelBody>
  );
}
