import { Request, Response, Router, type RequestHandler } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import {
  ACTIVITY_PRIORITIES,
  ACTIVITY_TASK_STATUSES,
  type ActivityPriority,
  type ActivityTaskStatus,
} from "../db/entities/Activity.js";
import {
  CONTACT_LIFECYCLE_STAGES,
  type ContactLifecycleStage,
} from "../db/entities/Contact.js";
import { Company } from "../db/entities/Company.js";
import {
  REVENUE_CLASSIFICATION_KINDS,
  type RevenueClassificationKind,
} from "../db/entities/RevenueClassification.js";
import {
  REVENUE_CUSTOM_FIELD_TYPES,
  REVENUE_RESOURCE_TYPES,
  type RevenueCustomFieldType,
  type RevenueResourceType,
} from "../db/entities/RevenueCustomField.js";
import {
  REVENUE_DOCUMENT_KINDS,
  type RevenueDocumentKind,
} from "../db/entities/RevenueDocument.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { recordAudit } from "../services/audit.js";
import {
  createRevenueAccount,
  getRevenueAccount,
  listRevenueAccounts,
  mergeRevenueAccounts,
  previewRevenueAccountMerge,
  setRevenueAccountArchived,
  updateRevenueAccount,
} from "../services/revenue/accounts.js";
import {
  createRevenueClassification,
  listRevenueClassifications,
  updateRevenueClassification,
} from "../services/revenue/classifications.js";
import {
  createCustomField,
  getCustomValues,
  installBaseMigrationCustomFields,
  listCustomFields,
  setCustomValues,
  updateCustomField,
} from "../services/revenue/customFields.js";
import {
  createRevenueDocument,
  deleteRevenueDocument,
  getRevenueDocument,
  listRevenueDocuments,
  updateRevenueDocument,
} from "../services/revenue/documents.js";
import {
  createFollowUpTask,
  listFollowUps,
  updateFollowUpTask,
} from "../services/revenue/followUps.js";
import {
  mergeRevenueRecords,
  previewRevenueMerge,
  type MergeResourceType,
} from "../services/revenue/merge.js";
import { runRevenueBulkOperation } from "../services/revenue/bulk.js";
import {
  backfillDealHistoryFromActivities,
  importHistoricalDealEvents,
  listDealHistory,
} from "../services/revenue/dealHistory.js";
import {
  createCommercialValueProposal,
  listRevenueEvidence,
  proposeCanonicalDomains,
  proposeCommercialValuesFromFinance,
  proposeCommercialValuesFromStripe,
  reviewRevenueEvidence,
} from "../services/revenue/enrichment.js";
import {
  dismissRevenueDuplicateCandidate,
  listRevenueDuplicateCandidates,
  scanRevenueDuplicates,
} from "../services/revenue/duplicates.js";
import {
  REVENUE_EXPORT_RESOURCES,
  exportRevenueSnapshotPage,
  revenueExportCsv,
  type RevenueExportResource,
} from "../services/revenue/exports.js";
import {
  listRevenueDocumentCandidates,
  reviewRevenueDocumentCandidate,
  scanMailForRevenueDocuments,
} from "../services/revenue/documentCapture.js";
import {
  findMergedRecordRedirect,
  getRevenueOperation,
  listRevenueOperations,
  rollbackRevenueOperation,
} from "../services/revenue/operations.js";
import {
  commitLinkedRevenueImport,
  commitRevenueImport,
  getRevenueImport,
  getRevenueImportRows,
  loadBaseImportRows,
  migrateBaseAttachmentsForImport,
  previewLinkedRevenueImport,
  previewRevenueImport,
  queryRevenueImports,
  rollbackRevenueImport,
  type ImportRow,
  type LinkedImportMapping,
} from "../services/revenue/imports.js";
import {
  addPartnershipContact,
  createPartnership,
  getPartnership,
  listPartnerships,
  removePartnershipContact,
  updatePartnership,
} from "../services/revenue/partnerships.js";
import { listActivities } from "../services/revenue/activities.js";
import { recordAttachment, resolveAttachmentFile, uploadMiddleware } from "../services/uploads.js";

export const revenueOperationsRouter = Router({ mergeParams: true });
revenueOperationsRouter.use(requireAuth);
revenueOperationsRouter.use(requireCompanyMember);

function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

function cidOf(req: Request): string {
  return (req.params as Record<string, string>).cid;
}

function actorOf(req: Request): { userId: string | null } {
  return { userId: req.userId ?? null };
}

async function audit(
  req: Request,
  action: string,
  type: string,
  id: string | null,
  label: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await recordAudit({
    companyId: cidOf(req),
    actorUserId: req.userId ?? null,
    action,
    targetType: type,
    targetId: id,
    targetLabel: label,
    metadata,
  });
}

const boolQuery = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1")
  .optional();
const resourceTypeEnum = z.enum(
  REVENUE_RESOURCE_TYPES as [RevenueResourceType, ...RevenueResourceType[]],
);
const fieldTypeEnum = z.enum(
  REVENUE_CUSTOM_FIELD_TYPES as [RevenueCustomFieldType, ...RevenueCustomFieldType[]],
);
const classificationKindEnum = z.enum(
  REVENUE_CLASSIFICATION_KINDS as [RevenueClassificationKind, ...RevenueClassificationKind[]],
);
const documentKindEnum = z.enum(
  REVENUE_DOCUMENT_KINDS as [RevenueDocumentKind, ...RevenueDocumentKind[]],
);
const taskStatusEnum = z.enum(
  ACTIVITY_TASK_STATUSES as [ActivityTaskStatus, ...ActivityTaskStatus[]],
);
const priorityEnum = z.enum(ACTIVITY_PRIORITIES as [ActivityPriority, ...ActivityPriority[]]);
const mergeResourceTypeEnum = z.enum(["account", "contact", "deal", "partnership"]);

function optionalDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

// ── Accounts (the existing Customer row, before or after billing) ──────────

const accountWriteSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(200).or(z.literal("")).optional(),
  phone: z.string().max(60).optional(),
  accountStatus: z.enum(["prospect", "customer", "former"]).optional(),
  domain: z.string().max(255).optional(),
  websiteUrl: z.string().max(1000).optional(),
  industry: z.string().max(200).optional(),
  employeeCount: z.number().int().min(0).max(2_000_000_000).optional(),
  currency: z.string().length(3).optional(),
  annualContractValueCents: z.number().int().min(0).max(2_000_000_000).optional(),
  notes: z.string().max(20_000).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  ownerEmployeeId: z.string().uuid().nullable().optional(),
});

