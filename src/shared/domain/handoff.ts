// Pipeline steps, the reply markers each step must end with, and the handoff
// texts the server sends between agents. Pure: no I/O, never throws.

import type { AgentRole } from "./roles.ts";
import { RESTART_STEPS, type RestartStep, type Task } from "./taskTypes.ts";

// ── Steps ───────────────────────────────────────────────────────────────────

/** One agent turn in the pipeline. "summary" runs while the task's phase is still "review". */
export const PIPELINE_STEPS = ["intake", "planning", "research", "implementation", "testing", "review", "summary"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_ROLE: Record<PipelineStep, AgentRole> = {
  intake: "orchestrator",
  planning: "product_manager",
  research: "researcher",
  implementation: "engineer",
  testing: "qa",
  review: "reviewer",
  summary: "orchestrator",
};

/** What a step's reply must end with, as written in reminders and pause reasons. */
export const STEP_ENDING: Record<PipelineStep, string> = {
  intake: "YOU ASKED: and BRIEF: (or QUESTION:)",
  planning: "PLAN: and RESEARCH QUESTIONS:",
  research: "FINDINGS:",
  implementation: "CHANGES:, HOW TO TEST: and STEPS DONE:",
  testing: "VERDICT: PASS or VERDICT: FAIL",
  review: "VERDICT: APPROVED or VERDICT: CHANGES",
  summary: "SUMMARY:",
};

/** Pause reasons the pipeline sets itself (a run error pauses with its error line). */
export const PAUSE = {
  stopped: "Stopped by you",
  restarted: "Server restarted",
  archived: "Project archived",
  question: "Waiting for your answer",
  permission: "Waiting for your OK",
  change: "Waiting for your OK on a change",
} as const;

/** What sONion Ring's reply to a change must end with. */
export const CHANGE_ENDING = "YOU ASKED:, BRIEF: and RESTART FROM: (or QUESTION:)";

// ── Marker parser ───────────────────────────────────────────────────────────

export const MARKERS = [
  "YOU ASKED",
  "BRIEF",
  "RESTART FROM",
  "QUESTION",
  "PLAN",
  "RESEARCH QUESTIONS",
  "FINDINGS",
  "CHANGES",
  "HOW TO TEST",
  "STEPS DONE",
  "VERDICT",
  "SUMMARY",
] as const;
export type Marker = (typeof MARKERS)[number];

/** Longest first, so "RESEARCH QUESTIONS" is not read as something shorter. */
const MARKERS_BY_LENGTH = [...MARKERS].sort((a, b) => b.length - a.length);
/** Markdown Claude may put around a marker: `**VERDICT: PASS**`, `## PLAN:`, `> BRIEF:`. */
const DECORATION = /^[\s#>*_`]*/;
/** Also a final period: `VERDICT: PASS.` is still PASS. */
const TRAILING_DECORATION = /[\s*_`.]+$/;

interface MarkerLine {
  marker: Marker;
  /** Text after the colon on the same line, decoration removed. */
  rest: string;
}

function readMarkerLine(line: string): MarkerLine | null {
  const text = line.replace(DECORATION, "");
  for (const marker of MARKERS_BY_LENGTH) {
    if (!text.startsWith(marker)) continue;
    const after = text.slice(marker.length).replace(/^[*_`]*/, "");
    if (!after.startsWith(":")) continue;
    return { marker, rest: after.slice(1).replace(/^[*_`]*/, "").replace(TRAILING_DECORATION, "").trim() };
  }
  return null;
}

export interface ParsedReply {
  /** Content of the last occurrence of each marker: the same-line text plus the lines up to the next marker. */
  sections: Partial<Record<Marker, string>>;
  /** Same-line text of the last occurrence of each marker (VERDICT: PASS → "PASS"). */
  values: Partial<Record<Marker, string>>;
  /** Line index of the last occurrence of each marker. */
  lines: Partial<Record<Marker, number>>;
}

export function parseReply(text: string): ParsedReply {
  const result: ParsedReply = { sections: {}, values: {}, lines: {} };
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let current: { marker: Marker; body: string[] } | null = null;

  const close = () => {
    if (current !== null) result.sections[current.marker] = current.body.join("\n").trim();
  };
  lines.forEach((line, index) => {
    const found = readMarkerLine(line);
    if (found === null) {
      current?.body.push(line);
      return;
    }
    close();
    current = { marker: found.marker, body: found.rest === "" ? [] : [found.rest] };
    result.values[found.marker] = found.rest;
    result.lines[found.marker] = index;
  });
  close();
  return result;
}

/** "none", "None.", "- none", "(none)" or nothing at all. */
export function isNone(text: string | undefined): boolean {
  if (text === undefined) return true;
  const letters = text.replace(/[^A-Za-z]/g, "").toLowerCase();
  return letters === "" || letters === "none";
}

/** Strips list markup and bold from one line. */
function cleanItem(text: string): string {
  return text.replace(/[*_`]+/g, "").trim();
}

/** `1. Add the toggle` lines of a plan. */
export function planSteps(plan: string): string[] {
  const steps: string[] = [];
  for (const line of plan.split("\n")) {
    const match = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined && cleanItem(match[1]) !== "") steps.push(cleanItem(match[1]));
  }
  return steps;
}

