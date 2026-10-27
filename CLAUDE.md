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
- `src/shared/config.ts` every setting and limit. `blockedProjectRoots` uses `APP_ROOT` for this app's folder (resolved by the server from process.cwd()).
- `src/shared/ids.ts` agent id helpers and `newId(prefix)`.
- `src/shared/domain/` pure domain: roles, agent/project/chat/task types, `workflow.ts` (task state machine), `messageQueue.ts` (per-agent FIFO input queue), `permissions.ts` (`evaluatePermission`, the tool, git and shell policy), `handoff.ts` (pipeline steps, the reply marker parser `readStepResult`, the handoff text templates).
- `src/shared/events/` the event vocabulary.
- `src/shared/protocol/` WebSocket contract: `protocol.ts` (types) and `schemas.ts` (zod schemas, `parseClientMessage`, `parseServerMessage`, compile-time checks that schemas match the types).
- `src/shared/backend/AgentBackend.ts` the interface the browser uses to reach the server.
- `src/shared/events/eventPayloads.ts` zod schemas for event `metadata` the client relies on (chat messages, deltas, status, queue, `{ task }` on task events).
- `server/` Node WebSocket server run with tsx: `startServer.ts` (loopback bind, Origin check, token hello, 1 MB payload, ping, coalesced snapshots), `commands.ts`, `world/World.ts` (in-memory state + events), `agents/AgentManager.ts` (per-agent queue and run lifecycle, session reset, chat only, task inputs and the `TaskHooks` the pipeline implements), `pipeline/Pipeline.ts` (tasks, the waiting line, steps, pauses, resume, cancel, task log), `agents/AgentRunner.ts` (runner interface; `EchoRunner.ts` is the fake runner for tests and `AGENT_RUNNER=echo`). Imports `src/shared` with relative `.ts` paths.
- `src/app/api/session-token/route.ts` gives the browser the token the server writes to `data/session-token` (loopback Host only).
- `src/client/` `WebSocketAgentBackend.ts` (AgentBackend over WebSocket, acks, timeouts, reconnect) and `backendClient.ts` (singleton + store wiring).
- `src/state/useWorldStore.ts` Zustand mirror: connection, throttled snapshot, chats per agent, recent events.
- `src/components/dev/DevConsole.tsx` temporary dev page (replaced in phase 6).
- `server/agents/claude/` the real agents: `ClaudeRunner.ts` (Claude Agent SDK `query()`, billing guard, env, recordings, role prompt, tool list), `translate.ts` (pure SDK message → action mapping), `toolSummary.ts` (tool call descriptions), `notesTool.ts` (the in-process `agentworld` tool server with `add_note`). `server/agents/PermissionBroker.ts` turns "ask" verdicts into permission cards and waits for `respondPermission`. `server/sandbox.ts` prepares `config.sandboxRoot`.
- `server/projects/` `folders.ts` (folder browser and project folder rules, all on real paths), `notes.ts` (`.agentworld/notes.md`, the `.gitignore` entry), `ProjectService.ts` (create, archive, restore, notes, pins).
- `server/store/` `DataStore.ts` JSON persistence under `dataDir`: `projects.json`, `agents/<projectId>.json` (session id, chat only, queued inputs), `chats/<agentId with : → _>.jsonl` (append only; the latest line per message id wins, `{ deletedId }` removes one), `tasks/<projectId>.json` (each task plus the pipeline's step state). Whole files are written atomically (`files.ts`). Loaded once on start by `World.load()`.
- `server/roles/` the role prompt files (`shared.md` + one per role) and `rolePrompts.ts`. Read at the start of every run and appended to Claude Code's own prompt.
- `scripts/test.ts` pure domain tests; `scripts/test-server.ts` server integration tests; `scripts/test-agents.ts` translator, broker, billing guard, role prompts, add_note and ClaudeRunner with a fake SDK (tsx); `scripts/test-projects.ts` folder rules, projects, notes and persistence across a server restart; `scripts/test-pipeline.ts` the pipeline with a scripted fake runner per role (happy path, skips, rework, pauses, cancel, line order, restart). Tests use folders under `.tmp/`, never `data/` or `D:\agent-sandbox`. `npm test` never calls Claude. `npm run test:live` makes one real call (with a throwaway data folder).

## Claude agents

- Agents run on the Claude subscription only. The billing guard refuses to start with ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX set, strips every inherited CLAUDE*/ANTHROPIC* variable, and aborts a run whose init reports API key billing.
- The agents' Claude Code login, sessions and settings live in `config.claudeConfigDir` (`D:\3d-ai-agent\.claude-home`, git-ignored). Log in once with `npm run claude:login` (pick "Claude account with subscription").
- Every tool call goes through `explainPermission` in a PreToolUse hook ("ask" forces `canUseTool` → PermissionBroker card). Never use the SDK's `allowedTools` (it auto-approves) or a bypass permission mode.
- Permissions (`permissions.ts`, lists in `config.git` and `config.shell`): Read/Grep/Glob/Web*/add_note allow, Edit/Write ask. Bash (engineer, qa, reviewer) allows look around (`ls`, `cat`, `echo`...), search (`grep`, `rg`, `find` without `-exec`/`-delete`...), exact version checks, read-only git (`status diff log show blame`, listing `branch`) and project checks (`npm test`, `npm run typecheck|lint|build`, `tsc --noEmit`). Denied for everyone: blocked git patterns, recursive deletes (`rm -r`, `rd /s`, `Remove-Item -Recurse`...), `sudo su doas shutdown reboot format mkfs diskpart`, a download piped into a shell. Engineer commits with no card, pushes with a card; others may not. Everything else asks. The reviewer only gets look around, search, versions and git read: anything else is denied, never asked. Redirects, `$(...)`, backticks and unclear quoting are at least "ask".
- The only tool server is our in-process `agentworld` server (`add_note`, seen by Claude as `mcp__agentworld__add_note`; `canonicalToolName` maps it back). No other MCP servers, claude.ai connectors or skills are loaded (`strictMcpConfig`, `disableClaudeAiConnectors`, `skills: []`): the connectors add ~300k tokens per run.
- Role prompt (`buildRolePrompt`): role file + `shared.md` + the team notes (`Team notes (.agentworld/notes.md):` and the file without its header, or `Team notes: none yet.`; over `notesPromptMaxChars` only the newest lines that fit, after `(Older notes are in .agentworld/notes.md.)`) + `Project folder: <root>` (+ the chat only line). Chat only prompts get the notes too.
- System prompt: `{ type: "preset", preset: "claude_code", append: <role prompt>, snapshot: false }`. `snapshot: false` matters: a recorded prompt would ignore prompt edits and the chat only switch in resumed sessions.
- Chat only agents run with `tools: []`, no tool server, and an empty allowed tool list in the permission rules.
- Raw SDK messages are recorded to `data/recordings/<agent>/<YYYYMMDD-HHmmss>.jsonl`.

## Task pipeline

- A task starts only from the New task form (`submitTask`); chatting with sONion Ring stays chat. Server code (`Pipeline.ts` with `workflow.ts` and `handoff.ts`) decides every handoff; no agent picks who goes next. The pipeline never commits or pushes.
- Steps: intake (sONion Ring, ends `BRIEF:` or `QUESTION:`) → planning (Pronelio Maximus, `PLAN:` + `RESEARCH QUESTIONS:`) → research (Drater, `FINDINGS:`; skipped when the questions are none/empty) → implementation (STD Dren, `CHANGES:` + `HOW TO TEST:`) → testing (Quantarino, last `VERDICT:` PASS/FAIL) → review (Rabies, last `VERDICT:` APPROVED/CHANGES) → summary (sONion Ring, `SUMMARY:`, while the phase is still review; `approved` is applied when it arrives). QA FAIL or review CHANGES go back to STD Dren, then QA and review again; rework past `maxIterations` fails the task.
- Markers: a line starting with the marker word and a colon (markdown `**`, `#`, `>`, `_`, backticks ignored; case sensitive); a section runs to the next marker; the last occurrence wins. `PLAN:` steps become `task.subtasks`, `FINDINGS:` bullets `task.findings`.
- One active task per project (paused ones keep the slot); the rest wait by `PRIORITY_ORDER`, then age. Projects run in parallel. Task inputs share each agent's FIFO queue with my chat messages, and always run with the role's tools (chat only is for direct chat).
- Sessions: each task has its own Claude session per role (`task.sessions`); every step for the same agent in a task resumes it. Direct chat keeps `agent.claudeSessionId`; Reset session only resets that.
- Pauses (`blockedReason`, status "blocked"), each continued only by Resume (`resumeTask`): usage limit (`Usage limit, resets HH:MM`; no new step starts anywhere while `world.usage.limited`), "Stopped by you", the run's error line (turn cap included), "Server restarted" (a step that was queued or running), "Project archived" (restore does not resume), "<name> did not finish with <MARKER>" (after one reminder in the same session), and sONion Ring's question ("Waiting for your answer": answer with `answerTask`, Resume refuses). Resume sends `Continue where you left off. Finish with the required ending: ...` when the step already ran in its task session, else the step's full handoff again. "Waiting for your OK" is shown while a step's permission card is open and clears when answered.
- Cancel (`cancelTask`) stops the running step, removes the task's queued inputs and starts the next waiting task.
- Task log: when a task ends one line goes into the notes: `- Task "<title>" done: <SUMMARY line> (task log, YYYY-MM-DD)`, `failed: <reason>` or `cancelled`. If the summary never comes, the task still ends done with the review's first line.
- Handoffs are chat messages with `author { kind: "handoff", fromAgentId }` (the first one to sONion Ring and my answers are `{ kind: "user" }`, reminders `{ kind: "system" }`) and the task id; they emit `task.assigned` (agentId from, targetAgentId to), `agent.message` and a `CommLink` ("assign" forward, "report" for QA/review results back to STD Dren and the summary request).

## Machine constraints (Windows)

- Drive C: is full. Never write anything to C:. The project lives in `D:\3d-ai-agent`; npm uses `.npm-cache/` (project `.npmrc`); temp files go to `.tmp/` (`.claude/settings.local.json` sets TEMP, TMP, NODE_COMPILE_CACHE). When starting processes yourself, set those env vars too.
- Run `bd` with `BD_DISABLE_METRICS=1` and `BD_DISABLE_EVENT_FLUSH=1`, otherwise it writes to `C:\Users\ACER\.beads`. Both are set in `.claude/settings.json` and the `.beads/hooks`.
- Scripts must work on Windows: no bash-only syntax, no `&` backgrounding, no `export VAR=`.

## Commit messages

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`, `build:`, `ci:`, `style:`, optionally with a scope (`feat(server): ...`).
- Never mention a phase (no "Phase 2", "phase 3 work", etc.) anywhere in a commit message: subject or body.
- Short imperative subject; the body explains what changed and why.

## Protocol in one paragraph

First client message: `{ type: "hello", token }`. Then `{ type: "command", id, command: { name, args } }`. Server sends `{ type: "snapshot", snapshot }`, `{ type: "event", event }` and `{ type: "ack", id, ok, result | error }`. Chat history is not in the snapshot: use `getChatHistory` (`view: "chat"`, the default, for direct chat; `"tasks"` for an agent's task messages). Task commands: `submitTask` (returns the Task), `cancelTask`, `resumeTask`, `answerTask { taskId, text }`; they ack `ok:false` with the reason when the task is not in a state for it. When you add or change a command, update `CommandArgsMap`/`CommandResultMap` in `protocol.ts`, the schema in `schemas.ts` and the examples in `scripts/test.ts`; typecheck fails if the schema and type drift.

## Checks

    npm run typecheck   # tsc --noEmit, includes the schema/type sync checks
    npm run lint        # eslint src scripts server
    npm test            # domain, server, agent, project and pipeline tests (no Claude calls)
    npm run test:live   # one real Claude call (needs npm run claude:login once)
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
