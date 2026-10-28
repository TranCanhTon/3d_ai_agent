"use client";

// "Opus · High" with a small menu for the model and effort: the agent's own
// setting in the Agents tab, and each agent's setting for one task in New task.

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CONFIG, type ModelSetting } from "@/shared/config.ts";
import type { EffortLevel } from "@/shared/domain/agentTypes.ts";
import { cx } from "./ui.tsx";

/** "Opus · High", "Sonnet · Default". */
export function modelSettingLabel(setting: ModelSetting): string {
  const model = CONFIG.models.find((m) => m.id === setting.model)?.label ?? setting.model;
  const effort = setting.effort === null ? "Default" : setting.effort.charAt(0).toUpperCase() + setting.effort.slice(1);
  return `${model} · ${effort}`;
}

export function ModelPicker({
  value,
  onChange,
  disabled = false,
  note,
  children,
  align = "right",
  up = false,
  buttonClassName = "btn btn-sm btn-quiet",
  ariaLabel,
}: {
  value: ModelSetting;
  onChange: (setting: ModelSetting) => void;
  disabled?: boolean;
  /** A line under the selects. */
  note?: ReactNode;
  /** The button's content (default: the label and a chevron). */
  children?: ReactNode;
  align?: "left" | "right" | "center";
  /** Open above the button (inside a scrolling dialog, where below would be cut off). */
  up?: boolean;
  buttonClassName?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (root.current !== null && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={buttonClassName}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {children ?? (
          <>
            {modelSettingLabel(value)}
            <ChevronDown size={13} className={cx("transition-transform", open && "rotate-180")} />
          </>
        )}
      </button>
      {open && (
        <div
          className={cx(
            "surface absolute z-30 w-56 space-y-3 rounded-xl p-3 text-left shadow-lg shadow-black/40",
            up ? "bottom-full mb-1" : "top-full mt-1",
            align === "right" ? "right-0" : align === "left" ? "left-0" : "left-1/2 -translate-x-1/2",
          )}
          role="dialog"
          aria-label="Model and effort"
        >
          <label className="block space-y-1 text-xs text-mist-300">
            Model
            <select className="field" value={value.model} onChange={(e) => onChange({ model: e.target.value, effort: value.effort })}>
              {CONFIG.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1 text-xs text-mist-300">
            Effort
            <select
              className="field"
              value={value.effort ?? ""}
              onChange={(e) => onChange({ model: value.model, effort: e.target.value === "" ? null : (e.target.value as EffortLevel) })}
            >
              <option value="">Default</option>
              {CONFIG.effortLevels.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
          {note !== undefined && <div className="text-xs text-mist-500">{note}</div>}
        </div>
      )}
    </div>
  );
}
