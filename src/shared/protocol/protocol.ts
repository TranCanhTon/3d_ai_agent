// WebSocket contract between the browser and the Node server.
// schemas.ts holds the matching zod schemas and fails typecheck if they drift.

import type { AgentRunnerKind } from "../config.ts";
import type { AgentState } from "../domain/agentTypes.ts";
import type { ChatMessage } from "../domain/chatTypes.ts";
import type { PermissionDecision, PermissionRequest } from "../domain/permissions.ts";
import type { Project } from "../domain/projectTypes.ts";
import type { Task, TaskPriority } from "../domain/taskTypes.ts";
import type { AgentEvent } from "../events/eventTypes.ts";

// ── Snapshot ────────────────────────────────────────────────────────────────

export const COMM_LINK_KINDS = ["message", "assign", "report"] as const;
export type CommLinkKind = (typeof COMM_LINK_KINDS)[number];

export interface CommLink {
  id: string;
  from: string;
  to: string;
  kind: CommLinkKind;
  /** Epoch ms. */
  startedAt: number;
  endsAt: number;
}

export interface UsageState {
  limited: boolean;
  resetsAt: number | null;
}

/** Where the agents' Claude credential comes from, as Claude Code reports it ("none" = claude.ai login). */
export interface AuthState {
  source: string | null;
}

/** Chat history is not included; see getChatHistory. */
export interface WorldSnapshot {
  serverTime: number;
  projects: Project[];
  agents: AgentState[];
  tasks: Task[];
  links: CommLink[];
  pendingPermissions: PermissionRequest[];
  usage: UsageState;
  auth: AuthState;
  /** Which runner answers chat messages. */
  runner: AgentRunnerKind;
}

// ── Commands ────────────────────────────────────────────────────────────────

/** Arguments of each command. Kept in `args` because createProject has its own `name`. */
export interface CommandArgsMap {
  /** Folder browser; defaults to config.folderBrowserRoot and never leaves it. */
  listFolders: { path?: string };
  createProject: { name: string; rootPath: string; initGit?: boolean };
  /** Hides a project; its data is kept and its agents refuse messages. */
  archiveProject: { projectId: string };
  restoreProject: { projectId: string };
  sendMessage: { agentId: string; text: string };
  cancelQueued: { agentId: string; messageId: string };
  stopAgent: { agentId: string };
  /** Only while the agent is not busy. The next message starts a new Claude session. */
  resetAgentSession: { agentId: string };
  setChatOnly: { agentId: string; chatOnly: boolean };
  submitTask: { projectId: string; title: string; description?: string; priority?: TaskPriority };
  cancelTask: { taskId: string };
  /** Only for a paused task without a question. */
  resumeTask: { taskId: string };
  /** My answer to sONion Ring's question; the task continues. */
  answerTask: { taskId: string; text: string };
  respondPermission: { requestId: string; decision: PermissionDecision };
  /** `text` is what I edited from the message (at most noteMaxChars). */
  pinToNotes: { messageId: string; text: string };
  getNotes: { projectId: string };
  /**
   * `before` is a message id; returns messages older than it, newest last.
   * view "chat" (default): my direct chat (taskId null); "tasks": the agent's task messages.
   */
  getChatHistory: { agentId: string; before?: string; limit?: number; view?: ChatView };
  getSnapshot: Record<string, never>;
}

export type CommandName = keyof CommandArgsMap;

export const CHAT_VIEWS = ["chat", "tasks"] as const;
export type ChatView = (typeof CHAT_VIEWS)[number];

export interface FolderEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  /** A project (archived included) already uses exactly this folder. */
  hasProject: boolean;
  /** Why this folder cannot become a project, or null. */
  blocked: string | null;
}

export interface FolderListing {
  path: string;
  /** null at the folder browser root. */
  parent: string | null;
  entries: FolderEntry[];
}

export interface ChatHistoryPage {
  messages: ChatMessage[];
  hasMore: boolean;
}

/** `result` of a successful ack. null means the command has no result. */
export interface CommandResultMap {
  listFolders: FolderListing;
  createProject: Project;
  archiveProject: null;
  restoreProject: null;
  sendMessage: ChatMessage;
  cancelQueued: null;
  stopAgent: null;
  resetAgentSession: null;
  setChatOnly: null;
  submitTask: Task;
  cancelTask: null;
  resumeTask: null;
  answerTask: null;
  respondPermission: null;
  pinToNotes: null;
  /** The notes file's content. */
  getNotes: string;
  getChatHistory: ChatHistoryPage;
  getSnapshot: WorldSnapshot;
}

export type ClientCommand = { [N in CommandName]: { name: N; args: CommandArgsMap[N] } }[CommandName];

// ── Client → server ─────────────────────────────────────────────────────────

/** Must be the first message on every connection; the server closes the socket otherwise. */
export interface HelloMessage {
  type: "hello";
  token: string;
}

export interface CommandMessage {
  type: "command";
  id: string;
  command: ClientCommand;
}

export type ClientMessage = HelloMessage | CommandMessage;

// ── Server → client ─────────────────────────────────────────────────────────

export interface SnapshotMessage {
  type: "snapshot";
  snapshot: WorldSnapshot;
}

export interface EventMessage {
  type: "event";
  event: AgentEvent;
}

export interface AckOkMessage {
  type: "ack";
  id: string;
  ok: true;
  result?: unknown;
}

export interface AckErrorMessage {
  type: "ack";
  id: string;
  ok: false;
  error: string;
}

export type AckMessage = AckOkMessage | AckErrorMessage;
export type ServerMessage = SnapshotMessage | EventMessage | AckMessage;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
