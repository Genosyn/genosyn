import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Todo, type TodoStatus } from "../db/entities/Todo.js";
import {
  filterFingerprint,
  type KeysetColumn,
  keysetPage,
  type Page,
  type PageLimits,
  pageQueryShape,
  type PageRequest,
} from "./listPaging.js";

/**
 * A Project's Todos, in the board's order, one page at a time
 * (`services/listPaging.ts`).
 *
 * The `list_todos` AI tool and `GET /projects/:pSlug/todos` (when it is asked
 * for a page) read this one function, so an AI Employee and an API client
 * reach the same Todos in the same order; for the same Project and filters
 * the two are one list, and a cursor from one continues the other. Access to
 * the Project is the caller's to check first.
 */

/** 50 Todos by default, at most 200 a page. */
export const TODO_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

/** Everything not done or cancelled: the work still to pick up. */
export const OPEN_TODO_STATUSES: TodoStatus[] = ["backlog", "todo", "in_progress", "in_review"];

/** The statuses a Todo list filters by: `open`, or one exact status. */
export const TODO_LIST_STATUSES = [
  "open",
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
] as const;

export type TodoListStatus = (typeof TODO_LIST_STATUSES)[number];

export type TodoListFilter = {
  status?: TodoListStatus;
  /** Only Todos assigned to this AI Employee. */
  assigneeEmployeeId?: string;
  /** Only Todos assigned to this Member. */
  assigneeUserId?: string;
};

/** `GET /projects/:pSlug/todos`'s query: the filters `list_todos` takes, and a page. */
export const todoListQuerySchema = z.object({
  status: z
    .enum(TODO_LIST_STATUSES)
    .optional()
    .describe("open is everything not done or cancelled: the work still to pick up."),
  assignedToMe: z
    .enum(["true", "false"])
    .optional()
    .describe("true: only the Todos assigned to you, the Member the session or API key belongs to."),
  assigneeEmployeeId: z
    .string()
    .uuid()
    .optional()
    .describe("Only the Todos assigned to this AI Employee."),
  assigneeUserId: z.string().uuid().optional().describe("Only the Todos assigned to this Member."),
  ...pageQueryShape,
});

/** The board's order: its drag-to-reorder key, then the oldest first, then the id. */
export const TODO_BOARD_KEYS: KeysetColumn[] = [
  { column: "todo.sortOrder", direction: "ASC", type: "number" },
  { column: "todo.createdAt", direction: "ASC", type: "timestamp" },
  { column: "todo.id", direction: "ASC", type: "string" },
];

/** A Project's Todos matching the filter, unordered: the shared WHERE of the page and the plain list. */
export function todoListQuery(projectId: string, filter: TodoListFilter) {
  const qb = AppDataSource.getRepository(Todo)
    .createQueryBuilder("todo")
    .where("todo.projectId = :projectId", { projectId });
  if (filter.status === "open") {
    qb.andWhere("todo.status IN (:...open)", { open: OPEN_TODO_STATUSES });
  } else if (filter.status) {
    qb.andWhere("todo.status = :status", { status: filter.status });
  }
  if (filter.assigneeEmployeeId) {
    qb.andWhere("todo.assigneeEmployeeId = :assigneeEmployeeId", {
      assigneeEmployeeId: filter.assigneeEmployeeId,
    });
  }
  if (filter.assigneeUserId) {
    qb.andWhere("todo.assigneeUserId = :assigneeUserId", {
      assigneeUserId: filter.assigneeUserId,
    });
  }
  return qb;
}

/** A Project's Todos in the board's order, one page at a time. A bad cursor throws a `ListQueryError`. */
export async function pageTodos<Out>(
  companyId: string,
  projectId: string,
  filter: TodoListFilter,
  page: PageRequest & { budgetChars?: number },
  present: (todos: Todo[]) => Promise<Out[]> | Out[],
): Promise<Page<Out>> {
  return keysetPage({
    query: () => todoListQuery(projectId, filter),
    keys: TODO_BOARD_KEYS,
    scope: "todos",
    fingerprint: filterFingerprint(companyId, {
      project: projectId,
      status: filter.status,
      assigneeEmployeeId: filter.assigneeEmployeeId,
      assigneeUserId: filter.assigneeUserId,
    }),
    noun: "Todos",
    limits: TODO_PAGE,
    page,
    present,
  });
}
