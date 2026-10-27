// Permission rules for agent tool calls. Pure: no I/O, never throws.
//
// Rules, in order:
// 1. Tool not in the role's allowedTools (or the run's override, e.g. none in chat only mode): deny.
//    Claude's name for our note tool (mcp__agentworld__add_note) counts as add_note.
// 2. Read, Grep, Glob, WebSearch, WebFetch, add_note: allow.
// 3. Edit, Write: ask.
// 4. Bash, per config.shell: denied commands (blocked git patterns, recursive deletes,
//    sudo/shutdown/format..., a download piped into a shell) deny for every role;
//    look around, search, versions, read-only git and project checks allow;
//    commit/push by capability; everything else asks.
// 5. The reviewer only gets look around, search, versions and read-only git:
//    anything else he tries is denied, not asked.
//
// Bash commands are split into parts (&&, ||, ;, |, &, newlines, subshells,
// command substitutions) and every part is checked; the strictest verdict wins.
// Anything the scanner is unsure about (redirects, substitutions, unclear quoting) is at least "ask".

import type { AppConfig, ShellGroup, ShellPolicy } from "../config.ts";
import { canonicalToolName, ROLE_DEFINITIONS, TOOL_NAMES, type AgentRole, type ToolName } from "./roles.ts";

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

/** A verdict plus a short reason a person can read. */
export interface PermissionOutcome {
  verdict: PermissionVerdict;
  reason: string;
}

const RANK: Record<PermissionVerdict, number> = { allow: 0, ask: 1, deny: 2 };

const outcome = (verdict: PermissionVerdict, reason: string): PermissionOutcome => ({ verdict, reason });

/** The strictest outcome wins; among equals, the first one keeps its reason. */
function strictest(...outcomes: PermissionOutcome[]): PermissionOutcome {
  let result = outcome("allow", "allowed");
  for (const o of outcomes) if (RANK[o.verdict] > RANK[result.verdict]) result = o;
  return result;
}

const ALWAYS_ALLOWED: ReadonlySet<ToolName> = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "add_note"]);
const MAX_NESTING = 4;

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/** The parts of the config the rules read. */
export type PermissionConfig = Pick<AppConfig, "git" | "shell">;

export function evaluatePermission(
  role: AgentRole,
  toolName: string,
  input: unknown,
  config: PermissionConfig,
  allowedTools?: readonly ToolName[],
): PermissionVerdict {
  return explainPermission(role, toolName, input, config, allowedTools).verdict;
}

/** Same rules as evaluatePermission, plus the reason for the verdict. `allowedTools` replaces the role's list. */
export function explainPermission(
  role: AgentRole,
  rawToolName: string,
  input: unknown,
  config: PermissionConfig,
  allowedTools?: readonly ToolName[],
): PermissionOutcome {
  const definition = ROLE_DEFINITIONS[role];
  const toolName = canonicalToolName(rawToolName);
  const tools = allowedTools ?? definition.allowedTools;
  if (!isToolName(toolName) || !tools.includes(toolName)) {
    return outcome("deny", `${toolName} is not available to the ${definition.roleLabel}${allowedTools?.length === 0 ? " in chat only mode" : ""}`);
  }
  if (ALWAYS_ALLOWED.has(toolName)) return outcome("allow", `${toolName} is always allowed`);
  if (toolName === "Edit" || toolName === "Write") return outcome("ask", `${toolName} changes files`);

  // Bash
  const command = readBashCommand(input);
  if (command === null) return outcome("deny", "Bash call without a command");
  const result = evaluateBash(role, command, config, 0);
  // The reviewer never gets a card: what is not on his list is denied.
  if (role === "reviewer" && result.verdict === "ask") return outcome("deny", reviewerReason());
  return result;
}

function reviewerReason(): string {
  return `${ROLE_DEFINITIONS.reviewer.name} only reviews: git read and look-around commands`;
}

function readBashCommand(input: unknown): string | null {
  if (typeof input !== "object" || input === null || !("command" in input)) return null;
  const command = (input as { command: unknown }).command;
  return typeof command === "string" ? command : null;
}

