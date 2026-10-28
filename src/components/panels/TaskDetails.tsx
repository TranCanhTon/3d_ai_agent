"use client";

// One task as a progress view: what it is, how far it got, who is working, the
// workflow, the plan's checklist and the research findings. The conversation stays
// in each agent's Tasks view; questions, briefs and changes are cards in my chat
// with the orchestrator.

import { Check, Crosshair, Lightbulb, Pencil, Play } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { getBackend, openAgent } from "@/client/backendClient.ts";
import { CONFIG } from "@/shared/config.ts";
import type { AgentState } from "@/shared/domain/agentTypes.ts";
import { PAUSE, STEP_ROLE } from "@/shared/domain/handoff.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import type { Task } from "@/shared/domain/taskTypes.ts";
import { STATIONS } from "@/shared/domain/worldLayout.ts";
import { WORKFLOW_ROWS, workflowRowStates, type RowState, type WorkflowRow } from "@/shared/domain/workflow.ts";
import { canChange, canResume, hasOpenAsk, shortTaskId, waitsForMe } from "@/shared/ui/present.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { errorText, useAgent, useConnected, useOrchestrator, useProjectAgents } from "../hooks.ts";
import { modelSettingLabel } from "../ModelPicker.tsx";
import { Badge, cx, ErrorLine, ProgressBar } from "../ui.tsx";
import { PriorityTag, progressColor, toneOf } from "./TaskCard.tsx";

const ROW_LABEL: Record<WorkflowRow, string> = {
  intake: "Intake",
  planning: "Planning",
  research: "Research",
  implementation: "Implementation",
  testing: "Testing",
  review: "Code review",
  summary: "Done",
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-mist-500">{children}</h4>;
}

