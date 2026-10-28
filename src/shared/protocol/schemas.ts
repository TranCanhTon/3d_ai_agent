// Runtime validation of every WebSocket message, in both directions.
// `SchemaTypeChecks` at the bottom fails `npm run typecheck` if a schema
// drifts from the hand-written types in protocol.ts and src/shared/domain.

import { z } from "zod";
import { AGENT_RUNNER_KINDS, CONFIG } from "../config.ts";
import { AGENT_STATUSES, EFFORT_LEVELS, STATION_IDS, type AgentState } from "../domain/agentTypes.ts";
import { CHAT_MESSAGE_STATUSES, type Chat, type ChatAuthor, type ChatMessage } from "../domain/chatTypes.ts";
import type { PermissionRequest } from "../domain/permissions.ts";
import type { Project } from "../domain/projectTypes.ts";
import { AGENT_ROLES } from "../domain/roles.ts";
import {
  TASK_END_REASONS,
  TASK_PRIORITIES,
  TASK_STATUSES,
  WORKFLOW_PHASES,
  WORKFLOW_SIGNALS,
  type Task,
} from "../domain/taskTypes.ts";
import { EVENT_SEVERITIES, EVENT_TYPES, type AgentEvent } from "../events/eventTypes.ts";
import {
  CHAT_VIEWS,
  COMM_LINK_KINDS,
  type ClientCommand,
  type ClientMessage,
  type CommandResultMap,
  type CommLink,
  type ParseResult,
  type ServerMessage,
  type WorldSnapshot,
} from "./protocol.ts";

const id = z.string().min(1);
const epochMs = z.number();

// ── Domain ──────────────────────────────────────────────────────────────────

export const projectSchema = z.object({
  id,
  name: z.string(),
  rootPath: z.string(),
  isGitRepo: z.boolean(),
  archived: z.boolean(),
  createdAt: epochMs,
});

export const agentStateSchema = z.object({
  id,
  projectId: id,
  role: z.enum(AGENT_ROLES),
  name: z.string(),
  status: z.enum(AGENT_STATUSES),
  activity: z.string(),
  location: z.enum(STATION_IDS),
  currentTaskId: z.string().nullable(),
  activeChatId: id,
  chatOnly: z.boolean(),
  model: z.string(),
  effort: z.enum(EFFORT_LEVELS).nullable(),
  lastRun: z.object({ model: z.string(), effort: z.string().nullable() }).nullable(),
  busy: z.boolean(),
  queuedCount: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: epochMs,
});

export const taskSchema = z.object({
  id,
  projectId: id,
  title: z.string(),
  description: z.string(),
  priority: z.enum(TASK_PRIORITIES),
  status: z.enum(TASK_STATUSES),
  phase: z.enum(WORKFLOW_PHASES),
  assignedAgentId: z.string().nullable(),
  progress: z.number().min(0).max(1),
  createdAt: epochMs,
  updatedAt: epochMs,
  completedAt: epochMs.nullable(),
  iteration: z.number().int().nonnegative(),
  subtasks: z.array(z.object({ id, title: z.string(), done: z.boolean() })),
  findings: z.array(z.string()),
  history: z.array(
    z.object({
      from: z.enum(WORKFLOW_PHASES),
      to: z.enum(WORKFLOW_PHASES),
      signal: z.enum(WORKFLOW_SIGNALS),
      at: epochMs,
    }),
  ),
  blockedReason: z.string().nullable(),
  sessions: z.partialRecord(z.enum(AGENT_ROLES), z.string()),
  outputs: z.partialRecord(z.enum(AGENT_ROLES), z.string()),
  question: z.string().nullable(),
  endReason: z.enum(TASK_END_REASONS).nullable(),
  summary: z.string().nullable(),
});

export const chatAuthorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("agent") }),
  z.object({ kind: z.literal("handoff"), fromAgentId: id }),
  z.object({ kind: z.literal("tool"), toolName: z.string() }),
  z.object({ kind: z.literal("system") }),
]);

export const chatMessageSchema = z.object({
  id,
  projectId: id,
  agentId: id,
  author: chatAuthorSchema,
  text: z.string(),
  taskId: z.string().nullable(),
  chatId: z.string().nullable(),
  pinned: z.boolean(),
  status: z.enum(CHAT_MESSAGE_STATUSES),
  createdAt: epochMs,
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
});

