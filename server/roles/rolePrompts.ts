// Role prompts appended to Claude Code's own system prompt. The files are read
// at the start of every run, so edits apply without a server restart.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRole } from "../../src/shared/domain/roles.ts";

export const ROLE_PROMPT_FILES: Record<AgentRole, string> = {
  orchestrator: "orchestrator.md",
  product_manager: "product_manager.md",
  researcher: "researcher.md",
  engineer: "engineer.md",
  qa: "qa.md",
  reviewer: "reviewer.md",
};

export const SHARED_PROMPT_FILE = "shared.md";

export const CHAT_ONLY_LINE =
  "You are in chat only mode: you have no tools. Answer from what you know and what is in this conversation.";

function readPrompt(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8").trimEnd();
}

/** role file + shared rules + the project folder (+ the chat only line). */
export function buildRolePrompt(dir: string, role: AgentRole, rootPath: string, chatOnly: boolean): string {
  const parts = [readPrompt(dir, ROLE_PROMPT_FILES[role]), readPrompt(dir, SHARED_PROMPT_FILE), `Project folder: ${rootPath}`];
  if (chatOnly) parts.push(CHAT_ONLY_LINE);
  return parts.join("\n\n");
}
