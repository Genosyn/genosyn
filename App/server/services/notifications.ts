import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import {
  Notification,
  NotificationActorKind,
  NotificationEntityKind,
  NotificationKind,
} from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Membership } from "../db/entities/Membership.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Approval } from "../db/entities/Approval.js";
import { broadcastToCompany } from "./realtime.js";

/**
 * Notification feed service. Generators (mention parser, todo-review hook,
 * approval cron) call `createNotification` / `createNotifications`; the
 * top-bar bell calls `listForUser` + `countUnreadForUser`.
 *
 * One row = one bell entry. We don't dedupe in v1 — if Sarah mentions you
 * three times in a row that's three rows. Easy to layer a `dedupeKey`
 * column on later if the panel gets noisy.
 *
 * Every write fires a `notification.new` WebSocket event scoped to the
 * recipient's company so the bell can bump live without polling.
 */

export type CreateNotificationInput = {
  companyId: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  link?: string | null;
  actorKind?: NotificationActorKind | null;
  actorId?: string | null;
  entityKind?: NotificationEntityKind | null;
  entityId?: string | null;
};

export type NotificationDTO = {
  id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  actor:
    | {
        kind: NotificationActorKind;
        id: string | null;
        name: string;
        avatarKey: string | null;
        slug: string | null;
      }
    | null;
  entityKind: NotificationEntityKind | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};

function repo() {
  return AppDataSource.getRepository(Notification);
}

export async function createNotification(
  input: CreateNotificationInput,
): Promise<Notification> {
  const [row] = await createNotifications([input]);
  return row;
}

export async function createNotifications(
  inputs: CreateNotificationInput[],
): Promise<Notification[]> {
  if (inputs.length === 0) return [];
  const r = repo();
  const rows = inputs.map((i) =>
    r.create({
      companyId: i.companyId,
      userId: i.userId,
      kind: i.kind,
      title: i.title,
      body: i.body ?? "",
      link: i.link ?? null,
      actorKind: i.actorKind ?? null,
      actorId: i.actorId ?? null,
      entityKind: i.entityKind ?? null,
      entityId: i.entityId ?? null,
      readAt: null,
    }),
  );
  await r.save(rows);

  // Hydrate so the WS payload is identical to the REST shape — saves a
  // refetch on the client when a fresh row arrives.
  const dtos = await hydrate(rows);
  for (const dto of dtos) {
    const recipient = rows.find((row) => row.id === dto.id);
    if (!recipient) continue;
    broadcastToCompany(recipient.companyId, {
      type: "notification.new",
      userId: recipient.userId,
      notification: dto,
    });
  }
  return rows;
}

export async function listForUser(params: {
  companyId: string;
  userId: string;
  limit: number;
  before?: string;
}): Promise<NotificationDTO[]> {
  const qb = repo()
    .createQueryBuilder("n")
    .where("n.companyId = :companyId", { companyId: params.companyId })
    .andWhere("n.userId = :userId", { userId: params.userId })
    .orderBy("n.createdAt", "DESC")
    .take(params.limit);
  if (params.before) {
    qb.andWhere("n.createdAt < :before", { before: params.before });
  }
  const rows = await qb.getMany();
  return hydrate(rows);
}

export async function countUnreadForUser(params: {
  companyId: string;
  userId: string;
}): Promise<number> {
  return repo().count({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      readAt: IsNull(),
    },
  });
}

export async function markRead(params: {
  id: string;
  companyId: string;
  userId: string;
}): Promise<void> {
  const row = await repo().findOneBy({
    id: params.id,
    companyId: params.companyId,
    userId: params.userId,
  });
  if (!row) return;
  if (row.readAt) return;
  row.readAt = new Date();
  await repo().save(row);
  broadcastToCompany(row.companyId, {
    type: "notification.read",
    userId: row.userId,
    notificationIds: [row.id],
  });
}

export async function markAllRead(params: {
  companyId: string;
  userId: string;
}): Promise<void> {
  const unread = await repo().find({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      readAt: IsNull(),
    },
    select: ["id"],
  });
  if (unread.length === 0) return;
  const now = new Date();
  await repo().update(
    { id: In(unread.map((r) => r.id)) },
    { readAt: now },
  );
  broadcastToCompany(params.companyId, {
    type: "notification.read",
    userId: params.userId,
    notificationIds: unread.map((r) => r.id),
  });
}

