import { In, LessThanOrEqual, MoreThanOrEqual, Not, IsNull } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Project } from "../db/entities/Project.js";
import { Todo, type TodoStatus } from "../db/entities/Todo.js";
import { TodoComment } from "../db/entities/TodoComment.js";
import { TodoPickup } from "../db/entities/TodoPickup.js";
import { User } from "../db/entities/User.js";
import {
  TASKS_HOME_SECTION_LIMIT,
  type TasksHome,
  type TasksHomeItem,
} from "../../shared/tasksHome.js";
import { TODO_WAIT_LABEL, type TodoWaitKind } from "../../shared/todoPickups.js";
import { redactSensitiveText } from "./approvalRedaction.js";
import { listAccessibleProjectIds, type ProjectActor } from "./projects.js";

/**
 * What's happening across a company's Tasks, for one person: what needs them, what AI is
 * doing, what's waiting and what finished. One read that stores nothing, and a Project
 * they can't open isn't mentioned or counted. Written without joins, because a Todo's
 * `projectId` and a pickup's `todoId` aren't the same column type as the ids they name on
 * Postgres.
 */

const OPEN: TodoStatus[] = ["backlog", "todo", "in_progress", "in_review"];
/** Waiting on someone here, so it's theirs to move. */
const NEEDS_A_PERSON: TodoWaitKind[] = [
  "member",
  "decision",
  "mail_review",
  "work_review",
  "browser_approval",
];
const WAITING_ON_OTHERS: TodoWaitKind[] = ["customer", "date", "work_session"];
const LINE_CHARS = 160;
const TITLE_CHARS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Sessions read at once. A company has few, and a pass only starts so many. */
const ACTIVE_PICKUPS_READ = 500;

function line(text: string): string {
  const first = redactSensitiveText(text)
    .split("\n")
    .map((row) => row.trim())
    .find(Boolean);
  return (first ?? "").slice(0, LINE_CHARS);
}

function emptyHome(): TasksHome {
  const none = { count: 0, items: [] };
  return { needsYou: none, working: { ...none, queuedCount: 0 }, waiting: none, doneToday: none };
}

