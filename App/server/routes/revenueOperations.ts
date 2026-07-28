import { Request, Response, Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import {
  ACTIVITY_PRIORITIES,
  ACTIVITY_TASK_STATUSES,
  type ActivityPriority,
  type ActivityTaskStatus,
} from "../db/entities/Activity.js";
import { CONTACT_LIFECYCLE_STAGES, type ContactLifecycleStage } from "../db/entities/Contact.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
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
import { RevenueFieldEvidence } from "../db/entities/RevenueFieldEvidence.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import {
  effectiveFinanceAccess,
  requireFinanceRead,
  requireFinanceWrite,
} from "../middleware/financeAccess.js";
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
  listFollowUpPage,
  updateFollowUpTask,
} from "../services/revenue/followUps.js";
import {
  createFollowUpView,
  deleteFollowUpView,
  listFollowUpViews,
  updateFollowUpView,
  type FollowUpViewFilters,
} from "../services/revenue/followUpViews.js";
import {
  mergeRevenueRecords,
  previewRevenueMerge,
  type MergeResourceType,
} from "../services/revenue/merge.js";
import { runRevenueBulkOperation } from "../services/revenue/bulk.js";
import {
  createRevenueBulkJob,
  getRevenueBulkJob,
  rollbackRevenueBulkJob,
} from "../services/revenue/bulkJobs.js";
import {
  backfillDealHistoryFromActivities,
  importHistoricalDealEvents,
  listDealHistory,
  listDealHistoryCoverage,
} from "../services/revenue/dealHistory.js";
import {
  assertRevenueEvidenceSource,
  createCommercialValueProposal,
  listCommercialValueBacklog,
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
  type RevenueExportOptionsByResource,
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
  listRevenueFirmographicLookups,
  MAX_FIRMOGRAPHIC_ACCOUNTS,
  previewRevenueFirmographics,
  proposeRevenueFirmographics,
} from "../services/revenue/firmographics.js";
import {
  commitLinkedRevenueImport,
  commitRevenueImport,
  getRevenueImportSummary,
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
  parseRevenueImportSource,
  REVENUE_IMPORT_SOURCE_MAX_BYTES,
  type RevenueImportFileFormat,
} from "../services/revenue/importSources.js";
import {
  addPartnershipContact,
  createPartnership,
  getPartnership,
  listPartnerships,
  removePartnershipContact,
  setPartnershipArchived,
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
      resolutions: z.record(z.enum(["source", "target"])).default({}),
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
        req.body.resolutions,
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
      resolutions: z.record(z.enum(["source", "target"])).default({}),
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
        req.body.resolutions,
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
        kind: z.enum(["merge", "bulk", "history_import"]).optional(),
        resourceType: z.enum(["account", "contact", "deal", "partnership", "follow_up"]).optional(),
        status: z
          .enum(["queued", "running", "completed", "partial", "failed", "rolled_back"])
          .optional(),
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
      const bulkJob = await getRevenueBulkJob(cidOf(req), params.data.id, { rowLimit: 1 });
      const result = bulkJob
        ? await rollbackRevenueBulkJob(cidOf(req), params.data.id).then((rollback) => ({
            operation: rollback.job,
            rolledBack: rollback.rolledBack,
          }))
        : await rollbackRevenueOperation(cidOf(req), params.data.id);
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
        state: z.enum(["all", "overdue", "today", "upcoming"]).optional(),
        q: z.string().max(200).optional(),
        includeArchived: z.boolean().optional(),
        ownerId: z.string().uuid().optional(),
        ownerEmployeeId: z.string().uuid().optional(),
        assignedUserId: z.string().uuid().optional(),
        assignedEmployeeId: z.string().uuid().optional(),
        unassigned: z.boolean().optional(),
        accountStatus: z.enum(["prospect", "customer", "former"]).optional(),
        lifecycleStage: z
          .enum(CONTACT_LIFECYCLE_STAGES as [ContactLifecycleStage, ...ContactLifecycleStage[]])
          .optional(),
        dealStatus: z.enum(["open", "won", "lost"]).optional(),
        dealStageId: z.string().uuid().optional(),
        partnershipStatus: z.string().max(80).optional(),
        source: z.enum(["task", "deal", "partnership"]).optional(),
        followUpSource: z.enum(["task", "deal", "partnership"]).optional(),
        status: taskStatusEnum.optional(),
        taskStatus: taskStatusEnum.optional(),
        priority: priorityEnum.optional(),
        linkedResourceType: z.enum(["account", "contact", "deal", "partnership"]).optional(),
        linkedResourceId: z.string().uuid().optional(),
        dueFrom: z.string().datetime().optional(),
        dueTo: z.string().datetime().optional(),
        reminderFrom: z.string().datetime().optional(),
        reminderTo: z.string().datetime().optional(),
        overdueMinDays: z.number().int().min(0).max(36_500).optional(),
        overdueMaxDays: z.number().int().min(0).max(36_500).optional(),
        staleBefore: z.string().datetime().optional(),
        createdBefore: z.string().datetime().optional(),
        closedDeals: z.enum(["include", "only", "exclude"]).optional(),
        archivedResources: z.enum(["include", "only", "exclude"]).optional(),
      })
      .optional(),
  })
  .refine(
    (target) => Boolean(target.ids?.length || target.followUpIds?.length || target.filter),
    "Choose selected IDs or a filter",
  );

const standardFieldValuesSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(20_000).optional(),
    email: z.union([z.literal(""), z.string().email().max(320)]).optional(),
    phone: z.string().max(100).optional(),
    domain: z.string().max(253).optional(),
    websiteUrl: z.union([z.literal(""), z.string().url().max(2_000)]).optional(),
    linkedinUrl: z.union([z.literal(""), z.string().url().max(2_000)]).optional(),
    industry: z.string().max(200).optional(),
    employeeCount: z.number().int().min(0).max(2_000_000_000).optional(),
    billingAddress: z.string().max(10_000).optional(),
    shippingAddress: z.string().max(10_000).optional(),
    taxNumber: z.string().max(200).optional(),
    currency: z.string().length(3).optional(),
    annualContractValueCents: z.number().int().min(0).max(2_000_000_000).optional(),
    notes: z.string().max(20_000).optional(),
    customerId: z.string().uuid().nullable().optional(),
    companyName: z.string().max(200).optional(),
    source: z.string().max(120).optional(),
    sourceDetail: z.string().max(500).optional(),
    score: z.number().int().min(0).max(100).optional(),
    doNotContact: z.boolean().optional(),
    primaryContactId: z.string().uuid().nullable().optional(),
    amountCents: z.number().int().min(0).max(2_000_000_000).optional(),
    probabilityOverride: z.number().int().min(0).max(100).nullable().optional(),
    expectedCloseDate: z.string().datetime().nullable().optional(),
    nextStep: z.string().max(2_000).optional(),
    nextFollowUpAt: z.string().datetime().nullable().optional(),
    followUpReminderAt: z.string().datetime().nullable().optional(),
    type: z.string().min(1).max(80).optional(),
    status: z.string().min(1).max(80).optional(),
    integrationContext: z.string().max(20_000).optional(),
    channelContext: z.string().max(20_000).optional(),
    reminderAt: z.string().datetime().nullable().optional(),
  })
  .strict();

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
    type: z.literal("move_deal_stage"),
    stageId: z.string().uuid(),
    lostReason: z.string().min(1).max(2_000).optional(),
  }),
  z.object({
    type: z.literal("update_standard_fields"),
    confirm: z.literal("UPDATE_STANDARD_FIELDS"),
    values: standardFieldValuesSchema.optional(),
    rows: z
      .array(
        z.object({
          id: z.string().uuid(),
          values: standardFieldValuesSchema,
        }),
      )
      .min(1)
      .max(5_000)
      .optional(),
    notesMode: z.enum(["replace", "append", "clear"]).optional(),
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

const bulkSchema = z
  .object({
    resourceType: z.enum(["account", "contact", "deal", "partnership", "follow_up"]),
    target: bulkTargetSchema,
    action: bulkActionSchema,
    dryRun: z.boolean().default(false),
    idempotencyKey: z.string().min(8).max(200).optional(),
    mode: z.enum(["atomic", "partial"]).default("partial"),
  })
  .superRefine((body, context) => {
    if (body.action.type !== "update_standard_fields") return;
    if (Boolean(body.action.values) === Boolean(body.action.rows?.length)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Supply either shared values or per-record values",
      });
    }
    if (
      body.action.notesMode !== "clear" &&
      !Object.keys(body.action.values ?? {}).length &&
      !body.action.rows?.some((row) => Object.keys(row.values).length > 0)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["action"],
        message: "Choose at least one standard field",
      });
    }
  });

function normalizedBulkBody(
  body: z.infer<typeof bulkSchema>,
): Parameters<typeof runRevenueBulkOperation>[1] {
  const filter = body.target.filter;
  const normalizeStandardValues = (
    values: z.infer<typeof standardFieldValuesSchema>,
  ): Record<string, unknown> => ({
    ...values,
    ...("expectedCloseDate" in values
      ? { expectedCloseDate: optionalDate(values.expectedCloseDate) }
      : {}),
    ...("nextFollowUpAt" in values ? { nextFollowUpAt: optionalDate(values.nextFollowUpAt) } : {}),
    ...("followUpReminderAt" in values
      ? { followUpReminderAt: optionalDate(values.followUpReminderAt) }
      : {}),
    ...("reminderAt" in values ? { reminderAt: optionalDate(values.reminderAt) } : {}),
  });
  const action = (() => {
    if (body.action.type === "update_follow_up") {
      return {
        ...body.action,
        dueAt: optionalDate(body.action.dueAt),
        reminderAt: optionalDate(body.action.reminderAt),
      };
    }
    if (body.action.type === "update_standard_fields") {
      return {
        ...body.action,
        values: body.action.values ? normalizeStandardValues(body.action.values) : undefined,
        rows: body.action.rows?.map((row) => ({
          id: row.id,
          values: normalizeStandardValues(row.values),
        })),
      };
    }
    return body.action;
  })();
  return {
    ...body,
    target: {
      ...body.target,
      filter: filter
        ? {
            ...filter,
            dueFrom: optionalDate(filter.dueFrom) ?? undefined,
            dueTo: optionalDate(filter.dueTo) ?? undefined,
            reminderFrom: optionalDate(filter.reminderFrom) ?? undefined,
            reminderTo: optionalDate(filter.reminderTo) ?? undefined,
            staleBefore: optionalDate(filter.staleBefore) ?? undefined,
            createdBefore: optionalDate(filter.createdBefore) ?? undefined,
          }
        : undefined,
    },
    action,
  };
}

