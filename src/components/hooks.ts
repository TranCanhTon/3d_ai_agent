"use client";

// Selectors and small hooks shared by the UI components.

import { useSyncExternalStore } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import type { Project } from "@/shared/domain/projectTypes.ts";
import type { Task } from "@/shared/domain/taskTypes.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";

const EMPTY_AGENTS: AgentState[] = [];
const EMPTY_TASKS: Task[] = [];

export function useSelectedProject(): Project | null {
  return useWorldStore((s) => s.snapshot?.projects.find((p) => p.id === s.selectedProjectId) ?? null);
}

/** The selected project's six agents, in role order. */
export function useProjectAgents(): AgentState[] {
  return useWorldStore(useShallow((s) => s.snapshot?.agents.filter((a) => a.projectId === s.selectedProjectId) ?? EMPTY_AGENTS));
}

export function useProjectTasks(): Task[] {
  return useWorldStore(useShallow((s) => s.snapshot?.tasks.filter((t) => t.projectId === s.selectedProjectId) ?? EMPTY_TASKS));
}

/** The selected project's orchestrator (sONion Ring): the agent I talk to. */
export function useOrchestrator(): AgentState | null {
  return useWorldStore((s) => s.snapshot?.agents.find((a) => a.projectId === s.selectedProjectId && a.role === "orchestrator") ?? null);
}

export function useAgent(agentId: string | null | undefined): AgentState | null {
  return useWorldStore((s) => (agentId == null ? null : (s.snapshot?.agents.find((a) => a.id === agentId) ?? null)));
}

export function useConnected(): boolean {
  return useWorldStore((s) => s.connectionStatus === "open");
}

/** The project is archived: agents refuse messages and tasks. */
export function useArchived(): boolean {
  return useSelectedProject()?.archived ?? false;
}

// One shared 30 s clock for every relative time on screen.
let now = Date.now();
const listeners = new Set<() => void>();
let ticker: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  if (ticker === null) {
    // Catch up with time that passed while nothing was listening.
    now = Date.now();
    ticker = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  };
}

/** The current time, refreshed every 30 s (relative times re-render together). */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeClock,
    () => now,
    () => now,
  );
}

/** True while focus is in a text field (keyboard shortcuts stay out of the way). */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** An ack error as one line. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
