import { In, IsNull, LessThanOrEqual } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import {
  Activity,
  type ActivityPriority,
  type ActivityTaskStatus,
} from "../../db/entities/Activity.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Deal } from "../../db/entities/Deal.js";
import { Membership } from "../../db/entities/Membership.js";
import { Partnership } from "../../db/entities/Partnership.js";
import { User } from "../../db/entities/User.js";
import { recordActivity, type ActivityActor } from "./activities.js";
import { assertRevenueLinks, assertRevenueOwner } from "./integrity.js";

export type FollowUpItem = {
  id: string;
  source: "task" | "deal" | "partnership";
  title: string;
  dueAt: Date;
  reminderAt: Date | null;
  status: ActivityTaskStatus;
  priority: ActivityPriority;
  overdue: boolean;
  dealId: string | null;
  partnershipId: string | null;
  contactId: string | null;
  customerId: string | null;
  assignedUserId: string | null;
  assignedEmployeeId: string | null;
  assigneeName: string | null;
  recurrenceRule: string | null;
};

export type TaskWrite = {
  subject?: string;
  bodyText?: string;
  dueAt?: Date | null;
  reminderAt?: Date | null;
  taskStatus?: ActivityTaskStatus;
  priority?: ActivityPriority;
  assignedUserId?: string | null;
  assignedEmployeeId?: string | null;
  recurrenceRule?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  customerId?: string | null;
  partnershipId?: string | null;
};

async function assigneeNames(
  companyId: string,
  userIds: string[],
  employeeIds: string[],
): Promise<{ users: Map<string, string>; employees: Map<string, string> }> {
  const [memberships, employees] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(Membership).find({
          where: { companyId, userId: In(userIds) },
        })
      : [],
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { companyId, id: In(employeeIds) },
        })
      : [],
  ]);
  const users = memberships.length
    ? await AppDataSource.getRepository(User).find({
        where: { id: In(memberships.map((membership) => membership.userId)) },
      })
    : [];
  return {
    users: new Map(users.map((user) => [user.id, user.name || user.email])),
    employees: new Map(employees.map((employee) => [employee.id, employee.name])),
  };
}