/** An outcome plus the allow-list group that allowed it (the reviewer only gets some groups). */
interface Classified extends PermissionOutcome {
  group?: ShellGroup;
}

const allowIn = (group: ShellGroup, reason: string): Classified => ({ verdict: "allow", reason, group });

function evaluateBash(role: AgentRole, command: string, config: PermissionConfig, depth: number): PermissionOutcome {
  if (depth > MAX_NESTING) return outcome("ask", "deeply nested shell command");
  const scan = scanShell(command);
  const outcomes: PermissionOutcome[] = [];

  if (scan.segments.length === 0 || scan.unterminated || scan.hasRedirect || scan.substitutions.length > 0) {
    outcomes.push(outcome("ask", "shell command with redirects, substitutions or unclear quoting"));
  }
  for (const sub of scan.substitutions) outcomes.push(evaluateBash(role, sub, config, depth + 1));
  for (const tokens of scan.segments) outcomes.push(evaluateSegment(role, tokens, config, depth));
  const download = pipedDownload(scan, config.shell);
  if (download !== null) outcomes.push(download);

  return strictest(...outcomes);
}

const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd"]);
/** Shells whose command option takes the rest of the line, not one argument. */
const REST_OF_LINE_SHELLS: ReadonlySet<string> = new Set(["cmd", "pwsh", "powershell"]);

function executableName(token: string): string {
  const base = token.split(/[\\/]/).pop() ?? token;
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, "");
}

