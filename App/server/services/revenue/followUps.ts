import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import {
  Activity,
  type ActivityPriority,
  type ActivityTaskStatus,
} from "../../db/entities/Activity.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Contact } from "../../db/entities/Contact.js";
import { Customer } from "../../db/entities/Customer.js";
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
  createdAt: Date;
  dealStatus: "open" | "won" | "lost" | null;
  dealStageId: string | null;
};

type DecodedFollowUpCursor = {
  dueAt: Date;
  source: FollowUpItem["source"];
  id: string;
};

const FOLLOW_UP_SOURCE_ORDER: FollowUpItem["source"][] = ["deal", "partnership", "task"];

function compareFollowUpSources(
  left: FollowUpItem["source"],
  right: FollowUpItem["source"],
): number {
  return FOLLOW_UP_SOURCE_ORDER.indexOf(left) - FOLLOW_UP_SOURCE_ORDER.indexOf(right);
}

function followUpCursorClause(
  source: FollowUpItem["source"],
  dueAtColumn: string,
  idColumn: string,
  cursor: DecodedFollowUpCursor,
): { sql: string; params: { cursorDueAt: Date; cursorId?: string } } {
  const sourceOrder = compareFollowUpSources(source, cursor.source);
  if (sourceOrder < 0) {
    return {
      sql: `${dueAtColumn} > :cursorDueAt`,
      params: { cursorDueAt: cursor.dueAt },
    };
  }
  if (sourceOrder > 0) {
    return {
      sql: `${dueAtColumn} >= :cursorDueAt`,
      params: { cursorDueAt: cursor.dueAt },
    };
  }
  return {
    sql: `(${dueAtColumn} > :cursorDueAt OR (${dueAtColumn} = :cursorDueAt AND ${idColumn} > :cursorId))`,
    params: { cursorDueAt: cursor.dueAt, cursorId: cursor.id },
  };
}

