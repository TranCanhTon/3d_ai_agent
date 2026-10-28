"use client";

import { Activity, Bot, LayoutDashboard, ListChecks, NotebookPen, Settings, Users, type LucideIcon } from "lucide-react";
import { forwardRef } from "react";
import { taskNeedsMe } from "@/shared/ui/present.ts";
import { useWorldStore, type SideTab } from "@/state/useWorldStore.ts";
import { useProjectTasks } from "../hooks.ts";
import { cx } from "../ui.tsx";

const TABS: { tab: SideTab; label: string; icon: LucideIcon }[] = [
  { tab: "tasks", label: "Tasks", icon: ListChecks },
  { tab: "agents", label: "Agents", icon: Users },
  { tab: "overview", label: "Overview", icon: LayoutDashboard },
  { tab: "activity", label: "Activity", icon: Activity },
  { tab: "notes", label: "Notes", icon: NotebookPen },
  { tab: "settings", label: "Settings", icon: Settings },
];

/** The sections, flush on the left. Clicking the open section hides the panel. */
export const NavRail = forwardRef<HTMLElement>(function NavRail(_props, ref) {
  const activeTab = useWorldStore((s) => s.activeTab);
  const collapsed = useWorldStore((s) => s.panelCollapsed);
  const needsMe = useProjectTasks().filter(taskNeedsMe).length;

  return (
    <nav ref={ref} aria-label="Sections" className="pointer-events-auto flex w-16 shrink-0 flex-col items-center gap-1 border-r border-[var(--hairline)] bg-ink-900 py-3">
      <span className="mb-4 inline-flex size-10 items-center justify-center rounded-xl bg-signal/15 text-signal" title="AI Agent World" aria-hidden>
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
              "relative flex w-14 flex-col items-center gap-1 rounded-lg py-2 text-xs transition-colors",
              active ? "bg-ink-700 text-mist-100" : "text-mist-500 hover:bg-ink-800 hover:text-mist-100",
            )}
          >
            {active && <span className="absolute left-[-4px] top-2 bottom-2 w-[3px] rounded-full bg-signal" aria-hidden />}
            <Icon size={18} />
            <span className="leading-none">{label}</span>
            {tab === "tasks" && needsMe > 0 && (
              <span className="absolute right-1.5 top-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-warn px-1 text-xs font-bold leading-[18px] text-ink-950" aria-label={`${needsMe} need you`}>
                {needsMe}
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
});
