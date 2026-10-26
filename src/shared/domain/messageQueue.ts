// Pure per-agent input queue. An agent handles one input at a time; while it is
// busy, new inputs (my chat messages or pipeline handoffs) wait in FIFO order.
// Stopping an agent ends the current input only (finishCurrent); the queue stays.

export interface AgentInput {
  /** The chat message id this input delivers. Every input is a chat message. */
  id: string;
  source: "user" | "handoff";
  text: string;
  taskId: string | null;
  /** Set for handoffs. */
  fromAgentId: string | null;
  enqueuedAt: number;
}

export interface MessageQueue {
  readonly current: AgentInput | null;
  readonly queued: readonly AgentInput[];
}

export const EMPTY_QUEUE: MessageQueue = { current: null, queued: [] };

export function isBusy(queue: MessageQueue): boolean {
  return queue.current !== null;
}

/** Always appends; call startNext afterwards to begin it if the agent is idle. */
export function enqueue(queue: MessageQueue, input: AgentInput): MessageQueue {
  return { current: queue.current, queued: [...queue.queued, input] };
}

/** Moves the oldest queued input to current. No-op while busy or when nothing is queued. */
export function startNext(queue: MessageQueue): MessageQueue {
  const [next, ...rest] = queue.queued;
  if (queue.current !== null || next === undefined) return queue;
  return { current: next, queued: rest };
}

export function finishCurrent(queue: MessageQueue): MessageQueue {
  if (queue.current === null) return queue;
  return { current: null, queued: queue.queued };
}

/** Removes a waiting input. The current input cannot be cancelled this way (use stop). */
export function cancelQueued(queue: MessageQueue, inputId: string): MessageQueue {
  if (!queue.queued.some((item) => item.id === inputId)) return queue;
  return { current: queue.current, queued: queue.queued.filter((item) => item.id !== inputId) };
}

export function peek(queue: MessageQueue): AgentInput | null {
  return queue.queued[0] ?? null;
}
