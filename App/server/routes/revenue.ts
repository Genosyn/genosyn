import { Request, Response, Router, type RequestHandler } from "express";
import { In, IsNull } from "typeorm";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { ACTIVITY_KINDS, type ActivityKind } from "../db/entities/Activity.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  CONTACT_LIFECYCLE_STAGES,
  Contact,
  type ContactLifecycleStage,
} from "../db/entities/Contact.js";
import { Customer } from "../db/entities/Customer.js";
import { Deal } from "../db/entities/Deal.js";
import { DEAL_STAGE_KINDS, DealStage, type DealStageKind } from "../db/entities/DealStage.js";
import {
  REVENUE_ACCESS_LEVELS,
  type RevenueAccessLevel,
} from "../db/entities/EmployeeRevenueGrant.js";
import { SEQUENCE_STATUSES, type SequenceStatus } from "../db/entities/Sequence.js";
import {
  ENROLLMENT_STATUSES,
  type EnrollmentStatus,
} from "../db/entities/SequenceEnrollment.js";
import {
  SIGNAL_ACTION_KINDS,
  SIGNAL_SOURCE_KINDS,
  type SignalActionKind,
  type SignalSourceKind,
} from "../db/entities/Signal.js";
import {
  SIGNAL_EVENT_STATUSES,
  type SignalEventStatus,
} from "../db/entities/SignalEvent.js";
import {
  SUPPRESSION_REASONS,
  Suppression,
  type SuppressionReason,
} from "../db/entities/Suppression.js";
import { normalizeEmail } from "../lib/emailAddress.js";
import {
  onRoutePaths,
  requireAuth,
  requireCompanyMember,
  requireCompanyRoleForMutations,
} from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import { listActivities, recordActivity } from "../services/revenue/activities.js";
import {
  DuplicateContactError,
  archiveContact,
  createContact,
  getContact,
  listContacts,
  restoreContact,
  updateContact,
} from "../services/revenue/contacts.js";
import {
  InvalidStageError,
  addDealContact,
  archiveDeal,
  createDeal,
  dealBoard,
  getHydratedDeal,
  listDealContacts,
  listDeals,
  moveDealToStage,
  removeDealContact,
  updateDeal,
} from "../services/revenue/deals.js";
import {
  deleteRevenueGrant,
  listRevenueGrantCandidates,
  listRevenueGrants,
  upsertRevenueGrant,
} from "../services/revenue/grants.js";
import {
  getCacReport,
  getFunnelReport,
  getMrrSeries,
  getRevenueOverview,
} from "../services/revenue/reports.js";
import {
  bulkEnroll,
  createSequence,
  getSequence,
  hydrateSequences,
  listEnrollments,
  listSequences,
  listSteps,
  replaceSteps,
  stopEnrollment,
  updateSequence,
} from "../services/revenue/sequences.js";
import {
  createSignal,
  getSignal,
  listSignalEvents,
  listSignals,
  testSignal,
  updateSignal,
} from "../services/revenue/signals.js";
import {
  listDealStages,
  reorderDealStages,
  uniqueStageSlug,
} from "../services/revenue/stages.js";

/**
 * The Revenue HTTP surface — contacts, the deal board, activities, sequences,
 * signals, the suppression list and the reports.
 *
 * This file parses, delegates and shapes. Every rule that could be got wrong
 * twice — the deal status invariant, duplicate-email detection, suppression
 * semantics, funnel arithmetic — lives in `services/revenue/*`, because the MCP
 * tool surface calls those same functions and a rule enforced here would simply
 * not exist for an AI employee. What is genuinely HTTP lives here: status codes,
 * pagination clamping, and the composite payloads a detail page needs so it
 * renders in one request rather than five.
 *
 * Mounted at `/api/companies/:cid` alongside a dozen sibling routers, which
 * dictates two things. Paths are prefixed `/revenue/...` rather than relying on
 * the mount point, and the one role guard we need is wrapped in
 * `onRoutePaths` — see the note above the AI-access section.
 */
export const revenueRouter = Router({ mergeParams: true });
revenueRouter.use(requireAuth);
revenueRouter.use(requireCompanyMember);

/**
 * Changing which AI employees can reach the revenue system is an owner/admin
 * act; reading the list is not, so members can see what has been delegated.
 *
 * The `onRoutePaths` wrapper is load-bearing, not decoration. A bare
 * `.use(requireCompanyRoleForMutations("admin"))` on this router would also run
 * for every request that reaches `/api/companies/:cid` after this router is
 * mounted — Express walks a mounted router's middleware stack for any path
 * under the mount point, so an unscoped guard here would silently make *other*
 * features admin-only. Scoping it to the paths this router actually owns is the
 * only correct form. See `middleware/auth.ts`.
 */
revenueRouter.use(
  onRoutePaths(["/revenue/ai-access"], requireCompanyRoleForMutations("admin")),
);

// ── Plumbing ───────────────────────────────────────────────────────────────

