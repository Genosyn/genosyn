import { z } from "zod";

import { defaultSecurity, registry } from "./registry.js";

/**
 * Revenue (M32) — follow-ups, accounts, contacts, deals, partnerships,
 * documents, migrations, and the revenue reports.
 *
 * Covers the endpoints somebody scripting Genosyn actually reaches for: pushing
 * leads in from a form or a warehouse, moving deals, reading the timeline, and
 * pulling the numbers for a dashboard. Sequences, signals and suppressions
 * remain UI-led configuration surfaces.
 */

const ErrorResponse = z.object({ error: z.string() }).openapi("RevenueErrorResponse");

const CompanyParam = z.object({ cid: z.string().uuid() });

const Contact = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    name: z.string(),
    email: z
      .string()
      .describe(
        "Lowercased and normalized on write. Empty when the contact has no address — " +
          "which is allowed, and why this is not a unique column.",
      ),
    phone: z.string(),
    title: z.string(),
    companyName: z.string().describe("Free-text employer, kept even once `customerId` is set."),
    customerId: z
      .string()
      .uuid()
      .nullable()
      .describe(
        "The company account this person belongs to. Accounts may be prospects, " +
          "customers, or former customers.",
      ),
    lifecycleStage: z.enum([
      "subscriber",
      "lead",
      "qualified",
      "opportunity",
      "customer",
      "churned",
      "unqualified",
    ]),
    ownerId: z.string().uuid().nullable().describe("Human Member who owns the relationship."),
    ownerEmployeeId: z
      .string()
      .uuid()
      .nullable()
      .describe("AI Employee who owns it. Mutually exclusive with `ownerId`."),
    source: z.string(),
    score: z.number().int().describe("0-100. Zero means unscored, not bad."),
    doNotContact: z
      .boolean()
      .describe("Hard opt-out. Blocks mail to every address held for this person."),
    unsubscribedAt: z.string().datetime().nullable(),
    bouncedAt: z.string().datetime().nullable(),
    lastActivityAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Contact");

const ContactList = z
  .object({
    rows: z.array(Contact),
    total: z.number().int().describe("Total matching the filter, ignoring limit/offset."),
  })
  .openapi("ContactList");

const DealStage = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    sortOrder: z.number().int(),
    probability: z.number().int().describe("Default close likelihood, 0-100."),
    kind: z
      .enum(["open", "won", "lost"])
      .describe("Drives `Deal.status`: moving into a won/lost stage closes the deal."),
    color: z.string(),
    description: z.string(),
  })
  .openapi("DealStage");

const Deal = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    title: z.string(),
    description: z.string(),
    customerId: z.string().uuid().nullable(),
    primaryContactId: z.string().uuid().nullable(),
    stageId: z.string().uuid(),
    amountCents: z
      .number()
      .int()
      .describe("Integer minor units of `currency`. Capped at 2,000,000,000."),
    currency: z.string().describe("3-letter ISO 4217 code."),
    probabilityOverride: z
      .number()
      .int()
      .nullable()
      .describe("0-100. Null inherits the stage default, which is the usual case."),
    expectedCloseDate: z.string().datetime().nullable(),
    nextFollowUpAt: z.string().datetime().nullable(),
    followUpReminderAt: z.string().datetime().nullable(),
    status: z
      .enum(["open", "won", "lost"])
      .describe("Always mirrors the current stage's `kind`. Never written directly."),
    closedAt: z
      .string()
      .datetime()
      .nullable()
      .describe("Stamped on first close; preserved if the deal is re-closed."),
    lostReason: z.string(),
    source: z.string(),
    ownerId: z.string().uuid().nullable(),
    ownerEmployeeId: z.string().uuid().nullable(),
    nextStep: z.string(),
    lastActivityAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Deal");

const Activity = z
  .object({
    id: z.string().uuid(),
    kind: z.enum([
      "email_in",
      "email_out",
      "call",
      "meeting",
      "note",
      "task",
      "deal_created",
      "stage_change",
      "deal_won",
      "deal_lost",
      "enrollment",
      "sequence_step",
      "unsubscribe",
      "bounce",
      "signal",
    ]),
    subject: z.string(),
    bodyText: z.string(),
    occurredAt: z
      .string()
      .datetime()
      .describe("When it happened — not when it was recorded. Backfills depend on this."),
    contactId: z.string().uuid().nullable(),
    dealId: z.string().uuid().nullable(),
    customerId: z.string().uuid().nullable(),
    partnershipId: z.string().uuid().nullable(),
    mailThreadId: z.string().uuid().nullable(),
    mailMessageId: z.string().uuid().nullable(),
    actorUserId: z.string().uuid().nullable(),
    actorEmployeeId: z.string().uuid().nullable(),
    taskStatus: z.enum(["open", "completed", "cancelled"]).nullable(),
    dueAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
    assignedUserId: z.string().uuid().nullable(),
    assignedEmployeeId: z.string().uuid().nullable(),
    priority: z.enum(["low", "normal", "high", "urgent"]).nullable(),
    reminderAt: z.string().datetime().nullable(),
    recurrenceRule: z.string().nullable(),
    metaJson: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("Activity");

const RevenueAccount = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    accountStatus: z.enum(["prospect", "customer", "former"]),
    domain: z.string(),
    websiteUrl: z.string(),
    industry: z.string(),
    employeeCount: z.number().int(),
    email: z.string(),
    phone: z.string(),
    currency: z.string(),
    annualContractValueCents: z.number().int(),
    notes: z.string(),
    ownerId: z.string().uuid().nullable(),
    ownerEmployeeId: z.string().uuid().nullable(),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    contactCount: z.number().int().optional(),
    openDealCount: z.number().int().optional(),
  })
  .openapi("RevenueAccount");

const AccountMergeCounts = z
  .object({
    contacts: z.number().int(),
    deals: z.number().int(),
    activities: z.number().int(),
    partnerships: z.number().int(),
    revenueDocuments: z.number().int(),
    signalEvents: z.number().int(),
    billingContacts: z.number().int(),
    contracts: z.number().int(),
    invoices: z.number().int(),
    estimates: z.number().int(),
    recurringInvoices: z.number().int(),
    credits: z.number().int(),
    customValuesCopied: z.number().int(),
    customValueConflicts: z.number().int(),
  })
  .openapi("RevenueAccountMergeCounts");

const AccountMergeFieldConflict = z.object({
  field: z.string(),
  label: z.string(),
  sourceValue: z.unknown(),
  targetValue: z.unknown(),
  resolution: z.enum(["source", "target"]),
  resolvedValue: z.unknown(),
});
const AccountMergeCustomFieldConflict = AccountMergeFieldConflict.extend({
  fieldId: z.string().uuid(),
  fieldKey: z.string(),
});

