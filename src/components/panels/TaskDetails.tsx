"use client";

import { Check, ChevronRight, CircleAlert, CircleCheck, CircleX, Play, Send } from "lucide-react";
import { useState } from "react";
import { getBackend } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import { AGENT_ROLES, ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import type { Task, WorkflowSignal } from "@/shared/domain/taskTypes.ts";
import { canResume, workflowSteps, type StepState } from "@/shared/ui/present.ts";
import { errorText, useAgent, useConnected } from "../hooks.ts";
import { Avatar, Badge, ClockTime, ConfirmButton, cx, ErrorLine, Markdown, ProgressBar, RelativeTime, Section } from "../ui.tsx";
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
            className={cx("rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1", STEP_STYLE[step.state])}
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
      <p className="eyebrow !text-warn">Needs your answer</p>
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

function AgentOutputs({ task }: { task: Task }) {
  const [open, setOpen] = useState<string | null>(null);
  const roles = AGENT_ROLES.filter((role) => task.outputs[role] !== undefined);
  if (roles.length === 0) return null;
  return (
    <Section title="Agent outputs">
      <div className="space-y-1.5">
        {roles.map((role) => {
          const expanded = open === role;
          return (
            <div key={role} className="well rounded-lg">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(expanded ? null : role)}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs"
              >
                <ChevronRight size={13} className={cx("text-mist-500 transition-transform", expanded && "rotate-90")} />
                <OutputAuthor taskProject={task.projectId} role={role} />
              </button>
              {expanded && (
                <div className="border-t border-mist-500/10 px-3 py-2.5">
                  <Markdown text={task.outputs[role] ?? ""} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function OutputAuthor({ taskProject, role }: { taskProject: string; role: (typeof AGENT_ROLES)[number] }) {
  const agent = useAgent(`${taskProject}:${role}`);
  return (
    <span className="flex items-center gap-2">
      {agent !== null && <Avatar agent={agent} size={18} />}
      <span className="font-medium">{agent?.name ?? ROLE_DEFINITIONS[role].name}</span>
      <span className="text-mist-500">{ROLE_DEFINITIONS[role].roleLabel}</span>
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
            <span className={cx("text-[11px]", task.iteration > 1 ? "text-warn" : "text-mist-500")}>
              Attempt {task.iteration}/{CONFIG.maxIterations}
            </span>
          )}
          <span className="ml-auto text-[11px] text-mist-500">
            created <RelativeTime at={task.createdAt} />
          </span>
        </div>
        <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
        {task.description !== "" && <p className="whitespace-pre-wrap text-xs leading-relaxed text-mist-300">{task.description}</p>}
        <ProgressBar value={task.progress} color={progressColor(task, agent === null ? null : ROLE_DEFINITIONS[agent.role].color)} label="Progress" />
        {agent !== null && !ended && (
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
                <span className={cx("mt-px inline-flex size-4 shrink-0 items-center justify-center rounded text-[10px]", subtask.done ? "bg-ok/20 text-ok" : "bg-ink-700 text-mist-500")}>
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

      <AgentOutputs task={task} />

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

