// JSON persistence under dataDir. Loaded once on start; written on every change.
//
//   projects.json                       Project[]
//   agents/<projectId>.json             SavedAgent[] (session id, chat only flag, pending inputs)
//   chats/<agentId with : → _>.jsonl    one ChatMessage per line; a later line for the same id
//                                       replaces it; { deletedId } removes it (a cancelled queued message)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ChatMessage } from "../../src/shared/domain/chatTypes.ts";
import type { AgentInput } from "../../src/shared/domain/messageQueue.ts";
import type { Project } from "../../src/shared/domain/projectTypes.ts";
import { AGENT_ROLES, type AgentRole } from "../../src/shared/domain/roles.ts";
import { chatMessageSchema, projectSchema } from "../../src/shared/protocol/schemas.ts";
import type { Logger } from "../log.ts";
import { appendLine, readJson, writeJsonAtomic } from "./files.ts";

export interface SavedAgent {
  id: string;
  role: AgentRole;
  name: string;
  claudeSessionId: string | null;
  chatOnly: boolean;
  /** Inputs waiting in the agent's queue (not the one running). */
  queue: AgentInput[];
}

export interface LoadedData {
  projects: Project[];
  /** By project id. */
  agents: Map<string, SavedAgent[]>;
  /** By agent id, oldest first, latest line per message. */
  chats: Map<string, ChatMessage[]>;
}

const agentInputSchema = z.object({
  id: z.string(),
  source: z.enum(["user", "handoff"]),
  text: z.string(),
  taskId: z.string().nullable(),
  fromAgentId: z.string().nullable(),
  enqueuedAt: z.number(),
});

const savedAgentSchema = z.object({
  id: z.string(),
  role: z.enum(AGENT_ROLES),
  name: z.string(),
  claudeSessionId: z.string().nullable(),
  chatOnly: z.boolean().default(false),
  queue: z.array(agentInputSchema).default([]),
});

const deletionSchema = z.object({ deletedId: z.string() });

export function chatFileName(agentId: string): string {
  return `${agentId.replace(/[:\\/]/g, "_")}.jsonl`;
}

export class DataStore {
  readonly dataDir: string;
  private readonly log: Logger;

  constructor(dataDir: string, log: Logger) {
    this.dataDir = dataDir;
    this.log = log;
  }

  private get projectsPath(): string {
    return join(this.dataDir, "projects.json");
  }

  private agentsPath(projectId: string): string {
    return join(this.dataDir, "agents", `${projectId}.json`);
  }

  private chatPath(agentId: string): string {
    return join(this.dataDir, "chats", chatFileName(agentId));
  }

  load(): LoadedData {
    const projects = z.array(projectSchema).parse(readJson(this.projectsPath) ?? []);

    const agents = new Map<string, SavedAgent[]>();
    for (const project of projects) {
      const raw = readJson(this.agentsPath(project.id));
      if (raw === undefined) continue;
      agents.set(project.id, z.array(savedAgentSchema).parse(raw));
    }

    const chats = new Map<string, ChatMessage[]>();
    const chatDir = join(this.dataDir, "chats");
    if (existsSync(chatDir)) {
      for (const file of readdirSync(chatDir)) {
        if (!file.endsWith(".jsonl")) continue;
        const messages = this.readChat(join(chatDir, file));
        const first = messages[0];
        if (first !== undefined) chats.set(first.agentId, messages);
      }
    }
    return { projects, agents, chats };
  }

  /** Latest line per message id wins; order is by first appearance. Bad lines are skipped. */
  private readChat(path: string): ChatMessage[] {
    const byId = new Map<string, ChatMessage>();
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (line.trim() === "") return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.log(`skipping unreadable line ${index + 1} of ${path}`);
        return;
      }
      const deletion = deletionSchema.safeParse(value);
      if (deletion.success) {
        byId.delete(deletion.data.deletedId);
        return;
      }
      const message = chatMessageSchema.safeParse(value);
      if (message.success) byId.set(message.data.id, message.data);
      else this.log(`skipping invalid line ${index + 1} of ${path}`);
    });
    return [...byId.values()];
  }

  saveProjects(projects: Project[]): void {
    writeJsonAtomic(this.projectsPath, projects);
  }

  saveAgents(projectId: string, agents: SavedAgent[]): void {
    writeJsonAtomic(this.agentsPath(projectId), agents);
  }

  appendMessage(message: ChatMessage): void {
    appendLine(this.chatPath(message.agentId), message);
  }

  deleteMessage(agentId: string, messageId: string): void {
    appendLine(this.chatPath(agentId), { deletedId: messageId });
  }
}
