import crypto from "node:crypto";
import fs from "node:fs";
import { Router, Request, Response, NextFunction } from "express";
import cron from "node-cron";
import { z } from "zod";
import {
  MAX_TOOLSET_ENTRIES,
  parseToolset,
  serializeToolset,
  validateToolset,
} from "../services/skillToolset.js";
import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Skill } from "../db/entities/Skill.js";
import { Project } from "../db/entities/Project.js";
import { Todo, TodoPriority, TodoRecurrence, TodoStatus } from "../db/entities/Todo.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { validateBody } from "../middleware/validate.js";
import { toSlug } from "../lib/slug.js";
import { formatMoney } from "../lib/money.js";
import { routineTemplate, skillTemplate } from "../services/files.js";
import { registerRoutine } from "../services/cron.js";
import { recordAudit } from "../services/audit.js";
import {
  resolveMcpToken,
  stageAttachmentForToken,
  stageSidecarForToken,
} from "../services/mcpTokens.js";
import {
  applyMailScope,
  applyMailSearchFilters,
  effectiveScope,
  parseMailQuery,
  resolveSearchLabelId,
} from "../services/mail/searchQuery.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { resolveAttachmentFile } from "../services/uploads.js";
import { Attachment } from "../db/entities/Attachment.js";
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup } from "pdf-lib";
import { Approval } from "../db/entities/Approval.js";
import { createBrowserActionApproval } from "../services/approvals.js";
import { createNotification } from "../services/notifications.js";
import { dispatchTodoCreated } from "../services/pipelines/events.js";
import { validateParentTodo } from "./projects.js";
import { ProjectActor, hasProjectAccess, listAccessibleProjectIds } from "../services/projects.js";
import {
  getGrantWithConnection,
  invokeConnectionTool,
  loadEmployeeConnections,
} from "../services/integrations.js";
import {
  buildLinkOptionsFor,
  findBaseByName,
  findBaseTableByName,
  grantBaseAccess,
  hasBaseGrant,
  hydrateField,
  hydrateRecord,
  hydrateRecordAttachments,
  hydrateRecordComments,
  listGrantedBasesForEmployee,
  seedBaseFromTemplate,
  uniqueBaseSlug,
  uniqueTableSlug,
} from "../services/bases.js";
import { buildResourceOptionsFor } from "../services/baseResources.js";
import { findBaseTemplate } from "../services/baseTemplates.js";
import {
  EmployeeMailAccountGrant,
  MAIL_ACCESS_RANK,
  type MailAccessLevel,
} from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import {
  createMailDraft,
  performThreadAction,
  sendMailDraft,
  sendMailMessage,
  updateMailDraft,
} from "../services/mail/actions.js";
import { columnToLabelIds } from "../services/mail/store.js";
import type { MimeAttachment } from "../services/mail/gmailClient.js";
import {
  makeResourceAttachmentResolver,
  resourceAttachmentSpecsSchema,
} from "../services/resourceAttachments.js";
import { Base } from "../db/entities/Base.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseField, BaseFieldType } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import {
  BASE_ATTACHMENTS_AI_MAX_BYTES,
  recordEmployeeAttachment,
  readBaseAttachmentText,
  resolveBaseAttachmentFile,
  deleteBaseAttachmentBytes,
} from "../services/baseRecordUploads.js";
import { EmployeeMemory } from "../db/entities/EmployeeMemory.js";
import { getProvider } from "../integrations/index.js";
import {
  archiveChannel,
  createChannel,
  findChannelBySlugOrId,
  findOrCreateDM,
  listChannelsForEmployee,
  postMessage,
  renameChannel,
} from "../services/workspaceChat.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { Team } from "../db/entities/Team.js";
import { Handoff, type HandoffStatus } from "../db/entities/Handoff.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { Resource } from "../db/entities/Resource.js";
import { CodeRepository } from "../db/entities/CodeRepository.js";
import { EmployeeCodeRepositoryGrant } from "../db/entities/EmployeeCodeRepositoryGrant.js";
import { hasNoteAccess, listAccessibleNoteIds, upsertNoteGrant } from "../services/notes.js";
import { ensureDefaultNotebook } from "../services/notebooks.js";
import {
  RESOURCE_BODY_TEXT_CAP,
  deleteGrantsForResource,
  deleteResourceBytes,
  fetchUrlAsText,
  hasResourceAccess,
  listAccessibleResourceIds,
  summarize,
  trimBodyText,
  uniqueResourceSlug,
  upsertResourceGrant,
} from "../services/resources.js";
import { EXPORT_FORMATS, exportResource, isExportFormat } from "../services/resourceExport.js";
import {
  deleteTagAssignments,
  replaceResourceTagNames,
  tagsByResourceIds,
  tagsForResource,
} from "../services/tags.js";
import { Chart } from "../db/entities/Chart.js";
import { Dashboard } from "../db/entities/Dashboard.js";
import { DashboardCard } from "../db/entities/DashboardCard.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { seedChartOfAccounts, trialBalance } from "../services/ledger.js";
import { balanceSheet, cashFlow, financialTrends, incomeStatement } from "../services/reports.js";
import {
  getLedgerEntryForReview,
  listLedgerEntriesForReview,
  stageAiLedgerReview,
} from "../services/transactionReviews.js";
import {
  displayStatus,
  draftInvoiceSlug,
  hydrateInvoices,
  issueInvoice,
  loadCustomerBySlug,
  loadInvoiceBySlug,
  postInvoicePayment,
  recomputeInvoiceTotals,
  replaceInvoiceLines,
  sendInvoiceEmail,
  uniqueCustomerSlug,
  voidInvoice,
} from "../services/finance.js";
import { Customer } from "../db/entities/Customer.js";
import { getFinanceSettings } from "../services/fx.js";
import {
  disallowedRecipients,
  trustedRecipientDomains,
} from "../lib/recipientAllowlist.js";
import { CustomerContact } from "../db/entities/CustomerContact.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import type { Activity } from "../db/entities/Activity.js";
import { ACTIVITY_KINDS, type ActivityKind } from "../db/entities/Activity.js";
import {
  CONTACT_LIFECYCLE_STAGES,
  type Contact,
  type ContactLifecycleStage,
} from "../db/entities/Contact.js";
import type { DealStage } from "../db/entities/DealStage.js";
import type { Signal } from "../db/entities/Signal.js";
import type { Suppression } from "../db/entities/Suppression.js";
import {
  EmployeeRevenueGrant,
  REVENUE_ACCESS_RANK,
  type RevenueAccessLevel,
} from "../db/entities/EmployeeRevenueGrant.js";
import { normalizeEmail } from "../lib/emailAddress.js";
import { addSuppression, isSuppressed } from "../services/mail/suppression.js";
import { listActivities, recordActivity } from "../services/revenue/activities.js";
import {
  DuplicateContactError,
  createContact,
  findContactByEmail,
  getContact,
  listContacts,
  updateContact,
} from "../services/revenue/contacts.js";
import {
  InvalidStageError,
  addDealContact,
  createDeal,
  dealBoard,
  getHydratedDeal,
  listDealContacts,
  listDeals,
  moveDealToStage,
  updateDeal,
  type HydratedDeal,
} from "../services/revenue/deals.js";
import {
  getCacReport,
  getFunnelReport,
  getMrrSeries,
  getRevenueOverview,
} from "../services/revenue/reports.js";
import {
  bulkEnroll,
  getSequence,
  listSequences,
  parseSendWindow,
  type HydratedSequence,
} from "../services/revenue/sequences.js";
import { listSignals } from "../services/revenue/signals.js";
import { listDealStages } from "../services/revenue/stages.js";
import {
  EmployeeFinanceGrant,
  FINANCE_ACCESS_RANK,
  type FinanceAccessLevel,
} from "../db/entities/EmployeeFinanceGrant.js";
import {
  deleteGrantsForChart,
  grantChartToAllEmployees,
  grantDashboardToAllEmployees,
  hasChartAccess,
  hasDashboardAccess,
  isExploreProvider,
  listAccessibleChartIds,
  listAccessibleDashboardIds,
  runSqlAgainstConnection,
  serializeCard,
  serializeChart,
  serializeDashboard,
  uniqueChartSlug,
  uniqueDashboardSlug,
  upsertChartGrant,
  upsertDashboardGrant,
} from "../services/explore.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";

/**
 * Internal HTTP surface for the built-in `genosyn` tools.
 *
 * The in-process agent (`services/agent/`) calls these endpoints over loopback
 * with a short-lived Bearer token when the model invokes a genosyn tool, and
 * the `browser` MCP child calls them to queue approvals. Authentication is the
 * token, which resolves to the acting {employee, company} pair via
 * {@link resolveMcpToken}.
 *
 * Every write records an AuditEvent with `actorKind: "ai"` and a matching
 * JournalEntry on the employee's diary so humans can see what the AI did
 * after the fact.
 */
export const mcpInternalRouter = Router();

type McpRequest = Request & {
  mcpEmployee?: AIEmployee;
  mcpCompany?: Company;
  /** Raw bearer token — stashed so route handlers can stage per-token
   * state (e.g. chat-attachment uploads) without re-parsing the header. */
  mcpToken?: string;
  /** The Run/Routine behind this call when the runner minted the token.
   * Null on the chat seam and external MCP sessions. Handlers that record
   * provenance on the rows they write read these. */
  mcpRunId?: string | null;
  mcpRoutineId?: string | null;
};

async function requireMcpToken(req: McpRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  const info = resolveMcpToken(token);
  if (!info) return res.status(401).json({ error: "Invalid or expired token" });
  const [emp, co] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({ id: info.employeeId }),
    AppDataSource.getRepository(Company).findOneBy({ id: info.companyId }),
  ]);
  if (!emp || !co || emp.companyId !== co.id) {
    return res.status(401).json({ error: "Token resolves to a stale actor" });
  }
  req.mcpEmployee = emp;
  req.mcpCompany = co;
  req.mcpToken = token;
  req.mcpRunId = info.runId;
  req.mcpRoutineId = info.routineId;
  next();
}

mcpInternalRouter.use(requireMcpToken);

// ----- Tool manifest -----

/**
 * The static tool catalogue. This route + `mcp/toolManifest.ts` are the single
 * source of truth; the in-process agent imports STATIC_TOOLS directly, so this
 * endpoint is retained mainly for external/manifest consumers. The list is
 * identical for every employee; integration-backed tools are discovered
 * separately via `/integrations/_list`.
 */
mcpInternalRouter.post("/manifest", (_req: McpRequest, res: Response) => {
  res.json({ tools: STATIC_TOOLS });
});

async function journal(employeeId: string, title: string, body = ""): Promise<void> {
  try {
    const repo = AppDataSource.getRepository(JournalEntry);
    await repo.save(
      repo.create({
        employeeId,
        kind: "system",
        title,
        body,
        runId: null,
        routineId: null,
        authorUserId: null,
      }),
    );
  } catch (err) {
    // Same philosophy as recordAudit — never let journalling failures break
    // the operation the AI is trying to perform.
    // eslint-disable-next-line no-console
    console.warn("[mcp-internal] journal write failed", err);
  }
}

function serializeEmployee(e: AIEmployee) {
  return { id: e.id, slug: e.slug, name: e.name, role: e.role };
}

function serializeRoutine(r: Routine, tags: string[] = []) {
  return {
    id: r.id,
    employeeId: r.employeeId,
    slug: r.slug,
    name: r.name,
    cronExpr: r.cronExpr,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt,
    brief: r.body,
    tags,
  };
}

function serializeSkill(s: Skill) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    body: s.body,
    toolset: parseToolset(s.toolsetJson),
  };
}

function serializeProject(p: Project) {
  return {
    id: p.id,
    slug: p.slug,
    key: p.key,
    name: p.name,
    description: p.description,
  };
}

function serializeTodo(t: Todo) {
  return {
    id: t.id,
    projectId: t.projectId,
    number: t.number,
    title: t.title,
    description: t.description,
    status: t.status,
    priority: t.priority,
    assigneeEmployeeId: t.assigneeEmployeeId,
    reviewerEmployeeId: t.reviewerEmployeeId,
    dueAt: t.dueAt,
    recurrence: t.recurrence,
    parentTodoId: t.parentTodoId,
  };
}

// ----- Orientation -----

mcpInternalRouter.post("/tools/get_self", async (req: McpRequest, res) => {
  const emp = req.mcpEmployee!;
  const co = req.mcpCompany!;
  res.json({
    employee: serializeEmployee(emp),
    company: { id: co.id, slug: co.slug, name: co.name },
  });
});

mcpInternalRouter.post("/tools/list_employees", async (req: McpRequest, res) => {
  const co = req.mcpCompany!;
  const all = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: co.id },
    order: { createdAt: "ASC" },
  });
  res.json({ employees: all.map(serializeEmployee) });
});

// ----- Finance -----
//
// The finance tools are grant-gated per employee via `EmployeeFinanceGrant`
// (Finance → AI access), mirroring the mail slice: read < invoice < full.
// Reads need `read`, the invoice/customer/payment lifecycle needs `invoice`,
// and staging a ledger review needs `full`. Every write records an
// AuditEvent (actorKind "ai") + a JournalEntry, like the rest of this file.

/**
 * Enforce the acting employee's finance grant. Writes the 403 itself and
 * returns false on failure, so callers do `if (!(await requireFinance(...)))
 * return;`. The message names the level shortfall so the model (and the human
 * reading its transcript) knows exactly what to ask for.
 */
async function requireFinance(
  req: McpRequest,
  res: Response,
  required: FinanceAccessLevel,
): Promise<boolean> {
  const self = req.mcpEmployee!;
  const grant = await AppDataSource.getRepository(EmployeeFinanceGrant).findOneBy({
    employeeId: self.id,
  });
  // Fail CLOSED on an unrecognized level. FINANCE_ACCESS_RANK[x] is
  // `undefined` for any string that isn't a known level, and
  // `undefined < N` is `false` — so a bare `<` comparison would SKIP the
  // 403 and grant access. That could happen during a mixed-version
  // deploy or after a rollback that left a newer level string in the DB.
  const have = grant ? FINANCE_ACCESS_RANK[grant.accessLevel] : undefined;
  if (!grant || typeof have !== "number" || have < FINANCE_ACCESS_RANK[required]) {
    res.status(403).json({
      error: grant
        ? `No grant: this needs the "${required}" finance access level; yours is "${grant.accessLevel}". Ask an owner or admin to raise it under Finance → AI access.`
        : "No grant: you do not have access to the finance system. Ask an owner or admin to grant it under Finance → AI access.",
    });
    return false;
  }
  return true;
}

/**
 * Record the audit + journal trail for a write by an AI employee.
 *
 * Every grant-gated write surface in this file owes the same two rows — an
 * AuditEvent naming the acting employee and a JournalEntry on its diary — so
 * this is shared rather than reimplemented per section. Finance and Revenue
 * both go through it; the `action` string is what says which.
 */
async function aiWriteTrail(
  req: McpRequest,
  args: {
    action: string;
    targetType: string;
    targetId: string;
    targetLabel: string;
    journalTitle: string;
    journalBody?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const company = req.mcpCompany!;
  const employee = req.mcpEmployee!;
  await recordAudit({
    companyId: company.id,
    actorEmployeeId: employee.id,
    action: args.action,
    targetType: args.targetType,
    targetId: args.targetId,
    targetLabel: args.targetLabel,
    metadata: { ...(args.metadata ?? {}), via: "mcp" },
  });
  await journal(employee.id, args.journalTitle, args.journalBody ?? "");
}

const isoCurrency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((s) => s.toUpperCase());

type HydratedInvoiceRow = Awaited<ReturnType<typeof hydrateInvoices>>[number];

function serializeToolCustomer(c: Customer) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    email: c.email,
    phone: c.phone,
    currency: c.currency,
    taxNumber: c.taxNumber,
    billingAddress: c.billingAddress,
    shippingAddress: c.shippingAddress,
    notes: c.notes,
    annualContractValueCents: c.annualContractValueCents,
    archived: !!c.archivedAt,
  };
}

function serializeInvoiceRow(h: HydratedInvoiceRow) {
  return {
    id: h.id,
    slug: h.slug,
    number: h.number || null,
    status: displayStatus(h),
    currency: h.currency,
    customer: h.customer ? { name: h.customer.name, slug: h.customer.slug } : null,
    subtotalCents: h.subtotalCents,
    taxCents: h.taxCents,
    totalCents: h.totalCents,
    paidCents: h.paidCents,
    balanceCents: h.balanceCents,
    issueDate: h.issueDate,
    dueDate: h.dueDate,
  };
}

function serializeInvoiceFull(h: HydratedInvoiceRow) {
  return {
    ...serializeInvoiceRow(h),
    customerId: h.customerId,
    notes: h.notes,
    footer: h.footer,
    sentAt: h.sentAt,
    paidAt: h.paidAt,
    voidedAt: h.voidedAt,
    lines: h.lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: l.quantity,
      unitPriceCents: l.unitPriceCents,
      taxRateId: l.taxRateId,
      taxName: l.taxName,
      taxPercent: l.taxPercent,
      lineSubtotalCents: l.lineSubtotalCents,
      lineTaxCents: l.lineTaxCents,
      lineTotalCents: l.lineTotalCents,
    })),
    payments: h.payments.map((p) => ({
      id: p.id,
      amountCents: p.amountCents,
      currency: p.currency,
      paidAt: p.paidAt,
      method: p.method,
      reference: p.reference,
      notes: p.notes,
    })),
  };
}

/** Shared by every tool that takes no arguments at all. */
const emptyToolSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_finance_accounts",
  validateBody(emptyToolSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const accounts = await seedChartOfAccounts(req.mcpCompany!.id);
    res.json({
      accounts: accounts.map((account) => ({
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        archived: !!account.archivedAt,
      })),
    });
  },
);

