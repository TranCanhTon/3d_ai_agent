// Entry point: `npm run dev:server` (tsx watch server/index.ts).

import { join, resolve } from "node:path";
import { CONFIG } from "../src/shared/config.ts";
import { consoleLogger } from "./log.ts";
import { startServer } from "./startServer.ts";

const server = await startServer({
  host: CONFIG.serverHost,
  port: CONFIG.serverPort,
  tokenPath: resolve(join(CONFIG.dataDir, CONFIG.sessionTokenFile)),
  allowedOrigins: CONFIG.allowedOrigins,
});

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
