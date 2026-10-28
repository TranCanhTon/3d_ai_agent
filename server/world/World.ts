// World state owned by the server. Mutations go through here so every change
// can emit events, schedule a snapshot and, with a DataStore, be saved.

import { CONFIG, type AgentRunnerKind } from "../../src/shared/config.ts";
import type { AgentState } from "../../src/shared/domain/agentTypes.ts";
import type { ChatMessage } from "../../src/shared/domain/chatTypes.ts";
import type { AgentInput } from "../../src/shared/domain/messageQueue.ts";
import type { PermissionRequest } from "../../src/shared/domain/permissions.ts";
import type { Project } from "../../src/shared/domain/projectTypes.ts";
import { AGENT_ROLES, ROLE_DEFINITIONS, type AgentRole } from "../../src/shared/domain/roles.ts";
import type { Task } from "../../src/shared/domain/taskTypes.ts";
import type { AgentEvent } from "../../src/shared/events/eventTypes.ts";
import { makeAgentId, newId } from "../../src/shared/ids.ts";
import { isModelId } from "../../src/shared/protocol/schemas.ts";
import type { AuthState, CommLink, UsageState, WorldSnapshot } from "../../src/shared/protocol/protocol.ts";
import type { DataStore, SavedAgent, SavedTask } from "../store/DataStore.ts";

export type EventInput = Omit<AgentEvent, "id" | "timestamp" | "severity" | "feed"> &
  Partial<Pick<AgentEvent, "severity" | "feed">>;

export interface WorldHooks {
  onEvent(event: AgentEvent): void;
  /** Called after any change that should reach clients in the next snapshot. */
  onChange(): void;
}

/** Agent fields that are saved; changing one of them rewrites the project's agents file. */
const SAVED_AGENT_FIELDS = ["name", "claudeSessionId", "chatOnly", "model", "effort"] as const;

export const INTERRUPTED = "[interrupted]";

export class World {
  readonly projects = new Map<string, Project>();
  readonly agents = new Map<string, AgentState>();
  readonly tasks = new Map<string, Task>();
  links: CommLink[] = [];
  pendingPermissions: PermissionRequest[] = [];
  usage: UsageState = { limited: false, resetsAt: null };
  auth: AuthState = { source: null };
  readonly runner: AgentRunnerKind;

  private readonly chat = new Map<string, ChatMessage[]>();
  /** message id → agent id, for commands that only know the message. */
  private readonly messageAgents = new Map<string, string>();
  /** Inputs waiting in each agent's queue, as last reported by the AgentManager (saved). */
  private readonly queues = new Map<string, AgentInput[]>();
  private readonly hooks: WorldHooks;
  private readonly store: DataStore | null;
  readonly now: () => number;