const financeTransactionsSchema = z
  .object({
    reviewStatus: z.enum(["unreviewed", "ai_reviewed", "approved"]).optional(),
    source: z.string().min(1).max(80).optional(),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

function parseOptionalToolDate(value: string | undefined, label: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${label} date`);
  return date;
}

mcpInternalRouter.post(
  "/tools/list_finance_transactions",
  validateBody(financeTransactionsSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const body = req.body as z.infer<typeof financeTransactionsSchema>;
    try {
      const transactions = await listLedgerEntriesForReview({
        companyId: req.mcpCompany!.id,
        reviewStatus: body.reviewStatus,
        source: body.source,
        from: parseOptionalToolDate(body.from, "from"),
        to: parseOptionalToolDate(body.to, "to"),
        limit: body.limit ?? 50,
      });
      res.json({ transactions });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const financeTransactionSchema = z.object({ transactionId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/get_finance_transaction",
  validateBody(financeTransactionSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const body = req.body as z.infer<typeof financeTransactionSchema>;
    const transaction = await getLedgerEntryForReview(req.mcpCompany!.id, body.transactionId);
    if (!transaction) return res.status(404).json({ error: "Transaction not found" });
    res.json({ transaction });
  },
);

const financeReviewSchema = z
  .object({
    transactionId: z.string().uuid(),
    changes: z
      .array(
        z.object({
          lineId: z.string().uuid(),
          accountId: z.string().uuid(),
        }),
      )
      .max(20)
      .optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/review_finance_transaction",
  validateBody(financeReviewSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "full"))) return;
    const body = req.body as z.infer<typeof financeReviewSchema>;
    const company = req.mcpCompany!;
    const employee = req.mcpEmployee!;
    try {
      const transaction = await stageAiLedgerReview({
        companyId: company.id,
        entryId: body.transactionId,
        employeeId: employee.id,
        changes: body.changes ?? [],
        note: body.note,
      });
      await recordAudit({
        companyId: company.id,
        actorEmployeeId: employee.id,
        action: "finance.transaction.ai_review",
        targetType: "ledger_entry",
        targetId: transaction.id,
        targetLabel: transaction.memo,
        metadata: { categoryChanges: transaction.reviewChanges, via: "mcp" },
      });
      await journal(
        employee.id,
        `${employee.name} reviewed finance transaction ${transaction.id.slice(0, 8)}`,
        `${transaction.reviewChanges.length} category change(s) staged for final human approval.`,
      );
      res.json({
        transaction,
        status: "waiting_for_human_approval",
        note: "The proposed categories are staged only. An owner or admin has been notified for final approval.",
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const financeReportSchema = z
  .object({
    report: z.enum(["income_statement", "balance_sheet", "cash_flow", "trial_balance", "trends"]),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    asOf: z.string().max(40).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_finance_report",
  validateBody(financeReportSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const body = req.body as z.infer<typeof financeReportSchema>;
    const companyId = req.mcpCompany!.id;
    try {
      if (body.report === "balance_sheet" || body.report === "trial_balance") {
        const asOf = parseOptionalToolDate(body.asOf, "asOf") ?? new Date();
        const report =
          body.report === "balance_sheet"
            ? await balanceSheet(companyId, asOf)
            : { asOf: asOf.toISOString(), rows: await trialBalance(companyId, asOf) };
        return res.json({ report: body.report, data: report });
      }
      const from = parseOptionalToolDate(body.from, "from");
      const to = parseOptionalToolDate(body.to, "to");
      if (!from || !to) {
        return res.status(400).json({ error: "from and to are required for this report" });
      }
      const report =
        body.report === "income_statement"
          ? await incomeStatement(companyId, from, to)
          : body.report === "cash_flow"
            ? await cashFlow(companyId, from, to)
            : await financialTrends(companyId, from, to);
      res.json({ report: body.report, data: report });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

// ---- Invoices + customers (read: view; invoice: run accounts receivable) ----

const listInvoicesSchema = z
  .object({
    status: z.enum(["draft", "sent", "paid", "void"]).optional(),
    customerSlug: z.string().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_invoices",
  validateBody(listInvoicesSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof listInvoicesSchema>;
    const where: Record<string, unknown> = { companyId: cid };
    if (body.status) where.status = body.status;
    if (body.customerSlug) {
      const customer = await loadCustomerBySlug(cid, body.customerSlug);
      if (!customer) {
        return res.status(404).json({ error: `Customer "${body.customerSlug}" not found` });
      }
      where.customerId = customer.id;
    }
    const invoices = await AppDataSource.getRepository(Invoice).find({
      where,
      order: { createdAt: "DESC" },
      take: body.limit ?? 50,
    });
    const hydrated = await hydrateInvoices(cid, invoices);
    res.json({ invoices: hydrated.map(serializeInvoiceRow) });
  },
);

const getInvoiceSchema = z.object({ invoiceSlug: z.string().min(1).max(200) }).strict();

mcpInternalRouter.post(
  "/tools/get_invoice",
  validateBody(getInvoiceSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const { invoiceSlug } = req.body as z.infer<typeof getInvoiceSchema>;
    const inv = await loadInvoiceBySlug(cid, invoiceSlug);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    const [hydrated] = await hydrateInvoices(cid, [inv]);
    res.json({ invoice: serializeInvoiceFull(hydrated) });
  },
);

const listCustomersSchema = z
  .object({
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_customers",
  validateBody(listCustomersSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof listCustomersSchema>;
    const rows = await AppDataSource.getRepository(Customer).find({
      where: { companyId: cid },
      order: { createdAt: "DESC" },
    });
    const filtered = (body.includeArchived ? rows : rows.filter((c) => !c.archivedAt)).slice(
      0,
      body.limit ?? 100,
    );
    res.json({ customers: filtered.map(serializeToolCustomer) });
  },
);

const getCustomerSchema = z.object({ customerSlug: z.string().min(1).max(200) }).strict();

mcpInternalRouter.post(
  "/tools/get_customer",
  validateBody(getCustomerSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const { customerSlug } = req.body as z.infer<typeof getCustomerSchema>;
    const customer = await loadCustomerBySlug(cid, customerSlug);
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const contacts = await AppDataSource.getRepository(CustomerContact).find({
      where: { companyId: cid, customerId: customer.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    res.json({
      customer: {
        ...serializeToolCustomer(customer),
        contacts: contacts.map((ct) => ({
          id: ct.id,
          name: ct.name,
          email: ct.email,
          phone: ct.phone,
          role: ct.role,
          isPrimary: ct.isPrimary,
        })),
      },
    });
  },
);

const createCustomerSchema = z
  .object({
    name: z.string().min(1).max(120),
    email: z.string().email().max(200).or(z.literal("")).optional(),
    phone: z.string().max(60).optional(),
    billingAddress: z.string().max(2000).optional(),
    shippingAddress: z.string().max(2000).optional(),
    taxNumber: z.string().max(60).optional(),
    currency: isoCurrency.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_customer",
  validateBody(createCustomerSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "invoice"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof createCustomerSchema>;
    const repo = AppDataSource.getRepository(Customer);
    const c = repo.create({
      companyId: cid,
      name: body.name,
      slug: await uniqueCustomerSlug(cid, toSlug(body.name)),
      email: body.email ?? "",
      phone: body.phone ?? "",
      billingAddress: body.billingAddress ?? "",
      shippingAddress: body.shippingAddress ?? "",
      taxNumber: body.taxNumber ?? "",
      currency: body.currency ?? "USD",
      notes: body.notes ?? "",
      createdById: null,
    });
    await repo.save(c);
    await aiWriteTrail(req, {
      action: "finance.customer.create",
      targetType: "customer",
      targetId: c.id,
      targetLabel: c.name,
      journalTitle: `${req.mcpEmployee!.name} created customer ${c.name}`,
    });
    res.json({ customer: serializeToolCustomer(c) });
  },
);

const updateCustomerSchema = z
  .object({
    customerSlug: z.string().min(1).max(200),
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().max(200).or(z.literal("")).optional(),
    phone: z.string().max(60).optional(),
    billingAddress: z.string().max(2000).optional(),
    shippingAddress: z.string().max(2000).optional(),
    taxNumber: z.string().max(60).optional(),
    currency: isoCurrency.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_customer",
  validateBody(updateCustomerSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "invoice"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof updateCustomerSchema>;
    const c = await loadCustomerBySlug(cid, body.customerSlug);
    if (!c) return res.status(404).json({ error: "Customer not found" });
    // Renames change the display name but not the slug, so links stay stable —
    // same rule the human customer routes follow.
    // Repointing a customer's email is the one field that interacts with the
    // send_invoice recipient allowlist (the customer's domain is trusted), so
    // record the before/after explicitly in the audit trail rather than as a
    // generic "updated customer".
    const emailChanged = body.email !== undefined && body.email !== c.email;
    const previousEmail = c.email;
    if (body.name !== undefined) c.name = body.name;
    if (body.email !== undefined) c.email = body.email;
    if (body.phone !== undefined) c.phone = body.phone;
    if (body.billingAddress !== undefined) c.billingAddress = body.billingAddress;
    if (body.shippingAddress !== undefined) c.shippingAddress = body.shippingAddress;
    if (body.taxNumber !== undefined) c.taxNumber = body.taxNumber;
    if (body.currency !== undefined) c.currency = body.currency;
    if (body.notes !== undefined) c.notes = body.notes;
    await AppDataSource.getRepository(Customer).save(c);
    await aiWriteTrail(req, {
      action: "finance.customer.update",
      targetType: "customer",
      targetId: c.id,
      targetLabel: c.name,
      journalTitle: `${req.mcpEmployee!.name} updated customer ${c.name}`,
      metadata: emailChanged
        ? { emailChanged: true, previousEmail, newEmail: c.email }
        : { emailChanged: false },
    });
    res.json({ customer: serializeToolCustomer(c) });
  },
);

const invoiceLineSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().min(0).max(1_000_000),
  unitPriceCents: z.number().int().min(-2_000_000_000).max(2_000_000_000),
  taxRateId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
});

const createInvoiceSchema = z
  .object({
    customerSlug: z.string().min(1).max(200),
    currency: isoCurrency.optional(),
    issueDate: z.string().datetime().optional(),
    dueDate: z.string().datetime().optional(),
    notes: z.string().max(4000).optional(),
    footer: z.string().max(1000).optional(),
    lines: z.array(invoiceLineSchema).min(1).max(200),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_invoice",
  validateBody(createInvoiceSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "invoice"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof createInvoiceSchema>;
    const customer = await loadCustomerBySlug(cid, body.customerSlug);
    if (!customer) {
      return res.status(404).json({ error: `Customer "${body.customerSlug}" not found` });
    }
    // A non-positive invoice never books an Accounts Receivable entry at issue
    // time (postInvoiceIssue skips the ledger when totalCents <= 0), which would
    // later strand any payment against a receivable that was never debited.
    // Refuse it before we persist anything. Tax only ever adds, so a positive
    // pre-tax gross is sufficient to guarantee a positive total.
    const grossCents = body.lines.reduce(
      (sum, l) => sum + Math.round(l.quantity * l.unitPriceCents),
      0,
    );
    if (grossCents <= 0) {
      return res
        .status(400)
        .json({ error: "Invoice line items must total more than zero before tax." });
    }
    // Reject unknown tax-rate ids up front — snapshotTax would otherwise treat
    // a stray id as "no tax" and silently under-bill.
    const taxRateIds = [
      ...new Set(body.lines.map((l) => l.taxRateId).filter((x): x is string => !!x)),
    ];
    if (taxRateIds.length) {
      const found = await AppDataSource.getRepository(TaxRate).find({
        where: { companyId: cid, id: In(taxRateIds) },
        select: ["id"],
      });
      const known = new Set(found.map((t) => t.id));
      const missing = taxRateIds.filter((id) => !known.has(id));
      if (missing.length) {
        return res.status(400).json({ error: `Unknown tax rate id(s): ${missing.join(", ")}` });
      }
    }
    const repo = AppDataSource.getRepository(Invoice);
    const issueDate = body.issueDate ? new Date(body.issueDate) : new Date();
    const dueDate = body.dueDate
      ? new Date(body.dueDate)
      : new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000);
    const inv = repo.create({
      companyId: cid,
      customerId: customer.id,
      slug: await draftInvoiceSlug(cid),
      numberSeq: 0,
      number: "",
      status: "draft",
      issueDate,
      dueDate,
      currency: body.currency ?? customer.currency ?? "USD",
      notes: body.notes ?? "",
      footer: body.footer ?? "",
      createdById: null,
    });
    await repo.save(inv);
    await replaceInvoiceLines(inv, body.lines);
    const recomputed = await recomputeInvoiceTotals(inv);
    const [hydrated] = await hydrateInvoices(cid, [recomputed]);
    await aiWriteTrail(req, {
      action: "finance.invoice.create",
      targetType: "invoice",
      targetId: inv.id,
      targetLabel: `Draft for ${customer.name}`,
      journalTitle: `${req.mcpEmployee!.name} drafted an invoice for ${customer.name}`,
      metadata: { totalCents: recomputed.totalCents, currency: recomputed.currency },
    });
    res.json({
      invoice: serializeInvoiceFull(hydrated),
      note: "Draft created. Call send_invoice to issue and email it to the customer.",
    });
  },
);

const sendInvoiceMcpSchema = z
  .object({
    invoiceSlug: z.string().min(1).max(200),
    message: z.string().max(4000).optional(),
    attachPdf: z.boolean().optional(),
    to: z.array(z.string().trim().email().max(320)).min(1).max(25).optional(),
    cc: z.array(z.string().trim().email().max(320)).max(25).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/send_invoice",
  validateBody(sendInvoiceMcpSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "invoice"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof sendInvoiceMcpSchema>;
    let inv = await loadInvoiceBySlug(cid, body.invoiceSlug);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "void") {
      return res.status(409).json({ error: "Voided invoices cannot be sent" });
    }
    // Defense in depth for drafts created outside create_invoice: a
    // non-positive total skips the AR posting at issue, so refuse to issue it.
    if (inv.status === "draft" && inv.totalCents <= 0) {
      return res.status(400).json({
        error: `Cannot issue an invoice with a non-positive total (${inv.totalCents} ${inv.currency}). Add positive line items first.`,
      });
    }
    // Recipient allowlist. A person sending from the invoice page confirms
    // the exact addresses in a modal, so the human route is unconstrained.
    // This tool is driven by an AI whose context carries attacker-controlled
    // text (memos, vendor names, bank descriptors), so an injected prompt
    // must not be able to mail company documents + free text to an arbitrary
    // address. AI-supplied To/Cc are limited to the customer's own domain and
    // the owner-curated always-Cc finance mailboxes. (Omitting To/Cc entirely
    // still defaults to the customer's on-file address, which is always fine.)
    if (body.to?.length || body.cc?.length) {
      const [customer, settings] = await Promise.all([
        AppDataSource.getRepository(Customer).findOneBy({ id: inv.customerId, companyId: cid }),
        getFinanceSettings(cid),
      ]);
      const trusted = trustedRecipientDomains({
        customerEmail: customer?.email,
        ccEmails: settings.invoiceCcEmails,
      });
      const blocked = disallowedRecipients([...(body.to ?? []), ...(body.cc ?? [])], trusted);
      if (blocked.length) {
        return res.status(400).json({
          error:
            `These recipients aren't allowed for an AI-sent invoice: ${blocked.join(", ")}. ` +
            "An AI employee may only email the customer's own domain or a finance mailbox saved " +
            "under Finance → Settings → Always Cc. A person can send to any address from the invoice page.",
        });
      }
    }
    try {
      // Auto-issue drafts first (mints the number, posts DR AR / CR Revenue),
      // matching the human "Send" button.
      if (inv.status === "draft") inv = await issueInvoice(inv, null);
      const result = await sendInvoiceEmail(cid, inv, null, {
        message: body.message,
        attachPdf: body.attachPdf ?? true,
        to: body.to,
        cc: body.cc ?? [],
      });
      const [hydrated] = await hydrateInvoices(cid, [inv]);
      await aiWriteTrail(req, {
        action: "finance.invoice.send",
        targetType: "invoice",
        targetId: inv.id,
        targetLabel: inv.number || "Invoice",
        journalTitle: `${req.mcpEmployee!.name} sent invoice ${inv.number || inv.slug}`,
        journalBody: `Delivery: ${result.status} → ${result.toAddress || "(no address on file)"}`,
        metadata: {
          sendStatus: result.status,
          toAddress: result.toAddress,
          transport: result.transport,
        },
      });
      res.json({
        invoice: serializeInvoiceFull(hydrated),
        send: {
          status: result.status,
          toAddress: result.toAddress,
          ccAddress: result.ccAddress,
          transport: result.transport,
          errorMessage: result.errorMessage,
        },
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const recordPaymentSchema = z
  .object({
    invoiceSlug: z.string().min(1).max(200),
    amountCents: z.number().int().min(1).max(2_000_000_000),
    currency: isoCurrency.optional(),
    paidAt: z.string().datetime().optional(),
    method: z.enum(["cash", "bank_transfer", "stripe", "lightning", "other"]).optional(),
    reference: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/record_payment",
  validateBody(recordPaymentSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "invoice"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof recordPaymentSchema>;
    const inv = await loadInvoiceBySlug(cid, body.invoiceSlug);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    if (inv.status === "draft") {
      return res.status(409).json({ error: "Issue the invoice before recording payments" });
    }
    if (inv.status === "void") {
      return res.status(409).json({ error: "Voided invoices cannot be paid" });
    }
    // The ledger applies the payment in the invoice's currency (postInvoicePayment
    // never reads payment.currency), so a mismatched code would silently misbook
    // cash and the paid/balance math. Refuse it rather than corrupt the books.
    if (body.currency && body.currency !== inv.currency) {
      return res.status(400).json({
        error: `Record the payment in the invoice's currency (${inv.currency}). Multi-currency payments aren't supported — the amount is always applied in ${inv.currency}.`,
      });
    }
    // Refuse overpayment here too — the AI path posts through the same ledger
    // as the human route, so an over-balance amount would drive AR negative
    // with no credit-note tracking. Keep the two paths' guarantees identical.
    if (body.amountCents > inv.balanceCents) {
      return res.status(400).json({
        error:
          inv.balanceCents <= 0
            ? "This invoice is already fully paid."
            : `Payment exceeds the ${formatMoney(inv.balanceCents, inv.currency)} balance due. Record at most that amount.`,
      });
    }
    const repo = AppDataSource.getRepository(InvoicePayment);
    const payment = await repo.save(
      repo.create({
        invoiceId: inv.id,
        amountCents: body.amountCents,
        currency: body.currency ?? inv.currency,
        paidAt: body.paidAt ? new Date(body.paidAt) : new Date(),
        method: body.method ?? "other",
        reference: body.reference ?? "",
        notes: body.notes ?? "",
        createdById: null,
      }),
    );
    // Auto-post DR Bank / CR AR (FX-aware). If the post throws, roll the
    // payment row back so the sub-ledger can't drift from the GL — matches
    // the human invoice route.
    try {
      await postInvoicePayment(inv, payment, null);
    } catch (err) {
      await repo.delete({ id: payment.id });
      return res.status(400).json({ error: (err as Error).message });
    }
    try {
      // recomputeInvoiceTotals flips the invoice to `paid` once payments
      // cover the total.
      const recomputed = await recomputeInvoiceTotals(inv);
      const [hydrated] = await hydrateInvoices(cid, [recomputed]);
      await aiWriteTrail(req, {
        action: "finance.invoice.payment",
        targetType: "invoice",
        targetId: inv.id,
        targetLabel: inv.number || "Invoice",
        journalTitle: `${req.mcpEmployee!.name} recorded a payment on invoice ${inv.number || inv.slug}`,
        metadata: {
          amountCents: body.amountCents,
          currency: payment.currency,
          status: recomputed.status,
        },
      });
      res.json({ invoice: serializeInvoiceFull(hydrated) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const voidInvoiceMcpSchema = z.object({ invoiceSlug: z.string().min(1).max(200) }).strict();

mcpInternalRouter.post(
  "/tools/void_invoice",
  validateBody(voidInvoiceMcpSchema),
  async (req: McpRequest, res) => {
    if (!(await requireFinance(req, res, "invoice"))) return;
    const cid = req.mcpCompany!.id;
    const { invoiceSlug } = req.body as z.infer<typeof voidInvoiceMcpSchema>;
    const inv = await loadInvoiceBySlug(cid, invoiceSlug);
    if (!inv) return res.status(404).json({ error: "Invoice not found" });
    try {
      const voided = await voidInvoice(inv, null);
      const [hydrated] = await hydrateInvoices(cid, [voided]);
      await aiWriteTrail(req, {
        action: "finance.invoice.void",
        targetType: "invoice",
        targetId: inv.id,
        targetLabel: inv.number || "Invoice",
        journalTitle: `${req.mcpEmployee!.name} voided invoice ${inv.number || inv.slug}`,
      });
      res.json({ invoice: serializeInvoiceFull(hydrated) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

// ----- Revenue -----
//
// The revenue tools are grant-gated per employee via `EmployeeRevenueGrant`
// (Revenue → AI access), the same one-row-per-employee shape as finance:
// read < write < send. Reads need `read` and every write needs `write`.
// `send` buys nothing extra at this surface on purpose — what it governs is
// whether a sequence's drafted touches may go out without a human, and that is
// enforced at the outbound choke-point in `services/mail/actions.ts`, not here.
//
// Every rule these handlers could get wrong — the deal status invariant,
// duplicate-email detection, suppression semantics, enrolment skips — lives in
// `services/revenue/*` and is shared with the human HTTP routes, so an AI
// employee and a member cannot end up with two different sets of guarantees.

/**
 * Enforce the acting employee's revenue grant. Writes the 403 itself and
 * returns false, so callers do `if (!(await requireRevenue(...))) return;`.
 */
async function requireRevenue(
  req: McpRequest,
  res: Response,
  required: RevenueAccessLevel,
): Promise<boolean> {
  const self = req.mcpEmployee!;
  const grant = await AppDataSource.getRepository(EmployeeRevenueGrant).findOneBy({
    employeeId: self.id,
  });
  if (!grant || REVENUE_ACCESS_RANK[grant.accessLevel] < REVENUE_ACCESS_RANK[required]) {
    res.status(403).json({
      error: grant
        ? `No grant: this needs the "${required}" revenue access level; yours is "${grant.accessLevel}". Ask an owner or admin to raise it under Revenue → AI access.`
        : "No grant: you do not have access to the revenue system. Ask an owner or admin to grant it under Revenue → AI access.",
    });
    return false;
  }
  return true;
}

/**
 * The principal behind an MCP call, in the shape the revenue services expect.
 *
 * Always an employee here — the human path into these services is
 * `routes/revenue.ts`, which supplies `userId`. Passing both would make the
 * activity trail ambiguous about who actually did it.
 */
function revenueActor(req: McpRequest): { userId: null; employeeId: string } {
  return { userId: null, employeeId: req.mcpEmployee!.id };
}

const contactLifecycleEnum = z.enum(
  CONTACT_LIFECYCLE_STAGES as [ContactLifecycleStage, ...ContactLifecycleStage[]],
);
const activityKindEnum = z.enum(ACTIVITY_KINDS as [ActivityKind, ...ActivityKind[]]);

function serializeContactRow(c: Contact & { customerName?: string | null }) {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    title: c.title,
    companyName: c.companyName,
    customerId: c.customerId,
    customerName: c.customerName ?? null,
    lifecycleStage: c.lifecycleStage,
    ownerId: c.ownerId,
    ownerEmployeeId: c.ownerEmployeeId,
    source: c.source,
    score: c.score,
    // The three fields that answer "may I email this person". Always on the
    // row, including list rows, so the answer is never one call away.
    doNotContact: c.doNotContact,
    unsubscribedAt: c.unsubscribedAt,
    bouncedAt: c.bouncedAt,
    lastActivityAt: c.lastActivityAt,
    archived: !!c.archivedAt,
  };
}

function serializeContactFull(c: Contact & { customerName?: string | null }) {
  return {
    ...serializeContactRow(c),
    linkedinUrl: c.linkedinUrl,
    websiteUrl: c.websiteUrl,
    sourceDetail: c.sourceDetail,
    notes: c.notes,
    createdAt: c.createdAt,
  };
}

function serializeDealRow(d: HydratedDeal) {
  return {
    id: d.id,
    title: d.title,
    status: d.status,
    stageId: d.stageId,
    stageName: d.stageName,
    stageKind: d.stageKind,
    amountCents: d.amountCents,
    currency: d.currency,
    weightedValueCents: d.weightedValueCents,
    customerId: d.customerId,
    customerName: d.customerName,
    primaryContactId: d.primaryContactId,
    contactName: d.contactName,
    expectedCloseDate: d.expectedCloseDate,
    closedAt: d.closedAt,
    lostReason: d.lostReason,
    nextStep: d.nextStep,
    ownerId: d.ownerId,
    ownerEmployeeId: d.ownerEmployeeId,
    lastActivityAt: d.lastActivityAt,
    archived: !!d.archivedAt,
  };
}

function serializeDealFull(d: HydratedDeal) {
  return {
    ...serializeDealRow(d),
    description: d.description,
    source: d.source,
    probabilityOverride: d.probabilityOverride,
    createdAt: d.createdAt,
  };
}

function serializeActivity(a: Activity) {
  return {
    id: a.id,
    kind: a.kind,
    subject: a.subject,
    bodyText: a.bodyText,
    occurredAt: a.occurredAt,
    contactId: a.contactId,
    dealId: a.dealId,
    customerId: a.customerId,
    mailThreadId: a.mailThreadId,
    actorUserId: a.actorUserId,
    actorEmployeeId: a.actorEmployeeId,
  };
}

function serializeDealStage(s: DealStage) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    sortOrder: s.sortOrder,
    kind: s.kind,
    probability: s.probability,
    description: s.description,
    archived: !!s.archivedAt,
  };
}

function serializeSequence(s: HydratedSequence) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    status: s.status,
    mailAccountId: s.mailAccountId,
    employeeId: s.employeeId,
    autoSend: s.autoSend,
    stopOnReply: s.stopOnReply,
    dailyCap: s.dailyCap,
    sendWindow: parseSendWindow(s),
    stepCount: s.stepCount,
    activeCount: s.activeCount,
    totalEnrolled: s.totalEnrolled,
    enrollmentCounts: s.enrollmentCounts,
    archived: !!s.archivedAt,
  };
}

/**
 * A Signal row, without its `sql`.
 *
 * The query runs against the company's own production database, and nothing an
 * employee does with this list — deciding whether outreach is already covered,
 * reading what fired — needs the statement itself. Omitting it keeps a
 * production schema out of a model's context for no loss of capability.
 */
function serializeSignal(s: Signal) {
  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    sourceKind: s.sourceKind,
    cron: s.cron,
    enabled: s.enabled,
    actionKind: s.actionKind,
    employeeId: s.employeeId,
    lastRunAt: s.lastRunAt,
    lastEventCount: s.lastEventCount,
    lastError: s.lastError,
    archived: !!s.archivedAt,
  };
}

function serializeSuppression(s: Suppression) {
  return {
    id: s.id,
    email: s.email,
    reason: s.reason,
    source: s.source,
    contactId: s.contactId,
    notes: s.notes,
    createdAt: s.createdAt,
  };
}

/** 404 unless the id names a Customer in this company. Blocks cross-tenant ids. */
async function revenueCustomerExists(companyId: string, customerId: string): Promise<boolean> {
  return AppDataSource.getRepository(Customer).existsBy({ id: customerId, companyId });
}

// ---- Revenue reads ----

const listContactsSchema = z
  .object({
    q: z.string().max(200).optional(),
    lifecycleStage: contactLifecycleEnum.optional(),
    customerId: z.string().uuid().optional(),
    ownedByMe: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_contacts",
  validateBody(listContactsSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const body = req.body as z.infer<typeof listContactsSchema>;
    const { rows, total } = await listContacts(req.mcpCompany!.id, {
      q: body.q,
      lifecycleStage: body.lifecycleStage,
      customerId: body.customerId,
      ownerEmployeeId: body.ownedByMe ? req.mcpEmployee!.id : undefined,
      includeArchived: body.includeArchived,
      limit: body.limit,
      offset: body.offset,
    });
    res.json({ contacts: rows.map(serializeContactRow), total });
  },
);

const searchContactsSchema = z
  .object({
    query: z.string().min(1).max(200),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/search_contacts",
  validateBody(searchContactsSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const body = req.body as z.infer<typeof searchContactsSchema>;
    const { rows, total } = await listContacts(req.mcpCompany!.id, {
      q: body.query,
      includeArchived: body.includeArchived,
      limit: body.limit ?? 25,
    });
    res.json({ contacts: rows.map(serializeContactRow), total });
  },
);

const contactIdSchema = z.object({ contactId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/get_contact",
  validateBody(contactIdSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const { contactId } = req.body as z.infer<typeof contactIdSchema>;
    const contact = await getContact(cid, contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const { rows } = await listDeals(cid, { contactId: contact.id, status: "open", limit: 50 });
    res.json({
      contact: serializeContactFull(contact),
      openDeals: rows.map(serializeDealRow),
      note: "Call get_contact_timeline for the conversation history.",
    });
  },
);

const contactTimelineSchema = z
  .object({
    contactId: z.string().uuid(),
    kinds: z.array(activityKindEnum).max(ACTIVITY_KINDS.length).optional(),
    includeRelatedDeals: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_contact_timeline",
  validateBody(contactTimelineSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof contactTimelineSchema>;
    const contact = await getContact(cid, body.contactId);
    if (!contact) return res.status(404).json({ error: "Contact not found" });
    const { rows, total } = await listActivities(cid, {
      contactId: contact.id,
      kinds: body.kinds,
      // Defaulting on matches what a human means by "our history with them" —
      // the contact page composes the same way.
      includeRelatedDeals: body.includeRelatedDeals ?? true,
      limit: body.limit ?? 50,
      offset: body.offset,
    });
    res.json({ activities: rows.map(serializeActivity), total });
  },
);

const listDealsSchema = z
  .object({
    q: z.string().max(200).optional(),
    status: z.enum(["open", "won", "lost"]).optional(),
    stageId: z.string().uuid().optional(),
    customerId: z.string().uuid().optional(),
    contactId: z.string().uuid().optional(),
    ownedByMe: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_deals",
  validateBody(listDealsSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const body = req.body as z.infer<typeof listDealsSchema>;
    const { rows, total } = await listDeals(req.mcpCompany!.id, {
      q: body.q,
      status: body.status,
      stageId: body.stageId,
      customerId: body.customerId,
      contactId: body.contactId,
      ownerEmployeeId: body.ownedByMe ? req.mcpEmployee!.id : undefined,
      includeArchived: body.includeArchived,
      limit: body.limit,
      offset: body.offset,
    });
    res.json({ deals: rows.map(serializeDealRow), total });
  },
);

const getDealSchema = z
  .object({
    dealId: z.string().uuid(),
    activityLimit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_deal",
  validateBody(getDealSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof getDealSchema>;
    const deal = await getHydratedDeal(cid, body.dealId);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    const [timeline, committee] = await Promise.all([
      listActivities(cid, { dealId: deal.id, limit: body.activityLimit ?? 50 }),
      listDealContacts(cid, deal.id),
    ]);
    res.json({
      deal: serializeDealFull(deal),
      activities: timeline.rows.map(serializeActivity),
      activityTotal: timeline.total,
      contacts: committee.map((l) => ({
        contactId: l.contactId,
        role: l.role,
        contact: l.contact ? serializeContactRow(l.contact) : null,
      })),
    });
  },
);

mcpInternalRouter.post(
  "/tools/get_deal_board",
  validateBody(emptyToolSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const columns = await dealBoard(req.mcpCompany!.id);
    res.json({
      columns: columns.map((c) => ({
        stage: serializeDealStage(c.stage),
        totalCents: c.totalCents,
        weightedCents: c.weightedCents,
        deals: c.deals.map(serializeDealRow),
      })),
    });
  },
);

mcpInternalRouter.post(
  "/tools/list_deal_stages",
  validateBody(emptyToolSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    // Seeds the default ladder on first read, so an employee asking about the
    // pipeline before any human has opened Revenue still gets real stage ids.
    const stages = await listDealStages(req.mcpCompany!.id);
    res.json({ stages: stages.map(serializeDealStage) });
  },
);

const listSequencesSchema = z
  .object({
    q: z.string().max(200).optional(),
    status: z.enum(["draft", "active", "paused", "archived"]).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_sequences",
  validateBody(listSequencesSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const body = req.body as z.infer<typeof listSequencesSchema>;
    const rows = await listSequences(req.mcpCompany!.id, body);
    res.json({ sequences: rows.map(serializeSequence) });
  },
);

const listSignalsSchema = z
  .object({
    enabled: z.boolean().optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_signals",
  validateBody(listSignalsSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const body = req.body as z.infer<typeof listSignalsSchema>;
    const rows = await listSignals(req.mcpCompany!.id, body);
    res.json({ signals: rows.map(serializeSignal) });
  },
);

const revenueReportSchema = z
  .object({
    report: z.enum(["overview", "mrr", "funnel", "cac"]),
    from: z.string().max(40).optional(),
    to: z.string().max(40).optional(),
    months: z.number().int().min(1).max(60).optional(),
    targetCents: z.number().int().min(0).max(2_000_000_000).optional(),
    grossMarginPct: z.number().int().min(0).max(100).optional(),
  })
  .strict();

/** Trailing twelve months when the caller states no window — see routes/revenue.ts. */
const DEFAULT_REVENUE_REPORT_MONTHS = 12;

function resolveRevenuePeriod(body: { from?: string; to?: string }): { from: Date; to: Date } {
  const to = parseOptionalToolDate(body.to, "to") ?? new Date();
  const stated = parseOptionalToolDate(body.from, "from");
  if (stated) return { from: stated, to };
  const from = new Date(to.getTime());
  from.setUTCMonth(from.getUTCMonth() - DEFAULT_REVENUE_REPORT_MONTHS);
  return { from, to };
}

mcpInternalRouter.post(
  "/tools/get_revenue_report",
  validateBody(revenueReportSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "read"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof revenueReportSchema>;
    try {
      if (body.report === "mrr") {
        const data = await getMrrSeries(cid, body.months ?? DEFAULT_REVENUE_REPORT_MONTHS);
        return res.json({ report: body.report, data });
      }
      const period = resolveRevenuePeriod(body);
      const data =
        body.report === "overview"
          ? await getRevenueOverview(cid, {
              ...period,
              targetCents: body.targetCents,
              grossMarginPct: body.grossMarginPct,
            })
          : body.report === "funnel"
            ? await getFunnelReport(cid, period, { targetCents: body.targetCents })
            : await getCacReport(cid, period, { grossMarginPct: body.grossMarginPct });
      res.json({ report: body.report, data });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

// ---- Revenue writes (all need `write`; all leave an audit + journal trail) ----

const contactWritableSchema = z.object({
  email: z.string().max(320).optional(),
  phone: z.string().max(60).optional(),
  title: z.string().max(200).optional(),
  linkedinUrl: z.string().max(500).optional(),
  websiteUrl: z.string().max(500).optional(),
  customerId: z.string().uuid().nullable().optional(),
  companyName: z.string().max(200).optional(),
  lifecycleStage: contactLifecycleEnum.optional(),
  source: z.string().max(100).optional(),
  sourceDetail: z.string().max(500).optional(),
  score: z.number().int().min(0).max(100).optional(),
  notes: z.string().max(20_000).optional(),
});

const createContactSchema = contactWritableSchema
  .extend({ name: z.string().min(1).max(200) })
  .strict();

mcpInternalRouter.post(
  "/tools/create_contact",
  validateBody(createContactSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof createContactSchema>;
    if (body.customerId && !(await revenueCustomerExists(cid, body.customerId))) {
      return res.status(400).json({ error: "Unknown customer" });
    }
    try {
      const contact = await createContact(cid, body, revenueActor(req));
      await aiWriteTrail(req, {
        action: "revenue.contact.create",
        targetType: "contact",
        targetId: contact.id,
        targetLabel: contact.name,
        journalTitle: `${req.mcpEmployee!.name} added contact ${contact.name}`,
        metadata: { email: contact.email, lifecycleStage: contact.lifecycleStage },
      });
      res.json({ contact: serializeContactFull(contact) });
    } catch (err) {
      // The service refuses rather than merging, and hands back the id of the
      // row that already holds the address so the model updates that one
      // instead of forking the person into two records.
      if (err instanceof DuplicateContactError) {
        return res.status(409).json({ error: err.message, existingId: err.existingId });
      }
      // Never rethrow: Express 4 does not await a handler, so a rejection here
      // escapes to the process instead of reaching an error middleware.
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const updateContactSchema = contactWritableSchema
  .extend({
    contactId: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
    doNotContact: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_contact",
  validateBody(updateContactSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const { contactId, ...patch } = req.body as z.infer<typeof updateContactSchema>;
    if (patch.customerId && !(await revenueCustomerExists(cid, patch.customerId))) {
      return res.status(400).json({ error: "Unknown customer" });
    }
    try {
      const contact = await updateContact(cid, contactId, patch);
      if (!contact) return res.status(404).json({ error: "Contact not found" });
      await aiWriteTrail(req, {
        action: "revenue.contact.update",
        targetType: "contact",
        targetId: contact.id,
        targetLabel: contact.name,
        journalTitle: `${req.mcpEmployee!.name} updated contact ${contact.name}`,
        metadata: { changes: Object.keys(patch) },
      });
      res.json({ contact: serializeContactFull(contact) });
    } catch (err) {
      if (err instanceof DuplicateContactError) {
        return res.status(409).json({ error: err.message, existingId: err.existingId });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const dealWritableSchema = z.object({
  description: z.string().max(20_000).optional(),
  customerId: z.string().uuid().nullable().optional(),
  primaryContactId: z.string().uuid().nullable().optional(),
  amountCents: z.number().int().min(0).max(2_000_000_000).optional(),
  currency: isoCurrency.optional(),
  probabilityOverride: z.number().int().min(0).max(100).nullable().optional(),
  expectedCloseDate: z.string().max(40).nullable().optional(),
  source: z.string().max(100).optional(),
  nextStep: z.string().max(500).optional(),
});

const createDealSchema = dealWritableSchema
  .extend({
    title: z.string().min(1).max(200),
    stageId: z.string().uuid().nullable().optional(),
  })
  .strict();

/**
 * `expectedCloseDate` off the wire: `undefined` means "leave it alone",
 * `null` means "clear it", a string is parsed and throws when unusable.
 */
function parseExpectedCloseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseOptionalToolDate(value, "expectedCloseDate") ?? null;
}

/** Company-scope every id a deal write links to, so a bare uuid can't reach another tenant. */
async function checkDealLinks(
  companyId: string,
  links: { customerId?: string | null; primaryContactId?: string | null },
): Promise<string | null> {
  if (links.customerId && !(await revenueCustomerExists(companyId, links.customerId))) {
    return "Unknown customer";
  }
  if (links.primaryContactId && !(await getContact(companyId, links.primaryContactId))) {
    return "Unknown contact";
  }
  return null;
}

mcpInternalRouter.post(
  "/tools/create_deal",
  validateBody(createDealSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof createDealSchema>;
    const badLink = await checkDealLinks(cid, body);
    if (badLink) return res.status(400).json({ error: badLink });
    try {
      const deal = await createDeal(
        cid,
        { ...body, expectedCloseDate: parseExpectedCloseDate(body.expectedCloseDate) ?? null },
        revenueActor(req),
      );
      const hydrated = await getHydratedDeal(cid, deal.id);
      await aiWriteTrail(req, {
        action: "revenue.deal.create",
        targetType: "deal",
        targetId: deal.id,
        targetLabel: deal.title,
        journalTitle: `${req.mcpEmployee!.name} opened deal ${deal.title}`,
        metadata: {
          stageId: deal.stageId,
          amountCents: deal.amountCents,
          currency: deal.currency,
        },
      });
      res.json({ deal: hydrated ? serializeDealFull(hydrated) : null });
    } catch (err) {
      if (err instanceof InvalidStageError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const updateDealSchema = dealWritableSchema
  .extend({
    dealId: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_deal",
  validateBody(updateDealSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const { dealId, ...patch } = req.body as z.infer<typeof updateDealSchema>;
    const badLink = await checkDealLinks(cid, patch);
    if (badLink) return res.status(400).json({ error: badLink });
    try {
      // No `stageId` here on purpose: a stage move carries the status invariant
      // and writes the activity every funnel report reads, so it goes through
      // move_deal_stage and nowhere else.
      const deal = await updateDeal(
        cid,
        dealId,
        { ...patch, expectedCloseDate: parseExpectedCloseDate(patch.expectedCloseDate) },
        revenueActor(req),
      );
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      await aiWriteTrail(req, {
        action: "revenue.deal.update",
        targetType: "deal",
        targetId: deal.id,
        targetLabel: deal.title,
        journalTitle: `${req.mcpEmployee!.name} updated deal ${deal.title}`,
        metadata: { changes: Object.keys(patch) },
      });
      const hydrated = await getHydratedDeal(cid, deal.id);
      res.json({ deal: hydrated ? serializeDealFull(hydrated) : null });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

const moveDealStageSchema = z
  .object({
    dealId: z.string().uuid(),
    stageId: z.string().uuid(),
    lostReason: z.string().max(500).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/move_deal_stage",
  validateBody(moveDealStageSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof moveDealStageSchema>;
    try {
      const deal = await moveDealToStage(cid, body.dealId, body.stageId, revenueActor(req), {
        lostReason: body.lostReason,
      });
      if (!deal) return res.status(404).json({ error: "Deal not found" });
      await aiWriteTrail(req, {
        action: "revenue.deal.stage",
        targetType: "deal",
        targetId: deal.id,
        targetLabel: deal.title,
        journalTitle: `${req.mcpEmployee!.name} moved deal ${deal.title} (now ${deal.status})`,
        metadata: {
          stageId: deal.stageId,
          status: deal.status,
          lostReason: deal.lostReason,
        },
      });
      const hydrated = await getHydratedDeal(cid, deal.id);
      res.json({ deal: hydrated ? serializeDealFull(hydrated) : null });
    } catch (err) {
      if (err instanceof InvalidStageError) {
        return res.status(400).json({ error: err.message });
      }
      res.status(400).json({ error: (err as Error).message });
    }
  },
);

/**
 * Kinds an AI employee may log by hand — the same four the human route allows.
 *
 * Deliberately narrower than `ACTIVITY_KINDS`. `stage_change`, `deal_won`,
 * `email_out` and friends are *derived* records the funnel and MRR reports read
 * as evidence that something happened, so a hand-written one would be a
 * conversion no report could tell from a real one. Those kinds are written only
 * by the service that performs the underlying act.
 */
const logActivitySchema = z
  .object({
    kind: z.enum(["note", "call", "meeting", "task"]),
    subject: z.string().max(500).optional(),
    bodyText: z.string().max(20_000).optional(),
    occurredAt: z.string().max(40).optional(),
    contactId: z.string().uuid().nullable().optional(),
    dealId: z.string().uuid().nullable().optional(),
    customerId: z.string().uuid().nullable().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/log_activity",
  validateBody(logActivitySchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof logActivitySchema>;
    if (body.contactId && !(await getContact(cid, body.contactId))) {
      return res.status(400).json({ error: "Unknown contact" });
    }
    if (body.dealId && !(await getHydratedDeal(cid, body.dealId))) {
      return res.status(400).json({ error: "Unknown deal" });
    }
    if (body.customerId && !(await revenueCustomerExists(cid, body.customerId))) {
      return res.status(400).json({ error: "Unknown customer" });
    }
    let occurredAt: Date | undefined;
    try {
      occurredAt = parseOptionalToolDate(body.occurredAt, "occurredAt");
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }
    const activity = await recordActivity(
      cid,
      { ...body, occurredAt },
      revenueActor(req),
    );
    await aiWriteTrail(req, {
      action: "revenue.activity.create",
      targetType: "activity",
      targetId: activity.id,
      targetLabel: activity.subject,
      journalTitle: `${req.mcpEmployee!.name} logged a ${activity.kind}`,
      journalBody: activity.subject,
      metadata: { kind: activity.kind, contactId: activity.contactId, dealId: activity.dealId },
    });
    res.json({ activity: serializeActivity(activity) });
  },
);

const addDealContactSchema = z
  .object({
    dealId: z.string().uuid(),
    contactId: z.string().uuid(),
    role: z.string().max(100).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_deal_contact",
  validateBody(addDealContactSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof addDealContactSchema>;
    const deal = await getHydratedDeal(cid, body.dealId);
    if (!deal) return res.status(404).json({ error: "Deal not found" });
    const contact = await getContact(cid, body.contactId);
    if (!contact) return res.status(400).json({ error: "Unknown contact" });

    const link = await addDealContact(cid, deal.id, contact.id, body.role ?? "");
    await aiWriteTrail(req, {
      action: "revenue.deal.contact.add",
      targetType: "deal",
      targetId: deal.id,
      targetLabel: deal.title,
      journalTitle: `${req.mcpEmployee!.name} put ${contact.name} on deal ${deal.title}`,
      metadata: { contactId: contact.id, role: link.role },
    });
    res.json({
      dealId: deal.id,
      contact: serializeContactRow(contact),
      role: link.role,
    });
  },
);

const enrollInSequenceSchema = z
  .object({
    sequenceId: z.string().uuid(),
    contactIds: z.array(z.string().uuid()).min(1).max(500),
    dealId: z.string().uuid().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/enroll_in_sequence",
  validateBody(enrollInSequenceSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof enrollInSequenceSchema>;
    const sequence = await getSequence(cid, body.sequenceId);
    if (!sequence) return res.status(404).json({ error: "Sequence not found" });
    if (body.dealId && !(await getHydratedDeal(cid, body.dealId))) {
      return res.status(400).json({ error: "Unknown deal" });
    }
    // Partial success by design: a suppressed or do-not-contact address inside
    // a large selection skips that one person rather than refusing the rest.
    // The service reports what it skipped and why.
    const result = await bulkEnroll(cid, sequence.id, body.contactIds, {
      dealId: body.dealId ?? null,
      actor: revenueActor(req),
    });
    await aiWriteTrail(req, {
      action: "revenue.sequence.enroll",
      targetType: "sequence",
      targetId: sequence.id,
      targetLabel: sequence.name,
      journalTitle: `${req.mcpEmployee!.name} enrolled ${result.enrolled} contact(s) in ${sequence.name}`,
      journalBody:
        result.skipped.length > 0 ? `${result.skipped.length} skipped — see the audit metadata.` : "",
      metadata: {
        requested: body.contactIds.length,
        enrolled: result.enrolled,
        skipped: result.skipped,
        autoSend: sequence.autoSend,
      },
    });
    res.json({
      sequenceId: sequence.id,
      enrolled: result.enrolled,
      skipped: result.skipped,
      note: sequence.autoSend
        ? "This sequence is marked auto-send: drafted touches may go out without a human pressing Send."
        : "Each drafted touch waits in the review queue for a human to send.",
    });
  },
);

const suppressEmailSchema = z
  .object({
    email: z.string().min(3).max(320),
    // `imported` is excluded: it is a provenance marker for a bulk opt-out list
    // carried in from another system, which an employee suppressing one address
    // at a time can never honestly claim.
    reason: z.enum(["unsubscribe", "bounce", "complaint", "manual"]).optional(),
    notes: z.string().max(2_000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/suppress_email",
  validateBody(suppressEmailSchema),
  async (req: McpRequest, res) => {
    if (!(await requireRevenue(req, res, "write"))) return;
    const cid = req.mcpCompany!.id;
    const body = req.body as z.infer<typeof suppressEmailSchema>;
    const email = normalizeEmail(body.email);
    if (!email) return res.status(400).json({ error: "That is not a usable email address" });

    const [already, contact] = await Promise.all([
      isSuppressed(cid, email),
      findContactByEmail(cid, email),
    ]);
    const row = await addSuppression({
      companyId: cid,
      email,
      reason: body.reason ?? "manual",
      source: "mcp",
      contactId: contact?.id ?? null,
      notes: body.notes,
      createdById: null,
    });
    if (!row) return res.status(400).json({ error: "That is not a usable email address" });

    // Only trail a real insert. Re-suppressing an address that was already on
    // the list changes nothing, and an audit row saying otherwise would put a
    // second "who suppressed this and when" answer into the record the list is
    // there to defend.
    if (!already) {
      await aiWriteTrail(req, {
        action: "revenue.suppression.create",
        targetType: "suppression",
        targetId: row.id,
        targetLabel: row.email,
        journalTitle: `${req.mcpEmployee!.name} suppressed ${row.email}`,
        journalBody: row.notes,
        metadata: { reason: row.reason, contactId: row.contactId },
      });
    }
    res.json({
      suppression: serializeSuppression(row),
      created: !already,
      note: "Removing an address from the do-not-mail list is a human's decision — there is no tool for it.",
    });
  },
);

// ----- Skills -----

const employeeRefSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
  })
  .strict();

async function resolveEmployee(
  co: Company,
  self: AIEmployee,
  slug?: string,
): Promise<AIEmployee | null> {
  if (!slug || slug === self.slug) return self;
  return AppDataSource.getRepository(AIEmployee).findOneBy({
    companyId: co.id,
    slug,
  });
}

mcpInternalRouter.post(
  "/tools/list_skills",
  validateBody(employeeRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof employeeRefSchema>;
    const target = await resolveEmployee(req.mcpCompany!, req.mcpEmployee!, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    const skills = await AppDataSource.getRepository(Skill).find({
      where: { employeeId: target.id },
      order: { createdAt: "ASC" },
    });
    res.json({ employee: serializeEmployee(target), skills: skills.map(serializeSkill) });
  },
);

const createSkillSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(80),
    body: z.string().max(20_000).optional(),
    toolset: z.array(z.string().min(1).max(64)).max(MAX_TOOLSET_ENTRIES).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_skill",
  validateBody(createSkillSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createSkillSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const target = await resolveEmployee(co, self, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });

    const repo = AppDataSource.getRepository(Skill);
    const dup = await repo
      .createQueryBuilder("s")
      .where("s.employeeId = :eid", { eid: target.id })
      .andWhere("LOWER(s.name) = LOWER(:name)", { name: body.name.trim() })
      .getOne();
    if (dup) {
      return res.status(409).json({
        error: `A skill named "${body.name}" already exists for ${target.name}`,
      });
    }
    const baseSlug = toSlug(body.name) || "skill";
    let slug = baseSlug;
    let n = 1;
    while (await repo.findOneBy({ employeeId: target.id, slug })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }

    const checkedToolset = validateToolset(body.toolset ?? []);
    if (!checkedToolset.ok) return res.status(400).json({ error: checkedToolset.error });

    const s = repo.create({
      employeeId: target.id,
      name: body.name,
      slug,
      body: body.body?.trim() ? body.body : skillTemplate(body.name),
      toolsetJson: serializeToolset(checkedToolset.names),
    });
    await repo.save(s);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "skill.create",
      targetType: "skill",
      targetId: s.id,
      targetLabel: s.name,
      metadata: { via: "mcp", employeeId: target.id },
    });
    await journal(
      target.id,
      `${self.name} added a skill: "${s.name}"`,
      "Created via the built-in MCP tool.",
    );

    res.json({ skill: serializeSkill(s) });
  },
);

const updateSkillSchema = z
  .object({
    skillId: z.string().uuid(),
    name: z.string().min(1).max(80).optional(),
    body: z.string().max(20_000).optional(),
    toolset: z.array(z.string().min(1).max(64)).max(MAX_TOOLSET_ENTRIES).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_skill",
  validateBody(updateSkillSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateSkillSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const repo = AppDataSource.getRepository(Skill);
    const skill = await repo.findOneBy({ id: body.skillId });
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    const owner = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: skill.employeeId,
      companyId: co.id,
    });
    if (!owner) return res.status(404).json({ error: "Skill not found" });

    if (body.name !== undefined && body.name.trim() !== skill.name) {
      const dup = await repo
        .createQueryBuilder("s")
        .where("s.employeeId = :eid", { eid: owner.id })
        .andWhere("LOWER(s.name) = LOWER(:name)", { name: body.name.trim() })
        .andWhere("s.id != :sid", { sid: skill.id })
        .getOne();
      if (dup) {
        return res.status(409).json({
          error: `A skill named "${body.name}" already exists for ${owner.name}`,
        });
      }
      skill.name = body.name;
    }
    if (body.body !== undefined) skill.body = body.body;
    if (body.toolset !== undefined) {
      const checked = validateToolset(body.toolset);
      if (!checked.ok) return res.status(400).json({ error: checked.error });
      skill.toolsetJson = serializeToolset(checked.names);
    }
    await repo.save(skill);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "skill.update",
      targetType: "skill",
      targetId: skill.id,
      targetLabel: skill.name,
      metadata: { via: "mcp", employeeId: owner.id, changes: body },
    });
    res.json({ skill: serializeSkill(skill) });
  },
);

const deleteSkillSchema = z.object({ skillId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/delete_skill",
  validateBody(deleteSkillSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteSkillSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const repo = AppDataSource.getRepository(Skill);
    const skill = await repo.findOneBy({ id: body.skillId });
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    const owner = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: skill.employeeId,
      companyId: co.id,
    });
    if (!owner) return res.status(404).json({ error: "Skill not found" });

    // Matches the REST delete, which has always done this. Skipping it here
    // orphaned a tag assignment row per tagged skill.
    await deleteTagAssignments("skill", skill.id);
    await repo.delete({ id: skill.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "skill.delete",
      targetType: "skill",
      targetId: skill.id,
      targetLabel: skill.name,
      metadata: { via: "mcp", employeeId: owner.id },
    });
    await journal(
      owner.id,
      `${self.name} removed the skill "${skill.name}"`,
      "Deleted via the built-in MCP tool.",
    );
    res.json({ ok: true });
  },
);

// ----- Routines -----

mcpInternalRouter.post(
  "/tools/list_routines",
  validateBody(employeeRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof employeeRefSchema>;
    const co = req.mcpCompany!;
    const target = await resolveEmployee(co, req.mcpEmployee!, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    const routines = await AppDataSource.getRepository(Routine).find({
      where: { employeeId: target.id },
      order: { createdAt: "ASC" },
    });
    const tagsById = await tagsByResourceIds(
      co.id,
      "routine",
      routines.map((r) => r.id),
    );
    res.json({
      employee: serializeEmployee(target),
      routines: routines.map((r) =>
        serializeRoutine(
          r,
          (tagsById.get(r.id) ?? []).map((tag) => tag.name),
        ),
      ),
    });
  },
);

const createRoutineSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
    name: z.string().min(1).max(80),
    cronExpr: z.string().refine((v) => cron.validate(v), "Invalid cron expression"),
    brief: z.string().max(20_000).optional(),
    tags: z.string().max(500).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_routine",
  validateBody(createRoutineSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createRoutineSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const target = await resolveEmployee(co, self, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });

    const repo = AppDataSource.getRepository(Routine);
    const dup = await repo
      .createQueryBuilder("r")
      .where("r.employeeId = :eid", { eid: target.id })
      .andWhere("LOWER(r.name) = LOWER(:name)", { name: body.name.trim() })
      .getOne();
    if (dup) {
      return res.status(409).json({
        error: `A routine named "${body.name}" already exists for ${target.name}`,
      });
    }
    const baseSlug = toSlug(body.name) || "routine";
    let slug = baseSlug;
    let n = 1;
    while (await repo.findOneBy({ employeeId: target.id, slug })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }

    const r = repo.create({
      employeeId: target.id,
      name: body.name,
      slug,
      cronExpr: body.cronExpr,
      enabled: true,
      lastRunAt: null,
      body: body.brief?.trim() ? body.brief : routineTemplate(body.name, body.cronExpr),
    });
    registerRoutine(r);
    await repo.save(r);
    // Tags live in the shared TagAssignment catalog, not on the Routine row —
    // names auto-create any tags the company doesn't have yet.
    const tags = body.tags?.trim()
      ? (await replaceResourceTagNames(co.id, "routine", r.id, body.tags)).map((tag) => tag.name)
      : [];

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "routine.create",
      targetType: "routine",
      targetId: r.id,
      targetLabel: r.name,
      metadata: { via: "mcp", employeeId: target.id, cronExpr: r.cronExpr },
    });
    await journal(
      target.id,
      `${self.name} scheduled a routine: "${r.name}"`,
      `Cron: \`${r.cronExpr}\`\n\nCreated via the built-in MCP tool.`,
    );

    res.json({ routine: serializeRoutine(r, tags) });
  },
);

const updateRoutineSchema = z
  .object({
    routineId: z.string().uuid(),
    name: z.string().min(1).max(80).optional(),
    cronExpr: z
      .string()
      .refine((v) => cron.validate(v), "Invalid cron expression")
      .optional(),
    brief: z.string().max(20_000).optional(),
    enabled: z.boolean().optional(),
    tags: z.string().max(500).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_routine",
  validateBody(updateRoutineSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateRoutineSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const repo = AppDataSource.getRepository(Routine);
    const routine = await repo.findOneBy({ id: body.routineId });
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const owner = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: routine.employeeId,
      companyId: co.id,
    });
    if (!owner) return res.status(404).json({ error: "Routine not found" });

    if (body.name !== undefined && body.name.trim() !== routine.name) {
      const dup = await repo
        .createQueryBuilder("r")
        .where("r.employeeId = :eid", { eid: owner.id })
        .andWhere("LOWER(r.name) = LOWER(:name)", { name: body.name.trim() })
        .andWhere("r.id != :rid", { rid: routine.id })
        .getOne();
      if (dup) {
        return res.status(409).json({
          error: `A routine named "${body.name}" already exists for ${owner.name}`,
        });
      }
      routine.name = body.name;
    }
    if (body.cronExpr !== undefined) routine.cronExpr = body.cronExpr;
    if (body.brief !== undefined) routine.body = body.brief;
    if (body.enabled !== undefined) routine.enabled = body.enabled;
    registerRoutine(routine);
    await repo.save(routine);
    // Tags aren't a Routine column — they're assignments in the shared catalog.
    // Passing `tags` replaces the whole set (empty string clears them); omitting
    // it leaves the existing assignments untouched.
    const tags =
      body.tags !== undefined
        ? await replaceResourceTagNames(co.id, "routine", routine.id, body.tags)
        : await tagsForResource(co.id, "routine", routine.id);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "routine.update",
      targetType: "routine",
      targetId: routine.id,
      targetLabel: routine.name,
      metadata: { via: "mcp", employeeId: owner.id, changes: body },
    });
    res.json({
      routine: serializeRoutine(
        routine,
        tags.map((tag) => tag.name),
      ),
    });
  },
);

const deleteRoutineSchema = z.object({ routineId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/delete_routine",
  validateBody(deleteRoutineSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteRoutineSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const repo = AppDataSource.getRepository(Routine);
    const routine = await repo.findOneBy({ id: body.routineId });
    if (!routine) return res.status(404).json({ error: "Routine not found" });
    const owner = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: routine.employeeId,
      companyId: co.id,
    });
    if (!owner) return res.status(404).json({ error: "Routine not found" });

    await AppDataSource.getRepository(Approval).delete({ routineId: routine.id });
    await AppDataSource.getRepository(Run).delete({ routineId: routine.id });
    await repo.delete({ id: routine.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "routine.delete",
      targetType: "routine",
      targetId: routine.id,
      targetLabel: routine.name,
      metadata: { via: "mcp", employeeId: owner.id },
    });
    await journal(
      owner.id,
      `${self.name} removed the routine "${routine.name}"`,
      "Deleted via the built-in MCP tool.",
    );
    res.json({ ok: true });
  },
);

// ----- Projects & todos -----

/**
 * The calling AI employee as a principal `services/projects.ts` can check.
 * `requireMcpToken` has already resolved the token to this employee.
 */
function mcpActorOf(req: McpRequest): ProjectActor {
  return { kind: "ai", id: req.mcpEmployee!.id };
}

/**
 * Whether a human reviewer can still open `project`. Reads their real role —
 * an owner reaches every project in their company, so assuming "member" here
 * would silently drop notifications they should get.
 */
async function reviewerCanSeeProject(
  companyId: string,
  userId: string,
  project: Project,
): Promise<boolean> {
  const mem = await AppDataSource.getRepository(Membership).findOneBy({
    companyId,
    userId,
  });
  if (!mem) return false;
  return hasProjectAccess(project, { kind: "user", id: userId, role: mem.role }, "read");
}

mcpInternalRouter.post("/tools/list_projects", async (req: McpRequest, res) => {
  const co = req.mcpCompany!;
  // Filter rather than 403 — an employee shouldn't be told a project exists
  // just to be refused it.
  const accessible = await listAccessibleProjectIds(co.id, mcpActorOf(req));
  if (accessible.size === 0) return res.json({ projects: [] });
  const projects = await AppDataSource.getRepository(Project).find({
    where: { companyId: co.id, id: In([...accessible]) },
    order: { createdAt: "ASC" },
  });
  res.json({ projects: projects.map(serializeProject) });
});

const createProjectSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    key: z
      .string()
      .min(1)
      .max(6)
      .regex(/^[A-Za-z0-9]+$/)
      .optional(),
  })
  .strict();

function deriveProjectKey(name: string): string {
  const cleaned = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .trim();
  if (!cleaned) return "PRJ";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0] + (parts[2]?.[0] ?? "")).slice(0, 4);
  }
  return parts[0].slice(0, 4);
}

mcpInternalRouter.post(
  "/tools/create_project",
  validateBody(createProjectSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createProjectSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Project);
    const dup = await repo
      .createQueryBuilder("p")
      .where("p.companyId = :cid", { cid: co.id })
      .andWhere("LOWER(p.name) = LOWER(:name)", { name: body.name.trim() })
      .getOne();
    if (dup) {
      return res.status(409).json({
        error: `A project named "${body.name}" already exists in this company`,
      });
    }
    const baseSlug = toSlug(body.name) || "project";
    let slug = baseSlug;
    let n = 1;
    while (await repo.findOneBy({ companyId: co.id, slug })) {
      n += 1;
      slug = `${baseSlug}-${n}`;
    }
    const key = (body.key ?? deriveProjectKey(body.name)).toUpperCase();
    const p = repo.create({
      companyId: co.id,
      name: body.name,
      slug,
      description: body.description ?? "",
      key,
      createdById: null,
      todoCounter: 0,
    });
    await repo.save(p);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "project.create",
      targetType: "project",
      targetId: p.id,
      targetLabel: p.name,
      metadata: { via: "mcp", key: p.key },
    });
    await journal(self.id, `${self.name} created project "${p.name}"`, `Key: ${p.key}`);
    res.json({ project: serializeProject(p) });
  },
);

const listTodosSchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_todos",
  validateBody(listTodosSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listTodosSchema>;
    const co = req.mcpCompany!;
    const p = await AppDataSource.getRepository(Project).findOneBy({
      companyId: co.id,
      slug: body.projectSlug,
    });
    if (!p) return res.status(404).json({ error: "Project not found" });
    if (!(await hasProjectAccess(p, mcpActorOf(req), "read"))) {
      return res.status(403).json({ error: "No access to that project" });
    }
    const todos = await AppDataSource.getRepository(Todo).find({
      where: { projectId: p.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    res.json({ project: serializeProject(p), todos: todos.map(serializeTodo) });
  },
);

const TODO_STATUSES: [TodoStatus, ...TodoStatus[]] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
];
const TODO_PRIORITIES: [TodoPriority, ...TodoPriority[]] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];
const TODO_RECURRENCES: [TodoRecurrence, ...TodoRecurrence[]] = [
  "none",
  "daily",
  "weekdays",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];

const createTodoSchema = z
  .object({
    projectSlug: z.string().min(1).max(120),
    title: z.string().min(1).max(200),
    description: z.string().max(10_000).optional(),
    status: z.enum(TODO_STATUSES).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    assigneeEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
    reviewerEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    recurrence: z.enum(TODO_RECURRENCES).optional(),
    parentTodoId: z.string().uuid().nullable().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_todo",
  validateBody(createTodoSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createTodoSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;

    const projRepo = AppDataSource.getRepository(Project);
    const project = await projRepo.findOneBy({ companyId: co.id, slug: body.projectSlug });
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!(await hasProjectAccess(project, mcpActorOf(req), "write"))) {
      return res.status(403).json({ error: "No access to that project" });
    }

    // Default assignee = the employee who called us. Humans can explicitly
    // pass null to unassign, or a different slug to delegate.
    let assigneeId: string | null = self.id;
    if (body.assigneeEmployeeSlug === null) {
      assigneeId = null;
    } else if (body.assigneeEmployeeSlug !== undefined) {
      const other = await AppDataSource.getRepository(AIEmployee).findOneBy({
        companyId: co.id,
        slug: body.assigneeEmployeeSlug,
      });
      if (!other) return res.status(400).json({ error: "Unknown assignee" });
      assigneeId = other.id;
    }

    let reviewerId: string | null = null;
    if (body.reviewerEmployeeSlug) {
      const rv = await AppDataSource.getRepository(AIEmployee).findOneBy({
        companyId: co.id,
        slug: body.reviewerEmployeeSlug,
      });
      if (!rv) return res.status(400).json({ error: "Unknown reviewer" });
      reviewerId = rv.id;
    }

    if (body.parentTodoId) {
      const parentErr = await validateParentTodo(project.id, body.parentTodoId);
      if (parentErr) return res.status(400).json({ error: parentErr });
    }

    project.todoCounter += 1;
    await projRepo.save(project);

    const status: TodoStatus = body.status ?? "todo";
    const todoRepo = AppDataSource.getRepository(Todo);
    const last = await todoRepo.findOne({
      where: { projectId: project.id, status },
      order: { sortOrder: "DESC" },
    });
    const sortOrder = (last?.sortOrder ?? 0) + 1000;

    const t = todoRepo.create({
      projectId: project.id,
      number: project.todoCounter,
      title: body.title,
      description: body.description ?? "",
      status,
      priority: body.priority ?? "none",
      assigneeEmployeeId: assigneeId,
      reviewerEmployeeId: reviewerId,
      createdById: null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      sortOrder,
      completedAt: status === "done" ? new Date() : null,
      recurrence: body.recurrence ?? "none",
      recurrenceParentId: null,
      parentTodoId: body.parentTodoId ?? null,
    });
    await todoRepo.save(t);
    void dispatchTodoCreated(co.id, t.id).catch((err) => {
      console.error(`[pipelines] task event failed for ${t.id}:`, err);
    });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "todo.create",
      targetType: "todo",
      targetId: t.id,
      targetLabel: `${project.key}-${t.number}: ${t.title}`,
      metadata: { via: "mcp", projectId: project.id, assigneeId },
    });
    await journal(
      self.id,
      `${self.name} created todo ${project.key}-${t.number}: "${t.title}"`,
      assigneeId === self.id
        ? "Assigned to self."
        : assigneeId
          ? "Assigned to a teammate."
          : "Unassigned.",
    );

    res.json({ todo: serializeTodo(t), projectKey: project.key });
  },
);

const updateTodoSchema = z
  .object({
    todoId: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(10_000).optional(),
    status: z.enum(TODO_STATUSES).optional(),
    priority: z.enum(TODO_PRIORITIES).optional(),
    assigneeEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
    reviewerEmployeeSlug: z.string().min(1).max(120).nullable().optional(),
    dueAt: z.string().datetime().nullable().optional(),
    parentTodoId: z.string().uuid().nullable().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_todo",
  validateBody(updateTodoSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateTodoSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;

    const todoRepo = AppDataSource.getRepository(Todo);
    const t = await todoRepo.findOneBy({ id: body.todoId });
    if (!t) return res.status(404).json({ error: "Todo not found" });
    const project = await AppDataSource.getRepository(Project).findOneBy({
      id: t.projectId,
      companyId: co.id,
    });
    if (!project) return res.status(404).json({ error: "Todo not found" });
    if (!(await hasProjectAccess(project, mcpActorOf(req), "write"))) {
      return res.status(403).json({ error: "No access to that project" });
    }

    if (body.assigneeEmployeeSlug !== undefined) {
      if (body.assigneeEmployeeSlug === null) {
        t.assigneeEmployeeId = null;
      } else {
        const other = await AppDataSource.getRepository(AIEmployee).findOneBy({
          companyId: co.id,
          slug: body.assigneeEmployeeSlug,
        });
        if (!other) return res.status(400).json({ error: "Unknown assignee" });
        t.assigneeEmployeeId = other.id;
        t.assigneeUserId = null;
      }
    }
    if (body.reviewerEmployeeSlug !== undefined) {
      if (body.reviewerEmployeeSlug === null) {
        t.reviewerEmployeeId = null;
      } else {
        const rv = await AppDataSource.getRepository(AIEmployee).findOneBy({
          companyId: co.id,
          slug: body.reviewerEmployeeSlug,
        });
        if (!rv) return res.status(400).json({ error: "Unknown reviewer" });
        t.reviewerEmployeeId = rv.id;
        t.reviewerUserId = null;
      }
    }
    if (body.title !== undefined) t.title = body.title;
    if (body.description !== undefined) t.description = body.description;
    if (body.priority !== undefined) t.priority = body.priority;
    if (body.dueAt !== undefined) t.dueAt = body.dueAt ? new Date(body.dueAt) : null;
    if (body.parentTodoId !== undefined) {
      if (body.parentTodoId) {
        const parentErr = await validateParentTodo(t.projectId, body.parentTodoId, t.id);
        if (parentErr) return res.status(400).json({ error: parentErr });
        const childCount = await todoRepo.countBy({ parentTodoId: t.id });
        if (childCount > 0) {
          return res.status(400).json({ error: "A todo with subtasks cannot become a subtask" });
        }
      }
      t.parentTodoId = body.parentTodoId;
    }
    let justEnteredReview = false;
    if (body.status !== undefined) {
      const prev = t.status;
      t.status = body.status;
      if (body.status === "done" && prev !== "done") t.completedAt = new Date();
      if (body.status !== "done" && prev === "done") t.completedAt = null;
      if (body.status === "in_review" && prev !== "in_review") {
        justEnteredReview = true;
      }
    }
    await todoRepo.save(t);

    // The reviewer may have been set while the project was still open, or had
    // their access removed since. Notifying them anyway would push the todo's
    // title to someone who can only 403 on the link, so re-check before
    // sending rather than trusting the stored reviewer.
    const reviewerStillHasAccess =
      justEnteredReview && t.reviewerUserId
        ? await reviewerCanSeeProject(co.id, t.reviewerUserId, project)
        : false;
    if (justEnteredReview && t.reviewerUserId && reviewerStillHasAccess) {
      void notifyTodoReviewByEmployee({
        companyId: co.id,
        todo: t,
        project,
        actorEmployeeId: self.id,
        actorEmployeeName: self.name,
      }).catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[mcpInternal] notify review requested failed:", e);
      });
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "todo.update",
      targetType: "todo",
      targetId: t.id,
      targetLabel: `${project.key}-${t.number}: ${t.title}`,
      metadata: { via: "mcp", changes: body },
    });
    res.json({ todo: serializeTodo(t) });
  },
);

// ----- Journal -----

const listJournalSchema = z
  .object({
    employeeSlug: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_journal",
  validateBody(listJournalSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listJournalSchema>;
    const target = await resolveEmployee(req.mcpCompany!, req.mcpEmployee!, body.employeeSlug);
    if (!target) return res.status(404).json({ error: "Employee not found" });
    const entries = await AppDataSource.getRepository(JournalEntry).find({
      where: { employeeId: target.id },
      order: { createdAt: "DESC" },
      take: body.limit ?? 20,
    });
    res.json({
      employee: serializeEmployee(target),
      entries: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        title: e.title,
        body: e.body,
        createdAt: e.createdAt,
      })),
    });
  },
);

const addJournalSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(10_000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_journal_entry",
  validateBody(addJournalSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof addJournalSchema>;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(JournalEntry);
    const entry = repo.create({
      employeeId: self.id,
      kind: "note",
      title: body.title,
      body: body.body ?? "",
      runId: null,
      routineId: null,
      authorUserId: null,
    });
    await repo.save(entry);
    await recordAudit({
      companyId: req.mcpCompany!.id,
      actorEmployeeId: self.id,
      action: "journal.create",
      targetType: "journal_entry",
      targetId: entry.id,
      targetLabel: entry.title,
      metadata: { via: "mcp" },
    });
    res.json({
      entry: {
        id: entry.id,
        kind: entry.kind,
        title: entry.title,
        body: entry.body,
        createdAt: entry.createdAt,
      },
    });
  },
);

// ----- Memory (durable facts injected into every prompt) -----

mcpInternalRouter.post("/tools/list_memory", async (req: McpRequest, res) => {
  const self = req.mcpEmployee!;
  const items = await AppDataSource.getRepository(EmployeeMemory).find({
    where: { employeeId: self.id },
    order: { createdAt: "ASC" },
  });
  res.json({
    items: items.map((i) => ({
      id: i.id,
      title: i.title,
      body: i.body,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    })),
  });
});

const addMemorySchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(4000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_memory",
  validateBody(addMemorySchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof addMemorySchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const repo = AppDataSource.getRepository(EmployeeMemory);
    const row = repo.create({
      employeeId: self.id,
      title: body.title,
      body: body.body ?? "",
      authorUserId: null,
    });
    await repo.save(row);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "memory.create",
      targetType: "memory_item",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({
      item: { id: row.id, title: row.title, body: row.body },
    });
  },
);

const updateMemorySchema = z
  .object({
    itemId: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(4000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_memory",
  validateBody(updateMemorySchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateMemorySchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const repo = AppDataSource.getRepository(EmployeeMemory);
    const row = await repo.findOneBy({ id: body.itemId, employeeId: self.id });
    if (!row) return res.status(404).json({ error: "Memory item not found" });
    if (body.title !== undefined) row.title = body.title;
    if (body.body !== undefined) row.body = body.body;
    await repo.save(row);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "memory.update",
      targetType: "memory_item",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({ item: { id: row.id, title: row.title, body: row.body } });
  },
);

const deleteMemorySchema = z.object({ itemId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/delete_memory",
  validateBody(deleteMemorySchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteMemorySchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const repo = AppDataSource.getRepository(EmployeeMemory);
    const row = await repo.findOneBy({ id: body.itemId, employeeId: self.id });
    if (!row) return res.status(404).json({ error: "Memory item not found" });
    await repo.delete({ id: row.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "memory.delete",
      targetType: "memory_item",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({ ok: true });
  },
);

// ----- Bases (per-employee grants) -----

/**
 * Load the base for this slug + assert the calling employee has an active
 * grant. Returns the base row on success, or `null` + writes a 403/404 and
 * returns `null` so the caller can early-out.
 */
async function loadGrantedBase(
  req: McpRequest,
  res: Response,
  baseSlug: string,
): Promise<Base | null> {
  const emp = req.mcpEmployee!;
  const co = req.mcpCompany!;
  const b = await AppDataSource.getRepository(Base).findOneBy({
    companyId: co.id,
    slug: baseSlug,
  });
  if (!b) {
    res.status(404).json({ error: "Base not found" });
    return null;
  }
  const ok = await hasBaseGrant(emp.id, b.id);
  if (!ok) {
    res.status(403).json({
      error: `No grant: ${emp.name} does not have access to base "${b.name}". Ask a teammate to grant it in Base settings → AI access.`,
    });
    return null;
  }
  return b;
}

mcpInternalRouter.post("/tools/list_bases", async (req: McpRequest, res) => {
  const emp = req.mcpEmployee!;
  const bases = await listGrantedBasesForEmployee(emp.id);
  res.json({
    bases: bases.map((b) => ({
      id: b.id,
      slug: b.slug,
      name: b.name,
      description: b.description,
    })),
  });
});

const baseRefSchema = z.object({ baseSlug: z.string().min(1).max(120) }).strict();

mcpInternalRouter.post(
  "/tools/get_base",
  validateBody(baseRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof baseRefSchema>;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const tables = await AppDataSource.getRepository(BaseTable).find({
      where: { baseId: b.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    const fields = tables.length
      ? await AppDataSource.getRepository(BaseField).find({
          where: { tableId: In(tables.map((t) => t.id)) },
          order: { sortOrder: "ASC", createdAt: "ASC" },
        })
      : [];
    const fieldsByTable = new Map<string, BaseField[]>();
    for (const f of fields) {
      if (!fieldsByTable.has(f.tableId)) fieldsByTable.set(f.tableId, []);
      fieldsByTable.get(f.tableId)!.push(f);
    }
    res.json({
      base: { id: b.id, slug: b.slug, name: b.name, description: b.description },
      tables: tables.map((t) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        fields: (fieldsByTable.get(t.id) ?? []).map(hydrateField),
      })),
    });
  },
);

const listRowsSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
    order: z.enum(["asc", "desc"]).optional(),
  })
  .strict();

/**
 * How many link options per target table the agent tools return. A link field
 * otherwise drags its whole target table into the model's context on every
 * read, however few rows were asked for.
 */
const MCP_LINK_OPTIONS_PER_TABLE = 200;

mcpInternalRouter.post(
  "/tools/list_base_rows",
  validateBody(listRowsSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listRowsSchema>;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    // Rows carry a manual sort order that create_base_row appends to, so the
    // newest row sorts last. Reading "desc" is how a caller gets the latest
    // rows without paging through the whole table to reach the end.
    const dir = body.order === "desc" ? "DESC" : "ASC";
    const [fields, records, total] = await Promise.all([
      AppDataSource.getRepository(BaseField).find({
        where: { tableId: t.id },
        order: { sortOrder: "ASC", createdAt: "ASC" },
      }),
      AppDataSource.getRepository(BaseRecord).find({
        where: { tableId: t.id },
        order: { sortOrder: dir, createdAt: dir },
        skip: body.offset ?? 0,
        take: body.limit ?? 100,
      }),
      AppDataSource.getRepository(BaseRecord).count({ where: { tableId: t.id } }),
    ]);
    const co = req.mcpCompany!;
    const [linkOptions, resourceOptions] = await Promise.all([
      buildLinkOptionsFor(fields, { maxPerTable: MCP_LINK_OPTIONS_PER_TABLE }),
      buildResourceOptionsFor(co.id, fields, {
        maxPerKind: MCP_LINK_OPTIONS_PER_TABLE,
        projectViewer: mcpActorOf(req),
      }),
    ]);
    res.json({
      table: { id: t.id, slug: t.slug, name: t.name },
      fields: fields.map(hydrateField),
      records: records.map(hydrateRecord),
      // So the caller can tell a short page from the end of the table without
      // fetching everything to find out.
      pagination: {
        total,
        offset: body.offset ?? 0,
        limit: body.limit ?? 100,
        order: body.order ?? "asc",
      },
      linkOptions,
      resourceOptions,
    });
  },
);

const writeRowSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    data: z.record(z.unknown()),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_base_row",
  validateBody(writeRowSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof writeRowSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const repo = AppDataSource.getRepository(BaseRecord);
    const last = await repo.findOne({
      where: { tableId: t.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await repo.save(
      repo.create({
        tableId: t.id,
        dataJson: JSON.stringify(body.data ?? {}),
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_row.create",
      targetType: "base_record",
      targetId: saved.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id },
    });
    await journal(
      self.id,
      `${self.name} added a row to ${b.name}/${t.name}`,
      "Via the base MCP tool.",
    );
    res.json({ row: hydrateRecord(saved) });
  },
);

const updateRowSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    rowId: z.string().uuid(),
    data: z.record(z.unknown()),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_base_row",
  validateBody(updateRowSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateRowSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const repo = AppDataSource.getRepository(BaseRecord);
    const r = await repo.findOneBy({ id: body.rowId, tableId: t.id });
    if (!r) return res.status(404).json({ error: "Row not found" });
    const data: Record<string, unknown> = JSON.parse(r.dataJson || "{}");
    for (const [k, v] of Object.entries(body.data)) {
      if (v === null || v === undefined || v === "") delete data[k];
      else data[k] = v;
    }
    r.dataJson = JSON.stringify(data);
    await repo.save(r);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_row.update",
      targetType: "base_record",
      targetId: r.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id },
    });
    res.json({ row: hydrateRecord(r) });
  },
);

const deleteRowSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    rowId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_base_row",
  validateBody(deleteRowSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteRowSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const repo = AppDataSource.getRepository(BaseRecord);
    const r = await repo.findOneBy({ id: body.rowId, tableId: t.id });
    if (!r) return res.status(404).json({ error: "Row not found" });
    await repo.delete({ id: r.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_row.delete",
      targetType: "base_record",
      targetId: r.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id },
    });
    res.json({ ok: true });
  },
);

// ----- Record detail (comments + attachments) -----

/**
 * Walk a row id back up through table → base, asserting the calling employee
 * holds a grant on the owning base. Returns `null` plus a 403/404 response on
 * failure so the route handler can early-out with a single check.
 */
async function loadGrantedRecord(
  req: McpRequest,
  res: Response,
  rowId: string,
): Promise<{ record: BaseRecord; table: BaseTable; base: Base } | null> {
  const emp = req.mcpEmployee!;
  const co = req.mcpCompany!;
  const record = await AppDataSource.getRepository(BaseRecord).findOneBy({
    id: rowId,
  });
  if (!record) {
    res.status(404).json({ error: "Record not found" });
    return null;
  }
  const table = await AppDataSource.getRepository(BaseTable).findOneBy({
    id: record.tableId,
  });
  if (!table) {
    res.status(404).json({ error: "Table not found" });
    return null;
  }
  const base = await AppDataSource.getRepository(Base).findOneBy({
    id: table.baseId,
    companyId: co.id,
  });
  if (!base) {
    res.status(404).json({ error: "Base not found" });
    return null;
  }
  const ok = await hasBaseGrant(emp.id, base.id);
  if (!ok) {
    res.status(403).json({
      error: `No grant: ${emp.name} does not have access to base "${base.name}". Ask a teammate to grant it in Base settings → AI access.`,
    });
    return null;
  }
  return { record, table, base };
}

const recordRefSchema = z
  .object({
    recordId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_base_record",
  validateBody(recordRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof recordRefSchema>;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const fields = await AppDataSource.getRepository(BaseField).find({
      where: { tableId: found.table.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    const co = req.mcpCompany!;
    const [linkOptions, resourceOptions] = await Promise.all([
      buildLinkOptionsFor(fields, { maxPerTable: MCP_LINK_OPTIONS_PER_TABLE }),
      buildResourceOptionsFor(co.id, fields, {
        maxPerKind: MCP_LINK_OPTIONS_PER_TABLE,
        projectViewer: mcpActorOf(req),
      }),
    ]);
    const [comments, attachments] = await Promise.all([
      AppDataSource.getRepository(BaseRecordComment).find({
        where: { recordId: found.record.id },
        order: { createdAt: "ASC" },
      }),
      AppDataSource.getRepository(BaseRecordAttachment).find({
        where: { recordId: found.record.id },
        order: { createdAt: "ASC" },
      }),
    ]);
    res.json({
      base: { id: found.base.id, slug: found.base.slug, name: found.base.name },
      table: {
        id: found.table.id,
        slug: found.table.slug,
        name: found.table.name,
      },
      record: hydrateRecord(found.record),
      fields: fields.map(hydrateField),
      linkOptions,
      resourceOptions,
      comments: await hydrateRecordComments(co.id, comments),
      attachments: await hydrateRecordAttachments(co.id, attachments),
    });
  },
);

mcpInternalRouter.post(
  "/tools/list_record_comments",
  validateBody(recordRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof recordRefSchema>;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const co = req.mcpCompany!;
    const comments = await AppDataSource.getRepository(BaseRecordComment).find({
      where: { recordId: found.record.id },
      order: { createdAt: "ASC" },
    });
    res.json({ comments: await hydrateRecordComments(co.id, comments) });
  },
);

const createRecordCommentSchema = z
  .object({
    recordId: z.string().uuid(),
    body: z.string().min(1).max(10_000),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_record_comment",
  validateBody(createRecordCommentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createRecordCommentSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordComment);
    const saved = await repo.save(
      repo.create({
        recordId: found.record.id,
        authorUserId: null,
        authorEmployeeId: self.id,
        body: body.body,
      }),
    );
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_comment.create",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: {
        via: "mcp",
        commentId: saved.id,
        baseId: found.base.id,
        tableId: found.table.id,
      },
    });
    await journal(
      self.id,
      `${self.name} commented on ${found.base.name}/${found.table.name}`,
      body.body.length > 240 ? `${body.body.slice(0, 240)}…` : body.body,
    );
    const [hydrated] = await hydrateRecordComments(co.id, [saved]);
    res.json({ comment: hydrated });
  },
);

const deleteRecordCommentSchema = z
  .object({
    recordId: z.string().uuid(),
    commentId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_record_comment",
  validateBody(deleteRecordCommentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteRecordCommentSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordComment);
    const cmt = await repo.findOneBy({
      id: body.commentId,
      recordId: found.record.id,
    });
    if (!cmt) return res.status(404).json({ error: "Comment not found" });
    // AI employees can only delete comments they themselves authored. They
    // shouldn't be able to silence humans on a record.
    if (cmt.authorEmployeeId !== self.id) {
      return res.status(403).json({
        error: "AI employees may only delete their own comments",
      });
    }
    await repo.delete({ id: cmt.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_comment.delete",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: { via: "mcp", commentId: cmt.id },
    });
    res.json({ ok: true });
  },
);

mcpInternalRouter.post(
  "/tools/list_record_attachments",
  validateBody(recordRefSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof recordRefSchema>;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const co = req.mcpCompany!;
    const rows = await AppDataSource.getRepository(BaseRecordAttachment).find({
      where: { recordId: found.record.id },
      order: { createdAt: "ASC" },
    });
    res.json({ attachments: await hydrateRecordAttachments(co.id, rows) });
  },
);

const attachToRecordSchema = z
  .object({
    recordId: z.string().uuid(),
    filename: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(120).optional(),
    contentText: z.string().optional(),
    contentBase64: z.string().optional(),
  })
  .strict()
  .refine(
    (b) => (b.contentText !== undefined) !== (b.contentBase64 !== undefined),
    "Provide exactly one of contentText or contentBase64",
  );

mcpInternalRouter.post(
  "/tools/attach_file_to_record",
  validateBody(attachToRecordSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof attachToRecordSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;

    let bytes: Buffer;
    let mimeType = body.mimeType;
    if (body.contentText !== undefined) {
      bytes = Buffer.from(body.contentText, "utf8");
      if (!mimeType) mimeType = "text/plain; charset=utf-8";
    } else {
      try {
        bytes = Buffer.from(body.contentBase64 ?? "", "base64");
      } catch {
        return res.status(400).json({ error: "Invalid base64" });
      }
      if (!mimeType) mimeType = "application/octet-stream";
    }
    if (bytes.length === 0) {
      return res.status(400).json({ error: "Empty file" });
    }
    if (bytes.length > BASE_ATTACHMENTS_AI_MAX_BYTES) {
      return res.status(413).json({
        error: `Attachment exceeds the ${BASE_ATTACHMENTS_AI_MAX_BYTES / (1024 * 1024)} MB AI upload cap`,
      });
    }

    const row = await recordEmployeeAttachment({
      companyId: co.id,
      companySlug: co.slug,
      recordId: found.record.id,
      filename: body.filename,
      mimeType,
      bytes,
      uploadedByEmployeeId: self.id,
    });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_attachment.create",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: {
        via: "mcp",
        attachmentId: row.id,
        filename: row.filename,
        sizeBytes: Number(row.sizeBytes),
      },
    });
    await journal(
      self.id,
      `${self.name} attached "${body.filename}" to ${found.base.name}/${found.table.name}`,
      `Mime: ${mimeType}, ${bytes.length} bytes.`,
    );
    const [hydrated] = await hydrateRecordAttachments(co.id, [row]);
    res.json({ attachment: hydrated });
  },
);

const readAttachmentSchema = z
  .object({
    recordId: z.string().uuid(),
    attachmentId: z.string().uuid(),
    /** Cap content read into memory. Defaults to 256 KiB. */
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024)
      .optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/read_record_attachment",
  validateBody(readAttachmentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof readAttachmentSchema>;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordAttachment);
    const row = await repo.findOneBy({
      id: body.attachmentId,
      recordId: found.record.id,
    });
    if (!row) return res.status(404).json({ error: "Attachment not found" });
    if (row.companyId !== co.id) {
      return res.status(403).json({ error: "Wrong company" });
    }
    const max = body.maxBytes ?? 256 * 1024;
    const text = await readBaseAttachmentText(row, co.slug, max);
    if (text === null) {
      return res.status(413).json({
        error:
          "Attachment is missing on disk or exceeds the maxBytes cap. Ask a human to download it from the UI for now.",
      });
    }
    res.json({
      attachment: {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
      },
      content: text,
    });
  },
);

const deleteAttachmentSchema = z
  .object({
    recordId: z.string().uuid(),
    attachmentId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_record_attachment",
  validateBody(deleteAttachmentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteAttachmentSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const found = await loadGrantedRecord(req, res, body.recordId);
    if (!found) return;
    const repo = AppDataSource.getRepository(BaseRecordAttachment);
    const row = await repo.findOneBy({
      id: body.attachmentId,
      recordId: found.record.id,
    });
    if (!row) return res.status(404).json({ error: "Attachment not found" });
    // AI may only remove attachments it uploaded itself.
    if (row.uploadedByEmployeeId !== self.id) {
      return res.status(403).json({
        error: "AI employees may only delete attachments they uploaded",
      });
    }
    if (row.companyId !== co.id) {
      return res.status(403).json({ error: "Wrong company" });
    }
    // Resolve to confirm it lives under our root and grab the path before
    // dropping the row, so the bytes go too.
    const resolved = await resolveBaseAttachmentFile(row.id, co.id);
    if (resolved) await deleteBaseAttachmentBytes(resolved.row, co.slug);
    await repo.delete({ id: row.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_record_attachment.delete",
      targetType: "base_record",
      targetId: found.record.id,
      targetLabel: `${found.base.name}/${found.table.name}`,
      metadata: { via: "mcp", attachmentId: row.id },
    });
    res.json({ ok: true });
  },
);

// ----- Base schema writes (create base / table / field) -----

const BASE_COLORS = ["indigo", "emerald", "amber", "rose", "sky", "violet", "slate"] as const;
const FIELD_TYPES_ENUM: [BaseFieldType, ...BaseFieldType[]] = [
  "text",
  "longtext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "email",
  "url",
  "select",
  "multiselect",
  "link",
  "customer",
  "invoice",
  "project",
  "employee",
  "member",
  "note",
  "pipeline",
];

function randOptionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function hydrateBase(b: Base) {
  return {
    id: b.id,
    slug: b.slug,
    name: b.name,
    description: b.description,
    icon: b.icon,
    color: b.color,
  };
}

function hydrateTable(t: BaseTable) {
  return { id: t.id, slug: t.slug, name: t.name, sortOrder: t.sortOrder };
}

const createBaseSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    icon: z.string().max(40).optional(),
    color: z.enum(BASE_COLORS).optional(),
    templateId: z.string().min(1).max(120).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_base",
  validateBody(createBaseSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createBaseSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;

    const template = body.templateId ? findBaseTemplate(body.templateId) : null;
    if (body.templateId && !template) {
      return res.status(400).json({ error: `Unknown template: ${body.templateId}` });
    }

    if (await findBaseByName(co.id, body.name)) {
      return res
        .status(409)
        .json({ error: `A base named "${body.name}" already exists in this company` });
    }

    const slug = await uniqueBaseSlug(co.id, toSlug(body.name));
    const repo = AppDataSource.getRepository(Base);
    const b = await repo.save(
      repo.create({
        companyId: co.id,
        name: body.name,
        slug,
        description: body.description ?? template?.description ?? "",
        icon: body.icon ?? template?.icon ?? "Database",
        color: body.color ?? template?.color ?? "indigo",
        createdById: null,
      }),
    );
    if (template) await seedBaseFromTemplate(b.id, template);

    // Auto-grant the creating employee so the base shows up in list_bases
    // without a second human-driven step.
    await grantBaseAccess(self.id, b.id);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base.create",
      targetType: "base",
      targetId: b.id,
      targetLabel: b.name,
      metadata: { via: "mcp", templateId: template?.id ?? null, autoGranted: true },
    });
    await journal(
      self.id,
      `${self.name} created base "${b.name}"`,
      template
        ? `Seeded from template \`${template.id}\`. Access granted to self.`
        : "Empty base. Access granted to self.",
    );
    res.json({ base: hydrateBase(b) });
  },
);

const createBaseTableSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_base_table",
  validateBody(createBaseTableSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createBaseTableSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;

    if (await findBaseTableByName(b.id, body.name)) {
      return res.status(409).json({
        error: `A table named "${body.name}" already exists in base "${b.name}"`,
      });
    }
    const slug = await uniqueTableSlug(b.id, toSlug(body.name));
    const last = await AppDataSource.getRepository(BaseTable).findOne({
      where: { baseId: b.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await AppDataSource.getRepository(BaseTable).save(
      AppDataSource.getRepository(BaseTable).create({
        baseId: b.id,
        name: body.name,
        slug,
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    const primary = await AppDataSource.getRepository(BaseField).save(
      AppDataSource.getRepository(BaseField).create({
        tableId: saved.id,
        name: "Name",
        type: "text",
        configJson: "{}",
        isPrimary: true,
        sortOrder: 1000,
      }),
    );

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_table.create",
      targetType: "base_table",
      targetId: saved.id,
      targetLabel: `${b.name}/${saved.name}`,
      metadata: { via: "mcp", baseId: b.id },
    });
    await journal(
      self.id,
      `${self.name} added table "${saved.name}" to ${b.name}`,
      "Seeded with a primary `Name` text field.",
    );
    res.json({ table: hydrateTable(saved), primaryField: hydrateField(primary) });
  },
);

const updateBaseTableSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_base_table",
  validateBody(updateBaseTableSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateBaseTableSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const tableRepo = AppDataSource.getRepository(BaseTable);
    const t = await tableRepo.findOneBy({ baseId: b.id, slug: body.tableSlug });
    if (!t) return res.status(404).json({ error: "Table not found" });

    if (await findBaseTableByName(b.id, body.name, t.id)) {
      return res.status(409).json({
        error: `A table named "${body.name}" already exists in base "${b.name}"`,
      });
    }
    const prevName = t.name;
    t.name = body.name;
    await tableRepo.save(t);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_table.update",
      targetType: "base_table",
      targetId: t.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id, prevName },
    });
    res.json({ table: hydrateTable(t) });
  },
);

const deleteBaseTableSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_base_table",
  validateBody(deleteBaseTableSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteBaseTableSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const tableRepo = AppDataSource.getRepository(BaseTable);
    const t = await tableRepo.findOneBy({ baseId: b.id, slug: body.tableSlug });
    if (!t) return res.status(404).json({ error: "Table not found" });

    await AppDataSource.getRepository(BaseRecord).delete({ tableId: t.id });
    await AppDataSource.getRepository(BaseField).delete({ tableId: t.id });
    await tableRepo.delete({ id: t.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_table.delete",
      targetType: "base_table",
      targetId: t.id,
      targetLabel: `${b.name}/${t.name}`,
      metadata: { via: "mcp", baseId: b.id },
    });
    await journal(
      self.id,
      `${self.name} deleted table "${t.name}" from ${b.name}`,
      "All fields and rows removed.",
    );
    res.json({ ok: true });
  },
);

const fieldOptionSchema = z
  .object({
    id: z.string().min(1).max(40).optional(),
    label: z.string().min(1).max(80),
    color: z.enum(BASE_COLORS).optional(),
  })
  .strict();

const addBaseFieldSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    name: z.string().min(1).max(80),
    type: z.enum(FIELD_TYPES_ENUM),
    options: z.array(fieldOptionSchema).max(100).optional(),
    linkTargetTableSlug: z.string().min(1).max(120).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_base_field",
  validateBody(addBaseFieldSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof addBaseFieldSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });

    let config: Record<string, unknown> = {};
    if (body.type === "select" || body.type === "multiselect") {
      const opts = body.options ?? [];
      config = {
        options: opts.map((o) => ({
          id: o.id && o.id.length > 0 ? o.id : randOptionId(),
          label: o.label,
          color: o.color ?? "slate",
        })),
      };
    } else if (body.type === "link") {
      if (!body.linkTargetTableSlug) {
        return res.status(400).json({
          error: "link fields require `linkTargetTableSlug` pointing at a table in the same base",
        });
      }
      const target = await AppDataSource.getRepository(BaseTable).findOneBy({
        baseId: b.id,
        slug: body.linkTargetTableSlug,
      });
      if (!target) {
        return res.status(400).json({
          error: `Link target table not found in base: ${body.linkTargetTableSlug}`,
        });
      }
      config = { targetTableId: target.id };
    }

    const fieldRepo = AppDataSource.getRepository(BaseField);
    const last = await fieldRepo.findOne({
      where: { tableId: t.id },
      order: { sortOrder: "DESC" },
    });
    const saved = await fieldRepo.save(
      fieldRepo.create({
        tableId: t.id,
        name: body.name,
        type: body.type,
        configJson: JSON.stringify(config),
        isPrimary: !!body.isPrimary,
        sortOrder: (last?.sortOrder ?? 0) + 1000,
      }),
    );
    if (body.isPrimary) {
      await fieldRepo
        .createQueryBuilder()
        .update()
        .set({ isPrimary: false })
        .where("tableId = :tid AND id != :sid", { tid: t.id, sid: saved.id })
        .execute();
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_field.create",
      targetType: "base_field",
      targetId: saved.id,
      targetLabel: `${b.name}/${t.name}.${saved.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id, type: saved.type },
    });
    res.json({ field: hydrateField(saved) });
  },
);

const updateBaseFieldSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    fieldId: z.string().uuid(),
    name: z.string().min(1).max(80).optional(),
    isPrimary: z.boolean().optional(),
    options: z.array(fieldOptionSchema).max(100).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_base_field",
  validateBody(updateBaseFieldSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateBaseFieldSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const fieldRepo = AppDataSource.getRepository(BaseField);
    const f = await fieldRepo.findOneBy({ id: body.fieldId, tableId: t.id });
    if (!f) return res.status(404).json({ error: "Field not found" });

    if (body.name !== undefined) f.name = body.name;

    if (body.options !== undefined) {
      if (f.type !== "select" && f.type !== "multiselect") {
        return res.status(400).json({
          error: `options can only be set on select or multiselect fields (this one is ${f.type})`,
        });
      }
      const config: Record<string, unknown> = (() => {
        try {
          return JSON.parse(f.configJson || "{}");
        } catch {
          return {};
        }
      })();
      config.options = body.options.map((o) => ({
        id: o.id && o.id.length > 0 ? o.id : randOptionId(),
        label: o.label,
        color: o.color ?? "slate",
      }));
      f.configJson = JSON.stringify(config);
    }

    if (body.isPrimary === true) {
      f.isPrimary = true;
    }

    await fieldRepo.save(f);
    if (body.isPrimary === true) {
      await fieldRepo
        .createQueryBuilder()
        .update()
        .set({ isPrimary: false })
        .where("tableId = :tid AND id != :fid", { tid: t.id, fid: f.id })
        .execute();
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_field.update",
      targetType: "base_field",
      targetId: f.id,
      targetLabel: `${b.name}/${t.name}.${f.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id, changes: body },
    });
    res.json({ field: hydrateField(f) });
  },
);