const isAssignment = (token: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

function isDeniedExecutable(exe: string, shell: ShellPolicy): boolean {
  return shell.deniedExecutables.includes(exe) || exe.startsWith("mkfs.");
}

/**
 * Index of the token that is the command a part runs: after `A=1` assignments and
 * wrappers such as `xargs` or `env` (and their options). `tokens.length` when there is none.
 */
function commandIndex(tokens: string[], shell: ShellPolicy): number {
  let p = 0;
  while (p < tokens.length && isAssignment(tokens[p] ?? "")) p++;
  while (p < tokens.length && shell.wrappers.includes(executableName(tokens[p] ?? ""))) {
    p++;
    while (p < tokens.length && ((tokens[p] ?? "").startsWith("-") || isAssignment(tokens[p] ?? ""))) p++;
  }
  return p;
}

/** `curl ... | sh`: a downloader whose output reaches a shell through pipes. */
function pipedDownload(scan: ShellScan, shell: ShellPolicy): PermissionOutcome | null {
  const names = scan.segments.map((tokens) => executableName(tokens[commandIndex(tokens, shell)] ?? ""));
  for (let i = 0; i < names.length; i++) {
    if (!shell.downloaders.includes(names[i] ?? "")) continue;
    for (let j = i + 1; j < names.length && scan.pipedToNext[j - 1] === true; j++) {
      if (shell.pipeShells.includes(names[j] ?? "")) return outcome("deny", `a download piped into ${names[j]} is blocked for every agent`);
    }
  }
  return null;
}

function evaluateSegment(role: AgentRole, tokens: string[], config: PermissionConfig, depth: number): PermissionOutcome {
  const { shell } = config;
  const outcomes: PermissionOutcome[] = [];

  // Denied executables count before the command too (`sudo rm x`, `xargs sudo ...`).
  const start = commandIndex(tokens, shell);
  for (const token of tokens.slice(0, start + 1)) {
    const exe = executableName(token);
    if (isDeniedExecutable(exe, shell)) return outcome("deny", `${exe} is blocked for every agent`);
  }
  const wrapped = tokens.slice(0, start).some((t) => !isAssignment(t));
  if (wrapped) outcomes.push(outcome("ask", "command run through another command"));

  const first = tokens[start];
  if (first === undefined) return strictest(outcome("ask", "shell command"), ...outcomes);
  const exe = executableName(first);

  // `bash -c "..."` and `eval ...` run their argument as a command.
  if (exe === "eval") outcomes.push(evaluateBash(role, tokens.slice(start + 1).join(" "), config, depth + 1));
  if (SHELLS.has(exe)) {
    const c = tokens.findIndex((t, i) => i > start && (t === "-c" || t.toLowerCase() === "/c" || t.toLowerCase() === "-command"));
    const script = c < 0 ? undefined : REST_OF_LINE_SHELLS.has(exe) ? tokens.slice(c + 1).join(" ") : tokens[c + 1];
    if (script !== undefined) outcomes.push(evaluateBash(role, script, config, depth + 1));
  }

  // git anywhere in the part counts (`sudo git ...`, `echo x | xargs git ...`, `A=1 git ...`).
  const gitIndex = tokens.findIndex((t) => executableName(t) === "git");
  let main: Classified;
  if (gitIndex !== -1) {
    if (gitIndex !== start) outcomes.push(outcome("ask", "git run through another command"));
    main = evaluateGit(role, tokens.slice(gitIndex + 1), config);
  } else {
    main = classifyCommand(exe, tokens.slice(start + 1), shell);
  }

  if (role === "reviewer" && main.verdict === "allow" && (main.group === undefined || !shell.reviewerAllowedGroups.includes(main.group))) {
    main = outcome("deny", reviewerReason());
  }
  return strictest(main, ...outcomes);
}

/** PowerShell's -Recurse and every prefix of it (-r, -rec, ...), optionally `-Recurse:$true`. */
const POWERSHELL_RECURSE = /^-r(e(c(u(r(se?)?)?)?)?)?(:.*)?$/i;
const DELETE_COMMANDS: ReadonlySet<string> = new Set(["rm", "rmdir", "rd", "del", "erase", "ri", "remove-item"]);
/** Commands whose ask reason names their first argument too (`npm install`). */
const SUBCOMMAND_TOOLS: ReadonlySet<string> = new Set(["npm", "npx", "pip", "pip3", "node", "python", "python3"]);

function startsWithWords(words: string[], command: string): boolean {
  return command.split(" ").every((word, i) => words[i] === word);
}

/** Every command except git. */
function classifyCommand(exe: string, args: string[], shell: ShellPolicy): Classified {
  if (DELETE_COMMANDS.has(exe)) {
    const unixRecursive = exe === "rm" && args.some((a) => a === "--recursive" || /^-[A-Za-z]*[rR]/.test(a));
    const windowsRecursive = args.some((a) => a.startsWith("/") && a.toLowerCase().split("/").includes("s"));
    if (unixRecursive || windowsRecursive || args.some((a) => POWERSHELL_RECURSE.test(a))) {
      return outcome("deny", "recursive deletes are blocked for every agent");
    }
    return outcome("ask", `${exe} deletes files`);
  }

  const words = [exe, ...args];
  if (shell.lookAround.includes(exe)) return allowIn("lookAround", `${exe} only looks around`);
  if (shell.search.includes(exe)) {
    if (exe === "find" && args.some((a) => shell.findAskArgs.includes(a))) return outcome("ask", "find that runs commands, deletes or writes files");
    return allowIn("search", `${exe} only searches`);
  }
  if (shell.versions.includes(words.join(" "))) return allowIn("versions", "version check");
  const check = shell.checks.find((c) => startsWithWords(words, c));
  if (check !== undefined) return allowIn("checks", `project check (${check})`);

  const label = SUBCOMMAND_TOOLS.has(exe) && args[0] !== undefined ? `${exe} ${args[0]}` : exe;
  return outcome("ask", `${label} is not on the allow list`);
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
const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "diff", "log", "show", "blame"]);
/** Read-only subcommand options that write files or run external programs. */
const READ_ONLY_WRITERS = ["--output", "--ext-diff", "--textconv"];