/** `- use X` lines of the findings. */
export function bulletItems(text: string): string[] {
  const items: string[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*[-*•]\s+(.+)$/.exec(line);
    if (match?.[1] !== undefined && cleanItem(match[1]) !== "") items.push(cleanItem(match[1]));
  }
  return items;
}

/** `STEPS DONE: 1, 2, 4` → [1, 2, 4]; "none" or nothing → []. */
export function stepNumbers(text: string | undefined): number[] {
  if (text === undefined) return [];
  return [...new Set([...text.matchAll(/\d+/g)].map((m) => Number(m[0])))];
}

export type StepResult =
  | { kind: "brief"; brief: string; youAsked: string }
  | { kind: "question"; question: string; /** sONion Ring's restatement at intake; null for other steps. */ youAsked: string | null }
  | { kind: "plan"; plan: string; researchQuestions: string; skipResearch: boolean; subtasks: string[] }
  | { kind: "findings"; findings: string; items: string[] }
  | { kind: "changes"; changes: string; howToTest: string; stepsDone: number[] }
  | { kind: "qa"; verdict: "PASS" | "FAIL" }
  | { kind: "review"; verdict: "APPROVED" | "CHANGES" }
  | { kind: "summary"; summary: string }
  | { kind: "missing"; marker: string };

const missing = (marker: string): StepResult => ({ kind: "missing", marker });

/** The markers that finish each step; a QUESTION: after them (or without them) is a question to me. */
const STEP_MARKERS: Record<PipelineStep, Marker[]> = {
  intake: ["BRIEF"],
  planning: ["PLAN", "RESEARCH QUESTIONS"],
  research: ["FINDINGS"],
  implementation: ["CHANGES", "HOW TO TEST"],
  testing: ["VERDICT"],
  review: ["VERDICT"],
  summary: ["SUMMARY"],
};

/** Steps whose agent may stop and ask me something (the summary only reports). */
export function canAsk(step: PipelineStep): boolean {
  return step !== "summary";
}

/** QUESTION: comes after the ending markers (or there are none): the reply asks me. */
function asksLast(reply: ParsedReply, endings: Marker[]): boolean {
  const { sections, lines } = reply;
  const has = (marker: Marker) => sections[marker] !== undefined && sections[marker] !== "";
  if (!has("QUESTION")) return false;
  // A verdict sits on its marker line, so its section may be empty.
  const endingLine = Math.max(-1, ...endings.map((marker) => (marker === "VERDICT" || has(marker) ? (lines[marker] ?? -1) : -1)));
  return (lines.QUESTION ?? -1) > endingLine;
}

/**
 * Reads a step's final reply. Any step but the summary may end with QUESTION:
 * instead of its ending, whichever comes last. `questionAllowed` is false once I
 * answered a question in this step (one question per step, so it cannot loop).
 * Intake always may ask (sONion Ring asks until he is sure) and must first restate
 * my request (YOU ASKED:).
 */
