# server

Local Node WebSocket server (phase 2). Owns all state in memory and runs one
`AgentRunner` per agent (an echo runner until phase 3 adds Claude).

- `index.ts` entry: `npm run dev:server` (or `npm run dev` for web + server).
- `startServer.ts` loopback-only HTTP/WebSocket server: Origin check on upgrade,
  per-start token in `data/session-token`, hello within 5 s, 1 MB max payload,
  ping every 15 s, coalesced snapshots.
- `commands.ts` maps protocol commands to the world and agent manager.
- `world/World.ts` in-memory projects, agents, chat; emits events.
- `agents/AgentManager.ts` per-agent queue + runner lifecycle.
- `agents/AgentRunner.ts` runner interface; `agents/EchoRunner.ts` temporary fake agent.

Server code imports `src/shared` with relative paths and explicit `.ts` extensions.