export type FollowUpListOptions = {
  state?: "all" | "overdue" | "today" | "upcoming";
  source?: "task" | "deal" | "partnership";
  assignedUserId?: string;
  assignedEmployeeId?: string;
  unassigned?: boolean;
  priority?: ActivityPriority;
  status?: ActivityTaskStatus;
  linkedResourceType?: "account" | "contact" | "deal" | "partnership";
  linkedResourceId?: string;
  dueFrom?: Date;
  dueTo?: Date;
  createdBefore?: Date;
  staleBefore?: Date;
  dealStageId?: string;
  dealStatus?: "open" | "won" | "lost";
  closedDeals?: "include" | "only" | "exclude";
  archivedResources?: "include" | "only" | "exclude";
  accountStatus?: "prospect" | "customer" | "former";
  q?: string;
  reminderFrom?: Date;
  reminderTo?: Date;
  overdueMinDays?: number;
  overdueMaxDays?: number;
  cursor?: string;
  limit?: number;
  offset?: number;
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
  opts: FollowUpListOptions = {},
): Promise<FollowUpItem[]> {
  const now = new Date();
  const endToday = new Date(now);
  endToday.setHours(23, 59, 59, 999);
  const cursor = opts.cursor ? decodeFollowUpCursor(opts.cursor) : null;
  const pageLimit = Math.min(Math.max(opts.limit ?? 200, 1), 5_000);
  const rowOffset = opts.cursor ? 0 : Math.max(opts.offset ?? 0, 0);
  const maxRows = pageLimit + rowOffset;
  const taskQb = AppDataSource.getRepository(Activity)
    .createQueryBuilder("a")
    .where("a.companyId = :companyId", { companyId })
    .andWhere("a.kind = 'task'")
    .andWhere("a.taskStatus = :taskStatus", { taskStatus: opts.status ?? "open" })
    .andWhere("a.dueAt IS NOT NULL")
    .leftJoin(Deal, "taskDeal", "taskDeal.companyId = a.companyId AND taskDeal.id = a.dealId")
    .leftJoin(
      Contact,
      "taskContact",
      "taskContact.companyId = a.companyId AND taskContact.id = a.contactId",
    )
    .leftJoin(
      Partnership,
      "taskPartnership",
      "taskPartnership.companyId = a.companyId AND taskPartnership.id = a.partnershipId",
    )
    .leftJoin(
      Customer,
      "taskAccount",
      "taskAccount.companyId = a.companyId AND taskAccount.id = COALESCE(a.customerId, taskDeal.customerId, taskPartnership.customerId)",
    );
  const dealQb = AppDataSource.getRepository(Deal)
    .createQueryBuilder("d")
    .where("d.companyId = :companyId", { companyId })
    .andWhere("d.nextFollowUpAt IS NOT NULL")
    .leftJoin(
      Customer,
      "dealAccount",
      "dealAccount.companyId = d.companyId AND dealAccount.id = d.customerId",
    );
  const partnershipQb = AppDataSource.getRepository(Partnership)
    .createQueryBuilder("p")
    .where("p.companyId = :companyId", { companyId })
    .andWhere("p.nextFollowUpAt IS NOT NULL")
    .leftJoin(
      Customer,
      "partnershipAccount",
      "partnershipAccount.companyId = p.companyId AND partnershipAccount.id = p.customerId",
    );

  if (opts.archivedResources === "only") {
    taskQb.andWhere(
      "(taskDeal.archivedAt IS NOT NULL OR taskContact.archivedAt IS NOT NULL OR taskPartnership.archivedAt IS NOT NULL OR taskAccount.archivedAt IS NOT NULL)",
    );
    dealQb.andWhere("d.archivedAt IS NOT NULL");
    partnershipQb.andWhere("p.archivedAt IS NOT NULL");
  } else if (opts.archivedResources !== "include") {
    taskQb
      .andWhere("(a.dealId IS NULL OR taskDeal.archivedAt IS NULL)")
      .andWhere("(a.contactId IS NULL OR taskContact.archivedAt IS NULL)")
      .andWhere("(a.partnershipId IS NULL OR taskPartnership.archivedAt IS NULL)")
      .andWhere("(taskAccount.id IS NULL OR taskAccount.archivedAt IS NULL)");
    dealQb.andWhere("d.archivedAt IS NULL");
    partnershipQb.andWhere("p.archivedAt IS NULL");
  }

  if (opts.source && opts.source !== "task") taskQb.andWhere("1 = 0");
  if (opts.source && opts.source !== "deal") dealQb.andWhere("1 = 0");
  if (opts.source && opts.source !== "partnership") partnershipQb.andWhere("1 = 0");
  if (opts.status && opts.status !== "open") {
    dealQb.andWhere("1 = 0");
    partnershipQb.andWhere("1 = 0");
  }
  if (opts.assignedUserId) {
    taskQb.andWhere("a.assignedUserId = :assignedUserId", { assignedUserId: opts.assignedUserId });
    dealQb.andWhere("d.ownerId = :assignedUserId", { assignedUserId: opts.assignedUserId });
    partnershipQb.andWhere("p.ownerId = :assignedUserId", {
      assignedUserId: opts.assignedUserId,
    });
  }
  if (opts.assignedEmployeeId) {
    taskQb.andWhere("a.assignedEmployeeId = :assignedEmployeeId", {
      assignedEmployeeId: opts.assignedEmployeeId,
    });
    dealQb.andWhere("d.ownerEmployeeId = :assignedEmployeeId", {
      assignedEmployeeId: opts.assignedEmployeeId,
    });
    partnershipQb.andWhere("p.ownerEmployeeId = :assignedEmployeeId", {
      assignedEmployeeId: opts.assignedEmployeeId,
    });
  }
  if (opts.unassigned) {
    taskQb.andWhere("a.assignedUserId IS NULL AND a.assignedEmployeeId IS NULL");
    dealQb.andWhere("d.ownerId IS NULL AND d.ownerEmployeeId IS NULL");
    partnershipQb.andWhere("p.ownerId IS NULL AND p.ownerEmployeeId IS NULL");
  }
  if (opts.priority) {
    taskQb.andWhere("a.priority = :priority", { priority: opts.priority });
    dealQb.andWhere("1 = 0");
    partnershipQb.andWhere("1 = 0");
  }
  if (opts.q) {
    const q = `%${opts.q.toLowerCase()}%`;
    taskQb.andWhere("(LOWER(a.subject) LIKE :q OR LOWER(a.bodyText) LIKE :q)", { q });
    dealQb.andWhere("(LOWER(d.title) LIKE :q OR LOWER(d.nextStep) LIKE :q)", { q });
    partnershipQb.andWhere(
      "(LOWER(p.name) LIKE :q OR LOWER(p.notes) LIKE :q OR LOWER(p.integrationContext) LIKE :q)",
      { q },
    );
  }
  if (opts.accountStatus) {
    taskQb.andWhere("taskAccount.accountStatus = :accountStatus", {
      accountStatus: opts.accountStatus,
    });
    dealQb.andWhere("dealAccount.accountStatus = :accountStatus", {
      accountStatus: opts.accountStatus,
    });
    partnershipQb.andWhere("partnershipAccount.accountStatus = :accountStatus", {
      accountStatus: opts.accountStatus,
    });
  }
  if (opts.linkedResourceType && opts.linkedResourceId) {
    if (opts.linkedResourceType === "account") {
      taskQb.andWhere(
        "COALESCE(a.customerId, taskDeal.customerId, taskPartnership.customerId) = :linkedResourceId",
        { linkedResourceId: opts.linkedResourceId },
      );
    } else {
      taskQb.andWhere(`a.${opts.linkedResourceType}Id = :linkedResourceId`, {
        linkedResourceId: opts.linkedResourceId,
      });
    }
    if (opts.linkedResourceType === "deal") {
      dealQb.andWhere("d.id = :linkedResourceId", { linkedResourceId: opts.linkedResourceId });
      partnershipQb.andWhere("1 = 0");
    } else if (opts.linkedResourceType === "partnership") {
      dealQb.andWhere("1 = 0");
      partnershipQb.andWhere("p.id = :linkedResourceId", {
        linkedResourceId: opts.linkedResourceId,
      });
    } else if (opts.linkedResourceType === "account") {
      dealQb.andWhere("d.customerId = :linkedResourceId", {
        linkedResourceId: opts.linkedResourceId,
      });
      partnershipQb.andWhere("p.customerId = :linkedResourceId", {
        linkedResourceId: opts.linkedResourceId,
      });
    } else {
      dealQb.andWhere("d.primaryContactId = :linkedResourceId", {
        linkedResourceId: opts.linkedResourceId,
      });
      partnershipQb.andWhere("1 = 0");
    }
  }
  if (opts.dueFrom) {
    taskQb.andWhere("a.dueAt >= :dueFrom", { dueFrom: opts.dueFrom });
    dealQb.andWhere("d.nextFollowUpAt >= :dueFrom", { dueFrom: opts.dueFrom });
    partnershipQb.andWhere("p.nextFollowUpAt >= :dueFrom", { dueFrom: opts.dueFrom });
  }
  if (opts.dueTo) {
    taskQb.andWhere("a.dueAt <= :dueTo", { dueTo: opts.dueTo });
    dealQb.andWhere("d.nextFollowUpAt <= :dueTo", { dueTo: opts.dueTo });
    partnershipQb.andWhere("p.nextFollowUpAt <= :dueTo", { dueTo: opts.dueTo });
  }
  if (opts.state === "overdue") {
    taskQb.andWhere("a.dueAt < :now", { now });
    dealQb.andWhere("d.nextFollowUpAt < :now", { now });
    partnershipQb.andWhere("p.nextFollowUpAt < :now", { now });
  } else if (opts.state === "today") {
    taskQb.andWhere("a.dueAt >= :now AND a.dueAt <= :endToday", { now, endToday });
    dealQb.andWhere("d.nextFollowUpAt >= :now AND d.nextFollowUpAt <= :endToday", {
      now,
      endToday,
    });
    partnershipQb.andWhere("p.nextFollowUpAt >= :now AND p.nextFollowUpAt <= :endToday", {
      now,
      endToday,
    });
  } else if (opts.state === "upcoming") {
    taskQb.andWhere("a.dueAt > :endToday", { endToday });
    dealQb.andWhere("d.nextFollowUpAt > :endToday", { endToday });
    partnershipQb.andWhere("p.nextFollowUpAt > :endToday", { endToday });
  }
  if (opts.reminderFrom) {
    taskQb.andWhere("a.reminderAt >= :reminderFrom", { reminderFrom: opts.reminderFrom });
    dealQb.andWhere("d.followUpReminderAt >= :reminderFrom", {
      reminderFrom: opts.reminderFrom,
    });
    partnershipQb.andWhere("p.reminderAt >= :reminderFrom", {
      reminderFrom: opts.reminderFrom,
    });
  }
  if (opts.reminderTo) {
    taskQb.andWhere("a.reminderAt <= :reminderTo", { reminderTo: opts.reminderTo });
    dealQb.andWhere("d.followUpReminderAt <= :reminderTo", { reminderTo: opts.reminderTo });
    partnershipQb.andWhere("p.reminderAt <= :reminderTo", { reminderTo: opts.reminderTo });
  }
  const overdueMinDate =
    opts.overdueMinDays === undefined
      ? null
      : new Date(now.getTime() - Math.max(opts.overdueMinDays, 0) * 86_400_000);
  const overdueMaxDate =
    opts.overdueMaxDays === undefined
      ? null
      : new Date(now.getTime() - Math.max(opts.overdueMaxDays, 0) * 86_400_000);
  if (overdueMinDate) {
    taskQb.andWhere("a.dueAt <= :overdueMinDate", { overdueMinDate });
    dealQb.andWhere("d.nextFollowUpAt <= :overdueMinDate", { overdueMinDate });
    partnershipQb.andWhere("p.nextFollowUpAt <= :overdueMinDate", { overdueMinDate });
  }
  if (overdueMaxDate) {
    taskQb.andWhere("a.dueAt >= :overdueMaxDate", { overdueMaxDate });
    dealQb.andWhere("d.nextFollowUpAt >= :overdueMaxDate", { overdueMaxDate });
    partnershipQb.andWhere("p.nextFollowUpAt >= :overdueMaxDate", { overdueMaxDate });
  }
  if (opts.staleBefore) {
    taskQb.andWhere("a.dueAt <= :staleBefore", { staleBefore: opts.staleBefore });
    dealQb.andWhere("d.nextFollowUpAt <= :staleBefore", {
      staleBefore: opts.staleBefore,
    });
    partnershipQb.andWhere("p.nextFollowUpAt <= :staleBefore", {
      staleBefore: opts.staleBefore,
    });
  }
  if (opts.createdBefore) {
    taskQb.andWhere("a.createdAt <= :createdBefore", { createdBefore: opts.createdBefore });
    dealQb.andWhere("d.createdAt <= :createdBefore", { createdBefore: opts.createdBefore });
    partnershipQb.andWhere("p.createdAt <= :createdBefore", {
      createdBefore: opts.createdBefore,
    });
  }
  if (opts.closedDeals === "exclude") {
    taskQb.andWhere("(a.dealId IS NULL OR taskDeal.status = 'open')");
  }
  if (opts.dealStageId) {
    dealQb.andWhere("d.stageId = :dealStageId", { dealStageId: opts.dealStageId });
    taskQb.andWhere("taskDeal.stageId = :dealStageId", { dealStageId: opts.dealStageId });
  }
  if (opts.dealStatus) {
    dealQb.andWhere("d.status = :dealStatus", { dealStatus: opts.dealStatus });
    taskQb.andWhere("taskDeal.status = :dealStatus", { dealStatus: opts.dealStatus });
  } else if (opts.closedDeals === "only") {
    dealQb.andWhere("d.status IN ('won', 'lost')");
    taskQb.andWhere("taskDeal.status IN ('won', 'lost')");
  } else if (opts.closedDeals !== "include") {
    dealQb.andWhere("d.status = 'open'");
  }
  if (cursor) {
    const taskCursor = followUpCursorClause("task", "a.dueAt", "a.id", cursor);
    taskQb.andWhere(taskCursor.sql, taskCursor.params);
    const dealCursor = followUpCursorClause("deal", "d.nextFollowUpAt", "d.id", cursor);
    dealQb.andWhere(dealCursor.sql, dealCursor.params);
    const partnershipCursor = followUpCursorClause(
      "partnership",
      "p.nextFollowUpAt",
      "p.id",
      cursor,
    );
    partnershipQb.andWhere(partnershipCursor.sql, partnershipCursor.params);
  }
  const [tasks, deals, partnerships] = await Promise.all([
    taskQb.orderBy("a.dueAt", "ASC").addOrderBy("a.id", "ASC").take(maxRows).getMany(),
    dealQb.orderBy("d.nextFollowUpAt", "ASC").addOrderBy("d.id", "ASC").take(maxRows).getMany(),
    partnershipQb
      .orderBy("p.nextFollowUpAt", "ASC")
      .addOrderBy("p.id", "ASC")
      .take(maxRows)
      .getMany(),
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
      createdAt: row.createdAt,
      dealStatus: null,
      dealStageId: null,
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
        createdAt: row.createdAt,
        dealStatus: row.status,
        dealStageId: row.stageId,
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
        createdAt: row.createdAt,
        dealStatus: null,
        dealStageId: null,
      })),
  ];
  const sorted = items.sort(
    (a, b) =>
      a.dueAt.getTime() - b.dueAt.getTime() ||
      compareFollowUpSources(a.source, b.source) ||
      a.id.localeCompare(b.id),
  );
  return sorted.slice(rowOffset, rowOffset + pageLimit);
}

