"use client";

// Speech bubbles over the robots: a DOM overlay above the canvas (never drei
// <Html>). React renders one bubble per agent of the selected project; a single
// requestAnimationFrame loop moves them to the anchors the AgentsLayer projects
// each frame (robotFrames), scales them by distance, stacks closer ones on top
// and cross fades text changes. Bubbles under the UI or off screen are hidden.

import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { CONFIG } from "@/shared/config.ts";
import type { BubbleTone } from "@/shared/domain/robotBrain.ts";
import { ROLE_DEFINITIONS, type AgentRole } from "@/shared/domain/roles.ts";
import { useWorldStore } from "@/state/useWorldStore.ts";
import { robotFrames } from "./robots/robotFrame.ts";

const TONE_BORDER: Record<BubbleTone, string> = {
  normal: "var(--hairline)",
  needs: "var(--color-warn)",
  success: "var(--color-ok)",
  error: "var(--color-warn)",
};

/** Cut to `max` characters with an ellipsis. */
export function bubbleText(text: string, max = CONFIG.world.robots.bubbleMaxChars): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

interface BubbleNodes {
  root: HTMLDivElement;
  texts: [HTMLSpanElement, HTMLSpanElement];
  /** Which of the two text spans shows now, and its text. */
  front: 0 | 1;
  text: string;
  tone: BubbleTone | null;
  /** Unscaled width, measured when the text changes. */
  width: number;
}

export function SpeechBubbles() {
  const agents = useWorldStore(
    useShallow((s) => s.snapshot?.agents.filter((a) => a.projectId === s.selectedProjectId).map((a) => `${a.id}|${a.name}|${a.role}`) ?? []),
  );
  const nodes = useRef(new Map<string, BubbleNodes>());

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const { selectedAgentId: selected, viewInsets } = useWorldStore.getState();
      const viewWidth = window.innerWidth;
      // Closer robots draw on top; the selected one above all.
      const order = [...robotFrames.values()].sort((a, b) => b.distance - a.distance).map((f) => f.agentId);
      for (const [agentId, bubble] of nodes.current) {
        const robot = robotFrames.get(agentId);
        if (robot === undefined || !robot.visible) {
          bubble.root.style.visibility = "hidden";
          continue;
        }
        const isSelected = agentId === selected;
        bubble.root.style.visibility = "visible";
        // The whole pill stays in the free area (never under the side panel or the rail).
        const half = (bubble.width * robot.scale) / 2;
        const x = Math.min(Math.max(robot.screenX, viewInsets.left + half + 4), viewWidth - viewInsets.right - half - 4);
        bubble.root.style.transform = `translate3d(${x.toFixed(1)}px, ${robot.screenY.toFixed(1)}px, 0) translate(-50%, -100%) scale(${robot.scale.toFixed(3)})`;
        bubble.root.style.zIndex = String(isSelected ? 100 : order.indexOf(agentId) + 1);
        bubble.root.style.opacity = isSelected ? "1" : "0.9";
        if (bubble.tone !== robot.tone) {
          bubble.tone = robot.tone;
          bubble.root.style.borderColor = TONE_BORDER[robot.tone];
        }
        const text = bubbleText(robot.bubble);
        if (text !== bubble.text) {
          // Cross fade: the back span takes the new text and fades in over the front one.
          bubble.text = text;
          const back = bubble.texts[bubble.front === 0 ? 1 : 0];
          const front = bubble.texts[bubble.front];
          back.textContent = text;
          back.style.opacity = "1";
          front.style.opacity = "0";
          bubble.front = bubble.front === 0 ? 1 : 0;
          bubble.width = bubble.root.offsetWidth;
        }
      }
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {agents.map((entry) => {
        const [agentId, name, role] = entry.split("|") as [string, string, AgentRole];
        return (
          <div
            key={agentId}
            ref={(root) => {
              if (root === null) {
                nodes.current.delete(agentId);
                return;
              }
              const texts = root.querySelectorAll<HTMLSpanElement>("[data-bubble-text]");
              nodes.current.set(agentId, { root, texts: [texts[0]!, texts[1]!], front: 0, text: "", tone: null, width: 0 });
            }}
            className="absolute left-0 top-0 flex origin-bottom items-center gap-1.5 whitespace-nowrap rounded-full border bg-ink-800 text-xs leading-4 text-mist-100"
            style={{ visibility: "hidden", padding: "6px 10px", borderColor: TONE_BORDER.normal, willChange: "transform" }}
          >
            <span className="size-2 shrink-0 rounded-full" style={{ background: ROLE_DEFINITIONS[role].color }} />
            <span className="font-semibold">{name}</span>
            <span className="relative inline-grid text-mist-300">
              <span data-bubble-text className="col-start-1 row-start-1 transition-opacity duration-150" />
              <span data-bubble-text className="col-start-1 row-start-1 transition-opacity duration-150" style={{ opacity: 0 }} />
            </span>
          </div>
        );
      })}
    </div>
  );
}

