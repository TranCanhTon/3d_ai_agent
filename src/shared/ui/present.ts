// Pure helpers that turn domain data into what the UI shows: task order and
// filters, the workflow stepper, relative times, notes lines, permission card
// previews, the activity filter. Framework free (tested by scripts/test.ts).

import { CONFIG } from "../config.ts";
import type { AgentEvent } from "../events/eventTypes.ts";
import { PAUSE } from "../domain/handoff.ts";
import type { PermissionRequest } from "../domain/permissions.ts";
import { PRIORITY_ORDER, type Task, type WorkflowPhase } from "../domain/taskTypes.ts";

// ── Tasks ───────────────────────────────────────────────────────────────────

/** active: being confirmed with me, or the project's current task (running or paused); waiting: in line; done: ended any way. */
export type TaskGroup = "active" | "waiting" | "done";
export const TASK_FILTERS = ["all", "active", "waiting", "done"] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

export function taskGroup(task: Task): TaskGroup {
  if (task.endReason !== null) return "done";
  return task.phase === "queued" ? "waiting" : "active";
}

export function matchesTaskFilter(task: Task, filter: TaskFilter): boolean {
  return filter === "all" || taskGroup(task) === filter;
}

export function taskFilterCounts(tasks: readonly Task[]): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = { all: tasks.length, active: 0, waiting: 0, done: 0 };
  for (const task of tasks) counts[taskGroup(task)]++;
  return counts;
}

const GROUP_ORDER: Record<TaskGroup, number> = { active: 0, waiting: 1, done: 2 };

/** Active first, then waiting (priority, then oldest: the order they will run), then ended (newest first). */
export function sortTasks(tasks: readonly Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const ga = taskGroup(a);
    const gb = taskGroup(b);
    if (ga !== gb) return GROUP_ORDER[ga] - GROUP_ORDER[gb];
    if (ga === "waiting") return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt - b.createdAt;
    if (ga === "done") return (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt);
    return b.updatedAt - a.updatedAt;
  });
}

/** A card in my chat with sONion Ring waits for me: a question, a brief to start, a change to apply. */
export function hasOpenAsk(task: Task): boolean {
  return task.endReason === null && task.asks.some((a) => a.outcome === "open");
}

/** The task needs me: an open card, or a pause to resume (a permission card is shown elsewhere). */
export function taskNeedsMe(task: Task): boolean {
  if (task.endReason !== null) return false;
  return hasOpenAsk(task) || task.question !== null || canResume(task);
}

/** Waits on me right now (a card, a pause, a permission card): the workflow shows "Waiting for you". */
export function waitsForMe(task: Task): boolean {
  return taskNeedsMe(task) || task.blockedReason === PAUSE.permission || task.blockedReason === PAUSE.change;
}

/** Can Resume continue it? Not with a question (answer it), a change (apply or discard it) or while a card waits. */
export function canResume(task: Task): boolean {
  return (
    task.endReason === null &&
    task.blockedReason !== null &&
    task.question === null &&
    task.blockedReason !== PAUSE.permission &&
    task.blockedReason !== PAUSE.change
  );
}

/** Change task is offered from planning to review (not during the final summary), one change at a time. */
export function canChange(task: Task): boolean {
  if (task.endReason !== null || !["planning", "research", "implementation", "testing", "review"].includes(task.phase)) return false;
  if (task.phase === "review" && task.assignedAgentId?.endsWith(":orchestrator") === true) return false;
  return !task.changes.some((c) => c.outcome === "pending" || c.outcome === "approved");
}

/** "T-3F9A2C": a short, readable form of the task id. */
export function shortTaskId(id: string): string {
  return `T-${(id.split("_")[1] ?? id).slice(0, 6).toUpperCase()}`;
}

export type TaskTone = "running" | "paused" | "done" | "failed" | "waiting";

export function taskTone(task: Task): TaskTone {
  if (task.endReason === "done") return "done";
  if (task.endReason !== null) return "failed";
  if (task.phase === "queued") return "waiting";
  return task.blockedReason !== null ? "paused" : "running";
}

const PHASE_LABEL: Record<WorkflowPhase, string> = {
  queued: "Waiting in line",
  intake: "Confirming",
  awaiting_approval: "Needs your OK",
  planning: "Planning",
  research: "Researching",
  implementation: "Building",
  testing: "Testing",
  review: "Reviewing",
  done: "Done",
  failed: "Failed",
};

