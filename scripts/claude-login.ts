// `npm run claude:login`: opens the Claude Code bundled with the Agent SDK, using
// the agents' config folder (config.claudeConfigDir) so the login is stored there.
// Type /login, choose your Claude Pro account, then /exit.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { assertSubscriptionBilling, buildAgentEnv } from "../server/agents/claude/ClaudeRunner.ts";
import { ensureSandbox } from "../server/sandbox.ts";
import { CONFIG } from "../src/shared/config.ts";

assertSubscriptionBilling(process.env);

const require = createRequire(import.meta.url);
const binary = process.platform === "win32" ? "claude.exe" : "claude";
const executable =
  CONFIG.claudeExecutablePath ?? require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/${binary}`);

const tempDir = resolve(CONFIG.claudeTempDir);
mkdirSync(tempDir, { recursive: true });
if (CONFIG.claudeConfigDir !== null) mkdirSync(CONFIG.claudeConfigDir, { recursive: true });
ensureSandbox(CONFIG.sandboxRoot, process.cwd());

console.log(`Claude Code: ${executable}`);
console.log(`Config folder: ${CONFIG.claudeConfigDir ?? "(Claude default)"}`);
console.log("Type /login, pick your Claude Pro account, then /exit.\n");

const result = spawnSync(executable, [], {
  cwd: resolve(CONFIG.sandboxRoot),
  stdio: "inherit",
  // Next's types make NODE_ENV required on ProcessEnv; the child does not need it.
  env: buildAgentEnv(process.env, { configDir: CONFIG.claudeConfigDir, tempDir }) as NodeJS.ProcessEnv,
});
process.exit(result.status ?? 1);
