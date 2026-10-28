// The team's shared notes file (<project>/.agentworld/notes.md) and the
// project's .gitignore entry for it.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG } from "../../src/shared/config.ts";

export const NOTES_HEADER = "# Team notes";
export const GITIGNORE_ENTRY = ".agentworld/";
/** Spellings that already ignore the folder. */
const IGNORE_SPELLINGS = new Set([".agentworld", ".agentworld/", "/.agentworld", "/.agentworld/"]);

export function notesPath(rootPath: string): string {
  return join(rootPath, CONFIG.notesPath);
}

/** Creates the notes file with its header line if it is missing. */
export function ensureNotesFile(rootPath: string): void {
  const path = notesPath(rootPath);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${NOTES_HEADER}\n\n`, "utf8");
}

/** Adds `.agentworld/` to the project's .gitignore (created if missing) unless it is already there. */
export function ensureGitignoreEntry(rootPath: string): boolean {
  const path = join(rootPath, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (current.split(/\r?\n/).some((line) => IGNORE_SPELLINGS.has(line.trim()))) return false;
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const separator = current === "" || current.endsWith("\n") ? "" : eol;
  writeFileSync(path, `${current}${separator}${GITIGNORE_ENTRY}${eol}`, "utf8");
  return true;
}

export function readNotes(rootPath: string): string {
  const path = notesPath(rootPath);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** Local date as YYYY-MM-DD. */
export function noteDate(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** One line of text: whitespace and newlines collapsed, cut to noteMaxChars. Throws when empty. */
export function cleanNoteText(text: string, maxChars: number = CONFIG.noteMaxChars): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine === "") throw new Error("A note cannot be empty");
  return oneLine.length > maxChars ? oneLine.slice(0, maxChars).trimEnd() : oneLine;
}

/** `- <text> (<by>, YYYY-MM-DD)` */
export function formatNote(text: string, by: string, epochMs: number): string {
  return `- ${text} (${by}, ${noteDate(epochMs)})`;
}

/** Appends one line to the notes file (creating it if needed). */
export function appendNoteLine(rootPath: string, line: string): void {
  ensureNotesFile(rootPath);
  const path = notesPath(rootPath);
  const current = readFileSync(path, "utf8");
  appendFileSync(path, `${current === "" || current.endsWith("\n") ? "" : "\n"}${line}\n`, "utf8");
}