export function phaseLabel(task: Task): string {
  if (task.endReason === "cancelled") return "Cancelled";
  return PHASE_LABEL[task.phase];
}

// ── Time ────────────────────────────────────────────────────────────────────

/** "just now", "5m ago", "3h ago", "yesterday", "4d ago", then the date. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Local HH:MM. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 950 → "950", 45_210 → "45.2k", 1_200_000 → "1.2M". */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function isLongChat(contextTokens: number | null): boolean {
  return contextTokens !== null && contextTokens > CONFIG.longChatTokens;
}

// ── Notes ───────────────────────────────────────────────────────────────────

export type NoteKind = "task_log" | "pinned" | "mine" | "agent" | "text" | "heading";

export interface NoteLine {
  kind: NoteKind;
  text: string;
  /** Who wrote it ("task log", "pinned by you", "you", an agent's name), null for plain text. */
  by: string | null;
  /** YYYY-MM-DD, null for plain text. */
  date: string | null;
}

/** `- <text> (<by>, YYYY-MM-DD)` (see formatNote on the server). */
const NOTE_LINE = /^- (.*) \(([^()]+), (\d{4}-\d{2}-\d{2})\)$/;

export function parseNoteLine(line: string): NoteLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("#")) return { kind: "heading", text: trimmed.replace(/^#+\s*/, ""), by: null, date: null };
  const match = NOTE_LINE.exec(trimmed);
  if (match === null) return { kind: "text", text: trimmed.replace(/^- /, ""), by: null, date: null };
  const [, text = "", by = "", date = ""] = match;
  const kind: NoteKind = by === "task log" ? "task_log" : by === "pinned by you" ? "pinned" : by === "you" ? "mine" : "agent";
  return { kind, text, by, date };
}

/** The notes file as lines to show, newest last; the file's own "# Team notes" header is dropped. */
export function parseNotes(content: string): NoteLine[] {
  return content
    .split(/\r?\n/)
    .map(parseNoteLine)
    .filter((line): line is NoteLine => line !== null && !(line.kind === "heading" && line.text === "Team notes"));
}

// ── Permission cards ────────────────────────────────────────────────────────

export interface PermissionPreview {
  /** The Bash command, in full. */
  command: string | null;
  filePath: string | null;
  /** Edit: the replaced text and its replacement, each cut to `maxChars`. */
  edit: { oldText: string; newText: string } | null;
  /** Write: the start of the new file. */
  content: string | null;
  /** Anything else: the input as pretty JSON, cut to `maxChars`. */
  json: string | null;
}

function field(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function cut(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

export function permissionPreview(request: Pick<PermissionRequest, "toolName" | "input">, maxChars = 600): PermissionPreview {
  const { toolName, input } = request;
  const preview: PermissionPreview = { command: null, filePath: null, edit: null, content: null, json: null };
  if (toolName === "Bash") {
    preview.command = field(input, "command");
  } else if (toolName === "Edit" || toolName === "Write") {
    preview.filePath = field(input, "file_path");
    if (toolName === "Edit") {
      const oldText = field(input, "old_string");
      const newText = field(input, "new_string");
      if (oldText !== null && newText !== null) preview.edit = { oldText: cut(oldText, maxChars), newText: cut(newText, maxChars) };
    } else {
      const content = field(input, "content");
      if (content !== null) preview.content = cut(content, maxChars);
    }
  }
  if (preview.command === null && preview.filePath === null) {
    let json: string;
    try {
      json = JSON.stringify(input, null, 2) ?? "";
    } catch {
      json = String(input);
    }
    preview.json = cut(json, maxChars);
  }
  return preview;
}

// ── Activity ────────────────────────────────────────────────────────────────

export const ACTIVITY_FILTERS = ["all", "handoffs", "permissions", "problems"] as const;
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number];

export function matchesActivityFilter(event: AgentEvent, filter: ActivityFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "handoffs":
      return event.type === "task.assigned" || (event.type === "agent.message" && event.targetAgentId !== undefined);
    case "permissions":
      return event.type.startsWith("permission.");
    case "problems":
      return event.severity === "error" || event.severity === "warning";
  }
}

// ── People ──────────────────────────────────────────────────────────────────

/** "STD Dren" → "SD", "sONion Ring" → "SR", "Drater" → "DR". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter((w) => w !== "");
  const [first = "", second] = words;
  if (second !== undefined) return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
  return first.slice(0, 2).toUpperCase();
}