export function readStepResult(step: PipelineStep, text: string, questionAllowed = true): StepResult {
  const reply = parseReply(text);
  const { sections, values } = reply;
  const has = (marker: Marker) => sections[marker] !== undefined && sections[marker] !== "";

  if (step === "intake") {
    if (!has("YOU ASKED")) return missing("YOU ASKED:");
    const youAsked = sections["YOU ASKED"] ?? "";
    if (asksLast(reply, STEP_MARKERS.intake)) return { kind: "question", question: sections.QUESTION ?? "", youAsked };
    return has("BRIEF") ? { kind: "brief", brief: sections.BRIEF ?? "", youAsked } : missing("BRIEF:");
  }
  if (questionAllowed && canAsk(step) && asksLast(reply, STEP_MARKERS[step])) {
    return { kind: "question", question: sections.QUESTION ?? "", youAsked: null };
  }

  switch (step) {
    case "planning": {
      if (!has("PLAN")) return missing("PLAN:");
      if (sections["RESEARCH QUESTIONS"] === undefined) return missing("RESEARCH QUESTIONS:");
      const plan = sections.PLAN ?? "";
      const researchQuestions = sections["RESEARCH QUESTIONS"];
      return { kind: "plan", plan, researchQuestions, skipResearch: isNone(researchQuestions), subtasks: planSteps(plan) };
    }
    case "research": {
      if (!has("FINDINGS")) return missing("FINDINGS:");
      const findings = sections.FINDINGS ?? "";
      return { kind: "findings", findings, items: bulletItems(findings) };
    }
    case "implementation":
      if (!has("CHANGES")) return missing("CHANGES:");
      if (!has("HOW TO TEST")) return missing("HOW TO TEST:");
      return { kind: "changes", changes: sections.CHANGES ?? "", howToTest: sections["HOW TO TEST"] ?? "", stepsDone: stepNumbers(sections["STEPS DONE"]) };
    case "testing": {
      const verdict = values.VERDICT;
      return verdict === "PASS" || verdict === "FAIL" ? { kind: "qa", verdict } : missing("VERDICT:");
    }
    case "review": {
      const verdict = values.VERDICT;
      return verdict === "APPROVED" || verdict === "CHANGES" ? { kind: "review", verdict } : missing("VERDICT:");
    }
    case "summary": {
      const summary = firstLine(sections.SUMMARY ?? "");
      return summary === "" ? missing("SUMMARY:") : { kind: "summary", summary };
    }
  }
}

export type ChangeResult =
  | { kind: "question"; question: string; youAsked: string }
  | { kind: "change"; youAsked: string; brief: string; restartFrom: RestartStep; why: string }
  | { kind: "missing"; marker: string };

/** `implementation`, `**Implementation** - the toggle moves` → implementation; anything else → null. */
export function readRestartFrom(text: string | undefined): { step: RestartStep; why: string } | null {
  if (text === undefined) return null;
  const match = /^[\s*_`]*([A-Za-z]+)[*_`]*[\s.:—–-]*([\s\S]*)$/.exec(text.trim());
  const word = match?.[1]?.toLowerCase() ?? "";
  const step = RESTART_STEPS.find((s) => s === word);
  return step === undefined ? null : { step, why: firstLine(match?.[2] ?? "") };
}

/** sONion Ring's reply to a change: YOU ASKED: and either QUESTION: or BRIEF: + RESTART FROM:. */
export function readChangeResult(text: string): ChangeResult {
  const reply = parseReply(text);
  const { sections } = reply;
  const has = (marker: Marker) => sections[marker] !== undefined && sections[marker] !== "";
  if (!has("YOU ASKED")) return { kind: "missing", marker: "YOU ASKED:" };
  const youAsked = sections["YOU ASKED"] ?? "";
  if (asksLast(reply, ["BRIEF", "RESTART FROM"])) return { kind: "question", question: sections.QUESTION ?? "", youAsked };
  if (!has("BRIEF")) return { kind: "missing", marker: "BRIEF:" };
  const restart = readRestartFrom(sections["RESTART FROM"]);
  if (restart === null) return { kind: "missing", marker: "RESTART FROM:" };
  return { kind: "change", youAsked, brief: sections.BRIEF ?? "", restartFrom: restart.step, why: restart.why };
}

/** First non-empty line, without list markup. */
export function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const clean = cleanItem(line.replace(/^\s*[-*•]\s+/, ""));
    if (clean !== "") return clean;
  }
  return "";
}

// ── Handoff texts ───────────────────────────────────────────────────────────

/** Display names by role (data: they can change). */
export type TeamNames = Record<AgentRole, string>;

function header(from: string, task: Pick<Task, "title">, attempt?: number): string {
  return `From ${from}, task "${task.title}"${attempt === undefined ? "" : ` (attempt ${attempt})`}:`;
}

