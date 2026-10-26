# server

Local Node WebSocket server. Owns all state, saves it under `data/`, and runs
one `AgentRunner` per agent (Claude, or the echo runner in tests).

- `index.ts` entry: `npm run dev:server` (or `npm run dev` for web + server).
- `startServer.ts` loopback-only HTTP/WebSocket server: Origin check on upgrade,
  per-start token in `data/session-token` (written once the port is bound),
  hello within 5 s, 1 MB max payload, ping every 15 s, coalesced snapshots.
  Loads saved data on start and creates the Sandbox project on the first start.
- `commands.ts` maps protocol commands to the world, agent manager and project service.
- `world/World.ts` projects, agents, chat; emits events and saves through the store.
- `store/` JSON persistence (atomic writes, append-only chat files).
- `projects/` folder browser rules, project creation/archiving, team notes.
- `roles/` role prompt files, read at the start of every run.
- `agents/AgentManager.ts` per-agent queue + runner lifecycle.
- `agents/AgentRunner.ts` runner interface; `agents/claude/` the Claude runner;
  `agents/EchoRunner.ts` fake agent for tests.

Server code imports `src/shared` with relative paths and explicit `.ts` extensions.