function cidOf(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

/**
 * The principal behind the request, in the shape the revenue services expect.
 *
 * Always a human here: the AI path into these services is the MCP tool surface,
 * which supplies `employeeId` itself. Passing both would make the audit trail
 * ambiguous about who actually did it.
 */
function actorOf(req: Request): { userId: string | null } {
  return { userId: req.userId ?? null };
}

/**
 * Wrap an async handler so a rejected promise reaches the app error handler.
 *
 * Express 4 does not await handlers: an unhandled rejection escapes to the
 * process and takes the server down with it. Every handler below is registered
 * through this, which is why none of them carry their own try/catch for
 * unexpected failures — only for domain errors that map to a specific status.
 */
function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function audit(
  req: Request,
  action: string,
  target: { type: string; id?: string | null; label?: string },
  metadata?: Record<string, unknown>,
): Promise<void> {
  return recordAudit({
    companyId: cidOf(req),
    actorUserId: req.userId ?? null,
    action,
    targetType: target.type,
    targetId: target.id ?? null,
    targetLabel: target.label ?? "",
    metadata,
  });
}

const BAD_QUERY = { error: "Invalid query parameters" } as const;

/** Pagination, clamped again in the services — this only rejects nonsense. */
const pageQuery = {
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};

/**
 * `?includeArchived=true`. Deliberately not `z.coerce.boolean()`, which maps
 * the string "false" to `true` and would make the flag impossible to turn off.
 */
const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1")
  .optional();

/** Repeated `?kinds=a&kinds=b` or a single `?kinds=a,b`, normalized to a list. */
function csvEnum<T extends string>(values: readonly T[]) {
  const allowed = new Set<string>(values);
  return z
    .union([z.string(), z.array(z.string())])
    .transform((raw) => {
      const parts = Array.isArray(raw) ? raw : raw.split(",");
      return parts.map((p) => p.trim()).filter((p): p is T => allowed.has(p));
    })
    .optional();
}

const lifecycleStageEnum = z.enum(
  CONTACT_LIFECYCLE_STAGES as [ContactLifecycleStage, ...ContactLifecycleStage[]],
);
const stageKindEnum = z.enum(DEAL_STAGE_KINDS as [DealStageKind, ...DealStageKind[]]);
const suppressionReasonEnum = z.enum(
  SUPPRESSION_REASONS as [SuppressionReason, ...SuppressionReason[]],
);
const revenueAccessEnum = z.enum(
  REVENUE_ACCESS_LEVELS as [RevenueAccessLevel, ...RevenueAccessLevel[]],
);
const sequenceStatusEnum = z.enum(
  SEQUENCE_STATUSES as [SequenceStatus, ...SequenceStatus[]],
);
const enrollmentStatusEnum = z.enum(
  ENROLLMENT_STATUSES as [EnrollmentStatus, ...EnrollmentStatus[]],
);
const signalSourceEnum = z.enum(
  SIGNAL_SOURCE_KINDS as [SignalSourceKind, ...SignalSourceKind[]],
);
const signalActionEnum = z.enum(
  SIGNAL_ACTION_KINDS as [SignalActionKind, ...SignalActionKind[]],
);
const signalEventStatusEnum = z.enum(
  SIGNAL_EVENT_STATUSES as [SignalEventStatus, ...SignalEventStatus[]],
);

// ── Contacts ───────────────────────────────────────────────────────────────

const contactListQuery = z.object({
  ...pageQuery,
  q: z.string().max(200).optional(),
  lifecycleStage: lifecycleStageEnum.optional(),
  customerId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  ownerEmployeeId: z.string().uuid().optional(),
  includeArchived: boolQuery,
});

revenueRouter.get(
  "/revenue/contacts",
  h(async (req, res) => {
    const parsed = contactListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    const { rows, total } = await listContacts(cidOf(req), parsed.data);
    return res.json({ rows, total });
  }),
);

const contactBodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().max(320).optional(),
  phone: z.string().max(60).optional(),
  title: z.string().max(200).optional(),
  linkedinUrl: z.string().max(500).optional(),
  websiteUrl: z.string().max(500).optional(),
  customerId: z.string().uuid().nullable().optional(),
  companyName: z.string().max(200).optional(),
  lifecycleStage: lifecycleStageEnum.optional(),
  ownerId: z.string().uuid().nullable().optional(),
  ownerEmployeeId: z.string().uuid().nullable().optional(),
  source: z.string().max(100).optional(),
  sourceDetail: z.string().max(500).optional(),
  score: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(20_000).optional(),
  doNotContact: z.boolean().optional(),
});

revenueRouter.post(
  "/revenue/contacts",
  validateBody(contactBodySchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof contactBodySchema>;
    try {
      const contact = await createContact(cid, body, actorOf(req));
      await audit(req, "revenue.contact.create", {
        type: "contact",
        id: contact.id,
        label: contact.name,
      });
      return res.status(201).json(contact);
    } catch (err) {
      // The service refuses rather than merging, so the client can offer "open
      // the existing one" instead of silently discarding what was typed. The
      // id rides along for exactly that.
      if (err instanceof DuplicateContactError) {
        return res.status(409).json({ error: err.message, existingId: err.existingId });
      }
      throw err;
    }
  }),
);

/**
 * Everything the contact page renders: the row, its timeline (including
 * activities logged against their deals, which is what a human means by "our
 * history with them"), and the deals still in play.
 */
revenueRouter.get(
  "/revenue/contacts/:id",
  h(async (req, res) => {
    const cid = cidOf(req);
    const contact = await getContact(cid, req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const [timeline, deals] = await Promise.all([
      listActivities(cid, {
        contactId: contact.id,
        includeRelatedDeals: true,
        limit: 100,
      }),
      listDeals(cid, { contactId: contact.id, status: "open", limit: 50 }),
    ]);
    return res.json({
      contact,
      activities: timeline.rows,
      activityTotal: timeline.total,
      openDeals: deals.rows,
    });
  }),
);

revenueRouter.patch(
  "/revenue/contacts/:id",
  validateBody(contactBodySchema.partial()),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as Partial<z.infer<typeof contactBodySchema>>;
    try {
      const contact = await updateContact(cid, req.params.id, body);
      if (!contact) return res.status(404).json({ error: "Contact not found" });
      await audit(
        req,
        "revenue.contact.update",
        { type: "contact", id: contact.id, label: contact.name },
        { changes: Object.keys(body) },
      );
      return res.json(contact);
    } catch (err) {
      if (err instanceof DuplicateContactError) {
        return res.status(409).json({ error: err.message, existingId: err.existingId });
      }
      throw err;
    }
  }),
);

