import type { ClientCommand, CommandName } from "../src/shared/protocol/protocol.ts";
import type { AgentManager } from "./agents/AgentManager.ts";
import type { PermissionBroker } from "./agents/PermissionBroker.ts";
import type { World } from "./world/World.ts";

export interface CommandContext {
  world: World;
  agents: AgentManager;
  permissions: PermissionBroker;
}

/** Commands that exist in the protocol but are built in a later phase. */
const NOT_YET: Partial<Record<CommandName, number>> = {
  listFolders: 4,
  createProject: 4,
  archiveProject: 4,
  resetAgentSession: 4,
  pinToNotes: 4,
  submitTask: 5,
  cancelTask: 5,
  resumeTask: 5,
};

/** Returns the ack result (null when the command has none). Throws to produce `ack ok:false`. */
export function handleCommand(command: ClientCommand, ctx: CommandContext): unknown {
  switch (command.name) {
    case "getSnapshot":
      return ctx.world.snapshot();
    case "sendMessage":
      return ctx.agents.sendMessage(command.args.agentId, command.args.text);
    case "stopAgent":
      ctx.world.getAgent(command.args.agentId);
      ctx.agents.stopAgent(command.args.agentId);
      return null;
    case "cancelQueued":
      ctx.agents.cancelQueued(command.args.agentId, command.args.messageId);
      return null;
    case "getChatHistory":
      return ctx.agents.getChatHistory(command.args.agentId, command.args.before, command.args.limit);
    case "respondPermission":
      ctx.permissions.respond(command.args.requestId, command.args.decision);
      return null;
    default: {
      const phase = NOT_YET[command.name];
      throw new Error(phase === undefined ? `Unknown command: ${command.name}` : `Not implemented until phase ${phase}`);
    }
  }
}
