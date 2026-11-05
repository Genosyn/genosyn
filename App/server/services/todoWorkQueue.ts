import { In } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { Project } from "../db/entities/Project.js";
import { Todo, type TodoStatus } from "../db/entities/Todo.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import type {
  EmployeeTodoQueue,
  TodoPickupHold,
  TodoPickupTrigger,
  TodoQueueItem,
  TodoWaitKind,
} from "../../shared/todoPickups.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { filterFingerprint, keysetPage, type Page, type PageRequest } from "./listPaging.js";
import { listAccessibleProjectIds, type ProjectActor } from "./projects.js";
import { inDispatchOrder, todoLimits } from "./todoPickups.js";

/**
 * What an AI Employee has on its plate: the session it's in, the Todos queued for
 * it in the order they'll start, and the ones waiting on someone.
 *
 * It stores nothing and starts nothing. The queue itself is the `todo_pickups` table
 * (`services/todoPickups.ts`), so this can't drift from what the heartbeat will do.
 * A Todo in a Project the reader can't open isn't mentioned or counted, here or in
 * an AI Employee's own list, and that is applied inside the query.
 */

const TITLE_CHARS = 200;
const REASON_CHARS = 300;
/** How much of a queue one view shows. The counts stay truthful past it. */
const QUEUE_PREVIEW_LIMIT = 100;

export const MY_TODOS_PAGE = { defaultLimit: 25, maxLimit: 100 };

/** Open work on a Todo, for the reads that have to leave it out of something else. */
const OPEN: TodoStatus[] = ["backlog", "todo", "in_progress", "in_review"];

function isDueOrRetrying(alias: string): string {
  return `(${alias}.status = 'running' OR (${alias}.status = 'queued' AND (${alias}.notBeforeAt IS NULL OR ${alias}.notBeforeAt <= :now OR ${alias}.hold = 'retrying')))`;
}

function waitingOf(todo: Todo): TodoQueueItem["waiting"] {
  if (!todo.waitingOn) return null;
  return {
    on: todo.waitingOn as TodoWaitKind,
    reason: redactSensitiveText(todo.waitingReason).slice(0, REASON_CHARS),
    since: todo.waitingSince?.toISOString() ?? null,
    checkAt: todo.waitingCheckAt?.toISOString() ?? null,
  };
}

async function present(
  companyId: string,
  todos: readonly Todo[],
  employeeId: string,
  now: Date,
  projectIds: readonly string[],
): Promise<TodoQueueItem[]> {
  if (todos.length === 0) return [];
  const projects = await AppDataSource.getRepository(Project).findBy({
    id: In([...new Set(todos.map((todo) => todo.projectId))]),
    companyId,
  });
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const active = await AppDataSource.getRepository(TodoPickup).findBy({
    todoId: In(todos.map((todo) => todo.id)),
    status: In(["queued", "running"]),
  });
  const pickupByTodo = new Map(active.map((row) => [row.todoId, row]));
  const places = await queuePlaces(employeeId, now, projectIds);
  return todos.flatMap((todo): TodoQueueItem[] => {
    const project = projectById.get(todo.projectId);
    if (!project) return [];
    const pickup = pickupByTodo.get(todo.id);
    return [
      {
        todoId: todo.id,
        ref: `${project.key}-${todo.number}`,
        title: redactSensitiveText(todo.title).slice(0, TITLE_CHARS),
        untrustedText: todo.untrustedText,
        heldToLimits: todoLimits(todo) !== null,
        projectSlug: project.slug,
        projectName: project.name,
        status: todo.status,
        priority: todo.priority,
        dueAt: todo.dueAt?.toISOString() ?? null,
        pickup: pickup
          ? {
              status: pickup.status as "queued" | "running",
              trigger: pickup.trigger as TodoPickupTrigger,
              hold: pickup.hold as TodoPickupHold | null,
              startedAt: pickup.acceptedAt.toISOString(),
              notBeforeAt: pickup.notBeforeAt?.toISOString() ?? null,
              position: places.get(todo.id) ?? null,
            }
          : null,
        waiting: waitingOf(todo),
      },
    ];
  });
}

/**
 * Each queued Todo's place, 1 being next up, in the order the heartbeat starts them.
 * Among what this reader can see, or a gap in the numbers would say something's hidden.
 */
async function queuePlaces(
  employeeId: string,
  now: Date,
  projectIds: readonly string[],
): Promise<Map<string, number>> {
  if (projectIds.length === 0) return new Map();
  const rows = await inDispatchOrder(
    AppDataSource.getRepository(TodoPickup)
      .createQueryBuilder("pickup")
      .innerJoin(Todo, "todo", "CAST(todo.id AS text) = pickup.todoId")
      .where("pickup.employeeId = :employeeId AND pickup.status = 'queued'", { employeeId })
      .andWhere("pickup.notBeforeAt <= :now", { now })
      .andWhere("todo.projectId IN (:...projectIds)", { projectIds }),
  )
    .select(["pickup.id", "pickup.todoId"])
    .limit(QUEUE_PREVIEW_LIMIT)
    .getMany();
  return new Map(rows.map((row, index) => [row.todoId, index + 1]));
}

