"use client";

// One task: status, the question box or Resume, the workflow, the plan and the
// team's work as one thread (my request, then each agent's reply in order).

import { Check, ChevronRight, CircleAlert, CircleCheck, CircleX, Play, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ensureChatPage, getBackend } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { ChatMessage } from "@/shared/domain/chatTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import type { Task, WorkflowSignal } from "@/shared/domain/taskTypes.ts";
import { canResume, workflowSteps, type StepState } from "@/shared/ui/present.ts";
import { chatKey, useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useAgent, useConnected, useProjectAgents } from "../hooks.ts";
import { Avatar, Badge, ClockTime, ConfirmButton, cx, Empty, ErrorLine, Markdown, ProgressBar, RelativeTime, Section } from "../ui.tsx";
import { MessageBubble } from "./Messages.tsx";
import { PriorityTag, progressColor, toneOf } from "./TaskCard.tsx";

const SIGNAL_LABEL: Record<WorkflowSignal, string> = {
  picked_up: "Picked up",
  delegated: "Brief handed to planning",
  plan_ready: "Plan ready",
  research_skipped: "No research needed",
  findings_published: "Findings published",
  submitted: "Changes submitted",
  tests_passed: "Tests passed",
  tests_failed: "Tests failed",
  approved: "Review approved",
  changes_requested: "Review asked for changes",
  abort: "Stopped",
};

const STEP_STYLE: Record<StepState, string> = {
  done: "bg-ok/15 text-ok ring-ok/30",
  current: "bg-signal/20 text-signal-strong ring-signal/60",
  skipped: "bg-ink-800 text-mist-500 ring-mist-500/15 line-through",
  pending: "bg-ink-800 text-mist-500 ring-mist-500/15",
  failed: "bg-bad/15 text-bad ring-bad/40",
};

function Workflow({ task }: { task: Task }) {
  const steps = workflowSteps(task);
  return (
    <ol className="flex flex-wrap items-center gap-1" aria-label="Workflow">
      {steps.map((step, index) => (
        <li key={step.phase} className="flex items-center gap-1">
          <span
            className={cx("rounded-md px-1.5 py-0.5 text-xs font-medium ring-1", STEP_STYLE[step.state])}
            aria-current={step.state === "current" ? "step" : undefined}
            title={step.state === "skipped" ? "Skipped: no research questions" : step.state}
          >
            {step.label}
          </span>
          {index < steps.length - 1 && <ChevronRight size={11} className="text-mist-500" aria-hidden />}
        </li>
      ))}
    </ol>
  );
}

function QuestionBox({ task }: { task: Task }) {
  const connected = useConnected();
  // The step's agent asked (any agent may, not only sONion Ring).
  const asker = useAgent(task.assignedAgentId);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = () => {
    if (answer.trim() === "") return;
    setSending(true);
    setError(null);
    getBackend()
      .answerTask({ taskId: task.id, text: answer.trim() })
      .then(
        () => setAnswer(""),
        (e: unknown) => setError(errorText(e)),
      )
      .finally(() => setSending(false));
  };
  return (
    <div className="space-y-2 rounded-xl bg-warn/10 p-3 ring-1 ring-warn/40">
      <p className="flex items-center gap-2 text-[13px] font-semibold text-warn">
        {asker !== null && <Avatar agent={asker} size={20} />}
        {asker === null ? "A question for you" : `${asker.name} asks you`}
      </p>
      <Markdown text={task.question ?? ""} />
      <textarea
        className="field min-h-16 resize-y"
        placeholder="Your answer"
        aria-label="Your answer"
        value={answer}
        maxLength={CONFIG.maxMessageChars}
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex items-center justify-between gap-2">
        <ErrorLine error={error} />
        <button type="button" className="btn btn-sm btn-primary ml-auto" disabled={!connected || sending || answer.trim() === ""} onClick={send}>
          <Send size={13} />
          Send
        </button>
      </div>
    </div>
  );
}

