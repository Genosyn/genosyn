import { Request, Response, Router, type RequestHandler } from "express";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import {
  ACTIVITY_PRIORITIES,
  ACTIVITY_TASK_STATUSES,
  type ActivityPriority,
  type ActivityTaskStatus,
} from "../db/entities/Activity.js";
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
  commitLinkedRevenueImport,
  commitRevenueImport,
  getRevenueImport,
  listRevenueImports,
  loadBaseImportRows,
  migrateBaseAttachmentsForImport,
  previewLinkedRevenueImport,
  previewRevenueImport,
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
        assignedUserId: z.string().uuid().optional(),
        assignedEmployeeId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "Invalid query parameters" });
    return res.json({ rows: await listFollowUps(cidOf(req), parsed.data) });
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
  h(async (req, res) => res.json({ rows: await listRevenueImports(cidOf(req)) })),
);

revenueOperationsRouter.get(
  "/revenue/imports/:id",
  h(async (req, res) => {
    const batch = await getRevenueImport(cidOf(req), req.params.id);
    return batch ? res.json(batch) : res.status(404).json({ error: "Import not found" });
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
