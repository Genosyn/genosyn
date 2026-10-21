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
import { sendPushToUser } from "./push.js";
import { redactApprovalSummary } from "./approvalRedaction.js";
import { companyNotificationLink, needsCompanyPrefix } from "../../shared/notificationLink.js";

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

/**
 * The kinds that also reach a person's phone or desktop as a push. Every row
 * lands in the bell, but a push interrupts, so it is kept for what needs a
 * person now — a question or an Approval that holds up work, a mention, a
 * review someone named you for, an email handed to you, a follow-up you set —
 * and for the few events an owner hears about at once: a Goal settled or
 * waiting for someone to confirm it was met, a Budget spent, a Standdown placed,
 * the monthly letter to the board, an applicant the AI screener rated a strong
 * match for an Opening the recipient owns.
 *
 * The rest wait quietly in the bell and on Home: a failed or off-goal Run, a
 * reminder about something already pushed, a proposed edit or Initiative to
 * review, a Finance review, a revoked Waiver, an overdue Handoff. They are the
 * company's own work to sort out, and paging a person for each is how a
 * notification stops meaning anything.
 */
export const PUSHED_NOTIFICATION_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "mention",
  "todo_review_requested",
  "approval_pending",
  "decision_pending",
  "mail_handover",
  "revenue_follow_up",
  "goal_achieved",
  "goal_missed",
  "goal_confirmation_pending",
  "budget_exhausted",
  "standdown_placed",
  "board_letter_ready",
  "recruiting_strong_match",
]);

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
  actor: {
    kind: NotificationActorKind;
    id: string | null;
    name: string;
    avatarKey: string | null;
    slug: string | null;
  } | null;
  entityKind: NotificationEntityKind | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
};

function repo() {
  return AppDataSource.getRepository(Notification);
}

export async function createNotification(input: CreateNotificationInput): Promise<Notification> {
  const [row] = await createNotifications([input]);
  return row;
}