const AccountMergePreview = z
  .object({
    source: RevenueAccount.pick({
      id: true,
      name: true,
      slug: true,
      archivedAt: true,
    }),
    target: RevenueAccount.pick({
      id: true,
      name: true,
      slug: true,
      archivedAt: true,
    }),
    counts: AccountMergeCounts,
    fieldConflicts: z.array(AccountMergeFieldConflict),
    customFieldConflicts: z.array(AccountMergeCustomFieldConflict),
    operationId: z.string().uuid().optional(),
  })
  .openapi("RevenueAccountMergePreview");

const FollowUp = z
  .object({
    id: z.string().uuid(),
    source: z.enum(["task", "deal", "partnership"]),
    title: z.string(),
    dueAt: z.string().datetime(),
    reminderAt: z.string().datetime().nullable(),
    status: z.enum(["open", "completed", "cancelled"]),
    priority: z.enum(["low", "normal", "high", "urgent"]),
    overdue: z.boolean(),
    dealId: z.string().uuid().nullable(),
    partnershipId: z.string().uuid().nullable(),
    contactId: z.string().uuid().nullable(),
    customerId: z.string().uuid().nullable(),
    assignedUserId: z.string().uuid().nullable(),
    assignedEmployeeId: z.string().uuid().nullable(),
    assigneeName: z.string().nullable(),
    recurrenceRule: z.string().nullable(),
  })
  .openapi("RevenueFollowUp");

const Partnership = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    name: z.string(),
    type: z.string(),
    status: z.string(),
    customerId: z.string().uuid().nullable(),
    websiteUrl: z.string(),
    integrationContext: z.string(),
    channelContext: z.string(),
    notes: z.string(),
    ownerId: z.string().uuid().nullable(),
    ownerEmployeeId: z.string().uuid().nullable(),
    nextFollowUpAt: z.string().datetime().nullable(),
    reminderAt: z.string().datetime().nullable(),
    lastActivityAt: z.string().datetime().nullable(),
    archivedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Partnership");

const RevenueClassification = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["deal_source", "committee_role", "partnership_type", "partnership_status"]),
    value: z.string(),
    label: z.string(),
    sortOrder: z.number().int(),
    archivedAt: z.string().datetime().nullable(),
  })
  .openapi("RevenueClassification");

const RevenueCustomField = z
  .object({
    id: z.string().uuid(),
    resourceType: z.enum(["contact", "account", "deal", "partnership"]),
    key: z.string(),
    name: z.string(),
    fieldType: z.enum(["text", "number", "date", "boolean", "select", "multi_select", "url"]),
    optionsJson: z.string(),
    required: z.boolean(),
    sortOrder: z.number().int(),
    archivedAt: z.string().datetime().nullable(),
  })
  .openapi("RevenueCustomField");

const MrrMovement = z
  .object({
    startingCents: z.number().int(),
    newCents: z.number().int(),
    expansionCents: z.number().int(),
    reactivationCents: z.number().int(),
    contractionCents: z.number().int().describe("Positive magnitude; the sign is in the name."),
    churnCents: z.number().int().describe("Positive magnitude."),
    netCents: z.number().int(),
    endingCents: z.number().int(),
  })
  .openapi("MrrMovement");

const RevenueOverview = z
  .object({
    mrrCents: z.number().int(),
    arrCents: z.number().int(),
    movement: MrrMovement.describe(
      "Guaranteed to balance: ending - starting === net, and the five components sum to net.",
    ),
    openPipelineCents: z.number().int(),
    weightedPipelineCents: z.number().int(),
    winRatePct: z.number().nullable().describe("Null when no deals closed in the period."),
    currency: z.string(),
  })
  .openapi("RevenueOverview");

const commonErrors = {
  401: {
    description: "Not authenticated",
    content: { "application/json": { schema: ErrorResponse } },
  },
  403: {
    description: "Not a member of this company",
    content: { "application/json": { schema: ErrorResponse } },
  },
};

