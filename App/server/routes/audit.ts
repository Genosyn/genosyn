import { Router } from "express";
import { In } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { User } from "../db/entities/User.js";
import {
  requireAuth,
  requireCompanyMember,
  requireCompanyRole,
  onRoutePaths,
} from "../middleware/auth.js";
import { validateQuery } from "../middleware/validate.js";
import { pageAuditEvents } from "../services/auditPaging.js";
import { CURSOR_MAX_LENGTH, filterFingerprint, ListQueryError } from "../services/listPaging.js";

/**
 * Company audit trail. Read-only — events are written by {@link recordAudit}
 * at the route seam. The list endpoint hydrates actor info so the UI can
 * render "Alice approved routine X" without extra round-trips. Reading the
 * log is admin-only.
 *
 * ## Why this grew filters (M58)
 *
 * The table has carried `actorEmployeeId` since M2 and this endpoint threw it
 * away — every AI Employee's action rendered as "System", so the log could
 * record which employee did what and could not answer it. It also returned a
 * flat newest-200, which is a browsable feed and not an investigation tool:
 * "what did last night's Runs touch" was not a question the product could
 * answer, and that is the first question anyone asks after a bad autonomous
 * day. The filters below are the whole difference between an append-only log
 * and a usable one.
 *
 * A Run's *own* effects are deliberately readable by every member — see
 * `routes/routineChecks.ts`. Reading the company's whole history is an admin's
 * investigation tool; reading what one Run did is part of trusting the Run at
 * all.
 */
export const auditRouter = Router({ mergeParams: true });
auditRouter.use(requireAuth);
auditRouter.use(requireCompanyMember);
auditRouter.use(onRoutePaths(["/audit"], requireCompanyRole("admin")));

const auditQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(500).default(200),
    cursor: z
      .string()
      .min(1)
      .max(CURSOR_MAX_LENGTH)
      .optional()
      .describe(
        "nextCursor from the previous page, with exactly the same filters. It names the oldest event shown, so events sharing its instant are neither skipped nor repeated; a bare timestamp from an older page still reads on from that instant.",
      ),
    actorKind: z.enum(["user", "system", "webhook", "cron", "ai"]).optional(),
    actorEmployeeId: z.string().uuid().optional(),
    actorUserId: z.string().uuid().optional(),
    /** Prefix match, so `invoice.` finds every invoice mutation. */
    action: z.string().max(80).optional(),
    runId: z.string().uuid().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
  })
  .strict();

auditRouter.get("/audit", validateQuery(auditQuerySchema), async (req, res, next) => {
  const { cid } = req.params as Record<string, string>;
  const q = req.query as unknown as z.infer<typeof auditQuerySchema>;

  const qb = AppDataSource.getRepository(AuditEvent)
    .createQueryBuilder("e")
    .where("e.companyId = :cid", { cid });
  if (q.actorKind) qb.andWhere("e.actorKind = :actorKind", { actorKind: q.actorKind });
  if (q.actorEmployeeId) {
    qb.andWhere("e.actorEmployeeId = :actorEmployeeId", { actorEmployeeId: q.actorEmployeeId });
  }
  if (q.actorUserId) qb.andWhere("e.actorUserId = :actorUserId", { actorUserId: q.actorUserId });
  if (q.runId) qb.andWhere("e.runId = :runId", { runId: q.runId });
  // Prefix rather than substring: `action` is a dotted namespace, so `invoice.`
  // means "everything in the invoice family" and never "any action mentioning
  // invoice somewhere in the middle".
  if (q.action) {
    qb.andWhere("e.action LIKE :action", {
      action: `${q.action.replace(/[%_\\]/g, "\\$&")}%`,
    });
  }
  if (q.since) qb.andWhere("e.createdAt >= :since", { since: new Date(q.since) });
  if (q.until) qb.andWhere("e.createdAt <= :until", { until: new Date(q.until) });

  let page: Awaited<ReturnType<typeof pageAuditEvents>>;
  try {
    page = await pageAuditEvents(qb, {
      scope: "audit.events",
      fingerprint: filterFingerprint(cid, {
        actorKind: q.actorKind,
        actorEmployeeId: q.actorEmployeeId,
        actorUserId: q.actorUserId,
        action: q.action,
        runId: q.runId,
        since: q.since ? new Date(q.since).toISOString() : undefined,
        until: q.until ? new Date(q.until).toISOString() : undefined,
      }),
      cursor: q.cursor,
      take: q.take,
    });
  } catch (err) {
    if (err instanceof ListQueryError) return res.status(err.status).json({ error: err.message });
    return next(err);
  }
  const rows = page.rows;

  const userIds = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
  const employeeIds = [
    ...new Set(rows.map((r) => r.actorEmployeeId).filter((x): x is string => !!x)),
  ];
  const [users, employees] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          // Company-scoped: an id that somehow points outside this company
          // hydrates to null rather than leaking a name across the boundary.
          where: { id: In(employeeIds), companyId: cid },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  const items = rows.map((r) => {
    const u = r.actorUserId ? userById.get(r.actorUserId) : null;
    const e = r.actorEmployeeId ? employeeById.get(r.actorEmployeeId) : null;
    let metadata: Record<string, unknown> | null = null;
    if (r.metadataJson) {
      try {
        metadata = JSON.parse(r.metadataJson);
      } catch {
        metadata = null;
      }
    }
    return {
      id: r.id,
      companyId: r.companyId,
      actorKind: r.actorKind,
      actorUserId: r.actorUserId,
      actor: u ? { id: u.id, name: u.name, email: u.email } : null,
      actorEmployeeId: r.actorEmployeeId,
      actorEmployee: e ? { id: e.id, slug: e.slug, name: e.name, role: e.role } : null,
      runId: r.runId,
      conversationId: r.conversationId,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      targetLabel: r.targetLabel,
      metadata,
      createdAt: r.createdAt,
    };
  });

  // A keyset cursor (`services/auditPaging.ts`): it names the oldest event
  // shown, so the events sharing its instant are neither skipped nor
  // repeated, and the last page offers none.
  res.json({ items, nextCursor: page.nextCursor, hasMore: page.hasMore });
});

/**
 * The actors a filter dropdown can offer, so the UI does not have to load the
 * whole roster to name three employees.
 */
auditRouter.get("/audit/actors", async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: cid },
    select: { id: true, slug: true, name: true, role: true },
    order: { name: "ASC" },
    take: 500,
  });
  res.json({ employees });
});
