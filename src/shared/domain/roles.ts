import { CONFIG } from "../config.ts";
import type { StationId } from "./agentTypes.ts";

/** Pipeline order: Orchestrator hands to PM, PM to Researcher, and so on. */
export const AGENT_ROLES = ["orchestrator", "product_manager", "researcher", "engineer", "qa", "reviewer"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export const TOOL_NAMES = ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebSearch", "WebFetch", "add_note"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** Our in-process tool server; Claude sees its tools as `mcp__<server>__<tool>`. */
export const NOTES_TOOL_SERVER = "agentworld";
export const ADD_NOTE_SDK_NAME = `mcp__${NOTES_TOOL_SERVER}__add_note`;

/** Maps the name Claude uses for a tool to ours (`mcp__agentworld__add_note` → `add_note`). */
export function canonicalToolName(name: string): string {
  return name === ADD_NOTE_SDK_NAME ? "add_note" : name;
}

export interface RoleDefinition {
  role: AgentRole;
  /** Default display name for a new agent. Saved agents keep their own name. */
  name: string;
  roleLabel: string;
  tagline: string;
  color: string;
  homeStation: StationId;
  maxTurns: number;
  allowedTools: ToolName[];
  model: string;
  canEditCode: boolean;
  canCommit: boolean;
}

const READ_TOOLS: ToolName[] = ["Read", "Grep", "Glob"];

export const ROLE_DEFINITIONS: Record<AgentRole, RoleDefinition> = {
  orchestrator: {
    role: "orchestrator",
    name: "sONion Ring",
    roleLabel: "Orchestrator",
    tagline: "Coordinates work and delegates tasks",
    color: "#E8B04A",
    homeStation: "hub",
    maxTurns: 15,
    allowedTools: [...READ_TOOLS, "add_note"],
    model: CONFIG.defaultModel,
    canEditCode: false,
    canCommit: false,
  },
  product_manager: {
    role: "product_manager",
    name: "Pronelio Maximus",
    roleLabel: "Product Manager",
    tagline: "Converts requirements into actionable tasks",
    color: "#A78BFA",
    homeStation: "product",
    maxTurns: 15,
    allowedTools: [...READ_TOOLS, "add_note"],
    model: CONFIG.defaultModel,
    canEditCode: false,
    canCommit: false,
  },
  researcher: {
    role: "researcher",
    name: "Drater",
    roleLabel: "Researcher",
    tagline: "Researches technical topics and gathers information",
    color: "#5CC8D7",
    homeStation: "research",
    maxTurns: 15,
    allowedTools: [...READ_TOOLS, "WebSearch", "WebFetch", "add_note"],
    model: CONFIG.defaultModel,
    canEditCode: false,
    canCommit: false,
  },
  engineer: {
    role: "engineer",
    name: "STD Dren",
    roleLabel: "Software Engineer",
    tagline: "Implements software features",
    color: "#6C9EFF",
    homeStation: "dev",
    maxTurns: 30,
    allowedTools: [...READ_TOOLS, "Edit", "Write", "Bash", "add_note"],
    model: CONFIG.defaultModel,
    canEditCode: true,
    canCommit: true,
  },
  qa: {
    role: "qa",
    name: "Quantarino Archilles",
    roleLabel: "QA Engineer",
    tagline: "Tests completed work",
    color: "#5FD39A",
    homeStation: "testing",
    maxTurns: 15,
    allowedTools: [...READ_TOOLS, "Bash", "add_note"],
    model: CONFIG.defaultModel,
    canEditCode: false,
    canCommit: false,
  },
  reviewer: {
    role: "reviewer",
    name: "Rabies",
    roleLabel: "Code Reviewer",
    tagline: "Reviews implementation quality",
    color: "#F08A7E",
    homeStation: "review",
    maxTurns: 15,
    allowedTools: [...READ_TOOLS, "Bash", "add_note"],
    model: CONFIG.defaultModel,
    canEditCode: false,
    canCommit: false,
  },
};

/** Built-in Claude Code tools for a run: the role's list without our own tools. Chat only: none. */
export function builtInToolsFor(role: AgentRole, chatOnly: boolean): ToolName[] {
  return chatOnly ? [] : ROLE_DEFINITIONS[role].allowedTools.filter((tool) => tool !== "add_note");
}

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}