/** The description, three lines until I ask for more. */
function Description({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el !== null && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div>
      <p ref={ref} className={cx("whitespace-pre-wrap text-sm leading-[22px] text-mist-300", !open && "line-clamp-3")}>
        {text}
      </p>
      {(long || open) && (
        <button type="button" className="mt-1 text-xs font-medium text-signal hover:underline" onClick={() => setOpen(!open)}>
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function RowIcon({ state, color, bad }: { state: RowState; color: string; bad: boolean }) {
  if (state === "done") {
    return (
      <span className="inline-flex size-[18px] items-center justify-center rounded-full bg-ok/20 text-ok">
        <Check size={12} strokeWidth={3} />
      </span>
    );
  }
  if (state === "current") {
    return (
      <span className="inline-flex size-[18px] items-center justify-center rounded-full" style={{ boxShadow: `0 0 0 2px ${bad ? "var(--color-bad)" : color}` }}>
        <span className="size-2.5 rounded-full" style={{ background: bad ? "var(--color-bad)" : color }} />
      </span>
    );
  }
  return <span className="inline-flex size-[18px] rounded-full border-2 border-mist-500/30" />;
}

function WorkflowList({ task, agents }: { task: Task; agents: AgentState[] }) {
  const states = workflowRowStates(task);
  const waiting = waitsForMe(task);
  const ended = task.endReason !== null && task.endReason !== "done";
  return (
    <ol className="space-y-0.5" aria-label="Workflow">
      {WORKFLOW_ROWS.map((row) => {
        const state = states[row];
        const role = STEP_ROLE[row];
        const agent = agents.find((a) => a.role === role) ?? null;
        const color = ROLE_DEFINITIONS[role].color;
        const current = state === "current";
        const attempt = row === "implementation" && task.iteration > 1 && state !== "upcoming";
        return (
          <li
            key={row}
            aria-current={current ? "step" : undefined}
            className={cx("flex h-9 items-center gap-3 rounded-lg px-2.5", current && "bg-ink-800")}
          >
            <RowIcon state={state} color={color} bad={ended} />
            <span className={cx("text-sm", state === "upcoming" || state === "skipped" ? "text-mist-500" : "text-mist-100", current && "font-medium")}>
              {ROW_LABEL[row]}
            </span>
            {attempt && (
              <span className="text-xs text-warn">
                Attempt {task.iteration}/{CONFIG.maxIterations}
              </span>
            )}
            <span
              className={cx("ml-auto truncate text-xs", !current && "text-mist-500", current && waiting && "font-medium text-warn")}
              style={current && !waiting && !ended ? { color } : undefined}
              title={state === "skipped" ? "No research questions" : `${agent?.name ?? role}: ${modelSettingLabel(task.team[role])} for this task`}
            >
              {state === "skipped" ? "Skipped" : current && waiting && !ended ? "Waiting for you" : (agent?.name ?? role)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Checklist({ task, planner }: { task: Task; planner: string }) {
  if (task.subtasks.length === 0) {
    return <p className="text-sm text-mist-500">{planner} writes the steps after the brief is approved.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {task.subtasks.map((subtask) => (
        <li key={subtask.id} className="flex items-start gap-2.5 text-sm">
          <span
            className={cx(
              "mt-[3px] inline-flex size-4 shrink-0 items-center justify-center rounded",
              subtask.done ? "bg-ok/20 text-ok" : "border-2 border-mist-500/40",
            )}
            aria-label={subtask.done ? "Done" : "Not done"}
          >
            {subtask.done && <Check size={11} strokeWidth={3} />}
          </span>
          <span className={cx(subtask.done ? "text-mist-500 line-through" : "text-mist-100")}>{subtask.title}</span>
        </li>
      ))}
    </ul>
  );
}

/** Change task: what I want different goes to the orchestrator, who updates the brief in my chat. */
export function ChangeBox({ task, onClose }: { task: Task; onClose: () => void }) {
  const connected = useConnected();
  const orchestrator = useOrchestrator();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const send = () => {
    if (text.trim() === "") return;
    setSending(true);
    setError(null);
    getBackend()
      .changeTask({ taskId: task.id, text: text.trim() })
      .then(
        () => {
          onClose();
          if (orchestrator !== null) {
            useWorldStore.getState().setAgentView("chat");
            openAgent(orchestrator.id);
          }
        },
        (e: unknown) => {
          setError(errorText(e));
          setSending(false);
        },
      );
  };
  return (
    <div className="space-y-2 rounded-xl bg-ink-850 p-3 ring-1 ring-[var(--hairline)]">
      <p className="text-xs text-mist-300">
        What should change? {orchestrator?.name ?? "The orchestrator"} updates the brief; the current step finishes and the team waits for your OK.
      </p>
      <textarea
        className="field min-h-20 resize-y"
        autoFocus
        aria-label="What to change"
        placeholder="Put the toggle in the settings page instead"
        maxLength={CONFIG.maxMessageChars}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <ErrorLine error={error} />
        <button type="button" className="btn btn-sm btn-quiet ml-auto" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-sm btn-primary" disabled={!connected || sending || text.trim() === ""} onClick={send}>
          Send change
        </button>
      </div>
    </div>
  );
}

/** One highlighted line under the actions: why the task waits, with Resume when that applies. */
function StatusLine({ task }: { task: Task }) {
  const connected = useConnected();
  const orchestrator = useOrchestrator();
  const [error, setError] = useState<string | null>(null);
  let text: string | null = null;
  let tone: "warn" | "bad" | "ok" = "warn";
  if (task.endReason === "failed") [text, tone] = [`Failed: ${task.summary ?? "the step failed"}`, "bad"];
  else if (task.endReason === "cancelled") [text, tone] = ["Cancelled by you", "bad"];
  else if (task.endReason === "done") [text, tone] = [task.summary ?? "Done", "ok"];
  else if (hasOpenAsk(task)) text = `Waiting for you in the chat with ${orchestrator?.name ?? "the orchestrator"}`;
  else if (task.blockedReason === PAUSE.change) text = `${PAUSE.change}: ${orchestrator?.name ?? "the orchestrator"} is updating the brief`;
  else if (task.blockedReason !== null) text = canResume(task) ? `Paused: ${task.blockedReason}` : `${task.blockedReason}: answer the permission card to go on`;
  if (text === null) return null;
  const openChat = hasOpenAsk(task) && orchestrator !== null;
  return (
    <div
      className={cx(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium",
        tone === "warn" && "bg-warn/10 text-warn",
        tone === "bad" && "bg-bad/10 text-bad",
        tone === "ok" && "bg-ok/10 text-ok",
      )}
    >
      <span className="min-w-0 flex-1">{text}</span>
      {openChat && (
        <button
          type="button"
          className="btn btn-sm btn-quiet shrink-0"
          onClick={() => {
            useWorldStore.getState().setAgentView("chat");
            openAgent(orchestrator.id);
          }}
        >
          Open chat
        </button>
      )}
      {canResume(task) && (
        <button
          type="button"
          className="btn btn-sm btn-primary shrink-0"
          disabled={!connected}
          onClick={() => {
            setError(null);
            getBackend()
              .resumeTask({ taskId: task.id })
              .catch((e: unknown) => setError(errorText(e)));
          }}
        >
          <Play size={13} />
          Resume
        </button>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

export function TaskDetails({ task }: { task: Task }) {
  const agents = useProjectAgents();
  const working = useAgent(task.endReason === null ? task.assignedAgentId : null);
  const [changing, setChanging] = useState(false);
  const tone = toneOf(task);
  const color = progressColor(task, working === null ? null : ROLE_DEFINITIONS[working.role].color);
  const percent = Math.round(task.progress * 100);
  const researchShown = task.findings.length > 0 && workflowRowStates(task).research !== "skipped";
  const planner = agents.find((a) => a.role === "product_manager")?.name ?? "The product manager";

  const locate = () => {
    if (working === null) return;
    const { center } = STATIONS[ROLE_DEFINITIONS[working.role].homeStation];
    useWorldStore.getState().requestCamera({ pan: { x: center.x, y: 0, z: center.z } });
    useWorldStore.getState().setDeskHighlight(working.id);
  };

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-mist-500">{shortTaskId(task.id)}</span>
          <Badge tone={tone.badge}>{tone.label}</Badge>
          <span className="ml-auto">
            <PriorityTag priority={task.priority} />
          </span>
        </div>
        <h3 className="text-[17px] font-semibold leading-snug text-mist-100">{task.title}</h3>
        {task.description !== "" && <Description text={task.description} />}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <ProgressBar value={task.progress} color={color} label="Progress" />
          </div>
          <span className="w-9 text-right text-xs tabular-nums text-mist-300">{percent}%</span>
        </div>
        {(working !== null || canChange(task)) && (
          <div className="flex flex-wrap items-center gap-2">
            {working !== null && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={locate} title={`Show ${working.name}'s desk in the office`}>
                <Crosshair size={14} />
                Locate {working.name}
              </button>
            )}
            {canChange(task) && !changing && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setChanging(true)}>
                <Pencil size={13} />
                Change task
              </button>
            )}
          </div>
        )}
        {changing && canChange(task) && <ChangeBox task={task} onClose={() => setChanging(false)} />}
        <StatusLine task={task} />
      </div>

      <section>
        <SectionTitle>Workflow</SectionTitle>
        <WorkflowList task={task} agents={agents} />
      </section>

      <section>
        <SectionTitle>Task cards · {task.subtasks.length}</SectionTitle>
        <Checklist task={task} planner={planner} />
      </section>

      {researchShown && (
        <section>
          <SectionTitle>Research findings</SectionTitle>
          <ul className="space-y-2">
            {task.findings.map((finding) => (
              <li key={finding} className="flex items-start gap-2.5 text-sm text-mist-100">
                <Lightbulb size={15} className="mt-[3px] shrink-0 text-warn" />
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