revenueRouter.post(
  "/revenue/contacts/:id/archive",
  h(async (req, res) => {
    const contact = await archiveContact(cidOf(req), req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    await audit(req, "revenue.contact.archive", {
      type: "contact",
      id: contact.id,
      label: contact.name,
    });
    return res.json(contact);
  }),
);

revenueRouter.post(
  "/revenue/contacts/:id/restore",
  h(async (req, res) => {
    const contact = await restoreContact(cidOf(req), req.params.id);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    await audit(req, "revenue.contact.restore", {
      type: "contact",
      id: contact.id,
      label: contact.name,
    });
    return res.json(contact);
  }),
);

// ── Stages ─────────────────────────────────────────────────────────────────
//
// The board's columns. `listDealStages` seeds the default ladder on first read,
// so a company that has never opened Revenue still gets a usable board rather
// than an empty screen asking it to design a sales process first.

revenueRouter.get(
  "/revenue/stages",
  h(async (req, res) => {
    return res.json(await listDealStages(cidOf(req)));
  }),
);

const stageCreateSchema = z.object({
  name: z.string().min(1).max(80),
  probability: z.number().int().min(0).max(100).optional(),
  kind: stageKindEnum.optional(),
  color: z.string().max(32).optional(),
  description: z.string().max(500).optional(),
});

revenueRouter.post(
  "/revenue/stages",
  validateBody(stageCreateSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof stageCreateSchema>;
    const repo = AppDataSource.getRepository(DealStage);
    // New stages land at the end of the board. Anywhere else and the caller has
    // to reorder anyway, and a stage silently inserted mid-pipeline changes what
    // every existing deal's position means.
    const last = await repo.findOne({
      where: { companyId: cid },
      order: { sortOrder: "DESC" },
    });
    const stage = await repo.save(
      repo.create({
        companyId: cid,
        name: body.name.trim(),
        slug: await uniqueStageSlug(cid, body.name),
        sortOrder: (last?.sortOrder ?? -1) + 1,
        probability: body.probability ?? 0,
        kind: body.kind ?? "open",
        color: body.color ?? "",
        description: body.description ?? "",
      }),
    );
    await audit(req, "revenue.stage.create", {
      type: "deal_stage",
      id: stage.id,
      label: stage.name,
    });
    return res.status(201).json(stage);
  }),
);

const stagePatchSchema = stageCreateSchema.partial();

revenueRouter.patch(
  "/revenue/stages/:id",
  validateBody(stagePatchSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const repo = AppDataSource.getRepository(DealStage);
    const stage = await repo.findOneBy({ id: req.params.id, companyId: cid });
    if (!stage) return res.status(404).json({ error: "Stage not found" });
    const body = req.body as z.infer<typeof stagePatchSchema>;

    if (body.name !== undefined) stage.name = body.name.trim();
    if (body.probability !== undefined) stage.probability = body.probability;
    if (body.color !== undefined) stage.color = body.color;
    if (body.description !== undefined) stage.description = body.description;
    // `kind` is not editable here on purpose. It drives `Deal.status`, and
    // flipping a populated stage from open to won would silently close every
    // deal sitting in it without writing the activities the funnel report reads.
    // Closing deals is a per-deal act; use POST /revenue/deals/:id/stage.

    await repo.save(stage);
    await audit(
      req,
      "revenue.stage.update",
      { type: "deal_stage", id: stage.id, label: stage.name },
      { changes: Object.keys(body) },
    );
    return res.json(stage);
  }),
);

const stageReorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).max(100),
});

revenueRouter.post(
  "/revenue/stages/reorder",
  validateBody(stageReorderSchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof stageReorderSchema>;
    const stages = await reorderDealStages(cidOf(req), body.orderedIds);
    await audit(
      req,
      "revenue.stage.reorder",
      { type: "deal_stage" },
      { orderedIds: body.orderedIds },
    );
    return res.json(stages);
  }),
);

/**
 * Archive a stage — soft, because closed deals must keep the name of the stage
 * they closed in or every historical funnel report loses a column.
 *
 * Refused while open deals still sit in it. The alternative designs are worse:
 * silently moving those deals rewrites someone's pipeline behind their back,
 * and leaving them stranded gives the board a column it cannot draw. Making the
 * caller move them first is the only version where the human decides where the
 * work goes.
 */
revenueRouter.delete(
  "/revenue/stages/:id",
  h(async (req, res) => {
    const cid = cidOf(req);
    const repo = AppDataSource.getRepository(DealStage);
    const stage = await repo.findOneBy({ id: req.params.id, companyId: cid });
    if (!stage) return res.status(404).json({ error: "Stage not found" });

    const stranded = await AppDataSource.getRepository(Deal).countBy({
      companyId: cid,
      stageId: stage.id,
      status: "open",
      archivedAt: IsNull(),
    });
    if (stranded > 0) {
      return res.status(409).json({
        error: `${stranded} open deal${stranded === 1 ? "" : "s"} still sit in this stage. Move them first.`,
      });
    }

    stage.archivedAt = new Date();
    await repo.save(stage);
    await audit(req, "revenue.stage.archive", {
      type: "deal_stage",
      id: stage.id,
      label: stage.name,
    });
    return res.json(stage);
  }),
);

