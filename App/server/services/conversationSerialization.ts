import { AppDataSource } from "../db/datasource.js";
import type { Attachment } from "../db/entities/Attachment.js";
import type { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { contextUsagePercent } from "./agent/contextUsage.js";
import { lastChatModelChoice, type ThreadModelChoice } from "./conversationModels.js";
import { parseActions } from "./turnActions.js";
import { parseTurnActivitySummary } from "../../shared/chatActivity.js";
import { parseTurnThinking, type TurnThinking } from "../../shared/thinkingLevels.js";
import { attachmentsForMessages } from "./uploads.js";

/**
 * The wire shape of a direct conversation and its messages. Employee chat and
 * a Decision's own discussion serve the same rows, so both read them back
 * through these.
 */

/**
 * `lastModelId` is the brain this thread last ran a turn on, resolved by
 * `lastChatModelChoice`. The composer preselects it so reopening a past
 * conversation keeps talking to the same model instead of silently jumping to
 * whichever model happens to be active now; null means "use the active model".
 *
 * `effort` is the thread's thinking level, which the composer shows and the
 * next message resolves against its model; null is Default. `lastEffort` is
 * the level the newest turn was sent at, kept for clients from before the
 * level belonged to the thread.
 */
export function serializeConversation(
  c: Conversation,
  lastMessageAt: Date | null = null,
  lastChoice: ThreadModelChoice | null = null,
) {
  return {
    id: c.id,
    employeeId: c.employeeId,
    title: c.title,
    archivedAt: c.archivedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    lastMessageAt,
    lastModelId: lastChoice?.modelId ?? null,
    lastEffort: lastChoice?.effort ?? null,
    effort: c.effort ?? null,
    source: c.source ?? "web",
    connectionId: c.connectionId ?? null,
    memberBrowserId: c.memberBrowserId ?? null,
    discussedDecisionId: c.discussedDecisionId ?? null,
    legacyUnclaimed: c.ownerUserId === null && (c.source === "web" || c.source === "help"),
  };
}

type AttachmentSummary = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
};

export function summarizeAttachment(a: Attachment): AttachmentSummary {
  return {
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: Number(a.sizeBytes),
    isImage: a.mimeType.startsWith("image/"),
  };
}

/**
 * Project the persisted context gauge onto the wire.
 *
 * Null whenever the provider never reported a prompt count — legacy rows,
 * Telegram-authored replies, and any turn that failed before its first model
 * response all land here, and the client renders nothing rather than a
 * confident zero. The window may still be null on a row that has tokens: that
 * is the normal state for OpenAI subscription models, so `percent` is null too
 * and the UI shows the token count alone.
 */
function serializeContextUsage(m: ConversationMessage) {
  if (typeof m.contextTokens !== "number") return null;
  return {
    tokens: m.contextTokens,
    window: m.contextWindow,
    percent: contextUsagePercent(m.contextTokens, m.contextWindow),
  };
}

/**
 * A reply's thinking record. A reply from before levels were recorded shows
 * the level it was sent at, when it was sent at one, and nothing otherwise.
 */
function serializeTurnThinking(m: ConversationMessage): TurnThinking | null {
  const recorded = parseTurnThinking(m.thinkingJson);
  if (recorded) return recorded;
  return m.effort ? { level: m.effort, requested: m.effort, adjusted: null } : null;
}

export function serializeMessage(m: ConversationMessage, attachments: Attachment[] = []) {
  const progress =
    m.status === "working" &&
    typeof m.progressPercent === "number" &&
    m.progressPercent >= 1 &&
    m.progressPercent <= 99 &&
    !!m.progressLabel
      ? { percent: m.progressPercent, label: m.progressLabel }
      : null;
  return {
    id: m.id,
    conversationId: m.conversationId,
    role: m.role,
    content: m.content,
    status: m.status,
    progress,
    context: serializeContextUsage(m),
    // "Worked for 2m 14s · 9 steps": how the turn went, without its events,
    // which a reader loads only when it opens them.
    activity: m.role === "assistant" ? parseTurnActivitySummary(m.activityJson) : null,
    // "Thinking: High": the level the reply ran at, and why it moved if it did.
    thinking: m.role === "assistant" ? serializeTurnThinking(m) : null,
    actions: parseActions(m.actionsJson),
    attachments: attachments.map(summarizeAttachment),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
}

/** A conversation and its whole transcript, oldest first. */
export async function serializeConversationDetail(conversation: Conversation) {
  const messages = await AppDataSource.getRepository(ConversationMessage).find({
    where: { conversationId: conversation.id },
    order: { createdAt: "ASC" },
  });
  const attachmentsByMessage = await attachmentsForMessages(messages.map((m) => m.id));
  return {
    conversation: serializeConversation(
      conversation,
      conversation.updatedAt,
      await lastChatModelChoice(conversation.employeeId, conversation.id),
    ),
    messages: messages.map((m) => serializeMessage(m, attachmentsByMessage.get(m.id) ?? [])),
  };
}
