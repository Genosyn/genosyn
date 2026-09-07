import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { withSerializedTransaction } from "../db/transactions.js";
import { Attachment } from "../db/entities/Attachment.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { claimMemberChatAttachments, serializeChatAttachment } from "./memberChatAttachments.js";
import {
  attachmentImageContextForMessages,
  historicalAttachmentSummaries,
  inlineAttachmentsForMessage,
} from "./attachmentText.js";
import { buildTodoMentionTurn } from "./todoMentionTurn.js";
import { resolveAttachmentFile } from "./uploads.js";
import type { ChatTurn } from "./chat.js";

/** Persist the Member's files with the discussion comment that owns them. */
export async function createTodoDiscussionComment(args: {
  companyId: string;
  todoId: string;
  userId: string | null;
  body: string;
  attachmentIds?: string[];
  mentionEmployeeId?: string | null;
}) {
  if (!args.body.trim() && !args.attachmentIds?.length)
    throw new Error("Write a comment or attach a file.");
  return withSerializedTransaction(async (manager) => {
    const repo = manager.getRepository(TodoComment);
    const human = await repo.save(
      repo.create({
        todoId: args.todoId,
        authorUserId: args.userId,
        authorEmployeeId: null,
        body: args.body,
        pending: false,
      }),
    );
    await claimMemberChatAttachments(
      args.companyId,
      args.userId,
      args.attachmentIds ?? [],
      human.id,
      manager,
    );
    const pending = args.mentionEmployeeId
      ? await repo.save(
          repo.create({
            todoId: args.todoId,
            authorUserId: null,
            authorEmployeeId: args.mentionEmployeeId,
            body: "",
            pending: true,
          }),
        )
      : null;
    return { human, pending };
  });
}

export async function todoCommentAttachments(companyId: string, commentIds: string[]) {
  const map = new Map<string, ReturnType<typeof serializeChatAttachment>[]>();
  if (!commentIds.length) return map;
  const rows = await AppDataSource.getRepository(Attachment).find({
    where: { companyId, messageId: In(commentIds) },
    order: { createdAt: "ASC" },
  });
  for (const row of rows) {
    const list = map.get(row.messageId!) ?? [];
    list.push(serializeChatAttachment(row));
    map.set(row.messageId!, list);
  }
  return map;
}

/** Freeze both the text and image inputs at the accepting Member comment. */
export async function composeTodoMentionContext(
  args: Parameters<typeof buildTodoMentionTurn>[0] & { companyId: string },
) {
  const turn = buildTodoMentionTurn(args);
  if (!turn) return null;
  const index = args.comments.findIndex((comment) => comment.id === args.triggerCommentId);
  const prior = args.comments.slice(0, index).filter((comment) => !comment.pending);
  const images = await attachmentImageContextForMessages(
    [
      ...prior.filter((comment) => !!comment.authorUserId).map((comment) => comment.id),
      args.triggerCommentId,
    ],
    args.companyId,
  );
  const summaries = await historicalAttachmentSummaries(
    prior.map((comment) => comment.id),
    args.companyId,
  );
  return {
    message: [
      turn.message,
      await inlineAttachmentsForMessage(args.triggerCommentId, args.companyId),
    ]
      .filter(Boolean)
      .join("\n\n"),
    images: images.get(args.triggerCommentId),
    history: turn.history.map((message, i) => ({
      ...message,
      content: [
        message.content,
        summaries.get(prior[i].id) ? `[Attachments: ${summaries.get(prior[i].id)}]` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      ...(message.role === "user" && images.get(prior[i].id)
        ? { images: images.get(prior[i].id) }
        : {}),
    })),
  };
}

export async function todoDiscussionHistory(
  companyId: string,
  todoId: string,
  employeeId: string,
  pendingCommentId: string,
): Promise<ChatTurn[]> {
  const thread = (
    await AppDataSource.getRepository(TodoComment).find({
      where: { todoId },
      order: { createdAt: "ASC" },
    })
  ).filter((comment) => comment.id !== pendingCommentId && !comment.pending);
  const images = await attachmentImageContextForMessages(
    thread.filter((comment) => !!comment.authorUserId).map((comment) => comment.id),
    companyId,
  );
  const summaries = await historicalAttachmentSummaries(
    thread.map((comment) => comment.id),
    companyId,
  );
  return thread.map((comment) => ({
    role: comment.authorEmployeeId === employeeId ? "assistant" : "user",
    content: [
      comment.body,
      summaries.get(comment.id) ? `[Attachments: ${summaries.get(comment.id)}]` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    ...(images.get(comment.id) ? { images: images.get(comment.id) } : {}),
  }));
}

export async function resolveTodoCommentAttachment(
  companyId: string,
  todoId: string,
  userId: string | null,
  attachmentId: string,
) {
  const resolved = await resolveAttachmentFile(attachmentId, companyId);
  if (!resolved) return null;
  if (!resolved.row.messageId)
    return resolved.row.uploadedByUserId === userId && userId ? resolved : null;
  return (await AppDataSource.getRepository(TodoComment).exist({
    where: { id: resolved.row.messageId, todoId },
  }))
    ? resolved
    : null;
}