export const chatSchema = z.object({
  id,
  projectId: id,
  agentId: id,
  title: z.string(),
  claudeSessionId: z.string().nullable(),
  createdAt: epochMs,
  updatedAt: epochMs,
  messageCount: z.number().int().nonnegative(),
  contextTokens: z.number().int().nonnegative().nullable(),
});

export const permissionRequestSchema = z.object({
  id,
  projectId: id,
  agentId: id,
  toolName: z.string(),
  summary: z.string(),
  input: z.unknown(),
  createdAt: epochMs,
});

export const agentEventSchema = z.object({
  id,
  type: z.enum(EVENT_TYPES),
  timestamp: epochMs,
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  targetAgentId: z.string().optional(),
  taskId: z.string().optional(),
  message: z.string(),
  severity: z.enum(EVENT_SEVERITIES),
  feed: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const commLinkSchema = z.object({
  id,
  from: id,
  to: id,
  kind: z.enum(COMM_LINK_KINDS),
  startedAt: epochMs,
  endsAt: epochMs,
});

export const worldSnapshotSchema = z.object({
  serverTime: epochMs,
  projects: z.array(projectSchema),
  agents: z.array(agentStateSchema),
  tasks: z.array(taskSchema),
  links: z.array(commLinkSchema),
  pendingPermissions: z.array(permissionRequestSchema),
  usage: z.object({ limited: z.boolean(), resetsAt: epochMs.nullable() }),
  auth: z.object({ source: z.string().nullable() }),
  runner: z.enum(AGENT_RUNNER_KINDS),
});

// ── Client → server (strict: unknown keys are rejected) ─────────────────────

const text = z.string().min(1).max(CONFIG.maxMessageChars);

/** One of config.models. */
export function isModelId(value: string): boolean {
  return CONFIG.models.some((model) => model.id === value);
}

function command<N extends string, A extends z.ZodRawShape>(name: N, args: A) {
  return z.strictObject({ name: z.literal(name), args: z.strictObject(args) });
}

export const clientCommandSchema = z.discriminatedUnion("name", [
  command("listFolders", { path: z.string().min(1).optional() }),
  command("createProject", {
    name: z.string().trim().min(1).max(CONFIG.projectNameMaxChars),
    rootPath: z.string().min(1),
    initGit: z.boolean().optional(),
  }),
  command("archiveProject", { projectId: id }),
  command("restoreProject", { projectId: id }),
  command("sendMessage", { agentId: id, text, chatId: id.optional() }),
  command("cancelQueued", { agentId: id, messageId: id }),
  command("stopAgent", { agentId: id }),
  command("newChat", { agentId: id }),
  command("openChat", { agentId: id, chatId: id }),
  command("listChats", { agentId: id }),
  command("setChatOnly", { agentId: id, chatOnly: z.boolean() }),
  command("setAgentModel", {
    agentId: id,
    model: z.string().refine((value) => isModelId(value), { message: "Unknown model" }),
    effort: z.enum(EFFORT_LEVELS).nullable(),
  }),
  command("submitTask", {
    projectId: id,
    title: z.string().trim().min(1).max(CONFIG.maxTaskTitleChars),
    description: z.string().max(CONFIG.maxMessageChars).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
  }),
  command("cancelTask", { taskId: id }),
  command("resumeTask", { taskId: id }),
  command("answerTask", { taskId: id, text }),
  command("respondPermission", { requestId: id, decision: z.enum(["allow", "deny"]) }),
  command("pinToNotes", { messageId: id, text: z.string().trim().min(1).max(CONFIG.noteMaxChars) }),
  command("getNotes", { projectId: id }),
  command("addNote", { projectId: id, text: z.string().trim().min(1).max(CONFIG.noteMaxChars) }),
  command("getChatHistory", {
    agentId: id,
    before: id.optional(),
    limit: z.number().int().min(1).max(CONFIG.chatHistoryMaxLimit).optional(),
    view: z.enum(CHAT_VIEWS).optional(),
    chatId: id.optional(),
  }),
  command("getSnapshot", {}),
]);

export const helloMessageSchema = z.strictObject({ type: z.literal("hello"), token: z.string().min(1) });

export const commandMessageSchema = z.strictObject({
  type: z.literal("command"),
  id,
  command: clientCommandSchema,
});

export const clientMessageSchema = z.discriminatedUnion("type", [helloMessageSchema, commandMessageSchema]);

// ── Server → client ─────────────────────────────────────────────────────────

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: worldSnapshotSchema }),
  z.object({ type: z.literal("event"), event: agentEventSchema }),
  z.discriminatedUnion("ok", [
    z.object({ type: z.literal("ack"), id, ok: z.literal(true), result: z.unknown().optional() }),
    z.object({ type: z.literal("ack"), id, ok: z.literal(false), error: z.string() }),
  ]),
]);

