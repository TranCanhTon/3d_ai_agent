// Fake agents for trying the UI without Claude (npm run dev:scripted). Each role
// answers a pipeline handoff with the ending the pipeline expects, streams its text,
// shows a few tool lines and asks for one real permission card per build step.
// sONion Ring asks one round of two questions when the description is short (under
// 40 characters), then writes a brief; a change gets an updated brief that restarts
// from implementation. The plan has 5 steps, STD Dren reports steps 1-3 on attempt 1
// and 4-5 on attempt 2, and QA fails attempt 1 so the rework loop shows too. Never
// calls Claude and never writes a file: an allowed Write only changes the reply.

import { CONFIG } from "../../src/shared/config.ts";
import type { AgentRole } from "../../src/shared/domain/roles.ts";
import type { AgentRunCallbacks, AgentRunInput, AgentRunner } from "./AgentRunner.ts";
import { describeTool } from "./claude/toolSummary.ts";
import type { PermissionBroker } from "./PermissionBroker.ts";

export interface ScriptedTiming {
  /** Before the first word. */
  thinkMs: number;
  /** Per streamed word. */
  wordMs: number;
  /** A tool call from start to result. */
  toolMs: number;
}

/** A tool call in a script; `input` is what Claude would send. */
interface ScriptedTool {
  tool: "Read" | "Grep" | "Glob" | "Write" | "Edit" | "Bash";
  input: Record<string, unknown>;
}

/** What one input does: tool calls first, then the reply (which may depend on the tool results). */
interface Script {
  tools: ScriptedTool[];
  reply(results: boolean[]): string;
}

/** The handoff's task title, from its first line: `From X, task "<title>" (attempt N):`. */
function taskTitle(text: string): string {
  return /task "([^"]*)"/.exec(text)?.[1] ?? "the task";
}

function attempt(text: string): number {
  return Number(/\(attempt (\d+)\)/.exec(text)?.[1] ?? "1");
}

/** The New task description in an intake handoff ("" when there is none). */
function description(text: string): string {
  const found = /Description:\n([\s\S]*?)\n\nThis is a new task/.exec(text)?.[1] ?? "";
  return found === "(no description)" ? "" : found.trim();
}

/** The text of a `Label:` block in a handoff, up to the next blank line. */
function blockText(text: string, label: string): string {
  return new RegExp(`${label}:\\n([\\s\\S]*?)(\\n\\n|$)`).exec(text)?.[1]?.trim() ?? "";
}

/** A file name for the task, e.g. "Add dark mode" → "src/add-dark-mode.ts". */
function fileFor(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
  return `src/${slug}.ts`;
}

/** The pipeline's handoffs for each role (see handoff.ts), answered with the right ending. */
export function scriptFor(role: AgentRole, text: string): Script {
  const title = taskTitle(text);
  const file = fileFor(title);
  // A Resume or a reminder inside a task: finish the step (QA passes, the orchestrator ends with what is asked).
  if (text.startsWith("Continue where you left off") || text.startsWith("Your reply did not end")) {
    const step = role === "orchestrator" && text.includes("SUMMARY:") ? "The task finished" : "";
    return scriptFor(role, `From the team, task "the task" (attempt 2): ${step}`);
  }
  // Task inputs start with their header, or with my change line after a change.
  if (!text.startsWith("From ") && !text.includes(" changed the task:\n")) return chatScript(role, text);

  switch (role) {
    case "orchestrator": {
      if (text.includes("The task finished")) {
        return {
          tools: [],
          reply: () =>
            `The team finished **${title}**. Have a look at \`${file}\` and run the tests once yourself.\n\nSUMMARY:\n${title}: added ${file} with a test (scripted run)`,
        };
      }
      if (text.includes("Change request:") || text.includes("Answer to your question about the change") || text.includes("Changes to your updated brief:")) {
        const request = blockText(text, "Change request") || blockText(text, "Changes to your updated brief") || "the change you asked for";
        return {
          tools: [],
          reply: () =>
            `Got it, here is the updated brief.\n\nYOU ASKED:\n${request}\n\nBRIEF:\n**Goal:** deliver "${title}" with this change: ${request}\n\n- **In scope:** the change and a test for it\n- **Out of scope:** unrelated files\n- **Done when:** the tests pass and the change shows in the app\n\nRESTART FROM: implementation - the plan still holds, only the code changes`,
        };
      }
      const brief = (asked: string) => ({
        tools: [{ tool: "Read" as const, input: { file_path: "README.md" } }],
        reply: () =>
          `I read the README.\n\nYOU ASKED:\n${asked}\n\nBRIEF:\n**Goal:** deliver "${title}".\n\n- **In scope:** the change itself and a test for it\n- **Out of scope:** unrelated files\n- **Done when:** the tests pass and the change shows in the app`,
      });
      if (text.includes("Changes to the brief:")) return brief(`"${title}", changed: ${blockText(text, "Changes to the brief")}`);
      if (text.includes("Answer to your question:")) return brief(`"${title}", with your answers: ${blockText(text, "Answer to your question")}`);
      if (text.includes("This is a new task") && description(text).length < 40) {
        return {
          tools: [],
          reply: () =>
            `Before I brief the team I need a few details.\n\nYOU ASKED:\n"${title}", with few details so far.\n\nQUESTION:\n1. Should this cover every page, or only the settings page?\n2. How will you check it is done: a test, or a look in the app?`,
        };
      }
      return brief(`"${title}": ${description(text) || "as described"}`);
    }
    case "product_manager":
      return {
        tools: [{ tool: "Glob", input: { pattern: "src/**/*.ts" } }],
        reply: () =>
          `Here is the plan.\n\nPLAN:\n1. Add ${file}\n2. Wire it into the app\n3. Cover it with a test\n4. Handle the empty case\n5. Mention it in the README\n\nRESEARCH QUESTIONS:\n- Which test runner does the project use?`,
      };
    case "researcher":
      return {
        tools: [
          { tool: "Grep", input: { pattern: "\"test\"", path: "package.json" } },
          { tool: "Read", input: { file_path: "package.json" } },
        ],
        reply: () =>
          `FINDINGS:\n- The project runs its tests with \`npm test\`\n- Source files live in src/ and use TypeScript\n- The README has a Features list to extend`,
      };
    case "engineer": {
      const steps = attempt(text) === 1 ? "1, 2, 3" : "4, 5";
      return {
        tools: [
          { tool: "Read", input: { file_path: "package.json" } },
          { tool: "Write", input: { file_path: file, content: `// ${title}\nexport function feature(): string {\n  return "done";\n}\n` } },
        ],
        reply: ([, wrote]) =>
          wrote
            ? `${text.includes("QA failed") || text.includes("asked for changes") ? "Fixed what was reported." : "Implemented the plan."}\n\nCHANGES:\n- ${file}: new feature() function\n\nHOW TO TEST:\n- npm test\n\nSTEPS DONE: ${steps}`
            : `The Write was denied, so nothing changed yet.\n\nCHANGES:\n- none (the write to ${file} was denied)\n\nHOW TO TEST:\n- nothing to test yet\n\nSTEPS DONE: none`,
      };
    }
    case "qa": {
      const fail = attempt(text) === 1;
      return {
        tools: [{ tool: "Bash", input: { command: "npm test" } }],
        reply: () =>
          fail
            ? `Ran the tests. \`feature()\` has no test for the empty case.\n\nVERDICT: FAIL`
            : `Ran the tests: all green, and the new case is covered.\n\nVERDICT: PASS`,
      };
    }
    case "reviewer":
      return {
        tools: [{ tool: "Bash", input: { command: "git diff" } }],
        reply: () => `The diff is small and readable; naming matches the codebase.\n\nVERDICT: APPROVED`,
      };
  }
}

