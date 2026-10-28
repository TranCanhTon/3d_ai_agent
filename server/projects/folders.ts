// Folder rules for the folder browser and project creation. Every path is
// compared by its real path (symlinks and junctions resolved), so `..`, links
// and junctions cannot reach outside the browser root.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, relative, resolve } from "node:path";
import { APP_ROOT } from "../../src/shared/config.ts";
import type { FolderEntry, FolderListing } from "../../src/shared/protocol/protocol.ts";

/** Folders the browser never shows (besides hidden folders starting with "."). */
const SYSTEM_FOLDERS = new Set(["$recycle.bin", "system volume information"]);

export interface FolderRules {
  /** Real path of config.folderBrowserRoot. */
  root: string;
  /** Real paths of config.blockedProjectRoots (this app's folder). */
  blockedRoots: string[];
  /** Every project, archived included. */
  projects: ReadonlyArray<{ name: string; rootPath: string }>;
}

/** True when `child` is `parent` or inside it. Case-insensitive on Windows (path.relative is). */
export function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !/^[a-zA-Z]:/.test(rel) && !rel.startsWith("\\\\") && !rel.startsWith("/"));
}

export function samePath(a: string, b: string): boolean {
  return relative(a, b) === "";
}

/** Real path of an existing path, or null when it does not exist. */
export function realPath(path: string): string | null {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return null;
  }
}

/** Real path when the path exists, else the resolved path. */
function canonical(path: string): string {
  return realPath(path) ?? resolve(path);
}

export function resolveBlockedRoots(roots: readonly string[], appRoot: string): string[] {
  return roots.map((root) => canonical(root === APP_ROOT ? appRoot : root));
}

export function resolveBrowserRoot(root: string): string {
  return canonical(root);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isHidden(name: string): boolean {
  return name.startsWith(".") || SYSTEM_FOLDERS.has(name.toLowerCase());
}

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Why a folder (already resolved to its real path) cannot become a project, or null.
 * Does not check that it exists; see checkProjectFolder.
 */
function blockReason(real: string, rules: FolderRules): string | null {
  if (!isInsidePath(real, rules.root)) return `Outside the folder browser root (${rules.root})`;
  if (samePath(real, rules.root) || samePath(real, parse(real).root)) return "A drive root cannot be a project";
  for (const blocked of rules.blockedRoots) {
    if (samePath(real, blocked)) return "This is AI Agent World's own folder";
    if (isInsidePath(real, blocked)) return "Inside AI Agent World's own folder";
    if (isInsidePath(blocked, real)) return "Contains AI Agent World's own folder";
  }
  for (const project of rules.projects) {
    const used = canonical(project.rootPath);
    if (samePath(real, used)) return `Already used by project "${project.name}"`;
    if (isInsidePath(real, used)) return `Inside the folder of project "${project.name}"`;
    if (isInsidePath(used, real)) return `Contains the folder of project "${project.name}"`;
  }
  return null;
}

/** Validates a folder for a new project. Returns its real path or the reason it is refused. */
export function checkProjectFolder(path: string, rules: FolderRules): { ok: true; path: string } | { ok: false; reason: string } {
  const real = realPath(path);
  if (real === null) return { ok: false, reason: "Folder does not exist" };
  if (!isDirectory(real)) return { ok: false, reason: "Not a folder" };
  const reason = blockReason(real, rules);
  return reason === null ? { ok: true, path: real } : { ok: false, reason };
}

/** Lists the visible subfolders of a folder inside the root (default: the root itself). */
export function listFolders(path: string | undefined, rules: FolderRules): FolderListing {
  const real = path === undefined ? rules.root : realPath(path);
  if (real === null || !isDirectory(real)) throw new Error("Folder does not exist");
  if (!isInsidePath(real, rules.root)) throw new Error(`Outside the folder browser root (${rules.root})`);

  let names: string[];
  try {
    names = readdirSync(real);
  } catch (error) {
    throw new Error(`Cannot read folder: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  const entries: FolderEntry[] = [];
  for (const name of names) {
    if (isHidden(name)) continue;
    // Links and junctions are listed under their real path, and only when it stays inside the root.
    const entryPath = realPath(join(real, name));
    if (entryPath === null || !isDirectory(entryPath) || !isInsidePath(entryPath, rules.root)) continue;
    entries.push({
      name,
      path: entryPath,
      isGitRepo: isGitRepo(entryPath),
      hasProject: rules.projects.some((p) => samePath(canonical(p.rootPath), entryPath)),
      blocked: blockReason(entryPath, rules),
    });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  return { path: real, parent: samePath(real, rules.root) ? null : dirname(real), entries };
}

export function folderName(path: string): string {
  return basename(path) || path;
}