function decodeFollowUpCursor(cursor: string): DecodedFollowUpCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      dueAt?: unknown;
      source?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.dueAt !== "string" ||
      !["task", "deal", "partnership"].includes(String(parsed.source)) ||
      typeof parsed.id !== "string"
    ) {
      return null;
    }
    const dueAt = new Date(parsed.dueAt);
    if (Number.isNaN(dueAt.getTime())) return null;
    return {
      dueAt,
      source: parsed.source as FollowUpItem["source"],
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

export function followUpCursor(item: FollowUpItem): string {
  return Buffer.from(
    JSON.stringify({
      dueAt: item.dueAt.toISOString(),
      source: item.source,
      id: item.id,
    }),
  ).toString("base64url");
}

export async function listFollowUpPage(
  companyId: string,
  opts: FollowUpListOptions = {},
): Promise<{ rows: FollowUpItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const rows = await listFollowUps(companyId, { ...opts, limit: limit + 1 });
  const page = rows.slice(0, limit);
  return {
    rows: page,
    nextCursor: rows.length > limit && page.length > 0 ? followUpCursor(page.at(-1)!) : null,
  };
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
            ? new Date(
                nextDue.getTime() - Math.max(0, row.dueAt.getTime() - row.reminderAt.getTime()),
              )
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
