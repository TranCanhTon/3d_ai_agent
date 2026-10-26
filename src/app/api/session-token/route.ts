// Hands the browser the server's per-start session token.
// Only answers requests addressed to the app's own loopback host (DNS rebinding guard).
// No CORS headers: other origins cannot read the response.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG } from "@/shared/config.ts";

export const dynamic = "force-dynamic";

const ALLOWED_HOSTS = new Set(CONFIG.allowedOrigins.map((origin) => new URL(origin).host));
const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const host = request.headers.get("host") ?? "";
  if (!ALLOWED_HOSTS.has(host)) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE });
  }
  try {
    const token = (await readFile(join(process.cwd(), CONFIG.dataDir, CONFIG.sessionTokenFile), "utf8")).trim();
    if (token.length === 0) throw new Error("empty token file");
    return Response.json({ token }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Agent server is not running" }, { status: 503, headers: NO_STORE });
  }
}
