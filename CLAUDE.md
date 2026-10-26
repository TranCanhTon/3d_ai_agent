# AI Agent World

A local app for managing teams of real Claude agents. Each project is a code folder with a team of six agents (Orchestrator, Product Manager, Researcher, Software Engineer, QA Engineer, Code Reviewer), each a Claude Agent SDK session running on the user's Claude Pro plan. The user chats with any agent directly, or gives a task to the Orchestrator, which runs it through a fixed pipeline of handoffs (PM → Researcher → Engineer → QA → Reviewer, with rework loops). A 3D office (later phases) shows robots doing what each agent is actually doing. Built in 9 phases; `reference/ai-agent-world.md` is a related simulated design used for conventions only (do not modify it, do not build its simulation engine).

## Architecture

    Browser (Next.js) <-- WebSocket --> Node server (separate process, 127.0.0.1 only) <--> Claude Agent SDK

- The server owns all truth: projects, agents, tasks, chat history, Claude session ids.
- The browser only renders state and sends commands. It never talks to Claude.
- Both sides import the same types from `src/shared/`.
- Pipeline handoffs are decided by server code (`workflow.ts`), not by an AI agent.

## Hard rules

1. Everything under `src/shared/` is pure TypeScript: no React, Next, three or `@/` alias imports, and sibling imports use explicit `.ts` extensions. The Node server and `scripts/test.ts` load these files directly (ESLint enforces this).
2. No `any` except at third party boundaries.
3. All limits and settings live in `src/shared/config.ts`.
4. Domain types must not depend on Claude Agent SDK types. A server-side translator maps SDK messages to our events.
5. All timestamps are epoch milliseconds (numbers) set by the server. The client only formats them.
6. Agent ids are role based (`${projectId}:${role}`, see `ids.ts`). Display names are data and can change.

## Folders

- `src/app/` Next.js App Router pages and `globals.css` (Tailwind 4 `@theme` tokens, dark only).
- `src/shared/config.ts` every setting and limit.
- `src/shared/ids.ts` agent id helpers and `newId(prefix)`.
- `src/shared/domain/` pure domain: roles, agent/project/chat/task types, `workflow.ts` (task state machine), `messageQueue.ts` (per-agent FIFO input queue), `permissions.ts` (`evaluatePermission`, the tool and git policy).
- `src/shared/events/` the event vocabulary.
- `src/shared/protocol/` WebSocket contract: `protocol.ts` (types) and `schemas.ts` (zod schemas, `parseClientMessage`, `parseServerMessage`, compile-time checks that schemas match the types).
- `src/shared/backend/AgentBackend.ts` the interface the browser uses to reach the server.
- `src/shared/events/eventPayloads.ts` zod schemas for event `metadata` the client relies on (chat messages, deltas, status, queue).
- `server/` Node WebSocket server run with tsx: `startServer.ts` (loopback bind, Origin check, token hello, 1 MB payload, ping, coalesced snapshots), `commands.ts`, `world/World.ts` (in-memory state + events), `agents/AgentManager.ts` (per-agent queue and run lifecycle), `agents/AgentRunner.ts` (runner interface; `EchoRunner.ts` until phase 3). Imports `src/shared` with relative `.ts` paths.
- `src/app/api/session-token/route.ts` gives the browser the token the server writes to `data/session-token` (loopback Host only).
- `src/client/` `WebSocketAgentBackend.ts` (AgentBackend over WebSocket, acks, timeouts, reconnect) and `backendClient.ts` (singleton + store wiring).
- `src/state/useWorldStore.ts` Zustand mirror: connection, throttled snapshot, chats per agent, recent events.
- `src/components/dev/DevConsole.tsx` temporary dev page (replaced in phase 6).
- `scripts/test.ts` pure domain tests; `scripts/test-server.ts` server integration tests (tsx).

## Machine constraints (Windows)

- Drive C: is full. Never write anything to C:. The project lives in `D:\3d-ai-agent`; npm uses `.npm-cache/` (project `.npmrc`); temp files go to `.tmp/` (`.claude/settings.local.json` sets TEMP, TMP, NODE_COMPILE_CACHE). When starting processes yourself, set those env vars too.
- Run `bd` with `BD_DISABLE_METRICS=1` and `BD_DISABLE_EVENT_FLUSH=1`, otherwise it writes to `C:\Users\ACER\.beads`. Both are set in `.claude/settings.json` and the `.beads/hooks`.
- Scripts must work on Windows: no bash-only syntax, no `&` backgrounding, no `export VAR=`.

## Protocol in one paragraph

First client message: `{ type: "hello", token }`. Then `{ type: "command", id, command: { name, args } }`. Server sends `{ type: "snapshot", snapshot }`, `{ type: "event", event }` and `{ type: "ack", id, ok, result | error }`. Chat history is not in the snapshot: use `getChatHistory`. When you add or change a command, update `CommandArgsMap`/`CommandResultMap` in `protocol.ts`, the schema in `schemas.ts` and the examples in `scripts/test.ts`; typecheck fails if the schema and type drift.

## Checks

    npm run typecheck   # tsc --noEmit, includes the schema/type sync checks
    npm run lint        # eslint src scripts server
    npm test            # domain tests (node --experimental-strip-types) then server tests (tsx)
    npm run dev         # web (http://localhost:3000) + server (ws://127.0.0.1:4317)
    npm run dev:web     # or run them in two terminals
    npm run dev:server

All three checks must pass before a phase is done. Requires Node 22.6+.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:1105d646 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