const NO_MESSAGES: ChatMessage[] = [];

const ANSWER_HEADING = "Answer to your question:\n";

/** My answer as I typed it, out of the text the pipeline sends (null for the intake handoff). */
function myAnswer(message: ChatMessage): ChatMessage | null {
  const start = message.text.indexOf(ANSWER_HEADING);
  if (start === -1) return null;
  const rest = message.text.slice(start + ANSWER_HEADING.length);
  const end = rest.lastIndexOf("\n\nNow ");
  return { ...message, text: (end === -1 ? rest : rest.slice(0, end)).trim() };
}

/**
 * The task as one thread: every agent's replies and tool lines and my answers,
 * oldest first. Handoffs are left out (they repeat the reply they pass on), and so
 * is the intake text (the request is shown above).
 */
function TaskThread({ task }: { task: Task }) {
  const agents = useProjectAgents();
  const connected = useConnected();
  const lists = useWorldStore(useShallow((s) => agents.map((a) => s.chats[chatKey(a.id, "tasks")] ?? NO_MESSAGES)));

  useEffect(() => {
    if (connected) for (const agent of agents) ensureChatPage(agent.id, "tasks", null);
  }, [agents, connected]);

  const messages = useMemo(
    () =>
      lists
        .flat()
        .filter((m) => m.taskId === task.id && m.author.kind !== "handoff")
        .flatMap((m) => (m.author.kind === "user" ? (myAnswer(m) ?? []) : [m]))
        .sort((a, b) => a.createdAt - b.createdAt),
    [lists, task.id],
  );

  if (messages.length === 0) return <Empty>The team has not started on this task yet.</Empty>;
  return (
    <div className="space-y-1.5">
      {messages.map((message, index) => {
        const previous = messages[index - 1];
        // A name above each agent's turn (its tool lines and reply); 16px between turns, 6px inside one.
        const mine = message.author.kind === "user";
        const newTurn = previous === undefined || previous.agentId !== message.agentId || mine !== (previous.author.kind === "user");
        return (
          <div key={message.id} className={cx(newTurn && index > 0 && "pt-2.5")}>
            {newTurn && !mine && <Speaker agentId={message.agentId} />}
            <MessageBubble message={message} />
          </div>
        );
      })}
    </div>
  );
}

function Speaker({ agentId }: { agentId: string }) {
  const agent = useAgent(agentId);
  if (agent === null) return null;
  return (
    <span className="mb-1 flex items-center gap-2 text-[13px] font-semibold text-mist-100">
      <Avatar agent={agent} size={20} />
      {agent.name}
      <span className="font-normal text-mist-500">{ROLE_DEFINITIONS[agent.role].roleLabel}</span>
    </span>
  );
}

