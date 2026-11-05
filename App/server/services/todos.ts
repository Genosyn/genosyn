import { AppDataSource } from "../db/datasource.js";
import { Project } from "../db/entities/Project.js";
import { Todo, type TodoPriority, type TodoRecurrence, type TodoStatus } from "../db/entities/Todo.js";

/**
 * The one way a Todo gets created.
 *
 * There used to be four copies of this: the human route, the AI tool, Pipelines
 * and recurrence. They drifted. An AI Employee completing a recurring Todo never
 * spawned the next one, because only the human route knew to.
 */

export type CreateTodoInput = {
  project: Project;
  title: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  assigneeEmployeeId?: string | null;
  assigneeUserId?: string | null;
  reviewerEmployeeId?: string | null;
  reviewerUserId?: string | null;
  createdById?: string | null;
  dueAt?: Date | null;
  recurrence?: TodoRecurrence;
  recurrenceParentId?: string | null;
  parentTodoId?: string | null;
  /** A Member did not write its title and description. */
  untrustedText?: boolean;
  tainted?: boolean;
  aiChainDepth?: number;
  /** The most an automatic session on it may do, when it came from restricted work. */
  ceilingJson?: string | null;
};

/**
 * Save a new Todo with the Project's next number, at the bottom of its column.
 *
 * The number comes from an increment inside the transaction, so two Todos
 * created at once on Postgres (where the row lock serializes them) or SQLite
 * (where the transaction gate does) never reach for the same one.
 */
export async function insertTodo(input: CreateTodoInput): Promise<Todo> {
  const status = input.status ?? "todo";
  const todo = await AppDataSource.transaction(async (manager) => {
    const projects = manager.getRepository(Project);
    await projects.increment({ id: input.project.id }, "todoCounter", 1);
    const { todoCounter } = await projects.findOneOrFail({
      where: { id: input.project.id },
      select: { id: true, todoCounter: true },
    });
    const todos = manager.getRepository(Todo);
    const last = await todos.findOne({
      where: { projectId: input.project.id, status },
      order: { sortOrder: "DESC" },
    });
    return todos.save(
      todos.create({
        projectId: input.project.id,
        number: todoCounter,
        title: input.title,
        description: input.description ?? "",
        status,
        priority: input.priority ?? "none",
        assigneeEmployeeId: input.assigneeEmployeeId ?? null,
        assigneeUserId: input.assigneeUserId ?? null,
        reviewerEmployeeId: input.reviewerEmployeeId ?? null,
        reviewerUserId: input.reviewerUserId ?? null,
        createdById: input.createdById ?? null,
        dueAt: input.dueAt ?? null,
        sortOrder: (last?.sortOrder ?? 0) + 1000,
        completedAt: status === "done" ? new Date() : null,
        recurrence: input.recurrence ?? "none",
        recurrenceParentId: input.recurrenceParentId ?? null,
        parentTodoId: input.parentTodoId ?? null,
        untrustedText: input.untrustedText ?? false,
        tainted: input.tainted ?? false,
        ceilingJson: input.ceilingJson ?? null,
        aiChainDepth: input.aiChainDepth ?? 0,
      }),
    );
  });
  input.project.todoCounter = todo.number;
  return todo;
}

/**
 * Advance a date by one recurrence period. `weekdays` skips ahead to the next
 * Monday to Friday slot; the others use calendar math so DST and month lengths
 * fall out for free.
 */
export function nextOccurrence(from: Date, recurrence: TodoRecurrence): Date | null {
  if (recurrence === "none") return null;
  const next = new Date(from.getTime());
  switch (recurrence) {
    case "daily":
      next.setDate(next.getDate() + 1);
      return next;
    case "weekdays":
      do {
        next.setDate(next.getDate() + 1);
      } while (next.getDay() === 0 || next.getDay() === 6);
      return next;
    case "weekly":
      next.setDate(next.getDate() + 7);
      return next;
    case "biweekly":
      next.setDate(next.getDate() + 14);
      return next;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      return next;
    case "yearly":
      next.setFullYear(next.getFullYear() + 1);
      return next;
    default:
      return null;
  }
}

/** What a Todo was held to, for the next one: its limits carry on, one email's trust doesn't. */
function limitsWithoutTrust(ceilingJson: string | null): string | null {
  if (!ceilingJson) return null;
  try {
    return JSON.stringify({ ...JSON.parse(ceilingJson), trustedSender: false });
  } catch {
    // A floor nobody can read is read as the narrowest wherever it's used.
    return ceilingJson;
  }
}

/**
 * A recurring Todo was just completed: put the next one on the list for when
 * it's next due. It anchors to the completed Todo's due date, so a weekly report
 * due on Monday stays due on Mondays, and to now when it had none.
 */
export async function spawnNextRecurrence(project: Project, completed: Todo): Promise<Todo | null> {
  const nextDue = nextOccurrence(completed.dueAt ?? new Date(), completed.recurrence);
  if (!nextDue) return null;
  const next = await insertTodo({
    project,
    title: completed.title,
    description: completed.description,
    status: "todo",
    priority: completed.priority,
    assigneeEmployeeId: completed.assigneeEmployeeId,
    assigneeUserId: completed.assigneeUserId,
    reviewerEmployeeId: completed.reviewerEmployeeId,
    reviewerUserId: completed.reviewerUserId,
    createdById: completed.createdById,
    dueAt: nextDue,
    recurrence: completed.recurrence,
    recurrenceParentId: completed.recurrenceParentId ?? completed.id,
    parentTodoId: completed.parentTodoId,
    untrustedText: completed.untrustedText,
    tainted: completed.tainted,
    aiChainDepth: completed.aiChainDepth,
    ceilingJson: limitsWithoutTrust(completed.ceilingJson),
  });
  // Imported here because Pipelines' own steps create Todos through this file.
  void import("./pipelines/events.js")
    .then(({ dispatchTodoCreated }) => dispatchTodoCreated(project.companyId, next.id))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[pipelines] task event failed for ${next.id}:`, err);
    });
  return next;
}
