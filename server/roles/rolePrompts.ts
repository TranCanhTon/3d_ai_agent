// Role prompts appended to Claude Code's own system prompt. The files (and the
// team notes) are read at the start of every run, so edits apply without a server restart.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "../../src/shared/config.ts";
import type { AgentRole } from "../../src/shared/domain/roles.ts";
import { NOTES_HEADER, readNotes } from "../projects/notes.ts";

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

export const NO_NOTES_LINE = "Team notes: none yet.";
export const OLDER_NOTES_LINE = `(Older notes are in ${CONFIG.notesPath}.)`;

function readPrompt(dir: string, file: string): string {
  return readFileSync(join(dir, file), "utf8").trimEnd();
}

/**
 * The notes file without its header, cut to `maxChars`: the newest lines that fit,
 * after a line saying where the older ones are.
 */
export function notesSection(content: string, maxChars: number = CONFIG.notesPromptMaxChars): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() === NOTES_HEADER) lines.shift();
  const body = lines.join("\n").trim();
  if (body === "") return NO_NOTES_LINE;

  let kept = body;
  if (body.length > maxChars) {
    const newest: string[] = [];
    let size = OLDER_NOTES_LINE.length;
    for (const line of body.split("\n").reverse()) {
      if (size + line.length + 1 > maxChars) break;
      newest.unshift(line);
      size += line.length + 1;
    }
    kept = [OLDER_NOTES_LINE, ...newest].join("\n");
  }
  return `Team notes (${CONFIG.notesPath}):\n${kept}`;
}

/** role file + shared rules + team notes + the project folder (+ the chat only line). */
export function buildRolePrompt(dir: string, role: AgentRole, rootPath: string, chatOnly: boolean): string {
  const parts = [
    readPrompt(dir, ROLE_PROMPT_FILES[role]),
    readPrompt(dir, SHARED_PROMPT_FILE),
    notesSection(readNotes(rootPath)),
    `Project folder: ${rootPath}`,
  ];
  if (chatOnly) parts.push(CHAT_ONLY_LINE);
  return parts.join("\n\n");
}
