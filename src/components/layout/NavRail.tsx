"use client";

import { Activity, Bot, LayoutDashboard, ListChecks, NotebookPen, Settings, Users, type LucideIcon } from "lucide-react";
import { forwardRef } from "react";
import { taskNeedsMe } from "@/shared/ui/present.ts";
import { useWorldStore, type SideTab } from "@/state/useWorldStore.ts";
import { useProjectTasks } from "../hooks.ts";
import { cx } from "../ui.tsx";

const TABS: { tab: SideTab; label: string; icon: LucideIcon }[] = [
  { tab: "overview", label: "Overview", icon: LayoutDashboard },
  { tab: "agents", label: "Agents", icon: Users },
  { tab: "tasks", label: "Tasks", icon: ListChecks },
  { tab: "activity", label: "Activity", icon: Activity },
  { tab: "notes", label: "Notes", icon: NotebookPen },
  { tab: "settings", label: "Settings", icon: Settings },
];

export const NavRail = forwardRef<HTMLElement>(function NavRail(_props, ref) {
  const activeTab = useWorldStore((s) => s.activeTab);
  const collapsed = useWorldStore((s) => s.panelCollapsed);
  const needsMe = useProjectTasks().filter(taskNeedsMe).length;

  return (
    <nav ref={ref} aria-label="Sections" className="surface pointer-events-auto flex w-14 shrink-0 flex-col items-center gap-1 rounded-2xl py-3">
      <span className="mb-3 inline-flex size-9 items-center justify-center rounded-xl bg-signal/15 text-signal" aria-hidden>
        <Bot size={20} />
      </span>
      {TABS.map(({ tab, label, icon: Icon }) => {
        const active = activeTab === tab && !collapsed;
        return (
          <button
            key={tab}
            type="button"
            aria-label={label}
            aria-current={active ? "page" : undefined}
            title={active ? `${label} (click to hide the panel)` : label}
            onClick={() => {
              const store = useWorldStore.getState();
              if (active) store.setPanelCollapsed(true);
              else store.setActiveTab(tab);
            }}
            className={cx(
              "relative inline-flex size-10 items-center justify-center rounded-xl transition-colors",
              active ? "bg-ink-600/80 text-mist-100" : "text-mist-500 hover:bg-ink-700/70 hover:text-mist-100",
            )}
          >
            <Icon size={18} />
            {tab === "tasks" && needsMe > 0 && (
              <span className="absolute right-1 top-1 inline-flex min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-bold leading-4 text-ink-950" aria-label={`${needsMe} need you`}>
                {needsMe}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
});
