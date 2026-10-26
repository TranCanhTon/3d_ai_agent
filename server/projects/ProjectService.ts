// Projects: the folder browser, creating (with notes file, .gitignore entry and
// optional git init), archiving and restoring, and the team notes.

import { execFileSync } from "node:child_process";
import { CONFIG } from "../../src/shared/config.ts";
import type { Project } from "../../src/shared/domain/projectTypes.ts";
import type { NotesUpdatedPayload } from "../../src/shared/events/eventPayloads.ts";
import { newId } from "../../src/shared/ids.ts";
import type { CommandArgsMap, FolderListing } from "../../src/shared/protocol/protocol.ts";
import type { AgentManager } from "../agents/AgentManager.ts";
import type { World } from "../world/World.ts";
import { checkProjectFolder, isGitRepo, listFolders, type FolderRules } from "./folders.ts";
import { appendNoteLine, cleanNoteText, ensureGitignoreEntry, ensureNotesFile, formatNote, readNotes } from "./notes.ts";

export interface ProjectServiceDeps {
  world: World;
  agents: AgentManager;
  /** Real path of the folder browser root. */
  browserRoot: string;
  /** Real paths no project may be in, equal to, or contain (this app's folder). */
  blockedRoots: string[];
}

export class ProjectService {
  private readonly deps: ProjectServiceDeps;

  constructor(deps: ProjectServiceDeps) {
    this.deps = deps;
  }

  rules(): FolderRules {
    return {
      root: this.deps.browserRoot,
      blockedRoots: this.deps.blockedRoots,
      projects: [...this.deps.world.projects.values()],
    };
  }

  listFolders(path?: string): FolderListing {
    return listFolders(path, this.rules());
  }

  /** Validates the folder, sets it up and creates the project with its 6 agents. Throws with the reason. */
  createProject(args: CommandArgsMap["createProject"], id: string = newId("proj")): Project {
    const { world } = this.deps;
    const name = args.name.trim();
    if (name.length === 0 || name.length > CONFIG.projectNameMaxChars) {
      throw new Error(`Project name must be 1 to ${CONFIG.projectNameMaxChars} characters`);
    }
    const check = checkProjectFolder(args.rootPath, this.rules());
    if (!check.ok) throw new Error(check.reason);
    const rootPath = check.path;

    if (!isGitRepo(rootPath) && args.initGit === true) {
      try {
        execFileSync("git", ["init", "-q"], { cwd: rootPath, stdio: "ignore", windowsHide: true });
      } catch (error) {
        throw new Error(`git init failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    ensureNotesFile(rootPath);
    ensureGitignoreEntry(rootPath);

    const project: Project = {
      id,
      name,
      rootPath,
      isGitRepo: isGitRepo(rootPath),
      archived: false,
      createdAt: world.now(),
    };
    world.addProject(project);
    world.emit({ type: "project.created", projectId: project.id, message: `Project "${name}" created`, severity: "success" });
    return project;
  }

  /** Stops the project's running agents; queued messages wait until it is restored. */
  archiveProject(projectId: string): void {
    const project = this.deps.world.getProject(projectId);
    if (project.archived) throw new Error("Project is already archived");
    this.deps.world.updateProject(projectId, { archived: true });
    this.deps.agents.stopProject(projectId);
    this.deps.world.emit({ type: "project.archived", projectId, message: `Project "${project.name}" archived` });
  }

  restoreProject(projectId: string): void {
    const project = this.deps.world.getProject(projectId);
    if (!project.archived) throw new Error("Project is not archived");
    this.deps.world.updateProject(projectId, { archived: false });
    this.deps.world.emit({ type: "project.restored", projectId, message: `Project "${project.name}" restored` });
    this.deps.agents.resumeProject(projectId);
  }

  getNotes(projectId: string): string {
    return readNotes(this.deps.world.getProjectRoot(projectId));
  }

  /** The add_note tool. Returns the line written. */
  addAgentNote(agentId: string, text: string): string {
    const agent = this.deps.world.getAgent(agentId);
    return this.appendNote(agent.projectId, formatNote(cleanNoteText(text), agent.name, this.deps.world.now()));
  }

  /** Pins my (possibly edited) text of a chat message to the notes and marks the message pinned. */
  pinToNotes(messageId: string, text: string): void {
    const { world } = this.deps;
    const message = world.findMessageById(messageId);
    if (message === undefined) throw new Error(`Unknown message: ${messageId}`);
    if (world.getProject(message.projectId).archived) throw new Error("Project is archived");
    this.appendNote(message.projectId, formatNote(cleanNoteText(text), "pinned by you", world.now()));
    const pinned = world.updateMessage(message.agentId, message.id, { pinned: true });
    world.emit({
      type: "chat.message_completed",
      projectId: pinned.projectId,
      agentId: pinned.agentId,
      message: "Message pinned",
      feed: false,
      metadata: { message: pinned },
    });
  }

  private appendNote(projectId: string, line: string): string {
    const { world } = this.deps;
    appendNoteLine(world.getProjectRoot(projectId), line);
    world.emit({
      type: "notes.updated",
      projectId,
      message: line,
      metadata: { line } satisfies NotesUpdatedPayload,
    });
    return line;
  }
}
