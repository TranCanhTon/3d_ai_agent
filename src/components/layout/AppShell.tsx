"use client";

// The app: the 3D office fills the window; a solid nav rail (left), top bar and
// side panel (right, full height) sit on it. The shell measures them and writes
// viewInsets to the store so the camera keeps the office in the free area.

import { PanelRightOpen } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useRef } from "react";
import { connectBackend } from "@/client/backendClient.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { NewProjectDialog } from "../dialogs/NewProjectDialog.tsx";
import { NewTaskDialog } from "../dialogs/NewTaskDialog.tsx";
import { isTyping, useSelectedProject } from "../hooks.ts";
import { SidePanel } from "../panels/SidePanel.tsx";
import { PermissionStack } from "../permissions/PermissionStack.tsx";
import { LoadingScreen } from "./LoadingScreen.tsx";
import { NavRail } from "./NavRail.tsx";
import { TopBar } from "./TopBar.tsx";
import { DebugOverlay } from "@/world/DebugOverlay.tsx";

const WorldCanvas = dynamic(() => import("@/world/WorldCanvas.tsx"), { ssr: false });

function useViewInsets(nav: React.RefObject<HTMLElement | null>, top: React.RefObject<HTMLElement | null>, side: React.RefObject<HTMLElement | null>) {
  const collapsed = useWorldStore((s) => s.panelCollapsed);
  useEffect(() => {
    const measure = () => {
      const width = window.innerWidth;
      const navBox = nav.current?.getBoundingClientRect();
      const topBox = top.current?.getBoundingClientRect();
      const sideBox = side.current?.getBoundingClientRect();
      useWorldStore.getState().setViewInsets({
        left: Math.round(navBox?.right ?? 0),
        top: Math.round(topBox?.bottom ?? 0),
        right: Math.round(sideBox === undefined ? 0 : width - sideBox.left),
        bottom: 0,
      });
    };
    const observer = new ResizeObserver(measure);
    for (const ref of [nav, top, side]) if (ref.current !== null) observer.observe(ref.current);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [nav, top, side, collapsed]);
}

function useShortcuts() {
  const project = useSelectedProject();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const store = useWorldStore.getState();
      if (event.key === "Escape") {
        if (store.dialog !== null) store.setDialog(null);
        else if (isTyping(event.target)) return;
        else {
          store.requestCamera({ overview: true });
          if (store.selectedTaskId !== null) store.setSelectedTask(null);
          else if (store.selectedAgentId !== null) store.setSelectedAgent(null);
        }
        return;
      }
      if (isTyping(event.target) || store.dialog !== null) return;
      if ((event.key === "n" || event.key === "N") && project !== null && !project.archived) {
        event.preventDefault();
        store.setDialog("task");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [project]);
}

export function AppShell() {
  const nav = useRef<HTMLElement>(null);
  const top = useRef<HTMLElement>(null);
  const side = useRef<HTMLElement>(null);
  const collapsed = useWorldStore((s) => s.panelCollapsed);
  const dialog = useWorldStore((s) => s.dialog);

  useEffect(() => connectBackend(), []);
  useViewInsets(nav, top, side);
  useShortcuts();

  return (
    <div className="relative h-dvh w-full min-w-[1024px] overflow-hidden">
      <div
        id="world-area"
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 30%, rgb(38 48 65 / 0.55), transparent 60%), radial-gradient(80% 60% at 80% 100%, rgb(124 196 214 / 0.08), transparent 70%), linear-gradient(180deg, #0a0e14, #06080c)",
        }}
      >
        <WorldCanvas />
      </div>
      <DebugOverlay />
      <div className="pointer-events-none absolute inset-0 flex">
        <NavRail ref={nav} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar ref={top} />
          {/* The free area over the office: permission cards and the show-panel button. */}
          <div className="relative min-h-0 flex-1">
            <PermissionStack />
            {collapsed && (
              <button
                type="button"
                aria-label="Show the side panel"
                title="Show the side panel"
                onClick={() => useWorldStore.getState().setPanelCollapsed(false)}
                className="surface pointer-events-auto absolute bottom-4 right-4 inline-flex size-10 items-center justify-center rounded-lg text-mist-300 hover:bg-ink-700 hover:text-mist-100"
              >
                <PanelRightOpen size={18} />
              </button>
            )}
          </div>
        </div>
        {!collapsed && <SidePanel ref={side} />}
      </div>
      {dialog === "task" && <NewTaskDialog />}
      {dialog === "project" && <NewProjectDialog />}
      <LoadingScreen />
    </div>
  );
}
