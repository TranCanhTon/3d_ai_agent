// Event vocabulary shared by the server and the browser. The server's SDK
// translator (later phase) maps Claude Agent SDK messages onto these.

export const EVENT_TYPES = [
  "system.ready",
  "system.error",
  "project.created",
  "project.archived",
  "task.created",
  "task.assigned",
  "task.status_changed",
  "task.paused",
  "task.resumed",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "plan.created",
  "research.completed",
  "implementation.started",
  "implementation.submitted",
  "qa.started",
  "qa.passed",
  "qa.failed",
  "review.started",
  "review.approved",
  "review.changes_requested",
  "agent.status_changed",
  "agent.tool_started",
  "agent.tool_finished",
  "agent.message",
  "agent.queue_changed",
  "agent.waiting_user",
  "agent.stopped",
  "agent.session_reset",
  "agent.error",
  "chat.message_created",
  "chat.message_delta",
  "chat.message_completed",
  "permission.requested",
  "permission.resolved",
  "notes.updated",
  "usage.limit_reached",
] as const;
export type AgentEventType = (typeof EVENT_TYPES)[number];

export const EVENT_SEVERITIES = ["info", "success", "warning", "error"] as const;
export type EventSeverity = (typeof EVENT_SEVERITIES)[number];

export interface AgentEvent {
  id: string;
  type: AgentEventType;
  /** Epoch ms, set by the server. */
  timestamp: number;
  projectId?: string;
  agentId?: string;
  targetAgentId?: string;
  taskId?: string;
  message: string;
  severity: EventSeverity;
  /** Belongs in the human-facing activity feed? */
  feed: boolean;
  metadata?: Record<string, unknown>;
}

const COMMUNICATION_TYPES: ReadonlySet<AgentEventType> = new Set(["agent.message", "task.assigned"]);

/** Agent to agent communication, drawn as an arc in the 3D view. */
export function isCommunication(event: AgentEvent): boolean {
  return event.targetAgentId !== undefined && COMMUNICATION_TYPES.has(event.type);
}
