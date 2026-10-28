// File helpers for the data store. Whole files are written atomically: a temp
// file next to the target, then a rename, so a crash never leaves half a file.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const RENAME_ATTEMPTS = 5;

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, "utf8");
  // On Windows a rename can fail briefly while another process (an editor,
  // antivirus) has the target open; retry a few times before giving up.
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS) {
        rmSync(temp, { force: true });
        throw error;
      }
      const until = Date.now() + 20 * attempt;
      while (Date.now() < until) {
        // brief synchronous wait; writes are rare and small
      }
    }
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function appendLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}
