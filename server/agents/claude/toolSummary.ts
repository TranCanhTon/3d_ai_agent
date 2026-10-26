// Human readable descriptions of a tool call, shared by the translator (status
// and chat tool lines) and the PermissionBroker (permission card summaries).
// Pure: no I/O.

import { isAbsolute, relative } from "node:path";
import type { AgentStatus } from "../../../src/shared/domain/agentTypes.ts";

export interface ToolDescription {
  status: AgentStatus;
  /** Present tense, for the agent's activity and permission cards: "Reading src/app.ts". */
  activity: string;
  /** Past tense, for the chat tool line: "Read src/app.ts". */
  line: string;
}

const MAX_COMMAND_CHARS = 60;
const TEST_COMMAND =
  /(^|&&|\|\||;|\|)\s*(npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|(npx\s+)?vitest|(npx\s+)?jest|(python3?\s+-m\s+)?pytest|go\s+test|cargo\s+test)\b/;
const READ_ONLY_GIT = /^\s*git\s+(-C\s+("[^"]*"|\S+)\s+)?(status|diff|log|show)\b/;

function str(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1).trimEnd()}…` : oneLine;
}

/** Path relative to the project root when it is inside it, else as given. */
export function displayPath(path: string, rootPath: string): string {
  if (path === "") return "a file";
  if (!isAbsolute(path)) return path.replace(/\\/g, "/");
  const rel = relative(rootPath, path);
  if (rel === "" ) return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return path;
  return rel.replace(/\\/g, "/");
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return truncate(url, MAX_COMMAND_CHARS);
  }
}

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command.trim());
}

export function describeTool(toolName: string, input: unknown, rootPath: string): ToolDescription {
  switch (toolName) {
    case "Read": {
      const path = displayPath(str(input, "file_path"), rootPath);
      return { status: "thinking", activity: `Reading ${path}`, line: `Read ${path}` };
    }
    case "Grep":
    case "Glob": {
      const pattern = truncate(str(input, "pattern"), MAX_COMMAND_CHARS);
      return { status: "thinking", activity: `Searching ${pattern}`, line: `Searched ${pattern}` };
    }
    case "WebSearch": {
      const query = truncate(str(input, "query"), MAX_COMMAND_CHARS);
      return { status: "thinking", activity: `Searching: ${query}`, line: `Searched: ${query}` };
    }
    case "WebFetch": {
      const host = hostname(str(input, "url"));
      return { status: "thinking", activity: `Reading ${host}`, line: `Read ${host}` };
    }
    case "Edit": {
      const path = displayPath(str(input, "file_path"), rootPath);
      return { status: "working", activity: `Editing ${path}`, line: `Edited ${path}` };
    }
    case "Write": {
      const path = displayPath(str(input, "file_path"), rootPath);
      return { status: "working", activity: `Writing ${path}`, line: `Wrote ${path}` };
    }
    case "Bash": {
      const command = str(input, "command");
      const short = truncate(command, MAX_COMMAND_CHARS);
      if (isTestCommand(command)) return { status: "working", activity: "Running tests", line: `Ran: ${short}` };
      if (READ_ONLY_GIT.test(command)) return { status: "thinking", activity: "Checking git", line: `Ran: ${short}` };
      return { status: "working", activity: `Running: ${short}`, line: `Ran: ${short}` };
    }
    default:
      return { status: "working", activity: `Using ${toolName}`, line: `Used ${toolName}` };
  }
}
