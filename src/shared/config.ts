// Every limit and setting for the app lives here (hard rule 3).
// Pure TypeScript: loaded by Next, the Node server and scripts/test.ts.

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
  /** The folder browser never goes outside this root. */
  folderBrowserRoot: "home";
  /** The 3D view holds each robot animation at least this long. */
  minStatusDisplayMs: number;
  defaultModel: string;
  git: GitPolicy;
  /** Longest chat message or task description accepted from the client. */
  maxMessageChars: number;
  maxTaskTitleChars: number;
  chatHistoryDefaultLimit: number;
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
  /** Fixed id of the seeded in-memory project, so ids survive server restarts. */
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
}

export const CONFIG: AppConfig = {
  serverHost: "127.0.0.1",
  serverPort: 4317,
  allowedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
  maxIterations: 3,
  notesPath: ".agentworld/notes.md",
  noteMaxChars: 200,
  dataDir: "./data",
  folderBrowserRoot: "home",
  minStatusDisplayMs: 1000,
  defaultModel: "sonnet",
  git: {
    commitRequiresApproval: false,
    pushRequiresApproval: true,
    readOnlyRequiresApproval: true,
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
  maxMessageChars: 20_000,
  maxTaskTitleChars: 200,
  chatHistoryDefaultLimit: 50,
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
};
