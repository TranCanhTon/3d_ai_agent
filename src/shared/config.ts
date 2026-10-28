// Every limit and setting for the app lives here (hard rule 3).
// Pure TypeScript: loaded by Next, the Node server and scripts/test.ts.

import { EFFORT_LEVELS, type EffortLevel } from "./domain/agentTypes.ts";
import type { AgentRole } from "./domain/roles.ts";
import type { WorkflowPhase } from "./domain/taskTypes.ts";

export interface GitPolicy {
  /** Engineer only. When false the engineer may `git commit` without asking. */
  commitRequiresApproval: boolean;
  /** Engineer only. Pushing always asks me while this is true. */
  pushRequiresApproval: boolean;
  /** git status, diff, log, show. */
  readOnlyRequiresApproval: boolean;
  /** `<subcommand> <arg>...` patterns denied for every role, e.g. "push --force". */
  blockedPatterns: string[];
}

/** Groups of allowed shell commands; the reviewer may only use some of them. */
export type ShellGroup = "lookAround" | "search" | "versions" | "gitRead" | "checks";

/**
 * Shell commands for roles with Bash. Allowed commands run without a card, denied ones
 * never run, and every command not on a list asks (installs, other npm/npx/node/python,
 * mkdir/cp/mv/touch, single file rm, git changes, push).
 */
export interface ShellPolicy {
  /** Executables that only look around: allowed with any arguments. */
  lookAround: string[];
  /** Search executables: allowed, except find with one of findAskArgs. */
  search: string[];
  /** find arguments that run commands, delete or write files. */
  findAskArgs: string[];
  /** Whole commands, matched exactly. */
  versions: string[];
  /** `git branch` with only these arguments (or none) just lists branches. */
  gitBranchListArgs: string[];
  /** Project checks; extra arguments are fine. */
  checks: string[];
  /** Denied for every role, wherever they run (sudo, shutdown, ...). mkfs also covers mkfs.<type>. */
  deniedExecutables: string[];
  /** Run another command; the command after them is checked too. */
  wrappers: string[];
  /** A download piped into one of pipeShells is denied. */
  downloaders: string[];
  pipeShells: string[];
  /** The only groups the reviewer may run; everything else is denied for him. */
  reviewerAllowedGroups: ShellGroup[];
}

/** A Claude model the agents can use, by Claude Code alias. */
export interface ModelChoice {
  id: string;
  label: string;
}

export interface ModelSetting {
  model: string;
  /** null = the model's default (no effort option is sent). */
  effort: EffortLevel | null;
}

export interface AppConfig {
  serverHost: string;
  serverPort: number;
  allowedOrigins: string[];
  /** Implementation attempts per task; rework past this aborts the task. */
  maxIterations: number;
  /** Relative to each project's rootPath. */
  notesPath: string;
  noteMaxChars: number;
  dataDir: string;
  /** The folder browser (and every project folder) stays inside this root. */
  folderBrowserRoot: string;
  /**
   * No project may be inside or equal to one of these, or contain one. APP_ROOT
   * stands for this app's own folder; the server resolves it from process.cwd().
   */
  blockedProjectRoots: string[];
  projectNameMaxChars: number;
  /** The 3D view holds each robot animation at least this long. */
  minStatusDisplayMs: number;
  /** Models offered per agent (Claude Code aliases). */
  models: ModelChoice[];
  /** Reasoning effort levels offered per agent. */
  effortLevels: readonly EffortLevel[];
  /** Model and effort of a new agent, by role. Each agent keeps its own afterwards. */
  roleModelDefaults: Record<AgentRole, ModelSetting>;
  git: GitPolicy;
  shell: ShellPolicy;
  /** Longest chat message or task description accepted from the client. */
  maxMessageChars: number;
  maxTaskTitleChars: number;
  chatHistoryDefaultLimit: number;
  /** A chat's title is my first message, cut to this. */
  chatTitleMaxChars: number;
  /** Above this many context tokens the UI suggests starting a new chat. */
  longChatTokens: number;
  chatHistoryMaxLimit: number;
  /** How long a communication arc stays visible. */
  commLinkDurationMs: number;
  /** Progress range [start, end] (0..1) of each workflow phase. */
  phaseProgress: Record<WorkflowPhase, readonly [number, number]>;

  // ── Server / connection (phase 2) ──
  /** File inside dataDir that holds the per-start session token. */
  sessionTokenFile: string;
  /** A connection must send hello within this time or is closed with closeCodeUnauthorized. */
  helloTimeoutMs: number;
  closeCodeUnauthorized: number;
  pingIntervalMs: number;
  maxPayloadBytes: number;
  /** Server publishes at most one snapshot per this interval. */
  snapshotCoalesceMs: number;
  /** After finishing an input the agent shows success (or error) this long before idling. */
  resultHoldMs: number;
  /** Fixed id of the Sandbox project created on first start. */
  sandboxProjectId: string;
  /** Temporary echo agent (replaced by the Claude runner in phase 3). */
  echo: { thinkMs: number; wordMs: number };

  // ── Browser client ──
  commandTimeoutMs: number;
  /** Reconnect delays; the last value repeats. */
  reconnectBackoffMs: number[];
  /** React updates from snapshots at most this often, unless an agent's status/busy/queue changed. */
  snapshotThrottleMs: number;
  maxStoredEvents: number;