export async function listFollowUps(
  companyId: string,
  opts: {
    state?: "all" | "overdue" | "today" | "upcoming";
    assignedUserId?: string;
    assignedEmployeeId?: string;
    limit?: number;
  } = {},
): Promise<FollowUpItem[]> {
  const now = new Date();
  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  const taskQb = AppDataSource.getRepository(Activity)
    .createQueryBuilder("a")
    .where("a.companyId = :companyId", { companyId })
    .andWhere("a.kind = 'task'")
    .andWhere("a.taskStatus = 'open'")
    .andWhere("a.dueAt IS NOT NULL");
  if (opts.assignedUserId) {
    taskQb.andWhere("a.assignedUserId = :assignedUserId", { assignedUserId: opts.assignedUserId });
  }
  if (opts.assignedEmployeeId) {
    taskQb.andWhere("a.assignedEmployeeId = :assignedEmployeeId", {
      assignedEmployeeId: opts.assignedEmployeeId,
    });
  }
  const [tasks, deals, partnerships] = await Promise.all([
    taskQb.orderBy("a.dueAt", "ASC").take(Math.min(opts.limit ?? 200, 500)).getMany(),
    AppDataSource.getRepository(Deal).find({
      where: {
        companyId,
        status: "open",
        archivedAt: IsNull(),
        nextFollowUpAt: LessThanOrEqual(
          !opts.state || opts.state === "all" || opts.state === "upcoming"
            ? new Date("9999-12-31T23:59:59.999Z")
            : endToday,
        ),
      },
      order: { nextFollowUpAt: "ASC" },
      take: Math.min(opts.limit ?? 200, 500),
    }),
    AppDataSource.getRepository(Partnership).find({
      where: {
        companyId,
        archivedAt: IsNull(),
        nextFollowUpAt: LessThanOrEqual(
          !opts.state || opts.state === "all" || opts.state === "upcoming"
            ? new Date("9999-12-31T23:59:59.999Z")
            : endToday,
        ),
      },
      order: { nextFollowUpAt: "ASC" },
      take: Math.min(opts.limit ?? 200, 500),
    }),
  ]);
  const userIds = [
    ...tasks.map((row) => row.assignedUserId),
    ...deals.map((row) => row.ownerId),
    ...partnerships.map((row) => row.ownerId),
  ].filter((id): id is string => !!id);
  const employeeIds = [
    ...tasks.map((row) => row.assignedEmployeeId),
    ...deals.map((row) => row.ownerEmployeeId),
    ...partnerships.map((row) => row.ownerEmployeeId),
  ].filter((id): id is string => !!id);
  const names = await assigneeNames(companyId, userIds, employeeIds);
  const nameFor = (userId: string | null, employeeId: string | null) =>
    (userId ? names.users.get(userId) : null) ??
    (employeeId ? names.employees.get(employeeId) : null) ??
    null;
  const items: FollowUpItem[] = [
    ...tasks.map((row) => ({
      id: row.id,
      source: "task" as const,
      title: row.subject || "Follow up",
      dueAt: row.dueAt!,
      reminderAt: row.reminderAt,
      status: row.taskStatus ?? "open",
      priority: row.priority ?? "normal",
      overdue: row.dueAt!.getTime() < now.getTime(),
      dealId: row.dealId,
      partnershipId: row.partnershipId,
      contactId: row.contactId,
      customerId: row.customerId,
      assignedUserId: row.assignedUserId,
      assignedEmployeeId: row.assignedEmployeeId,
      assigneeName: nameFor(row.assignedUserId, row.assignedEmployeeId),
      recurrenceRule: row.recurrenceRule,
    })),
    ...deals
      .filter((row) => row.nextFollowUpAt)
      .map((row) => ({
        id: row.id,
        source: "deal" as const,
        title: row.nextStep || `Follow up on ${row.title}`,
        dueAt: row.nextFollowUpAt!,
        reminderAt: row.followUpReminderAt,
        status: "open" as const,
        priority: "normal" as const,
        overdue: row.nextFollowUpAt!.getTime() < now.getTime(),
        dealId: row.id,
        partnershipId: null,
        contactId: row.primaryContactId,
        customerId: row.customerId,
        assignedUserId: row.ownerId,
        assignedEmployeeId: row.ownerEmployeeId,
        assigneeName: nameFor(row.ownerId, row.ownerEmployeeId),
        recurrenceRule: null,
      })),
    ...partnerships
      .filter((row) => row.nextFollowUpAt)
      .map((row) => ({
        id: row.id,
        source: "partnership" as const,
        title: `Follow up with ${row.name}`,
        dueAt: row.nextFollowUpAt!,
        reminderAt: row.reminderAt,
        status: "open" as const,
        priority: "normal" as const,
        overdue: row.nextFollowUpAt!.getTime() < now.getTime(),
        dealId: null,
        partnershipId: row.id,
        contactId: null,
        customerId: row.customerId,
        assignedUserId: row.ownerId,
        assignedEmployeeId: row.ownerEmployeeId,
        assigneeName: nameFor(row.ownerId, row.ownerEmployeeId),
        recurrenceRule: null,
      })),
  ];
  const filtered = items.filter((item) => {
    if (opts.assignedUserId && item.assignedUserId !== opts.assignedUserId) return false;
    if (
      opts.assignedEmployeeId &&
      item.assignedEmployeeId !== opts.assignedEmployeeId
    ) {
      return false;
    }
    if (opts.state === "overdue") return item.overdue;
    if (opts.state === "today") return !item.overdue && item.dueAt <= endToday;
    if (opts.state === "upcoming") return item.dueAt > endToday;
    return true;
  });
  return filtered
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    .slice(0, Math.min(opts.limit ?? 200, 500));
}

