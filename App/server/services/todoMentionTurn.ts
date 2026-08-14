import type { TodoComment } from "../db/entities/TodoComment.js";
import type { ChatTurn } from "./chat.js";

type ThreadComment = Pick<
  TodoComment,
  "id" | "authorUserId" | "authorEmployeeId" | "body" | "pending"
>;

/**
 * Freeze a Project-comment AI turn to the exact Member comment which
 * accepted it. Comments posted later must not replace either the prompt or
 * the requester whose authority the AI Employee receives.
 */
export function buildTodoMentionTurn(args: {
  comments: readonly ThreadComment[];
  triggerCommentId: string;
  requesterUserId: string;
  employeeId: string;
}): { message: string; history: ChatTurn[] } | null {
  const triggerIndex = args.comments.findIndex((comment) => comment.id === args.triggerCommentId);
  const triggerComment = triggerIndex >= 0 ? args.comments[triggerIndex] : null;
  if (!triggerComment || triggerComment.authorUserId !== args.requesterUserId) {
    return null;
  }

  const history: ChatTurn[] = [];
  for (const comment of args.comments.slice(0, triggerIndex)) {
    if (comment.pending) continue;
    history.push({
      role: comment.authorEmployeeId === args.employeeId ? "assistant" : "user",
      content: comment.body,
    });
  }
  return { message: triggerComment.body, history };
}