function evaluateGit(role: AgentRole, args: string[], config: PermissionConfig): Classified {
  const policy = config.git;
  if (args.length === 1 && args[0] === "--version") return allowIn("versions", "version check");

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
  if (sub === undefined) return outcome("ask", "git without a subcommand");
  const rest = args.slice(i + 1);

  const blocked = matchesBlockedPattern(sub, rest, policy.blockedPatterns);
  if (blocked !== null) return outcome("deny", `"git ${blocked}" is blocked for every agent`);

  const floor = riskyGlobal ? outcome("ask", "git option that can run other programs") : outcome("allow", "allowed");
  const definition = ROLE_DEFINITIONS[role];

  if (sub === "commit") {
    if (!definition.canCommit) return outcome("deny", `only the Software Engineer may commit, not the ${definition.roleLabel}`);
    return strictest(floor, policy.commitRequiresApproval ? outcome("ask", "commits need approval") : outcome("allow", "commit"));
  }
  if (sub === "push") {
    if (!definition.canCommit) return outcome("deny", `only the Software Engineer may push, not the ${definition.roleLabel}`);
    return strictest(floor, policy.pushRequiresApproval ? outcome("ask", "pushes need approval") : outcome("allow", "push"));
  }
  const listsBranches = sub === "branch" && rest.every((a) => config.shell.gitBranchListArgs.includes(a));
  if (READ_ONLY_SUBCOMMANDS.has(sub) || listsBranches) {
    const writes = rest.some((a) => READ_ONLY_WRITERS.some((w) => a === w || a.startsWith(`${w}=`)));
    if (writes) return outcome("ask", `git ${sub} with an option that writes files or runs programs`);
    if (riskyGlobal) return floor;
    if (policy.readOnlyRequiresApproval) return outcome("ask", "read-only git needs approval");
    return allowIn("gitRead", "read-only git");
  }
  if (sub === "branch") return outcome("ask", "git branch that creates or changes branches");
  return outcome("ask", `git ${sub}`);
}

/** Returns the blocked pattern that matches (e.g. "push --force"), or null. */
function matchesBlockedPattern(sub: string, rest: string[], patterns: string[]): string | null {
  const parsed = patterns.map((p) => p.trim().split(/\s+/)).filter((p) => p[0] === sub);
  if (parsed.length === 0) return null;

  const longOptions = parsed.flat().filter((t) => t.startsWith("--"));
  const args = normalizeArgs(sub, rest, longOptions);
  const match = parsed.find((tokens) =>
    tokens.slice(1).every((t) => args.has(t) || (t.endsWith(":") && rest.some((a) => a.startsWith(t)))),
  );
  return match === undefined ? null : match.join(" ");
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
  /** pipedToNext[i]: part i's output goes into part i + 1 (`|`, not `||`). */
  pipedToNext: boolean[];
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
  const pipedToNext: boolean[] = [];
  const substitutions: string[] = [];
  let hasRedirect = false;
  let unterminated = false;

  let tokens: string[] = [];
  let token: string | null = null;

  const endToken = () => {
    if (token !== null) tokens.push(token);
    token = null;
  };
  /** The word being read (a function, so the closures' writes are seen). */
  const currentToken = (): string | null => token;
  /** `separator` is what ended the part; an empty part keeps the previous part's separator. */
  const endSegment = (separator = "") => {
    endToken();
    if (tokens.length > 0) {
      segments.push(tokens);
      pipedToNext.push(separator === "|");
    }
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
      // A word of digits right before the operator is its file descriptor (`2>`), not an argument.
      const fd = currentToken();
      if (fd !== null && /^\d+$/.test(fd)) token = null;
      else endToken();
      // `2>&1`, `>&2`, `2>&-`: duplicating or closing a descriptor writes no file.
      const duplicate = /^[<>]&(\d+-?|-)(?=$|[\s;|&()<>])/.exec(command.slice(i));
      if (duplicate !== null) {
        i += duplicate[0].length;
        continue;
      }
      hasRedirect = true;
      i++;
      while (command[i] === ">" || command[i] === "&") i++;
    } else if (SEPARATORS.has(ch)) {
      const double = (ch === "|" || ch === "&") && next === ch;
      endSegment(double ? ch + ch : ch);
      i += double ? 2 : 1;
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

  return { segments, pipedToNext, substitutions, hasRedirect, unterminated };
}