export function TaskDetails({ task }: { task: Task }) {
  const connected = useConnected();
  const agent = useAgent(task.assignedAgentId);
  const [error, setError] = useState<string | null>(null);
  const tone = toneOf(task);
  const ended = task.endReason !== null;
  const run = (promise: Promise<unknown>) => {
    setError(null);
    promise.catch((e: unknown) => setError(errorText(e)));
  };

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Badge tone={tone.badge}>{tone.label}</Badge>
          <PriorityTag priority={task.priority} />
          {task.iteration > 0 && (
            <span className={cx("text-xs", task.iteration > 1 ? "text-warn" : "text-mist-500")}>
              Attempt {task.iteration}/{CONFIG.maxIterations}
            </span>
          )}
          <span className="ml-auto text-xs text-mist-500">
            created <RelativeTime at={task.createdAt} />
          </span>
        </div>
        <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
        {task.description !== "" && <p className="whitespace-pre-wrap text-xs leading-relaxed text-mist-300">{task.description}</p>}
        <ProgressBar value={task.progress} color={progressColor(task, agent === null ? null : ROLE_DEFINITIONS[agent.role].color)} label="Progress" />
        {agent !== null && !ended && task.blockedReason === null && (
          <p className="flex items-center gap-2 text-xs text-mist-300">
            <Avatar agent={agent} size={18} />
            {agent.name} · {agent.activity || "working"}
          </p>
        )}
      </header>

      {task.endReason === "done" && (
        <div className="flex gap-2 rounded-xl bg-ok/10 p-3 text-xs ring-1 ring-ok/30">
          <CircleCheck size={16} className="shrink-0 text-ok" />
          <div className="space-y-1">
            <p className="font-medium text-ok">Done{task.completedAt !== null && <> · <RelativeTime at={task.completedAt} /></>}</p>
            {task.summary !== null && <p className="text-mist-100">{task.summary}</p>}
          </div>
        </div>
      )}
      {(task.endReason === "failed" || task.endReason === "cancelled") && (
        <div className="flex gap-2 rounded-xl bg-bad/10 p-3 text-xs ring-1 ring-bad/30">
          <CircleX size={16} className="shrink-0 text-bad" />
          <p className="font-medium text-bad">
            {task.endReason === "cancelled" ? "Cancelled by you" : `Failed${task.summary !== null ? `: ${task.summary}` : ""}`}
          </p>
        </div>
      )}

      {task.question !== null && !ended && <QuestionBox task={task} />}

      {task.blockedReason !== null && task.question === null && !ended && (
        <div className="flex items-start gap-2 rounded-xl bg-warn/10 p-3 ring-1 ring-warn/30">
          <CircleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-xs font-medium text-warn">
              {canResume(task) ? `Paused: ${task.blockedReason}` : `${task.blockedReason}: answer the permission card to go on`}
            </p>
            {canResume(task) && (
              <button type="button" className="btn btn-sm btn-primary" disabled={!connected} onClick={() => run(getBackend().resumeTask({ taskId: task.id }))}>
                <Play size={13} />
                Resume
              </button>
            )}
          </div>
        </div>
      )}

      {!ended && (
        <div className="flex items-center gap-2">
          <ConfirmButton confirmLabel="Cancel task" disabled={!connected} onConfirm={() => run(getBackend().cancelTask({ taskId: task.id }))}>
            Cancel task…
          </ConfirmButton>
          <ErrorLine error={error} />
        </div>
      )}

      <Section title="Workflow">
        <Workflow task={task} />
      </Section>

      {task.subtasks.length > 0 && (
        <Section title={`Plan · ${task.subtasks.length}`}>
          <ol className="space-y-1">
            {task.subtasks.map((subtask, index) => (
              <li key={subtask.id} className="flex gap-2 text-xs">
                <span className={cx("mt-px inline-flex size-4 shrink-0 items-center justify-center rounded text-xs", subtask.done ? "bg-ok/20 text-ok" : "bg-ink-700 text-mist-500")}>
                  {subtask.done ? <Check size={11} /> : index + 1}
                </span>
                <span className="text-mist-300">{subtask.title}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}

      {task.findings.length > 0 && (
        <Section title="Research findings">
          <ul className="list-disc space-y-1 pl-4 text-xs text-mist-300">
            {task.findings.map((finding) => (
              <li key={finding}>{finding}</li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Team thread">
        <TaskThread task={task} />
      </Section>

      {task.history.length > 0 && (
        <Section title="Timeline">
          <ol className="space-y-1.5 border-l border-mist-500/15 pl-3">
            {task.history.map((transition, index) => (
              <li key={`${transition.at}-${index}`} className="relative text-xs">
                <span className="absolute -left-[15px] top-1.5 size-1.5 rounded-full bg-mist-500" />
                <span className="text-mist-500">
                  <ClockTime at={transition.at} />
                </span>{" "}
                <span className="text-mist-300">{SIGNAL_LABEL[transition.signal]}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
    </div>
  );
}

