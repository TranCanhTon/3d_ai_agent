// In-memory world state owned by the server (no persistence until a later phase).
// Mutations go through here so every change can emit events and schedule a snapshot.

import { CONFIG } from "../../src/shared/config.ts";
import type { AgentState } from "../../src/shared/domain/agentTypes.ts";
import type { ChatMessage } from "../../src/shared/domain/chatTypes.ts";
import type { PermissionRequest } from "../../src/shared/domain/permissions.ts";
import type { Project } from "../../src/shared/domain/projectTypes.ts";
import { AGENT_ROLES, ROLE_DEFINITIONS } from "../../src/shared/domain/roles.ts";
import type { Task } from "../../src/shared/domain/taskTypes.ts";
import type { AgentEvent } from "../../src/shared/events/eventTypes.ts";
import { makeAgentId, newId } from "../../src/shared/ids.ts";
import type { CommLink, UsageState, WorldSnapshot } from "../../src/shared/protocol/protocol.ts";

export type EventInput = Omit<AgentEvent, "id" | "timestamp" | "severity" | "feed"> &
  Partial<Pick<AgentEvent, "severity" | "feed">>;

export interface WorldHooks {
  onEvent(event: AgentEvent): void;
  /** Called after any change that should reach clients in the next snapshot. */
  onChange(): void;
}

export class World {
  readonly projects = new Map<string, Project>();
  readonly agents = new Map<string, AgentState>();
  readonly tasks = new Map<string, Task>();
  links: CommLink[] = [];
  pendingPermissions: PermissionRequest[] = [];
  usage: UsageState = { limited: false, resetsAt: null };

  private readonly chat = new Map<string, ChatMessage[]>();
  private readonly hooks: WorldHooks;
  readonly now: () => number;

  constructor(hooks: WorldHooks, now: () => number = Date.now) {
    this.hooks = hooks;
    this.now = now;
  }

  emit(input: EventInput): AgentEvent {
    const event: AgentEvent = { severity: "info", feed: true, ...input, id: newId("evt"), timestamp: this.now() };
    this.hooks.onEvent(event);
    return event;
  }

  changed(): void {
    this.hooks.onChange();
  }

  snapshot(): WorldSnapshot {
    const now = this.now();
    this.links = this.links.filter((link) => link.endsAt > now);
    return {
      serverTime: now,
      projects: [...this.projects.values()],
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      links: [...this.links],
      pendingPermissions: [...this.pendingPermissions],
      usage: { ...this.usage },
    };
  }

  /** Seeds the demo project with its 6 agents, idle at their home stations. */
  seedSandbox(rootPath: string): Project {
    const now = this.now();
    const project: Project = {
      id: CONFIG.sandboxProjectId,
      name: "Sandbox",
      rootPath,
      isGitRepo: false,
      archived: false,
      createdAt: now,
    };
    this.projects.set(project.id, project);
    for (const role of AGENT_ROLES) {
      const def = ROLE_DEFINITIONS[role];
      const agent: AgentState = {
        id: makeAgentId(project.id, role),
        projectId: project.id,
        role,
        name: def.name,
        status: "idle",
        activity: "",
        location: def.homeStation,
        currentTaskId: null,
        claudeSessionId: null,
        busy: false,
        queuedCount: 0,
        lastError: null,
        updatedAt: now,
      };
      this.agents.set(agent.id, agent);
      this.chat.set(agent.id, []);
    }
    this.changed();
    return project;
  }

  getAgent(agentId: string): AgentState {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  updateAgent(agentId: string, patch: Partial<Omit<AgentState, "id" | "projectId" | "role">>): AgentState {
    const next: AgentState = { ...this.getAgent(agentId), ...patch, updatedAt: this.now() };
    this.agents.set(agentId, next);
    this.changed();
    return next;
  }

  // ── Chat ──

  chatFor(agentId: string): ChatMessage[] {
    const list = this.chat.get(agentId);
    if (list === undefined) throw new Error(`Unknown agent: ${agentId}`);
    return list;
  }

  addMessage(message: ChatMessage): void {
    this.chatFor(message.agentId).push(message);
  }

  findMessage(agentId: string, messageId: string): ChatMessage | undefined {
    return this.chatFor(agentId).find((m) => m.id === messageId);
  }

  updateMessage(agentId: string, messageId: string, patch: Partial<Pick<ChatMessage, "text" | "status" | "pinned">>): ChatMessage {
    const list = this.chatFor(agentId);
    const index = list.findIndex((m) => m.id === messageId);
    const current = list[index];
    if (current === undefined) throw new Error(`Unknown message: ${messageId}`);
    const next = { ...current, ...patch };
    list[index] = next;
    return next;
  }

  removeMessage(agentId: string, messageId: string): void {
    const list = this.chatFor(agentId);
    const index = list.findIndex((m) => m.id === messageId);
    if (index >= 0) list.splice(index, 1);
  }
}
