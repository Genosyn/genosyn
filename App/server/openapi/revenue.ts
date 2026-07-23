import { z } from "zod";

import { defaultSecurity, registry } from "./registry.js";

/**
 * Revenue (M32) — contacts, deals, activities, and the revenue reports.
 *
 * Covers the endpoints somebody scripting Genosyn actually reaches for: pushing
 * leads in from a form or a warehouse, moving deals, reading the timeline, and
 * pulling the numbers for a dashboard. Sequences, signals and suppressions are
 * deliberately not documented here yet — they are configuration surfaces driven
 * from the UI, and documenting them would imply a stability promise the shapes
 * have not earned.
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
        "The billable account, once one exists. Null for everyone you have not " +
          "invoiced yet — early on, most of the list.",
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
    mailThreadId: z.string().uuid().nullable(),
    mailMessageId: z.string().uuid().nullable(),
    actorUserId: z.string().uuid().nullable(),
    actorEmployeeId: z.string().uuid().nullable(),
    metaJson: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi("Activity");

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
    "A Contact is a **person**; a Customer is the billable **account** they may or may " +
    "not belong to yet. `customerId` is null for anyone you have not invoiced.",
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