export async function createNotifications(
  inputs: CreateNotificationInput[],
): Promise<Notification[]> {
  if (inputs.length === 0) return [];
  const r = repo();
  // A bare section path ("/goals") is stored inside its company
  // ("/c/acme/goals"), so the bell, Home and a push all open the right page
  // of the right company — the router sends a bare path to the first
  // company's Home.
  const bare = [
    ...new Set(inputs.filter((i) => needsCompanyPrefix(i.link)).map((i) => i.companyId)),
  ];
  const slugs = new Map<string, string>();
  if (bare.length > 0) {
    const companies = await AppDataSource.getRepository(Company).find({
      where: { id: In(bare) },
      select: { id: true, slug: true },
    });
    for (const company of companies) slugs.set(company.id, company.slug);
  }
  const linkFor = (i: CreateNotificationInput): string | null => {
    const slug = slugs.get(i.companyId);
    return slug ? companyNotificationLink(slug, i.link) : (i.link ?? null);
  };
  const rows = inputs.map((i) =>
    r.create({
      companyId: i.companyId,
      userId: i.userId,
      kind: i.kind,
      title: i.title,
      body: i.body ?? "",
      link: linkFor(i),
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

  // Fan out to the recipient's PWA devices — only the kinds that need a
  // person now (`PUSHED_NOTIFICATION_KINDS`). Fire-and-forget: push delivery
  // must never delay or fail the write that produced the bell row.
  for (const row of rows) {
    if (!PUSHED_NOTIFICATION_KINDS.has(row.kind)) continue;
    void sendPushToUser(row.userId, {
      title: row.title,
      body: row.body,
      link: row.link ?? "/",
      tag: `genosyn-notification-${row.id}`,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[notifications] push fan-out failed:", err);
    });
  }
  return rows;
}

/**
 * `kind` matching none of `excludeKinds`, or no condition when there are none.
 * The bell lists, counts, marks and clears with the same kinds left out, so a
 * row the reader may no longer see is neither shown to them nor changed by
 * them (`notificationKindsHiddenFrom` in `boardLetterReads.ts`).
 */
function kindFilter(excludeKinds: readonly NotificationKind[] | undefined) {
  return excludeKinds && excludeKinds.length > 0 ? { kind: Not(In([...excludeKinds])) } : {};
}

/**
 * Unread rows only, newest first — powers the Home page "needs your
 * attention" card without dragging in already-read history. `excludeKinds`
 * leaves out rows the reader may no longer see, such as a letter to the board
 * that reached them while they were an admin.
 */
export async function listUnreadForUser(params: {
  companyId: string;
  userId: string;
  limit: number;
  excludeKinds?: readonly NotificationKind[];
}): Promise<NotificationDTO[]> {
  const rows = await repo().find({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      readAt: IsNull(),
      ...kindFilter(params.excludeKinds),
    },
    order: { createdAt: "DESC" },
    take: params.limit,
  });
  return hydrate(rows);
}

export async function listForUser(params: {
  companyId: string;
  userId: string;
  limit: number;
  before?: string;
  excludeKinds?: readonly NotificationKind[];
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
  if (params.excludeKinds && params.excludeKinds.length > 0) {
    qb.andWhere("n.kind NOT IN (:...excludeKinds)", { excludeKinds: [...params.excludeKinds] });
  }
  const rows = await qb.getMany();
  return hydrate(rows);
}

export async function countUnreadForUser(params: {
  companyId: string;
  userId: string;
  excludeKinds?: readonly NotificationKind[];
}): Promise<number> {
  return repo().count({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      readAt: IsNull(),
      ...kindFilter(params.excludeKinds),
    },
  });
}

export async function markRead(params: {
  id: string;
  companyId: string;
  userId: string;
  excludeKinds?: readonly NotificationKind[];
}): Promise<void> {
  const row = await repo().findOneBy({
    id: params.id,
    companyId: params.companyId,
    userId: params.userId,
    ...kindFilter(params.excludeKinds),
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
  excludeKinds?: readonly NotificationKind[];
}): Promise<void> {
  const unread = await repo().find({
    where: {
      companyId: params.companyId,
      userId: params.userId,
      readAt: IsNull(),
      ...kindFilter(params.excludeKinds),
    },
    select: ["id"],
  });
  if (unread.length === 0) return;
  const now = new Date();
  await repo().update({ id: In(unread.map((r) => r.id)) }, { readAt: now });
  broadcastToCompany(params.companyId, {
    type: "notification.read",
    userId: params.userId,
    notificationIds: unread.map((r) => r.id),
  });
}

/**
 * Mark every unread bell for one shared entity as read for every recipient,
 * or for one recipient when `userId` is given.
 *
 * Resolving or snoozing a shared row changes it for the whole company, so a
 * stale bell must not keep telling another Member that the old state still
 * needs attention. Reading a letter to the board is one person's, so it
 * passes that person. Grouping the normal `notification.read` frame by
 * recipient keeps each connected badge in sync with the bulk update.
 */
export async function markEntityNotificationsRead(params: {
  companyId: string;
  entityKind: NotificationEntityKind;
  entityId: string;
  userId?: string;
}): Promise<void> {
  const unread = await repo().find({
    where: {
      companyId: params.companyId,
      entityKind: params.entityKind,
      entityId: params.entityId,
      readAt: IsNull(),
      ...(params.userId ? { userId: params.userId } : {}),
    },
    select: ["id", "userId"],
  });
  if (unread.length === 0) return;

  await repo().update({ id: In(unread.map((row) => row.id)) }, { readAt: new Date() });
  const idsByUser = new Map<string, string[]>();
  for (const row of unread) {
    const ids = idsByUser.get(row.userId) ?? [];
    ids.push(row.id);
    idsByUser.set(row.userId, ids);
  }
  for (const [userId, notificationIds] of idsByUser) {
    broadcastToCompany(params.companyId, {
      type: "notification.read",
      userId,
      notificationIds,
    });
  }
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
 * Caller saves the Approval row first. Kind-agnostic: routine approvals
 * derive their copy from the joined Routine row, every other kind (payment,
 * browser action, ad spend, guarded MCP tool, …) from the Approval's own
 * `title`/`summary` — so a new kind gets notifications without touching
 * this function.
 */
export async function notifyApprovalPending(approval: Approval): Promise<void> {
  const [company, routine, employee, memberships] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: approval.companyId }),
    approval.routineId
      ? AppDataSource.getRepository(Routine).findOneBy({ id: approval.routineId })
      : Promise.resolve(null),
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: approval.employeeId,
    }),
    AppDataSource.getRepository(Membership).find({
      where: { companyId: approval.companyId, role: In(["owner", "admin"]) },
    }),
  ]);
  if (!company || !employee || memberships.length === 0) return;
  if (approval.kind === "routine" && !routine) return;

  const copy =
    approval.kind === "routine" && routine
      ? {
          title: `${employee.name} requested approval to run "${routine.name}"`,
          body: "Cron tick is gated; an admin needs to approve or reject.",
        }
      : approval.kind === "mail_send"
        ? {
            title: `${employee.name} prepared an email for review`,
            body: `${redactApprovalSummary(approval.title) ?? "An email"} is ready to edit, send, or discard in the Decision stack.`,
          }
        : approval.kind === "proactive_work"
          ? {
              title: `${employee.name} proposed work for review`,
              body:
                redactApprovalSummary(approval.title) ??
                "Review what happened and choose whether to start the proposed work.",
            }
          : {
              // Older rows can predate creation-time sanitization. Redact at this
              // persistence boundary too, so neither bell rows nor push payloads
              // turn legacy approval copy into a credential exfiltration path.
              title: `${employee.name} requested approval: ${
                redactApprovalSummary(approval.title) ?? "an action"
              }`,
              body:
                redactApprovalSummary(approval.summary) ??
                "An action is waiting for a human to approve or reject.",
            };

  const inputs = memberships.map((m) => ({
    companyId: approval.companyId,
    userId: m.userId,
    kind: "approval_pending" as const,
    title: copy.title,
    body: copy.body,
    link:
      approval.kind === "proactive_work" || approval.kind === "mail_send"
        ? `/c/${company.slug}/decisions#review-${approval.id}`
        : `/c/${company.slug}/decisions/approvals`,
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
  excludeKinds?: readonly NotificationKind[];
}): Promise<number> {
  const r = await repo().delete({
    companyId: params.companyId,
    userId: params.userId,
    readAt: Not(IsNull()),
    ...kindFilter(params.excludeKinds),
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