// ── Deals ──────────────────────────────────────────────────────────────────

const dealListQuery = z.object({
  ...pageQuery,
  q: z.string().max(200).optional(),
  status: z.enum(["open", "won", "lost"]).optional(),
  stageId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  ownerEmployeeId: z.string().uuid().optional(),
  includeArchived: boolQuery,
});

revenueRouter.get(
  "/revenue/deals",
  h(async (req, res) => {
    const parsed = dealListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    const { rows, total } = await listDeals(cidOf(req), parsed.data);
    return res.json({ rows, total });
  }),
);

// Registered before `/revenue/deals/:id` — Express matches in declaration order
// and "board" is a perfectly valid-looking id to a `:id` pattern.
revenueRouter.get(
  "/revenue/deals/board",
  h(async (req, res) => {
    return res.json({ columns: await dealBoard(cidOf(req)) });
  }),
);

const dealCreateSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  customerId: z.string().uuid().nullable().optional(),
  primaryContactId: z.string().uuid().nullable().optional(),
  stageId: z.string().uuid().nullable().optional(),
  amountCents: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  probabilityOverride: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: z.coerce.date().nullable().optional(),
  source: z.string().max(100).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  ownerEmployeeId: z.string().uuid().nullable().optional(),
  nextStep: z.string().max(500).optional(),
  lostReason: z.string().max(500).optional(),
});

revenueRouter.post(
  "/revenue/deals",
  validateBody(dealCreateSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof dealCreateSchema>;
    try {
      const deal = await createDeal(cid, body, actorOf(req));
      await audit(
        req,
        "revenue.deal.create",
        { type: "deal", id: deal.id, label: deal.title },
        { stageId: deal.stageId, amountCents: deal.amountCents, currency: deal.currency },
      );
      return res.status(201).json(await getHydratedDeal(cid, deal.id));
    } catch (err) {
      if (err instanceof InvalidStageError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }),
);

revenueRouter.get(
  "/revenue/deals/:id",
  h(async (req, res) => {
    const cid = cidOf(req);
    const deal = await getHydratedDeal(cid, req.params.id);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    const [timeline, committee] = await Promise.all([
      listActivities(cid, { dealId: deal.id, limit: 100 }),
      listDealContacts(cid, deal.id),
    ]);
    return res.json({
      deal,
      activities: timeline.rows,
      activityTotal: timeline.total,
      contacts: committee,
    });
  }),
);

revenueRouter.patch(
  "/revenue/deals/:id",
  validateBody(dealCreateSchema.partial()),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as Partial<z.infer<typeof dealCreateSchema>>;
    try {
      // A `stageId` in the patch is routed through moveDealToStage by the
      // service, so the status invariant and the stage-change activity happen
      // even when the client folds a stage move into an ordinary save.
      const deal = await updateDeal(cid, req.params.id, body, actorOf(req));
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      await audit(
        req,
        "revenue.deal.update",
        { type: "deal", id: deal.id, label: deal.title },
        { changes: Object.keys(body) },
      );
      return res.json(await getHydratedDeal(cid, deal.id));
    } catch (err) {
      if (err instanceof InvalidStageError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }),
);

const dealStageMoveSchema = z.object({
  stageId: z.string().uuid(),
  lostReason: z.string().max(500).optional(),
});

revenueRouter.post(
  "/revenue/deals/:id/stage",
  validateBody(dealStageMoveSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof dealStageMoveSchema>;
    try {
      const deal = await moveDealToStage(cid, req.params.id, body.stageId, actorOf(req), {
        lostReason: body.lostReason,
      });
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      await audit(
        req,
        "revenue.deal.stage",
        { type: "deal", id: deal.id, label: deal.title },
        { stageId: deal.stageId, status: deal.status, lostReason: deal.lostReason },
      );
      return res.json(await getHydratedDeal(cid, deal.id));
    } catch (err) {
      if (err instanceof InvalidStageError) {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
  }),
);

revenueRouter.post(
  "/revenue/deals/:id/archive",
  h(async (req, res) => {
    const deal = await archiveDeal(cidOf(req), req.params.id);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    await audit(req, "revenue.deal.archive", {
      type: "deal",
      id: deal.id,
      label: deal.title,
    });
    return res.json(deal);
  }),
);

const dealContactSchema = z.object({
  contactId: z.string().uuid(),
  role: z.string().max(100).optional(),
});

revenueRouter.post(
  "/revenue/deals/:id/contacts",
  validateBody(dealContactSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof dealContactSchema>;
    // 404 on the deal before anything else, then reject an out-of-company
    // contact: a bare uuid must not be able to attach a stranger to a deal.
    const deal = await getHydratedDeal(cid, req.params.id);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    const contact = await getContact(cid, body.contactId);
    if (!contact) return res.status(400).json({ error: "Unknown contact" });

    const link = await addDealContact(cid, deal.id, contact.id, body.role ?? "");
    await audit(
      req,
      "revenue.deal.contact.add",
      { type: "deal", id: deal.id, label: deal.title },
      { contactId: contact.id, role: link.role },
    );
    return res.status(201).json(Object.assign(link, { contact }));
  }),
);

revenueRouter.delete(
  "/revenue/deals/:id/contacts/:contactId",
  h(async (req, res) => {
    const cid = cidOf(req);
    const deal = await getHydratedDeal(cid, req.params.id);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    const removed = await removeDealContact(cid, deal.id, req.params.contactId);
    if (!removed) return res.status(404).json({ error: "Contact is not on this deal" });
    await audit(
      req,
      "revenue.deal.contact.remove",
      { type: "deal", id: deal.id, label: deal.title },
      { contactId: req.params.contactId },
    );
    return res.json({ ok: true });
  }),
);

// ── Activities ─────────────────────────────────────────────────────────────

const activityListQuery = z.object({
  ...pageQuery,
  contactId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  kinds: csvEnum(ACTIVITY_KINDS),
  includeRelatedDeals: boolQuery,
});

revenueRouter.get(
  "/revenue/activities",
  h(async (req, res) => {
    const parsed = activityListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    const { rows, total } = await listActivities(cidOf(req), parsed.data);
    return res.json({ rows, total });
  }),
);

/**
 * Kinds a human may log by hand.
 *
 * Deliberately narrower than `ACTIVITY_KINDS`. `stage_change`, `deal_won`,
 * `email_out` and friends are *derived* records — the funnel and MRR reports
 * read them as evidence that something happened — so letting a client post one
 * directly would let anyone fabricate a conversion. Those kinds are written only
 * by the service that performs the underlying act.
 */
const MANUAL_ACTIVITY_KINDS = ["note", "call", "meeting", "task"] as const;

const activityCreateSchema = z.object({
  kind: z.enum(MANUAL_ACTIVITY_KINDS),
  subject: z.string().max(500).optional(),
  bodyText: z.string().max(20_000).optional(),
  occurredAt: z.coerce.date().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
});

revenueRouter.post(
  "/revenue/activities",
  validateBody(activityCreateSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof activityCreateSchema>;

    // Each link is company-scoped before it is written, so a timeline entry can
    // never point at another tenant's row.
    if (body.contactId && !(await getContact(cid, body.contactId))) {
      return res.status(400).json({ error: "Unknown contact" });
    }
    if (body.dealId && !(await getHydratedDeal(cid, body.dealId))) {
      return res.status(400).json({ error: "Unknown deal" });
    }
    if (body.customerId) {
      const customer = await AppDataSource.getRepository(Customer).findOneBy({
        id: body.customerId,
        companyId: cid,
      });
      if (!customer) return res.status(400).json({ error: "Unknown customer" });
    }

    const activity = await recordActivity(
      cid,
      { ...body, kind: body.kind as ActivityKind },
      actorOf(req),
    );
    await audit(
      req,
      "revenue.activity.create",
      { type: "activity", id: activity.id, label: activity.subject },
      { kind: activity.kind, contactId: activity.contactId, dealId: activity.dealId },
    );
    return res.status(201).json(activity);
  }),
);