// ───────────────────────────── Contacts ─────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/contacts",
  summary: "List contacts",
  description:
    "People in the revenue system. Sorted by most recent activity, with never-touched " +
    "contacts last — the question this list answers is 'who have I not spoken to'.\n\n" +
    "A Contact is a **person**; a Customer is the **account** they may or may not " +
    "belong to yet. Accounts can be prospects long before anyone is invoiced.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      q: z.string().optional().describe("Substring match over name, email, company and title."),
      lifecycleStage: z.string().optional(),
      customerId: z.string().uuid().optional(),
      ownerId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional().describe("Default 50."),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ContactList } } },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/contacts",
  summary: "Create a contact",
  description:
    "Email is normalized (lowercased, display name stripped) and must be unique within " +
    "the company when non-empty — a duplicate is a **409**, not a silent merge, because " +
    "somebody filling in a form for an existing person wants to be told.\n\n" +
    "A contact with no email is allowed and is not a conflict; plenty of real contacts " +
    "are a name and a phone number.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            email: z.string().optional(),
            phone: z.string().optional(),
            title: z.string().optional(),
            companyName: z.string().optional(),
            customerId: z.string().uuid().nullable().optional(),
            lifecycleStage: z.string().optional(),
            source: z.string().optional(),
            score: z.number().int().min(0).max(100).optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Created", content: { "application/json": { schema: Contact } } },
    409: {
      description: "A contact with that address already exists",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

// ───────────────────── Accounts and follow-ups ──────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/accounts",
  summary: "List revenue accounts",
  description:
    "One company record across the full relationship lifecycle. A prospect account is " +
    "the same Customer row used later for billing; it does not become a finance " +
    "customer until an invoice is issued.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      q: z.string().optional(),
      status: z.enum(["prospect", "customer", "former"]).optional(),
      ownerId: z.string().uuid().optional(),
      ownerEmployeeId: z.string().uuid().optional(),
      customFieldKey: z.string().optional(),
      customFieldValue: z.string().optional(),
      includeArchived: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(RevenueAccount),
            total: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/accounts",
  summary: "Create a prospect or customer account",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            accountStatus: z.enum(["prospect", "customer", "former"]).optional(),
            domain: z.string().optional(),
            websiteUrl: z.string().url().optional(),
            industry: z.string().optional(),
            employeeCount: z.number().int().min(0).optional(),
            ownerId: z.string().uuid().nullable().optional(),
            ownerEmployeeId: z.string().uuid().nullable().optional(),
            notes: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: RevenueAccount } } },
    409: {
      description: "An account with the same normalized domain already exists",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

for (const action of ["archive", "restore"] as const) {
  registry.registerPath({
    method: "post",
    path: `/api/companies/{cid}/revenue/accounts/{id}/${action}`,
    summary: `${action === "archive" ? "Archive" : "Restore"} a revenue account`,
    description:
      action === "archive"
        ? "Hides the Account from default lists without deleting any Revenue or Finance history."
        : "Restores an archived Account. Refuses a normalized-domain collision with an active Account.",
    tags: ["Revenue"],
    security: defaultSecurity,
    request: { params: CompanyParam.extend({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: action === "archive" ? "Archived" : "Restored",
        content: { "application/json": { schema: RevenueAccount } },
      },
      409: {
        description: "The Account cannot be restored safely",
        content: { "application/json": { schema: ErrorResponse } },
      },
      ...commonErrors,
    },
  });
}

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/accounts/{id}/merge-preview",
  summary: "Preview an Account merge",
  description:
    "Counts every Revenue and Finance reference that would move and returns every standard " +
    "and custom-field conflict with its default resolution.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    query: z.object({ targetAccountId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Merge preview",
      content: { "application/json": { schema: AccountMergePreview } },
    },
    409: {
      description: "Source and destination are not safe to merge",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/accounts/{id}/merge",
  summary: "Merge and archive an Account",
  description:
    "Transactionally reparents Revenue and Finance history into an active destination Account, " +
    "applies the supplied source/target conflict resolutions, preserves issued document " +
    "identifiers, archives the source Account, and returns an operation ID for guarded undo.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            targetAccountId: z.string().uuid(),
            confirmSourceName: z.string().min(1).max(120),
            resolutions: z.record(z.enum(["source", "target"])).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Merged",
      content: { "application/json": { schema: AccountMergePreview } },
    },
    409: {
      description: "The merge confirmation or destination is invalid",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

const MergeResourceType = z.enum(["account", "contact", "deal", "partnership"]);
const MergeFieldConflict = AccountMergeFieldConflict;
const MergeCustomFieldConflict = AccountMergeCustomFieldConflict;
const RevenueMergePreview = z
  .object({
    resourceType: MergeResourceType,
    source: z.object({ id: z.string().uuid(), label: z.string(), archivedAt: z.unknown() }),
    target: z.object({ id: z.string().uuid(), label: z.string(), archivedAt: z.unknown() }),
    fieldConflicts: z.array(MergeFieldConflict),
    relationshipCounts: z.record(z.number().int()),
    customValuesCopied: z.number().int(),
    customValueConflicts: z.number().int(),
    customFieldConflicts: z.array(MergeCustomFieldConflict),
    operationId: z.string().uuid().optional(),
  })
  .openapi("RevenueMergePreview");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/records/{resourceType}/{id}/merge-preview",
  summary: "Preview a core Revenue record merge",
  description:
    "Works for Accounts, Contacts, Deals, and Partnerships. Returns field-level conflict " +
    "choices and every relationship count without changing either record.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({
      resourceType: MergeResourceType,
      id: z.string().uuid(),
    }),
    query: z.object({ targetId: z.string().uuid() }),
  },
  responses: {
    200: {
      description: "Merge preview",
      content: { "application/json": { schema: RevenueMergePreview } },
    },
    409: {
      description: "The records cannot be merged safely",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/records/{resourceType}/{id}/merge",
  summary: "Merge a core Revenue record with explicit conflict choices",
  description:
    "Reparents related data, preserves source aliases, archives a redirect tombstone, and " +
    "returns a guarded operation ID that can be undone while its after-state is unchanged.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({
      resourceType: MergeResourceType,
      id: z.string().uuid(),
    }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            targetId: z.string().uuid(),
            confirmSourceLabel: z.string().min(1).max(500),
            resolutions: z.record(z.enum(["source", "target"])).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Merged",
      content: { "application/json": { schema: RevenueMergePreview } },
    },
    409: {
      description: "A conflict or invariant makes the merge unsafe",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/records/{resourceType}/{id}/redirect",
  summary: "Resolve a merged record to its canonical survivor",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({
      resourceType: MergeResourceType,
      id: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: "Canonical redirect",
      content: {
        "application/json": {
          schema: z.object({
            targetId: z.string().uuid(),
            operationId: z.string().uuid(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

const RevenueOperationStatus = z.enum([
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
  "rolled_back",
]);
const RevenueOperation = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["merge", "bulk", "history_import"]),
    resourceType: z.enum(["account", "contact", "deal", "partnership", "follow_up"]),
    status: RevenueOperationStatus,
    idempotencyKey: z.string().nullable(),
    sourceId: z.string().nullable(),
    targetId: z.string().nullable(),
    summaryJson: z.string(),
    completedAt: z.string().datetime(),
    rolledBackAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("RevenueOperation");
const RevenueOperationRow = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    operationId: z.string().uuid(),
    resourceType: z.string(),
    resourceId: z.string(),
    entityType: z.string(),
    action: z.string(),
    status: z.enum(["applied", "skipped", "failed", "rolled_back"]),
    beforeJson: z.string(),
    afterJson: z.string(),
    detail: z.string(),
    sortOrder: z.number().int(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("RevenueOperationRow");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/operations",
  summary: "List reversible Revenue operations",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      kind: z.enum(["merge", "bulk", "history_import"]).optional(),
      resourceType: z.enum(["account", "contact", "deal", "partnership", "follow_up"]).optional(),
      status: RevenueOperationStatus.optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Operation page",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(RevenueOperation), total: z.number().int() }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/operations/{id}",
  summary: "Inspect a Revenue operation and its reconciliation rows",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    query: z.object({
      rowLimit: z.coerce.number().int().min(1).max(500).optional(),
      rowOffset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Operation detail",
      content: {
        "application/json": {
          schema: z.object({
            operation: RevenueOperation,
            rows: z.array(RevenueOperationRow),
            rowTotal: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/operations/{id}/undo",
  summary: "Guardedly undo a completed Revenue operation",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: z.object({ confirm: z.literal("UNDO") }) },
      },
    },
  },
  responses: {
    200: {
      description: "Rolled back",
      content: {
        "application/json": {
          schema: z.object({ operation: RevenueOperation, rolledBack: z.number().int() }),
        },
      },
    },
    409: {
      description: "The operation is not terminal or its after-state has changed",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

const BulkTarget = z.object({
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
  filter: z.record(z.unknown()).optional(),
});
const BulkRequest = z.object({
  resourceType: z.enum(["account", "contact", "deal", "partnership", "follow_up"]),
  target: BulkTarget,
  action: z
    .record(z.unknown())
    .describe(
      "A typed action: assign_owner, set_contact_lifecycle, set_account_status, " +
        "set_custom_fields, archive, move_deal_stage, or update_follow_up.",
    ),
  dryRun: z.boolean().optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
  mode: z.enum(["atomic", "partial"]).optional(),
});
const BulkJobRequest = BulkRequest.extend({
  dryRun: z.literal(false).optional(),
  idempotencyKey: z.string().min(8).max(200),
});
const BulkResult = z
  .object({
    dryRun: z.boolean(),
    matched: z.number().int(),
    valid: z.number().int(),
    applied: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    operationId: z.string().uuid().optional(),
    replayed: z.boolean().optional(),
    rows: z.array(
      z.object({
        resourceType: z.string(),
        resourceId: z.string(),
        source: z.enum(["task", "deal", "partnership"]).optional(),
        label: z.string(),
        status: z.enum(["applied", "valid", "skipped", "failed"]),
        before: z.record(z.unknown()).nullable(),
        after: z.record(z.unknown()).nullable(),
        error: z.string().optional(),
      }),
    ),
  })
  .openapi("RevenueBulkResult");

const BulkJobSubmission = z.object({
  job: RevenueOperation,
  preview: BulkResult,
  replayed: z.boolean(),
});

for (const path of [
  "/api/companies/{cid}/revenue/bulk",
  "/api/companies/{cid}/revenue/bulk/jobs",
] as const) {
  registry.registerPath({
    method: "post",
    path,
    summary: path.endsWith("/jobs")
      ? "Queue an idempotent Revenue bulk job"
      : "Preview or synchronously apply a Revenue bulk operation",
    tags: ["Revenue"],
    security: defaultSecurity,
    request: {
      params: CompanyParam,
      body: {
        content: {
          "application/json": {
            schema: path.endsWith("/jobs") ? BulkJobRequest : BulkRequest,
          },
        },
      },
    },
    responses: {
      200: {
        description: "Preview, replay, or synchronous result",
        content: {
          "application/json": {
            schema: path.endsWith("/jobs") ? BulkJobSubmission : BulkResult,
          },
        },
      },
      ...(path.endsWith("/jobs")
        ? {
            202: {
              description: "Job queued",
              content: {
                "application/json": {
                  schema: BulkJobSubmission,
                },
              },
            },
          }
        : {}),
      409: {
        description: "Validation or idempotency conflict",
        content: { "application/json": { schema: ErrorResponse } },
      },
      ...commonErrors,
    },
  });
}

for (const suffix of ["", "/reconciliation"] as const) {
  registry.registerPath({
    method: "get",
    path: `/api/companies/{cid}/revenue/bulk/jobs/{id}${suffix}`,
    summary: suffix ? "Export a bulk-job reconciliation page" : "Read bulk-job progress",
    tags: ["Revenue"],
    security: defaultSecurity,
    request: {
      params: CompanyParam.extend({ id: z.string().uuid() }),
      query: suffix
        ? z.object({
            format: z.enum(["json", "csv"]).optional(),
            limit: z.coerce.number().int().min(1).max(500).optional(),
            offset: z.coerce.number().int().min(0).optional(),
          })
        : z.object({
            rowLimit: z.coerce.number().int().min(1).max(500).optional(),
            rowOffset: z.coerce.number().int().min(0).optional(),
          }),
    },
    responses: {
      200: {
        description: "Job progress or reconciliation page",
        content: {
          "application/json": {
            schema: z.object({
              operation: RevenueOperation,
              summary: z.record(z.unknown()),
              rows: z.array(z.record(z.unknown())),
              rowTotal: z.number().int(),
            }),
          },
          ...(suffix ? { "text/csv": { schema: z.string() } } : {}),
        },
      },
      ...commonErrors,
    },
  });
}

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/bulk/jobs/{id}/undo",
  summary: "Undo a completed Revenue bulk job",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: z.object({ confirm: z.literal("UNDO") }) },
      },
    },
  },
  responses: {
    200: { description: "Rolled back" },
    409: {
      description: "The job is still running or no longer safe to undo",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/follow-ups",
  summary: "Read the unified follow-up queue",
  description:
    "Returns due task activities, deal follow-up dates, and partnership follow-up dates " +
    "in one chronological queue. `overdue` is computed at read time.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      state: z.enum(["all", "overdue", "today", "upcoming"]).optional(),
      q: z.string().max(200).optional(),
      source: z.enum(["task", "deal", "partnership"]).optional(),
      assignedUserId: z.string().uuid().optional(),
      assignedEmployeeId: z.string().uuid().optional(),
      unassigned: z.coerce.boolean().optional(),
      priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
      status: z.enum(["open", "completed", "cancelled"]).optional(),
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
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(FollowUp),
            nextCursor: z.string().nullable(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/follow-ups",
  summary: "Create an assignable follow-up task",
  description:
    "Creates a task activity with a due date, priority, reminder, assignee, and optional " +
    "daily, weekly, or monthly RRULE recurrence.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            subject: z.string().min(1),
            bodyText: z.string().optional(),
            dueAt: z.string().datetime().nullable().optional(),
            reminderAt: z.string().datetime().nullable().optional(),
            priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
            assignedUserId: z.string().uuid().nullable().optional(),
            assignedEmployeeId: z.string().uuid().nullable().optional(),
            recurrenceRule: z.string().nullable().optional(),
            contactId: z.string().uuid().nullable().optional(),
            dealId: z.string().uuid().nullable().optional(),
            customerId: z.string().uuid().nullable().optional(),
            partnershipId: z.string().uuid().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Activity } } },
    ...commonErrors,
  },
});

// ─────────────────────────────── Deals ───────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/deals",
  summary: "List deals",
  description:
    "Open and closed opportunities. `status` always mirrors the `kind` of the stage the " +
    "deal sits in — it is never set independently, so filtering on either is equivalent.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      q: z.string().optional(),
      status: z.enum(["open", "won", "lost"]).optional(),
      stageId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
      contactId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(Deal), total: z.number().int() }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/stages",
  summary: "List deal stages",
  description:
    "The company's sales process, in board order. Seeds a conventional B2B ladder on " +
    "first read, the same way the finance chart of accounts appears when you first open " +
    "the books.\n\n" +
    "Note the vocabulary: these are **deal stages**, not a 'pipeline'. `Pipeline` means " +
    "the DAG automation primitive elsewhere in Genosyn.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: { params: CompanyParam },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.array(DealStage) } },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/deals/{id}/stage",
  summary: "Move a deal to a stage",
  description:
    "The only way to change a deal's stage. Applies the status invariant — moving into a " +
    "`won` or `lost` stage closes the deal and stamps `closedAt`; moving back to an open " +
    "stage clears both and drops the loss reason. Re-closing preserves the **original** " +
    "close date, so sales-cycle math stays honest.\n\n" +
    "Also writes the activity the funnel report reads to compute stage conversion.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            stageId: z.string().uuid(),
            lostReason: z.string().optional().describe("Recorded when moving to a lost stage."),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: Deal } } },
    404: {
      description: "No such deal, or the stage belongs to another company",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

// ───────────────────────────── Activities ─────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/activities",
  summary: "Read a timeline",
  description:
    "The unified activity timeline, newest first. Most rows are written automatically: " +
    "mail sync matches thread participants against known contacts and records every " +
    "message, so a contact's history is populated without anyone doing data entry.\n\n" +
    "Filter by `contactId`, `dealId` or `customerId`. All three are independent — an " +
    "email to somebody with no open deal carries only `contactId`.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      contactId: z.string().uuid().optional(),
      dealId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(Activity), total: z.number().int() }),
        },
      },
    },
    ...commonErrors,
  },
});

