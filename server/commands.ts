import type { ClientCommand, CommandName } from "../src/shared/protocol/protocol.ts";
import type { AgentManager } from "./agents/AgentManager.ts";
import type { PermissionBroker } from "./agents/PermissionBroker.ts";
import type { ProjectService } from "./projects/ProjectService.ts";
import type { World } from "./world/World.ts";

export interface CommandContext {
  world: World;
  agents: AgentManager;
  permissions: PermissionBroker;
  projects: ProjectService;
}

/** Commands that exist in the protocol but are built in a later phase. */
const NOT_YET: Partial<Record<CommandName, number>> = {
  submitTask: 5,
  cancelTask: 5,
  resumeTask: 5,
};

/** Returns the ack result (null when the command has none). Throws to produce `ack ok:false`. */
export function handleCommand(command: ClientCommand, ctx: CommandContext): unknown {
  switch (command.name) {
    case "getSnapshot":
      return ctx.world.snapshot();
    case "listFolders":
      return ctx.projects.listFolders(command.args.path);
    case "createProject":
      return ctx.projects.createProject(command.args);
    case "archiveProject":
      ctx.projects.archiveProject(command.args.projectId);
      return null;
    case "restoreProject":
      ctx.projects.restoreProject(command.args.projectId);
      return null;
    case "sendMessage":
      return ctx.agents.sendMessage(command.args.agentId, command.args.text);
    case "stopAgent":
      ctx.world.getAgent(command.args.agentId);
      ctx.agents.stopAgent(command.args.agentId);
      return null;
    case "cancelQueued":
      ctx.agents.cancelQueued(command.args.agentId, command.args.messageId);
      return null;
    case "resetAgentSession":
      ctx.agents.resetSession(command.args.agentId);
      return null;
    case "setChatOnly":
      ctx.agents.setChatOnly(command.args.agentId, command.args.chatOnly);
      return null;
    case "getChatHistory":
      return ctx.agents.getChatHistory(command.args.agentId, command.args.before, command.args.limit);
    case "respondPermission":
      ctx.permissions.respond(command.args.requestId, command.args.decision);
      return null;
    case "pinToNotes":
      ctx.projects.pinToNotes(command.args.messageId, command.args.text);
      return null;
    case "getNotes":
      return ctx.projects.getNotes(command.args.projectId);
    default: {
      const phase = NOT_YET[command.name];
      throw new Error(phase === undefined ? `Unknown command: ${command.name}` : `Not implemented until phase ${phase}`);
    }
  }
}