// ── Sequences ──────────────────────────────────────────────────────────────

// Unpaginated, matching `listSequences`: a company runs tens of campaigns, not
// thousands, and the rows already arrive with their enrolment counts attached.
const sequenceListQuery = z.object({
  q: z.string().max(200).optional(),
  status: sequenceStatusEnum.optional(),
  includeArchived: boolQuery,
});

revenueRouter.get(
  "/revenue/sequences",
  h(async (req, res) => {
    const parsed = sequenceListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    return res.json(await listSequences(cidOf(req), parsed.data));
  }),
);

const sendWindowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).max(7),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  timezone: z.string().min(1).max(64),
});

const sequenceCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  status: sequenceStatusEnum.optional(),
  mailAccountId: z.string().uuid(),
  employeeId: z.string().uuid(),
  brief: z.string().max(20_000).optional(),
  autoSend: z.boolean().optional(),
  stopOnReply: z.boolean().optional(),
  dailyCap: z.number().int().min(0).max(10_000).optional(),
  sendWindow: sendWindowSchema.optional(),
});

revenueRouter.post(
  "/revenue/sequences",
  validateBody(sequenceCreateSchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof sequenceCreateSchema>;
    const sequence = await createSequence(cidOf(req), body, actorOf(req));
    await audit(
      req,
      "revenue.sequence.create",
      { type: "sequence", id: sequence.id, label: sequence.name },
      // `autoSend` is the one field worth reading back off the audit log a year
      // later: it is the switch that spends sending reputation without a human.
      { autoSend: sequence.autoSend, employeeId: sequence.employeeId },
    );
    return res.status(201).json(sequence);
  }),
);

/**
 * The sequence, its ladder, and the enrolment counts.
 *
 * Composed here from three service calls rather than asking the sequence
 * service for a bespoke detail function: the shape is what one screen happens
 * to need, and `hydrateSequences` already answers the only part that is real
 * work (the counts, in one grouped query).
 */
revenueRouter.get(
  "/revenue/sequences/:id",
  h(async (req, res) => {
    const cid = cidOf(req);
    const sequence = await getSequence(cid, req.params.id);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    const [hydrated, steps] = await Promise.all([
      hydrateSequences(cid, [sequence]),
      listSteps(cid, sequence.id),
    ]);
    return res.json({ sequence: hydrated[0] ?? sequence, steps });
  }),
);

revenueRouter.patch(
  "/revenue/sequences/:id",
  validateBody(sequenceCreateSchema.partial()),
  h(async (req, res) => {
    const body = req.body as Partial<z.infer<typeof sequenceCreateSchema>>;
    const sequence = await updateSequence(cidOf(req), req.params.id, body);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    await audit(
      req,
      "revenue.sequence.update",
      { type: "sequence", id: sequence.id, label: sequence.name },
      { changes: Object.keys(body), autoSend: sequence.autoSend },
    );
    return res.json(sequence);
  }),
);