export async function createFollowUpTask(
  companyId: string,
  input: TaskWrite & { subject: string },
  actor: ActivityActor,
): Promise<Activity> {
  await assertRevenueOwner(companyId, {
    ownerId: input.assignedUserId,
    ownerEmployeeId: input.assignedEmployeeId,
  });
  await assertRevenueLinks(companyId, input);
  return recordActivity(
    companyId,
    {
      kind: "task",
      ...input,
      occurredAt: new Date(),
      taskStatus: input.taskStatus ?? "open",
      priority: input.priority ?? "normal",
    },
    actor,
  );
}

function nextRecurrence(dueAt: Date, rule: string): Date | null {
  const parts = new Map(
    rule
      .split(";")
      .map((part) => part.split("=", 2))
      .filter((part) => part.length === 2)
      .map(([key, value]) => [key.toUpperCase(), value.toUpperCase()]),
  );
  const interval = Math.max(1, Number.parseInt(parts.get("INTERVAL") ?? "1", 10) || 1);
  const next = new Date(dueAt);
  if (parts.get("FREQ") === "DAILY") next.setUTCDate(next.getUTCDate() + interval);
  else if (parts.get("FREQ") === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7 * interval);
  else if (parts.get("FREQ") === "MONTHLY") next.setUTCMonth(next.getUTCMonth() + interval);
  else return null;
  return next;
}

export async function updateFollowUpTask(
  companyId: string,
  id: string,
  patch: TaskWrite,
  actor: ActivityActor,
): Promise<Activity | null> {
  const repo = AppDataSource.getRepository(Activity);
  const row = await repo.findOneBy({ companyId, id, kind: "task" });
  if (!row) return null;
  await assertRevenueOwner(companyId, {
    ownerId: patch.assignedUserId,
    ownerEmployeeId: patch.assignedEmployeeId,
  });
  await assertRevenueLinks(companyId, patch);
  if (patch.subject !== undefined) row.subject = patch.subject.slice(0, 500);
  if (patch.bodyText !== undefined) row.bodyText = patch.bodyText.slice(0, 8_000);
  if (patch.dueAt !== undefined) row.dueAt = patch.dueAt;
  if (patch.reminderAt !== undefined) row.reminderAt = patch.reminderAt;
  if (patch.priority !== undefined) row.priority = patch.priority;
  if (patch.assignedUserId !== undefined) {
    row.assignedUserId = patch.assignedUserId;
    if (patch.assignedUserId) row.assignedEmployeeId = null;
  }
  if (patch.assignedEmployeeId !== undefined) {
    row.assignedEmployeeId = patch.assignedEmployeeId;
    if (patch.assignedEmployeeId) row.assignedUserId = null;
  }
  if (patch.recurrenceRule !== undefined) row.recurrenceRule = patch.recurrenceRule;
  if (patch.taskStatus !== undefined) {
    row.taskStatus = patch.taskStatus;
    row.completedAt = patch.taskStatus === "completed" ? new Date() : null;
  }
  const saved = await repo.save(row);
  if (
    patch.taskStatus === "completed" &&
    row.recurrenceRule &&
    row.dueAt &&
    !(await repo.findOne({
      where: {
        companyId,
        kind: "task",
        metaJson: JSON.stringify({ recurringFromId: row.id }),
      },
    }))
  ) {
    const nextDue = nextRecurrence(row.dueAt, row.recurrenceRule);
    if (nextDue) {
      await recordActivity(
        companyId,
        {
          kind: "task",
          subject: row.subject,
          bodyText: row.bodyText,
          dueAt: nextDue,
          reminderAt: row.reminderAt
            ? new Date(nextDue.getTime() - Math.max(0, row.dueAt.getTime() - row.reminderAt.getTime()))
            : null,
          assignedUserId: row.assignedUserId,
          assignedEmployeeId: row.assignedEmployeeId,
          priority: row.priority ?? "normal",
          recurrenceRule: row.recurrenceRule,
          contactId: row.contactId,
          dealId: row.dealId,
          customerId: row.customerId,
          partnershipId: row.partnershipId,
          meta: { recurringFromId: row.id },
        },
        actor,
      );
    }
  }
  return saved;
}