// ───────────── Partnerships, schema, documents, and imports ─────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/partnerships",
  summary: "List partnerships",
  description:
    "Partner relationships stay separate from deals and carry controlled type/status, " +
    "multiple contacts, Reply-All rules, channel context, and their own follow-up date.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      q: z.string().optional(),
      status: z.string().optional(),
      type: z.string().optional(),
      customFieldKey: z.string().optional(),
      customFieldValue: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(Partnership), total: z.number().int() }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/partnerships",
  summary: "Create a partnership",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1),
            type: z.string().optional(),
            status: z.string().optional(),
            websiteUrl: z.string().optional(),
            integrationContext: z.string().optional(),
            channelContext: z.string().optional(),
            notes: z.string().optional(),
            ownerId: z.string().uuid().nullable().optional(),
            ownerEmployeeId: z.string().uuid().nullable().optional(),
            nextFollowUpAt: z.string().datetime().nullable().optional(),
            reminderAt: z.string().datetime().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: Partnership } } },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/classifications",
  summary: "List controlled Revenue classifications",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      kind: z
        .enum(["deal_source", "committee_role", "partnership_type", "partnership_status"])
        .optional(),
      includeArchived: z.coerce.boolean().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(RevenueClassification) }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/custom-fields",
  summary: "List typed Revenue custom fields",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      resourceType: z.enum(["contact", "account", "deal", "partnership"]).optional(),
      includeArchived: z.coerce.boolean().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": { schema: z.object({ rows: z.array(RevenueCustomField) }) },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/documents",
  summary: "List formal Revenue documents",
  description:
    "Links proposals, RFPs, security questionnaires, contracts, uploaded files, mail " +
    "attachments, or external URLs to one Revenue resource.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      dealId: z.string().uuid().optional(),
      customerId: z.string().uuid().optional(),
      partnershipId: z.string().uuid().optional(),
      contactId: z.string().uuid().optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(
              z.object({
                id: z.string().uuid(),
                kind: z.enum([
                  "proposal",
                  "rfp",
                  "security_questionnaire",
                  "contract",
                  "email_attachment",
                  "other",
                ]),
                title: z.string(),
                notes: z.string(),
                attachmentId: z.string().uuid().nullable(),
                sourceMailMessageId: z.string().uuid().nullable(),
                externalUrl: z.string(),
                createdAt: z.string().datetime(),
              }),
            ),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/imports",
  summary: "List Revenue migration batches",
  description:
    "Returns compact batch metadata by default; large row decisions are available through " +
    "the paginated rows and reconciliation endpoints.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      sourceKind: z.enum(["base", "csv"]).optional(),
      status: z.enum(["completed", "rolled_back", "failed"]).optional(),
      resourceType: z
        .enum(["account", "contact", "deal", "partnership", "account_contact_deal"])
        .optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      summaryOnly: z.coerce.boolean().optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(
              z.object({
                id: z.string().uuid(),
                resourceType: z.enum([
                  "contact",
                  "account",
                  "deal",
                  "partnership",
                  "account_contact_deal",
                ]),
                sourceKind: z.enum(["base", "csv"]),
                sourceLabel: z.string(),
                status: z.enum(["completed", "rolled_back", "failed"]),
                rolledBackAt: z.string().datetime().nullable(),
                createdAt: z.string().datetime(),
                updatedAt: z.string().datetime(),
              }),
            ),
            total: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