const sequenceStepsSchema = z.object({
  steps: z
    .array(
      z.object({
        name: z.string().max(120).optional(),
        delayDays: z.number().int().min(0).max(365).optional(),
        delayHours: z.number().int().min(0).max(23).optional(),
        instruction: z.string().max(20_000).optional(),
        threadWithPrevious: z.boolean().optional(),
      }),
    )
    .max(50),
});

/**
 * PUT, not PATCH: the ladder is replaced wholesale.
 *
 * The builder always knows the full list, and `sortOrder` is what decides which
 * touch goes out next — reconciling per-step edits against live enrolments
 * sitting on step 3 is a much larger problem than this endpoint needs to solve.
 */
revenueRouter.put(
  "/revenue/sequences/:id/steps",
  validateBody(sequenceStepsSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof sequenceStepsSchema>;
    // `replaceSteps` writes whatever it is given without checking the parent —
    // it is reachable from the tick as well as from here — so the 404 is ours.
    if (!(await getSequence(cid, req.params.id))) {
      return res.status(404).json({ error: "Sequence not found" });
    }
    const steps = await replaceSteps(cid, req.params.id, body.steps);
    await audit(
      req,
      "revenue.sequence.steps.replace",
      { type: "sequence", id: req.params.id },
      { stepCount: body.steps.length },
    );
    return res.json(steps);
  }),
);

const enrollSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(500),
});

revenueRouter.post(
  "/revenue/sequences/:id/enroll",
  validateBody(enrollSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof enrollSchema>;
    const sequence = await getSequence(cid, req.params.id);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });

    // Partial success is the right shape here rather than all-or-nothing: a
    // suppressed or do-not-contact address inside a 200-row selection should
    // skip that one person, not refuse the other 199. The service reports what
    // it skipped and why.
    const result = await bulkEnroll(cid, req.params.id, body.contactIds, {
      actor: actorOf(req),
    });
    await audit(
      req,
      "revenue.sequence.enroll",
      { type: "sequence", id: sequence.id, label: sequence.name },
      { requested: body.contactIds.length, enrolled: result.enrolled },
    );
    return res.json(result);
  }),
);

const enrollmentListQuery = z.object({
  ...pageQuery,
  status: enrollmentStatusEnum.optional(),
});

/**
 * Who is in this sequence and where they are in it.
 *
 * The contact names are attached here rather than in the service. They are what
 * this one screen renders, not something any other caller of `listEnrollments`
 * needs, and one extra query keeps the row-per-contact lookup out of the list.
 */
revenueRouter.get(
  "/revenue/sequences/:id/enrollments",
  h(async (req, res) => {
    const cid = cidOf(req);
    const parsed = enrollmentListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);

    const { rows, total } = await listEnrollments(cid, {
      ...parsed.data,
      sequenceId: req.params.id,
    });
    const contacts = rows.length
      ? await AppDataSource.getRepository(Contact).find({
          where: { companyId: cid, id: In(rows.map((r) => r.contactId)) },
          select: { id: true, name: true, email: true },
        })
      : [];
    const byId = new Map(contacts.map((c) => [c.id, c]));
    return res.json({
      rows: rows.map((r) => Object.assign(r, { contact: byId.get(r.contactId) ?? null })),
      total,
    });
  }),
);

const stopEnrollmentSchema = z.object({
  reason: z.string().max(200).optional(),
});

/**
 * Stop one enrolment by hand.
 *
 * The terminal status is fixed at `stopped_manual` rather than taken from the
 * body. The other members of `StopStatus` — replied, bounced, unsubscribed —
 * are claims about what the recipient did, and a route that let a client assert
 * "they unsubscribed" would put unverifiable consent evidence in the record the
 * suppression list is meant to defend.
 */
revenueRouter.post(
  "/revenue/enrollments/:id/stop",
  validateBody(stopEnrollmentSchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof stopEnrollmentSchema>;
    const enrollment = await stopEnrollment(
      cidOf(req),
      req.params.id,
      "stopped_manual",
      body.reason ?? "",
    );
    if (!enrollment) return res.status(404).json({ error: "Enrollment not found" });
    await audit(
      req,
      "revenue.enrollment.stop",
      { type: "sequence_enrollment", id: enrollment.id },
      { sequenceId: enrollment.sequenceId, reason: enrollment.stoppedReason },
    );
    return res.json(enrollment);
  }),
);

// ── Signals ────────────────────────────────────────────────────────────────

// Unpaginated on purpose: `listSignals` is a configuration screen backed by a
// handful of rows, and the service deliberately offers no page window.
const signalListQuery = z.object({
  enabled: boolQuery,
  includeArchived: boolQuery,
});

revenueRouter.get(
  "/revenue/signals",
  h(async (req, res) => {
    const parsed = signalListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    return res.json(await listSignals(cidOf(req), parsed.data));
  }),
);

const signalCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).optional(),
  sourceKind: signalSourceEnum.optional(),
  connectionId: z.string().uuid().nullable().optional(),
  sql: z.string().max(20_000).optional(),
  cron: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  dedupeKeyColumn: z.string().max(120).optional(),
  emailColumn: z.string().max(120).optional(),
  domainColumn: z.string().max(120).optional(),
  amountColumn: z.string().max(120).optional(),
  actionKind: signalActionEnum.optional(),
  actionConfig: z.record(z.unknown()).nullable().optional(),
  employeeId: z.string().uuid().nullable().optional(),
});

/**
 * The service reports refusals ("that is not a cron this scheduler can run")
 * through a result union rather than by throwing, because a bad cron expression
 * is an ordinary outcome of a human filling in a form. They all land as 400
 * here: the two ways to fail — an empty name and an unrunnable cron — are both
 * the submitted body being wrong.
 */
