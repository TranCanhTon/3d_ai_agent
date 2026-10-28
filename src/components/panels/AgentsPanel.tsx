"use client";

import { useWorldStore } from "@/state/useWorldStore.ts";
import { useAgent } from "../hooks.ts";
import { AgentDetails } from "./AgentDetails.tsx";
import { Roster } from "./OverviewPanel.tsx";
import { PanelBody } from "./SidePanel.tsx";

export function AgentsPanel() {
  const selectedId = useWorldStore((s) => s.selectedAgentId);
  const agent = useAgent(selectedId);
  if (agent !== null) return <AgentDetails agent={agent} />;
  return (
    <PanelBody>
      <p className="text-xs text-mist-500">Pick an agent to chat with it, see its task messages or change its model.</p>
      <Roster />
    </PanelBody>
  );
}