const deleteBaseFieldSchema = z
  .object({
    baseSlug: z.string().min(1).max(120),
    tableSlug: z.string().min(1).max(120),
    fieldId: z.string().uuid(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_base_field",
  validateBody(deleteBaseFieldSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteBaseFieldSchema>;
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const b = await loadGrantedBase(req, res, body.baseSlug);
    if (!b) return;
    const t = await AppDataSource.getRepository(BaseTable).findOneBy({
      baseId: b.id,
      slug: body.tableSlug,
    });
    if (!t) return res.status(404).json({ error: "Table not found" });
    const fieldRepo = AppDataSource.getRepository(BaseField);
    const f = await fieldRepo.findOneBy({ id: body.fieldId, tableId: t.id });
    if (!f) return res.status(404).json({ error: "Field not found" });
    if (f.isPrimary) {
      return res.status(400).json({
        error: "Promote another field to primary via update_base_field before deleting this one",
      });
    }

    await fieldRepo.delete({ id: f.id });
    // Strip this field id from every row's dataJson so row payloads stay clean.
    const recordRepo = AppDataSource.getRepository(BaseRecord);
    const rows = await recordRepo.find({ where: { tableId: t.id } });
    for (const r of rows) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(r.dataJson || "{}");
      } catch {
        continue;
      }
      if (f.id in data) {
        delete data[f.id];
        r.dataJson = JSON.stringify(data);
        await recordRepo.save(r);
      }
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "base_field.delete",
      targetType: "base_field",
      targetId: f.id,
      targetLabel: `${b.name}/${t.name}.${f.name}`,
      metadata: { via: "mcp", baseId: b.id, tableId: t.id },
    });
    res.json({ ok: true });
  },
);

