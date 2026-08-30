import { Router } from "express";
import { And, In, LessThan, Like, MoreThanOrEqual, LessThanOrEqual } from "typeorm";
import type { FindOptionsWhere } from "typeorm";
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
import { requireCompanyFeature } from "../services/entitlements.js";

/**
 * Company audit trail. Read-only — events are written by {@link recordAudit}
 * at the route seam. The list endpoint hydrates actor info so the UI can
 * render "Alice approved routine X" without extra round-trips.
 *
 * READING is gated on the `auditLog` feature (Scale plan / Enterprise
 * license, M56); `recordAudit` keeps WRITING regardless, so the history
 * exists the day the company upgrades.
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
 * A Run's *own* effects are deliberately NOT behind the entitlement — see
 * `routes/routines.ts`. Reading the company's whole history is the paid
 * feature; reading what one Run did is part of trusting the Run at all.
 */
export const auditRouter = Router({ mergeParams: true });
auditRouter.use(requireAuth);
auditRouter.use(requireCompanyMember);
auditRouter.use(onRoutePaths(["/audit"], requireCompanyRole("admin")));
auditRouter.use(onRoutePaths(["/audit"], requireCompanyFeature("auditLog")));

const auditQuerySchema = z
  .object({
    take: z.coerce.number().int().min(1).max(500).default(200),
    /** Keyset on `createdAt`: pass the oldest row's timestamp to page back. */
    cursor: z.string().datetime().optional(),
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

/**
 * Fold the date window and the keyset cursor into one `createdAt` predicate.
 * TypeORM has no `where` array-of-operators form for a single column, so
 * overlapping bounds have to be combined explicitly rather than assigned twice
 * — the second assignment would silently win and widen the window.
 */
function createdAtPredicate(opts: { since?: string; until?: string; cursor?: string }) {
  const bounds = [
    opts.since ? MoreThanOrEqual(new Date(opts.since)) : null,
    opts.until ? LessThanOrEqual(new Date(opts.until)) : null,
    opts.cursor ? LessThan(new Date(opts.cursor)) : null,
  ].filter((b): b is NonNullable<typeof b> => b !== null);
  if (bounds.length === 0) return undefined;
  if (bounds.length === 1) return bounds[0];
  return And(...bounds);
}

auditRouter.get("/audit", validateQuery(auditQuerySchema), async (req, res) => {
  const { cid } = req.params as Record<string, string>;
  const q = req.query as unknown as z.infer<typeof auditQuerySchema>;

  const where: FindOptionsWhere<AuditEvent> = { companyId: cid };
  if (q.actorKind) where.actorKind = q.actorKind;
  if (q.actorEmployeeId) where.actorEmployeeId = q.actorEmployeeId;
  if (q.actorUserId) where.actorUserId = q.actorUserId;
  if (q.runId) where.runId = q.runId;
  // Prefix rather than substring: `action` is a dotted namespace, so `invoice.`
  // means "everything in the invoice family" and never "any action mentioning
  // invoice somewhere in the middle".
  if (q.action) where.action = Like(`${q.action.replace(/[%_\\]/g, "\\$&")}%`);
  const createdAt = createdAtPredicate(q);
  if (createdAt) where.createdAt = createdAt;

  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where,
    order: { createdAt: "DESC", id: "DESC" },
    take: q.take,
  });

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

  // A deliberate shape change: this returned a bare array, which left nowhere
  // to put the paging cursor. `AuditLog.tsx` and the `api.ts` client type are
  // updated in the same commit; nothing else consumes this endpoint (the REST
  // API surface in `routes/openapi.ts` does not publish it).
  res.json({
    items,
    nextCursor:
      items.length === q.take ? (items[items.length - 1].createdAt.toISOString() ?? null) : null,
  });
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
