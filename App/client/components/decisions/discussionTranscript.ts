import type { ChatProgress, ConversationMessage } from "../../lib/api";

/**
 * Transcript bookkeeping for a Decision's inline discussion, kept free of
 * React so the rules below are tested on their own.
 */

/** An employee reply that is still being written, here or in another tab. */
export function isWorkingMessage(message: ConversationMessage): boolean {
  return message.role === "assistant" && message.status === "working";
}

/** Replace a message by id, or append it when it is new. */
export function upsertMessage(
  messages: ConversationMessage[],
  incoming: ConversationMessage,
): ConversationMessage[] {
  const index = messages.findIndex((message) => message.id === incoming.id);
  if (index === -1) return [...messages, incoming];
  const next = [...messages];
  next[index] = incoming;
  return next;
}

/**
 * Take the server's transcript without letting a response that left before a
 * reply finished turn that reply back into a spinner. Two reads can cross,
 * and a finished message never becomes unfinished again.
 */
export function mergeTranscript(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
): ConversationMessage[] {
  const settled = new Map(
    current.filter((message) => !isWorkingMessage(message)).map((message) => [message.id, message]),
  );
  return incoming.map((message) =>
    isWorkingMessage(message) ? (settled.get(message.id) ?? message) : message,
  );
}

/** A live progress event, or null when it is not one the reply can show. */
export function parseProgress(data: unknown): ChatProgress | null {
  const candidate = data as Partial<ChatProgress> | null;
  if (
    typeof candidate?.percent !== "number" ||
    !Number.isInteger(candidate.percent) ||
    candidate.percent < 1 ||
    candidate.percent > 99 ||
    typeof candidate.label !== "string" ||
    !candidate.label.trim()
  ) {
    return null;
  }
  return { percent: candidate.percent, label: candidate.label.trim() };
}
