// Prepares the Sandbox project folder the Claude agents work in.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const README = `# Agent sandbox

Scratch project for AI Agent World. The agents read and write files here.
Nothing in this folder is part of the AI Agent World app itself.
`;

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel));
}

/** Creates the folder, git-initialises it and adds a README. Returns whether it is a git repo. */
export function ensureSandbox(root: string, appRoot: string): boolean {
  const target = resolve(root);
  const app = resolve(appRoot);
  if (isInside(target, app) || isInside(app, target)) {
    throw new Error(`sandboxRoot (${target}) must not be inside this app's folder (${app}) or contain it`);
  }
  mkdirSync(target, { recursive: true });
  if (!existsSync(join(target, ".git"))) execFileSync("git", ["init", "-q"], { cwd: target, stdio: "ignore" });
  if (!existsSync(join(target, "README.md"))) writeFileSync(join(target, "README.md"), README, "utf8");
  return existsSync(join(target, ".git"));
}
