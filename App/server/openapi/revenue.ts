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

const ErrorResponse = z
  .object({ error: z.string() })
  .openapi("RevenueErrorResponse");

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
    companyName: z
      .string()
      .describe("Free-text employer, kept even once `customerId` is set."),
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
    kind: z.enum([
      "deal_source",
      "committee_role",
      "partnership_type",
      "partnership_status",
    ]),
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
    fieldType: z.enum([
      "text",
      "number",
      "date",
      "boolean",
      "select",
      "multi_select",
      "url",
    ]),
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
      assignedUserId: z.string().uuid().optional(),
      assignedEmployeeId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: z.object({ rows: z.array(FollowUp) }) } },
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
        .enum([
          "deal_source",
          "committee_role",
          "partnership_type",
          "partnership_status",
        ])
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
    "Each committed Base or CSV import retains its mapping, duplicate decisions, " +
    "source-row-to-native-ID map, status, and reconciliation report.",
  tags: ["Revenue"],
  security: defaultSecurity,
  request: { params: CompanyParam },
  responses: {
    200: {
      description: "OK",
      content: {
        "application/json": {
          schema: z.object({
            rows: z.array(
              z.object({
                id: z.string().uuid(),
                resourceType: z.enum(["contact", "account", "deal", "partnership"]),
                sourceKind: z.enum(["base", "csv"]),
                sourceLabel: z.string(),
                status: z.enum(["completed", "rolled_back", "failed"]),
                mappingJson: z.string(),
                rowMapJson: z.string(),
                reportJson: z.string(),
                rolledBackAt: z.string().datetime().nullable(),
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