export async function readTasksHome(args: {
  companyId: string;
  actor: ProjectActor;
  userId: string;
  now?: Date;
}): Promise<TasksHome> {
  const { companyId, userId } = args;
  const now = args.now ?? new Date();
  const projectIds = await listAccessibleProjectIds(companyId, args.actor);
  if (projectIds.size === 0) return emptyHome();
  const inProjects = In([...projectIds]);
  const todos = AppDataSource.getRepository(Todo);
  const limit = TASKS_HOME_SECTION_LIMIT;

  const [[needsYou, needsYouCount], [waiting, waitingCount], [done, doneCount], active] =
    await Promise.all([
      todos.findAndCount({
        where: [
          { projectId: inProjects, status: "in_review", reviewerUserId: userId },
          { projectId: inProjects, status: In(OPEN), waitingOn: In(NEEDS_A_PERSON) },
        ],
        order: { updatedAt: "DESC", id: "DESC" },
        take: limit,
      }),
      todos.findAndCount({
        where: { projectId: inProjects, status: In(OPEN), waitingOn: In(WAITING_ON_OTHERS) },
        order: { waitingCheckAt: "ASC", id: "DESC" },
        take: limit,
      }),
      todos.findAndCount({
        where: {
          projectId: inProjects,
          status: "done",
          completedAt: MoreThanOrEqual(new Date(now.getTime() - DAY_MS)),
        },
        order: { completedAt: "DESC", id: "DESC" },
        take: limit,
      }),
      AppDataSource.getRepository(TodoPickup).find({
        where: [
          { companyId, status: "running" },
          { companyId, status: "queued", notBeforeAt: LessThanOrEqual(now) },
          { companyId, status: "queued", notBeforeAt: IsNull() },
        ],
        select: { id: true, todoId: true, status: true, acceptedAt: true, employeeId: true },
        order: { acceptedAt: "DESC", id: "DESC" },
        take: ACTIVE_PICKUPS_READ,
      }),
    ]);

  // Sessions are the company's, so only the ones on a Todo this person can see count.
  const activeTodos = active.length
    ? await todos.findBy({
        id: In([...new Set(active.map((row) => row.todoId))]),
        projectId: inProjects,
      })
    : [];
  const activeTodoById = new Map(activeTodos.map((todo) => [todo.id, todo]));
  const visible = active.filter((row) => activeTodoById.has(row.todoId));
  const running = visible.filter((row) => row.status === "running");
  const queuedCount = visible.length - running.length;
  const shownRunning = running.slice(0, limit);

  const everyTodo = [
    ...needsYou,
    ...waiting,
    ...done,
    ...shownRunning.map((row) => activeTodoById.get(row.todoId)!),
  ];
  const [projects, employees, users, reports] = await Promise.all([
    AppDataSource.getRepository(Project).find({
      where: { id: In([...new Set(everyTodo.map((todo) => todo.projectId))]), companyId },
      select: { id: true, slug: true, key: true, name: true },
    }),
    AppDataSource.getRepository(AIEmployee).find({
      where: {
        companyId,
        id: In([
          ...new Set(
            [
              ...everyTodo.map((todo) => todo.assigneeEmployeeId),
              ...shownRunning.map((row) => row.employeeId),
            ].filter((id): id is string => Boolean(id)),
          ),
        ]),
      },
      select: { id: true, name: true },
    }),
    AppDataSource.getRepository(User).find({
      where: {
        id: In([
          ...new Set(
            everyTodo.map((todo) => todo.assigneeUserId).filter((id): id is string => Boolean(id)),
          ),
        ]),
      },
      select: { id: true, name: true, email: true },
    }),
    done.length
      ? AppDataSource.getRepository(TodoComment).find({
          where: {
            todoId: In(done.map((todo) => todo.id)),
            pickupId: Not(IsNull()),
            pending: false,
          },
          select: { id: true, todoId: true, body: true, createdAt: true },
          order: { createdAt: "DESC", id: "DESC" },
        })
      : Promise.resolve([] as TodoComment[]),
  ]);
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const employeeName = new Map(employees.map((employee) => [employee.id, employee.name]));
  const userName = new Map(users.map((user) => [user.id, user.name || user.email]));
  const reportOf = new Map<string, string>();
  for (const report of reports) {
    if (!reportOf.has(report.todoId)) reportOf.set(report.todoId, line(report.body));
  }

  const item = (todo: Todo, detail: string, since: Date | null): TasksHomeItem => {
    const project = projectById.get(todo.projectId);
    const ai = todo.assigneeEmployeeId ? employeeName.get(todo.assigneeEmployeeId) : undefined;
    const person = todo.assigneeUserId ? userName.get(todo.assigneeUserId) : undefined;
    return {
      todoId: todo.id,
      ref: `${project?.key ?? ""}-${todo.number}`,
      number: todo.number,
      title: redactSensitiveText(todo.title).slice(0, TITLE_CHARS),
      projectSlug: project?.slug ?? "",
      projectName: project?.name ?? "",
      assignee: ai
        ? { kind: "ai", name: ai }
        : person
          ? { kind: "human", name: person }
          : null,
      detail,
      waitingOn: (todo.waitingOn as TodoWaitKind | null) ?? null,
      since: since?.toISOString() ?? null,
      checkAt: todo.waitingCheckAt?.toISOString() ?? null,
    };
  };

  const waitingLine = (todo: Todo): string =>
    line(todo.waitingReason) || TODO_WAIT_LABEL[todo.waitingOn as TodoWaitKind];

  return {
    needsYou: {
      count: needsYouCount,
      items: needsYou.map((todo) =>
        item(
          todo,
          todo.status === "in_review" && todo.reviewerUserId === userId
            ? "Needs your review"
            : waitingLine(todo),
          todo.waitingSince ?? todo.updatedAt,
        ),
      ),
    },
    working: {
      count: running.length,
      queuedCount,
      items: shownRunning.map((row) => {
        const todo = activeTodoById.get(row.todoId)!;
        return item(
          todo,
          `${employeeName.get(row.employeeId) ?? "An AI Employee"} is working on this`,
          row.acceptedAt,
        );
      }),
    },
    waiting: {
      count: waitingCount,
      items: waiting.map((todo) => item(todo, waitingLine(todo), todo.waitingSince)),
    },
    doneToday: {
      count: doneCount,
      items: done.map((todo) => item(todo, reportOf.get(todo.id) ?? "", todo.completedAt)),
    },
  };
}