// ----- Integrations (dynamic tools per employee Grant) -----

/**
 * Return the integration-backed tools available to the calling employee.
 * Called by the MCP stdio binary on its first `tools/list` so the AI can
 * see one tool per (granted connection × provider tool it offers).
 *
 * Tool names are prefixed:
 *   - single connection for that provider → `<provider>_<tool>`
 *     (e.g. `stripe_list_customers`)
 *   - multiple connections → `<provider>_<connSlug>_<tool>`
 *     (e.g. `stripe_us_list_customers`, `stripe_eu_list_customers`)
 */
mcpInternalRouter.post("/integrations/_list", async (req: McpRequest, res) => {
  const emp = req.mcpEmployee!;
  const items = await loadEmployeeConnections(emp);

  // Group by provider so we know when to disambiguate by connection.
  const byProvider = new Map<string, typeof items>();
  for (const it of items) {
    const arr = byProvider.get(it.connection.provider) ?? [];
    arr.push(it);
    byProvider.set(it.connection.provider, arr);
  }

  const out: Array<{
    name: string;
    description: string;
    inputSchema: unknown;
    connectionId: string;
    providerToolName: string;
  }> = [];

  for (const [providerId, group] of byProvider) {
    const provider = getProvider(providerId);
    if (!provider) continue;
    const disambiguate = group.length > 1;
    for (const { connection } of group) {
      const connSlug = toolNameSegment(connection.label || connection.id);
      const prefix = disambiguate ? `${providerId}_${connSlug}` : providerId;
      for (const tool of provider.tools) {
        const name = `${prefix}_${tool.name}`;
        out.push({
          name,
          description: integrationToolDescription(
            provider.catalog.name,
            connection.label,
            tool.description,
          ),
          inputSchema: tool.inputSchema,
          connectionId: connection.id,
          providerToolName: tool.name,
        });
      }
    }
  }

  res.json({ tools: out });
});

