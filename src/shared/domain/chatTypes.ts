// Chat history is not part of the snapshot: it is fetched with getChatHistory
// and new messages arrive as chat.* events.
//
// My direct chat with an agent is split into chats, like chats in a Claude
// project: each has its own Claude session, and all of them share the project
// folder and the team notes. Task messages belong to no chat.

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
  /** The chat this message belongs to; null for task messages. */
  chatId: string | null;
  pinned: boolean;
  status: ChatMessageStatus;
  createdAt: number;
  /** Tokens used by the run, on the last agent reply of that run. */
  usage?: TokenUsage;
}

/** One of my chats with an agent. */
export interface Chat {
  id: string;
  projectId: string;
  agentId: string;
  /** From my first message in it; "" while the chat is empty. */
  title: string;
  /** The chat's Claude session, null until its first run. */
  claudeSessionId: string | null;
  createdAt: number;
  /** Time of the latest message (createdAt while empty). */
  updatedAt: number;
  /** My messages and the agent's replies (not tool or system lines). */
  messageCount: number;
  /** Prompt tokens of the latest run: how big the conversation has become. null before the first reply. */
  contextTokens: number | null;
}
