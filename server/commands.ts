import type { ClientCommand } from "../src/shared/protocol/protocol.ts";
import type { AgentManager } from "./agents/AgentManager.ts";
import type { PermissionBroker } from "./agents/PermissionBroker.ts";
import type { Pipeline } from "./pipeline/Pipeline.ts";
import type { ProjectService } from "./projects/ProjectService.ts";
import type { World } from "./world/World.ts";

export interface CommandContext {
  world: World;
  agents: AgentManager;
  permissions: PermissionBroker;
  projects: ProjectService;
  pipeline: Pipeline;
}

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
      return ctx.agents.sendMessage(command.args.agentId, command.args.text, command.args.chatId);
    case "stopAgent":
      ctx.world.getAgent(command.args.agentId);
      ctx.agents.stopAgent(command.args.agentId);
      return null;
    case "cancelQueued":
      ctx.agents.cancelQueued(command.args.agentId, command.args.messageId);
      return null;
    case "newChat":
      return ctx.agents.newChat(command.args.agentId);
    case "openChat":
      ctx.agents.openChat(command.args.agentId, command.args.chatId);
      return null;
    case "listChats":
      return ctx.agents.listChats(command.args.agentId);
    case "setChatOnly":
      ctx.agents.setChatOnly(command.args.agentId, command.args.chatOnly);
      return null;
    case "setAgentModel":
      ctx.agents.setAgentModel(command.args.agentId, command.args.model, command.args.effort);
      return null;
    case "getChatHistory":
      return ctx.agents.getChatHistory(command.args.agentId, command.args.before, command.args.limit, command.args.view, command.args.chatId);
    case "submitTask":
      return ctx.pipeline.submit(command.args);
    case "cancelTask":
      ctx.pipeline.cancel(command.args.taskId);
      return null;
    case "resumeTask":
      ctx.pipeline.resume(command.args.taskId);
      return null;
    case "answerTask":
      ctx.pipeline.answer(command.args.taskId, command.args.text);
      return null;
    case "approveTask":
      ctx.pipeline.approve(command.args.taskId);
      return null;
    case "reviseBrief":
      ctx.pipeline.reviseBrief(command.args.taskId, command.args.text);
      return null;
    case "changeTask":
      ctx.pipeline.requestChange(command.args.taskId, command.args.text);
      return null;
    case "applyChange":
      ctx.pipeline.applyChange(command.args.taskId);
      return null;
    case "discardChange":
      ctx.pipeline.discardChange(command.args.taskId);
      return null;
    case "respondPermission":
      ctx.permissions.respond(command.args.requestId, command.args.decision);
      return null;
    case "pinToNotes":
      ctx.projects.pinToNotes(command.args.messageId, command.args.text);
      return null;
    case "getNotes":
      return ctx.projects.getNotes(command.args.projectId);
    case "addNote":
      ctx.projects.addMyNote(command.args.projectId, command.args.text);
      return null;
    default: {
      const unknown: never = command;
      throw new Error(`Unknown command: ${(unknown as { name: string }).name}`);
    }
  }
}
