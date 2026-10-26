import { isAgentRole, type AgentRole } from "./domain/roles.ts";

/** Agent ids are role based, so renaming an agent never breaks saved data. */
export function makeAgentId(projectId: string, role: AgentRole): string {
  if (projectId.length === 0 || projectId.includes(":")) {
    throw new Error(`Invalid project id: "${projectId}"`);
  }
  return `${projectId}:${role}`;
}

export function parseAgentId(agentId: string): { projectId: string; role: AgentRole } | null {
  const sep = agentId.lastIndexOf(":");
  if (sep <= 0) return null;
  const projectId = agentId.slice(0, sep);
  const role = agentId.slice(sep + 1);
  if (projectId.includes(":") || !isAgentRole(role)) return null;
  return { projectId, role };
}

/** `${prefix}_${16 hex chars}`. Prefix must not contain ":" (project ids end up in agent ids). */
export function newId(prefix: string): string {
  const hex = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return `${prefix}_${hex}`;
}