revenueOperationsRouter.post(
  "/revenue/bulk/jobs",
  validateBody(bulkSchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof bulkSchema>;
    if (body.dryRun) {
      return res.status(400).json({ error: "Use /revenue/bulk for a synchronous dry run" });
    }
    try {
      const result = await createRevenueBulkJob(cidOf(req), normalizedBulkBody(body), actorOf(req));
      if (!result.replayed) {
        await audit(
          req,
          "revenue.bulk.queue",
          "revenue_operation",
          result.job.id,
          body.resourceType,
          {
            action: body.action.type,
            mode: body.mode,
            frozenSelection: result.preview.matched,
          },
        );
      }
      return res.status(result.replayed ? 200 : 202).json(result);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/bulk/jobs/:id",
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const query = z
      .object({
        rowLimit: z.coerce.number().int().min(1).max(500).optional(),
        rowOffset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Invalid bulk job query" });
    }
    const job = await getRevenueBulkJob(cidOf(req), params.data.id, query.data);
    return job ? res.json(job) : res.status(404).json({ error: "Bulk job not found" });
  }),
);

revenueOperationsRouter.get(
  "/revenue/bulk/jobs/:id/reconciliation",
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    const query = z
      .object({
        format: z.enum(["json", "csv"]).default("json"),
        limit: z.coerce.number().int().min(1).max(500).default(500),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Invalid bulk reconciliation query" });
    }
    const job = await getRevenueBulkJob(cidOf(req), params.data.id, {
      rowLimit: query.data.limit,
      rowOffset: query.data.offset,
    });
    if (!job) return res.status(404).json({ error: "Bulk job not found" });
    if (query.data.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="revenue-bulk-${params.data.id}-${query.data.offset}.csv"`,
      );
      return res.send(
        revenueExportCsv({
          resource: "import_reconciliation",
          generatedAt: new Date(),
          offset: query.data.offset,
          limit: query.data.limit,
          total: job.rowTotal,
          nextOffset:
            query.data.offset + job.rows.length < job.rowTotal
              ? query.data.offset + job.rows.length
              : null,
          rows: job.rows,
        }),
      );
    }
    return res.json(job);
  }),
);

revenueOperationsRouter.post(
  "/revenue/bulk/jobs/:id/undo",
  validateBody(z.object({ confirm: z.literal("UNDO") })),
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid bulk job" });
    try {
      const result = await rollbackRevenueBulkJob(cidOf(req), params.data.id);
      await audit(
        req,
        "revenue.bulk.undo",
        "revenue_operation",
        result.job.id,
        result.job.resourceType,
        { rolledBack: result.rolledBack },
      );
      return res.json(result);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/bulk",
  validateBody(bulkSchema),
  h(async (req, res) => {
    try {
      const body = req.body as z.infer<typeof bulkSchema>;
      const result = await runRevenueBulkOperation(
        cidOf(req),
        normalizedBulkBody(body),
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
  sourceEventId: z.string().min(1).max(300),
  eventType: z.enum([
    "stage_changed",
    "amount_changed",
    "owner_changed",
    "expected_close_changed",
    "won",
    "lost",
  ]),
  effectiveAt: z.string().datetime(),
  fromStageId: z.string().uuid().nullable().optional(),
  toStageId: z.string().uuid().nullable().optional(),
  fromAmountCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  toAmountCents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  fromCurrency: z.string().length(3).nullable().optional(),
  toCurrency: z.string().length(3).nullable().optional(),
  currency: z.string().length(3).optional(),
  fromOwnerId: z.string().uuid().nullable().optional(),
  fromOwnerEmployeeId: z.string().uuid().nullable().optional(),
  toOwnerId: z.string().uuid().nullable().optional(),
  toOwnerEmployeeId: z.string().uuid().nullable().optional(),
  fromExpectedCloseDate: z.string().datetime().nullable().optional(),
  toExpectedCloseDate: z.string().datetime().nullable().optional(),
  lostReason: z.string().max(2_000).optional(),
  sourceActor: z.string().max(300).optional(),
  metadata: z.unknown().optional(),
});

const historyImportSchema = z
  .object({
    batchKey: z.string().min(8).max(200),
    sourceSystem: z.string().min(1).max(200),
    dryRun: z.boolean().default(true),
    confirm: z.literal("IMPORT").optional(),
    rows: z
      .array(
        z.object({
          sourceRecordId: z.string().min(1).max(300),
          dealId: z.string().uuid(),
          historyCompleteness: z.enum(["complete", "partial", "snapshot_only"]),
          originalCreatedAt: z.string().datetime().optional(),
          initialStageId: z.string().uuid().nullable().optional(),
          snapshotAt: z.string().datetime().optional(),
          events: z.array(historyEventSchema).max(2_000),
        }),
      )
      .min(1)
      .max(200),
  })
  .superRefine((value, context) => {
    if (!value.dryRun && value.confirm !== "IMPORT") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["confirm"],
        message: "Committed historical imports require confirm: IMPORT",
      });
    }
  });

revenueOperationsRouter.post(
  "/revenue/deal-history/import",
  validateBody(historyImportSchema),
  h(async (req, res) => {
    const body = req.body as z.infer<typeof historyImportSchema>;
    try {
      const result = await importHistoricalDealEvents(
        cidOf(req),
        body.batchKey,
        body.rows.map((row) => ({
          sourceId: row.sourceRecordId,
          dealId: row.dealId,
          historyCompleteness: row.historyCompleteness,
          originalCreatedAt: row.originalCreatedAt ? new Date(row.originalCreatedAt) : undefined,
          initialStageId: row.initialStageId,
          snapshotAt: row.snapshotAt ? new Date(row.snapshotAt) : undefined,
          events: row.events.map((event) => ({
            sourceId: event.sourceEventId,
            kind: event.eventType,
            occurredAt: new Date(event.effectiveAt),
            fromStageId: event.fromStageId,
            toStageId: event.toStageId,
            fromAmountCents: event.fromAmountCents,
            toAmountCents: event.toAmountCents,
            fromCurrency: event.fromCurrency,
            toCurrency: event.toCurrency,
            currency: event.currency,
            fromOwnerId: event.fromOwnerId,
            fromOwnerEmployeeId: event.fromOwnerEmployeeId,
            toOwnerId: event.toOwnerId,
            toOwnerEmployeeId: event.toOwnerEmployeeId,
            fromExpectedCloseDate:
              event.fromExpectedCloseDate === null
                ? null
                : event.fromExpectedCloseDate
                  ? new Date(event.fromExpectedCloseDate)
                  : undefined,
            toExpectedCloseDate:
              event.toExpectedCloseDate === null
                ? null
                : event.toExpectedCloseDate
                  ? new Date(event.toExpectedCloseDate)
                  : undefined,
            lostReason: event.lostReason,
            sourceActor: event.sourceActor,
            metadata: event.metadata,
          })),
        })),
        actorOf(req),
        { sourceSystem: body.sourceSystem, dryRun: body.dryRun },
      );
      if (!body.dryRun && !result.replayed) {
        await audit(
          req,
          "revenue.deal_history.import",
          "revenue_operation",
          result.operationId ?? null,
          body.batchKey,
          {
            imported: result.imported,
            rejected: result.rejected,
            conflicting: result.conflicting,
            duplicates: result.duplicates,
          },
        );
      }
      return res
        .status(result.rejected > 0 || result.conflicting > 0 || result.failed > 0 ? 207 : 200)
        .json(result);
    } catch (error) {
      return res.status(409).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/deal-history/activity-backfill/preview",
  validateBody(
    z
      .object({
        dealIds: z.array(z.string().uuid()).max(5_000).optional(),
      })
      .strict(),
  ),
  h(async (req, res) => {
    const result = await backfillDealHistoryFromActivities(cidOf(req), actorOf(req), {
      dealIds: req.body.dealIds,
      dryRun: true,
    });
    return res.json(result);
  }),
);

const dealHistoryBackfillSchema = z
  .object({
    dealIds: z.array(z.string().uuid()).min(1).max(5_000),
    idempotencyKey: z.string().min(8).max(200),
    confirm: z.literal("BACKFILL"),
  })
  .strict();

async function commitDealHistoryActivityBackfill(req: Request, res: Response): Promise<Response> {
  try {
    const result = await backfillDealHistoryFromActivities(cidOf(req), actorOf(req), {
      dealIds: req.body.dealIds,
      dryRun: false,
      idempotencyKey: req.body.idempotencyKey,
    });
    await audit(
      req,
      "revenue.deal_history.backfill",
      "deal_history_event",
      null,
      "Activity backfill",
      result,
    );
    return res.json(result);
  } catch (error) {
    return res.status(409).json({ error: (error as Error).message });
  }
}

revenueOperationsRouter.post(
  "/revenue/deal-history/activity-backfill",
  validateBody(dealHistoryBackfillSchema),
  h(commitDealHistoryActivityBackfill),
);

// Backwards-compatible path, now subject to the same explicit Deal selection.
revenueOperationsRouter.post(
  "/revenue/deal-history/backfill-activities",
  validateBody(dealHistoryBackfillSchema),
  h(commitDealHistoryActivityBackfill),
);

revenueOperationsRouter.get(
  "/revenue/deal-history/coverage",
  h(async (req, res) => {
    const parsed = z
      .object({
        dealIds: z
          .string()
          .max(200_000)
          .transform((value) => value.split(",").filter(Boolean))
          .pipe(z.array(z.string().uuid()).max(5_000))
          .optional(),
        includeArchived: boolQuery,
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listDealHistoryCoverage(cidOf(req), parsed.data));
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
          .enum([
            "created",
            "snapshot",
            "stage_changed",
            "amount_changed",
            "owner_changed",
            "expected_close_changed",
            "won",
            "lost",
          ])
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
  validateBody(
    z
      .object({
        dealIds: z.array(z.string().uuid()).min(1).max(5_000),
        confirm: z.literal("PROPOSE"),
      })
      .strict(),
  ),
  requireFinanceWrite,
  h(async (req, res) => {
    const result = await proposeCommercialValuesFromFinance(cidOf(req), {
      dealIds: req.body.dealIds,
    });
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
  validateBody(
    z
      .object({
        connectionId: z.string().uuid(),
        dealIds: z.array(z.string().uuid()).min(1).max(5_000),
        confirm: z.literal("PROPOSE"),
      })
      .strict(),
  ),
  h(async (req, res) => {
    const result = await proposeCommercialValuesFromStripe(cidOf(req), {
      connectionId: req.body.connectionId,
      dealIds: req.body.dealIds,
    });
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

revenueOperationsRouter.get(
  "/revenue/enrichment/commercial-values/backlog",
  requireFinanceRead,
  h(async (req, res) => {
    const parsed = z
      .object({
        dealIds: z
          .string()
          .max(200_000)
          .transform((value) => value.split(",").filter(Boolean))
          .pipe(z.array(z.string().uuid()).max(5_000))
          .optional(),
        stageIds: z
          .string()
          .max(20_000)
          .transform((value) => value.split(",").filter(Boolean))
          .pipe(z.array(z.string().uuid()).max(500))
          .optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listCommercialValueBacklog(cidOf(req), parsed.data));
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
        tcvCents: z.number().int().min(0).nullable().optional(),
        oneTimeCents: z.number().int().min(0).nullable().optional(),
      }),
      metadata: z.unknown().optional(),
    }),
  ),
  h(async (req, res) => {
    if (req.body.sourceType === "finance" && effectiveFinanceAccess(req) !== "full") {
      return res.status(403).json({
        error: "You need full finance access to propose Finance-backed Deal values.",
      });
    }
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
    const financeAccess = effectiveFinanceAccess(req);
    if (parsed.data.sourceType === "finance" && financeAccess === "none") {
      return res.status(403).json({
        error: "You don't have access to this company's finances.",
      });
    }
    return res.json(
      await listRevenueEvidence(cidOf(req), {
        ...parsed.data,
        excludeSourceTypes: financeAccess === "none" ? ["finance"] : undefined,
      }),
    );
  }),
);

revenueOperationsRouter.post(
  "/revenue/enrichment/evidence/:id/review",
  validateBody(
    z.object({
      decision: z.enum(["accept", "reject"]),
      supersedeExisting: z.boolean().optional(),
    }),
  ),
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid evidence" });
    const existing = await AppDataSource.getRepository(RevenueFieldEvidence).findOneBy({
      companyId: cidOf(req),
      id: params.data.id,
    });
    if (!existing) return res.status(404).json({ error: "Evidence not found" });
    if (existing.sourceType === "finance" && effectiveFinanceAccess(req) !== "full") {
      return res.status(403).json({
        error: "You need full finance access to review Finance-backed evidence.",
      });
    }
    try {
      const evidence = await reviewRevenueEvidence(
        cidOf(req),
        params.data.id,
        req.body.decision,
        actorOf(req),
        { supersedeExisting: req.body.supersedeExisting },
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

const firmographicSelectionSchema = z
  .object({
    connectionId: z.string().uuid(),
    accountIds: z.array(z.string().uuid()).max(MAX_FIRMOGRAPHIC_ACCOUNTS).optional(),
    missingOnly: z.boolean().optional(),
    refreshOlderThanDays: z.number().int().min(1).max(3_650).optional(),
    limit: z.number().int().min(1).max(MAX_FIRMOGRAPHIC_ACCOUNTS).optional(),
    force: z.boolean().optional(),
  })
  .strict();

revenueOperationsRouter.post(
  "/revenue/enrichment/firmographics/preview",
  validateBody(firmographicSelectionSchema),
  h(async (req, res) => {
    try {
      return res.json(await previewRevenueFirmographics(cidOf(req), req.body));
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.post(
  "/revenue/enrichment/firmographics/propose",
  validateBody(firmographicSelectionSchema.extend({ confirm: z.literal("PROPOSE") })),
  h(async (req, res) => {
    try {
      const result = await proposeRevenueFirmographics(cidOf(req), req.body);
      await audit(
        req,
        "revenue.enrichment.firmographics.propose",
        "revenue_firmographic_lookup",
        null,
        "Firmographic evidence",
        result,
      );
      return res.json(result);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

revenueOperationsRouter.get(
  "/revenue/enrichment/firmographics/lookups",
  h(async (req, res) => {
    const parsed = z
      .object({
        connectionId: z.string().uuid().optional(),
        customerId: z.string().uuid().optional(),
        status: z.enum(["matched", "not_found", "failed"]).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(await listRevenueFirmographicLookups(cidOf(req), parsed.data));
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
        status: z.enum(["pending", "processing", "accepted", "rejected", "duplicate"]).optional(),
        accountId: z.string().uuid().optional(),
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

const followUpViewFiltersSchema = z
  .object({
    state: z.enum(["all", "overdue", "today", "upcoming"]).optional(),
    q: z.string().max(200).optional(),
    source: z.enum(["task", "deal", "partnership"]).optional(),
    assignedUserId: z.string().uuid().optional(),
    assignedEmployeeId: z.string().uuid().optional(),
    unassigned: z.boolean().optional(),
    priority: priorityEnum.optional(),
    status: taskStatusEnum.optional(),
    linkedResourceType: z.enum(["account", "contact", "deal", "partnership"]).optional(),
    linkedResourceId: z.string().uuid().optional(),
    dueFrom: z.string().datetime().optional(),
    dueTo: z.string().datetime().optional(),
    reminderFrom: z.string().datetime().optional(),
    reminderTo: z.string().datetime().optional(),
    overdueMinDays: z.number().int().min(0).max(36_500).optional(),
    overdueMaxDays: z.number().int().min(0).max(36_500).optional(),
    createdBefore: z.string().datetime().optional(),
    staleBefore: z.string().datetime().optional(),
    dealStageId: z.string().uuid().optional(),
    dealStatus: z.enum(["open", "won", "lost"]).optional(),
    closedDeals: z.enum(["include", "only", "exclude"]).optional(),
    archivedResources: z.enum(["include", "only", "exclude"]).optional(),
    accountStatus: z.enum(["prospect", "customer", "former"]).optional(),
  })
  .strict();

function followUpViewFilters(
  input: z.infer<typeof followUpViewFiltersSchema>,
): FollowUpViewFilters {
  return {
    ...input,
    dueFrom: optionalDate(input.dueFrom) ?? undefined,
    dueTo: optionalDate(input.dueTo) ?? undefined,
    reminderFrom: optionalDate(input.reminderFrom) ?? undefined,
    reminderTo: optionalDate(input.reminderTo) ?? undefined,
    createdBefore: optionalDate(input.createdBefore) ?? undefined,
    staleBefore: optionalDate(input.staleBefore) ?? undefined,
  };
}

revenueOperationsRouter.get(
  "/revenue/follow-up-views",
  h(async (req, res) => res.json(await listFollowUpViews(cidOf(req)))),
);

revenueOperationsRouter.post(
  "/revenue/follow-up-views",
  validateBody(
    z
      .object({
        name: z.string().min(1).max(120),
        filters: followUpViewFiltersSchema,
        sortOrder: z.number().finite().optional(),
      })
      .strict(),
  ),
  h(async (req, res) => {
    const body = req.body as {
      name: string;
      filters: z.infer<typeof followUpViewFiltersSchema>;
      sortOrder?: number;
    };
    const view = await createFollowUpView(
      cidOf(req),
      { ...body, filters: followUpViewFilters(body.filters) },
      actorOf(req),
    );
    await audit(req, "revenue.follow_up_view.create", "revenue_follow_up_view", view.id, view.name);
    return res.status(201).json(view);
  }),
);

revenueOperationsRouter.patch(
  "/revenue/follow-up-views/:id",
  validateBody(
    z
      .object({
        name: z.string().min(1).max(120).optional(),
        filters: followUpViewFiltersSchema.optional(),
        sortOrder: z.number().finite().optional(),
      })
      .strict(),
  ),
  h(async (req, res) => {
    const body = req.body as {
      name?: string;
      filters?: z.infer<typeof followUpViewFiltersSchema>;
      sortOrder?: number;
    };
    const view = await updateFollowUpView(cidOf(req), req.params.id, {
      ...body,
      filters: body.filters ? followUpViewFilters(body.filters) : undefined,
    });
    if (!view) return res.status(404).json({ error: "Follow-up view not found" });
    await audit(req, "revenue.follow_up_view.update", "revenue_follow_up_view", view.id, view.name);
    return res.json(view);
  }),
);

revenueOperationsRouter.delete(
  "/revenue/follow-up-views/:id",
  h(async (req, res) => {
    if (!(await deleteFollowUpView(cidOf(req), req.params.id))) {
      return res.status(404).json({ error: "Follow-up view not found" });
    }
    await audit(
      req,
      "revenue.follow_up_view.delete",
      "revenue_follow_up_view",
      req.params.id,
      "Follow-up view",
    );
    return res.status(204).end();
  }),
);

revenueOperationsRouter.get(
  "/revenue/follow-ups",
  h(async (req, res) => {
    const parsed = z
      .object({
        state: z.enum(["all", "overdue", "today", "upcoming"]).optional(),
        q: z.string().max(200).optional(),
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
        reminderFrom: z.string().datetime().optional(),
        reminderTo: z.string().datetime().optional(),
        overdueMinDays: z.coerce.number().int().min(0).max(36_500).optional(),
        overdueMaxDays: z.coerce.number().int().min(0).max(36_500).optional(),
        createdBefore: z.string().datetime().optional(),
        staleBefore: z.string().datetime().optional(),
        dealStageId: z.string().uuid().optional(),
        dealStatus: z.enum(["open", "won", "lost"]).optional(),
        closedDeals: z.enum(["include", "only", "exclude"]).optional(),
        archivedResources: z.enum(["include", "only", "exclude"]).optional(),
        accountStatus: z.enum(["prospect", "customer", "former"]).optional(),
        cursor: z.string().max(1_000).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json(
      await listFollowUpPage(cidOf(req), {
        ...parsed.data,
        dueFrom: optionalDate(parsed.data.dueFrom) ?? undefined,
        dueTo: optionalDate(parsed.data.dueTo) ?? undefined,
        reminderFrom: optionalDate(parsed.data.reminderFrom) ?? undefined,
        reminderTo: optionalDate(parsed.data.reminderTo) ?? undefined,
        createdBefore: optionalDate(parsed.data.createdBefore) ?? undefined,
        staleBefore: optionalDate(parsed.data.staleBefore) ?? undefined,
      }),
    );
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
  validateBody(
    z.object({
      values: z.record(z.unknown()),
      provenance: z
        .object({
          sourceType: evidenceSourceTypeEnum,
          sourceId: z.string().min(1).max(500),
          sourceLabel: z.string().max(500).optional(),
          extractionMethod: z.string().max(200).optional(),
          confidence: z.number().int().min(0).max(100).optional(),
          observedAt: z.string().datetime().optional(),
          verificationState: z.enum(["verified", "unverified"]),
          lastVerifiedAt: z.string().datetime().nullable().optional(),
          metadata: z.record(z.unknown()).optional(),
        })
        .optional(),
    }),
  ),
  h(async (req, res) => {
    const resourceType = resourceTypeEnum.safeParse(req.params.resourceType);
    if (!resourceType.success) return res.status(400).json({ error: "Invalid resource type" });
    try {
      const body = req.body as {
        values: Record<string, unknown>;
        provenance?: {
          sourceType: z.infer<typeof evidenceSourceTypeEnum>;
          sourceId: string;
          sourceLabel?: string;
          extractionMethod?: string;
          confidence?: number;
          observedAt?: string;
          verificationState: "verified" | "unverified";
          lastVerifiedAt?: string | null;
          metadata?: Record<string, unknown>;
        };
      };
      if (body.provenance?.sourceType === "finance" && effectiveFinanceAccess(req) === "none") {
        return res.status(403).json({
          error: "You don't have access to this company's finances.",
        });
      }
      if (body.provenance) {
        await assertRevenueEvidenceSource(cidOf(req), body.provenance);
      }
      const rows = await setCustomValues(
        cidOf(req),
        resourceType.data,
        req.params.resourceId,
        body.values,
        {
          actor: actorOf(req),
          provenance: body.provenance
            ? {
                ...body.provenance,
                observedAt: body.provenance.observedAt
                  ? new Date(body.provenance.observedAt)
                  : undefined,
                lastVerifiedAt:
                  body.provenance.lastVerifiedAt === null
                    ? null
                    : body.provenance.lastVerifiedAt
                      ? new Date(body.provenance.lastVerifiedAt)
                      : undefined,
              }
            : undefined,
        },
      );
      await audit(
        req,
        "revenue.custom_values.update",
        resourceType.data,
        req.params.resourceId,
        resourceType.data,
        { keys: Object.keys(body.values), sourceType: body.provenance?.sourceType ?? "manual" },
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

for (const [action, archived] of [
  ["archive", true],
  ["restore", false],
] as const) {
  revenueOperationsRouter.post(
    `/revenue/partnerships/:id/${action}`,
    h(async (req, res) => {
      try {
        const row = await setPartnershipArchived(cidOf(req), req.params.id, archived);
        if (!row) return res.status(404).json({ error: "Partnership not found" });
        await audit(req, `revenue.partnership.${action}`, "partnership", row.id, row.name);
        return res.json(row);
      } catch (error) {
        return res.status(409).json({ error: (error as Error).message });
      }
    }),
  );
}

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

// ── Reversible Base / file migration ──────────────────────────────────────

const revenueImportFileUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: REVENUE_IMPORT_SOURCE_MAX_BYTES, files: 1, fields: 10 },
});
const receiveRevenueImportFile: RequestHandler = (req, res, next) => {
  revenueImportFileUpload.single("file")(req, res, (error) => {
    if (!error) return next();
    return res.status(400).json({ error: (error as Error).message });
  });
};
const revenueImportFileResourceSchema = z.enum([
  "account",
  "contact",
  "deal",
  "partnership",
  "account_contact_deal",
]);
const revenueImportFileFieldsSchema = z.object({
  format: z.enum(["csv", "json", "ndjson"]),
  resourceType: revenueImportFileResourceSchema.optional(),
  sourceLabel: z.string().min(1).max(500).optional(),
  sourceIdField: z.string().min(1).max(500).optional(),
  mapping: z.string().max(200_000).optional(),
});

function parseImportMapping(value: string | undefined): Record<string, unknown> {
  if (!value) throw new Error("Field mapping is required");
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Field mapping must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function parseUploadedRevenueSource(req: Request): {
  format: RevenueImportFileFormat;
  sourceLabel: string;
  resourceType?: z.infer<typeof revenueImportFileResourceSchema>;
  mapping?: Record<string, unknown>;
  fields: string[];
  rows: ImportRow[];
} {
  const parsed = revenueImportFileFieldsSchema.safeParse(req.body);
  if (!parsed.success) throw new Error("Invalid import file options");
  if (!req.file) throw new Error("Choose a CSV, JSON, or NDJSON file");
  const source = parseRevenueImportSource(parsed.data.format, req.file.buffer.toString("utf8"), {
    sourceIdField: parsed.data.sourceIdField,
  });
  return {
    format: source.format,
    sourceLabel: parsed.data.sourceLabel || req.file.originalname,
    resourceType: parsed.data.resourceType,
    mapping: parsed.data.mapping ? parseImportMapping(parsed.data.mapping) : undefined,
    fields: source.fields,
    rows: source.rows,
  };
}

revenueOperationsRouter.post(
  "/revenue/imports/file/inspect",
  receiveRevenueImportFile,
  h(async (req, res) => {
    try {
      const source = parseUploadedRevenueSource(req);
      return res.json({
        format: source.format,
        sourceLabel: source.sourceLabel,
        fields: source.fields,
        rowCount: source.rows.length,
      });
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
  }),
);

for (const mode of ["preview", "commit"] as const) {
  revenueOperationsRouter.post(
    `/revenue/imports/file/${mode}`,
    receiveRevenueImportFile,
    h(async (req, res) => {
      try {
        const source = parseUploadedRevenueSource(req);
        if (!source.resourceType || !source.mapping) {
          return res.status(400).json({ error: "Import target and field mapping are required" });
        }
        const sourceKind = source.format === "csv" ? "csv" : "json";
        if (source.resourceType === "account_contact_deal") {
          const mapping = source.mapping as LinkedImportMapping;
          if (mode === "preview") {
            return res.json(await previewLinkedRevenueImport(cidOf(req), mapping, source.rows));
          }
          const batch = await commitLinkedRevenueImport(
            cidOf(req),
            {
              sourceKind,
              sourceLabel: source.sourceLabel,
              sourceBaseId: null,
              sourceTableId: null,
              sourceConnectionId: null,
              mapping,
              rows: source.rows,
            },
            actorOf(req),
          );
          await audit(
            req,
            "revenue.import.file.commit",
            "revenue_import",
            batch.id,
            batch.sourceLabel,
            { resourceType: batch.resourceType, format: source.format },
          );
          return res.status(201).json(await getRevenueImportSummary(cidOf(req), batch.id));
        }
        const mapping = source.mapping as Record<string, string>;
        if (mode === "preview") {
          return res.json(
            await previewRevenueImport(cidOf(req), source.resourceType, mapping, source.rows),
          );
        }
        const batch = await commitRevenueImport(
          cidOf(req),
          {
            resourceType: source.resourceType,
            sourceKind,
            sourceLabel: source.sourceLabel,
            sourceBaseId: null,
            sourceTableId: null,
            sourceConnectionId: null,
            mapping,
            rows: source.rows,
          },
          actorOf(req),
        );
        await audit(
          req,
          "revenue.import.file.commit",
          "revenue_import",
          batch.id,
          batch.sourceLabel,
          { resourceType: batch.resourceType, format: source.format },
        );
        return res.status(201).json(await getRevenueImportSummary(cidOf(req), batch.id));
      } catch (error) {
        return res.status(400).json({ error: (error as Error).message });
      }
    }),
  );
}

const importRowSchema = z.object({
  sourceId: z.string().min(1).max(500),
  values: z.record(z.unknown()),
});
const importInputSchema = z.object({
  resourceType: resourceTypeEnum,
  sourceKind: z.enum(["base", "csv", "json", "connection"]),
  sourceLabel: z.string().min(1).max(500),
  sourceBaseId: z.string().uuid().nullable().optional(),
  sourceTableId: z.string().uuid().nullable().optional(),
  sourceConnectionId: z.string().uuid().nullable().optional(),
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
    if (body.sourceConnectionId) {
      throw new Error("Base imports cannot carry Connection provenance");
    }
    if (!body.sourceBaseId || !body.sourceTableId) {
      throw new Error("Base and table are required");
    }
    const source = await loadBaseImportRows(companyId, body.sourceBaseId, body.sourceTableId);
    return { rows: source.rows, sourceLabel: source.sourceLabel };
  }
  if (body.sourceBaseId || body.sourceTableId) {
    throw new Error("Only Base imports can carry Base provenance");
  }
  if (!body.rows || body.rows.length === 0) {
    throw new Error("Direct imports require at least one source row");
  }
  if (body.sourceKind === "connection") {
    if (!body.sourceConnectionId) {
      throw new Error("Connection-backed imports require a source Connection");
    }
    const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      companyId,
      id: body.sourceConnectionId,
    });
    if (!connection) throw new Error("Source Connection not found in this company");
    if (connection.status !== "connected") throw new Error("Source Connection is not connected");
  } else if (body.sourceConnectionId) {
    throw new Error("Only Connection-backed imports can carry Connection provenance");
  }
  return { rows: body.rows ?? [], sourceLabel: body.sourceLabel };
}

async function resolvedLinkedImportRows(
  companyId: string,
  body: z.infer<typeof linkedImportInputSchema>,
): Promise<{ rows: ImportRow[]; sourceLabel: string }> {
  return resolvedImportRows(companyId, {
    ...body,
    resourceType: "account",
    mapping: {},
  });
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
      return res.status(201).json(await getRevenueImportSummary(cidOf(req), batch.id));
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
      return res.status(201).json(await getRevenueImportSummary(cidOf(req), batch.id));
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
        sourceKind: z.enum(["base", "csv", "json", "connection"]).optional(),
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
        summaryOnly: parsed.data.summaryOnly !== false,
        from: optionalDate(parsed.data.from) ?? undefined,
        to: optionalDate(parsed.data.to) ?? undefined,
      }),
    );
  }),
);

revenueOperationsRouter.get(
  "/revenue/imports/:id/summary",
  h(async (req, res) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!params.success) return res.status(400).json({ error: "Invalid import" });
    const summary = await getRevenueImportSummary(cidOf(req), params.data.id);
    return summary ? res.json(summary) : res.status(404).json({ error: "Import not found" });
  }),
);

revenueOperationsRouter.get(
  "/revenue/imports/:id",
  h(async (req, res) => {
    const summary = await getRevenueImportSummary(cidOf(req), req.params.id);
    return summary ? res.json(summary) : res.status(404).json({ error: "Import not found" });
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
        sourceId: z.string().max(300).optional(),
        nativeId: z.string().uuid().optional(),
        error: z.string().max(500).optional(),
        hasError: boolQuery,
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
        sourceId: z.string().max(300).optional(),
        nativeId: z.string().uuid().optional(),
        error: z.string().max(500).optional(),
        hasError: boolQuery,
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
        cursor: z.string().max(4_000).optional(),
        asOf: z.string().datetime().optional(),
        dealId: z.string().uuid().optional(),
        sourceKind: z.enum(["live", "import", "activity_backfill"]).optional(),
        kind: z
          .enum([
            "created",
            "snapshot",
            "stage_changed",
            "amount_changed",
            "owner_changed",
            "expected_close_changed",
            "won",
            "lost",
            "merge",
            "bulk",
            "history_import",
          ])
          .optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
        resourceType: z.enum(["account", "contact", "deal", "partnership", "follow_up"]).optional(),
        resourceId: z.string().uuid().optional(),
        fieldKey: z.string().max(200).optional(),
        sourceType: evidenceSourceTypeEnum.optional(),
        status: z
          .enum([
            "proposed",
            "accepted",
            "rejected",
            "superseded",
            "open",
            "dismissed",
            "merged",
            "queued",
            "running",
            "completed",
            "partial",
            "failed",
            "rolled_back",
            "pending",
            "processing",
            "duplicate",
          ])
          .optional(),
        minScore: z.coerce.number().int().min(0).max(100).optional(),
        accountId: z.string().uuid().optional(),
      })
      .safeParse(req.query);
    if (!params.success || !query.success) {
      return res.status(400).json({ error: "Invalid Revenue export query" });
    }
    const resource = params.data.resource;
    const specialFilters = Object.entries(query.data)
      .filter(
        ([key, value]) =>
          value !== undefined && !["format", "limit", "offset", "cursor", "asOf"].includes(key),
      )
      .map(([key]) => key);
    const allowedFilters: Partial<Record<RevenueExportResource, readonly string[]>> = {
      deal_history: ["dealId", "sourceKind", "kind", "from", "to"],
      field_evidence: ["resourceType", "resourceId", "fieldKey", "sourceType", "status"],
      duplicate_candidates: ["resourceType", "status", "minScore"],
      operation_audit: ["kind", "resourceType", "status"],
      document_candidates: ["status", "accountId"],
    };
    if (specialFilters.some((key) => !(allowedFilters[resource] ?? []).includes(key))) {
      return res.status(400).json({ error: `Invalid filters for ${resource}` });
    }
    const status = query.data.status;
    const validStatus =
      !status ||
      (resource === "field_evidence" &&
        ["proposed", "accepted", "rejected", "superseded"].includes(status)) ||
      (resource === "duplicate_candidates" && ["open", "dismissed", "merged"].includes(status)) ||
      (resource === "operation_audit" &&
        ["queued", "running", "completed", "partial", "failed", "rolled_back"].includes(status)) ||
      (resource === "document_candidates" &&
        ["pending", "processing", "accepted", "rejected", "duplicate"].includes(status));
    const kind = query.data.kind;
    const validKind =
      !kind ||
      (resource === "deal_history" &&
        [
          "created",
          "snapshot",
          "stage_changed",
          "amount_changed",
          "owner_changed",
          "expected_close_changed",
          "won",
          "lost",
        ].includes(kind)) ||
      (resource === "operation_audit" && ["merge", "bulk", "history_import"].includes(kind));
    if (!validStatus || !validKind) {
      return res.status(400).json({ error: `Invalid filters for ${resource}` });
    }
    const { format: _format, ...rawOptions } = query.data;
    const financeAccess = effectiveFinanceAccess(req);
    if (
      resource === "field_evidence" &&
      rawOptions.sourceType === "finance" &&
      financeAccess === "none"
    ) {
      return res.status(403).json({
        error: "You don't have access to this company's finances.",
      });
    }
    const options = {
      ...rawOptions,
      asOf: rawOptions.asOf ? new Date(rawOptions.asOf) : undefined,
      from: rawOptions.from ? new Date(rawOptions.from) : undefined,
      to: rawOptions.to ? new Date(rawOptions.to) : undefined,
      excludeSourceTypes:
        resource === "field_evidence" && financeAccess === "none"
          ? ["finance" as const]
          : undefined,
    } as RevenueExportOptionsByResource[RevenueExportResource];
    let page;
    try {
      page = await exportRevenueSnapshotPage(cidOf(req), resource, options);
    } catch (error) {
      return res.status(400).json({ error: (error as Error).message });
    }
    if (query.data.format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("X-Revenue-Export-Next-Offset", page.nextOffset?.toString() ?? "");
      res.setHeader("X-Revenue-Export-Next-Cursor", page.nextCursor ?? "");
      res.setHeader("X-Revenue-Export-As-Of", page.asOf?.toISOString() ?? "");
      res.setHeader("X-Revenue-Export-Total", page.total?.toString() ?? "");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="revenue-${resource}-${page.offset}.csv"`,
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
  validateBody(z.object({ confirm: z.literal("ROLLBACK") }).strict()),
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
    return res.json({
      ...(await getRevenueImportSummary(cidOf(req), result.batch.id)),
      deleted: result.deleted,
      blocked: result.blocked,
    });
  }),
);