const invokeToolSchema = z
  .object({
    connectionId: z.string().uuid(),
    toolName: z.string().min(1).max(80),
    args: z.record(z.unknown()).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/integrations/invoke",
  validateBody(invokeToolSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof invokeToolSchema>;
    const emp = req.mcpEmployee!;
    const co = req.mcpCompany!;

    // Pre-read the connection so we can stamp provider + label onto the
    // audit row even when the invocation throws. The authoritative grant
    // check still lives inside `invokeConnectionTool`.
    const pair = await getGrantWithConnection(emp.id, body.connectionId);
    const connection = pair?.connection ?? null;

    const startedAt = Date.now();
    const args = body.args ?? {};
    try {
      const result = await invokeConnectionTool({
        employee: emp,
        connectionId: body.connectionId,
        toolName: body.toolName,
        toolArgs: args,
      });
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: emp.id,
        action: "integration.invoke",
        targetType: "connection",
        targetId: body.connectionId,
        targetLabel: connection?.label ? `${connection.label} · ${body.toolName}` : body.toolName,
        metadata: {
          via: "mcp",
          provider: connection?.provider ?? null,
          connectionId: body.connectionId,
          connectionLabel: connection?.label ?? null,
          toolName: body.toolName,
          status: "ok",
          durationMs: Date.now() - startedAt,
          argsPreview: previewForAudit(args),
          resultPreview: previewForAudit(result),
        },
      });
      res.json({ result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: emp.id,
        action: "integration.invoke",
        targetType: "connection",
        targetId: body.connectionId,
        targetLabel: connection?.label ? `${connection.label} · ${body.toolName}` : body.toolName,
        metadata: {
          via: "mcp",
          provider: connection?.provider ?? null,
          connectionId: body.connectionId,
          connectionLabel: connection?.label ?? null,
          toolName: body.toolName,
          status: "error",
          durationMs: Date.now() - startedAt,
          argsPreview: previewForAudit(args),
          error: message,
        },
      });
      res.status(400).json({ error: message });
    }
  },
);

/**
 * Cap a payload stored in the audit log. Tool results (especially Metabase
 * dashboards, NocoDB rows) can be large — we want enough to make the "view
 * logs" modal useful but not so much that the audit row balloons. 20 KB of
 * pretty JSON is roughly 400 lines, which is plenty for humans to skim.
 */
function previewForAudit(value: unknown, capBytes = 20_000): string {
  let str: string;
  if (typeof value === "string") {
    str = value;
  } else {
    try {
      str = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      str = String(value);
    }
  }
  if (str.length <= capBytes) return str;
  return str.slice(0, capBytes) + `\n…[truncated, ${str.length.toLocaleString()} chars total]`;
}

/**
 * Sanitize a connection label for use in an MCP tool name. MCP tool names
 * live in the same namespace as function names on most hosts — letters,
 * digits, underscores only. We lowercase, replace non-alphanum with `_`,
 * collapse repeats, and trim.
 */
function toolNameSegment(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "conn";
}

function integrationToolDescription(
  providerName: string,
  connectionLabel: string,
  inner: string,
): string {
  return `[${providerName} · ${connectionLabel}] ${inner}`;
}

// ─────────────────── Workspace channels (AI-admin) ──────────────────────

const listChannelsSchema = z.object({}).strict();
mcpInternalRouter.post(
  "/tools/list_workspace_channels",
  validateBody(listChannelsSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const channels = await listChannelsForEmployee(co.id, self.id);
    res.json({ channels });
  },
);

const createChannelMcpSchema = z
  .object({
    name: z.string().min(1).max(80),
    topic: z.string().max(280).optional(),
    kind: z.enum(["public", "private"]).optional(),
  })
  .strict();
mcpInternalRouter.post(
  "/tools/create_workspace_channel",
  validateBody(createChannelMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createChannelMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    try {
      const channel = await createChannel({
        companyId: co.id,
        name: body.name,
        topic: body.topic ?? "",
        kind: body.kind ?? "public",
        // Credit the creator as the company's owner rather than a fake
        // userId. Falls back to null if the company has no owner row.
        createdByUserId: await companyOwnerId(co.id),
        initialMemberUserIds: [],
        initialEmployeeIds: [self.id],
      });
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: self.id,
        action: "channel.create",
        targetType: "channel",
        targetId: channel.id,
        targetLabel: channel.name ?? channel.slug ?? "channel",
        metadata: { via: "mcp", kind: channel.kind },
      });
      await journal(
        self.id,
        `${self.name} created channel #${channel.slug}`,
        `Kind: ${channel.kind}. Topic: ${channel.topic || "(none)"}.`,
      );
      res.json({
        channel: {
          id: channel.id,
          name: channel.name,
          slug: channel.slug,
          kind: channel.kind,
          topic: channel.topic,
        },
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Create failed" });
    }
  },
);

const renameChannelMcpSchema = z
  .object({
    channel: z.string().min(1).max(120),
    name: z.string().min(1).max(80).optional(),
    topic: z.string().max(280).optional(),
  })
  .strict();
mcpInternalRouter.post(
  "/tools/rename_workspace_channel",
  validateBody(renameChannelMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof renameChannelMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const ch = await findChannelBySlugOrId(co.id, body.channel);
    if (!ch) return res.status(404).json({ error: "Channel not found" });
    if (body.name === undefined && body.topic === undefined) {
      return res.status(400).json({ error: "Pass at least one of `name` or `topic`." });
    }
    try {
      const updated = await renameChannel({
        channelId: ch.id,
        name: body.name,
        topic: body.topic,
      });
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: self.id,
        action: "channel.rename",
        targetType: "channel",
        targetId: updated.id,
        targetLabel: updated.name ?? updated.slug ?? "channel",
        metadata: {
          via: "mcp",
          previousSlug: ch.slug,
          nextSlug: updated.slug,
        },
      });
      await journal(
        self.id,
        `${self.name} renamed channel #${ch.slug} → #${updated.slug}`,
        body.topic !== undefined ? `Topic: ${body.topic}` : "",
      );
      res.json({
        channel: {
          id: updated.id,
          name: updated.name,
          slug: updated.slug,
          kind: updated.kind,
          topic: updated.topic,
        },
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Rename failed" });
    }
  },
);

const archiveChannelMcpSchema = z
  .object({
    channel: z.string().min(1).max(120),
  })
  .strict();
mcpInternalRouter.post(
  "/tools/archive_workspace_channel",
  validateBody(archiveChannelMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof archiveChannelMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const ch = await findChannelBySlugOrId(co.id, body.channel);
    if (!ch) return res.status(404).json({ error: "Channel not found" });
    if (ch.kind === "dm") {
      return res.status(400).json({ error: "DMs cannot be archived via MCP." });
    }
    await archiveChannel(ch.id);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "channel.archive",
      targetType: "channel",
      targetId: ch.id,
      targetLabel: ch.name ?? ch.slug ?? "channel",
      metadata: { via: "mcp" },
    });
    await journal(
      self.id,
      `${self.name} archived channel #${ch.slug}`,
      "Via the built-in MCP tool.",
    );
    res.json({ ok: true });
  },
);

// ─────────────────── Workspace messages (AI ↔ AI / AI → human) ──────────

const sendWorkspaceMessageSchema = z
  .object({
    channel: z.string().min(1).max(120).optional(),
    dmEmployee: z.string().min(1).max(120).optional(),
    dmUser: z.string().uuid().optional(),
    content: z.string().min(1).max(16_000),
    parentMessageId: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.channel, v.dmEmployee, v.dmUser].filter((x) => typeof x === "string" && x.length > 0)
        .length === 1,
    {
      message: "Specify exactly one of: channel, dmEmployee, dmUser.",
    },
  );

mcpInternalRouter.post(
  "/tools/send_workspace_message",
  validateBody(sendWorkspaceMessageSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof sendWorkspaceMessageSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;

    let channel: Channel;
    let auditTarget: { type: string; id: string; label: string };
    let journalTitle: string;

    if (body.channel) {
      const ch = await findChannelBySlugOrId(co.id, body.channel);
      if (!ch) return res.status(404).json({ error: "Channel not found" });
      if (ch.archivedAt) {
        return res.status(400).json({ error: "Channel is archived" });
      }
      if (ch.kind === "dm") {
        return res.status(400).json({
          error: "That is a DM channel; pass `dmEmployee` or `dmUser` instead of `channel`.",
        });
      }
      // Auto-join public channels (mirrors the @mention auto-join in chat).
      // Private channels require an explicit grant — refuse to broadcast
      // into a room the AI was never invited to.
      const memberRepo = AppDataSource.getRepository(ChannelMember);
      const existing = await memberRepo.findOneBy({
        channelId: ch.id,
        memberKind: "ai",
        employeeId: self.id,
      });
      if (!existing) {
        if (ch.kind === "private") {
          return res.status(403).json({
            error: "Not a member of this private channel.",
          });
        }
        await memberRepo.save(
          memberRepo.create({
            channelId: ch.id,
            memberKind: "ai",
            userId: null,
            employeeId: self.id,
            lastReadAt: null,
          }),
        );
      }
      channel = ch;
      auditTarget = {
        type: "channel",
        id: ch.id,
        label: ch.name ?? ch.slug ?? "channel",
      };
      journalTitle = `${self.name} posted in #${ch.slug ?? "channel"}`;
    } else if (body.dmEmployee) {
      const empRepo = AppDataSource.getRepository(AIEmployee);
      const target =
        (await empRepo.findOneBy({
          id: body.dmEmployee,
          companyId: co.id,
        })) ??
        (await empRepo.findOneBy({
          slug: body.dmEmployee.toLowerCase(),
          companyId: co.id,
        }));
      if (!target) {
        return res.status(404).json({ error: "Employee not found" });
      }
      if (target.id === self.id) {
        return res.status(400).json({ error: "Cannot DM yourself" });
      }
      channel = await findOrCreateDM({
        companyId: co.id,
        from: { kind: "ai", employeeId: self.id },
        target: { kind: "ai", employeeId: target.id },
      });
      auditTarget = {
        type: "channel",
        id: channel.id,
        label: `DM with ${target.name}`,
      };
      journalTitle = `${self.name} DM'd ${target.name}`;
    } else if (body.dmUser) {
      // Human Member of the same company. Cross-company DMs are refused.
      const member = await AppDataSource.getRepository(Membership).findOneBy({
        companyId: co.id,
        userId: body.dmUser,
      });
      if (!member) {
        return res.status(404).json({ error: "User not found" });
      }
      const user = await AppDataSource.getRepository(User).findOneBy({
        id: body.dmUser,
      });
      if (!user) return res.status(404).json({ error: "User not found" });
      channel = await findOrCreateDM({
        companyId: co.id,
        from: { kind: "ai", employeeId: self.id },
        target: { kind: "user", userId: user.id },
      });
      auditTarget = {
        type: "channel",
        id: channel.id,
        label: `DM with ${user.name || user.email}`,
      };
      journalTitle = `${self.name} DM'd ${user.name || user.email}`;
    } else {
      return res.status(400).json({ error: "No target specified" });
    }

    let summary;
    try {
      summary = await postMessage({
        channelId: channel.id,
        companyId: co.id,
        author: { kind: "ai", employeeId: self.id },
        content: body.content,
        parentMessageId: body.parentMessageId ?? null,
      });
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : "Send failed",
      });
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "channel_message.create",
      targetType: auditTarget.type,
      targetId: auditTarget.id,
      targetLabel: auditTarget.label,
      metadata: {
        via: "mcp",
        messageId: summary.id,
        channelKind: channel.kind,
      },
    });
    await journal(
      self.id,
      journalTitle,
      body.content.length > 240 ? `${body.content.slice(0, 240)}…` : body.content,
    );

    res.json({
      message: summary,
      channel: {
        id: channel.id,
        kind: channel.kind,
        slug: channel.slug,
        name: channel.name,
      },
    });
  },
);

// ─────────────────── Org chart (Teams + reporting line) ────────────────

