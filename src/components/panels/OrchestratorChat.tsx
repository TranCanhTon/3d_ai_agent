"use client";

// My chat with the orchestrator (sONion Ring), the only agent I talk to. Besides
// our normal chat it shows every task of the project as cards, in time order: my
// new task, his questions and brief (Start, Request changes, Cancel task), any
// agent's question during the task, my changes and his updated brief (Apply change,
// Request changes, Discard change), and how the task ended. Answers on a card go to
// the task, never to this chat's session.

import { Send } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ensureChatPage, getBackend, loadChatPage, openTask } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import type { RestartStep, Task, TaskAsk, TaskChange } from "@/shared/domain/taskTypes.ts";
import { canChange, clockTime, shortTaskId } from "@/shared/ui/present.ts";
import { chatKey, useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useAgent, useConnected, useProjectTasks } from "../hooks.ts";
import { Avatar, ConfirmButton, cx, Empty, ErrorLine, Markdown } from "../ui.tsx";
import { LoadOlder, MessageBubble, MessageList } from "./Messages.tsx";
import { ChangeBox } from "./TaskDetails.tsx";

const NO_MESSAGES: ChatMessage[] = [];

const STEP_NAME: Record<RestartStep, string> = {
  planning: "planning",
  research: "research",
  implementation: "implementation",
  testing: "testing",
};

type Item =
  | { kind: "message"; at: number; message: ChatMessage }
  | { kind: "task"; at: number; task: Task }
  | { kind: "ask"; at: number; task: Task; ask: TaskAsk; latest: boolean }
  | { kind: "change"; at: number; task: Task; change: TaskChange }
  | { kind: "end"; at: number; task: Task };

/** Chat messages and every task's cards, oldest first. */
function timeline(messages: readonly ChatMessage[], tasks: readonly Task[]): Item[] {
  const items: Item[] = messages.map((message) => ({ kind: "message", at: message.createdAt, message }));
  for (const task of tasks) {
    items.push({ kind: "task", at: task.createdAt, task });
    task.asks.forEach((ask, index) => items.push({ kind: "ask", at: ask.createdAt, task, ask, latest: index === task.asks.length - 1 }));
    for (const change of task.changes) items.push({ kind: "change", at: change.requestedAt, task, change });
    if (task.endReason !== null) items.push({ kind: "end", at: task.completedAt ?? task.updatedAt, task });
  }
  const order: Record<Item["kind"], number> = { message: 0, task: 0, change: 1, ask: 2, end: 3 };
  return items.sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind]);
}

function itemKey(item: Item): string {
  switch (item.kind) {
    case "message":
      return item.message.id;
    case "task":
      return `${item.task.id}:new`;
    case "ask":
      return item.ask.id;
    case "change":
      return item.change.id;
    case "end":
      return `${item.task.id}:end`;
  }
}

function TaskLink({ task }: { task: Task }) {
  return (
    <button type="button" className="flex min-w-0 items-center gap-2 text-left hover:underline" onClick={() => openTask(task.id)}>
      <span className="shrink-0 font-mono text-xs text-mist-500">{shortTaskId(task.id)}</span>
      <span className="truncate text-xs font-semibold text-signal">{task.title}</span>
    </button>
  );
}

/** My bubble: a new task, or a change to one. */
function MyTaskBubble({ task, label, text, detail, at }: { task: Task; label: string; text: string; detail?: string; at: number }) {
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[85%] space-y-1 rounded-xl bg-ink-700 px-3.5 py-2.5">
        <p className="text-xs text-mist-500">{label}</p>
        <p className="whitespace-pre-wrap break-words text-[14px] leading-[22px] text-mist-100">{text}</p>
        {detail !== undefined && detail !== "" && <p className="line-clamp-4 whitespace-pre-wrap text-[13px] leading-5 text-mist-300">{detail}</p>}
      </div>
      <span className="mt-1 text-xs text-mist-500">
        {shortTaskId(task.id)} · {clockTime(at)}
      </span>
    </div>
  );
}

