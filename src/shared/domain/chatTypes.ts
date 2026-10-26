// Chat history is not part of the snapshot: it is fetched with getChatHistory
// and new messages arrive as chat.* events.

/** `tool` lines are the small "Read src/app.ts" entries a run produces between text. */
export type ChatAuthor =
  | { kind: "user" }
  | { kind: "agent" }
  | { kind: "handoff"; fromAgentId: string }
  | { kind: "tool"; toolName: string }
  | { kind: "system" };

export interface TokenUsage {
  /** Prompt tokens including cache reads and writes. */
  inputTokens: number;
  outputTokens: number;
}

export const CHAT_MESSAGE_STATUSES = ["queued", "delivered", "streaming", "complete", "error"] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

export interface ChatMessage {
  id: string;
  projectId: string;
  /** The agent whose conversation this message belongs to. */
  agentId: string;
  author: ChatAuthor;
  text: string;
  taskId: string | null;
  pinned: boolean;
  status: ChatMessageStatus;
  createdAt: number;
  /** Tokens used by the run, on the last agent reply of that run. */
  usage?: TokenUsage;
}