  constructor(hooks: WorldHooks, runner: AgentRunnerKind, now: () => number = Date.now, store: DataStore | null = null) {
    this.hooks = hooks;
    this.runner = runner;
    this.now = now;
    this.store = store;
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
      auth: { ...this.auth },
      runner: this.runner,
    };
  }

  // ── Loading ──

  /**
   * Loads saved projects, agents and chats. Agents start idle. Messages a crash
   * left streaming or delivered (and queued ones no longer in a queue) become
   * errors marked [interrupted]; no events, they are history.
   * Task inputs are dropped from the queues: their tasks are paused "Server restarted"
   * by the pipeline and continue only when I resume them.
   * Returns each agent's saved queue, to be restored by the AgentManager, and the
   * saved tasks, for the pipeline.
   */
  load(): { queues: Map<string, AgentInput[]>; tasks: Map<string, SavedTask[]> } {
    if (this.store === null) return { queues: new Map(), tasks: new Map() };
    const data = this.store.load();
    const queues = new Map<string, AgentInput[]>();
    const dropped = new Set<string>();

    for (const project of data.projects) {
      this.projects.set(project.id, project);
      const saved = new Map((data.agents.get(project.id) ?? []).map((a) => [a.role, a]));
      for (const role of AGENT_ROLES) {
        const agent = this.newAgent(project.id, role, saved.get(role));
        this.agents.set(agent.id, agent);
        this.chat.set(agent.id, []);
        const queue = (saved.get(role)?.queue ?? []).filter((input) => input.taskId === null);
        this.queues.set(agent.id, queue);
        if (queue.length !== (saved.get(role)?.queue ?? []).length) dropped.add(project.id);
        if (queue.length > 0) queues.set(agent.id, queue);
      }
    }

    for (const [agentId, messages] of data.chats) {
      const list = this.chat.get(agentId);
      if (list === undefined) continue;
      const queuedIds = new Set((queues.get(agentId) ?? []).map((input) => input.id));
      for (const loaded of messages) {
        let message = loaded;
        const stillQueued = message.status === "queued" && queuedIds.has(message.id);
        if (message.status === "streaming" || message.status === "delivered" || (message.status === "queued" && !stillQueued)) {
          message = { ...message, status: "error", text: message.text === "" ? INTERRUPTED : `${message.text} ${INTERRUPTED}` };
          this.store.appendMessage(message);
        }
        list.push(message);
        this.messageAgents.set(message.id, agentId);
      }
    }
    for (const projectId of dropped) this.saveAgents(projectId);
    return { queues, tasks: data.tasks };
  }

  // ── Projects ──

  getProject(projectId: string): Project {
    const project = this.projects.get(projectId);
    if (project === undefined) throw new Error(`Unknown project: ${projectId}`);
    return project;
  }

  getProjectRoot(projectId: string): string {
    return this.getProject(projectId).rootPath;
  }

  /** Adds a project with its 6 agents, idle at their home stations, and saves both. */
  addProject(project: Project): void {
    if (this.projects.has(project.id)) throw new Error(`Project already exists: ${project.id}`);
    this.projects.set(project.id, project);
    for (const role of AGENT_ROLES) {
      const agent = this.newAgent(project.id, role, undefined);
      this.agents.set(agent.id, agent);
      this.chat.set(agent.id, []);
      this.queues.set(agent.id, []);
    }
    this.saveProjects();
    this.saveAgents(project.id);
    this.changed();
  }

  updateProject(projectId: string, patch: Partial<Pick<Project, "name" | "archived" | "isGitRepo">>): Project {
    const next: Project = { ...this.getProject(projectId), ...patch };
    this.projects.set(projectId, next);
    this.saveProjects();
    this.changed();
    return next;
  }

  /** In-memory demo project with its 6 agents (tests that need no files). */
  seedSandbox(rootPath: string, isGitRepo = false): Project {
    const project: Project = {
      id: CONFIG.sandboxProjectId,
      name: "Sandbox",
      rootPath,
      isGitRepo,
      archived: false,
      createdAt: this.now(),
    };
    this.addProject(project);
    return project;
  }

  private newAgent(projectId: string, role: AgentRole, saved: SavedAgent | undefined): AgentState {
    const def = ROLE_DEFINITIONS[role];
    const defaults = CONFIG.roleModelDefaults[role];
    // A saved model that is no longer offered falls back to the role default (effort with it).
    const savedModel = saved?.model !== undefined && isModelId(saved.model) ? saved.model : undefined;
    return {
      id: makeAgentId(projectId, role),
      projectId,
      role,
      name: saved?.name ?? def.name,
      status: "idle",
      activity: "",
      location: def.homeStation,
      currentTaskId: null,
      claudeSessionId: saved?.claudeSessionId ?? null,
      chatOnly: saved?.chatOnly ?? false,
      model: savedModel ?? defaults.model,
      effort: savedModel === undefined ? defaults.effort : (saved?.effort ?? null),
      lastRun: null,
      busy: false,
      queuedCount: 0,
      lastError: null,
      updatedAt: this.now(),
    };
  }

  // ── Agents ──

  getAgent(agentId: string): AgentState {
    const agent = this.agents.get(agentId);
    if (agent === undefined) throw new Error(`Unknown agent: ${agentId}`);
    return agent;
  }

  updateAgent(agentId: string, patch: Partial<Omit<AgentState, "id" | "projectId" | "role">>): AgentState {
    const current = this.getAgent(agentId);
    const next: AgentState = { ...current, ...patch, updatedAt: this.now() };
    this.agents.set(agentId, next);
    if (SAVED_AGENT_FIELDS.some((field) => field in patch && patch[field] !== current[field])) this.saveAgents(next.projectId);
    this.changed();
    return next;
  }

  /** The AgentManager reports its waiting inputs after every queue change, so they survive a restart. */
  setSavedQueue(agentId: string, inputs: readonly AgentInput[]): void {
    const agent = this.getAgent(agentId);
    const current = this.queues.get(agentId) ?? [];
    if (current.length === inputs.length && current.every((input, i) => input.id === inputs[i]?.id)) return;
    this.queues.set(agentId, [...inputs]);
    this.saveAgents(agent.projectId);
  }

  // ── Chat ──

  chatFor(agentId: string): ChatMessage[] {
    const list = this.chat.get(agentId);
    if (list === undefined) throw new Error(`Unknown agent: ${agentId}`);
    return list;
  }

  addMessage(message: ChatMessage): void {
    this.chatFor(message.agentId).push(message);
    this.messageAgents.set(message.id, message.agentId);
    this.store?.appendMessage(message);
  }

  findMessage(agentId: string, messageId: string): ChatMessage | undefined {
    return this.chatFor(agentId).find((m) => m.id === messageId);
  }

  /** Finds a message in any agent's chat. */
  findMessageById(messageId: string): ChatMessage | undefined {
    const agentId = this.messageAgents.get(messageId);
    return agentId === undefined ? undefined : this.findMessage(agentId, messageId);
  }

  /** `persist: false` for streamed text deltas; the text is saved when the message ends. */
  updateMessage(
    agentId: string,
    messageId: string,
    patch: Partial<Pick<ChatMessage, "text" | "status" | "pinned" | "usage">>,
    persist = true,
  ): ChatMessage {
    const list = this.chatFor(agentId);
    const index = list.findIndex((m) => m.id === messageId);
    const current = list[index];
    if (current === undefined) throw new Error(`Unknown message: ${messageId}`);
    const next = { ...current, ...patch };
    list[index] = next;
    if (persist) this.store?.appendMessage(next);
    return next;
  }

  removeMessage(agentId: string, messageId: string): void {
    const list = this.chatFor(agentId);
    const index = list.findIndex((m) => m.id === messageId);
    if (index < 0) return;
    list.splice(index, 1);
    this.messageAgents.delete(messageId);
    this.store?.deleteMessage(agentId, messageId);
  }

  // ── Tasks and links ──

  /** The pipeline owns tasks; this mirrors one into the snapshot. */
  setTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.changed();
  }

  getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (task === undefined) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  /** An arc between two agents, shown for commLinkDurationMs (expired links drop out of the snapshot). */
  addLink(from: string, to: string, kind: CommLink["kind"]): void {
    const now = this.now();
    this.links = [...this.links.filter((link) => link.endsAt > now), { id: newId("link"), from, to, kind, startedAt: now, endsAt: now + CONFIG.commLinkDurationMs }];
    this.changed();
    // One more snapshot once it has expired, so clients stop drawing it.
    setTimeout(() => this.changed(), CONFIG.commLinkDurationMs + 1).unref();
  }

  // ── Saving ──

  private saveProjects(): void {
    this.store?.saveProjects([...this.projects.values()]);
  }

  private saveAgents(projectId: string): void {
    if (this.store === null) return;
    const agents = [...this.agents.values()]
      .filter((a) => a.projectId === projectId)
      .map(
        (a): SavedAgent => ({
          id: a.id,
          role: a.role,
          name: a.name,
          claudeSessionId: a.claudeSessionId,
          chatOnly: a.chatOnly,
          model: a.model,
          effort: a.effort,
          queue: this.queues.get(a.id) ?? [],
        }),
      );
    this.store.saveAgents(projectId, agents);
  }
}