revenueOperationsRouter.get(
  "/revenue/accounts",
  h(async (req, res) => {
    const parsed = z
      .object({
        q: z.string().max(200).optional(),
        status: z.enum(["prospect", "customer", "former"]).optional(),
        ownerId: z.string().uuid().optional(),
        ownerEmployeeId: z.string().uuid().optional(),
        customFieldKey: z.string().max(80).optional(),
        customFieldValue: z.string().max(500).optional(),
        includeArchived: boolQuery,
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listRevenueAccounts(cidOf(req), parsed.data));
  }),
);

revenueOperationsRouter.post(
  "/revenue/accounts",
  validateBody(accountWriteSchema.extend({ name: z.string().min(1).max(120) })),
  h(async (req, res) => {
    try {
      const row = await createRevenueAccount(cidOf(req), req.body, actorOf(req));
      await audit(req, "revenue.account.create", "customer", row.id, row.name);
      return res.status(201).json(row);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

for (const [action, archived] of [
  ["archive", true],
  ["restore", false],
] as const) {
  revenueOperationsRouter.post(
    `/revenue/accounts/:id/${action}`,
    h(async (req, res) => {
      try {
        const row = await setRevenueAccountArchived(cidOf(req), req.params.id, archived);
        if (!row) return res.status(404).json({ error: "Account not found" });
        await audit(req, `revenue.account.${action}`, "customer", row.id, row.name);
        return res.json(row);
      } catch (error) {
        return res.status(409).json({ error: (error as Error).message });
      }
    }),
  );
}

revenueOperationsRouter.get(
  "/revenue/accounts/:id/merge-preview",
  h(async (req, res) => {
    const parsed = z.object({ targetAccountId: z.string().uuid() }).safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "A valid destination Account is required" });
    }
    try {
      return res.json(
        await previewRevenueAccountMerge(cidOf(req), req.params.id, parsed.data.targetAccountId),
      );
    } catch (error) {
      const message = (error as Error).message;
      return res.status(message.endsWith("not found") ? 404 : 409).json({ error: message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/accounts/:id/merge",
  validateBody(
    z.object({
      targetAccountId: z.string().uuid(),
      confirmSourceName: z.string().min(1).max(120),
    }),
  ),
  h(async (req, res) => {
    try {
      const result = await mergeRevenueAccounts(
        cidOf(req),
        req.params.id,
        req.body.targetAccountId,
        req.body.confirmSourceName,
        actorOf(req),
      );
      await audit(
        req,
        "revenue.account.merge",
        "customer",
        result.source.id,
        `${result.source.name} → ${result.target.name}`,
        {
          targetAccountId: result.target.id,
          moved: result.counts,
        },
      );
      return res.json(result);
    } catch (error) {
      const message = (error as Error).message;
      return res.status(message.endsWith("not found") ? 404 : 409).json({ error: message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/accounts/:id",
  h(async (req, res) => {
    const row = await getRevenueAccount(cidOf(req), req.params.id);
    return row ? res.json(row) : res.status(404).json({ error: "Account not found" });
  }),
);

revenueOperationsRouter.patch(
  "/revenue/accounts/:id",
  validateBody(accountWriteSchema),
  h(async (req, res) => {
    try {
      const row = await updateRevenueAccount(cidOf(req), req.params.id, req.body);
      if (!row) return res.status(404).json({ error: "Account not found" });
      await audit(req, "revenue.account.update", "customer", row.id, row.name, {
        changes: Object.keys(req.body),
      });
      return res.json(row);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

// ── Core-record consolidation + reversible operation history ─────────────

const mergeParamsSchema = z.object({
  resourceType: mergeResourceTypeEnum,
  id: z.string().uuid(),
});

revenueOperationsRouter.get(
  "/revenue/records/:resourceType/:id/merge-preview",
  h(async (req, res) => {
    const params = mergeParamsSchema.safeParse(req.params);
    const query = z.object({ targetId: z.string().uuid() }).safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Valid source and destination records are required" });
    }
    try {
      return res.json(
        await previewRevenueMerge(
          cidOf(req),
          params.data.resourceType as MergeResourceType,
          params.data.id,
          query.data.targetId,
        ),
      );
    } catch (error) {
      const message = (error as Error).message;
      return res.status(message.endsWith("not found") ? 404 : 409).json({ error: message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/records/:resourceType/:id/merge",
  validateBody(
    z.object({
      targetId: z.string().uuid(),
      confirmSourceLabel: z.string().min(1).max(500),
    }),
  ),
  h(async (req, res) => {
    const params = mergeParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid Revenue record" });
    try {
      const result = await mergeRevenueRecords(
        cidOf(req),
        params.data.resourceType,
        params.data.id,
        req.body.targetId,
        req.body.confirmSourceLabel,
        actorOf(req),
      );
      await audit(
        req,
        `revenue.${params.data.resourceType}.merge`,
        params.data.resourceType,
        result.source.id,
        `${result.source.label} → ${result.target.label}`,
        {
          operationId: result.operationId,
          targetId: result.target.id,
          moved: result.relationshipCounts,
          customValuesCopied: result.customValuesCopied,
        },
      );
      return res.json(result);
    } catch (error) {
      const message = (error as Error).message;
      return res.status(message.endsWith("not found") ? 404 : 409).json({ error: message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/records/:resourceType/:id/redirect",
  h(async (req, res) => {
    const params = mergeParamsSchema.safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid Revenue record" });
    const redirect = await findMergedRecordRedirect(
      cidOf(req),
      params.data.resourceType,
      params.data.id,
    );
    return redirect ? res.json(redirect) : res.status(404).json({ error: "Redirect not found" });
  }),
);

revenueOperationsRouter.get(
  "/revenue/operations",
  h(async (req, res) => {
    const parsed = z
      .object({
        kind: z.enum(["merge", "bulk"]).optional(),
        resourceType: z
          .enum(["account", "contact", "deal", "partnership", "follow_up"])
          .optional(),
        status: z.enum(["completed", "partial", "failed", "rolled_back"]).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listRevenueOperations(cidOf(req), parsed.data));
  }),
);

revenueOperationsRouter.get(
  "/revenue/operations/:id",
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const query = z
      .object({
        rowLimit: z.coerce.number().int().min(1).max(500).optional(),
        rowOffset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Invalid operation query" });
    }
    const result = await getRevenueOperation(cidOf(req), params.data.id, query.data);
    return result ? res.json(result) : res.status(404).json({ error: "Operation not found" });
  }),
);

revenueOperationsRouter.post(
  "/revenue/operations/:id/undo",
  validateBody(z.object({ confirm: z.literal("UNDO") })),
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid operation" });
    try {
      const result = await rollbackRevenueOperation(cidOf(req), params.data.id);
      await audit(
        req,
        "revenue.operation.undo",
        "revenue_operation",
        result.operation.id,
        result.operation.kind,
        { rolledBack: result.rolledBack },
      );
      return res.json(result);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

const bulkTargetSchema = z
  .object({
    ids: z.array(z.string().uuid()).max(5_000).optional(),
    followUpIds: z
      .array(
        z.object({
          source: z.enum(["task", "deal", "partnership"]),
          id: z.string().uuid(),
        }),
      )
      .max(5_000)
      .optional(),
    filter: z
      .object({
        q: z.string().max(200).optional(),
        includeArchived: z.boolean().optional(),
        ownerId: z.string().uuid().optional(),
        ownerEmployeeId: z.string().uuid().optional(),
        unassigned: z.boolean().optional(),
        accountStatus: z.enum(["prospect", "customer", "former"]).optional(),
        lifecycleStage: z
          .enum(CONTACT_LIFECYCLE_STAGES as [ContactLifecycleStage, ...ContactLifecycleStage[]])
          .optional(),
        dealStatus: z.enum(["open", "won", "lost"]).optional(),
        dealStageId: z.string().uuid().optional(),
        partnershipStatus: z.string().max(80).optional(),
        followUpSource: z.enum(["task", "deal", "partnership"]).optional(),
        taskStatus: taskStatusEnum.optional(),
        priority: priorityEnum.optional(),
        linkedResourceType: z.enum(["account", "contact", "deal", "partnership"]).optional(),
        linkedResourceId: z.string().uuid().optional(),
        dueFrom: z.string().datetime().optional(),
        dueTo: z.string().datetime().optional(),
        staleBefore: z.string().datetime().optional(),
        createdBefore: z.string().datetime().optional(),
        closedDeals: z.enum(["include", "only", "exclude"]).optional(),
      })
      .optional(),
  })
  .refine(
    (target) =>
      Boolean(target.ids?.length || target.followUpIds?.length || target.filter),
    "Choose selected IDs or a filter",
  );

const bulkActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("assign_owner"),
    ownerId: z.string().uuid().nullable(),
    ownerEmployeeId: z.string().uuid().nullable(),
  }),
  z.object({
    type: z.literal("set_contact_lifecycle"),
    lifecycleStage: z.enum(
      CONTACT_LIFECYCLE_STAGES as [ContactLifecycleStage, ...ContactLifecycleStage[]],
    ),
  }),
  z.object({
    type: z.literal("set_account_status"),
    accountStatus: z.enum(["prospect", "customer", "former"]),
  }),
  z.object({
    type: z.literal("set_custom_fields"),
    values: z.record(z.unknown()),
  }),
  z.object({
    type: z.literal("archive"),
    archived: z.boolean(),
  }),
  z.object({
    type: z.literal("update_follow_up"),
    taskStatus: taskStatusEnum.optional(),
    priority: priorityEnum.optional(),
    assignedUserId: z.string().uuid().nullable().optional(),
    assignedEmployeeId: z.string().uuid().nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    reminderAt: z.string().datetime().nullable().optional(),
  }),
]);

const bulkSchema = z.object({
  resourceType: z.enum(["account", "contact", "deal", "partnership", "follow_up"]),
  target: bulkTargetSchema,
  action: bulkActionSchema,
  dryRun: z.boolean().default(false),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

revenueOperationsRouter.post(
  "/revenue/bulk",
  validateBody(bulkSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof bulkSchema>;
      const filter = body.target.filter;
      const action =
        body.action.type === "update_follow_up"
          ? {
              ...body.action,
              dueAt: optionalDate(body.action.dueAt),
              reminderAt: optionalDate(body.action.reminderAt),
            }
          : body.action;
      const result = await runRevenueBulkOperation(
        cidOf(req),
        {
          ...body,
          target: {
            ...body.target,
            filter: filter
              ? {
                  ...filter,
                  dueFrom: optionalDate(filter.dueFrom) ?? undefined,
                  dueTo: optionalDate(filter.dueTo) ?? undefined,
                  staleBefore: optionalDate(filter.staleBefore) ?? undefined,
                  createdBefore: optionalDate(filter.createdBefore) ?? undefined,
                }
              : undefined,
          },
          action,
        },
        actorOf(req),
      );
      if (!result.dryRun && !result.replayed) {
        await audit(
          req,
          "revenue.bulk.apply",
          "revenue_operation",
          result.operationId ?? null,
          body.resourceType,
          {
            action: body.action.type,
            matched: result.matched,
            applied: result.applied,
            failed: result.failed,
          },
        );
      }
      return res.json(result);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

const historyEventSchema = z.object({
  sourceId: z.string().min(1).max(300),
  kind: z.enum(["stage_changed", "amount_changed", "owner_changed", "won", "lost"]),
  occurredAt: z.string().datetime(),
  fromStageId: z.string().uuid().nullable().optional(),
  toStageId: z.string().uuid().nullable().optional(),
  fromAmountCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  toAmountCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  currency: z.string().length(3).optional(),
  fromOwnerId: z.string().uuid().nullable().optional(),
  fromOwnerEmployeeId: z.string().uuid().nullable().optional(),
  toOwnerId: z.string().uuid().nullable().optional(),
  toOwnerEmployeeId: z.string().uuid().nullable().optional(),
  lostReason: z.string().max(2_000).optional(),
  metadata: z.unknown().optional(),
});

revenueOperationsRouter.post(
  "/revenue/deal-history/import",
  validateBody(
    z.object({
      batchKey: z.string().min(8).max(200),
      rows: z
        .array(
          z.object({
            sourceId: z.string().min(1).max(300),
            dealId: z.string().uuid(),
            originalCreatedAt: z.string().datetime().optional(),
            events: z.array(historyEventSchema).max(2_000),
          }),
        )
        .min(1)
        .max(200),
    }),
  ),
  h(async (req, res) => {
    const body = req.body as {
      batchKey: string;
      rows: Array<{
        sourceId: string;
        dealId: string;
        originalCreatedAt?: string;
        events: Array<z.infer<typeof historyEventSchema>>;
      }>;
    };
    const result = await importHistoricalDealEvents(
      cidOf(req),
      body.batchKey,
      body.rows.map((row) => ({
        ...row,
        originalCreatedAt: row.originalCreatedAt
          ? new Date(row.originalCreatedAt)
          : undefined,
        events: row.events.map((event) => ({
          ...event,
          occurredAt: new Date(event.occurredAt),
        })),
      })),
      actorOf(req),
    );
    await audit(
      req,
      "revenue.deal_history.import",
      "deal_history_import",
      null,
      body.batchKey,
      {
        imported: result.imported,
        skipped: result.skipped,
        failed: result.failed,
      },
    );
    return res.status(result.failed > 0 ? 207 : 200).json(result);
  }),
);

revenueOperationsRouter.post(
  "/revenue/deal-history/backfill-activities",
  validateBody(z.object({ confirm: z.literal("BACKFILL") })),
  h(async (req, res) => {
    const result = await backfillDealHistoryFromActivities(cidOf(req), actorOf(req));
    await audit(
      req,
      "revenue.deal_history.backfill",
      "deal_history_event",
      null,
      "Activity backfill",
      result,
    );
    return res.json(result);
  }),
);

revenueOperationsRouter.get(
  "/revenue/deal-history",
  h(async (req, res) => {
    const parsed = z
      .object({
        dealId: z.string().uuid().optional(),
        sourceKind: z.enum(["live", "import", "activity_backfill"]).optional(),
        kind: z
          .enum(["created", "stage_changed", "amount_changed", "owner_changed", "won", "lost"])
          .optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(
      await listDealHistory(cidOf(req), {
        ...parsed.data,
        from: optionalDate(parsed.data.from) ?? undefined,
        to: optionalDate(parsed.data.to) ?? undefined,
      }),
    );
  }),
);

const evidenceSourceTypeEnum = z.enum([
  "email",
  "document",
  "integration",
  "finance",
  "website",
  "import",
  "manual",
]);

revenueOperationsRouter.post(
  "/revenue/enrichment/domains/propose",
  validateBody(
    z.object({
      accountIds: z.array(z.string().uuid()).max(5_000).optional(),
      verifiedContactIds: z.array(z.string().uuid()).max(20_000).optional(),
      followWebsiteRedirects: z.boolean().optional(),
    }),
  ),
  h(async (req, res) => {
    const result = await proposeCanonicalDomains(cidOf(req), req.body);
    await audit(
      req,
      "revenue.enrichment.domains.propose",
      "revenue_field_evidence",
      null,
      "Canonical domains",
      result,
    );
    return res.json(result);
  }),
);

revenueOperationsRouter.post(
  "/revenue/enrichment/commercial-values/propose-from-finance",
  validateBody(z.object({ confirm: z.literal("PROPOSE") })),
  h(async (req, res) => {
    const result = await proposeCommercialValuesFromFinance(cidOf(req));
    await audit(
      req,
      "revenue.enrichment.commercial_values.propose",
      "revenue_field_evidence",
      null,
      "Finance evidence",
      result,
    );
    return res.json(result);
  }),
);

revenueOperationsRouter.post(
  "/revenue/enrichment/commercial-values/propose-from-stripe",
  validateBody(z.object({ confirm: z.literal("PROPOSE") })),
  h(async (req, res) => {
    const result = await proposeCommercialValuesFromStripe(cidOf(req));
    await audit(
      req,
      "revenue.enrichment.commercial_values.propose",
      "revenue_field_evidence",
      null,
      "Stripe subscription evidence",
      result,
    );
    return res.json(result);
  }),
);

revenueOperationsRouter.post(
  "/revenue/enrichment/commercial-values/proposals",
  validateBody(
    z.object({
      dealId: z.string().uuid(),
      sourceType: z.enum(["email", "document", "integration", "finance", "manual"]),
      sourceId: z.string().min(1).max(500),
      sourceLabel: z.string().max(500).optional(),
      sourceVerified: z.boolean(),
      confidence: z.number().int().min(0).max(100),
      extractedAt: z.string().datetime().optional(),
      value: z.object({
        amountCents: z.number().int().min(0).max(2_000_000_000),
        currency: z.string().length(3),
        revenueType: z.enum(["one_time", "recurring"]),
        billingInterval: z.enum(["month", "quarter", "year"]).nullable().optional(),
        quantity: z.number().int().min(0).nullable().optional(),
        seats: z.number().int().min(0).nullable().optional(),
        mrrCents: z.number().int().min(0).nullable().optional(),
        arrCents: z.number().int().min(0).nullable().optional(),
        acvCents: z.number().int().min(0).nullable().optional(),
      }),
      metadata: z.unknown().optional(),
    }),
  ),
  h(async (req, res) => {
    try {
      const evidence = await createCommercialValueProposal(cidOf(req), {
        ...req.body,
        extractedAt: req.body.extractedAt ? new Date(req.body.extractedAt) : undefined,
      });
      await audit(
        req,
        "revenue.enrichment.commercial_value.propose",
        "revenue_field_evidence",
        evidence.id,
        evidence.sourceLabel,
        { dealId: evidence.resourceId, confidence: evidence.confidence },
      );
      return res.status(201).json(evidence);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/enrichment/evidence",
  h(async (req, res) => {
    const parsed = z
      .object({
        resourceType: z.enum(["account", "contact", "deal", "partnership"]).optional(),
        resourceId: z.string().uuid().optional(),
        fieldKey: z.string().max(120).optional(),
        sourceType: evidenceSourceTypeEnum.optional(),
        status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listRevenueEvidence(cidOf(req), parsed.data));
  }),
);

revenueOperationsRouter.post(
  "/revenue/enrichment/evidence/:id/review",
  validateBody(z.object({ decision: z.enum(["accept", "reject"]) })),
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid evidence" });
    try {
      const evidence = await reviewRevenueEvidence(
        cidOf(req),
        params.data.id,
        req.body.decision,
        actorOf(req),
      );
      await audit(
        req,
        `revenue.enrichment.evidence.${req.body.decision}`,
        "revenue_field_evidence",
        evidence.id,
        evidence.fieldKey,
        { resourceType: evidence.resourceType, resourceId: evidence.resourceId },
      );
      return res.json(evidence);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/duplicates/scan",
  validateBody(z.object({ confirm: z.literal("SCAN") })),
  h(async (req, res) => {
    const result = await scanRevenueDuplicates(cidOf(req));
    await audit(
      req,
      "revenue.duplicates.scan",
      "revenue_duplicate_candidate",
      null,
      "Revenue duplicates",
      result,
    );
    return res.json(result);
  }),
);

revenueOperationsRouter.get(
  "/revenue/duplicates",
  h(async (req, res) => {
    const parsed = z
      .object({
        resourceType: mergeResourceTypeEnum.optional(),
        status: z.enum(["open", "dismissed", "merged"]).optional(),
        minScore: z.coerce.number().int().min(0).max(100).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listRevenueDuplicateCandidates(cidOf(req), parsed.data));
  }),
);

revenueOperationsRouter.post(
  "/revenue/duplicates/:id/dismiss",
  validateBody(z.object({ confirm: z.literal("DISMISS") })),
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid duplicate candidate" });
    try {
      const row = await dismissRevenueDuplicateCandidate(
        cidOf(req),
        params.data.id,
        req.userId ?? null,
      );
      if (!row) return res.status(404).json({ error: "Duplicate candidate not found" });
      await audit(
        req,
        "revenue.duplicate.dismiss",
        "revenue_duplicate_candidate",
        row.id,
        row.resourceType,
      );
      return res.json(row);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/document-capture/scan",
  validateBody(
    z.object({
      accountId: z.string().uuid().optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.number().int().min(1).max(500).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  ),
  h(async (req, res) => {
    const result = await scanMailForRevenueDocuments(cidOf(req), {
      ...req.body,
      from: optionalDate(req.body.from) ?? undefined,
      to: optionalDate(req.body.to) ?? undefined,
    });
    await audit(
      req,
      "revenue.document_capture.scan",
      "revenue_document_candidate",
      null,
      "Mail attachments",
      result,
    );
    return res.json(result);
  }),
);

revenueOperationsRouter.get(
  "/revenue/document-capture/candidates",
  h(async (req, res) => {
    const parsed = z
      .object({
        status: z.enum(["pending", "accepted", "rejected", "duplicate"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listRevenueDocumentCandidates(cidOf(req), parsed.data));
  }),
);

revenueOperationsRouter.post(
  "/revenue/document-capture/candidates/:id/review",
  validateBody(
    z.discriminatedUnion("decision", [
      z.object({
        decision: z.literal("reject"),
        note: z.string().max(2_000).optional(),
      }),
      z.object({
        decision: z.literal("accept"),
        kind: documentKindEnum.optional(),
        resourceType: z.enum(["account", "contact", "deal", "partnership"]).optional(),
        resourceId: z.string().uuid().optional(),
        note: z.string().max(2_000).optional(),
      }),
    ]),
  ),
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid document candidate" });
    try {
      const candidate = await reviewRevenueDocumentCandidate(
        cidOf(req),
        params.data.id,
        req.body,
        actorOf(req),
      );
      await audit(
        req,
        `revenue.document_capture.${req.body.decision}`,
        "revenue_document_candidate",
        candidate.id,
        candidate.filename,
        {
          status: candidate.status,
          revenueDocumentId: candidate.revenueDocumentId,
        },
      );
      return res.json(candidate);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

// ── Follow-up queue + complete task model ─────────────────────────────────

const taskWriteSchema = z.object({
  subject: z.string().min(1).max(500).optional(),
  bodyText: z.string().max(20_000).optional(),
  dueAt: z.string().max(40).nullable().optional(),
  reminderAt: z.string().max(40).nullable().optional(),
  taskStatus: taskStatusEnum.optional(),
  priority: priorityEnum.optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
  assignedEmployeeId: z.string().uuid().nullable().optional(),
  recurrenceRule: z.string().max(200).nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  dealId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  partnershipId: z.string().uuid().nullable().optional(),
});

revenueOperationsRouter.get(
  "/revenue/follow-ups",
  h(async (req, res) => {
    const parsed = z
      .object({
        state: z.enum(["all", "overdue", "today", "upcoming"]).optional(),
        source: z.enum(["task", "deal", "partnership"]).optional(),
        assignedUserId: z.string().uuid().optional(),
        assignedEmployeeId: z.string().uuid().optional(),
        unassigned: boolQuery,
        priority: priorityEnum.optional(),
        status: taskStatusEnum.optional(),
        linkedResourceType: z.enum(["account", "contact", "deal", "partnership"]).optional(),
        linkedResourceId: z.string().uuid().optional(),
        dueFrom: z.string().datetime().optional(),
        dueTo: z.string().datetime().optional(),
        createdBefore: z.string().datetime().optional(),
        staleBefore: z.string().datetime().optional(),
        dealStageId: z.string().uuid().optional(),
        dealStatus: z.enum(["open", "won", "lost"]).optional(),
        closedDeals: z.enum(["include", "only", "exclude"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json({
      rows: await listFollowUps(cidOf(req), {
        ...parsed.data,
        dueFrom: optionalDate(parsed.data.dueFrom) ?? undefined,
        dueTo: optionalDate(parsed.data.dueTo) ?? undefined,
        createdBefore: optionalDate(parsed.data.createdBefore) ?? undefined,
        staleBefore: optionalDate(parsed.data.staleBefore) ?? undefined,
      }),
    });
  }),
);

revenueOperationsRouter.post(
  "/revenue/follow-ups",
  validateBody(taskWriteSchema.extend({ subject: z.string().min(1).max(500) })),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof taskWriteSchema> & { subject: string };
      const row = await createFollowUpTask(
        cidOf(req),
        {
          ...body,
          dueAt: optionalDate(body.dueAt),
          reminderAt: optionalDate(body.reminderAt),
        },
        actorOf(req),
      );
      await audit(req, "revenue.follow_up.create", "activity", row.id, row.subject);
      return res.status(201).json(row);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.patch(
  "/revenue/follow-ups/:id",
  validateBody(taskWriteSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof taskWriteSchema>;
      const row = await updateFollowUpTask(
        cidOf(req),
        req.params.id,
        {
          ...body,
          dueAt: optionalDate(body.dueAt),
          reminderAt: optionalDate(body.reminderAt),
        },
        actorOf(req),
      );
      if (!row) return res.status(404).json({ error: "Follow-up task not found" });
      await audit(req, "revenue.follow_up.update", "activity", row.id, row.subject, {
        changes: Object.keys(body),
      });
      return res.json(row);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

// ── Controlled classifications ────────────────────────────────────────────

revenueOperationsRouter.get(
  "/revenue/classifications",
  h(async (req, res) => {
    const parsed = z
      .object({ kind: classificationKindEnum.optional(), includeArchived: boolQuery })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json({
      rows: await listRevenueClassifications(
        cidOf(req),
        parsed.data.kind,
        parsed.data.includeArchived,
      ),
    });
  }),
);

revenueOperationsRouter.post(
  "/revenue/classifications",
  validateBody(
    z.object({
      kind: classificationKindEnum,
      label: z.string().min(1).max(120),
      value: z.string().max(80).optional(),
    }),
  ),
  h(async (req, res) => {
    try {
      const row = await createRevenueClassification(cidOf(req), req.body);
      await audit(
        req,
        "revenue.classification.create",
        "revenue_classification",
        row.id,
        row.label,
      );
      return res.status(201).json(row);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.patch(
  "/revenue/classifications/:id",
  validateBody(
    z.object({
      label: z.string().min(1).max(120).optional(),
      sortOrder: z.number().int().optional(),
      archived: z.boolean().optional(),
    }),
  ),
  h(async (req, res) => {
    const row = await updateRevenueClassification(cidOf(req), req.params.id, req.body);
    if (!row) return res.status(404).json({ error: "Classification not found" });
    await audit(req, "revenue.classification.update", "revenue_classification", row.id, row.label);
    return res.json(row);
  }),
);

// ── Typed custom fields ────────────────────────────────────────────────────

revenueOperationsRouter.get(
  "/revenue/custom-fields",
  h(async (req, res) => {
    const parsed = z
      .object({ resourceType: resourceTypeEnum.optional(), includeArchived: boolQuery })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json({
      rows: await listCustomFields(
        cidOf(req),
        parsed.data.resourceType,
        parsed.data.includeArchived,
      ),
    });
  }),
);

revenueOperationsRouter.post(
  "/revenue/custom-fields/base-migration-preset",
  h(async (req, res) => {
    const result = await installBaseMigrationCustomFields(cidOf(req));
    await audit(
      req,
      "revenue.custom_fields.install_base_migration",
      "revenue_custom_field",
      null,
      "Base migration fields",
      { created: result.created.map((field) => field.key) },
    );
    return res.status(result.created.length > 0 ? 201 : 200).json(result);
  }),
);

revenueOperationsRouter.post(
  "/revenue/custom-fields",
  validateBody(
    z.object({
      resourceType: resourceTypeEnum,
      name: z.string().min(1).max(120),
      key: z.string().max(80).optional(),
      fieldType: fieldTypeEnum,
      options: z.array(z.string().min(1).max(120)).max(200).optional(),
      required: z.boolean().optional(),
    }),
  ),
  h(async (req, res) => {
    try {
      const row = await createCustomField(cidOf(req), req.body);
      await audit(req, "revenue.custom_field.create", "revenue_custom_field", row.id, row.name);
      return res.status(201).json(row);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.patch(
  "/revenue/custom-fields/:id",
  validateBody(
    z.object({
      name: z.string().min(1).max(120).optional(),
      options: z.array(z.string().min(1).max(120)).max(200).optional(),
      required: z.boolean().optional(),
      sortOrder: z.number().int().optional(),
      archived: z.boolean().optional(),
    }),
  ),
  h(async (req, res) => {
    const row = await updateCustomField(cidOf(req), req.params.id, req.body);
    if (!row) return res.status(404).json({ error: "Custom field not found" });
    await audit(req, "revenue.custom_field.update", "revenue_custom_field", row.id, row.name);
    return res.json(row);
  }),
);

revenueOperationsRouter.get(
  "/revenue/custom-values/:resourceType/:resourceId",
  h(async (req, res) => {
    const resourceType = resourceTypeEnum.safeParse(req.params.resourceType);
    if (!resourceType.success) return res.status(400).json({ error: "Invalid resource type" });
    return res.json({
      rows: await getCustomValues(cidOf(req), resourceType.data, req.params.resourceId),
    });
  }),
);

revenueOperationsRouter.put(
  "/revenue/custom-values/:resourceType/:resourceId",
  validateBody(z.object({ values: z.record(z.unknown()) })),
  h(async (req, res) => {
    const resourceType = resourceTypeEnum.safeParse(req.params.resourceType);
    if (!resourceType.success) return res.status(400).json({ error: "Invalid resource type" });
    try {
      const rows = await setCustomValues(
        cidOf(req),
        resourceType.data,
        req.params.resourceId,
        (req.body as { values: Record<string, unknown> }).values,
      );
      await audit(
        req,
        "revenue.custom_values.update",
        resourceType.data,
        req.params.resourceId,
        resourceType.data,
        { keys: Object.keys((req.body as { values: Record<string, unknown> }).values) },
      );
      return res.json({ rows });
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

// ── Partnerships ──────────────────────────────────────────────────────────

const partnershipWriteSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  type: z.string().max(80).optional(),
  status: z.string().max(80).optional(),
  customerId: z.string().uuid().nullable().optional(),
  websiteUrl: z.string().max(1000).optional(),
  integrationContext: z.string().max(20_000).optional(),
  channelContext: z.string().max(20_000).optional(),
  notes: z.string().max(20_000).optional(),
  ownerId: z.string().uuid().nullable().optional(),
  ownerEmployeeId: z.string().uuid().nullable().optional(),
  nextFollowUpAt: z.string().max(40).nullable().optional(),
  reminderAt: z.string().max(40).nullable().optional(),
  archived: z.boolean().optional(),
});

revenueOperationsRouter.get(
  "/revenue/partnerships",
  h(async (req, res) => {
    const parsed = z
      .object({
        q: z.string().max(200).optional(),
        status: z.string().max(80).optional(),
        type: z.string().max(80).optional(),
        customFieldKey: z.string().max(80).optional(),
        customFieldValue: z.string().max(500).optional(),
        includeArchived: boolQuery,
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listPartnerships(cidOf(req), parsed.data));
  }),
);

revenueOperationsRouter.post(
  "/revenue/partnerships",
  validateBody(partnershipWriteSchema.extend({ name: z.string().min(1).max(200) })),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof partnershipWriteSchema> & { name: string };
      const row = await createPartnership(
        cidOf(req),
        {
          ...body,
          nextFollowUpAt: optionalDate(body.nextFollowUpAt),
          reminderAt: optionalDate(body.reminderAt),
        },
        actorOf(req),
      );
      await audit(req, "revenue.partnership.create", "partnership", row.id, row.name);
      return res.status(201).json(row);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/partnerships/:id",
  h(async (req, res) => {
    const row = await getPartnership(cidOf(req), req.params.id);
    if (!row) return res.status(404).json({ error: "Partnership not found" });
    const [activities, customValues, documents] = await Promise.all([
      listActivities(cidOf(req), { partnershipId: req.params.id, limit: 100 }),
      getCustomValues(cidOf(req), "partnership", req.params.id),
      listRevenueDocuments(cidOf(req), { partnershipId: req.params.id }),
    ]);
    return res.json({
      ...row,
      activities: activities.rows,
      activityTotal: activities.total,
      customValues,
      documents,
    });
  }),
);

revenueOperationsRouter.patch(
  "/revenue/partnerships/:id",
  validateBody(partnershipWriteSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof partnershipWriteSchema>;
      const row = await updatePartnership(cidOf(req), req.params.id, {
        ...body,
        nextFollowUpAt: optionalDate(body.nextFollowUpAt),
        reminderAt: optionalDate(body.reminderAt),
      });
      if (!row) return res.status(404).json({ error: "Partnership not found" });
      await audit(req, "revenue.partnership.update", "partnership", row.id, row.name, {
        changes: Object.keys(body),
      });
      return res.json(row);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/partnerships/:id/contacts",
  validateBody(
    z.object({
      contactId: z.string().uuid(),
      role: z.string().max(120).optional(),
      isPrimary: z.boolean().optional(),
      replyAll: z.boolean().optional(),
    }),
  ),
  h(async (req, res) => {
    try {
      const row = await addPartnershipContact(cidOf(req), req.params.id, req.body);
      await audit(req, "revenue.partnership.contact.add", "partnership", req.params.id, "Contact", {
        contactId: row.contactId,
        replyAll: row.replyAll,
      });
      return res.status(201).json(row);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.delete(
  "/revenue/partnerships/:id/contacts/:contactId",
  h(async (req, res) => {
    const removed = await removePartnershipContact(cidOf(req), req.params.id, req.params.contactId);
    return removed ? res.json({ ok: true }) : res.status(404).json({ error: "Contact not found" });
  }),
);

// ── Formal revenue documents ──────────────────────────────────────────────

const documentWriteSchema = z.object({
  kind: documentKindEnum,
  title: z.string().min(1).max(200),
  notes: z.string().max(2000).optional(),
  dealId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  partnershipId: z.string().uuid().nullable().optional(),
  contactId: z.string().uuid().nullable().optional(),
  attachmentId: z.string().uuid().nullable().optional(),
  sourceMailMessageId: z.string().uuid().nullable().optional(),
  externalUrl: z.string().url().max(2000).or(z.literal("")).optional(),
});
const documentPatchSchema = documentWriteSchema
  .pick({
    kind: true,
    title: true,
    notes: true,
    dealId: true,
    customerId: true,
    partnershipId: true,
    contactId: true,
    externalUrl: true,
  })
  .partial();

revenueOperationsRouter.get(
  "/revenue/documents",
  h(async (req, res) => {
    const parsed = z
      .object({
        dealId: z.string().uuid().optional(),
        customerId: z.string().uuid().optional(),
        partnershipId: z.string().uuid().optional(),
        contactId: z.string().uuid().optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json({ rows: await listRevenueDocuments(cidOf(req), parsed.data) });
  }),
);

revenueOperationsRouter.post(
  "/revenue/documents",
  validateBody(documentWriteSchema),
  h(async (req, res) => {
    try {
      const row = await createRevenueDocument(cidOf(req), req.body, actorOf(req));
      await audit(req, "revenue.document.create", "revenue_document", row.id, row.title);
      return res.status(201).json(row);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/documents/:id",
  h(async (req, res) => {
    const document = await getRevenueDocument(cidOf(req), req.params.id);
    return document ? res.json(document) : res.status(404).json({ error: "Document not found" });
  }),
);

revenueOperationsRouter.patch(
  "/revenue/documents/:id",
  validateBody(documentPatchSchema),
  h(async (req, res) => {
    try {
      const document = await updateRevenueDocument(cidOf(req), req.params.id, req.body);
      if (!document) return res.status(404).json({ error: "Document not found" });
      await audit(req, "revenue.document.update", "revenue_document", document.id, document.title, {
        changes: Object.keys(req.body),
      });
      return res.json(document);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

// Uploads use the existing company attachment store. Hydrate Company only for
// this multipart route because the storage middleware needs its stable slug.
revenueOperationsRouter.post(
  "/revenue/documents/upload",
  h(async (req, res) => {
    const company = await AppDataSource.getRepository(Company).findOneBy({ id: cidOf(req) });
    if (!company) return res.status(404).json({ error: "Company not found" });
    (req as unknown as { company: Company }).company = company;
    return new Promise<void>((resolve, reject) => {
      uploadMiddleware.single("file")(req, res, (error) => {
        if (error) {
          reject(error);
          return;
        }
        const file = (req as unknown as { file?: Express.Multer.File }).file;
        if (!file) {
          res.status(400).json({ error: "No file uploaded" });
          resolve();
          return;
        }
        recordAttachment({
          companyId: company.id,
          companySlug: company.slug,
          file,
          uploadedByUserId: req.userId!,
        })
          .then((attachment) => {
            res.status(201).json(attachment);
            resolve();
          })
          .catch(reject);
      });
    });
  }),
);

revenueOperationsRouter.get(
  "/revenue/documents/:id/file",
  h(async (req, res) => {
    const document = await getRevenueDocument(cidOf(req), req.params.id);
    if (!document?.attachmentId) {
      return res.status(404).json({ error: "Document file not found" });
    }
    const resolved = await resolveAttachmentFile(document.attachmentId, cidOf(req));
    if (!resolved) return res.status(404).json({ error: "Document file not found" });
    res.setHeader("Content-Type", resolved.row.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${encodeURIComponent(resolved.row.filename)}"`,
    );
    return res.sendFile(resolved.absPath);
  }),
);

revenueOperationsRouter.delete(
  "/revenue/documents/:id",
  h(async (req, res) => {
    const document = await getRevenueDocument(cidOf(req), req.params.id);
    if (!document) return res.status(404).json({ error: "Document not found" });
    const removed = await deleteRevenueDocument(cidOf(req), req.params.id);
    if (!removed) return res.status(404).json({ error: "Document not found" });
    await audit(req, "revenue.document.delete", "revenue_document", document.id, document.title);
    return res.json({ ok: true });
  }),
);

// ── Reversible Base / CSV migration ───────────────────────────────────────

const importRowSchema = z.object({
  sourceId: z.string().min(1).max(500),
  values: z.record(z.unknown()),
});
const importInputSchema = z.object({
  resourceType: resourceTypeEnum,
  sourceKind: z.enum(["base", "csv"]),
  sourceLabel: z.string().min(1).max(500),
  sourceBaseId: z.string().uuid().nullable().optional(),
  sourceTableId: z.string().uuid().nullable().optional(),
  mapping: z.record(z.string().min(1).max(500)),
  rows: z.array(importRowSchema).max(10_000).optional(),
});
const linkedImportInputSchema = importInputSchema
  .omit({ resourceType: true, mapping: true })
  .extend({
    mapping: z.object({
      account: z.record(z.string().min(1).max(500)),
      contact: z.record(z.string().min(1).max(500)),
      deal: z.record(z.string().min(1).max(500)),
    }),
  });

async function resolvedImportRows(
  companyId: string,
  body: z.infer<typeof importInputSchema>,
): Promise<{ rows: ImportRow[]; sourceLabel: string }> {
  if (body.sourceKind === "base") {
    if (!body.sourceBaseId || !body.sourceTableId) {
      throw new Error("Base and table are required");
    }
    const source = await loadBaseImportRows(companyId, body.sourceBaseId, body.sourceTableId);
    return { rows: source.rows, sourceLabel: source.sourceLabel };
  }
  return { rows: body.rows ?? [], sourceLabel: body.sourceLabel };
}

async function resolvedLinkedImportRows(
  companyId: string,
  body: z.infer<typeof linkedImportInputSchema>,
): Promise<{ rows: ImportRow[]; sourceLabel: string }> {
  if (body.sourceKind === "base") {
    if (!body.sourceBaseId || !body.sourceTableId) {
      throw new Error("Base and table are required");
    }
    const source = await loadBaseImportRows(companyId, body.sourceBaseId, body.sourceTableId);
    return { rows: source.rows, sourceLabel: source.sourceLabel };
  }
  return { rows: body.rows ?? [], sourceLabel: body.sourceLabel };
}

revenueOperationsRouter.get(
  "/revenue/imports/base-source",
  h(async (req, res) => {
    const parsed = z
      .object({ baseId: z.string().uuid(), tableId: z.string().uuid() })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid Base source" });
    try {
      return res.json(
        await loadBaseImportRows(cidOf(req), parsed.data.baseId, parsed.data.tableId),
      );
    } catch (error) {
      return res.status(404).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/imports/preview",
  validateBody(importInputSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof importInputSchema>;
      const source = await resolvedImportRows(cidOf(req), body);
      return res.json(
        await previewRevenueImport(cidOf(req), body.resourceType, body.mapping, source.rows),
      );
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/imports/linked/preview",
  validateBody(linkedImportInputSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof linkedImportInputSchema>;
      const source = await resolvedLinkedImportRows(cidOf(req), body);
      return res.json(
        await previewLinkedRevenueImport(
          cidOf(req),
          body.mapping as LinkedImportMapping,
          source.rows,
        ),
      );
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/imports",
  validateBody(importInputSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof importInputSchema>;
      const source = await resolvedImportRows(cidOf(req), body);
      const batch = await commitRevenueImport(
        cidOf(req),
        {
          ...body,
          sourceLabel: source.sourceLabel,
          rows: source.rows,
        },
        actorOf(req),
      );
      await audit(req, "revenue.import.commit", "revenue_import", batch.id, batch.sourceLabel, {
        resourceType: batch.resourceType,
      });
      return res.status(201).json(batch);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/imports/linked",
  validateBody(linkedImportInputSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof linkedImportInputSchema>;
      const source = await resolvedLinkedImportRows(cidOf(req), body);
      const batch = await commitLinkedRevenueImport(
        cidOf(req),
        {
          ...body,
          sourceLabel: source.sourceLabel,
          mapping: body.mapping as LinkedImportMapping,
          rows: source.rows,
        },
        actorOf(req),
      );
      await audit(
        req,
        "revenue.import.linked.commit",
        "revenue_import",
        batch.id,
        batch.sourceLabel,
        { resourceType: batch.resourceType },
      );
      return res.status(201).json(batch);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/imports",
  h(async (req, res) => {
    const parsed = z
      .object({
        sourceKind: z.enum(["base", "csv"]).optional(),
        status: z.enum(["completed", "rolled_back", "failed"]).optional(),
        resourceType: z
          .enum(["account", "contact", "deal", "partnership", "account_contact_deal"])
          .optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        summaryOnly: boolQuery,
        limit: z.coerce.number().int().min(1).max(200).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(
      await queryRevenueImports(cidOf(req), {
        ...parsed.data,
        from: optionalDate(parsed.data.from) ?? undefined,
        to: optionalDate(parsed.data.to) ?? undefined,
      }),
    );
  }),
);

revenueOperationsRouter.get(
  "/revenue/imports/:id",
  h(async (req, res) => {
    const batch = await getRevenueImport(cidOf(req), req.params.id);
    return batch ? res.json(batch) : res.status(404).json({ error: "Import not found" });
  }),
);

revenueOperationsRouter.get(
  "/revenue/imports/:id/rows",
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const query = z
      .object({
        resourceType: resourceTypeEnum.optional(),
        status: z.enum(["created", "matched", "skipped", "failed", "rolled_back"]).optional(),
        action: z.string().max(80).optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Invalid import row query" });
    }
    const result = await getRevenueImportRows(cidOf(req), params.data.id, query.data);
    return result ? res.json(result) : res.status(404).json({ error: "Import not found" });
  }),
);

revenueOperationsRouter.get(
  "/revenue/imports/:id/reconciliation",
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const query = z
      .object({
        format: z.enum(["json", "csv"]).default("json"),
        resourceType: resourceTypeEnum.optional(),
        status: z.enum(["created", "matched", "skipped", "failed", "rolled_back"]).optional(),
        action: z.string().max(80).optional(),
        q: z.string().max(200).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Invalid reconciliation query" });
    }
    const { format, ...rowQuery } = query.data;
    const result = await getRevenueImportRows(cidOf(req), params.data.id, rowQuery);
    if (!result) return res.status(404).json({ error: "Import not found" });
    if (format === "csv") {
      const csv = revenueExportCsv({
        resource: "import_reconciliation",
        generatedAt: new Date(),
        offset: rowQuery.offset ?? 0,
        limit: rowQuery.limit ?? 100,
        total: result.total,
        nextOffset:
          (rowQuery.offset ?? 0) + result.rows.length < result.total
            ? (rowQuery.offset ?? 0) + result.rows.length
            : null,
        rows: result.rows.map((row) => ({ ...row })),
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="revenue-import-${params.data.id}.csv"`,
      );
      return res.send(csv);
    }
    return res.json(result);
  }),
);

revenueOperationsRouter.get(
  "/revenue/exports/:resource",
  h(async (req, res) => {
    const params = z
      .object({
        resource: z.enum(
          REVENUE_EXPORT_RESOURCES as unknown as [
            RevenueExportResource,
            ...RevenueExportResource[],
          ],
        ),
      })
      .safeParse(req.params);
    const query = z
      .object({
        format: z.enum(["json", "csv"]).default("json"),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Invalid Revenue export query" });
    }
    const page = await exportRevenueSnapshotPage(
      cidOf(req),
      params.data.resource,
      query.data,
    );
    if (query.data.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("X-Revenue-Export-Next-Offset", page.nextOffset?.toString() ?? "");
      res.setHeader("X-Revenue-Export-Total", page.total?.toString() ?? "");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="revenue-${params.data.resource}-${page.offset}.csv"`,
      );
      return res.send(revenueExportCsv(page));
    }
    return res.json(page);
  }),
);

revenueOperationsRouter.post(
  "/revenue/imports/:id/attachments",
  validateBody(
    z.object({
      targetResourceType: resourceTypeEnum.optional(),
      kind: documentKindEnum.optional(),
    }),
  ),
  h(async (req, res) => {
    try {
      const result = await migrateBaseAttachmentsForImport(
        cidOf(req),
        req.params.id,
        req.body,
        actorOf(req),
      );
      await audit(
        req,
        "revenue.import.attachments",
        "revenue_import",
        req.params.id,
        "Base attachments",
        {
          targetResourceType: result.targetResourceType,
          migrated: result.migrated,
          skipped: result.skipped,
          failed: result.failures.length,
        },
      );
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/imports/:id/rollback",
  h(async (req, res) => {
    const result = await rollbackRevenueImport(cidOf(req), req.params.id);
    if (!result) return res.status(404).json({ error: "Import not found" });
    await audit(
      req,
      "revenue.import.rollback",
      "revenue_import",
      result.batch.id,
      result.batch.sourceLabel,
      {
        deleted: result.deleted,
        blocked: result.blocked,
      },
    );
    return res.json(result);
  }),
);