revenueRouter.post(
  "/revenue/signals",
  validateBody(signalCreateSchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof signalCreateSchema>;
    const result = await createSignal(cidOf(req), body, actorOf(req));
    if (!result.ok) return res.status(400).json({ error: result.error });
    const { signal } = result;
    await audit(
      req,
      "revenue.signal.create",
      { type: "signal", id: signal.id, label: signal.name },
      { actionKind: signal.actionKind, enabled: signal.enabled, cron: signal.cron },
    );
    return res.status(201).json(signal);
  }),
);

// `/revenue/signal-events` is a sibling path, not a child of `/revenue/signals`,
// so it never collides with `:id` — kept that way on purpose.
const signalEventListQuery = z.object({
  ...pageQuery,
  signalId: z.string().uuid().optional(),
  status: signalEventStatusEnum.optional(),
  contactId: z.string().uuid().optional(),
});

revenueRouter.get(
  "/revenue/signal-events",
  h(async (req, res) => {
    const parsed = signalEventListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    return res.json(await listSignalEvents(cidOf(req), parsed.data));
  }),
);

revenueRouter.get(
  "/revenue/signals/:id",
  h(async (req, res) => {
    const cid = cidOf(req);
    const signal = await getSignal(cid, req.params.id);
    if (!signal) return res.status(404).json({ error: "Signal not found" });
    const events = await listSignalEvents(cid, { signalId: req.params.id, limit: 50 });
    return res.json({ signal, events });
  }),
);

revenueRouter.patch(
  "/revenue/signals/:id",
  validateBody(signalCreateSchema.partial()),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as Partial<z.infer<typeof signalCreateSchema>>;
    // Existence is resolved here rather than read back out of the result union,
    // which carries only a message string. 404-before-anything-else is the house
    // rule, and it leaves every remaining refusal unambiguously a bad body.
    if (!(await getSignal(cid, req.params.id))) {
      return res.status(404).json({ error: "Signal not found" });
    }
    const result = await updateSignal(cid, req.params.id, body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const { signal } = result;
    await audit(
      req,
      "revenue.signal.update",
      { type: "signal", id: signal.id, label: signal.name },
      { changes: Object.keys(body), enabled: signal.enabled },
    );
    return res.json(signal);
  }),
);

/**
 * Dry run: execute the query and report what *would* fire, without writing
 * events or performing the action.
 *
 * Audited even though it changes nothing, because it runs arbitrary SQL against
 * a connected production database — the read itself is the thing worth having a
 * record of.
 */
revenueRouter.post(
  "/revenue/signals/:id/test",
  h(async (req, res) => {
    const cid = cidOf(req);
    const signal = await getSignal(cid, req.params.id);
    if (!signal) return res.status(404).json({ error: "Signal not found" });
    const result = await testSignal(cid, req.params.id);
    await audit(req, "revenue.signal.test", {
      type: "signal",
      id: req.params.id,
      label: signal.name,
    });
    return res.json(result);
  }),
);

// ── Suppressions ───────────────────────────────────────────────────────────
//
// The do-not-mail list. Enforcement lives at the outbound choke-point in
// `services/mail/actions.ts`; these three endpoints are only the human view of
// it, which is why they talk to the repository directly instead of through a
// service — there is no rule here for anything else to agree with.

const suppressionListQuery = z.object({
  ...pageQuery,
  q: z.string().max(320).optional(),
  reason: suppressionReasonEnum.optional(),
});

revenueRouter.get(
  "/revenue/suppressions",
  h(async (req, res) => {
    const cid = cidOf(req);
    const parsed = suppressionListQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    const { limit = 50, offset = 0, q, reason } = parsed.data;

    const qb = AppDataSource.getRepository(Suppression)
      .createQueryBuilder("s")
      .where("s.companyId = :cid", { cid });
    if (q) {
      qb.andWhere("LOWER(s.email) LIKE :term", { term: `%${q.trim().toLowerCase()}%` });
    }
    if (reason) qb.andWhere("s.reason = :reason", { reason });

    const total = await qb.clone().getCount();
    const rows = await qb
      .orderBy("s.createdAt", "DESC")
      .skip(offset)
      .take(limit)
      .getMany();
    return res.json({ rows, total });
  }),
);

const suppressionCreateSchema = z.object({
  email: z.string().min(3).max(320),
  reason: suppressionReasonEnum,
  notes: z.string().max(2_000).optional(),
});

/**
 * Suppress an address.
 *
 * Idempotent: re-suppressing an already-suppressed address returns the existing
 * row with 200 rather than 409. The caller asked for an end state that already
 * holds, and a conflict here would push every client into a check-then-write
 * dance for no benefit. The reason on the original row is left alone — the
 * first, strongest signal for why we must not mail somebody is the one worth
 * keeping.
 */
revenueRouter.post(
  "/revenue/suppressions",
  validateBody(suppressionCreateSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof suppressionCreateSchema>;
    const email = normalizeEmail(body.email);
    if (!email) return res.status(400).json({ error: "That is not a usable email address" });

    const repo = AppDataSource.getRepository(Suppression);
    const existing = await repo.findOneBy({ companyId: cid, email });
    if (existing) return res.json(existing);

    const row = await repo.save(
      repo.create({
        companyId: cid,
        email,
        reason: body.reason,
        source: "revenue-ui",
        notes: body.notes ?? "",
        createdById: req.userId ?? null,
      }),
    );
    await audit(
      req,
      "revenue.suppression.create",
      { type: "suppression", id: row.id, label: row.email },
      { reason: row.reason },
    );
    return res.status(201).json(row);
  }),
);