function YouAsked({ text }: { text: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold uppercase tracking-wider text-mist-500">You asked</p>
      <p className="whitespace-pre-wrap text-[14px] leading-[22px] text-mist-300">{text}</p>
    </div>
  );
}

const KIND_LABEL: Record<TaskAsk["kind"], string> = { question: "Question", brief: "Brief", change: "Change" };

/** What happened to a card after I acted (or the task moved on). */
function outcomeLine(task: Task, ask: TaskAsk): string | null {
  const at = ask.closedAt === null ? "" : ` ${clockTime(ask.closedAt)}`;
  const change = task.changes.findLast((c) => c.requestedAt <= ask.createdAt);
  switch (ask.outcome) {
    case "open":
      return null;
    case "answered":
      return `You answered${at}`;
    case "started":
      return `Started${at}`;
    case "revised":
      return `You asked for changes${at}`;
    case "applied":
      return `Applied${at}: the team goes on from ${STEP_NAME[change?.restartFrom ?? ask.restartFrom ?? "planning"]}`;
    case "discarded":
      return `Discarded${at}: the team goes on as before`;
    case "cancelled":
      return "Cancelled";
    case "dropped":
      return change?.outcome === "failed" && change.detail !== null ? `Dropped: ${change.detail}` : "No longer needed";
  }
}

