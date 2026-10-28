// What the robots look like this frame, shared outside React: written by the
// AgentsLayer inside the canvas, read by the speech bubble overlay (DOM), the
// comm arcs and Locate. No three here, so the DOM side can import it.

import type { BubbleTone, RobotView } from "@/shared/domain/robotBrain.ts";

export interface RobotFrame {
  agentId: string;
  name: string;
  color: string;
  bubble: string;
  tone: BubbleTone;
  /** Floor position and heading now (after damping). */
  x: number;
  z: number;
  heading: number;
  /** Chest height now (sitting or standing). */
  chestY: number;
  /** The bubble anchor on screen (canvas pixels), its scale and distance; hidden off screen or under the UI. */
  screenX: number;
  screenY: number;
  scale: number;
  distance: number;
  visible: boolean;
}

/** By agent id, for the selected project's robots only. */
export const robotFrames = new Map<string, RobotFrame>();

/** The brain's latest views (the arcs read the links). */
export const robotViews: { list: RobotView[] } = { list: [] };

declare global {
  interface Window {
    /** ?debug=1 only: the robots' frames and views, for inspecting from the console. */
    __agentWorldRobots?: { frames: typeof robotFrames; views: typeof robotViews };
  }
}

if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "1") {
  window.__agentWorldRobots = { frames: robotFrames, views: robotViews };
}

/** Where the robot is now, or null when it is not in the office (another project). */
export function robotPositionNow(agentId: string): { x: number; z: number } | null {
  const frame = robotFrames.get(agentId);
  return frame === undefined ? null : { x: frame.x, z: frame.z };
}
