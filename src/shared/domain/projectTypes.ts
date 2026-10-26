/**
 * A project always has exactly 6 agents, one per role, created together with it.
 * Archiving keeps all data; nothing is ever deleted.
 */
export interface Project {
  id: string;
  name: string;
  /** Absolute path of the code folder the agents work in. */
  rootPath: string;
  isGitRepo: boolean;
  archived: boolean;
  createdAt: number;
}
