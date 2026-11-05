import { z } from "zod";
import { AppDataSource } from "../../db/datasource.js";
import { Activity } from "../../db/entities/Activity.js";
import { Project } from "../../db/entities/Project.js";
import { Routine } from "../../db/entities/Routine.js";
import { Todo } from "../../db/entities/Todo.js";
import { TodoPickup } from "../../db/entities/TodoPickup.js";
import { Workstream } from "../../db/entities/Workstream.js";

type PreparationContext = {
  companyId: string;
  employeeId: string;
  routineId?: string | null;
  /**
   * The pickup this turn was started for, and the thread when it has one. A pickup held
   * to preparing works that Todo and that thread and nothing else: the words behind it
   * are from outside, so they don't get to reach other people's work.
   */
  emailWork?: { pickupId: string; threadId: string | null } | null;
};

/** Subtasks a session working from outside words may file on its Todo. They start nobody. */
export const MAX_SUBTASKS_FROM_EMAIL = 10;

const EMAIL_WORK_BOUNDARY =
  "A session working from outside words can only work on its own Todo and the thread it came from. Say what else you'd do in your report, or use request_work_review.";

/** Why this call reaches past the Todo and thread an email started this turn for. */
async function emailWorkError(
  context: PreparationContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const work = context.emailWork;
  if (!work) return null;
  if (toolName === "update_mail_thread" && args.threadId !== work.threadId) {
    return EMAIL_WORK_BOUNDARY;
  }
  const checksTodo = ["update_todo", "add_todo_comment", "link_todo", "wait_on_todo"];
  if (!checksTodo.includes(toolName) && toolName !== "create_todo") return null;
  const pickup = await AppDataSource.getRepository(TodoPickup).findOne({
    where: { id: work.pickupId },
    select: { id: true, todoId: true },
  });
  const own = pickup
    ? await AppDataSource.getRepository(Todo).findOne({
        where: { id: pickup.todoId },
        select: { id: true, projectId: true },
      })
    : null;
  if (!own) return EMAIL_WORK_BOUNDARY;
  if (toolName === "create_todo") {
    const project = await AppDataSource.getRepository(Project).findOne({
      where: { companyId: context.companyId, slug: String(args.projectSlug ?? "") },
      select: { id: true },
    });
    if (project?.id !== own.projectId || args.parentTodoId !== own.id) {
      return `${EMAIL_WORK_BOUNDARY} Anything you file here is a subtask of your Todo: pass its id as parentTodoId.`;
    }
    const subtasks = await AppDataSource.getRepository(Todo).countBy({ parentTodoId: own.id });
    return subtasks >= MAX_SUBTASKS_FROM_EMAIL
      ? `This Todo has ${MAX_SUBTASKS_FROM_EMAIL} subtasks, which is as many as this work can file. Say what's left in your report.`
      : null;
  }
  // A wait is what starts a later session, so that stays with the Todo the email filed.
  if (toolName === "wait_on_todo" && args.todoId !== own.id) return EMAIL_WORK_BOUNDARY;
  if (args.todoId !== own.id) {
    const parsed = idSchema.safeParse(args.todoId);
    const row = parsed.success
      ? await AppDataSource.getRepository(Todo).findOne({
          where: { id: parsed.data },
          select: { id: true, parentTodoId: true },
        })
      : null;
    if (row?.parentTodoId !== own.id) return EMAIL_WORK_BOUNDARY;
  }
  if (toolName === "link_todo" && args.kind === "mail_thread" && args.id !== work.threadId) {
    return EMAIL_WORK_BOUNDARY;
  }
  if (toolName === "wait_on_todo" && args.threadId !== undefined && args.threadId !== work.threadId) {
    return EMAIL_WORK_BOUNDARY;
  }
  return null;
}

const idSchema = z.string().uuid();

async function keepsPreparationBoundary(context: PreparationContext): Promise<boolean> {
  const parsed = idSchema.safeParse(context.routineId);
  if (!parsed.success) return false;
  const routine = await AppDataSource.getRepository(Routine).findOneBy({
    id: parsed.data,
    employeeId: context.employeeId,
    selfReviewOnly: false,
  });
  // Event/webhook/retry Runs may be preparation-only even though a later
  // scheduled Run of that same Routine has broader authority. Its stateDoc
  // must not become a way to carry restricted work into that later turn.
  return routine?.mailDeliveryMode != null;
}

/** Stored state can carry authority that a field allowlist alone cannot see.
 * Keep preparation away from broader Routine briefs and recurring/reminding
 * follow-ups. Resource Grants and route validation still apply afterward. */
export async function proactivePreparationError(
  context: PreparationContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | null> {
  const emailBoundary = await emailWorkError(context, toolName, args);
  if (emailBoundary) return emailBoundary;
  const workstreamBoundary =
    "Proactive preparation can track an unbound Workstream or this turn's own permanently restricted Routine only. It cannot change a broader Routine's work instructions. Record the finding in an unbound Workstream instead.";
  if (toolName === "create_workstream") {
    if (
      args.routineId !== undefined &&
      (args.routineId !== context.routineId || !(await keepsPreparationBoundary(context)))
    )
      return workstreamBoundary;
  }
  if (toolName === "update_workstream") {
    const parsed = idSchema.safeParse(args.workstreamId);
    if (!parsed.success) return null;
    const row = await AppDataSource.getRepository(Workstream).findOneBy({
      id: parsed.data,
      companyId: context.companyId,
      employeeId: context.employeeId,
    });
    if (
      row?.routineId &&
      (row.routineId !== context.routineId || !(await keepsPreparationBoundary(context)))
    )
      return workstreamBoundary;
  }
  if (toolName === "update_follow_up") {
    const parsed = idSchema.safeParse(args.followUpId);
    if (!parsed.success) return null;
    const row = await AppDataSource.getRepository(Activity).findOneBy({
      id: parsed.data,
      companyId: context.companyId,
      kind: "task",
    });
    if (
      row &&
      (row.recurrenceRule ||
        row.reminderAt ||
        row.assignedUserId ||
        (row.assignedEmployeeId && row.assignedEmployeeId !== context.employeeId))
    )
      return "Proactive preparation can maintain only ordinary follow-ups assigned to you or unassigned, without reminders or recurrence. Preserve this follow-up and record your finding in your Workstream.";
  }
  if (["update_todo", "add_todo_comment", "link_todo", "wait_on_todo"].includes(toolName)) {
    const parsed = idSchema.safeParse(args.todoId);
    if (!parsed.success) return null;
    const row = await AppDataSource.getRepository(Todo).findOneBy({ id: parsed.data });
    const project = row
      ? await AppDataSource.getRepository(Project).findOneBy({
          id: row.projectId,
          companyId: context.companyId,
        })
      : null;
    if (
      row &&
      project &&
      row.assigneeEmployeeId !== context.employeeId &&
      row.reviewerEmployeeId !== context.employeeId &&
      (row.assigneeEmployeeId || row.assigneeUserId)
    ) {
      return "Proactive preparation can maintain only Todos assigned to you, up for your review, or unassigned. Record your finding in your Workstream instead.";
    }
  }
  return null;
}