const listTeamsSchema = z.object({}).strict();
mcpInternalRouter.post(
  "/tools/list_teams",
  validateBody(listTeamsSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const teams = await AppDataSource.getRepository(Team).find({
      where: { companyId: co.id },
      order: { name: "ASC" },
    });
    const empRepo = AppDataSource.getRepository(AIEmployee);
    const out = [];
    for (const t of teams) {
      if (t.archivedAt) continue;
      const members = await empRepo.find({
        where: { teamId: t.id, companyId: co.id },
        order: { name: "ASC" },
      });
      out.push({
        id: t.id,
        slug: t.slug,
        name: t.name,
        description: t.description,
        members: members.map((e) => ({
          id: e.id,
          slug: e.slug,
          name: e.name,
          role: e.role,
        })),
      });
    }
    res.json({ teams: out });
  },
);

// ─────────────────── Handoffs (AI → AI delegation) ──────────────────────

async function findEmployeeBySlugOrId(
  companyId: string,
  idOrSlug: string,
): Promise<AIEmployee | null> {
  const repo = AppDataSource.getRepository(AIEmployee);
  const byId = await repo.findOneBy({ id: idOrSlug, companyId });
  if (byId) return byId;
  return repo.findOneBy({ companyId, slug: idOrSlug.toLowerCase() });
}

function serializeHandoff(h: Handoff) {
  return {
    id: h.id,
    fromEmployeeId: h.fromEmployeeId,
    toEmployeeId: h.toEmployeeId,
    title: h.title,
    body: h.body,
    status: h.status,
    resolutionNote: h.resolutionNote,
    dueAt: h.dueAt?.toISOString() ?? null,
    completedAt: h.completedAt?.toISOString() ?? null,
    createdAt: h.createdAt.toISOString(),
    updatedAt: h.updatedAt.toISOString(),
  };
}

const listHandoffsSchema = z
  .object({
    direction: z.enum(["incoming", "outgoing", "any"]).optional(),
    status: z.enum(["pending", "completed", "declined", "cancelled"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_handoffs",
  validateBody(listHandoffsSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listHandoffsSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const direction = body.direction ?? "incoming";
    const qb = AppDataSource.getRepository(Handoff)
      .createQueryBuilder("h")
      .where("h.companyId = :cid", { cid: co.id });
    if (direction === "incoming") {
      qb.andWhere("h.toEmployeeId = :eid", { eid: self.id });
    } else if (direction === "outgoing") {
      qb.andWhere("h.fromEmployeeId = :eid", { eid: self.id });
    } else {
      qb.andWhere("(h.toEmployeeId = :eid OR h.fromEmployeeId = :eid)", { eid: self.id });
    }
    if (body.status) qb.andWhere("h.status = :status", { status: body.status });
    qb.orderBy("h.createdAt", "DESC").take(body.limit ?? 50);
    const rows = await qb.getMany();
    res.json({ handoffs: rows.map(serializeHandoff) });
  },
);

const createHandoffSchema = z
  .object({
    toEmployee: z.string().min(1).max(120).optional(),
    toManager: z.boolean().optional(),
    title: z.string().min(1).max(160),
    body: z.string().max(20_000).optional(),
    dueAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.toEmployee) !== Boolean(v.toManager), {
    message: "Specify exactly one of `toEmployee` (slug/UUID) or `toManager: true`.",
  });

mcpInternalRouter.post(
  "/tools/create_handoff",
  validateBody(createHandoffSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createHandoffSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    let target: AIEmployee | null = null;
    if (body.toManager) {
      if (!self.reportsToEmployeeId) {
        return res.status(400).json({
          error:
            "You don't have a manager set. Ask a human to wire up your reporting line, or pass `toEmployee` instead.",
        });
      }
      target = await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: self.reportsToEmployeeId,
        companyId: co.id,
      });
      if (!target) {
        return res.status(400).json({ error: "Manager record is stale; ask a human to fix it." });
      }
    } else if (body.toEmployee) {
      target = await findEmployeeBySlugOrId(co.id, body.toEmployee);
      if (!target) {
        return res.status(404).json({ error: "Employee not found" });
      }
    }
    if (!target) {
      return res.status(400).json({ error: "No target resolved" });
    }
    if (target.id === self.id) {
      return res.status(400).json({ error: "Cannot hand off to yourself" });
    }
    const repo = AppDataSource.getRepository(Handoff);
    const h = repo.create({
      companyId: co.id,
      fromEmployeeId: self.id,
      toEmployeeId: target.id,
      title: body.title.trim(),
      body: body.body ?? "",
      status: "pending",
      resolutionNote: null,
      dueAt: body.dueAt ? new Date(body.dueAt) : null,
      completedAt: null,
    });
    await repo.save(h);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "handoff.create",
      targetType: "handoff",
      targetId: h.id,
      targetLabel: h.title,
      metadata: {
        via: "mcp",
        fromEmployeeId: self.id,
        toEmployeeId: target.id,
      },
    });
    await journal(
      self.id,
      `Handed off "${h.title}" to ${target.name}`,
      h.body.length > 240 ? `${h.body.slice(0, 240)}…` : h.body,
    );
    await journal(
      target.id,
      `Received handoff "${h.title}" from ${self.name}`,
      h.body.length > 240 ? `${h.body.slice(0, 240)}…` : h.body,
    );
    res.json({ handoff: serializeHandoff(h) });
  },
);

const transitionHandoffSchema = z
  .object({
    handoffId: z.string().uuid(),
    resolutionNote: z.string().max(20_000).optional(),
  })
  .strict();

async function applyMcpTransition(
  req: McpRequest,
  res: import("express").Response,
  next: HandoffStatus,
  expectedActor: "from" | "to",
): Promise<void> {
  const body = req.body as z.infer<typeof transitionHandoffSchema>;
  const co = req.mcpCompany!;
  const self = req.mcpEmployee!;
  const repo = AppDataSource.getRepository(Handoff);
  const h = await repo.findOneBy({ id: body.handoffId, companyId: co.id });
  if (!h) {
    res.status(404).json({ error: "Handoff not found" });
    return;
  }
  if (h.status !== "pending") {
    res.status(400).json({
      error: `Handoff is already ${h.status}; only pending handoffs can transition.`,
    });
    return;
  }
  const allowedActorId = expectedActor === "to" ? h.toEmployeeId : h.fromEmployeeId;
  if (allowedActorId !== self.id) {
    res.status(403).json({
      error:
        expectedActor === "to"
          ? "Only the receiver can complete or decline a handoff."
          : "Only the sender can cancel a handoff.",
    });
    return;
  }
  h.status = next;
  h.resolutionNote = body.resolutionNote ?? null;
  h.completedAt = next === "completed" ? new Date() : null;
  await repo.save(h);
  await recordAudit({
    companyId: co.id,
    actorEmployeeId: self.id,
    action: `handoff.${next}`,
    targetType: "handoff",
    targetId: h.id,
    targetLabel: h.title,
    metadata: { via: "mcp" },
  });
  const verb = next === "completed" ? "completed" : next === "declined" ? "declined" : "cancelled";
  await journal(h.fromEmployeeId, `Handoff "${h.title}" ${verb}`, body.resolutionNote ?? "");
  await journal(h.toEmployeeId, `Handoff "${h.title}" ${verb}`, body.resolutionNote ?? "");
  res.json({ handoff: serializeHandoff(h) });
}

mcpInternalRouter.post(
  "/tools/complete_handoff",
  validateBody(transitionHandoffSchema),
  async (req: McpRequest, res) => {
    await applyMcpTransition(req, res, "completed", "to");
  },
);

mcpInternalRouter.post(
  "/tools/decline_handoff",
  validateBody(transitionHandoffSchema),
  async (req: McpRequest, res) => {
    await applyMcpTransition(req, res, "declined", "to");
  },
);

mcpInternalRouter.post(
  "/tools/cancel_handoff",
  validateBody(transitionHandoffSchema),
  async (req: McpRequest, res) => {
    await applyMcpTransition(req, res, "cancelled", "from");
  },
);

// ----- Notes (Notion-style company-wide knowledge base) -----

function serializeNote(n: Note) {
  return {
    id: n.id,
    slug: n.slug,
    title: n.title,
    body: n.body,
    icon: n.icon,
    notebookId: n.notebookId,
    parentId: n.parentId,
    archived: n.archivedAt !== null,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

function serializeNotebook(nb: Notebook) {
  return {
    id: nb.id,
    slug: nb.slug,
    title: nb.title,
    icon: nb.icon,
    sortOrder: nb.sortOrder,
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
  };
}

async function uniqueNoteSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Note);
  let slug = base || "note";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

const listNotesSchema = z
  .object({
    notebookSlug: z.string().min(1).max(80).optional(),
    parentSlug: z.string().min(1).max(160).optional(),
    includeArchived: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/list_notes",
  validateBody(listNotesSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof listNotesSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    let notebookId: string | undefined;
    if (body.notebookSlug) {
      const nb = await AppDataSource.getRepository(Notebook).findOneBy({
        companyId: co.id,
        slug: body.notebookSlug,
      });
      if (!nb) return res.status(404).json({ error: "Notebook not found" });
      notebookId = nb.id;
    }

    let parentId: string | null | undefined = undefined;
    if (body.parentSlug) {
      const parent = await repo.findOneBy({ companyId: co.id, slug: body.parentSlug });
      if (!parent) return res.status(404).json({ error: "Parent note not found" });
      // The employee can only inspect children of a parent they can see.
      if (!(await hasNoteAccess(self.id, parent.id, "read"))) {
        return res.status(403).json({ error: "No access to that note" });
      }
      parentId = parent.id;
    }

    const accessible = await listAccessibleNoteIds(co.id, self.id);
    if (accessible.size === 0) return res.json({ notes: [] });

    const where: Record<string, unknown> = {
      companyId: co.id,
      id: In([...accessible]),
    };
    if (notebookId !== undefined) where.notebookId = notebookId;
    if (parentId !== undefined) where.parentId = parentId;
    if (!body.includeArchived) where.archivedAt = IsNull();
    const notes = await repo.find({
      where,
      order: { sortOrder: "ASC", updatedAt: "DESC" },
    });
    res.json({ notes: notes.map(serializeNote) });
  },
);

const listNotebooksSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_notebooks",
  validateBody(listNotebooksSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    // Filter to notebooks the employee has any access to: either a direct
    // notebook grant, or a note grant somewhere inside the notebook.
    const accessible = await listAccessibleNoteIds(co.id, self.id);
    const rows = await AppDataSource.getRepository(Notebook).find({
      where: { companyId: co.id },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
    if (accessible.size === 0) return res.json({ notebooks: [] });
    const accessibleNotebookIds = new Set<string>();
    if (accessible.size > 0) {
      const allNotes = await AppDataSource.getRepository(Note).find({
        where: { companyId: co.id, id: In([...accessible]) },
        select: ["notebookId"],
      });
      for (const n of allNotes) accessibleNotebookIds.add(n.notebookId);
    }
    res.json({
      notebooks: rows.filter((nb) => accessibleNotebookIds.has(nb.id)).map(serializeNotebook),
    });
  },
);

const searchNotesSchema = z
  .object({
    query: z.string().min(1).max(200),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/search_notes",
  validateBody(searchNotesSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof searchNotesSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleNoteIds(co.id, self.id);
    if (accessible.size === 0) return res.json({ notes: [] });

    const term = `%${body.query.replace(/[%_]/g, (c) => "\\" + c)}%`;
    const rows = await AppDataSource.getRepository(Note)
      .createQueryBuilder("n")
      .where("n.companyId = :cid", { cid: co.id })
      .andWhere("n.archivedAt IS NULL")
      .andWhere("n.id IN (:...ids)", { ids: [...accessible] })
      .andWhere("(n.title LIKE :term ESCAPE '\\' OR n.body LIKE :term ESCAPE '\\')", { term })
      .orderBy("n.updatedAt", "DESC")
      .limit(50)
      .getMany();
    res.json({ notes: rows.map(serializeNote) });
  },
);

const getNoteSchema = z
  .object({
    noteSlug: z.string().min(1).max(160),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_note",
  validateBody(getNoteSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof getNoteSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const note = await AppDataSource.getRepository(Note).findOneBy({
      companyId: co.id,
      slug: body.noteSlug,
    });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!(await hasNoteAccess(self.id, note.id, "read"))) {
      return res.status(403).json({ error: "No access to that note" });
    }
    res.json({ note: serializeNote(note) });
  },
);

const createNoteMcpSchema = z
  .object({
    title: z.string().min(1).max(200),
    body: z.string().max(200_000).optional(),
    icon: z.string().max(40).optional(),
    notebookSlug: z.string().min(1).max(80).optional(),
    parentSlug: z.string().min(1).max(160).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_note",
  validateBody(createNoteMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createNoteMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    let parentId: string | null = null;
    let parentNotebookId: string | null = null;
    if (body.parentSlug) {
      const parent = await repo.findOneBy({
        companyId: co.id,
        slug: body.parentSlug,
      });
      if (!parent) return res.status(400).json({ error: "Unknown parent note" });
      // Creating a child requires write on the parent — the new note will
      // inherit that access via the cascade so we don't add a fresh grant.
      if (!(await hasNoteAccess(self.id, parent.id, "write"))) {
        return res.status(403).json({ error: "Need write access on the parent note" });
      }
      parentId = parent.id;
      parentNotebookId = parent.notebookId;
    }

    let notebookId: string;
    if (body.notebookSlug) {
      const nb = await AppDataSource.getRepository(Notebook).findOneBy({
        companyId: co.id,
        slug: body.notebookSlug,
      });
      if (!nb) return res.status(400).json({ error: "Unknown notebook" });
      if (parentNotebookId && nb.id !== parentNotebookId) {
        return res.status(400).json({
          error: "Sub-pages must live in the same notebook as their parent",
        });
      }
      notebookId = nb.id;
    } else if (parentNotebookId) {
      notebookId = parentNotebookId;
    } else {
      const nb = await ensureDefaultNotebook(co.id, null);
      notebookId = nb.id;
    }

    const slug = await uniqueNoteSlug(co.id, toSlug(body.title));
    const siblings = await repo.find({
      where: {
        companyId: co.id,
        notebookId,
        parentId: parentId ?? IsNull(),
      },
      order: { sortOrder: "DESC" },
      take: 1,
    });
    const sortOrder = (siblings[0]?.sortOrder ?? 0) + 1000;

    const note = repo.create({
      companyId: co.id,
      notebookId,
      title: body.title,
      slug,
      body: body.body ?? "",
      icon: body.icon ?? "",
      parentId,
      sortOrder,
      createdById: null,
      createdByEmployeeId: self.id,
      lastEditedById: null,
      lastEditedByEmployeeId: self.id,
      archivedAt: null,
    });
    await repo.save(note);

    // Top-level notes have no ancestor chain to inherit access from, so the
    // creating AI gets an explicit write grant on its own page. Without
    // this it would lose visibility on the page it just authored.
    if (!parentId) {
      await upsertNoteGrant(self.id, note.id, "write");
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "note.create",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: { via: "mcp", parentId },
    });
    await journal(
      self.id,
      `${self.name} created note "${note.title}"`,
      `Slug: \`${note.slug}\`. Created via the built-in MCP tool.`,
    );

    res.json({ note: serializeNote(note) });
  },
);

const updateNoteMcpSchema = z
  .object({
    noteSlug: z.string().min(1).max(160),
    title: z.string().min(1).max(200).optional(),
    body: z.string().max(200_000).optional(),
    icon: z.string().max(40).optional(),
    parentSlug: z.string().min(1).max(160).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_note",
  validateBody(updateNoteMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateNoteMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    const note = await repo.findOneBy({ companyId: co.id, slug: body.noteSlug });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!(await hasNoteAccess(self.id, note.id, "write"))) {
      return res.status(403).json({ error: "No write access on that note" });
    }

    if (body.parentSlug !== undefined) {
      if (body.parentSlug === null) {
        note.parentId = null;
      } else {
        const parent = await repo.findOneBy({
          companyId: co.id,
          slug: body.parentSlug,
        });
        if (!parent) return res.status(400).json({ error: "Unknown parent note" });
        if (parent.id === note.id) {
          return res.status(400).json({ error: "A note cannot be its own parent" });
        }
        if (await isNoteDescendant(co.id, parent.id, note.id)) {
          return res
            .status(400)
            .json({ error: "Cannot move a note under one of its own descendants" });
        }
        note.parentId = parent.id;
      }
    }

    if (body.title !== undefined) note.title = body.title;
    if (body.body !== undefined) note.body = body.body;
    if (body.icon !== undefined) note.icon = body.icon;
    if (body.archived !== undefined) {
      note.archivedAt = body.archived ? new Date() : null;
    }
    note.lastEditedById = null;
    note.lastEditedByEmployeeId = self.id;
    await repo.save(note);

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "note.update",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: {
        via: "mcp",
        archived: note.archivedAt !== null,
      },
    });
    await journal(
      self.id,
      `${self.name} updated note "${note.title}"`,
      "Via the built-in MCP tool.",
    );

    res.json({ note: serializeNote(note) });
  },
);

const deleteNoteSchema = z
  .object({
    noteSlug: z.string().min(1).max(160),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_note",
  validateBody(deleteNoteSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteNoteSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Note);

    const note = await repo.findOneBy({ companyId: co.id, slug: body.noteSlug });
    if (!note) return res.status(404).json({ error: "Note not found" });
    if (!(await hasNoteAccess(self.id, note.id, "write"))) {
      return res.status(403).json({ error: "No write access on that note" });
    }

    await repo.update({ companyId: co.id, parentId: note.id }, { parentId: note.parentId });
    await AppDataSource.getRepository(EmployeeNoteGrant).delete({ noteId: note.id });
    await repo.delete({ id: note.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "note.delete",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: { via: "mcp" },
    });
    await journal(
      self.id,
      `${self.name} deleted note "${note.title}"`,
      "Permanent delete via the built-in MCP tool.",
    );

    res.json({ ok: true });
  },
);

/**
 * Walk children breadth-first to detect parent-cycles before re-parenting.
 */
async function isNoteDescendant(
  companyId: string,
  rootId: string,
  descendantId: string,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(Note);
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === descendantId) return true;
    const children = await repo.find({
      where: { companyId, parentId: id },
      select: ["id"],
    });
    for (const c of children) queue.push(c.id);
  }
  return false;
}

function serializeResource(r: Resource, opts: { includeBody?: boolean } = {}) {
  const tagList = r.tags
    ? r.tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
  const out: Record<string, unknown> = {
    id: r.id,
    title: r.title,
    slug: r.slug,
    sourceKind: r.sourceKind,
    sourceUrl: r.sourceUrl,
    sourceFilename: r.sourceFilename,
    summary: r.summary,
    tags: tagList,
    bodyLength: r.bodyText?.length ?? 0,
    bytes: Number(r.bytes),
    status: r.status,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
  if (opts.includeBody) out.bodyText = r.bodyText;
  return out;
}

const listResourcesSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_resources",
  validateBody(listResourcesSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleResourceIds(self.id);
    if (accessible.size === 0) return res.json({ resources: [] });
    const rows = await AppDataSource.getRepository(Resource).find({
      where: { companyId: co.id, id: In([...accessible]) },
      order: { updatedAt: "DESC" },
    });
    res.json({ resources: rows.map((r) => serializeResource(r)) });
  },
);

