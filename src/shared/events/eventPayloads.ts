// Typed `metadata` for events whose payload the client relies on.
// The server builds metadata with these types; the client reads it with readPayload.

import { z } from "zod";
import { AGENT_STATUSES } from "../domain/agentTypes.ts";
import { chatMessageSchema, permissionRequestSchema } from "../protocol/schemas.ts";
import type { AgentEvent, AgentEventType } from "./eventTypes.ts";

export const eventPayloadSchemas = {
  /** chat.message_created and chat.message_completed carry the whole message. */
  chatMessage: z.object({ message: chatMessageSchema }),
  /** chat.message_delta: text to append to a streaming message. */
  chatDelta: z.object({ messageId: z.string(), delta: z.string() }),
  /** agent.status_changed */
  agentStatus: z.object({ status: z.enum(AGENT_STATUSES), activity: z.string() }),
  /** agent.queue_changed: the full queue after the change, plus what changed. */
  queueChanged: z.object({
    queuedMessageIds: z.array(z.string()),
    startedMessageId: z.string().optional(),
    cancelledMessageId: z.string().optional(),
  }),
  /** agent.tool_started / agent.tool_finished (`ok` only on finished). */
  tool: z.object({ toolUseId: z.string(), toolName: z.string(), summary: z.string(), ok: z.boolean().optional() }),
  /** permission.requested */
  permissionRequested: z.object({ request: permissionRequestSchema }),
  /** permission.resolved */
  permissionResolved: z.object({ requestId: z.string(), decision: z.enum(["allow", "deny"]) }),
  /** usage.limit_reached */
  usageLimit: z.object({ resetsAt: z.number().nullable() }),
  /** notes.updated: the line appended to the project's notes file. */
  notesUpdated: z.object({ line: z.string() }),
};

export type ChatMessagePayload = z.infer<typeof eventPayloadSchemas.chatMessage>;
export type ChatDeltaPayload = z.infer<typeof eventPayloadSchemas.chatDelta>;
export type AgentStatusPayload = z.infer<typeof eventPayloadSchemas.agentStatus>;
export type QueueChangedPayload = z.infer<typeof eventPayloadSchemas.queueChanged>;
export type ToolPayload = z.infer<typeof eventPayloadSchemas.tool>;
export type PermissionRequestedPayload = z.infer<typeof eventPayloadSchemas.permissionRequested>;
export type PermissionResolvedPayload = z.infer<typeof eventPayloadSchemas.permissionResolved>;
export type UsageLimitPayload = z.infer<typeof eventPayloadSchemas.usageLimit>;
export type NotesUpdatedPayload = z.infer<typeof eventPayloadSchemas.notesUpdated>;

/** Returns the event's metadata if the event has the given type and the metadata matches. */
export function readPayload<T>(event: AgentEvent, type: AgentEventType | AgentEventType[], schema: z.ZodType<T>): T | null {
  const types = Array.isArray(type) ? type : [type];
  if (!types.includes(event.type)) return null;
  const parsed = schema.safeParse(event.metadata);
  return parsed.success ? parsed.data : null;
}