const RevenueImportRow = z
  .object({
    id: z.string().uuid(),
    batchId: z.string().uuid(),
    resourceType: z.enum(["contact", "account", "deal", "partnership"]),
    sourceId: z.string(),
    nativeId: z.string().nullable(),
    action: z.string(),
    status: z.enum(["created", "matched", "skipped", "failed", "rolled_back"]),
    reason: z.string(),
    decisionJson: z.string(),
    sortOrder: z.number().int(),
  })
  .openapi("RevenueImportRow");

const RevenueImportRowQuery = z.object({
  resourceType: z.enum(["contact", "account", "deal", "partnership"]).optional(),
  status: z.enum(["created", "matched", "skipped", "failed", "rolled_back"]).optional(),
  action: z.string().max(80).optional(),
  q: z.string().max(200).optional(),
  sourceId: z.string().max(300).optional(),
  nativeId: z.string().uuid().optional(),
  error: z.string().max(500).optional(),
  hasError: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

for (const suffix of ["", "/summary"] as const) {
  registry.registerPath({
    method: "get",
    path: `/api/companies/{cid}/revenue/imports/{id}${suffix}`,
    summary: "Read a compact Revenue import summary",
    tags: ["Revenue"],
    security: defaultSecurity,
    request: { params: CompanyParam.extend({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: "Import summary",
        content: {
          "application/json": {
            schema: z.object({
              batch: z.object({
                id: z.string().uuid(),
                resourceType: z.string(),
                sourceKind: z.enum(["base", "csv"]),
                sourceLabel: z.string(),
                status: z.enum(["completed", "rolled_back", "failed"]),
                rolledBackAt: z.string().datetime().nullable(),
                createdAt: z.string().datetime(),
                updatedAt: z.string().datetime(),
              }),
              counts: z.record(z.number().int()),
            }),
          },
        },
      },
      ...commonErrors,
    },
  });
}

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/imports/{id}/rows",
  summary: "Page and filter Revenue import row decisions",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    query: RevenueImportRowQuery,
  },
  responses: {
    200: {
      description: "Filtered import rows",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(RevenueImportRow), total: z.number().int() }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/imports/{id}/reconciliation",
  summary: "Export filtered import reconciliation rows",
  description:
    "Filter failures, skips, duplicates, source IDs, native IDs, actions, or resource type. " +
    "CSV is paginated with the same limit and offset contract as JSON.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    query: RevenueImportRowQuery.extend({ format: z.enum(["json", "csv"]).optional() }),
  },
  responses: {
    200: {
      description: "JSON page or CSV attachment",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(RevenueImportRow), total: z.number().int() }),
        },
        "text/csv": { schema: z.string() },
      },
    },
    ...commonErrors,
  },
});