function chatScript(role: AgentRole, text: string): Script {
  const asked = text.replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    tools: role === "orchestrator" || role === "product_manager" ? [] : [{ tool: "Read", input: { file_path: "README.md" } }],
    reply: () =>
      [
        `Scripted reply: you asked "${asked}".`,
        "",
        "In scripted mode no Claude call is made. Things to try:",
        "- **New task** to watch a handoff run through the whole team",
        "- **New chat** to start a fresh conversation",
        "",
        "```ts",
        "// code blocks get a copy button",
        'const mode = "scripted";',
        "```",
      ].join("\n"),
  };
}

export interface ScriptedRunnerOptions {
  agent: { id: string; role: AgentRole };
  broker: PermissionBroker;
  timing?: ScriptedTiming;
}

let sessionSeq = 0;

export class ScriptedRunner implements AgentRunner {
  private readonly options: ScriptedRunnerOptions;
  private readonly timing: ScriptedTiming;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private abort: AbortController | null = null;
  /** Bumped by stop() and each run; steps of older runs do nothing. */
  private generation = 0;

  constructor(options: ScriptedRunnerOptions) {
    this.options = options;
    this.timing = options.timing ?? CONFIG.scripted;
  }

  run(input: AgentRunInput, callbacks: AgentRunCallbacks): void {
    this.stop();
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    const abort = new AbortController();
    this.abort = abort;
    // No timer for 0 ms: on Windows each one takes ~15 ms, which adds up per streamed word.
    const wait = (ms: number) =>
      ms <= 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            this.timers.push(setTimeout(resolve, ms));
          });

    void (async () => {
      const { agent, broker } = this.options;
      callbacks.onSession(input.sessionId ?? `scripted-${Date.now()}-${++sessionSeq}`);
      callbacks.onRunInfo({ model: `${input.model} (scripted)`, effort: input.effort });
      await wait(this.timing.thinkMs);
      if (!live()) return;

      const script = scriptFor(agent.role, input.text);
      const tools = input.chatOnly ? [] : script.tools;
      const results: boolean[] = [];
      for (const [index, call] of tools.entries()) {
        const description = describeTool(call.tool, call.input, input.cwd);
        const toolUseId = `scripted-tool-${generation}-${index}`;
        callbacks.onStatus(description.status, description.activity);
        callbacks.onTool({ phase: "started", toolUseId, toolName: call.tool, summary: description.line });
        const decision = await broker.decide(agent.id, call.tool, call.input, abort.signal);
        if (!live()) return;
        await wait(this.timing.toolMs);
        if (!live()) return;
        results.push(decision.behavior === "allow");
        callbacks.onTool({ phase: "finished", toolUseId, toolName: call.tool, ok: decision.behavior === "allow" });
      }

      const reply = script.reply(results);
      callbacks.onStatus("communicating", "Typing...");
      for (const word of reply.split(/(?<=\s)/)) {
        callbacks.onDelta(word);
        await wait(this.timing.wordMs);
        if (!live()) return;
      }
      callbacks.onUsage({ inputTokens: 1200 + input.text.length * 3, outputTokens: reply.length });
      callbacks.onComplete(reply);
    })();
  }

  stop(): void {
    this.generation++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.abort?.abort();
    this.abort = null;
    this.options.broker.denyAllFor(this.options.agent.id);
  }
}