/**
 * Un-suppress. Audited with the reason it carried, because the cheapest way to
 * get a sending domain blocklisted is to mail somebody who already said no, and
 * "who removed this and when" is the first question asked afterwards.
 */
revenueRouter.delete(
  "/revenue/suppressions/:id",
  h(async (req, res) => {
    const cid = cidOf(req);
    const repo = AppDataSource.getRepository(Suppression);
    const row = await repo.findOneBy({ id: req.params.id, companyId: cid });
    if (!row) return res.status(404).json({ error: "Suppression not found" });
    await repo.delete({ id: row.id });
    await audit(
      req,
      "revenue.suppression.delete",
      { type: "suppression", id: row.id, label: row.email },
      { reason: row.reason },
    );
    return res.json({ ok: true });
  }),
);

// ── Reports ────────────────────────────────────────────────────────────────

const periodQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  /** Sales target for the period, in minor units. 0 / omitted → no coverage. */
  targetCents: z.coerce.number().int().min(0).optional(),
  /** 0-100. Omitted → the service returns null rather than inventing a margin. */
  grossMarginPct: z.coerce.number().int().min(0).max(100).optional(),
});

const DEFAULT_REPORT_MONTHS = 12;

/**
 * Fill in a missing window.
 *
 * The report services require a real `[from, to)` and throw on a partial one,
 * which is right for them — a metric computed over an unstated period is a
 * number nobody can check. But a dashboard opening for the first time has no
 * window to state, so choosing the default is the HTTP layer's job: the
 * trailing twelve months, which is the span every one of these reports is
 * legible over.
 */
function resolvePeriod(q: z.infer<typeof periodQuery>): { from: Date; to: Date } {
  const to = q.to ?? new Date();
  if (q.from) return { from: q.from, to };
  const from = new Date(to.getTime());
  from.setUTCMonth(from.getUTCMonth() - DEFAULT_REPORT_MONTHS);
  return { from, to };
}

revenueRouter.get(
  "/revenue/reports/overview",
  h(async (req, res) => {
    const parsed = periodQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    const { from, to } = resolvePeriod(parsed.data);
    return res.json(
      await getRevenueOverview(cidOf(req), {
        from,
        to,
        targetCents: parsed.data.targetCents,
        grossMarginPct: parsed.data.grossMarginPct,
      }),
    );
  }),
);

const mrrQuery = z.object({
  months: z.coerce.number().int().min(1).max(60).optional(),
});

revenueRouter.get(
  "/revenue/reports/mrr",
  h(async (req, res) => {
    const parsed = mrrQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    return res.json(
      await getMrrSeries(cidOf(req), parsed.data.months ?? DEFAULT_REPORT_MONTHS),
    );
  }),
);

revenueRouter.get(
  "/revenue/reports/funnel",
  h(async (req, res) => {
    const parsed = periodQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    return res.json(
      await getFunnelReport(cidOf(req), resolvePeriod(parsed.data), {
        targetCents: parsed.data.targetCents,
      }),
    );
  }),
);

revenueRouter.get(
  "/revenue/reports/cac",
  h(async (req, res) => {
    const parsed = periodQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json(BAD_QUERY);
    return res.json(
      await getCacReport(cidOf(req), resolvePeriod(parsed.data), {
        grossMarginPct: parsed.data.grossMarginPct,
      }),
    );
  }),
);

// ── AI access ──────────────────────────────────────────────────────────────
//
// Which AI employees may reach the revenue system, and at what level
// (read < write < send). Human members reach Revenue through company
// membership; this governs the AI surface only. Mutations are owner/admin,
// enforced by the `onRoutePaths` guard at the top of this file.

revenueRouter.get(
  "/revenue/ai-access",
  h(async (req, res) => {
    const cid = cidOf(req);
    const [grants, candidates] = await Promise.all([
      listRevenueGrants(cid),
      listRevenueGrantCandidates(cid),
    ]);
    return res.json({ grants, candidates });
  }),
);

const grantPutSchema = z.object({ accessLevel: revenueAccessEnum });

/**
 * PUT because it is an upsert keyed by the employee: one grant row per
 * employee, and the caller is stating the level it should hold rather than
 * asking whether one exists first.
 */
revenueRouter.put(
  "/revenue/ai-access/:employeeId",
  validateBody(grantPutSchema),
  h(async (req, res) => {
    const cid = cidOf(req);
    const body = req.body as z.infer<typeof grantPutSchema>;
    const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: req.params.employeeId,
      companyId: cid,
    });
    if (!employee) return res.status(404).json({ error: "Employee not found" });

    await upsertRevenueGrant(cid, employee.id, body.accessLevel);
    await audit(
      req,
      "revenue.grant.upsert",
      { type: "employee", id: employee.id, label: employee.name },
      { accessLevel: body.accessLevel },
    );
    const grant = (await listRevenueGrants(cid)).find((g) => g.employeeId === employee.id);
    return res.json({ grant: grant ?? null });
  }),
);

revenueRouter.delete(
  "/revenue/ai-access/:id",
  h(async (req, res) => {
    const removed = await deleteRevenueGrant(cidOf(req), req.params.id);
    if (!removed) return res.status(404).json({ error: "Grant not found" });
    await audit(
      req,
      "revenue.grant.delete",
      { type: "employee", id: removed.employeeId },
      { accessLevel: removed.accessLevel },
    );
    return res.json({ ok: true });
  }),
);