const searchResourcesSchema = z
  .object({
    query: z.string().min(1).max(200),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/search_resources",
  validateBody(searchResourcesSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof searchResourcesSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleResourceIds(self.id);
    if (accessible.size === 0) return res.json({ resources: [] });

    const term = `%${body.query.replace(/[%_]/g, (c) => "\\" + c)}%`;
    const rows = await AppDataSource.getRepository(Resource)
      .createQueryBuilder("r")
      .where("r.companyId = :cid", { cid: co.id })
      .andWhere("r.id IN (:...ids)", { ids: [...accessible] })
      .andWhere(
        "(r.title LIKE :term ESCAPE '\\' OR r.summary LIKE :term ESCAPE '\\' OR r.tags LIKE :term ESCAPE '\\' OR r.bodyText LIKE :term ESCAPE '\\')",
        { term },
      )
      .orderBy("r.updatedAt", "DESC")
      .limit(50)
      .getMany();
    res.json({ resources: rows.map((r) => serializeResource(r)) });
  },
);

const getResourceSchema = z
  .object({
    resourceSlug: z.string().min(1).max(160),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/get_resource",
  validateBody(getResourceSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof getResourceSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const row = await AppDataSource.getRepository(Resource).findOneBy({
      companyId: co.id,
      slug: body.resourceSlug,
    });
    if (!row) return res.status(404).json({ error: "Resource not found" });
    if (!(await hasResourceAccess(self.id, row.id, "read"))) {
      return res.status(403).json({ error: "No access to that resource" });
    }
    res.json({ resource: serializeResource(row, { includeBody: true }) });
  },
);

const exportResourceSchema = z
  .object({
    resourceSlug: z.string().min(1).max(160),
    format: z.enum(EXPORT_FORMATS as [string, ...string[]]),
  })
  .strict();

const EXPORT_RESOURCE_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB cap on the base64 round-trip

mcpInternalRouter.post(
  "/tools/export_resource",
  validateBody(exportResourceSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof exportResourceSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    if (!isExportFormat(body.format)) {
      return res.status(400).json({
        error: `Unsupported format. Use one of: ${EXPORT_FORMATS.join(", ")}.`,
      });
    }
    const row = await AppDataSource.getRepository(Resource).findOneBy({
      companyId: co.id,
      slug: body.resourceSlug,
    });
    if (!row) return res.status(404).json({ error: "Resource not found" });
    if (!(await hasResourceAccess(self.id, row.id, "read"))) {
      return res.status(403).json({ error: "No access to that resource" });
    }
    if (!row.bodyText || row.bodyText.length === 0) {
      return res.status(400).json({ error: "Resource has no body to export." });
    }
    try {
      const artifact = await exportResource(row, body.format);
      if (artifact.buffer.length > EXPORT_RESOURCE_MAX_BYTES) {
        return res.status(413).json({
          error: `Rendered ${body.format} is ${artifact.buffer.length} bytes, over the 8 MiB MCP cap. Ask a human to download it from the resource page.`,
        });
      }
      res.json({
        format: artifact.ext,
        mimeType: artifact.mime,
        filename: artifact.filename,
        bytes: artifact.buffer.length,
        contentBase64: artifact.buffer.toString("base64"),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to export: ${message}` });
    }
  },
);

const listCodeRepositoriesSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_code_repositories",
  validateBody(listCodeRepositoriesSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const grants = await AppDataSource.getRepository(EmployeeCodeRepositoryGrant).find({
      where: { employeeId: self.id },
    });
    if (grants.length === 0) return res.json({ repositories: [] });
    const accessById = new Map(grants.map((g) => [g.codeRepositoryId, g.accessLevel]));
    const rows = await AppDataSource.getRepository(CodeRepository).find({
      where: { companyId: co.id, id: In([...accessById.keys()]) },
      order: { updatedAt: "DESC" },
    });
    res.json({
      repositories: rows.map((r) => ({
        name: r.name,
        slug: r.slug,
        description: r.description,
        localPath: `code-repos/${r.slug}`,
        defaultBranch: r.defaultBranch,
        gitUrl: r.gitUrl,
        accessLevel: accessById.get(r.id) ?? "read",
        lastSyncStatus: r.lastSyncStatus,
      })),
    });
  },
);

const createResourceSchema = z
  .object({
    sourceKind: z.enum(["text", "url"]),
    title: z.string().min(1).max(200).optional(),
    url: z.string().url().max(2000).optional(),
    body: z.string().max(RESOURCE_BODY_TEXT_CAP).optional(),
    summary: z.string().max(2000).optional(),
    tags: z.string().max(500).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_resource",
  validateBody(createResourceSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createResourceSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;

    let title = body.title?.trim() ?? "";
    let bodyText = "";
    let sourceUrl: string | null = null;
    let status: "ready" | "failed" = "ready";
    let errorMessage = "";
    let bytes = 0;

    if (body.sourceKind === "url") {
      if (!body.url) {
        return res.status(400).json({ error: "`url` is required when sourceKind is 'url'" });
      }
      sourceUrl = body.url;
      try {
        const fetched = await fetchUrlAsText(body.url);
        title = (title || fetched.title || body.url).slice(0, 200);
        bodyText = trimBodyText(fetched.text);
        bytes = bodyText.length;
      } catch (err) {
        title = (title || body.url).slice(0, 200);
        status = "failed";
        errorMessage = err instanceof Error ? err.message : String(err);
      }
    } else {
      if (!title) {
        return res.status(400).json({ error: "`title` is required when sourceKind is 'text'" });
      }
      if (!body.body || !body.body.trim()) {
        return res.status(400).json({ error: "`body` is required when sourceKind is 'text'" });
      }
      bodyText = trimBodyText(body.body);
      bytes = bodyText.length;
    }

    const repo = AppDataSource.getRepository(Resource);
    const slug = await uniqueResourceSlug(co.id, toSlug(title) || "resource");
    const summary = summarize(bodyText, body.summary);
    const row = repo.create({
      companyId: co.id,
      title,
      slug,
      sourceKind: body.sourceKind,
      sourceUrl,
      sourceFilename: null,
      storageKey: null,
      summary,
      bodyText,
      tags: (body.tags ?? "").trim(),
      bytes,
      status,
      errorMessage,
      createdById: null,
      createdByEmployeeId: self.id,
    });
    await repo.save(row);
    if (body.tags) {
      await replaceResourceTagNames(co.id, "resource", row.id, body.tags);
      row.tags = body.tags.trim();
    }

    // The author always gets `delete` (full control) so it can keep
    // curating its own page without a human round-trip — including
    // removing it if asked. Teammates start at `read`; humans promote
    // them to `edit` or `delete` from the share modal as needed.
    await upsertResourceGrant(self.id, row.id, "delete");
    const teammates = await AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: co.id },
      select: ["id"],
    });
    for (const e of teammates) {
      if (e.id === self.id) continue;
      await upsertResourceGrant(e.id, row.id, "read");
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "resource.create",
      targetType: "resource",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp", sourceKind: row.sourceKind, status: row.status },
    });
    await journal(
      self.id,
      `${self.name} created resource "${row.title}"`,
      `Slug: \`${row.slug}\`. Created via the built-in MCP tool.`,
    );

    res.json({ resource: serializeResource(row, { includeBody: true }) });
  },
);

const updateResourceSchema = z
  .object({
    resourceSlug: z.string().min(1).max(160),
    title: z.string().min(1).max(200).optional(),
    summary: z.string().max(2000).optional(),
    tags: z.string().max(500).optional(),
    body: z.string().max(RESOURCE_BODY_TEXT_CAP).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_resource",
  validateBody(updateResourceSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateResourceSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Resource);
    const row = await repo.findOneBy({
      companyId: co.id,
      slug: body.resourceSlug,
    });
    if (!row) return res.status(404).json({ error: "Resource not found" });
    if (!(await hasResourceAccess(self.id, row.id, "edit"))) {
      return res.status(403).json({ error: "No edit permission on that resource" });
    }

    if (body.title !== undefined) row.title = body.title;
    if (body.summary !== undefined) row.summary = body.summary.trim();
    if (body.tags !== undefined) row.tags = body.tags.trim();
    if (body.body !== undefined) {
      // Mirroring the HTTP route: only `text` resources have an editable
      // body. Extracted text on PDFs/EPUBs/URLs has to match the original
      // source or search results silently drift.
      if (row.sourceKind !== "text") {
        return res.status(400).json({
          error: "Only text resources can have their body edited",
        });
      }
      const trimmed = trimBodyText(body.body);
      row.bodyText = trimmed;
      row.bytes = trimmed.length;
      if (body.summary === undefined) row.summary = summarize(trimmed);
      row.status = "ready";
      row.errorMessage = "";
    }
    await repo.save(row);
    if (body.tags !== undefined) {
      await replaceResourceTagNames(co.id, "resource", row.id, body.tags);
      row.tags = body.tags.trim();
    }

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "resource.update",
      targetType: "resource",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    await journal(
      self.id,
      `${self.name} updated resource "${row.title}"`,
      "Via the built-in MCP tool.",
    );

    res.json({ resource: serializeResource(row, { includeBody: true }) });
  },
);

const deleteResourceSchema = z
  .object({
    resourceSlug: z.string().min(1).max(160),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/delete_resource",
  validateBody(deleteResourceSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteResourceSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Resource);
    const row = await repo.findOneBy({
      companyId: co.id,
      slug: body.resourceSlug,
    });
    if (!row) return res.status(404).json({ error: "Resource not found" });
    if (!(await hasResourceAccess(self.id, row.id, "delete"))) {
      return res.status(403).json({ error: "No delete permission on that resource" });
    }

    await deleteGrantsForResource(row.id);
    if (row.storageKey) {
      // AI may be deleting a human-uploaded PDF/EPUB; mirror the HTTP
      // route's cleanup so we don't orphan bytes on disk.
      await deleteResourceBytes(row.storageKey, co.slug);
    }
    await deleteTagAssignments("resource", row.id);
    await repo.delete({ id: row.id });

    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "resource.delete",
      targetType: "resource",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    await journal(
      self.id,
      `${self.name} deleted resource "${row.title}"`,
      "Permanent delete via the built-in MCP tool.",
    );

    res.json({ ok: true });
  },
);

async function companyOwnerId(companyId: string): Promise<string | null> {
  const co = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  return co?.ownerId ?? null;
}

async function notifyTodoReviewByEmployee(args: {
  companyId: string;
  todo: Todo;
  project: Project;
  actorEmployeeId: string;
  actorEmployeeName: string;
}): Promise<void> {
  const { companyId, todo, project, actorEmployeeId, actorEmployeeName } = args;
  if (!todo.reviewerUserId) return;
  const company = await AppDataSource.getRepository(Company).findOneBy({
    id: companyId,
  });
  if (!company) return;
  const ref = `${project.key}-${todo.number}`;
  await createNotification({
    companyId,
    userId: todo.reviewerUserId,
    kind: "todo_review_requested",
    title: `${actorEmployeeName} requested your review on ${ref}`,
    body: todo.title,
    link: `/c/${company.slug}/tasks/p/${project.slug}`,
    actorKind: "ai",
    actorId: actorEmployeeId,
    entityKind: "todo",
    entityId: todo.id,
  });
}

// --------------------------------------------------------------------------
// Browser-action approvals
// --------------------------------------------------------------------------
//
// Called by the built-in `browser` MCP child (`server/mcp-browser/`) when
// `AIEmployee.browserApprovalRequired` is on and the model invokes
// `browser_submit`. The MCP captures the live page URL + selector + key,
// queues an Approval row here, and returns `pending_approval` to the
// model. Once a human approves it from the UI, the model calls
// `browser_resume(approvalId)` and the MCP re-fires the held action; the
// server side never drives the browser itself.

const queueBrowserApprovalSchema = z.object({
  /** Free-text reason / target action shown to the approver. */
  summary: z.string().trim().min(1).max(1000),
  /** Page URL captured at queue time (best-effort; may be empty). */
  pageUrl: z.string().max(2048).optional(),
  /** Selector the MCP intends to act on. Capped at 500 to match the
   *  click/press routes that `browser_resume` re-fires through — a longer
   *  selector would queue fine but strand on execute. */
  selector: z.string().min(1).max(500),
  /** Optional key press (e.g. `Enter`) — null/undefined for a click. */
  key: z.string().max(60).nullish(),
});

mcpInternalRouter.post(
  "/tools/queue_browser_approval",
  validateBody(queueBrowserApprovalSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof queueBrowserApprovalSchema>;
    const emp = req.mcpEmployee!;
    const co = req.mcpCompany!;
    if (!emp.browserApprovalRequired) {
      return res.status(400).json({
        error:
          "browserApprovalRequired is off for this employee — queue rejected to avoid stranding the action",
      });
    }
    const approval = await createBrowserActionApproval({
      companyId: co.id,
      employeeId: emp.id,
      selector: body.selector,
      key: body.key ?? null,
      pageUrl: body.pageUrl ?? "",
      summary: body.summary,
    });
    res.json({ approvalId: approval.id, status: approval.status });
  },
);

mcpInternalRouter.get("/tools/check_browser_approval/:id", async (req: McpRequest, res) => {
  const id = req.params.id;
  const emp = req.mcpEmployee!;
  const approval = await AppDataSource.getRepository(Approval).findOneBy({ id });
  if (!approval || approval.kind !== "browser_action") {
    return res.status(404).json({ error: "Approval not found" });
  }
  if (approval.employeeId !== emp.id) {
    // The MCP token resolves to one employee; refuse to leak status of
    // a different employee's pending approvals.
    return res.status(403).json({ error: "Approval belongs to another employee" });
  }
  // Return the held action alongside the status so `browser_resume` can
  // re-fire it even when the MCP child that queued it is long gone — the
  // child is spawned per chat turn, and approvals usually land later. The
  // `pageUrl` lets the child refuse to fire if the page has since changed
  // (the approval is bound to what the human actually saw), and `executed`
  // makes the approval one-shot so it can't be replayed indefinitely.
  let payload: { selector?: unknown; key?: unknown; pageUrl?: unknown; executedAt?: unknown } = {};
  try {
    payload = JSON.parse(approval.payloadJson || "{}") as typeof payload;
  } catch {
    // legacy/malformed payload — status alone still helps
  }
  res.json({
    status: approval.status,
    selector: typeof payload.selector === "string" ? payload.selector : null,
    key: typeof payload.key === "string" ? payload.key : null,
    pageUrl: typeof payload.pageUrl === "string" ? payload.pageUrl : null,
    executed: typeof payload.executedAt === "string",
  });
});

/**
 * Mark a browser_action approval as fired, so it can't be replayed. Called
 * by the MCP child right after a successful `browser_resume`. Idempotent —
 * a second call is a no-op — and scoped to the resolving employee.
 */
mcpInternalRouter.post(
  "/tools/mark_browser_approval_executed/:id",
  async (req: McpRequest, res) => {
    const id = req.params.id;
    const emp = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Approval);
    const approval = await repo.findOneBy({ id });
    if (!approval || approval.kind !== "browser_action") {
      return res.status(404).json({ error: "Approval not found" });
    }
    if (approval.employeeId !== emp.id) {
      return res.status(403).json({ error: "Approval belongs to another employee" });
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(approval.payloadJson || "{}") as Record<string, unknown>;
    } catch {
      // overwrite an unreadable payload rather than fail the mark
    }
    if (typeof payload.executedAt !== "string") {
      payload.executedAt = new Date().toISOString();
      approval.payloadJson = JSON.stringify(payload);
      await repo.save(approval);
    }
    res.json({ ok: true });
  },
);

// ───────────────────── Chat attachments + PDF tools ─────────────────────

/** Cap for AI-driven chat uploads; mirrors the human-side ATTACHMENTS_MAX_BYTES. */
const CHAT_ATTACHMENT_AI_MAX_BYTES = 10 * 1024 * 1024;

const sendChatAttachmentSchema = z
  .object({
    filename: z.string().min(1).max(200),
    mimeType: z.string().max(120).optional(),
    contentBase64: z.string().optional(),
    contentText: z.string().optional(),
  })
  .strict()
  .refine(
    (b) => (b.contentText !== undefined) !== (b.contentBase64 !== undefined),
    "Provide exactly one of contentText or contentBase64",
  );

/**
 * Upload a file the AI just generated (e.g. a filled PDF) and stage it
 * for the current chat turn. The chat seam drains the staged ids when
 * the spawn ends and binds them to the assistant message — so the human
 * sees a download chip on the reply bubble.
 */
mcpInternalRouter.post(
  "/tools/send_chat_attachment",
  validateBody(sendChatAttachmentSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof sendChatAttachmentSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const token = req.mcpToken!;

    let bytes: Buffer;
    let mimeType = body.mimeType;
    if (body.contentText !== undefined) {
      bytes = Buffer.from(body.contentText, "utf8");
      if (!mimeType) mimeType = "text/plain; charset=utf-8";
    } else {
      try {
        bytes = Buffer.from(body.contentBase64 ?? "", "base64");
      } catch {
        return res.status(400).json({ error: "Invalid base64" });
      }
      if (!mimeType) mimeType = "application/octet-stream";
    }
    if (bytes.length === 0) return res.status(400).json({ error: "Empty file" });
    if (bytes.length > CHAT_ATTACHMENT_AI_MAX_BYTES) {
      return res.status(413).json({
        error: `Attachment exceeds the ${CHAT_ATTACHMENT_AI_MAX_BYTES / (1024 * 1024)} MB AI upload cap`,
      });
    }

    const row = await recordAttachmentBytes({
      companyId: co.id,
      companySlug: co.slug,
      filename: body.filename,
      mimeType,
      bytes,
      uploadedByUserId: null,
    });
    stageAttachmentForToken(token, row.id);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "chat_attachment.create",
      targetType: "attachment",
      targetId: row.id,
      targetLabel: row.filename,
      metadata: { via: "mcp", filename: row.filename, sizeBytes: Number(row.sizeBytes) },
    });
    await journal(
      self.id,
      `${self.name} attached "${body.filename}" to a chat reply`,
      `Mime: ${mimeType}, ${bytes.length} bytes.`,
    );
    res.json({
      attachment: {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
      },
    });
  },
);

const pdfFieldsSchema = z.object({ attachmentId: z.string().uuid() }).strict();

async function loadAttachmentPdf(
  attachmentId: string,
  companyId: string,
): Promise<{ row: Attachment; doc: PDFDocument } | { error: string; status: number }> {
  const resolved = await resolveAttachmentFile(attachmentId, companyId);
  if (!resolved) return { error: "Attachment not found", status: 404 };
  const ext = resolved.row.filename.toLowerCase().endsWith(".pdf");
  const isPdfMime = resolved.row.mimeType === "application/pdf";
  if (!ext && !isPdfMime) {
    return { error: "Attachment is not a PDF", status: 400 };
  }
  const buf = await fs.promises.readFile(resolved.absPath);
  try {
    const doc = await PDFDocument.load(buf, { ignoreEncryption: true });
    return { row: resolved.row, doc };
  } catch (err) {
    return {
      error: `Could not parse PDF: ${err instanceof Error ? err.message : String(err)}`,
      status: 400,
    };
  }
}

function describePdfFieldType(field: unknown): string {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFRadioGroup) return "radio";
  if (field instanceof PDFDropdown) return "dropdown";
  return "unknown";
}

/**
 * List the form fields in a PDF attachment so the AI knows what to fill.
 * Returns each field's name, type, and current value (if any). For radio
 * groups and dropdowns, also returns the option set.
 */
mcpInternalRouter.post(
  "/tools/read_pdf_fields",
  validateBody(pdfFieldsSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof pdfFieldsSchema>;
    const co = req.mcpCompany!;
    const loaded = await loadAttachmentPdf(body.attachmentId, co.id);
    if ("error" in loaded) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const form = loaded.doc.getForm();
    const fields = form.getFields().map((f) => {
      const name = f.getName();
      const type = describePdfFieldType(f);
      const out: Record<string, unknown> = { name, type };
      if (f instanceof PDFTextField) {
        out.value = f.getText() ?? "";
      } else if (f instanceof PDFCheckBox) {
        out.value = f.isChecked();
      } else if (f instanceof PDFDropdown) {
        out.value = f.getSelected();
        out.options = f.getOptions();
      } else if (f instanceof PDFRadioGroup) {
        out.value = f.getSelected() ?? "";
        out.options = f.getOptions();
      }
      return out;
    });
    res.json({ filename: loaded.row.filename, fields });
  },
);

const fillPdfSchema = z
  .object({
    attachmentId: z.string().uuid(),
    /** Map of field name → value. Strings for text fields, booleans for
     * checkboxes, the option string for dropdowns/radio groups. */
    fields: z.record(z.union([z.string(), z.boolean()])),
    /** Filename for the produced PDF; defaults to the source's name with a
     * `-filled` suffix. */
    outputFilename: z.string().min(1).max(200).optional(),
    /** When true (default) the form is flattened so the values are baked
     * in and the PDF can't be edited further. */
    flatten: z.boolean().optional(),
  })
  .strict();

/**
 * Fill an existing PDF form with the supplied values and stage the
 * resulting file as a chat attachment. The AI gets back the new
 * attachment's metadata; the chat seam binds it to the reply bubble.
 */
mcpInternalRouter.post(
  "/tools/fill_pdf_form",
  validateBody(fillPdfSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof fillPdfSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const token = req.mcpToken!;
    const loaded = await loadAttachmentPdf(body.attachmentId, co.id);
    if ("error" in loaded) {
      return res.status(loaded.status).json({ error: loaded.error });
    }
    const form = loaded.doc.getForm();
    const fieldByName = new Map(form.getFields().map((f) => [f.getName(), f]));

    const unknownFields: string[] = [];
    for (const [name, value] of Object.entries(body.fields)) {
      const field = fieldByName.get(name);
      if (!field) {
        unknownFields.push(name);
        continue;
      }
      if (field instanceof PDFTextField) {
        field.setText(typeof value === "boolean" ? String(value) : value);
      } else if (field instanceof PDFCheckBox) {
        const truthy =
          value === true || (typeof value === "string" && /^(true|yes|on|x|checked)$/i.test(value));
        if (truthy) field.check();
        else field.uncheck();
      } else if (field instanceof PDFDropdown) {
        if (typeof value === "string") field.select(value);
      } else if (field instanceof PDFRadioGroup) {
        if (typeof value === "string") field.select(value);
      }
    }

    if (unknownFields.length > 0) {
      return res.status(400).json({
        error: `PDF has no field named: ${unknownFields.join(", ")}. Run read_pdf_fields first to list them.`,
      });
    }

    if (body.flatten !== false) form.flatten();
    const out = await loaded.doc.save();
    const outputName =
      body.outputFilename || loaded.row.filename.replace(/\.pdf$/i, "") + "-filled.pdf";

    const row = await recordAttachmentBytes({
      companyId: co.id,
      companySlug: co.slug,
      filename: outputName,
      mimeType: "application/pdf",
      bytes: Buffer.from(out),
      uploadedByUserId: null,
    });
    stageAttachmentForToken(token, row.id);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "pdf.fill",
      targetType: "attachment",
      targetId: row.id,
      targetLabel: outputName,
      metadata: {
        via: "mcp",
        sourceAttachmentId: body.attachmentId,
        filledFields: Object.keys(body.fields).length,
      },
    });
    await journal(
      self.id,
      `${self.name} filled PDF "${loaded.row.filename}" → "${outputName}"`,
      `Filled ${Object.keys(body.fields).length} field(s).`,
    );
    res.json({
      attachment: {
        id: row.id,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: Number(row.sizeBytes),
      },
    });
  },
);

// ---------------- Explore (M20) ----------------
//
// Charts + Dashboards. AI employees can list/run/create charts and pin
// them to dashboards the team will see. SQL runs through the company's
// existing postgres/mysql/clickhouse Integration Connections — no extra
// auth, same 30s / 5,000-row envelope as the integration tools.

const listChartsSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_charts",
  validateBody(listChartsSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleChartIds(self.id);
    if (accessible.size === 0) return res.json({ charts: [] });
    const rows = await AppDataSource.getRepository(Chart).find({
      where: { companyId: co.id, id: In([...accessible]) },
      order: { updatedAt: "DESC" },
    });
    res.json({ charts: rows.map((r) => serializeChart(r)) });
  },
);

const getChartSchema = z.object({ chartSlug: z.string().min(1).max(160) }).strict();

mcpInternalRouter.post(
  "/tools/get_chart",
  validateBody(getChartSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof getChartSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const row = await AppDataSource.getRepository(Chart).findOneBy({
      companyId: co.id,
      slug: body.chartSlug,
    });
    if (!row) return res.status(404).json({ error: "Chart not found" });
    if (!(await hasChartAccess(self.id, row.id, "read"))) {
      return res.status(403).json({ error: "No access to that chart" });
    }
    res.json({ chart: serializeChart(row) });
  },
);

const runChartMcpSchema = z
  .object({
    chartSlug: z.string().min(1).max(160),
    maxRows: z.number().int().min(1).max(5000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/run_chart",
  validateBody(runChartMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof runChartMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const row = await AppDataSource.getRepository(Chart).findOneBy({
      companyId: co.id,
      slug: body.chartSlug,
    });
    if (!row) return res.status(404).json({ error: "Chart not found" });
    if (!(await hasChartAccess(self.id, row.id, "read"))) {
      return res.status(403).json({ error: "No access to that chart" });
    }
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      id: row.connectionId,
      companyId: co.id,
    });
    if (!conn) {
      return res.status(400).json({ error: "Chart's connection no longer exists" });
    }
    try {
      const result = await runSqlAgainstConnection(conn, row.sql, {
        maxRows: body.maxRows,
      });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  },
);

const VIZ_ENUM_MCP = ["table", "scalar", "bar", "line", "area", "pie"] as [string, ...string[]];

const createChartMcpSchema = z
  .object({
    title: z.string().min(1).max(200),
    connectionId: z.string().uuid(),
    sql: z.string().min(1).max(50_000),
    description: z.string().max(2000).optional(),
    vizType: z.enum(VIZ_ENUM_MCP).optional(),
    vizConfig: z.record(z.unknown()).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_chart",
  validateBody(createChartMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createChartMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
      id: body.connectionId,
      companyId: co.id,
    });
    if (!conn) return res.status(400).json({ error: "Unknown connection" });
    if (!isExploreProvider(conn.provider)) {
      return res.status(400).json({ error: "Connection is not a supported Explore source" });
    }
    const repo = AppDataSource.getRepository(Chart);
    const slug = await uniqueChartSlug(co.id, body.title);
    const row = repo.create({
      companyId: co.id,
      title: body.title,
      slug,
      description: body.description ?? "",
      connectionId: body.connectionId,
      sql: body.sql,
      vizType: (body.vizType ?? "table") as Chart["vizType"],
      vizConfig: JSON.stringify(body.vizConfig ?? {}),
      createdById: null,
      createdByEmployeeId: self.id,
    });
    await repo.save(row);
    // Seed grants: read for the team, write for the author.
    await grantChartToAllEmployees(co.id, row.id);
    await upsertChartGrant(self.id, row.id, "write");
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "chart.create",
      targetType: "chart",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp", vizType: row.vizType },
    });
    await journal(self.id, `${self.name} created chart "${row.title}"`);
    res.json({ chart: serializeChart(row) });
  },
);

const updateChartMcpSchema = z
  .object({
    chartSlug: z.string().min(1).max(160),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    sql: z.string().min(1).max(50_000).optional(),
    vizType: z.enum(VIZ_ENUM_MCP).optional(),
    vizConfig: z.record(z.unknown()).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_chart",
  validateBody(updateChartMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof updateChartMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const row = await AppDataSource.getRepository(Chart).findOneBy({
      companyId: co.id,
      slug: body.chartSlug,
    });
    if (!row) return res.status(404).json({ error: "Chart not found" });
    if (!(await hasChartAccess(self.id, row.id, "write"))) {
      return res.status(403).json({ error: "Write access required to edit that chart" });
    }
    if (body.title !== undefined) row.title = body.title;
    if (body.description !== undefined) row.description = body.description;
    if (body.sql !== undefined) row.sql = body.sql;
    if (body.vizType !== undefined) row.vizType = body.vizType as Chart["vizType"];
    if (body.vizConfig !== undefined) row.vizConfig = JSON.stringify(body.vizConfig);
    await AppDataSource.getRepository(Chart).save(row);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "chart.update",
      targetType: "chart",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({ chart: serializeChart(row) });
  },
);

const deleteChartMcpSchema = z.object({ chartSlug: z.string().min(1).max(160) }).strict();

mcpInternalRouter.post(
  "/tools/delete_chart",
  validateBody(deleteChartMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof deleteChartMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const row = await AppDataSource.getRepository(Chart).findOneBy({
      companyId: co.id,
      slug: body.chartSlug,
    });
    if (!row) return res.status(404).json({ error: "Chart not found" });
    if (!(await hasChartAccess(self.id, row.id, "write"))) {
      return res.status(403).json({ error: "Write access required to delete that chart" });
    }
    await AppDataSource.getRepository(DashboardCard).delete({ chartId: row.id });
    await deleteGrantsForChart(row.id);
    await AppDataSource.getRepository(Chart).delete({ id: row.id });
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "chart.delete",
      targetType: "chart",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    res.json({ ok: true });
  },
);

const listDashboardsSchema = z.object({}).strict();

mcpInternalRouter.post(
  "/tools/list_dashboards",
  validateBody(listDashboardsSchema),
  async (req: McpRequest, res) => {
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const accessible = await listAccessibleDashboardIds(self.id);
    if (accessible.size === 0) return res.json({ dashboards: [] });
    const rows = await AppDataSource.getRepository(Dashboard).find({
      where: { companyId: co.id, id: In([...accessible]) },
      order: { updatedAt: "DESC" },
    });
    res.json({ dashboards: rows.map((r) => serializeDashboard(r)) });
  },
);

const getDashboardSchema = z.object({ dashboardSlug: z.string().min(1).max(160) }).strict();

mcpInternalRouter.post(
  "/tools/get_dashboard",
  validateBody(getDashboardSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof getDashboardSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const row = await AppDataSource.getRepository(Dashboard).findOneBy({
      companyId: co.id,
      slug: body.dashboardSlug,
    });
    if (!row) return res.status(404).json({ error: "Dashboard not found" });
    if (!(await hasDashboardAccess(self.id, row.id, "read"))) {
      return res.status(403).json({ error: "No access to that dashboard" });
    }
    const cards = await AppDataSource.getRepository(DashboardCard).find({
      where: { dashboardId: row.id },
      order: { y: "ASC", x: "ASC" },
    });
    const chartIds = [...new Set(cards.map((c) => c.chartId))];
    // Hide cards whose underlying Chart this employee can't read. A
    // dashboard read grant is not transitive to its charts — without
    // this we'd leak the SQL/data behind a chart the human meant to
    // scope tighter.
    const allCharts = chartIds.length
      ? await AppDataSource.getRepository(Chart).find({
          where: { id: In(chartIds), companyId: co.id },
        })
      : [];
    const accessibleChartIds = await listAccessibleChartIds(self.id);
    const charts = allCharts.filter((c) => accessibleChartIds.has(c.id));
    const visibleChartIdSet = new Set(charts.map((c) => c.id));
    const visibleCards = cards.filter((c) => visibleChartIdSet.has(c.chartId));
    res.json({
      dashboard: serializeDashboard(row),
      cards: visibleCards.map(serializeCard),
      charts: charts.map(serializeChart),
    });
  },
);

const createDashboardMcpSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_dashboard",
  validateBody(createDashboardMcpSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof createDashboardMcpSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const repo = AppDataSource.getRepository(Dashboard);
    const slug = await uniqueDashboardSlug(co.id, body.title);
    const row = repo.create({
      companyId: co.id,
      title: body.title,
      slug,
      description: body.description ?? "",
      createdById: null,
      createdByEmployeeId: self.id,
    });
    await repo.save(row);
    await grantDashboardToAllEmployees(co.id, row.id);
    await upsertDashboardGrant(self.id, row.id, "write");
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "dashboard.create",
      targetType: "dashboard",
      targetId: row.id,
      targetLabel: row.title,
      metadata: { via: "mcp" },
    });
    await journal(self.id, `${self.name} created dashboard "${row.title}"`);
    res.json({ dashboard: serializeDashboard(row) });
  },
);

const addDashboardCardSchema = z
  .object({
    dashboardSlug: z.string().min(1).max(160),
    chartSlug: z.string().min(1).max(160),
    x: z.number().int().min(0).max(11).optional(),
    y: z.number().int().min(0).max(10_000).optional(),
    w: z.number().int().min(1).max(12).optional(),
    h: z.number().int().min(1).max(40).optional(),
    titleOverride: z.string().max(200).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/add_dashboard_card",
  validateBody(addDashboardCardSchema),
  async (req: McpRequest, res) => {
    const body = req.body as z.infer<typeof addDashboardCardSchema>;
    const co = req.mcpCompany!;
    const self = req.mcpEmployee!;
    const dashboard = await AppDataSource.getRepository(Dashboard).findOneBy({
      companyId: co.id,
      slug: body.dashboardSlug,
    });
    if (!dashboard) return res.status(404).json({ error: "Dashboard not found" });
    if (!(await hasDashboardAccess(self.id, dashboard.id, "write"))) {
      return res.status(403).json({ error: "Write access required to edit that dashboard" });
    }
    const chart = await AppDataSource.getRepository(Chart).findOneBy({
      companyId: co.id,
      slug: body.chartSlug,
    });
    if (!chart) return res.status(400).json({ error: "Unknown chart" });
    if (!(await hasChartAccess(self.id, chart.id, "read"))) {
      return res.status(403).json({ error: "Read access on the chart is required to pin it" });
    }
    let defaultY = 0;
    if (body.y === undefined) {
      const existing = await AppDataSource.getRepository(DashboardCard).find({
        where: { dashboardId: dashboard.id },
        order: { y: "DESC" },
        take: 12,
      });
      defaultY = existing.reduce((m, c) => Math.max(m, c.y + c.h), 0);
    }
    const repo = AppDataSource.getRepository(DashboardCard);
    const card = repo.create({
      dashboardId: dashboard.id,
      chartId: chart.id,
      x: body.x ?? 0,
      y: body.y ?? defaultY,
      w: body.w ?? 6,
      h: body.h ?? 4,
      titleOverride: body.titleOverride ?? "",
    });
    await repo.save(card);
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "dashboard.card.add",
      targetType: "dashboard",
      targetId: dashboard.id,
      targetLabel: dashboard.title,
      metadata: { via: "mcp", chartId: chart.id },
    });
    res.json({ card: serializeCard(card) });
  },
);