function AskCard({ task, ask, latest }: { task: Task; ask: TaskAsk; latest: boolean }) {
  const connected = useConnected();
  const asker = useAgent(ask.agentId);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [changing, setChanging] = useState(false);
  const open = ask.outcome === "open" && task.endReason === null;
  const change = task.changes.find((c) => c.outcome === "pending" || c.outcome === "approved");
  const applying = ask.kind === "change" && change?.outcome === "approved";
  const stepAgent = useAgent(task.assignedAgentId);
  const outcome = outcomeLine(task, ask);

  const act = (promise: Promise<unknown>, clear = true) => {
    setSending(true);
    setError(null);
    promise.then(
      () => {
        if (clear) setText("");
        setSending(false);
      },
      (e: unknown) => {
        setError(errorText(e));
        setSending(false);
      },
    );
  };
  const backend = getBackend();
  const reply = text.trim();

  return (
    <article
      className={cx("w-full space-y-3 rounded-xl border bg-ink-850 p-3.5", open ? "border-warn/40" : "border-[var(--hairline)]")}
      aria-label={`${KIND_LABEL[ask.kind]} for ${task.title}`}
    >
      <header className="flex items-center gap-2 border-b border-[var(--hairline)] pb-2">
        <TaskLink task={task} />
        <span className={cx("ml-auto shrink-0 text-xs font-medium", open ? "text-warn" : "text-mist-500")}>{KIND_LABEL[ask.kind]}</span>
      </header>

      {ask.kind === "question" && asker !== null && asker.role !== "orchestrator" && (
        <p className="flex items-center gap-2 text-[13px] font-semibold text-mist-100">
          <Avatar agent={asker} size={20} />
          {asker.name} asks
        </p>
      )}
      {ask.youAsked !== null && <YouAsked text={ask.youAsked} />}

      {ask.kind === "question" && (
        <div className="space-y-1">
          {ask.youAsked !== null && <p className="text-xs font-semibold uppercase tracking-wider text-mist-500">Questions</p>}
          <Markdown text={ask.text} />
        </div>
      )}
      {(ask.kind === "brief" || ask.kind === "change") && (
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-mist-500">{ask.kind === "brief" ? "Brief for the team" : "Updated brief"}</p>
          <div className="rounded-lg bg-ink-900 px-3 py-2">
            <Markdown text={ask.text} />
          </div>
          {ask.kind === "change" && ask.restartFrom !== null && (
            <p className="text-[13px] text-mist-300">
              Goes on from <span className="font-medium text-mist-100">{STEP_NAME[ask.restartFrom]}</span>
              {ask.restartWhy !== null && `: ${ask.restartWhy}`}
            </p>
          )}
        </div>
      )}

      {ask.reply !== null && !open && (
        <div className="flex justify-end">
          <p className="max-w-[85%] whitespace-pre-wrap rounded-xl bg-ink-700 px-3 py-2 text-[14px] leading-[22px] text-mist-100">{ask.reply}</p>
        </div>
      )}

      {open && applying && (
        <p className="rounded-lg bg-ink-800 px-3 py-2 text-[13px] text-mist-300">
          Applies when {stepAgent?.name ?? "the agent"} finishes the current step.
        </p>
      )}

      {open && !applying && (
        <div className="space-y-2">
          <textarea
            className="field min-h-16 resize-y"
            aria-label={ask.kind === "question" ? "Your answer" : "What to change"}
            placeholder={ask.kind === "question" ? "Your answer" : "Anything to change? (optional)"}
            maxLength={CONFIG.maxMessageChars}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (ask.kind === "question" && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && reply !== "") {
                e.preventDefault();
                act(backend.answerTask({ taskId: task.id, text: reply }));
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            {ask.kind === "question" && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!connected || sending || reply === ""}
                onClick={() => act(backend.answerTask({ taskId: task.id, text: reply }))}
              >
                <Send size={13} />
                Send answer
              </button>
            )}
            {ask.kind === "brief" && (
              <>
                <button type="button" className="btn btn-sm btn-primary" disabled={!connected || sending} onClick={() => act(backend.approveTask({ taskId: task.id }))}>
                  Start
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={!connected || sending || reply === ""} onClick={() => act(backend.reviseBrief({ taskId: task.id, text: reply }))}>
                  Request changes
                </button>
                <ConfirmButton className="btn btn-sm btn-quiet ml-auto" confirmLabel="Cancel task" disabled={!connected || sending} onConfirm={() => act(backend.cancelTask({ taskId: task.id }), false)}>
                  Cancel task
                </ConfirmButton>
              </>
            )}
            {ask.kind === "change" && (
              <>
                <button type="button" className="btn btn-sm btn-primary" disabled={!connected || sending} onClick={() => act(backend.applyChange({ taskId: task.id }))}>
                  Apply change
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={!connected || sending || reply === ""} onClick={() => act(backend.reviseBrief({ taskId: task.id, text: reply }))}>
                  Request changes
                </button>
                <button type="button" className="btn btn-sm btn-quiet ml-auto" disabled={!connected || sending} onClick={() => act(backend.discardChange({ taskId: task.id }))}>
                  Discard change
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {open && ask.lane === "change" && ask.kind === "question" && (
        <button type="button" className="btn btn-sm btn-quiet" disabled={!connected || sending} onClick={() => act(getBackend().discardChange({ taskId: task.id }))}>
          Discard change
        </button>
      )}

      {outcome !== null && <p className={cx("text-xs font-medium", ask.outcome === "cancelled" || ask.outcome === "dropped" ? "text-mist-500" : "text-ok")}>{outcome}</p>}

      {latest && canChange(task) && !changing && (
        <div className="flex items-center gap-2 border-t border-[var(--hairline)] pt-2.5">
          <span className="text-xs text-mist-500">{stepAgent === null ? "Running" : `${stepAgent.name} is working on it`}</span>
          <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={() => setChanging(true)}>
            Change task
          </button>
          <ConfirmButton className="btn btn-sm btn-quiet" confirmLabel="Cancel task" disabled={!connected} onConfirm={() => act(backend.cancelTask({ taskId: task.id }), false)}>
            Cancel task
          </ConfirmButton>
        </div>
      )}
      {changing && canChange(task) && <ChangeBox task={task} onClose={() => setChanging(false)} />}
      <ErrorLine error={error} />
    </article>
  );
}

function EndLine({ task }: { task: Task }) {
  const tone = task.endReason === "done" ? "text-ok" : "text-bad";
  const text =
    task.endReason === "done" ? `Done: ${task.summary ?? task.title}` : task.endReason === "failed" ? `Failed: ${task.summary ?? "the step failed"}` : "Cancelled";
  return (
    <div className="flex items-center gap-2 px-2 text-xs">
      <span className="h-px flex-1 bg-[var(--hairline)]" />
      <TaskLink task={task} />
      <span className={cx("max-w-[60%] truncate", tone)} title={text}>
        {text}
      </span>
      <span className="h-px flex-1 bg-[var(--hairline)]" />
    </div>
  );
}

function ChatInput({ agent }: { agent: AgentState }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connected = useConnected();
  const archived = useWorldStore((s) => s.snapshot?.projects.find((p) => p.id === agent.projectId)?.archived ?? false);
  const area = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = area.current;
    if (el === null) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = () => {
    const value = text.trim();
    if (value === "" || !connected || archived) return;
    setError(null);
    getBackend()
      .sendMessage({ agentId: agent.id, text: value })
      .then(
        () => setText(""),
        (e: unknown) => setError(errorText(e)),
      );
  };

  return (
    <div className="shrink-0 border-t border-[var(--hairline)] p-3">
      <div className="flex items-end gap-2">
        <textarea
          ref={area}
          rows={1}
          className="field scroll-thin max-h-40 resize-none"
          placeholder={archived ? "This project is archived" : `Message ${agent.name}`}
          aria-label={`Message ${agent.name}`}
          value={text}
          maxLength={CONFIG.maxMessageChars}
          disabled={archived}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button type="button" className="btn btn-primary !h-9 !px-3" aria-label="Send" disabled={!connected || archived || text.trim() === ""} onClick={send}>
          <Send size={14} />
        </button>
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

export function OrchestratorChat({ agent }: { agent: AgentState }) {
  const chatId = agent.activeChatId;
  const key = chatKey(agent.id, "chat", chatId);
  const messages = useWorldStore((s) => s.chats[key] ?? NO_MESSAGES);
  const page = useWorldStore((s) => s.chatPages[key]);
  const tasks = useProjectTasks();
  const connected = useConnected();

  useEffect(() => {
    if (connected) ensureChatPage(agent.id, "chat", chatId);
  }, [agent.id, chatId, connected]);

  const items = useMemo(() => timeline(messages, tasks), [messages, tasks]);
  const last = messages.at(-1);
  // Grows with new messages, cards and card changes.
  const contentKey = `${items.length}:${last?.id ?? ""}:${last?.text.length ?? 0}:${tasks.map((t) => t.asks.map((a) => a.outcome).join(",")).join("|")}`;

  return (
    <>
      <MessageList
        resetKey={key}
        contentKey={contentKey}
        top={page?.hasMore === true ? <LoadOlder onLoad={() => loadChatPage(agent.id, "chat", chatId, true)} /> : undefined}
      >
        {items.length === 0 && page?.loaded === true && (
          <Empty>
            Give the team a task with New task: {agent.name} confirms it with you here before anyone starts. Questions from any agent show up here too.
          </Empty>
        )}
        {items.map((item) => {
          switch (item.kind) {
            case "message":
              return <MessageBubble key={itemKey(item)} message={item.message} />;
            case "task":
              return <MyTaskBubble key={itemKey(item)} task={item.task} label="New task" text={item.task.title} detail={item.task.description} at={item.at} />;
            case "change":
              return (
                <div key={itemKey(item)} className="space-y-1">
                  <MyTaskBubble task={item.task} label={`Change to ${item.task.title}`} text={item.change.text} at={item.at} />
                  {item.change.outcome === "failed" && item.change.detail !== null && (
                    <p className="text-center text-xs text-bad">The change was dropped: {item.change.detail}</p>
                  )}
                </div>
              );
            case "ask":
              return <AskCard key={itemKey(item)} task={item.task} ask={item.ask} latest={item.latest} />;
            case "end":
              return <EndLine key={itemKey(item)} task={item.task} />;
          }
        })}
      </MessageList>
      <ChatInput agent={agent} />
    </>
  );
}
