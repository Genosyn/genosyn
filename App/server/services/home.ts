import { Between, In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Project } from "../db/entities/Project.js";
import { Routine } from "../db/entities/Routine.js";
import { Todo, TodoPriority } from "../db/entities/Todo.js";
import {
  countUnreadForUser,
  listUnreadForUser,
  NotificationDTO,
} from "./notifications.js";
import { listChannelsForUser } from "./workspaceChat.js";

/**
 * Aggregation behind the Home page — the landing surface after sign-in.
 * One round-trip gathers everything that might need the member's
 * attention: unread bell rows, todos assigned to them, reviews waiting on
 * their sign-off, pending approvals, unread channels/DMs, and a one-line
 * digest of today's AI activity. Each card deep-links to the full section.
 */

export type HomeTodo = {
  id: string;
  number: number;
  title: string;
  status: string;
  priority: TodoPriority;
  dueAt: string | null;
  parentTodoId: string | null;
  project: { id: string; key: string; name: string; slug: string };
};

export type HomeApproval = {
  id: string;
  kind: string;
  title: string | null;
  summary: string | null;
  requestedAt: string;
  employee: { id: string; name: string; slug: string } | null;
  routine: { id: string; name: string; slug: string } | null;
};

export type HomeChannel = {
  id: string;
  kind: string;
  /** Display label — channel name, or the counterparty for DMs. */
  label: string;
  unreadCount: number;
};

export type HomeData = {
  notifications: NotificationDTO[];
  unreadNotificationCount: number;
  myTodos: HomeTodo[];
  myTodoCount: number;
  reviewTodos: HomeTodo[];
  reviewTodoCount: number;
  approvals: HomeApproval[];
  pendingApprovalCount: number;
  unreadChannels: HomeChannel[];
  journalToday: { entries: number; employees: number };
  counts: { employees: number; projects: number };
};

const PRIORITY_WEIGHT: Record<TodoPriority, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

function toHomeTodo(t: Todo, p: Project): HomeTodo {
  return {
    id: t.id,
    number: t.number,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueAt: t.dueAt?.toISOString() ?? null,
    parentTodoId: t.parentTodoId,
    project: { id: p.id, key: p.key, name: p.name, slug: p.slug },
  };
}

/** Due-soonest first (no due date sinks), then priority, then age. */
function compareTodos(a: Todo, b: Todo): number {
  const aDue = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bDue = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (aDue !== bDue) return aDue - bDue;
  const pw = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (pw !== 0) return pw;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

export async function getHomeData(params: {
  companyId: string;
  userId: string;
}): Promise<HomeData> {
  const { companyId, userId } = params;

  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId },
    select: ["id", "key", "name", "slug"],
  });
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const projectIds = projects.map((p) => p.id);

  const todoRepo = AppDataSource.getRepository(Todo);
  const [mine, reviews] = await Promise.all([
    projectIds.length
      ? todoRepo.find({
          where: {
            projectId: In(projectIds),
            assigneeUserId: userId,
            status: In(["backlog", "todo", "in_progress"]),
          },
        })
      : Promise.resolve([] as Todo[]),
    projectIds.length
      ? todoRepo.find({
          where: {
            projectId: In(projectIds),
            reviewerUserId: userId,
            status: "in_review",
          },
          order: { updatedAt: "ASC" },
        })
      : Promise.resolve([] as Todo[]),
  ]);
  mine.sort(compareTodos);

  const approvalRepo = AppDataSource.getRepository(Approval);
  const [pendingApprovals, pendingApprovalCount] = await approvalRepo.findAndCount({
    where: { companyId, status: "pending" },
    order: { requestedAt: "DESC" },
    take: 5,
  });
  const routineIds = [
    ...new Set(pendingApprovals.map((a) => a.routineId).filter(Boolean)),
  ];
  const approvalEmpIds = [
    ...new Set(pendingApprovals.map((a) => a.employeeId).filter(Boolean)),
  ];
  const [routines, approvalEmps] = await Promise.all([
    routineIds.length
      ? AppDataSource.getRepository(Routine).find({ where: { id: In(routineIds) } })
      : Promise.resolve([] as Routine[]),
    approvalEmpIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(approvalEmpIds) },
        })
      : Promise.resolve([] as AIEmployee[]),
  ]);
  const routineById = new Map(routines.map((r) => [r.id, r]));
  const approvalEmpById = new Map(approvalEmps.map((e) => [e.id, e]));

  const channels = await listChannelsForUser(companyId, userId);
  const unreadChannels: HomeChannel[] = channels
    .filter((c) => c.unreadCount > 0)
    .sort(
      (a, b) =>
        new Date(b.lastMessageAt ?? 0).getTime() -
        new Date(a.lastMessageAt ?? 0).getTime(),
    )
    .slice(0, 6)
    .map((c) => {
      const others = c.members.filter(
        (m) => !(m.kind === "user" && m.id === userId),
      );
      const label =
        c.kind === "dm"
          ? others.map((m) => m.name).join(", ") || "Direct message"
          : `#${c.name ?? c.slug ?? "channel"}`;
      return { id: c.id, kind: c.kind, label, unreadCount: c.unreadCount };
    });

  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId },
    select: ["id"],
  });
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const todayEntries = employees.length
    ? await AppDataSource.getRepository(JournalEntry).find({
        where: {
          employeeId: In(employees.map((e) => e.id)),
          createdAt: Between(dayStart, dayEnd),
        },
        select: ["id", "employeeId"],
      })
    : [];

  const [notifications, unreadNotificationCount] = await Promise.all([
    listUnreadForUser({ companyId, userId, limit: 8 }),
    countUnreadForUser({ companyId, userId }),
  ]);

  return {
    notifications,
    unreadNotificationCount,
    myTodos: mine
      .slice(0, 8)
      .map((t) => toHomeTodo(t, projectById.get(t.projectId)!))
      .filter((t) => t.project),
    myTodoCount: mine.length,
    reviewTodos: reviews
      .slice(0, 8)
      .map((t) => toHomeTodo(t, projectById.get(t.projectId)!))
      .filter((t) => t.project),
    reviewTodoCount: reviews.length,
    approvals: pendingApprovals.map((a) => {
      const r = a.routineId ? routineById.get(a.routineId) : null;
      const e = a.employeeId ? approvalEmpById.get(a.employeeId) : null;
      return {
        id: a.id,
        kind: a.kind,
        title: a.title,
        summary: a.summary,
        requestedAt: a.requestedAt.toISOString(),
        employee: e ? { id: e.id, name: e.name, slug: e.slug } : null,
        routine: r ? { id: r.id, name: r.name, slug: r.slug } : null,
      };
    }),
    pendingApprovalCount,
    unreadChannels,
    journalToday: {
      entries: todayEntries.length,
      employees: new Set(todayEntries.map((e) => e.employeeId)).size,
    },
    counts: { employees: employees.length, projects: projects.length },
  };
}