/** Added to every handoff after intake (which says it in its own words) except the summary. */
export const ASK_LINE =
  "If you cannot go on without a decision from the user (what they want, or a design choice), ask them one question instead and end with QUESTION:.";

function block(marker: string, content: string): string {
  return `${marker}\n${content.trim() === "" ? "(empty)" : content.trim()}`;
}

const INTAKE_RULES =
  "Start with YOU ASKED: and my request in your own words, short. Then, if you are not about 95% sure what I want (scope, files, behaviour, how to check it), end with QUESTION: and numbered questions (at most 5). Otherwise end with BRIEF: and the full brief for the team: goal, in scope, out of scope, files or areas if known, and what done looks like (how to check it). Never guess to fill gaps.";

export function intakeHandoff(task: Pick<Task, "title" | "description" | "priority">): string {
  return [
    header("you", task),
    `Title: ${task.title}\nPriority: ${task.priority}`,
    block("Description:", task.description === "" ? "(no description)" : task.description),
    `This is a new task from the New task form. Confirm it with me before the team starts. ${INTAKE_RULES}`,
  ].join("\n\n");
}

/** Request changes on a brief: back to sONion Ring in the task's session. */
export function reviseBriefHandoff(task: Pick<Task, "title">, request: string): string {
  return [
    header("you", task),
    block("Changes to the brief:", request),
    `Answer with a new YOU ASKED: and a full new BRIEF: (or QUESTION: if you need to know more), never only the differences. ${INTAKE_RULES}`,
  ].join("\n\n");
}

/** My answer, back to the agent that asked, in its task session. */
export function answerHandoff(task: Pick<Task, "title">, step: PipelineStep, answer: string): string {
  return [header("you", task), block("Answer to your question:", answer), `Now go on with your step and end with ${STEP_ENDING[step]}.`].join("\n\n");
}

/** What sONion Ring gets with a change to a running task. */
export interface ChangeContext {
  approvedBrief: string;
  plan: string;
  /** STD Dren's latest CHANGES, or null before implementation. */
  changes: string | null;
  /** "QA, attempt 1: FAIL" lines, oldest first. */
  verdicts: string[];
  /** e.g. "Implementation (STD Dren)". */
  currentStep: string;
}

export function changeHandoff(task: Pick<Task, "title">, request: string, context: ChangeContext): string {
  return [
    header("you", task),
    block("Change request:", request),
    block("Approved brief:", context.approvedBrief),
    block("Plan:", context.plan === "" ? "(no plan yet)" : context.plan),
    block("Latest CHANGES from the engineer:", context.changes ?? "(none yet)"),
    block("Verdicts so far:", context.verdicts.length === 0 ? "(none yet)" : context.verdicts.map((v) => `- ${v}`).join("\n")),
    `Current step: ${context.currentStep}`,
    "I want to change this running task. The current step finishes, then the team waits for my OK. Start with YOU ASKED: and the change in your own words. If you are not about 95% sure what I want, end with QUESTION: and numbered questions (at most 5). Otherwise write the full updated BRIEF: (not only the differences), then RESTART FROM: with one of planning, research, implementation or testing and one line why. Pick the earliest step the change actually affects.",
  ].join("\n\n");
}

/** My answer to sONion Ring's question about a change. */
export function changeAnswerHandoff(task: Pick<Task, "title">, answer: string): string {
  return [header("you", task), block("Answer to your question about the change:", answer), `Now end with ${CHANGE_ENDING}.`].join("\n\n");
}

/** Request changes on sONion Ring's updated brief for a change. */
export function reviseChangeHandoff(task: Pick<Task, "title">, request: string): string {
  return [
    header("you", task),
    block("Changes to your updated brief:", request),
    `Answer with a new YOU ASKED:, the full updated BRIEF: (not only the differences) and RESTART FROM:, or QUESTION: if you need to know more. End with ${CHANGE_ENDING}.`,
  ].join("\n\n");
}

/** Put before the first handoff after a change is applied. */
export function changedTaskLine(userName: string, request: string): string {
  return `${userName} changed the task:\n${request.trim()}`;
}

const STEPS_DONE_LINE = "STEPS DONE: with the numbers of the plan steps you finished in this attempt (for example STEPS DONE: 1, 2).";

