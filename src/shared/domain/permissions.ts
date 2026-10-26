// Permission rules for agent tool calls. Pure: no I/O, never throws.
//
// Rules, in order:
// 1. Tool not in the role's allowedTools: deny.
// 2. Read, Grep, Glob, WebSearch, WebFetch, add_note: allow.
// 3. Edit, Write: ask.
// 4. Bash running git: blocked pattern deny; commit/push by capability;
//    read-only git per config; any other git ask.
// 5. Any other Bash: ask.
//
// Bash commands are split into parts (&&, ||, ;, |, &, newlines, subshells,
// command substitutions) and every part is checked; the strictest verdict wins.
// Anything the scanner is unsure about is at least "ask".

import type { AppConfig, GitPolicy } from "../config.ts";
import { ROLE_DEFINITIONS, TOOL_NAMES, type AgentRole, type ToolName } from "./roles.ts";

export interface PermissionRequest {
  id: string;
  projectId: string;
  agentId: string;
  toolName: string;
  /** One line I can read before deciding, e.g. "git push origin main". */
  summary: string;
  input: unknown;
  createdAt: number;
}

export type PermissionDecision = "allow" | "deny";
export type PermissionVerdict = "allow" | "ask" | "deny";

const RANK: Record<PermissionVerdict, number> = { allow: 0, ask: 1, deny: 2 };

function strictest(...verdicts: PermissionVerdict[]): PermissionVerdict {
  let result: PermissionVerdict = "allow";
  for (const v of verdicts) if (RANK[v] > RANK[result]) result = v;
  return result;
}

const ALWAYS_ALLOWED: ReadonlySet<ToolName> = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "add_note"]);
const MAX_NESTING = 4;

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export function evaluatePermission(
  role: AgentRole,
  toolName: string,
  input: unknown,
  config: Pick<AppConfig, "git">,
): PermissionVerdict {
  const definition = ROLE_DEFINITIONS[role];
  if (!isToolName(toolName) || !definition.allowedTools.includes(toolName)) return "deny";
  if (ALWAYS_ALLOWED.has(toolName)) return "allow";
  if (toolName === "Edit" || toolName === "Write") return "ask";

  // Bash
  const command = readBashCommand(input);
  if (command === null) return "deny";
  return evaluateBash(role, command, config.git, 0);
}

function readBashCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null || !("command" in input)) return null;
  const command = (input as { command: unknown }).command;
  return typeof command === "string" ? command : null;
}

function evaluateBash(role: AgentRole, command: string, policy: GitPolicy, depth: number): PermissionVerdict {
  if (depth > MAX_NESTING) return "ask";
  const scan = scanShell(command);
  const verdicts: PermissionVerdict[] = [];

  if (scan.segments.length === 0 || scan.unterminated || scan.hasRedirect || scan.substitutions.length > 0) {
    verdicts.push("ask");
  }
  for (const sub of scan.substitutions) verdicts.push(evaluateBash(role, sub, policy, depth + 1));
  for (const tokens of scan.segments) verdicts.push(evaluateSegment(role, tokens, policy, depth));

  return strictest(...verdicts);
}

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"]);

function executableName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.exe$/, "");
}

function evaluateSegment(role: AgentRole, tokens: string[], policy: GitPolicy, depth: number): PermissionVerdict {
  const verdicts: PermissionVerdict[] = [];

  // `bash -c "..."` and `eval ...` run their argument as a command.
  const first = tokens[0];
  if (first !== undefined) {
    const exe = executableName(first);
    if (exe === "eval") verdicts.push(evaluateBash(role, tokens.slice(1).join(" "), policy, depth + 1));
    if (SHELLS.has(exe)) {
      const c = tokens.findIndex((t) => t === "-c" || t === "/c" || t.toLowerCase() === "-command");
      const script = c >= 0 ? tokens[c + 1] : undefined;
      if (script !== undefined) verdicts.push(evaluateBash(role, script, policy, depth + 1));
    }
  }

  // git anywhere in the part counts (`sudo git ...`, `xargs git ...`, `A=1 git ...`).
  const gitIndex = tokens.findIndex((t) => executableName(t) === "git");
  if (gitIndex === -1) return strictest("ask", ...verdicts);

  const before = tokens.slice(0, gitIndex).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (before.length > 0) verdicts.push("ask");
  verdicts.push(evaluateGit(role, tokens.slice(gitIndex + 1), policy));
  return strictest(...verdicts);
}

/** git global options that take a separate value argument. */
const GLOBALS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--super-prefix",
]);
/** Global options that can run arbitrary programs or point git elsewhere. */
const RISKY_GLOBALS: ReadonlySet<string> = new Set(["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree"]);
const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show"]);
/** Read-only subcommand options that write files or run external programs. */
const READ_ONLY_WRITERS = ["--output", "--ext-diff", "--textconv"];

function evaluateGit(role: AgentRole, args: string[], policy: GitPolicy): PermissionVerdict {
  let i = 0;
  let riskyGlobal = false;
  while (i < args.length) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) break;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (RISKY_GLOBALS.has(name)) riskyGlobal = true;
    i += GLOBALS_WITH_VALUE.has(arg) ? 2 : 1;
  }

  const sub = args[i];
  if (sub === undefined) return "ask";
  const rest = args.slice(i + 1);

  if (matchesBlockedPattern(sub, rest, policy.blockedPatterns)) return "deny";

  const floor: PermissionVerdict = riskyGlobal ? "ask" : "allow";
  const canCommit = ROLE_DEFINITIONS[role].canCommit;

  if (sub === "commit") {
    if (!canCommit) return "deny";
    return strictest(floor, policy.commitRequiresApproval ? "ask" : "allow");
  }
  if (sub === "push") {
    if (!canCommit) return "deny";
    return strictest(floor, policy.pushRequiresApproval ? "ask" : "allow");
  }
  if (READ_ONLY_SUBCOMMANDS.has(sub)) {
    const writes = rest.some((a) => READ_ONLY_WRITERS.some((w) => a === w || a.startsWith(`${w}=`)));
    return strictest(floor, policy.readOnlyRequiresApproval || writes ? "ask" : "allow");
  }
  return "ask";
}

