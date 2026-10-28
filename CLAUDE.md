# AI Agent World

A local app for managing teams of real Claude agents. Each project is a code folder with a team of six agents (Orchestrator, Product Manager, Researcher, Software Engineer, QA Engineer, Code Reviewer), each a Claude Agent SDK session running on the user's Claude Pro plan. The app is task-first: the user gives the team a task (New task, with each agent's model and effort for that task), sONion Ring (the orchestrator, the only agent the user talks to) confirms it in his chat (questions, then a brief the user starts), and the server runs it through a fixed pipeline of handoffs (PM → Researcher → Engineer → QA → Reviewer, with rework loops). Any agent may ask the user a question; it shows as a card in the chat with sONion Ring. The user can change a running task there too. Direct chat exists only with sONion Ring in the UI (the server keeps it for every agent). A 3D office (later phases) shows robots doing what each agent is actually doing. Built in 9 phases; `reference/ai-agent-world.md` is a related simulated design used for conventions only (do not modify it, do not build its simulation engine).

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
- `server/` Node WebSocket server run with tsx: `startServer.ts` (loopback bind, Origin check, token hello, 1 MB payload, ping, coalesced snapshots), `commands.ts`, `world/World.ts` (in-memory state + events), `agents/AgentManager.ts` (per-agent queue and run lifecycle, chats, model settings, chat only, task inputs and the `TaskHooks` the pipeline implements), `pipeline/Pipeline.ts` (tasks, the waiting line, steps, pauses, resume, cancel, task log), `agents/AgentRunner.ts` (runner interface; `EchoRunner.ts` is the fake runner for tests and `AGENT_RUNNER=echo`; `ScriptedRunner.ts` is the fake team for `npm run dev:scripted`). Imports `src/shared` with relative `.ts` paths.
- `src/app/api/session-token/route.ts` gives the browser the token the server writes to `data/session-token` (loopback Host only).
- `src/client/` `WebSocketAgentBackend.ts` (AgentBackend over WebSocket, acks, timeouts, reconnect) and `backendClient.ts` (singleton + store wiring, and the helpers components use: `loadChatPage`/`ensureChatPage`, `openAgent`, `openTask`). Components call backend commands only, never the WebSocket.
- `src/state/useWorldStore.ts` Zustand mirror: connection, throttled snapshot (pitfall 7), messages per `chatKey` (`agentId#tasks` for an agent's task messages; `agentId@chatId` for direct chat, unused by the UI) with their page state, recent events; plus UI state: selected project (remembered in localStorage), agent and task, side tab (default Tasks), panel collapsed, dialog, `viewInsets` (what the UI covers, for the 3D camera), the permission flash, quality, `sceneReady`, hover, the camera request (`{ overview }` or `{ focus }`) and `deskHighlight`.
- `src/components/` the app UI (desktop, 1280px and up, usable from 1024px; dark only):
  - Everything is solid (no blur, nothing of the office shows through): `.surface` is `ink-900` with a hairline border, text is 12px or larger, `mist-500` passes 4.5:1 on ink-900/800/700, spacing tokens `--space-1..6` (4px scale).
  - `layout/` `AppShell` (the office fills the window; NavRail flush left, TopBar across the top, SidePanel flush right at full height; measures them into `viewInsets`; shortcuts N new task, Esc closes the dialog, clears the selection and sends the camera to the overview), `NavRail` (Tasks, Agents, Overview, Activity, Notes, Settings with labels; a badge on Tasks when a task needs me; clicking the open tab hides the panel), `TopBar` (project menu, a "Scripted runner"/"Echo runner" chip for the fakes, metrics Agents · Active · Pending · Complete shown by a container query when there is room, permission badge, connection dot, New task; the usage limit is only in Settings), `ProjectMenu` (switch, archived group with Restore, New project, Archive with inline confirm), `LoadingScreen` (connection steps plus "Building the office", at least 1.1s, "Can't reach the server" after 6s).
  - `panels/` `SidePanel` (440px) and its tabs: `TasksPanel` → `TaskCard`, `TaskDetails` (a progress view only: short id, status, priority, title, description with Show more, the step-based progress bar, Locate <agent> (pans to the desk at the current zoom), Change task, one highlighted status line with Resume or Open chat, the workflow rows with the agent per row ("Waiting for you", "Skipped", "Attempt 2/3", model and effort on hover), the plan checklist (TASK CARDS) and research findings; no messages), `AgentsPanel` (six avatars with working/waiting dots, a warn dot on the orchestrator while a card waits, the chosen agent's name, Stop, the shared `ModelPicker` for its chat setting; the orchestrator has Chat · Tasks (`agentView` in the store), everyone else only `TaskMessagesView`: the agent's own replies and tool lines grouped by task, handoffs and other inputs hidden), `OrchestratorChat` (my chat with sONion Ring plus every task in time order: my new task and change bubbles, the cards (question: answer box; brief: Start, Request changes, Cancel task; change: Apply change, Request changes, Discard change; read only with a result line once handled), Change task and Cancel task on a running task's latest card, an end line per task, and the normal chat input), `Messages` (my messages in a bubble, agent replies as plain markdown, tool rows, pin editor, usage on hover, a list that sticks to the bottom with a "New messages" pill), `OverviewPanel` (callout, roster, current task, latest activity), `ActivityPanel` (feed filters), `NotesPanel` (notes by kind, Add note), `SettingsPanel` (Rendering, then read only: connection, usage limit, team, rules).
  - The only direct chat is with the orchestrator; everything any agent needs from me comes through it as a card.
  - `ModelPicker.tsx` the "Opus · High" menu (agent header, and the Team columns plus Set all in `NewTaskDialog`; the dialog starts from each agent's chat setting and locks them on the task).
  - `permissions/PermissionStack.tsx` solid cards (360px) in the top right of the free area for every project (3 visible, "N more"), details with the full command or an Edit old → new preview, Allow and Deny.
  - `dialogs/` `Modal`, `NewTaskDialog`, `NewProjectDialog` (folder browser).
  - `ui.tsx` (Avatar, StatusPill, Badge (sentence case), ProgressBar, Segmented, ConfirmButton, IconButton, RelativeTime, ClockTime, Section, Empty, ErrorLine, Markdown with react-markdown + remark-gfm, no raw HTML, code blocks with a copy button) and `hooks.ts` (selectors, the shared 30s clock).
- `src/world/` the 3D office (@react-three/fiber 9 + drei 10, three r186): `WorldCanvas.tsx` (loaded with next/dynamic, no SSR, never remounted; `shadows`/`dpr` follow quality; PerformanceMonitor falls back to low unless `?quality=` forced it; `ReadySignal` sets `sceneReady` for the loading screen's "Building the office"), `OfficeEnvironment.tsx`, `Workstations.tsx` (instanced furniture, name plates and the wall screen as canvas textures), `Lighting.tsx` (an evening skyline outside, a lit office inside: moonlight with the only shadow map, a bright hemisphere and ambient fill, a light from straight above for the ceiling panels, warm non-shadow lights over the desks, hub, shared places and walkway; the reflection map is prefiltered once with PMREMGenerator, not drei's Environment, which leaked a texture per quality switch; free-area luminance at the overview is about 0.36 high / 0.33 low), `CameraController.tsx` (no rotation ever: a fixed 35° look toward the back wall; left or right drag pans like a map, the wheel zooms, both damped and clamped by `cameraView.ts`; a view offset centres the target in the free area; requests go to the overview or an agent's desk, and selecting an agent anywhere focuses its desk), `InteractionManager.tsx` (hit boxes, 5 px click tolerance, floor outline = `deskHighlight`), `sharedResources.ts` (pooled geometries, materials, cached canvas textures), `DebugOverlay.tsx` (`?debug=1`: fps, draw calls, triangles, textures, geometries, quality). Never use drei `<Html>`; no binary assets; read the store with `getState()` inside `useFrame`. `react-hooks/immutability` is off for this folder (three objects are mutated by design).
- `src/shared/domain/worldLayout.ts` floor plan (stations, slots, partitions, plants, `slotFor`, `route`, `pathLength`); `src/shared/ui/cameraView.ts` the camera math (pure, tested): `floorOffset` (where a screen pixel looks at the floor), `zoomRange` (closest: a desk is a third of the free width; furthest: the free area's bottom edge spans the floor), `clampTarget` (the bottom corners stay on the floor, the target in front of the back wall), `overview` (furthest zoom, centred; the app opens there). Quality (`quality`, `qualitySource`) lives in the store and in Settings → Rendering; settings in `CONFIG.world`.
- `src/shared/ui/present.ts` pure view helpers tested in `scripts/test.ts`: task groups, order and filters, `taskNeedsMe`/`canResume`, the workflow stepper, relative times, token formatting, notes line parsing, permission previews, activity filters, initials.
- `server/agents/claude/` the real agents: `ClaudeRunner.ts` (Claude Agent SDK `query()`, billing guard, env, recordings, role prompt, tool list), `translate.ts` (pure SDK message → action mapping), `toolSummary.ts` (tool call descriptions), `notesTool.ts` (the in-process `agentworld` tool server with `add_note`). `server/agents/PermissionBroker.ts` turns "ask" verdicts into permission cards and waits for `respondPermission`. `server/sandbox.ts` prepares `config.sandboxRoot`.
- `server/projects/` `folders.ts` (folder browser and project folder rules, all on real paths), `notes.ts` (`.agentworld/notes.md`, the `.gitignore` entry), `ProjectService.ts` (create, archive, restore, notes, pins).
- `server/store/` `DataStore.ts` JSON persistence under `dataDir`: `projects.json`, `agents/<projectId>.json` (session id, chat only, queued inputs), `chats/<agentId with : → _>.jsonl` (append only; the latest line per message id wins, `{ deletedId }` removes one), `tasks/<projectId>.json` (each task plus the pipeline's step state). Whole files are written atomically (`files.ts`). Loaded once on start by `World.load()`.
- `server/roles/` the role prompt files (`shared.md` + one per role) and `rolePrompts.ts`. Read at the start of every run and appended to Claude Code's own prompt.
- `scripts/test.ts` pure domain tests; `scripts/test-server.ts` server integration tests; `scripts/test-agents.ts` translator, broker, billing guard, role prompts, add_note and ClaudeRunner with a fake SDK (tsx); `scripts/test-projects.ts` folder rules, projects, notes and persistence across a server restart; `scripts/test-pipeline.ts` the pipeline with a scripted fake runner per role (happy path, skips, rework, pauses, cancel, line order, restart, model at step start) and one full task with `ScriptedRunner`. Tests use folders under `.tmp/`, never `data/` or `D:\agent-sandbox`. `npm test` never calls Claude. `npm run test:live` makes one real call (with a throwaway data folder).

## Claude agents

- Agents run on the Claude subscription only. The billing guard refuses to start with ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX set, strips every inherited CLAUDE*/ANTHROPIC* variable, and aborts a run whose init reports API key billing.
- The agents' Claude Code login, sessions and settings live in `config.claudeConfigDir` (`D:\3d-ai-agent\.claude-home`, git-ignored). Log in once with `npm run claude:login` (pick "Claude account with subscription").
- Every tool call goes through `explainPermission` in a PreToolUse hook ("ask" forces `canUseTool` → PermissionBroker card). Never use the SDK's `allowedTools` (it auto-approves) or a bypass permission mode.
- Permissions (`permissions.ts`, lists in `config.git` and `config.shell`): Read/Grep/Glob/Web*/add_note allow, Edit/Write ask. Bash (engineer, qa, reviewer) allows look around (`ls`, `cat`, `echo`...), search (`grep`, `rg`, `find` without `-exec`/`-delete`...), exact version checks, read-only git (`status diff log show blame`, listing `branch`) and project checks (`npm test`, `npm run typecheck|lint|build`, `tsc --noEmit`). Denied for everyone: blocked git patterns, recursive deletes (`rm -r`, `rd /s`, `Remove-Item -Recurse`...), `sudo su doas shutdown reboot format mkfs diskpart`, a download piped into a shell. Engineer commits with no card, pushes with a card; others may not. Everything else asks. The reviewer only gets look around, search, versions and git read: anything else is denied, never asked. Redirects, `$(...)`, backticks and unclear quoting are at least "ask"; duplicating or closing a descriptor (`2>&1`, `>&2`, `2>&-`) writes no file and is not a redirect.
- The only tool server is our in-process `agentworld` server (`add_note`, seen by Claude as `mcp__agentworld__add_note`; `canonicalToolName` maps it back). No other MCP servers, claude.ai connectors or skills are loaded (`strictMcpConfig`, `disableClaudeAiConnectors`, `skills: []`): the connectors add ~300k tokens per run.
- Role prompt (`buildRolePrompt`): role file + `shared.md` + the team notes (`Team notes (.agentworld/notes.md):` and the file without its header, or `Team notes: none yet.`; over `notesPromptMaxChars` only the newest lines that fit, after `(Older notes are in .agentworld/notes.md.)`) + `Project folder: <root>` (+ the chat only line). Chat only prompts get the notes too.
- System prompt: `{ type: "preset", preset: "claude_code", append: <role prompt>, snapshot: false }`. `snapshot: false` matters: a recorded prompt would ignore prompt edits and the chat only switch in resumed sessions.
- Chat only agents run with `tools: []`, no tool server, and an empty allowed tool list in the permission rules.
- Model and effort are per agent (`AgentState.model`, `effort`; null effort = the model's default, no `effort` option sent). New agents get `config.roleModelDefaults` (engineer opus/high, reviewer opus/medium, the rest sonnet); saved agents without them load with the role default. `setAgentModel { agentId, model, effort }` (model one of `config.models`, effort one of `config.effortLevels` or null) takes effect from the agent's next run, chat or task step (a step reads it when it starts), and emits `agent.settings_changed`. `AgentState.lastRun` is what actually ran: the model from the init message, the effort from hook inputs (`effort.level`, after Claude Code's silent downgrades; PreToolUse plus a read-only Stop hook). SDK init messages carry no effort.
- Raw SDK messages are recorded to `data/recordings/<agent>/<YYYYMMDD-HHmmss>.jsonl`.

## Task pipeline

- A task starts only from the New task form (`submitTask`). Server code (`Pipeline.ts` with `workflow.ts` and `handoff.ts`) decides every handoff; no agent picks who goes next. The pipeline never commits or pushes.
- Confirmation: `submitTask` starts intake at once (it does not take the project's slot; it waits only in sONion Ring's own queue). His reply must start with `YOU ASKED:` and end with `QUESTION:` (numbered, as many rounds as he needs) or `BRIEF:`. A brief moves the task to `awaiting_approval` (signal `brief_ready`); `approveTask` (Start) locks it as `task.approvedBrief` and puts the task in the waiting line (`approved_by_user` → `queued`); `reviseBrief` (Request changes) sends my text back to his task session (`brief_changes_requested` → `intake`). Planning starts from the waiting line (`picked_up`) with exactly the approved brief, and every later handoff carries it.
- Cards: `task.asks` (kind question/brief/change, lane task/change, the asker, YOU ASKED, the text, RESTART FROM, outcome open/answered/started/revised/applied/discarded/cancelled/dropped, my reply). The UI renders them in the chat with the orchestrator; `taskNeedsMe` counts open ones for the Tasks badge.
- Questions: every step but the summary may end with `QUESTION:` instead of its ending (whichever marker comes last wins; each handoff says so with `ASK_LINE`). The task pauses with "Waiting for your answer" on the agent that asked (`assignedAgentId`), and `answerTask` sends my answer to that agent in its task session with the step's ending (`answerHandoff`). One question per step run (`questionAnswered`, reset at each step start, so a rework attempt may ask again); intake has no limit.
- Changes: `changeTask` (planning to review, not during the summary, one at a time: `task.changes`) sends my text with the approved brief, plan, latest CHANGES, verdicts and current step to sONion Ring's task session in a side lane (`SavedTask.side`) while the step keeps running (`change_requested`). The step finishes normally; its reply is held (`SavedTask.held`, "Waiting for your OK on a change"). He answers `YOU ASKED:` + `QUESTION:` or a full `BRIEF:` + `RESTART FROM: planning|research|implementation|testing - why` (anything else counts as missing: one reminder, then the change is dropped and the held reply goes on). `applyChange` replaces the approved brief and goes on from the restart step with attempt 1 (`change_applied`; pressed while the step runs, it applies when the step ends; a paused task resumes); a restart later than the held step (or one without what it needs: testing needs CHANGES) hands the held reply on with the new brief instead. The first handoff after it starts with `Ton changed the task:` (`config.userName`). `discardChange` hands the held reply on (`change_discarded`). `reviseBrief` on an open change card asks him again. The task log line adds `(N change(s) applied)`.
- Checklist: STD Dren ends with `STEPS DONE: 1, 2` (unknown numbers ignored, kept in `task.claimedSteps` across attempts); they tick only when QA passes an attempt. A new plan replaces the checklist.
- Team: `task.team` is each role's model and effort from New task; every run of the task (intake included) uses it (`TaskHooks.modelFor`); the agents' own chat settings never change a task.
- Progress: `taskProgress` in `workflow.ts`: seven rows (intake … done), each an equal share, the current one half, skipped research counts as done.
- Steps: intake (sONion Ring, ends `YOU ASKED:` + `BRIEF:`) → planning (Pronelio Maximus, `PLAN:` + `RESEARCH QUESTIONS:`) → research (Drater, `FINDINGS:`; skipped when the questions are none/empty) → implementation (STD Dren, `CHANGES:` + `HOW TO TEST:`, plus `STEPS DONE:`) → testing (Quantarino, last `VERDICT:` PASS/FAIL) → review (Rabies, last `VERDICT:` APPROVED/CHANGES) → summary (sONion Ring, `SUMMARY:`, while the phase is still review; `approved` is applied when it arrives). QA FAIL or review CHANGES go back to STD Dren, then QA and review again; rework past `maxIterations` fails the task.
- Markers: a line starting with the marker word and a colon (markdown `**`, `#`, `>`, `_`, backticks ignored; case sensitive); a section runs to the next marker; the last occurrence wins. `PLAN:` steps become `task.subtasks`, `FINDINGS:` bullets `task.findings`.
- One active task per project from planning to the end of review (`holdsSlot`; paused ones keep the slot); intake and awaiting_approval never hold it; started tasks wait by `PRIORITY_ORDER`, then age. Projects run in parallel. Task inputs share each agent's FIFO queue with my chat messages, and always run with the role's tools (chat only is for direct chat).
- Sessions: each task has its own Claude session per role (`task.sessions`); every step for the same agent in a task resumes it. Direct chat is split into chats (see Chats); a new chat never touches task sessions.
- Pauses (`blockedReason`, status "blocked"), each continued only by Resume (`resumeTask`): usage limit (`Usage limit, resets HH:MM`; no new step starts anywhere while `world.usage.limited`), "Stopped by you", the run's error line (turn cap included), "Server restarted" (a step that was queued or running), "Project archived" (restore does not resume), "<name> did not finish with <MARKER>" (after one reminder in the same session), a step's question ("Waiting for your answer": answer with `answerTask`, Resume refuses), and a held change ("Waiting for your OK on a change": apply or discard, Resume refuses; after a restart a held reply waits for Resume). Resume sends `Continue where you left off. Finish with the required ending: ...` when the step already ran in its task session, else the step's full handoff again. "Waiting for your OK" is shown while a step's permission card is open and clears when answered.
- Cancel (`cancelTask`, any time, a pending change included) stops the running inputs (the step and sONion Ring's change), removes the task's queued inputs, closes open cards and starts the next waiting task.
- Task log: when a task ends one line goes into the notes: `- Task "<title>" done: <SUMMARY line> (task log, YYYY-MM-DD)`, `failed: <reason>` or `cancelled`. If the summary never comes, the task still ends done with the review's first line.
- Handoffs are chat messages with `author { kind: "handoff", fromAgentId }` (the first one to sONion Ring and my answers are `{ kind: "user" }`, reminders `{ kind: "system" }`) and the task id; they emit `task.assigned` (agentId from, targetAgentId to), `agent.message` and a `CommLink` ("assign" forward, "report" for QA/review results back to STD Dren and the summary request).

## Chats

- In the UI only with the orchestrator (`OrchestratorChat`, the active chat, no chat list); the commands, sessions and stored chats remain for every agent.
- My direct chat with an agent is a list of chats (`Chat` in `chatTypes.ts`), like chats in a Claude project: each has its own Claude session (`chat.claudeSessionId`), and all of them share the project folder and the team notes. `AgentState.activeChatId` is where my messages go. Task messages have `chatId: null`.
- `newChat { agentId }` starts a new chat and makes it active (returns the active chat unchanged while it is empty; allowed while busy, a running input keeps its chat). `openChat { agentId, chatId }` makes an earlier chat active; the next message resumes its session. `listChats { agentId }` is newest first (by last message). `sendMessage` takes an optional `chatId` (it becomes active); `getChatHistory` an optional `chatId` (default the active chat).
- A chat's title is my first message in it (one line, `chatTitleMaxChars`); `messageCount` counts my messages and the replies; `contextTokens` is the latest run's prompt tokens (the UI suggests a new chat above `longChatTokens`). Events: `chat.started` (feed) and `chat.updated`, both with `{ chat }`.
- Saved in `agents/<projectId>.json` (`chats`, `activeChatId`); count and last message time are rebuilt from the messages on load. Files from before chats: the agent's old `claudeSessionId` becomes its first chat and messages without `chatId` belong to it.

## Scripted runner

- `npm run dev:scripted` starts the server with `--runner=scripted` (a CLI flag rather than an env var, so it works on every shell; `--runner=` beats `AGENT_RUNNER`, which beats `config.agentRunner`). The top bar shows "Scripted runner · no Claude calls".
- It saves to `config.scriptedDataDir` (`.tmp/scripted-data`), never `data/`, and its first-start Sandbox is `config.scriptedSandboxRoot` (`D:\agent-sandbox-scripted`), never the real Sandbox, so fake replies and task log lines never mix with real chats, tasks and notes. A project you create in scripted mode is a real folder: scripted tasks do write their task log line to its notes.
- Each role answers its handoff with the right ending after a short think, a few tool lines and streamed text (`config.scripted` timings). Every build step makes one Write that goes through the PermissionBroker, so a real card appears; an allowed Write writes nothing. sONion Ring asks one round of two questions when the description is under 40 characters, then writes a brief (at once for longer ones); a change gets an updated brief with `RESTART FROM: implementation`. Pronelio writes a 5 step plan, Drater 3 findings, STD Dren reports `STEPS DONE: 1, 2, 3` on attempt 1 and `4, 5` on attempt 2, and QA fails attempt 1. Direct chat gets a short canned markdown reply.

## Machine constraints (Windows)

- Drive C: is full. Never write anything to C:. The project lives in `D:\3d-ai-agent`; npm uses `.npm-cache/` (project `.npmrc`); temp files go to `.tmp/` (`.claude/settings.local.json` sets TEMP, TMP, NODE_COMPILE_CACHE). When starting processes yourself, set those env vars too.
- Run `bd` with `BD_DISABLE_METRICS=1` and `BD_DISABLE_EVENT_FLUSH=1`, otherwise it writes to `C:\Users\ACER\.beads`. Both are set in `.claude/settings.json` and the `.beads/hooks`.
- Scripts must work on Windows: no bash-only syntax, no `&` backgrounding, no `export VAR=`.
- `npm run dev` gives `tsx watch` its stdin from `NUL`: concurrently hands each command a stdin pipe, and with a pipe tsx watch's own stdin reading stalls the server child on Windows (it never reaches listen). The cost: Return no longer restarts the server, and tsx watch exits when the server exits.

## Commit messages

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `perf:`, `build:`, `ci:`, `style:`, optionally with a scope (`feat(server): ...`).
- Never mention a phase (no "Phase 2", "phase 3 work", etc.) anywhere in a commit message: subject or body.
- Short imperative subject; the body explains what changed and why.

## Protocol in one paragraph

First client message: `{ type: "hello", token }`. Then `{ type: "command", id, command: { name, args } }`. Server sends `{ type: "snapshot", snapshot }`, `{ type: "event", event }` and `{ type: "ack", id, ok, result | error }`. Chat history is not in the snapshot: use `getChatHistory` (`view: "chat"`, the default, for direct chat; `"tasks"` for an agent's task messages). Notes: `getNotes`, `pinToNotes { messageId, text }` (`pinned by you`), `addNote { projectId, text }` (`you`). Task commands: `submitTask { projectId, title, description?, priority?, team }` (returns the Task), `cancelTask`, `resumeTask`, `answerTask { taskId, text }` (the open question card, any lane), `approveTask`, `reviseBrief { taskId, text }` (brief or change card), `changeTask { taskId, text }`, `applyChange`, `discardChange`; they ack `ok:false` with the reason when the task is not in a state for it. When you add or change a command, update `CommandArgsMap`/`CommandResultMap` in `protocol.ts`, the schema in `schemas.ts` and the examples in `scripts/test.ts`; typecheck fails if the schema and type drift.

## Checks

    npm run typecheck   # tsc --noEmit, includes the schema/type sync checks
    npm run lint        # eslint src scripts server
    npm test            # domain, server, agent, project and pipeline tests (no Claude calls)
    npm run test:live   # one real Claude call (needs npm run claude:login once)
    npm run dev         # web (http://localhost:3000) + server (ws://127.0.0.1:4317)
    npm run dev:web     # or run them in two terminals
    npm run dev:server
    npm run dev:scripted  # web + server with the scripted fake team (no Claude calls, own data in .tmp/scripted-data)

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