const RevenueEvidenceSourceType = z.enum([
  "email",
  "document",
  "integration",
  "finance",
  "website",
  "import",
  "manual",
]);
const RevenueFieldEvidence = z
  .object({
    id: z.string().uuid(),
    resourceType: MergeResourceType,
    resourceId: z.string().uuid(),
    fieldKey: z.string(),
    sourceType: RevenueEvidenceSourceType,
    sourceId: z.string(),
    sourceLabel: z.string(),
    extractedValueJson: z.string(),
    normalizedValue: z.string(),
    confidence: z.number().int().min(0).max(100),
    status: z.enum(["proposed", "accepted", "rejected", "superseded"]),
    verificationState: z.enum(["unverified", "verified", "rejected", "superseded"]),
    extractionMethod: z.string(),
    observedAt: z.string().datetime().nullable(),
    extractedAt: z.string().datetime(),
    lastVerifiedAt: z.string().datetime().nullable(),
    verifyingActorType: z.enum(["member", "ai_employee", "system"]).nullable(),
    verifyingActorId: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("RevenueFieldEvidence");

for (const method of ["get", "put"] as const) {
  registry.registerPath({
    method,
    path: "/api/companies/{cid}/revenue/custom-values/{resourceType}/{resourceId}",
    summary:
      method === "get"
        ? "Read typed custom values with current provenance"
        : "Transactionally update typed custom values and provenance",
    description:
      method === "put"
        ? "Unverified evidence cannot directly replace a current value; submit it through the " +
          "evidence review workflow. Manual Member writes are verified."
        : undefined,
    tags: ["Revenue"],
    security: defaultSecurity,
    request: {
      params: CompanyParam.extend({
        resourceType: MergeResourceType,
        resourceId: z.string().uuid(),
      }),
      ...(method === "put"
        ? {
            body: {
              content: {
                "application/json": {
                  schema: z.object({
                    values: z.record(z.unknown()),
                    provenance: z
                      .object({
                        sourceType: RevenueEvidenceSourceType,
                        sourceId: z.string().min(1),
                        sourceLabel: z.string().optional(),
                        extractionMethod: z.string().optional(),
                        confidence: z.number().int().min(0).max(100).optional(),
                        observedAt: z.string().datetime().optional(),
                        verificationState: z.enum(["verified", "unverified"]),
                        lastVerifiedAt: z.string().datetime().nullable().optional(),
                        metadata: z.record(z.unknown()).optional(),
                      })
                      .optional(),
                  }),
                },
              },
            },
          }
        : {}),
    },
    responses: {
      200: {
        description: "Custom values",
        content: {
          "application/json": {
            schema: z.object({
              rows: z.array(
                z.object({
                  field: RevenueCustomField,
                  value: z.unknown().nullable(),
                  provenance: RevenueFieldEvidence.nullable(),
                  provenanceHistoryCount: z.number().int(),
                }),
              ),
            }),
          },
        },
      },
      ...commonErrors,
    },
  });
}

const FollowUpView = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    filters: z.record(z.unknown()),
    sortOrder: z.number(),
    createdByUserId: z.string().uuid().nullable(),
    createdByEmployeeId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("RevenueFollowUpView");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/follow-up-views",
  summary: "List saved follow-up views",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: { params: CompanyParam },
  responses: {
    200: {
      description: "Saved views",
      content: { "application/json": { schema: z.array(FollowUpView) } },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/follow-up-views",
  summary: "Save a reusable follow-up filter",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            name: z.string().min(1).max(120),
            filters: z.record(z.unknown()),
            sortOrder: z.number().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: FollowUpView } },
    },
    ...commonErrors,
  },
});

for (const method of ["patch", "delete"] as const) {
  registry.registerPath({
    method,
    path: "/api/companies/{cid}/revenue/follow-up-views/{id}",
    summary: method === "patch" ? "Update a saved follow-up view" : "Delete a saved follow-up view",
    tags: ["Revenue"],
    security: defaultSecurity,
    request: {
      params: CompanyParam.extend({ id: z.string().uuid() }),
      ...(method === "patch"
        ? {
            body: {
              content: {
                "application/json": {
                  schema: z.object({
                    name: z.string().min(1).max(120).optional(),
                    filters: z.record(z.unknown()).optional(),
                    sortOrder: z.number().optional(),
                  }),
                },
              },
            },
          }
        : {}),
    },
    responses:
      method === "patch"
        ? {
            200: {
              description: "Updated",
              content: { "application/json": { schema: FollowUpView } },
            },
            ...commonErrors,
          }
        : { 204: { description: "Deleted" }, ...commonErrors },
  });
}

