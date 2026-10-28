"use client";

// Shown until the first snapshot (at least 1.1 s, so the steps can be read).
// After 6 s without the server it says so; reconnecting keeps going behind it.

import { Bot, Check, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { cx } from "../ui.tsx";

const STEPS = ["Connecting to server", "Loading projects", "Waking up agents"];
const MIN_MS = 1100;
const UNREACHABLE_MS = 6000;
const FADE_MS = 400;

export function LoadingScreen() {
  const firstSnapshotAt = useWorldStore((s) => s.firstSnapshotAt);
  const [elapsed, setElapsed] = useState(0);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 100);
    return () => clearInterval(timer);
  }, []);

  const ready = firstSnapshotAt !== null && elapsed >= MIN_MS;
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => setGone(true), FADE_MS);
    return () => clearTimeout(timer);
  }, [ready]);

  if (gone) return null;
  // Each step ticks over after its share of the minimum time; the last waits for the snapshot.
  const stepMs = MIN_MS / STEPS.length;
  const done = (index: number) => (index < STEPS.length - 1 ? elapsed >= (index + 1) * stepMs : ready);
  const unreachable = firstSnapshotAt === null && elapsed >= UNREACHABLE_MS;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cx("absolute inset-0 z-50 flex items-center justify-center bg-ink-950 transition-opacity", ready ? "opacity-0" : "opacity-100")}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
      <div className="w-72 space-y-6">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-10 items-center justify-center rounded-xl bg-signal/15 text-signal">
            <Bot size={22} />
          </span>
          <div>
            <p className="font-semibold">AI Agent World</p>
            <p className="text-xs text-mist-500">Your Claude team is getting ready</p>
          </div>
        </div>
        <ul className="space-y-2.5">
          {STEPS.map((step, index) => {
            const isDone = done(index);
            const active = !isDone && (index === 0 || done(index - 1));
            return (
              <li key={step} className={cx("flex items-center gap-2.5 text-sm", isDone ? "text-mist-100" : active ? "text-mist-300" : "text-mist-500")}>
                <span className="inline-flex size-4 items-center justify-center">
                  {isDone ? <Check size={14} className="text-ok" /> : active ? <LoaderCircle size={14} className="animate-spin text-signal" /> : <span className="size-1.5 rounded-full bg-mist-500/50" />}
                </span>
                {step}
              </li>
            );
          })}
        </ul>
        {unreachable && (
          <p className="rounded-lg bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            Can&apos;t reach the server. Is <code className="font-mono">npm run dev</code> running? Still trying to connect…
          </p>
        )}
      </div>
    </div>
  );
}