/**
 * One AI Employee's Todo work, as a Member may see it. Where a session is running
 * or due it counts as that, and only otherwise as waiting, so a check-back that came
 * due doesn't show twice.
 */
export async function employeeTodoQueue(
  companyId: string,
  employeeId: string,
  viewer: ProjectActor,
  now: Date = new Date(),
): Promise<EmployeeTodoQueue> {
  const projectIds = [...(await listAccessibleProjectIds(companyId, viewer))];
  if (projectIds.length === 0) {
    return { running: [], queued: [], queuedCount: 0, waiting: [], waitingCount: 0 };
  }
  const todos = AppDataSource.getRepository(Todo);
  const pickups = (status: "running" | "queued") => {
    const qb = todos
      .createQueryBuilder("todo")
      .innerJoin(TodoPickup, "pickup", "pickup.todoId = CAST(todo.id AS text)")
      .where("todo.projectId IN (:...projectIds)", { projectIds })
      .andWhere("pickup.employeeId = :employeeId AND pickup.status = :status", {
        employeeId,
        status,
      });
    return status === "queued"
      ? qb.andWhere(
          "(pickup.notBeforeAt IS NULL OR pickup.notBeforeAt <= :now OR pickup.hold = 'retrying')",
          { now },
        )
      : qb;
  };
  const waiting = () =>
    todos
      .createQueryBuilder("todo")
      .where("todo.projectId IN (:...projectIds)", { projectIds })
      .andWhere("todo.assigneeEmployeeId = :employeeId", { employeeId })
      .andWhere("todo.waitingOn IS NOT NULL")
      .andWhere("todo.status IN (:...open)", { open: OPEN })
      .andWhere((qb) => {
        const sessions = qb
          .subQuery()
          .select("1")
          .from(TodoPickup, "pickup")
          .where("pickup.todoId = CAST(todo.id AS text)")
          .andWhere(isDueOrRetrying("pickup"), { now })
          .getQuery();
        return `NOT EXISTS ${sessions}`;
      });

  const [running, queuedRows, queuedCount, waitingRows, waitingCount] = await Promise.all([
    pickups("running").orderBy("pickup.acceptedAt", "ASC").limit(QUEUE_PREVIEW_LIMIT).getMany(),
    inDispatchOrder(pickups("queued")).limit(QUEUE_PREVIEW_LIMIT).getMany(),
    pickups("queued").getCount(),
    waiting()
      .orderBy("todo.waitingSince", "ASC")
      .addOrderBy("todo.id", "ASC")
      .take(QUEUE_PREVIEW_LIMIT)
      .getMany(),
    waiting().getCount(),
  ]);
  const [runningItems, queuedItems, waitingItems] = await Promise.all([
    present(companyId, running, employeeId, now, projectIds),
    present(companyId, queuedRows, employeeId, now, projectIds),
    present(companyId, waitingRows, employeeId, now, projectIds),
  ]);
  return {
    running: runningItems,
    queued: queuedItems,
    queuedCount,
    waiting: waitingItems,
    waitingCount,
  };
}

/** An AI Employee's own open Todos across Projects, for `list_my_todos`. */
export async function pageMyTodos(
  companyId: string,
  employeeId: string,
  actors: readonly ProjectActor[],
  page: PageRequest & { budgetChars?: number },
  now: Date = new Date(),
): Promise<Page<TodoQueueItem & { role: "assignee" | "reviewer" }>> {
  const sets = await Promise.all(actors.map((actor) => listAccessibleProjectIds(companyId, actor)));
  const [first, ...rest] = sets;
  const projectIds = [...(first ?? [])].filter((id) => rest.every((set) => set.has(id)));
  return keysetPage({
    query: () => {
      const qb = AppDataSource.getRepository(Todo)
        .createQueryBuilder("todo")
        .where(
          "((todo.assigneeEmployeeId = :employeeId AND todo.status IN (:...open)) OR (todo.reviewerEmployeeId = :employeeId AND todo.status = :review))",
          { employeeId, open: OPEN, review: "in_review" },
        );
      if (projectIds.length === 0) return qb.andWhere("1 = 0");
      return qb.andWhere("todo.projectId IN (:...projectIds)", { projectIds });
    },
    keys: [
      { column: "todo.createdAt", direction: "ASC", type: "timestamp" },
      { column: "todo.id", direction: "ASC", type: "string" },
    ],
    scope: "my-todos",
    fingerprint: filterFingerprint(companyId, {
      employeeId,
      actors: actors.map((actor) => actor.id),
    }),
    noun: "Todos",
    limits: MY_TODOS_PAGE,
    page,
    present: async (rows) => {
      const items = await present(companyId, rows, employeeId, now, projectIds);
      const byId = new Map(rows.map((row) => [row.id, row]));
      return items.map((item) => ({
        ...item,
        role:
          byId.get(item.todoId)?.assigneeEmployeeId === employeeId
            ? ("assignee" as const)
            : ("reviewer" as const),
      }));
    },
  });
}
