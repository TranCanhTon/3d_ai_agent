// The agents' only tool server: in-process, named "agentworld", with one tool,
// add_note. Claude sees it as mcp__agentworld__add_note (see canonicalToolName).

import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { NOTES_TOOL_SERVER } from "../../../src/shared/domain/roles.ts";

const DESCRIPTION =
  "Add one line to the team's shared notes file (.agentworld/notes.md). Use it only to record a decision the user made that affects the project, not routine progress.";

/** The add_note tool. `addNote` writes the note and returns the line, or throws with the reason. */
export function addNoteTool(addNote: (text: string) => string) {
  return tool("add_note", DESCRIPTION, { text: z.string().describe("The decision, in one short line") }, async ({ text }) => {
    try {
      return { content: [{ type: "text" as const, text: `Noted: ${addNote(text)}` }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
}

export function createNotesServer(addNote: (text: string) => string): McpSdkServerConfigWithInstance {
  // alwaysLoad: never defer the tool behind tool search; it is the only one.
  return createSdkMcpServer({ name: NOTES_TOOL_SERVER, version: "1.0.0", tools: [addNoteTool(addNote)], alwaysLoad: true });
}
