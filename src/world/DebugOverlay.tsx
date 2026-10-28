"use client";

// ?debug=1: fps, draw calls, triangles, textures and geometries in memory, and
// the quality with what set it. Hidden otherwise.

import { useSyncExternalStore } from "react";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { debugEnabled, getDebugStats, subscribeDebugStats } from "./debugStats.ts";

const noSubscribe = () => () => {};

export function DebugOverlay() {
  const enabled = useSyncExternalStore(noSubscribe, debugEnabled, () => false);
  const stats = useSyncExternalStore(subscribeDebugStats, getDebugStats, getDebugStats);
  const quality = useWorldStore((s) => s.quality);
  const source = useWorldStore((s) => s.qualitySource);
  const left = useWorldStore((s) => s.viewInsets.left);
  if (!enabled) return null;

  const rows: [string, string][] = [
    ["fps", String(stats.fps)],
    ["draw calls", String(stats.calls)],
    ["triangles", stats.triangles.toLocaleString("en-US")],
    ["textures", String(stats.textures)],
    ["geometries", String(stats.geometries)],
    ["quality", `${quality} (${source})`],
  ];
  return (
    <div className="surface pointer-events-none absolute bottom-3 z-10 rounded-lg px-3 py-2 font-mono text-[11px] leading-5 text-mist-300" style={{ left: left + 12 }} data-testid="debug-overlay">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-6">
          <span className="text-mist-500">{label}</span>
          <span className="tabular-nums text-mist-100">{value}</span>
        </div>
      ))}
    </div>
  );
}
