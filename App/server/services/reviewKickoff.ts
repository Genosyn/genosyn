import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Project } from "../db/entities/Project.js";
import { Todo } from "../db/entities/Todo.js";
import { getActiveModel } from "./models.js";
import { requestTodoPickup, type TodoPickupCeiling } from "./todoPickups.js";

/**
 * Review kickoff: the session that starts when work lands in an AI reviewer's
 * queue.
 *
 * A todo moved to `in_review` used to notify a human reviewer and do nothing at
 * all for an AI one, so the card sat in review forever unless somebody noticed.
 * An AI reviewer doesn't need a bell; it needs a session. The session is a pickup
 * like any other (`todoPickups.ts`), so it waits out a Standdown or an outage and
 * survives a restart, and it runs after the assignee's session has finished
 * writing its report.
 *
 * The reviewer judges the work and moves the card itself via `update_todo`:
 * `done` when it holds up, `in_progress` when it should go back. It runs under
 * employee authority: review is background AI orchestration whether a human or
 * an AI moved the card, and everything privileged the reviewer tries still meets
 * its own gate.
 */

/**
 * How many AI review sessions one todo may have before it waits for a human.
 * Two AI teammates can otherwise bounce a card between review and rework
 * indefinitely, each pass costing a model turn.
 */
const MAX_AI_REVIEW_PASSES = 3;

export async function kickoffTodoReview(args: {
  companyId: string;
  todoId: string;
  /** What the turn that moved the card was held to. A review can't shed it. */
  ceiling?: TodoPickupCeiling;
}): Promise<void> {
  const { companyId, todoId } = args;
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
  // Bound the review and rework cycle two AI employees can drive on their own.
  // The count lives on the row rather than being inferred from the comment
  // thread: an AI reviewer also comments when a human @-mentions it, so counting
  // comments would let ordinary chatter silently disable reviewing.
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

  await requestTodoPickup({
    companyId,
    todoId: todo.id,
    employeeId: reviewer.id,
    trigger: "review",
    authority: { kind: "employee" },
    ceiling: args.ceiling,
  });
}