// ----- Email (M25): grant-gated mail tools -----
//
// Mirrors the human routes in `routes/mail.ts` but resolves the actor from
// the MCP token and enforces `EmployeeMailAccountGrant` levels:
// read < draft < send. Every write records an AuditEvent (actorKind "ai")
// and a JournalEntry, like the rest of this file.

/** Resolve the target mail account for a tool call and enforce the grant.
 * When `accountId` is omitted and the employee holds exactly one grant, that
 * account is used. Writes the error response itself and returns null on
 * failure. */
async function loadGrantedMailAccount(
  req: McpRequest,
  res: Response,
  accountId: string | undefined,
  required: MailAccessLevel,
): Promise<MailAccount | null> {
  const self = req.mcpEmployee!;
  const co = req.mcpCompany!;
  const grantRepo = AppDataSource.getRepository(EmployeeMailAccountGrant);
  const accountRepo = AppDataSource.getRepository(MailAccount);

  let account: MailAccount | null = null;
  if (accountId) {
    account = await accountRepo.findOneBy({ id: accountId, companyId: co.id });
    if (!account) {
      res.status(404).json({ error: "Mail account not found" });
      return null;
    }
  } else {
    const grants = await grantRepo.find({ where: { employeeId: self.id } });
    const accounts = grants.length
      ? await accountRepo.find({
          where: { id: In(grants.map((g) => g.accountId)), companyId: co.id },
        })
      : [];
    if (accounts.length === 1) {
      account = accounts[0];
    } else {
      res.status(400).json({
        error:
          accounts.length === 0
            ? "No grant: you do not have access to any mailbox. Ask a human to grant one under Email → Settings → AI access."
            : "You have access to several mailboxes — pass `accountId` (see list_mail_accounts).",
      });
      return null;
    }
  }

  const grant = await grantRepo.findOneBy({
    employeeId: self.id,
    accountId: account.id,
  });
  if (!grant || MAIL_ACCESS_RANK[grant.accessLevel] < MAIL_ACCESS_RANK[required]) {
    res.status(403).json({
      error: grant
        ? `No grant: this needs the "${required}" access level on ${account.address}; yours is "${grant.accessLevel}".`
        : `No grant: you do not have access to ${account.address}.`,
    });
    return null;
  }
  return account;
}

/** Load a thread and enforce the grant on its account. */
async function loadGrantedMailThread(
  req: McpRequest,
  res: Response,
  threadId: string,
  required: MailAccessLevel,
): Promise<{ thread: MailThread; account: MailAccount } | null> {
  const co = req.mcpCompany!;
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: threadId,
    companyId: co.id,
  });
  if (!thread) {
    res.status(404).json({ error: "Thread not found" });
    return null;
  }
  const account = await loadGrantedMailAccount(req, res, thread.accountId, required);
  if (!account) return null;
  return { thread, account };
}

function serializeMailThreadForAgent(t: MailThread) {
  return {
    threadId: t.id,
    subject: t.subject,
    snippet: t.snippet,
    participants: t.participants,
    labels: columnToLabelIds(t.labelIds),
    unread: t.unread,
    messageCount: t.messageCount,
    hasAttachments: t.hasAttachments,
    lastMessageAt: t.lastMessageAt ? t.lastMessageAt.toISOString() : null,
  };
}

/** Agent view of one message: text body only, capped — HTML stays server-side. */
const AGENT_MAIL_BODY_CAP = 20_000;
function serializeMailMessageForAgent(m: MailMessage) {
  let attachments: unknown[] = [];
  try {
    attachments = (
      JSON.parse(m.attachmentsJson) as Array<{
        filename?: string;
        mimeType?: string;
        size?: number;
      }>
    ).map((a) => ({ filename: a.filename, mimeType: a.mimeType, size: a.size }));
  } catch {
    attachments = [];
  }
  const body = m.bodyText || m.snippet;
  return {
    messageId: m.id,
    isDraft: m.gmailDraftId !== "",
    from: m.fromName ? `${m.fromName} <${m.fromEmail}>` : m.fromEmail,
    to: m.toEmails,
    cc: m.ccEmails,
    subject: m.subject,
    sentAt: m.sentAt ? m.sentAt.toISOString() : null,
    labels: columnToLabelIds(m.labelIds),
    bodyText:
      body.length > AGENT_MAIL_BODY_CAP
        ? `${body.slice(0, AGENT_MAIL_BODY_CAP)}\n… [truncated]`
        : body,
    attachments,
  };
}

mcpInternalRouter.post("/tools/list_mail_accounts", async (req: McpRequest, res: Response) => {
  const self = req.mcpEmployee!;
  const co = req.mcpCompany!;
  const grants = await AppDataSource.getRepository(EmployeeMailAccountGrant).find({
    where: { employeeId: self.id },
  });
  const accounts = grants.length
    ? await AppDataSource.getRepository(MailAccount).find({
        where: { id: In(grants.map((g) => g.accountId)), companyId: co.id },
      })
    : [];
  const byId = new Map(accounts.map((a) => [a.id, a]));
  res.json({
    accounts: grants.flatMap((g) => {
      const a = byId.get(g.accountId);
      return a
        ? [
            {
              accountId: a.id,
              address: a.address,
              status: a.status,
              accessLevel: g.accessLevel,
            },
          ]
        : [];
    }),
  });
});

const searchMailSchema = z
  .object({
    accountId: z.string().uuid().optional(),
    query: z.string().max(500).optional(),
    from: z.string().max(200).optional(),
    to: z.string().max(200).optional(),
    after: z.string().max(30).optional(),
    before: z.string().max(30).optional(),
    label: z.string().max(200).optional(),
    unreadOnly: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/search_mail",
  validateBody(searchMailSchema),
  async (req: McpRequest, res: Response) => {
    const body = req.body as z.infer<typeof searchMailSchema>;
    const account = await loadGrantedMailAccount(req, res, body.accountId, "read");
    if (!account) return;

    // One grammar with the human search box: `query` goes through
    // parseMailQuery, so terms AND together and Gmail-style operators
    // (from:/to:/subject:/label:/in:/has:/is:/before:/after:) work verbatim.
    // The structured args override their operator twins when both appear.
    const parsed = parseMailQuery(body.query?.trim() ?? "");
    if (body.from?.trim()) parsed.from = body.from.trim().toLowerCase();
    if (body.to?.trim()) parsed.to = body.to.trim().toLowerCase();
    if (body.unreadOnly) parsed.isUnread = true;
    if (body.hasAttachment) parsed.hasAttachment = true;
    const after = body.after ? new Date(body.after) : null;
    if (after && !Number.isNaN(after.getTime())) parsed.after = after;
    const before = body.before ? new Date(body.before) : null;
    if (before && !Number.isNaN(before.getTime())) parsed.before = before;
    if (body.label) parsed.label = body.label;

    let labelId: string | null | undefined;
    if (parsed.label) {
      labelId = await resolveSearchLabelId(account.id, parsed.label);
      if (!labelId) {
        return res.json({ threads: [], note: `No label "${parsed.label}" on this mailbox.` });
      }
    }

    let qb = AppDataSource.getRepository(MailThread)
      .createQueryBuilder("t")
      .where("t.accountId = :aid", { aid: account.id })
      .andWhere("t.lastMessageAt IS NOT NULL");
    qb = applyMailScope(qb, effectiveScope(parsed, labelId));
    qb = applyMailSearchFilters(qb, parsed, labelId);
    const threads = await qb
      .orderBy("t.lastMessageAt", "DESC")
      .take(body.limit ?? 20)
      .getMany();
    res.json({ threads: threads.map(serializeMailThreadForAgent) });
  },
);

const getMailThreadSchema = z.object({ threadId: z.string().uuid() }).strict();

mcpInternalRouter.post(
  "/tools/get_mail_thread",
  validateBody(getMailThreadSchema),
  async (req: McpRequest, res: Response) => {
    const body = req.body as z.infer<typeof getMailThreadSchema>;
    const found = await loadGrantedMailThread(req, res, body.threadId, "read");
    if (!found) return;
    const messages = await AppDataSource.getRepository(MailMessage).find({
      where: { threadId: found.thread.id },
      order: { sentAt: "ASC" },
    });
    res.json({
      thread: serializeMailThreadForAgent(found.thread),
      account: { accountId: found.account.id, address: found.account.address },
      messages: messages.map(serializeMailMessageForAgent),
    });
  },
);

/**
 * Resolve an AI employee's attachment specs — Resources by slug and/or
 * invoices by slug (rendered to PDF, finance-grant-gated) — into MIME parts
 * for the mail compose path. Returns undefined when there are none; throws on
 * a bad spec, a missing grant, or an over-size total (the caller turns that
 * into a 400 the model can read).
 */
async function resolveMailAttachments(
  req: McpRequest,
  specs: unknown,
): Promise<MimeAttachment[] | undefined> {
  if (!Array.isArray(specs) || specs.length === 0) return undefined;
  const resolve = makeResourceAttachmentResolver({
    companyId: req.mcpCompany!.id,
    employeeId: req.mcpEmployee!.id,
  });
  const resolved = await resolve(specs);
  return resolved.map((a) => ({
    filename: a.filename,
    mimeType: a.contentType,
    content: a.content,
  }));
}

const createMailDraftSchema = z
  .object({
    threadId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    to: z.string().max(2000).optional(),
    cc: z.string().max(2000).optional(),
    bcc: z.string().max(2000).optional(),
    subject: z.string().max(1000).optional(),
    bodyText: z.string().min(1).max(200_000),
    attachments: resourceAttachmentSpecsSchema.optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/create_mail_draft",
  validateBody(createMailDraftSchema),
  async (req: McpRequest, res: Response) => {
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const body = req.body as z.infer<typeof createMailDraftSchema>;

    let thread: MailThread | null = null;
    let account: MailAccount | null;
    if (body.threadId) {
      const found = await loadGrantedMailThread(req, res, body.threadId, "draft");
      if (!found) return;
      thread = found.thread;
      account = found.account;
    } else {
      account = await loadGrantedMailAccount(req, res, body.accountId, "draft");
      if (!account) return;
      if (!body.to) {
        return res
          .status(400)
          .json({ error: "`to` is required for a fresh compose (no threadId)." });
      }
    }

    try {
      const attachments = await resolveMailAttachments(req, body.attachments);
      const message = await createMailDraft(
        account,
        {
          to: body.to ?? "",
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          bodyText: body.bodyText,
          attachments,
        },
        thread,
        // Provenance for the Drafts review queue: which employee wrote it, and
        // the Run/Routine behind it when the runner minted this token.
        {
          employeeId: self.id,
          routineId: req.mcpRoutineId ?? null,
          runId: req.mcpRunId ?? null,
        },
      );
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: self.id,
        action: "mail.draft.create",
        targetType: "mail_message",
        targetId: message.id,
        targetLabel: message.subject || "(no subject)",
        metadata: { via: "mcp", threadId: thread?.id ?? null },
      });
      await journal(
        self.id,
        `Drafted an email: "${message.subject || "(no subject)"}"`,
        thread
          ? `Reply draft on thread ${thread.id} in ${account.address}.`
          : `New draft in ${account.address}.`,
      );
      res.json({
        message: serializeMailMessageForAgent(message),
        note: "Draft saved to the thread and to Gmail Drafts. A human can now review and send it.",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Draft failed" });
    }
  },
);

const editMailDraftSchema = z
  .object({
    draftMessageId: z.string().uuid(),
    to: z.string().max(2000).optional(),
    cc: z.string().max(2000).optional(),
    bcc: z.string().max(2000).optional(),
    subject: z.string().max(1000).optional(),
    bodyText: z.string().min(1).max(200_000).optional(),
  })
  .strict()
  .refine(
    (body) =>
      body.to !== undefined ||
      body.cc !== undefined ||
      body.bcc !== undefined ||
      body.subject !== undefined ||
      body.bodyText !== undefined,
    { message: "Pass at least one draft field to edit." },
  );

mcpInternalRouter.post(
  "/tools/edit_mail_draft",
  validateBody(editMailDraftSchema),
  async (req: McpRequest, res: Response) => {
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const body = req.body as z.infer<typeof editMailDraftSchema>;
    const draft = await AppDataSource.getRepository(MailMessage).findOneBy({
      id: body.draftMessageId,
      companyId: co.id,
    });
    if (!draft || !draft.gmailDraftId) {
      return res.status(404).json({ error: "Draft not found" });
    }
    const account = await loadGrantedMailAccount(req, res, draft.accountId, "draft");
    if (!account) return;

    try {
      const message = await updateMailDraft(account, draft, {
        to: body.to ?? draft.toEmails,
        cc: (body.cc ?? draft.ccEmails) || undefined,
        bcc: (body.bcc ?? draft.bccEmails) || undefined,
        subject: body.subject ?? draft.subject,
        bodyText: body.bodyText ?? draft.bodyText,
      });
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: self.id,
        action: "mail.draft.update",
        targetType: "mail_message",
        targetId: message.id,
        targetLabel: message.subject || "(no subject)",
        metadata: {
          via: "mcp",
          previousMessageId: draft.id,
          threadId: message.threadId,
        },
      });
      await journal(
        self.id,
        `Edited an email draft: "${message.subject || "(no subject)"}"`,
        `Updated draft on thread ${message.threadId} in ${account.address}.`,
      );
      res.json({
        message: serializeMailMessageForAgent(message),
        note: "Draft updated in Genosyn and Gmail. Gmail assigned the returned messageId to the replacement draft.",
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Draft update failed" });
    }
  },
);

const updateMailThreadSchema = z
  .object({
    threadId: z.string().uuid(),
    markRead: z.boolean().optional(),
    markUnread: z.boolean().optional(),
    star: z.boolean().optional(),
    unstar: z.boolean().optional(),
    archive: z.boolean().optional(),
    moveToInbox: z.boolean().optional(),
    addLabels: z.array(z.string().min(1).max(200)).max(10).optional(),
    removeLabels: z.array(z.string().min(1).max(200)).max(10).optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/update_mail_thread",
  validateBody(updateMailThreadSchema),
  async (req: McpRequest, res: Response) => {
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const body = req.body as z.infer<typeof updateMailThreadSchema>;
    const found = await loadGrantedMailThread(req, res, body.threadId, "draft");
    if (!found) return;

    const applied: string[] = [];
    try {
      if (body.markRead) {
        await performThreadAction(found.account, found.thread, "markRead");
        applied.push("markRead");
      }
      if (body.markUnread) {
        await performThreadAction(found.account, found.thread, "markUnread");
        applied.push("markUnread");
      }
      if (body.star) {
        await performThreadAction(found.account, found.thread, "star");
        applied.push("star");
      }
      if (body.unstar) {
        await performThreadAction(found.account, found.thread, "unstar");
        applied.push("unstar");
      }
      if (body.archive) {
        await performThreadAction(found.account, found.thread, "archive");
        applied.push("archive");
      }
      if (body.moveToInbox) {
        await performThreadAction(found.account, found.thread, "moveToInbox");
        applied.push("moveToInbox");
      }
      for (const name of body.addLabels ?? []) {
        await performThreadAction(found.account, found.thread, "applyLabel", {
          labelName: name,
        });
        applied.push(`+${name}`);
      }
      for (const name of body.removeLabels ?? []) {
        await performThreadAction(found.account, found.thread, "removeLabel", {
          labelName: name,
        });
        applied.push(`-${name}`);
      }
    } catch (err) {
      return res.status(400).json({
        error: err instanceof Error ? err.message : "Update failed",
        applied,
      });
    }
    if (applied.length === 0) {
      return res
        .status(400)
        .json({ error: "Nothing to do — pass at least one action flag or label." });
    }
    await recordAudit({
      companyId: co.id,
      actorEmployeeId: self.id,
      action: "mail.thread.action",
      targetType: "mail_thread",
      targetId: found.thread.id,
      targetLabel: found.thread.subject || "(no subject)",
      metadata: { via: "mcp", applied },
    });
    await journal(
      self.id,
      `Triaged an email thread: "${found.thread.subject || "(no subject)"}"`,
      `Applied: ${applied.join(", ")} (${found.account.address}).`,
    );
    const fresh = await AppDataSource.getRepository(MailThread).findOneBy({
      id: found.thread.id,
    });
    res.json({
      thread: fresh ? serializeMailThreadForAgent(fresh) : null,
      applied,
    });
  },
);

const sendMailSchema = z
  .object({
    draftMessageId: z.string().uuid().optional(),
    threadId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    to: z.string().max(2000).optional(),
    cc: z.string().max(2000).optional(),
    bcc: z.string().max(2000).optional(),
    subject: z.string().max(1000).optional(),
    bodyText: z.string().max(200_000).optional(),
    attachments: resourceAttachmentSpecsSchema.optional(),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/send_mail",
  validateBody(sendMailSchema),
  async (req: McpRequest, res: Response) => {
    const self = req.mcpEmployee!;
    const co = req.mcpCompany!;
    const body = req.body as z.infer<typeof sendMailSchema>;

    // Sending an existing draft ships whatever is already attached to it; a
    // fresh `attachments` list here would be silently dropped, so reject it.
    if (body.draftMessageId && body.attachments && body.attachments.length > 0) {
      return res.status(400).json({
        error:
          "Attachments can't be added when sending an existing draft. Attach them with create_mail_draft (or edit the draft), then send it.",
      });
    }

    try {
      if (body.draftMessageId) {
        const draft = await AppDataSource.getRepository(MailMessage).findOneBy({
          id: body.draftMessageId,
          companyId: co.id,
        });
        if (!draft || !draft.gmailDraftId) {
          return res.status(404).json({ error: "Draft not found" });
        }
        const account = await loadGrantedMailAccount(req, res, draft.accountId, "send");
        if (!account) return;
        const sent = await sendMailDraft(account, draft);
        await recordAudit({
          companyId: co.id,
          actorEmployeeId: self.id,
          action: "mail.send",
          targetType: "mail_message",
          targetId: sent.id,
          targetLabel: sent.subject || "(no subject)",
          metadata: { via: "mcp", fromDraft: true },
        });
        await journal(
          self.id,
          `Sent an email: "${sent.subject || "(no subject)"}"`,
          `Sent a reviewed draft from ${account.address} to ${sent.toEmails}.`,
        );
        return res.json({ message: serializeMailMessageForAgent(sent) });
      }

      if (!body.bodyText) {
        return res
          .status(400)
          .json({ error: "`bodyText` is required unless sending an existing draft." });
      }
      let thread: MailThread | null = null;
      let account: MailAccount | null;
      if (body.threadId) {
        const found = await loadGrantedMailThread(req, res, body.threadId, "send");
        if (!found) return;
        thread = found.thread;
        account = found.account;
      } else {
        account = await loadGrantedMailAccount(req, res, body.accountId, "send");
        if (!account) return;
        if (!body.to || !body.subject) {
          return res.status(400).json({
            error: "`to` and `subject` are required for a fresh compose (no threadId).",
          });
        }
      }
      const attachments = await resolveMailAttachments(req, body.attachments);
      const sent = await sendMailMessage(
        account,
        {
          to: body.to ?? "",
          cc: body.cc,
          bcc: body.bcc,
          subject: body.subject,
          bodyText: body.bodyText,
          attachments,
        },
        thread,
      );
      await recordAudit({
        companyId: co.id,
        actorEmployeeId: self.id,
        action: "mail.send",
        targetType: "mail_message",
        targetId: sent.id,
        targetLabel: sent.subject || "(no subject)",
        metadata: { via: "mcp", threadId: thread?.id ?? null },
      });
      await journal(
        self.id,
        `Sent an email: "${sent.subject || "(no subject)"}"`,
        `From ${account.address} to ${sent.toEmails}.`,
      );
      res.json({ message: serializeMailMessageForAgent(sent) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Send failed" });
    }
  },
);

// ----- Per-email AI chat: structured action suggestions -----
//
// `suggest_mail_actions` never mutates anything — it stages structured
// suggestions on the turn's MCP token; the per-email chat drains them after
// the turn and renders them as one-click buttons the human executes through
// the ordinary mail routes (with the human's own authority). That is the
// point: a draft-level employee can *propose* a send it isn't allowed to do.

const suggestionLabelSchema = z.string().min(1).max(80);

const suggestedRuleSchema = z
  .object({
    name: z.string().min(1).max(120),
    conditions: z
      .object({
        from: z.string().max(200).optional(),
        to: z.string().max(200).optional(),
        subjectContains: z.string().max(200).optional(),
        bodyContains: z.string().max(200).optional(),
        hasAttachment: z.boolean().optional(),
      })
      .strict(),
    actions: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({ type: z.literal("applyLabel"), labelName: z.string().min(1).max(200) })
            .strict(),
          z.object({ type: z.literal("markRead") }).strict(),
          z.object({ type: z.literal("star") }).strict(),
          z.object({ type: z.literal("archive") }).strict(),
          z
            .object({
              type: z.literal("handToEmployee"),
              employeeId: z.string().uuid(),
              instruction: z.string().min(1).max(4000),
              mode: z.enum(["draft", "reply", "triage"]),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(5),
  })
  .strict();

const mailSuggestionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("reply"),
      label: suggestionLabelSchema,
      threadId: z.string().uuid().optional(),
      to: z.string().max(2000).optional(),
      cc: z.string().max(2000).optional(),
      subject: z.string().max(1000).optional(),
      bodyText: z.string().max(200_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("send_draft"),
      label: suggestionLabelSchema,
      messageId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thread_action"),
      label: suggestionLabelSchema,
      threadId: z.string().uuid(),
      action: z.enum([
        "markRead",
        "markUnread",
        "star",
        "unstar",
        "archive",
        "moveToInbox",
        "trash",
        "applyLabel",
        "removeLabel",
      ]),
      labelName: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("open_thread"),
      label: suggestionLabelSchema,
      threadId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("hand_over"),
      label: suggestionLabelSchema,
      threadId: z.string().uuid(),
      employeeId: z.string().uuid(),
      mode: z.enum(["draft", "reply", "triage"]),
      instruction: z.string().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("create_rule"),
      label: suggestionLabelSchema,
      rule: suggestedRuleSchema,
    })
    .strict(),
]);

const suggestMailActionsSchema = z
  .object({
    accountId: z.string().uuid().optional(),
    suggestions: z.array(mailSuggestionSchema).min(1).max(6),
  })
  .strict();

mcpInternalRouter.post(
  "/tools/suggest_mail_actions",
  validateBody(suggestMailActionsSchema),
  async (req: McpRequest, res: Response) => {
    const co = req.mcpCompany!;
    const token = req.mcpToken!;
    const body = req.body as z.infer<typeof suggestMailActionsSchema>;

    const account = await loadGrantedMailAccount(req, res, body.accountId, "read");
    if (!account) return;

    const threadRepo = AppDataSource.getRepository(MailThread);
    const msgRepo = AppDataSource.getRepository(MailMessage);
    const empRepo = AppDataSource.getRepository(AIEmployee);

    // Validate every reference before staging anything, so the model either
    // gets a clean success or a correctable error — never half a button row.
    // While validating we also snapshot server-verified facts (recipient,
    // subject) onto each suggestion: the client shows those next to the
    // button, so what the human approves is what the server checked — not
    // whatever the model chose to put in the label.
    const requireThread = async (threadId: string): Promise<MailThread | null> => {
      const t = await threadRepo.findOneBy({ id: threadId, accountId: account.id });
      if (!t) {
        res.status(400).json({
          error: `Unknown threadId "${threadId}" on ${account.address} — use ids from search_mail / get_mail_thread.`,
        });
        return null;
      }
      return t;
    };
    const requireEmployee = async (employeeId: string): Promise<AIEmployee | null> => {
      const e = await empRepo.findOneBy({ id: employeeId, companyId: co.id });
      if (!e) {
        res.status(400).json({
          error: `Unknown employeeId "${employeeId}" — use ids from list_employees.`,
        });
        return null;
      }
      return e;
    };

    const staged: Array<Record<string, unknown>> = [];
    for (const s of body.suggestions) {
      const verified: Record<string, unknown> = {};
      if (s.kind === "reply" && !s.threadId && !(s.to && s.subject)) {
        return res.status(400).json({
          error: "A `reply` suggestion needs a `threadId`, or `to` + `subject` for fresh mail.",
        });
      }
      if (
        s.kind === "thread_action" &&
        (s.action === "applyLabel" || s.action === "removeLabel") &&
        !s.labelName
      ) {
        return res
          .status(400)
          .json({ error: "`labelName` is required for applyLabel / removeLabel." });
      }
      if (s.kind === "send_draft") {
        const draft = await msgRepo.findOneBy({
          id: s.messageId,
          accountId: account.id,
        });
        if (!draft || !draft.gmailDraftId) {
          return res.status(400).json({
            error: `messageId "${s.messageId}" is not a draft on ${account.address}.`,
          });
        }
        verified.targetTo = draft.toEmails;
        verified.targetSubject = draft.subject;
      }
      if ("threadId" in s && s.threadId) {
        const thread = await requireThread(s.threadId);
        if (!thread) return;
        if (verified.targetSubject === undefined) {
          verified.targetSubject = thread.subject;
        }
      }
      if (s.kind === "hand_over") {
        const emp = await requireEmployee(s.employeeId);
        if (!emp) return;
        verified.targetEmployeeName = emp.name;
      }
      if (s.kind === "create_rule") {
        for (const a of s.rule.actions) {
          if (a.type === "handToEmployee" && !(await requireEmployee(a.employeeId))) return;
        }
      }
      staged.push({
        id: crypto.randomUUID(),
        accountId: account.id,
        ...s,
        ...verified,
      });
    }

    for (const s of staged) {
      stageSidecarForToken(token, "mail.suggestions", s);
    }
    res.json({
      ok: true,
      staged: body.suggestions.length,
      note: "The buttons will render under your reply in this email's AI chat — mention them briefly instead of repeating their contents.",
    });
  },
);
