// Entry point: `npm run dev:server` (tsx watch server/index.ts). `--runner=scripted` uses the fake team.

import { join, resolve } from "node:path";
import { CONFIG } from "../src/shared/config.ts";
import { consoleLogger } from "./log.ts";
import { resolveRunnerKind, startServer } from "./startServer.ts";

let server: Awaited<ReturnType<typeof startServer>>;
try {
  server = await startServer({
    host: CONFIG.serverHost,
    port: CONFIG.serverPort,
    tokenPath: resolve(join(CONFIG.dataDir, CONFIG.sessionTokenFile)),
    allowedOrigins: CONFIG.allowedOrigins,
    runner: resolveRunnerKind(process.env, process.argv.slice(2)),
  });
} catch (error) {
  consoleLogger(`server failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  consoleLogger(`${signal} received, shutting down`);
  server.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => consoleLogger(`uncaught exception: ${error.stack ?? error.message}`));
process.on("unhandledRejection", (reason) => consoleLogger(`unhandled rejection: ${String(reason)}`));