export function planningHandoff(names: TeamNames, task: Pick<Task, "title" | "description">, brief: string): string {
  return [
    header(names.orchestrator, task),
    block("BRIEF:", brief),
    block("Task description:", task.description === "" ? "(no description)" : task.description),
    'Make the plan. End with PLAN: and RESEARCH QUESTIONS: (write "none" when there are none).',
    ASK_LINE,
  ].join("\n\n");
}

export function researchHandoff(names: TeamNames, task: Pick<Task, "title">, brief: string, plan: string, questions: string): string {
  return [
    header(names.product_manager, task),
    block("BRIEF:", brief),
    block("PLAN:", plan),
    block("RESEARCH QUESTIONS:", questions),
    "Answer the research questions. End with FINDINGS:.",
    ASK_LINE,
  ].join("\n\n");
}

export function implementationHandoff(
  names: TeamNames,
  task: Pick<Task, "title">,
  brief: string,
  plan: string,
  findings: string | null,
): string {
  const from = findings === null ? names.product_manager : names.researcher;
  return [
    header(from, task, 1),
    block("BRIEF:", brief),
    block("PLAN:", plan),
    block("FINDINGS:", findings ?? "none (no research needed)"),
    `Implement the plan. Do not commit or push. End with CHANGES: and HOW TO TEST:, then ${STEPS_DONE_LINE}`,
    ASK_LINE,
  ].join("\n\n");
}

/** QA failed or review asked for changes: back to STD Dren in his task session. */
export function reworkHandoff(
  names: TeamNames,
  task: Pick<Task, "title">,
  attempt: number,
  source: "qa" | "review",
  feedback: string,
  brief: string,
): string {
  const from = source === "qa" ? names.qa : names.reviewer;
  const what = source === "qa" ? "QA failed" : "The review asked for changes";
  return [
    header(from, task, attempt),
    block(`${what}. Report:`, feedback),
    block("BRIEF:", brief),
    `Fix exactly what was reported, then check nothing else broke. Do not commit or push. End with CHANGES: and HOW TO TEST:, then ${STEPS_DONE_LINE}`,
    ASK_LINE,
  ].join("\n\n");
}

export function testingHandoff(
  names: TeamNames,
  task: Pick<Task, "title">,
  attempt: number,
  brief: string,
  plan: string,
  changes: string,
  howToTest: string,
): string {
  return [
    header(names.engineer, task, attempt),
    block("BRIEF:", brief),
    block("PLAN:", plan),
    block("CHANGES:", changes),
    block("HOW TO TEST:", howToTest),
    "Test the changes. Your last line must be VERDICT: PASS or VERDICT: FAIL.",
    ASK_LINE,
  ].join("\n\n");
}

export function reviewHandoff(names: TeamNames, task: Pick<Task, "title">, attempt: number, brief: string, plan: string, changes: string): string {
  return [
    header(names.qa, task, attempt),
    "QA passed.",
    block("BRIEF:", brief),
    block("PLAN:", plan),
    block("CHANGES:", changes),
    "Review the changes with git diff. Your last line must be VERDICT: APPROVED or VERDICT: CHANGES.",
    ASK_LINE,
  ].join("\n\n");
}

export function summaryHandoff(
  names: TeamNames,
  task: Pick<Task, "title">,
  attempts: number,
  brief: string,
  changes: string,
  qaVerdict: string,
  reviewVerdict: string,
): string {
  return [
    header(names.reviewer, task),
    `The task finished after ${attempts} attempt${attempts === 1 ? "" : "s"}. QA: ${qaVerdict}. Review: ${reviewVerdict}.`,
    block("BRIEF:", brief),
    block("Final CHANGES:", changes),
    "Give the user a short summary of what changed and what they should check, and end with SUMMARY: and one line for the team notes.",
  ].join("\n\n");
}

/** Sent once when a reply lacks its required ending. */
export function reminderText(step: PipelineStep): string {
  return `Your reply did not end with the required ending. Finish now with: ${STEP_ENDING[step]}`;
}

/** Sent once when sONion Ring's reply to a change lacks its ending. */
export function changeReminderText(): string {
  return `Your reply did not end with the required ending. Finish now with: ${CHANGE_ENDING}`;
}

/** Resume after a pause, into the step's task session. */
export function continueText(step: PipelineStep): string {
  return `Continue where you left off. Finish with the required ending: ${STEP_ENDING[step]}.`;
}