/**
 * Best-effort cleanup when an entity disappears (e.g. todo deleted, message
 * soft-deleted). Drops dangling notification rows so the bell doesn't link
 * to 404 pages. Safe to call from a route handler — failures are swallowed
 * by the caller; correctness of the feed doesn't depend on this running.
 */
export async function deleteForEntity(params: {
  entityKind: NotificationEntityKind;
  entityId: string;
}): Promise<void> {
  await repo().delete({
    entityKind: params.entityKind,
    entityId: params.entityId,
  });
}

/**
 * Bell-notify everyone who can sign off on a pending approval — owners and
 * admins of the company. Members can't approve, so they're not paged.
 * Caller saves the Approval row first; we look up the routine/employee
 * names from it for the title.
 */
export async function notifyApprovalPending(approval: Approval): Promise<void> {
  const [company, routine, employee, memberships] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: approval.companyId }),
    AppDataSource.getRepository(Routine).findOneBy({ id: approval.routineId }),
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: approval.employeeId,
    }),
    AppDataSource.getRepository(Membership).find({
      where: { companyId: approval.companyId, role: In(["owner", "admin"]) },
    }),
  ]);
  if (!company || !routine || !employee || memberships.length === 0) return;

  const inputs = memberships.map((m) => ({
    companyId: approval.companyId,
    userId: m.userId,
    kind: "approval_pending" as const,
    title: `${employee.name} requested approval to run "${routine.name}"`,
    body: "Cron tick is gated; an admin needs to approve or reject.",
    link: `/c/${company.slug}/approvals`,
    actorKind: "ai" as const,
    actorId: employee.id,
    entityKind: "approval" as const,
    entityId: approval.id,
  }));
  await createNotifications(inputs);
}

/**
 * Drop already-read notifications for a user. Powers the panel "Clear all
 * read" affordance. Unread rows are kept so a forgotten mention can't be
 * silently lost from a stale browser tab.
 */
export async function clearReadForUser(params: {
  companyId: string;
  userId: string;
}): Promise<number> {
  const r = await repo().delete({
    companyId: params.companyId,
    userId: params.userId,
    readAt: Not(IsNull()),
  });
  return r.affected ?? 0;
}

// ───────────────── Hydration (DB row → API DTO) ─────────────────────────

async function hydrate(rows: Notification[]): Promise<NotificationDTO[]> {
  if (rows.length === 0) return [];

  const userIds = new Set<string>();
  const empIds = new Set<string>();
  for (const r of rows) {
    if (!r.actorId) continue;
    if (r.actorKind === "user") userIds.add(r.actorId);
    else if (r.actorKind === "ai") empIds.add(r.actorId);
  }
  const [users, employees] = await Promise.all([
    userIds.size
      ? AppDataSource.getRepository(User).findBy({
          id: In(Array.from(userIds)),
        })
      : Promise.resolve([]),
    empIds.size
      ? AppDataSource.getRepository(AIEmployee).findBy({
          id: In(Array.from(empIds)),
        })
      : Promise.resolve([]),
  ]);
  const userMap = new Map(users.map((u) => [u.id, u]));
  const empMap = new Map(employees.map((e) => [e.id, e]));

  return rows.map((r) => {
    let actor: NotificationDTO["actor"] = null;
    if (r.actorKind === "system") {
      actor = {
        kind: "system",
        id: null,
        name: "System",
        avatarKey: null,
        slug: null,
      };
    } else if (r.actorKind === "user" && r.actorId) {
      const u = userMap.get(r.actorId);
      if (u) {
        actor = {
          kind: "user",
          id: u.id,
          name: u.name || u.email,
          avatarKey: u.avatarKey ?? null,
          slug: null,
        };
      }
    } else if (r.actorKind === "ai" && r.actorId) {
      const e = empMap.get(r.actorId);
      if (e) {
        actor = {
          kind: "ai",
          id: e.id,
          name: e.name,
          avatarKey: e.avatarKey ?? null,
          slug: e.slug,
        };
      }
    }

    return {
      id: r.id,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      actor,
      entityKind: r.entityKind,
      entityId: r.entityId,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  });
}