function matchesBlockedPattern(sub: string, rest: string[], patterns: string[]): boolean {
  const parsed = patterns.map((p) => p.trim().split(/\s+/)).filter((p) => p[0] === sub);
  if (parsed.length === 0) return false;

  const longOptions = parsed.flat().filter((t) => t.startsWith("--"));
  const args = normalizeArgs(sub, rest, longOptions);
  return parsed.some((tokens) =>
    tokens.slice(1).every((t) => args.has(t) || (t.endsWith(":") && rest.some((a) => a.startsWith(t)))),
  );
}

/**
 * Expands args into every spelling a pattern may use: `--opt=value` → `--opt`,
 * `-fd` → `-f -d`, unambiguous long option prefixes (`--forc` → `--force`),
 * and git equivalences (`push +ref` is a force push, `push :ref` a delete).
 */
function normalizeArgs(sub: string, rest: string[], longOptions: string[]): Set<string> {
  const set = new Set<string>();
  for (const arg of rest) {
    set.add(arg);
    if (arg.startsWith("--")) {
      const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      set.add(name);
      if (name.length >= 4) for (const opt of longOptions) if (opt.startsWith(name)) set.add(opt);
    } else if (/^-[A-Za-z]{2,}$/.test(arg)) {
      for (const ch of arg.slice(1)) set.add(`-${ch}`);
    }
  }

  const alias = (a: string, b: string) => {
    if (set.has(a)) set.add(b);
    if (set.has(b)) set.add(a);
  };
  if (sub === "push") {
    for (const arg of rest) {
      if (arg.startsWith("+")) set.add("--force");
      if (arg.startsWith(":") && arg.length > 1) set.add("--delete");
    }
    if (set.has("--mirror")) {
      set.add("--force");
      set.add("--delete");
    }
    if (set.has("--prune")) set.add("--delete");
    alias("-f", "--force");
    alias("-d", "--delete");
  }
  if (sub === "clean") alias("-f", "--force");
  if (sub === "branch") {
    alias("-d", "--delete");
    alias("-f", "--force");
    if (set.has("--delete") && set.has("--force")) set.add("-D");
  }
  return set;
}

interface ShellScan {
  /** Each part's words with quotes removed. */
  segments: string[][];
  /** Bodies of $(...), `...`, <(...) and >(...), checked as commands of their own. */
  substitutions: string[];
  hasRedirect: boolean;
  unterminated: boolean;
}

const SEPARATORS = new Set([";", "&", "|", "\n", "\r", "(", ")"]);

/**
 * A deliberately conservative shell scanner. It splits on more than a real shell
 * would (comments and braces are not special) because extra parts only make the
 * verdict stricter.
 */
function scanShell(command: string): ShellScan {
  const segments: string[][] = [];
  const substitutions: string[] = [];
  let hasRedirect = false;
  let unterminated = false;

  let tokens: string[] = [];
  let token: string | null = null;

  const endToken = () => {
    if (token !== null) tokens.push(token);
    token = null;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  const append = (text: string) => {
    token = (token ?? "") + text;
  };
  /** Reads a substitution body starting after its opener; returns the index after its closer. */
  const readSubstitution = (start: number, closer: ")" | "`"): number => {
    let depth = 1;
    let quote: string | null = null;
    for (let j = start; j < command.length; j++) {
      const ch = command[j];
      if (quote !== null) {
        if (ch === quote) quote = null;
        continue;
      }
      if (closer === "`") {
        if (ch === "`") {
          substitutions.push(command.slice(start, j));
          return j + 1;
        }
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) {
        substitutions.push(command.slice(start, j));
        return j + 1;
      }
    }
    unterminated = true;
    substitutions.push(command.slice(start));
    return command.length;
  };

  let quote: "'" | '"' | null = null;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] ?? "";
    const next = command[i + 1] ?? "";

    if (quote === "'") {
      if (ch === "'") quote = null;
      else append(ch);
      i++;
      continue;
    }

    if (ch === "\\") {
      append(next);
      i += 2;
      continue;
    }
    if (ch === "$" && next === "(") {
      append("$SUB");
      i = readSubstitution(i + 2, ")");
      continue;
    }
    if (ch === "`") {
      append("$SUB");
      i = readSubstitution(i + 1, "`");
      continue;
    }

    if (quote === '"') {
      if (ch === '"') quote = null;
      else append(ch);
      i++;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      append("");
      i++;
    } else if ((ch === "<" || ch === ">") && next === "(") {
      endToken();
      i = readSubstitution(i + 2, ")");
    } else if (ch === "<" || ch === ">") {
      hasRedirect = true;
      endToken();
      i++;
      while (command[i] === ">" || command[i] === "&") i++;
    } else if (SEPARATORS.has(ch)) {
      endSegment();
      i++;
    } else if (/\s/.test(ch)) {
      endToken();
      i++;
    } else {
      append(ch);
      i++;
    }
  }
  if (quote !== null) unterminated = true;
  endSegment();

  return { segments, substitutions, hasRedirect, unterminated };
}
