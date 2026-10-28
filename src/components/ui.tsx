"use client";

// Small building blocks: avatars, pills, badges, progress, segmented controls,
// two step confirm buttons, relative times and markdown.

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentState, AgentStatus } from "@/shared/domain/agentTypes.ts";
import { ROLE_DEFINITIONS } from "@/shared/domain/roles.ts";
import { clockTime, initials, relativeTime } from "@/shared/ui/present.ts";
import { useNow } from "./hooks.ts";

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ── Avatar ──

export function Avatar({ agent, size = 28, ring = false }: { agent: Pick<AgentState, "name" | "role">; size?: number; ring?: boolean }) {
  const color = ROLE_DEFINITIONS[agent.role].color;
  return (
    <span
      aria-hidden
      className={cx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-ink-950", ring && "ring-2 ring-ink-900")}
      style={{ width: size, height: size, background: color, fontSize: Math.max(9, Math.round(size * 0.38)) }}
    >
      {initials(agent.name)}
    </span>
  );
}

// ── Status ──

const STATUS: Record<AgentStatus, { label: string; tone: string; pulse: boolean }> = {
  idle: { label: "Idle", tone: "text-mist-500", pulse: false },
  thinking: { label: "Thinking", tone: "text-signal", pulse: true },
  working: { label: "Working", tone: "text-signal-strong", pulse: true },
  communicating: { label: "Replying", tone: "text-signal", pulse: true },
  waiting_user: { label: "Waiting for you", tone: "text-warn", pulse: true },
  waiting_permission: { label: "Needs your OK", tone: "text-warn", pulse: true },
  success: { label: "Done", tone: "text-ok", pulse: false },
  error: { label: "Error", tone: "text-bad", pulse: false },
  offline: { label: "Offline", tone: "text-mist-500", pulse: false },
};

export function statusLabel(status: AgentStatus): string {
  return STATUS[status].label;
}

export function StatusPill({ status }: { status: AgentStatus }) {
  const s = STATUS[status];
  return (
    <span className={cx("inline-flex items-center gap-1.5 rounded-full bg-ink-800/80 px-2 py-0.5 text-[11px] font-medium", s.tone)}>
      <span className={cx("size-1.5 rounded-full bg-current", s.pulse && "pulse-dot")} />
      {s.label}
    </span>
  );
}

export type BadgeTone = "neutral" | "signal" | "ok" | "warn" | "bad";

const BADGE: Record<BadgeTone, string> = {
  neutral: "bg-ink-700 text-mist-300",
  signal: "bg-signal/15 text-signal",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
};

export function Badge({ tone = "neutral", children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide", BADGE[tone])}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, color, label }: { value: number; color: string; label: string }) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700" role="progressbar" aria-label={label} aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${percent}%`, background: color }} />
    </div>
  );
}

// ── Controls ──

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "md",
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (value: T) => void;
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-ink-900/80 p-0.5 ring-1 ring-mist-500/15">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            "rounded-md font-medium transition-colors",
            size === "sm" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
            value === option.value ? "bg-ink-600 text-mist-100" : "text-mist-500 hover:text-mist-300",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A button that asks "Sure?" inline before acting. */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  disabled,
  className = "btn btn-sm btn-ghost",
  title,
}: {
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className={className} disabled={disabled} title={title} onClick={() => setAsking(true)}>
        {children}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        className="btn btn-sm btn-danger"
        autoFocus
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {confirmLabel}
      </button>
      <button type="button" className="btn btn-sm btn-quiet" onClick={() => setAsking(false)}>
        Cancel
      </button>
    </span>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  disabled,
  className,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx("inline-flex size-7 items-center justify-center rounded-md text-mist-500 transition-colors hover:bg-ink-700 hover:text-mist-100 disabled:opacity-40", className)}
    >
      {children}
    </button>
  );
}

// ── Time ──

export function RelativeTime({ at }: { at: number }) {
  const now = useNow();
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} suppressHydrationWarning>
      {relativeTime(at, now)}
    </time>
  );
}

export function ClockTime({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()} className="font-mono tabular-nums" suppressHydrationWarning>
      {clockTime(at)}
    </time>
  );
}

// ── Layout bits ──

export function Section({ title, aside, children }: { title: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-mist-500/20 px-3 py-4 text-center text-xs text-mist-500">{children}</p>;
}

export function ErrorLine({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <p role="alert" className="text-xs text-bad">
      {error}
    </p>
  );
}

// ── Markdown ──

function CodeBlock({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="group relative">
      <pre ref={ref} className="scroll-thin overflow-x-auto rounded-lg bg-ink-950/80 p-3 font-mono text-[11.5px] leading-relaxed ring-1 ring-mist-500/10">
        {children}
      </pre>
      <button
        type="button"
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        onClick={() => {
          const text = ref.current?.innerText ?? "";
          navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
        className="absolute right-1.5 top-1.5 inline-flex size-6 items-center justify-center rounded-md bg-ink-700/90 text-mist-300 opacity-0 transition-opacity hover:text-mist-100 focus:opacity-100 group-hover:opacity-100"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

/** Agent text: GitHub flavoured markdown, no raw HTML (react-markdown escapes it). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