const RevenueExportResource = z.enum([
  "accounts",
  "contacts",
  "deals",
  "partnerships",
  "partnership_contacts",
  "buying_committees",
  "follow_ups",
  "documents",
  "stage_definitions",
  "custom_fields",
  "custom_values",
  "import_reconciliation",
]);

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/exports/{resource}",
  summary: "Export a native Revenue dataset page",
  description:
    "Returns stable field names in JSON or CSV. Follow `nextOffset` until null to retrieve " +
    "the complete dataset without a hidden first-page cap.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ resource: RevenueExportResource }),
    query: z.object({
      format: z.enum(["json", "csv"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "JSON page or CSV attachment",
      content: {
        "application/json": {
          schema: z.object({
            resource: RevenueExportResource,
            generatedAt: z.string().datetime(),
            offset: z.number().int(),
            limit: z.number().int(),
            total: z.number().int().nullable(),
            nextOffset: z.number().int().nullable(),
            rows: z.array(z.record(z.unknown())),
          }),
        },
        "text/csv": { schema: z.string() },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/enrichment/domains/propose",
  summary: "Propose canonical Account domains for review",
  description:
    "Generates evidence from safe website resolution and business Contact email domains. " +
    "Public or disposable providers are excluded and collisions become duplicate candidates.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            accountIds: z.array(z.string().uuid()).max(5_000).optional(),
            verifiedContactIds: z.array(z.string().uuid()).max(20_000).optional(),
            followWebsiteRedirects: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Proposal counts",
      content: {
        "application/json": {
          schema: z.object({
            reviewedAccounts: z.number().int(),
            proposed: z.number().int(),
            rejectedPublicProviders: z.number().int(),
            rejectedDisposableProviders: z.number().int(),
            collisions: z.number().int(),
            errors: z.array(z.object({ accountId: z.string(), error: z.string() })),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

for (const source of ["finance", "stripe"] as const) {
  registry.registerPath({
    method: "post",
    path: `/api/companies/{cid}/revenue/enrichment/commercial-values/propose-from-${source}`,
    summary: `Propose Deal values from ${source === "finance" ? "Finance" : "Stripe"}`,
    description:
      source === "finance"
        ? "Requires Revenue access and at least read access to Finance."
        : "Normalizes subscriptions and paid invoices into reviewable recurring or one-time values.",
    tags: ["Revenue"],
    security: defaultSecurity,
    request: {
      params: CompanyParam,
      body: {
        content: {
          "application/json": { schema: z.object({ confirm: z.literal("PROPOSE") }) },
        },
      },
    },
    responses: {
      200: {
        description: "Proposal summary",
        content: { "application/json": { schema: z.record(z.unknown()) } },
      },
      ...commonErrors,
    },
  });
}

const CommercialValue = z.object({
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
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/enrichment/commercial-values/proposals",
  summary: "Create a verified commercial-value proposal",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            dealId: z.string().uuid(),
            sourceType: z.enum(["email", "document", "integration", "finance", "manual"]),
            sourceId: z.string().min(1).max(500),
            sourceLabel: z.string().max(500).optional(),
            sourceVerified: z.literal(true),
            confidence: z.number().int().min(0).max(100),
            extractedAt: z.string().datetime().optional(),
            value: CommercialValue,
            metadata: z.unknown().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Proposed",
      content: { "application/json": { schema: RevenueFieldEvidence } },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/enrichment/evidence",
  summary: "Page Revenue field evidence",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      resourceType: MergeResourceType.optional(),
      resourceId: z.string().uuid().optional(),
      fieldKey: z.string().optional(),
      sourceType: RevenueEvidenceSourceType.optional(),
      status: z.enum(["proposed", "accepted", "rejected", "superseded"]).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Evidence page",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(RevenueFieldEvidence), total: z.number().int() }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/enrichment/evidence/{id}/review",
  summary: "Accept, reject, or supersede Revenue field evidence",
  description:
    "Acceptance updates the record and evidence atomically. Replacing a different verified " +
    "value requires the explicit `supersedeExisting` flag.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            decision: z.enum(["accept", "reject"]),
            supersedeExisting: z.boolean().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Reviewed",
      content: { "application/json": { schema: RevenueFieldEvidence } },
    },
    409: {
      description: "Evidence is stale, already reviewed, or conflicts with a verified value",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

const RevenueDuplicateCandidate = z
  .object({
    id: z.string().uuid(),
    resourceType: MergeResourceType,
    leftId: z.string().uuid(),
    rightId: z.string().uuid(),
    score: z.number().int().min(0).max(100),
    reasonsJson: z.string(),
    status: z.enum(["open", "dismissed", "merged"]),
    mergeOperationId: z.string().uuid().nullable(),
    detectedAt: z.string().datetime(),
    resolvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("RevenueDuplicateCandidate");

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/duplicates/scan",
  summary: "Reconcile persistent duplicate candidates",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: { "application/json": { schema: z.object({ confirm: z.literal("SCAN") }) } },
    },
  },
  responses: {
    200: {
      description: "Scan summary",
      content: {
        "application/json": {
          schema: z.object({
            created: z.number().int(),
            updated: z.number().int(),
            unchanged: z.number().int(),
            closed: z.number().int(),
            evaluatedPairs: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/duplicates",
  summary: "List persistent duplicate candidates",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      resourceType: MergeResourceType.optional(),
      status: z.enum(["open", "dismissed", "merged"]).optional(),
      minScore: z.coerce.number().int().min(0).max(100).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Candidate page",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(RevenueDuplicateCandidate),
            total: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/duplicates/{id}/dismiss",
  summary: "Dismiss a duplicate candidate without forgetting that decision",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": { schema: z.object({ confirm: z.literal("DISMISS") }) },
      },
    },
  },
  responses: {
    200: {
      description: "Dismissed",
      content: { "application/json": { schema: RevenueDuplicateCandidate } },
    },
    ...commonErrors,
  },
});

const RevenueDocumentCandidate = z
  .object({
    id: z.string().uuid(),
    mailMessageId: z.string().uuid(),
    attachmentIndex: z.number().int(),
    gmailMessageId: z.string(),
    gmailThreadId: z.string(),
    gmailAttachmentId: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    contentHash: z.string(),
    proposedKind: z.string(),
    proposedResourceType: MergeResourceType.nullable(),
    proposedResourceId: z.string().uuid().nullable(),
    confidence: z.number().int().min(0).max(100),
    alternativesJson: z.string(),
    status: z.enum(["pending", "processing", "accepted", "rejected", "duplicate"]),
    processingAt: z.string().datetime().nullable(),
    revenueDocumentId: z.string().uuid().nullable(),
    reviewNote: z.string(),
    reviewedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("RevenueDocumentCandidate");

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/document-capture/scan",
  summary: "Scan mirrored Gmail attachments for Revenue documents",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            accountId: z.string().uuid().optional(),
            from: z.string().datetime().optional(),
            to: z.string().datetime().optional(),
            limit: z.number().int().min(1).max(500).optional(),
            offset: z.number().int().min(0).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Scan summary",
      content: {
        "application/json": {
          schema: z.object({
            scannedMessages: z.number().int(),
            createdCandidates: z.number().int(),
            skippedAttachments: z.number().int(),
            nextOffset: z.number().int().nullable(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/document-capture/candidates",
  summary: "List Gmail document-capture candidates",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      status: z.enum(["pending", "processing", "accepted", "rejected", "duplicate"]).optional(),
      accountId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Candidate page",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(RevenueDocumentCandidate),
            total: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/document-capture/candidates/{id}/review",
  summary: "Accept or reject a Gmail document candidate",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam.extend({ id: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.union([
            z.object({ decision: z.literal("reject"), note: z.string().optional() }),
            z.object({
              decision: z.literal("accept"),
              kind: z
                .enum([
                  "proposal",
                  "rfp",
                  "security_questionnaire",
                  "contract",
                  "email_attachment",
                  "other",
                ])
                .optional(),
              resourceType: MergeResourceType.optional(),
              resourceId: z.string().uuid().optional(),
              note: z.string().optional(),
            }),
          ]),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Reviewed",
      content: { "application/json": { schema: RevenueDocumentCandidate } },
    },
    409: {
      description: "Candidate is stale, already reviewed, or duplicates a captured file",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

const HistoricalDealEventInput = z
  .object({
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
  })
  .openapi("HistoricalDealEventInput");

const HistoricalDealImportRows = z
  .array(
    z.object({
      sourceRecordId: z.string().min(1).max(300),
      dealId: z.string().uuid(),
      historyCompleteness: z.enum(["complete", "partial", "snapshot_only"]),
      originalCreatedAt: z.string().datetime().optional(),
      initialStageId: z.string().uuid().nullable().optional(),
      snapshotAt: z.string().datetime().optional(),
      events: z.array(HistoricalDealEventInput).max(2_000),
    }),
  )
  .min(1)
  .max(200);

const HistoricalDealImportBase = {
  batchKey: z.string().min(8).max(200),
  sourceSystem: z.string().min(1).max(200),
  rows: HistoricalDealImportRows,
};

const HistoricalDealImportRequest = z.union([
  z.object({
    ...HistoricalDealImportBase,
    dryRun: z.literal(false),
    confirm: z.literal("IMPORT"),
  }),
  z.object({
    ...HistoricalDealImportBase,
    dryRun: z.literal(true).default(true),
    confirm: z.literal("IMPORT").optional(),
  }),
]);

const HistoricalDealImportSummary = z
  .object({
    batchKey: z.string(),
    sourceSystem: z.string(),
    dryRun: z.boolean(),
    operationId: z.string().uuid().optional(),
    replayed: z.boolean().optional(),
    imported: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    reordered: z.number().int(),
    conflicting: z.number().int(),
    duplicates: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    rows: z.array(
      z.object({
        sourceId: z.string(),
        dealId: z.string().uuid(),
        historyCompleteness: z.enum(["complete", "partial", "snapshot_only"]),
        status: z.enum(["ready", "imported", "partial", "failed", "skipped"]),
        imported: z.number().int(),
        skipped: z.number().int(),
        errors: z.array(z.string()),
        decisions: z.array(
          z.object({
            sourceId: z.string(),
            kind: z.string(),
            occurredAt: z.string().datetime(),
            status: z.enum(["accepted", "rejected", "duplicate", "conflicting"]),
            reordered: z.boolean(),
            reason: z.string().optional(),
          }),
        ),
      }),
    ),
  })
  .openapi("HistoricalDealImportSummary");

const DealHistoryKind = z.enum([
  "created",
  "snapshot",
  "stage_changed",
  "amount_changed",
  "owner_changed",
  "expected_close_changed",
  "won",
  "lost",
]);
const DealHistoryEvent = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    dealId: z.string().uuid(),
    kind: DealHistoryKind,
    occurredAt: z.string().datetime(),
    fromStageId: z.string().uuid().nullable(),
    toStageId: z.string().uuid().nullable(),
    fromAmountCents: z.number().int().nullable(),
    toAmountCents: z.number().int().nullable(),
    currency: z.string(),
    fromOwnerId: z.string().uuid().nullable(),
    fromOwnerEmployeeId: z.string().uuid().nullable(),
    toOwnerId: z.string().uuid().nullable(),
    toOwnerEmployeeId: z.string().uuid().nullable(),
    lostReason: z.string(),
    sourceKind: z.enum(["live", "import", "activity_backfill"]),
    sourceKey: z.string(),
    sourceActivityId: z.string().uuid().nullable(),
    metadataJson: z.string(),
    createdByUserId: z.string().uuid().nullable(),
    createdByEmployeeId: z.string().uuid().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("DealHistoryEvent");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/deal-history",
  summary: "List immutable Deal history",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      dealId: z.string().uuid().optional(),
      sourceKind: z.enum(["live", "import", "activity_backfill"]).optional(),
      kind: DealHistoryKind.optional(),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: "Historical event page",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(DealHistoryEvent),
            total: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/deal-history/backfill-activities",
  summary: "Backfill Deal history from existing Activities",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({ confirm: z.literal("BACKFILL") }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Backfill result",
      content: {
        "application/json": {
          schema: z.object({
            imported: z.number().int(),
            skipped: z.number().int(),
          }),
        },
      },
    },
    ...commonErrors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/revenue/deal-history/import",
  summary: "Preview or import historical Deal events",
  description:
    "Dry-run by default. Classifies every source event as accepted, rejected, reordered, " +
    "conflicting, or duplicate while preserving its effective timestamp. A committed batch " +
    "requires `confirm: IMPORT`, never overlaps native history, and returns a guarded " +
    "Revenue operation ID for import-scoped undo.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    body: {
      content: {
        "application/json": {
          schema: HistoricalDealImportRequest,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Preview or clean import",
      content: { "application/json": { schema: HistoricalDealImportSummary } },
    },
    207: {
      description: "Preview or import containing rejected or conflicting rows",
      content: { "application/json": { schema: HistoricalDealImportSummary } },
    },
    409: {
      description: "Batch-key conflict",
      content: { "application/json": { schema: ErrorResponse } },
    },
    ...commonErrors,
  },
});

// ────────────────────────────── Reports ──────────────────────────────

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/revenue/reports/overview",
  summary: "Revenue overview",
  description:
    "The headline numbers: MRR and its movement, ARR, open and weighted pipeline, and " +
    "win rate.\n\n" +
    "The movement figures are guaranteed to balance — `ending - starting === net`, and " +
    "the five components sum to `net`. A brand-new company returns zeros rather than " +
    "nulls or an error.\n\n" +
    "**On CAC:** where the reports expose acquisition cost, ad spend is read from " +
    "`AdSpendEvent`, which records *authorized budget changes* rather than settled " +
    "platform spend. Treat it as a proxy.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: {
    params: CompanyParam,
    query: z.object({
      from: z.string().optional().describe("ISO date. Defaults to the start of the month."),
      to: z.string().optional().describe("ISO date, exclusive."),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: RevenueOverview } },
    },
    ...commonErrors,
  },
});
