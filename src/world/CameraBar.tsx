"use client";

// Camera presets as a floating pill at the bottom centre of the free area.

import { CAMERA_PRESET_IDS, CAMERA_PRESETS } from "@/shared/ui/cameraPresets.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { cx } from "@/components/ui.tsx";

export function CameraBar() {
  const active = useWorldStore((s) => s.activePreset);
  const left = useWorldStore((s) => s.viewInsets.left);
  const right = useWorldStore((s) => s.viewInsets.right);
  const ready = useWorldStore((s) => s.sceneReady);
  if (!ready) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 z-10 flex justify-center" style={{ left, right }}>
      <div role="toolbar" aria-label="Camera" className="surface pointer-events-auto flex gap-0.5 rounded-full p-1">
        {CAMERA_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={active === id}
            onClick={() => useWorldStore.getState().requestCamera({ preset: id })}
            className={cx(
              "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              active === id ? "bg-signal/20 text-signal-strong" : "text-mist-500 hover:bg-ink-600/60 hover:text-mist-100",
            )}
          >
            {CAMERA_PRESETS[id].label}
          </button>
        ))}
      </div>
    </div>
  );
}