  // ── Claude agents (phase 3) ──
  /** Which runner answers chat messages. The AGENT_RUNNER env var overrides it; tests force "echo". */
  agentRunner: AgentRunnerKind;
  /** Folder of the seeded Sandbox project. Created and git-initialised if missing. Never this app's repo. */
  sandboxRoot: string;
  /** CLAUDE_CONFIG_DIR for the agents' Claude Code (login, sessions, settings). null = Claude's default in the home folder. */
  claudeConfigDir: string | null;
  /** Temp folder for the agents' Claude Code process (relative to this app's folder). Keeps temp files off C:. */
  claudeTempDir: string;
  /** Raw SDK messages, one JSONL file per run. */
  recordingsDir: string;
  /** Explicit Claude Code executable; null = the one bundled with the SDK. */
  claudeExecutablePath: string | null;
  /** Role prompt files (relative to this app's folder), read at the start of every run. */
  rolePromptsDir: string;
  /** Team notes pasted into every role prompt; over this only the newest lines are kept. */
  notesPromptMaxChars: number;
}

export type AgentRunnerKind = "claude" | "echo";

/** Placeholder in blockedProjectRoots for this app's own folder (resolved by the server at runtime). */
export const APP_ROOT = "<app>";

export const CONFIG: AppConfig = {
  serverHost: "127.0.0.1",
  serverPort: 4317,
  allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  maxIterations: 3,
  notesPath: ".agentworld/notes.md",
  noteMaxChars: 200,
  dataDir: "./data",
  folderBrowserRoot: "D:\\",
  blockedProjectRoots: [APP_ROOT],
  projectNameMaxChars: 60,
  minStatusDisplayMs: 1000,
  models: [
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  effortLevels: EFFORT_LEVELS,
  roleModelDefaults: {
    orchestrator: { model: "sonnet", effort: "low" },
    product_manager: { model: "sonnet", effort: "medium" },
    researcher: { model: "sonnet", effort: "medium" },
    engineer: { model: "opus", effort: "high" },
    qa: { model: "sonnet", effort: "medium" },
    reviewer: { model: "opus", effort: "medium" },
  },
  git: {
    commitRequiresApproval: false,
    pushRequiresApproval: true,
    readOnlyRequiresApproval: false,
    blockedPatterns: [
      "push --force",
      "push -f",
      "push --force-with-lease",
      "push --delete",
      "push origin :",
      "reset --hard",
      "branch -D",
      "clean -f",
    ],
  },
  shell: {
    lookAround: ["ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "tree", "which", "where", "echo"],
    search: ["grep", "rg", "find"],
    findAskArgs: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprintf", "-fls"],
    versions: ["node -v", "node --version", "npm -v", "npm --version", "git --version", "python --version", "python3 --version"],
    gitBranchListArgs: ["-a", "-r", "--list", "-v", "-vv", "--all", "--remotes", "--show-current"],
    checks: ["npm test", "npm run test", "npm run typecheck", "npm run lint", "npm run build", "tsc --noEmit", "npx tsc --noEmit"],
    deniedExecutables: ["sudo", "su", "doas", "shutdown", "reboot", "format", "mkfs", "diskpart"],
    wrappers: ["xargs", "env", "nohup", "time", "command", "exec", "nice", "timeout"],
    downloaders: ["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod"],
    pipeShells: ["sh", "bash", "zsh", "pwsh", "powershell", "cmd", "iex", "invoke-expression"],
    reviewerAllowedGroups: ["lookAround", "search", "versions", "gitRead"],
  },
  maxMessageChars: 20_000,
  maxTaskTitleChars: 200,
  chatHistoryDefaultLimit: 50,
  chatTitleMaxChars: 60,
  longChatTokens: 80_000,
  chatHistoryMaxLimit: 200,
  commLinkDurationMs: 2400,
  phaseProgress: {
    queued: [0, 0],
    intake: [0, 0.08],
    planning: [0.08, 0.2],
    research: [0.2, 0.36],
    implementation: [0.36, 0.62],
    testing: [0.62, 0.78],
    review: [0.78, 0.94],
    done: [1, 1],
    failed: [0, 0],
  },

  sessionTokenFile: "session-token",
  helloTimeoutMs: 5000,
  closeCodeUnauthorized: 4401,
  pingIntervalMs: 15_000,
  maxPayloadBytes: 1024 * 1024,
  snapshotCoalesceMs: 100,
  resultHoldMs: 800,
  sandboxProjectId: "proj_sandbox",
  echo: { thinkMs: 600, wordMs: 60 },

  commandTimeoutMs: 10_000,
  reconnectBackoffMs: [500, 1000, 2000, 5000],
  snapshotThrottleMs: 160,
  maxStoredEvents: 200,

  agentRunner: "claude",
  sandboxRoot: "D:\\agent-sandbox",
  claudeConfigDir: "D:\\3d-ai-agent\\.claude-home",
  claudeTempDir: ".tmp",
  recordingsDir: "data/recordings",
  claudeExecutablePath: null,
  rolePromptsDir: "server/roles",
  notesPromptMaxChars: 8000,
};