/** Validates the `result` of a successful ack for a given command. */
export const commandResultSchemas = {
  listFolders: z.object({
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        isGitRepo: z.boolean(),
        hasProject: z.boolean(),
        blocked: z.string().nullable(),
      }),
    ),
  }),
  createProject: projectSchema,
  archiveProject: z.null(),
  restoreProject: z.null(),
  sendMessage: chatMessageSchema,
  cancelQueued: z.null(),
  stopAgent: z.null(),
  newChat: chatSchema,
  openChat: z.null(),
  listChats: z.array(chatSchema),
  setChatOnly: z.null(),
  setAgentModel: z.null(),
  submitTask: taskSchema,
  cancelTask: z.null(),
  resumeTask: z.null(),
  answerTask: z.null(),
  respondPermission: z.null(),
  pinToNotes: z.null(),
  getNotes: z.string(),
  addNote: z.null(),
  getChatHistory: z.object({ messages: z.array(chatMessageSchema), hasMore: z.boolean() }),
  getSnapshot: worldSnapshotSchema,
};

type ResultSchemaMap = { [N in keyof CommandResultMap]: z.ZodType<CommandResultMap[N]> };
const resultSchemaMap: ResultSchemaMap = commandResultSchemas;

// ── Parsing (never throws) ──────────────────────────────────────────────────

function formatError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): ParseResult<T> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const result = schema.safeParse(data);
  return result.success ? { ok: true, value: result.data } : { ok: false, error: formatError(result.error) };
}

export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseJson(raw, clientMessageSchema);
}

export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseJson(raw, serverMessageSchema);
}

export function parseCommandResult<N extends keyof CommandResultMap>(
  name: N,
  result: unknown,
): ParseResult<CommandResultMap[N]> {
  const schema: z.ZodType<CommandResultMap[N]> = resultSchemaMap[name];
  const parsed = schema.safeParse(result ?? null);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: formatError(parsed.error) };
}

// ── Compile-time sync checks between schemas and types ──────────────────────

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type ResultTypesMatch = {
  [N in keyof CommandResultMap]: Equals<z.infer<(typeof commandResultSchemas)[N]>, CommandResultMap[N]>;
}[keyof CommandResultMap];

export type SchemaTypeChecks = [
  Expect<Equals<z.infer<typeof projectSchema>, Project>>,
  Expect<Equals<z.infer<typeof agentStateSchema>, AgentState>>,
  Expect<Equals<z.infer<typeof taskSchema>, Task>>,
  Expect<Equals<z.infer<typeof chatAuthorSchema>, ChatAuthor>>,
  Expect<Equals<z.infer<typeof chatMessageSchema>, ChatMessage>>,
  Expect<Equals<z.infer<typeof chatSchema>, Chat>>,
  Expect<Equals<z.infer<typeof permissionRequestSchema>, PermissionRequest>>,
  Expect<Equals<z.infer<typeof agentEventSchema>, AgentEvent>>,
  Expect<Equals<z.infer<typeof commLinkSchema>, CommLink>>,
  Expect<Equals<z.infer<typeof worldSnapshotSchema>, WorldSnapshot>>,
  Expect<Equals<z.infer<typeof clientCommandSchema>, ClientCommand>>,
  Expect<Equals<z.infer<typeof clientMessageSchema>, ClientMessage>>,
  Expect<Equals<z.infer<typeof serverMessageSchema>, ServerMessage>>,
  Expect<ResultTypesMatch>,
];
