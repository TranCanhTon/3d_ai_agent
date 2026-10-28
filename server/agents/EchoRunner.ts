// Temporary fake agent: echoes the input word by word. Replaced in phase 3.

import { CONFIG } from "../../src/shared/config.ts";
import type { AgentRunCallbacks, AgentRunInput, AgentRunner } from "./AgentRunner.ts";

export class EchoRunner implements AgentRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly agentName: string;
  private readonly timing: { thinkMs: number; wordMs: number };

  constructor(agentName: string, timing: { thinkMs: number; wordMs: number } = CONFIG.echo) {
    this.agentName = agentName;
    this.timing = timing;
  }

  run(input: AgentRunInput, callbacks: AgentRunCallbacks): void {
    this.stop();
    const fullText = `Echo from ${this.agentName}: ${input.text}`;
    const words = fullText.split(/(?<=\s)/);
    let index = 0;

    callbacks.onStatus("thinking", "Reading your message");
    const step = () => {
      const word = words[index++];
      if (word === undefined) {
        this.timer = null;
        callbacks.onComplete(fullText);
        return;
      }
      callbacks.onDelta(word);
      this.timer = setTimeout(step, this.timing.wordMs);
    };
    this.timer = setTimeout(() => {
      callbacks.onStatus("communicating", "Typing...");
      step();
    }, this.timing.thinkMs);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
