"use client";

// Read only: connection, usage, the team's models and the rules from CONFIG.

import type { ReactNode } from "react";
import { CONFIG } from "@/shared/config.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { DEFAULT_WS_URL } from "@/client/WebSocketAgentBackend.ts";
import { clockTime } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { useProjectAgents } from "../hooks.ts";
import { Avatar, Section } from "../ui.tsx";
import { PanelBody } from "./SidePanel.tsx";

function Rows({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="well divide-y divide-mist-500/5 rounded-xl text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-3 px-3 py-2">
          <dt className="w-28 shrink-0 text-mist-500">{label}</dt>
          <dd className="min-w-0 flex-1 break-words text-mist-300">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function List({ items }: { items: readonly string[] }) {
  return <span className="font-mono text-[11px] leading-relaxed">{items.join(", ")}</span>;
}

export function SettingsPanel() {
  const status = useWorldStore((s) => s.connectionStatus);
  const runner = useWorldStore((s) => s.snapshot?.runner ?? null);
  const auth = useWorldStore((s) => s.snapshot?.auth.source ?? null);
  const usage = useWorldStore((s) => s.snapshot?.usage ?? null);
  const agents = useProjectAgents();
  const authLabel = auth === null ? "Not reported yet (after the first run)" : auth === "none" ? "Claude subscription" : auth;

  return (
    <PanelBody>
      <Section title="Connection">
        <Rows
          rows={[
            ["Status", status === "open" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected"],
            ["Server", <span key="s" className="font-mono">{DEFAULT_WS_URL}</span>],
            ["Runner", runner === "claude" ? "Claude agents (real)" : runner === "scripted" ? "Scripted team (no Claude calls)" : runner === "echo" ? "Echo (no Claude calls)" : "–"],
            ["Billing", authLabel],
          ]}
        />
      </Section>

      <Section title="Usage limit">
        <Rows
          rows={[
            ["State", usage?.limited ? <span key="u" className="text-bad">Limit reached</span> : "OK"],
            ["Resets", usage?.resetsAt != null ? clockTime(usage.resetsAt) : "–"],
          ]}
        />
      </Section>

      <Section title="Team">
        <div className="well overflow-hidden rounded-xl">
          <table className="w-full text-left text-[11.5px]">
            <thead className="text-mist-500">
              <tr>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-2 py-2 font-medium">Model</th>
                <th className="px-2 py-2 font-medium">Turns</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-mist-500/5">
              {agents.map((agent) => {
                const role = ROLE_DEFINITIONS[agent.role];
                return (
                  <tr key={agent.id} className="align-top">
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <Avatar agent={agent} size={20} />
                        <span>
                          <span className="block text-mist-100">{agent.name}</span>
                          <span className="block text-[10.5px] text-mist-500">{role.roleLabel}</span>
                          <span className="mt-0.5 block font-mono text-[10px] text-mist-500">{role.allowedTools.join(" ")}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-mist-300">
                      {agent.model}
                      <span className="block text-[10.5px] text-mist-500">{agent.effort ?? "default"}</span>
                    </td>
                    <td className="px-2 py-2 tabular-nums text-mist-300">{role.maxTurns}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="Rules">
        <Rows
          rows={[
            ["Attempts", `${CONFIG.maxIterations} per task`],
            ["Git", `Engineer commits ${CONFIG.git.commitRequiresApproval ? "with" : "without"} a card, pushes ${CONFIG.git.pushRequiresApproval ? "with" : "without"} one; the pipeline never commits`],
            ["Git blocked", <List key="g" items={CONFIG.git.blockedPatterns} />],
            ["Look around", <List key="l" items={CONFIG.shell.lookAround} />],
            ["Search", <List key="s" items={CONFIG.shell.search} />],
            ["Checks", <List key="c" items={CONFIG.shell.checks} />],
            ["Versions", <List key="v" items={CONFIG.shell.versions} />],
            ["Always denied", <List key="d" items={CONFIG.shell.deniedExecutables} />],
            ["Edits", "Edit and Write always ask"],
          ]}
        />
      </Section>
    </PanelBody>
  );
}
