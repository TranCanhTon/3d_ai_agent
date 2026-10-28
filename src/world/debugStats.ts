// Renderer numbers for the ?debug=1 overlay: written by DebugProbe inside the
// canvas, read by DebugOverlay in the DOM.

export interface DebugStats {
  fps: number;
  calls: number;
  triangles: number;
  textures: number;
  geometries: number;
}

let stats: DebugStats = { fps: 0, calls: 0, triangles: 0, textures: 0, geometries: 0 };
const listeners = new Set<() => void>();

export function debugEnabled(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1";
}

export function publishDebugStats(next: DebugStats): void {
  stats = next;
  for (const listener of listeners) listener();
}

export function subscribeDebugStats(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getDebugStats(): DebugStats {
  return stats;
}
