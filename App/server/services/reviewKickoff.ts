import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { ChatTurn, chatWithEmployee } from "./chat.js";
import { getActiveModel } from "./models.js";

/**
 * Review kickoff — the session that starts when work lands in an AI
 * reviewer's queue.
 *
 * A todo moved to `in_review` used to notify a human reviewer and do nothing
 * at all for an AI one ("bots don't get a bell") — the card sat in review
 * forever unless somebody noticed. An AI reviewer doesn't need a bell; it
 * needs a session, the same "go" signal `todoKickoff.ts` gives an assignee.
 *
 * The reviewer is briefed with the thread, judges the work, and moves the card
 * itself via `update_todo`: `done` when the work holds up, `in_progress` when
 * it should go back to the assignee — with the reasons on the thread either
 * way. Runs under employee authority (`toolAuthority: "employee"`): review is
 * background AI orchestration whether a human or an AI moved the card, and
 * everything privileged the reviewer tries still meets its own gate.
 *
 * Degradation mirrors the sibling kickoffs: no model → skip quietly (a human
 * will see the card in the review queue), errors land on the thread.
 */

const inFlight = new Set<string>();

/**
 * How many AI review sessions one todo may have before it waits for a human.
 * Two AI teammates can otherwise bounce a card between review and rework
 * indefinitely, each pass costing a model turn.
 */
const MAX_AI_REVIEW_PASSES = 3;

export async function kickoffTodoReview(args: {
  companyId: string;
  todoId: string;
}): Promise<void> {
  const { companyId, todoId } = args;
  if (inFlight.has(todoId)) return;

  const todoRepo = AppDataSource.getRepository(Todo);
  const todo = await todoRepo.findOneBy({ id: todoId });
  if (!todo || todo.status !== "in_review" || !todo.reviewerEmployeeId) return;
  // An employee signing off its own work is a rubber stamp, not a review.
  // Leave the card in review for a human rather than spending a turn on it.
  if (todo.reviewerEmployeeId === todo.assigneeEmployeeId) return;

  const project = await AppDataSource.getRepository(Project).findOneBy({
    id: todo.projectId,
    companyId,
  });
  if (!project) return;
  const reviewer = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: todo.reviewerEmployeeId,
    companyId,
  });
  if (!reviewer) return;
  if (!(await getActiveModel(reviewer.id))) {
    console.log(
      `[review-kickoff] ${project.key}-${todo.number} entered review for ${reviewer.slug}, ` +
        `but the reviewer has no AI Model connected — not starting.`,
    );
    return;
  }
  // Bound the review⇄rework cycle two AI employees can drive on their own.
  // The count lives on the row rather than being inferred from the comment
  // thread: an AI reviewer also comments when a human @-mentions it, so
  // counting comments would let ordinary chatter silently disable reviewing.
  if (todo.aiReviewPasses >= MAX_AI_REVIEW_PASSES) {
    console.log(
      `[review-kickoff] ${project.key}-${todo.number} has had ${todo.aiReviewPasses} review ` +
        `passes — leaving it in review for a human.`,
    );
    return;
  }
  // Claim the pass with a conditional UPDATE against the count we read, so two
  // kickoffs racing the same card start exactly one session.
  const claim = await todoRepo.update(
    { id: todo.id, status: "in_review", aiReviewPasses: todo.aiReviewPasses },
    { aiReviewPasses: todo.aiReviewPasses + 1 },
  );
  if (!claim.affected) return;

  inFlight.add(todoId);
  const commentRepo = AppDataSource.getRepository(TodoComment);
  const pending = await commentRepo.save(
    commentRepo.create({
      todoId: todo.id,
      authorUserId: null,
      authorEmployeeId: reviewer.id,
      body: "",
      pending: true,
    }),
  );
  // Whatever happens from here, that placeholder has to stop being pending —
  // the thread renders a pending row as a typing skeleton and would spin on it
  // forever.
  let outcome: string;
  try {
    const assignee = todo.assigneeEmployeeId
      ? await AppDataSource.getRepository(AIEmployee).findOneBy({
          id: todo.assigneeEmployeeId,
          companyId,
        })
      : null;
    const result = await chatWithEmployee(
      companyId,
      reviewer.id,
      composeReviewBrief(project, todo, assignee),
      await threadHistory(todo.id, reviewer.id, pending.id),
      // The same thread the assignee kickoff and @-mention replies replay, so
      // a review must not answer it while one of those is mid-reply.
      { toolAuthority: "employee", workloadScope: `todo:${todo.id}` },
    );
    outcome =
      result.status === "ok"
        ? result.reply || "(no reply)"
        : `I couldn't review this — ${result.reply}`;
  } catch (err) {
    outcome = `I couldn't review this — ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    inFlight.delete(todoId);
  }
  try {
    const row = await commentRepo.findOneBy({ id: pending.id });
    if (row) {
      row.body = outcome;
      row.pending = false;
      await commentRepo.save(row);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[review-kickoff] failed to post review verdict for todo ${todoId}:`, err);
  }
}

/** Thread mapping mirrors `todoKickoff.ts`: this reviewer is `assistant`. */
async function threadHistory(
  todoId: string,
  employeeId: string,
  pendingCommentId: string,
): Promise<ChatTurn[]> {
  const thread = await AppDataSource.getRepository(TodoComment).find({
    where: { todoId },
    order: { createdAt: "ASC" },
  });
  const history: ChatTurn[] = [];
  for (const c of thread) {
    if (c.id === pendingCommentId || c.pending) continue;
    history.push({
      role: c.authorEmployeeId === employeeId ? "assistant" : "user",
      content: c.body,
    });
  }
  return history;
}

function composeReviewBrief(project: Project, todo: Todo, assignee: AIEmployee | null): string {
  const ref = `${project.key}-${todo.number}`;
  const lines = [
    `**${ref}: ${todo.title}** in project "${project.name}" has been moved to review, and you are its reviewer.`,
  ];
  if (todo.description) lines.push("", "Description:", todo.description);
  lines.push(
    "",
    "---",
    "Review the work now. The thread above carries the worker's report; verify what it claims with your tools where you can, rather than taking the report's word for it.",
    `- If the work holds up, call \`update_todo\` with todoId "${todo.id}" and set status to "done".`,
    `- If it does not, call \`update_todo\` with todoId "${todo.id}" and set status to "in_progress", and say precisely what is missing so the assignee can fix it.`,
    ...(assignee
      ? [
          `- The assignee is your AI teammate ${assignee.name} (@${assignee.slug}). If you send the work back, also call \`create_handoff\` to them titled "Rework ${ref}" carrying exactly what must change — that starts them on the fix immediately instead of on their next scheduled run.`,
        ]
      : []),
    "- Your reply is posted on the todo's thread as the review verdict. Make it concrete: what you checked, what you found, what happens next.",
  );
  return lines.join("\n");
}
