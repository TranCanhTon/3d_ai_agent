"use client";

import { PanelRightClose } from "lucide-react";
import { forwardRef } from "react";
import { useWorldStore, type SideTab } from "@/state/useWorldStore.ts";
import { IconButton } from "../ui.tsx";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { AgentsPanel } from "./AgentsPanel.tsx";
import { NotesPanel } from "./NotesPanel.tsx";
import { OverviewPanel } from "./OverviewPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { TasksPanel } from "./TasksPanel.tsx";

const TITLES: Record<SideTab, string> = {
  overview: "Overview",
  agents: "Agents",
  tasks: "Tasks",
  activity: "Activity",
  notes: "Notes",
  settings: "Settings",
};

/** Solid, full height, flush right: nothing of the office shows through it. */
export const SidePanel = forwardRef<HTMLElement>(function SidePanel(_props, ref) {
  const tab = useWorldStore((s) => s.activeTab);
  return (
    <aside ref={ref} aria-label={TITLES[tab]} className="pointer-events-auto flex h-full w-[440px] shrink-0 flex-col border-l border-[var(--hairline)] bg-ink-900">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--hairline)] pl-4 pr-2">
        <h2 className="text-[15px] font-semibold">{TITLES[tab]}</h2>
        <IconButton label="Hide the side panel" onClick={() => useWorldStore.getState().setPanelCollapsed(true)}>
          <PanelRightClose size={16} />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === "overview" && <OverviewPanel />}
        {tab === "agents" && <AgentsPanel />}
        {tab === "tasks" && <TasksPanel />}
        {tab === "activity" && <ActivityPanel />}
        {tab === "notes" && <NotesPanel />}
        {tab === "settings" && <SettingsPanel />}
      </div>
    </aside>
  );
});

/** The scrolling body most tabs use. */
export function PanelBody({ children }: { children: React.ReactNode }) {
  return <div className="scroll-thin min-h-0 flex-1 space-y-6 overflow-y-auto p-4">{children}</div>;
}
