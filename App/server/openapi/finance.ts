import { z } from "zod";
import {
  estimateBulkSchema,
  estimateCreateSchema,
  estimatePatchSchema,
  invoiceBulkSchema,
  invoiceCreateSchema,
  invoicePatchSchema,
  recurringInvoiceBulkSchema,
  recurringInvoiceCreateSchema,
  recurringInvoicePatchSchema,
} from "../routes/finance.js";
import { subsidiaryWriteSchema } from "../routes/subsidiaries.js";
import { bankingQueueQuerySchema } from "../services/bankingQueue.js";
import { ledgerReviewQuerySchema } from "../services/transactionReviews.js";
import { withIndefiniteArticle } from "../../shared/indefiniteArticle.js";
import { defaultSecurity, registry } from "./registry.js";

const companyParams = z.object({ cid: z.string().uuid() });
const documentParams = companyParams.extend({ slug: z.string() });
const errorResponse = z.object({ error: z.string() });

const issuerSnapshot = subsidiaryWriteSchema.required().openapi("DocumentIssuerSnapshot", {
  description:
    "Legal issuer details copied from the selected subsidiary when the draft is created or its issuer changes. Profile edits and archiving do not change this saved identity.",
});
const subsidiary = issuerSnapshot
  .extend({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    archived: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Subsidiary");

const subsidiarySelection = z
  .string()
  .uuid()
  .nullable()
  .describe(
    "Issuing legal entity within this company. Null uses the company default issuer. Only an active subsidiary can be selected for a new document.",
  );
const documentIdentity = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    slug: z.string(),
    customerId: z.string().uuid().nullable(),
    subsidiaryId: subsidiarySelection,
    issuerSnapshot: issuerSnapshot.nullable(),
    number: z.string(),
    currency: z.string(),
    issueDate: z.string().datetime(),
    subtotalCents: z.number().int(),
    taxCents: z.number().int(),
    totalCents: z.number().int(),
    notes: z.string(),
    footer: z.string(),
  })
  .passthrough();
const invoiceResponse = documentIdentity
  .extend({
    status: z.enum(["draft", "sent", "paid", "void"]),
    dueDate: z.string().datetime(),
    archivedAt: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "When the invoice was archived out of the default lists, or null. Archiving never changes its status, payments, or balance.",
      ),
    recurringInvoiceId: z
      .string()
      .uuid()
      .nullable()
      .describe(
        "The recurring invoice schedule that created this invoice, by a scheduled run or Run now, or null for an invoice made any other way. Deleting the schedule clears it.",
      ),
    recurringInvoice: z
      .object({ id: z.string().uuid(), name: z.string(), slug: z.string() })
      .nullable()
      .describe("The schedule named by recurringInvoiceId, or null."),
  })
  .openapi("FinanceInvoice");
const invoiceListItem = invoiceResponse
  .extend({
    linesCount: z.number().int(),
    paymentsCount: z.number().int(),
  })
  .openapi("FinanceInvoiceListItem");
const estimateResponse = documentIdentity
  .extend({
    status: z.enum(["draft", "sent", "accepted", "declined", "void"]),
    validUntil: z.string().datetime(),
    archivedAt: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "When the estimate was archived out of the default lists, or null. Archiving never changes its status.",
      ),
  })
  .openapi("FinanceEstimate");
const estimateBulkResult = z
  .object({
    action: z.enum(["archive", "restore"]),
    succeeded: z.array(z.string().uuid()).describe("Estimates whose archived state changed."),
    skipped: z
      .array(z.object({ id: z.string(), reason: z.string() }))
      .describe("Ids left as they were, each with the reason."),
  })
  .openapi("FinanceEstimateBulkResult");
const invoiceBulkResult = z
  .object({
    action: z.enum(["archive", "restore"]),
    succeeded: z.array(z.string().uuid()).describe("Invoices whose archived state changed."),
    skipped: z
      .array(z.object({ id: z.string(), reason: z.string() }))
      .describe("Ids left as they were, each with the reason."),
  })
  .openapi("FinanceInvoiceBulkResult");
const recurringBulkResult = z
  .object({
    action: z.enum(["archive", "restore"]),
    succeeded: z.array(z.string().uuid()).describe("Schedules whose archived state changed."),
    skipped: z
      .array(z.object({ id: z.string(), reason: z.string() }))
      .describe("Ids left as they were, each with the reason."),
  })
  .openapi("FinanceRecurringInvoiceBulkResult");
const recurringResponse = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    slug: z.string(),
    name: z.string(),
    subsidiaryId: subsidiarySelection,
    customerId: z.string().uuid().nullable(),
    status: z.enum(["active", "paused", "ended"]),
    cronExpr: z.string(),
    frequency: z.enum(["daily", "weekly", "monthly", "quarterly", "yearly"]),
    intervalCount: z.number().int(),
    autoSend: z.boolean(),
    currency: z.string(),
    daysUntilDue: z.number().int(),
    notes: z.string(),
    footer: z.string(),
    archivedAt: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "When the paused or ended schedule was archived out of the default lists, or null. Resuming a schedule clears it.",
      ),
  })
  .passthrough()
  .openapi("FinanceRecurringInvoice");

const errors = {
  400: {
    description: "Invalid input or unavailable subsidiary",
    content: { "application/json": { schema: errorResponse } },
  },
  401: { description: "Authentication required" },
  403: { description: "Insufficient company or Finance access" },
  404: { description: "Record not found in this company" },
};

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/finance/subsidiaries",
  summary: "List the company's legal entities",
  description:
    "Requires Read Finance access. Includes active and archived subsidiaries. Archived subsidiaries remain available for historical document details but cannot be chosen for new documents.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: { params: companyParams },
  responses: {
    200: {
      description: "Company subsidiaries",
      content: { "application/json": { schema: z.array(subsidiary) } },
    },
    ...errors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/finance/subsidiaries",
  summary: "Add an issuing legal entity",
  description:
    "Requires an owner or admin and full Finance access. The new subsidiary can be selected when creating invoices, estimates, or recurring invoice schedules.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams,
    body: { required: true, content: { "application/json": { schema: subsidiaryWriteSchema } } },
  },
  responses: {
    201: {
      description: "Subsidiary created",
      content: { "application/json": { schema: subsidiary } },
    },
    ...errors,
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{cid}/finance/subsidiaries/{id}",
  summary: "Edit or archive an issuing legal entity",
  description:
    "Requires an owner or admin and full Finance access. Set archived to true to remove a subsidiary from new-document selection, or false to restore it. Existing invoice and estimate issuer snapshots remain unchanged. Recurring schedules use the profile when generating each invoice and refuse an archived issuer.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams.extend({ id: z.string().uuid() }),
    body: {
      required: true,
      content: {
        "application/json": {
          schema: subsidiaryWriteSchema.partial().extend({ archived: z.boolean().optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Subsidiary updated",
      content: { "application/json": { schema: subsidiary } },
    },
    ...errors,
  },
});

for (const document of [
  {
    path: "invoices",
    label: "invoice",
    create: invoiceCreateSchema,
    patch: invoicePatchSchema,
    patchDescription:
      "Requires full Finance access. A draft takes any change. Changing subsidiaryId saves fresh issuer details; null restores the company default. Omitting the field or retaining its current value preserves the saved snapshot. Sending discountPercent or discountAmountCents replaces the whole-document discount (the other becomes zero; zero for both removes it). A sent or paid invoice stays editable so it can be corrected and resent under the same number, but its customer and issuer cannot change. Its total must stay positive and cannot drop below what is already paid, credited, or written off; once money is applied its currency is fixed, as is the issue date of a foreign-currency invoice. A change to an issued invoice's amounts (lines or discount), currency, or issue date posts an invoice_revision journal entry and is refused inside a closed period. Editing never emails the customer; resend it with the send endpoint.",
    response: invoiceResponse,
  },
  {
    path: "estimates",
    label: "estimate",
    create: estimateCreateSchema,
    patch: estimatePatchSchema,
    patchDescription:
      "Requires full Finance access. A draft takes any change. Changing subsidiaryId saves fresh issuer details; null restores the company default. Omitting the field or retaining its current value preserves the saved snapshot. Sending discountPercent or discountAmountCents replaces the whole-document discount (the other becomes zero; zero for both removes it). A sent or accepted estimate stays editable so it can be revised and resent under the same number, but its customer and issuer cannot change, and any change to an accepted estimate returns it to sent. Declined, voided, and converted estimates cannot be edited. Editing never emails the customer; resend it with the send endpoint.",
    response: estimateResponse,
  },
] as const) {
  registry.registerPath({
    method: "post",
    path: `/api/companies/{cid}/${document.path}`,
    summary: `Create a draft ${document.label}`,
    description:
      "Requires full Finance access. Pass subsidiaryId to select an active legal entity in this company; omit it or pass null for the company default. Subsidiary details are saved on the draft and used in its email and PDF. Pass discountPercent (0–100) or discountAmountCents, not both, for a discount on the whole document taken before tax; subtotalCents in the response is already net of discountCents. Creating a draft does not issue or email it.",
    tags: ["Finance"],
    security: defaultSecurity,
    request: {
      params: companyParams,
      body: { required: true, content: { "application/json": { schema: document.create } } },
    },
    responses: {
      200: {
        description: "Draft created with hydrated document details",
        content: { "application/json": { schema: document.response } },
      },
      ...errors,
    },
  });
  registry.registerPath({
    method: "patch",
    path: `/api/companies/{cid}/${document.path}/{slug}`,
    summary: `Edit ${withIndefiniteArticle(document.label)}`,
    description: document.patchDescription,
    tags: ["Finance"],
    security: defaultSecurity,
    request: {
      params: documentParams,
      body: { required: true, content: { "application/json": { schema: document.patch } } },
    },
    responses: {
      200: {
        description: "Updated hydrated document",
        content: { "application/json": { schema: document.response } },
      },
      ...errors,
      409: {
        description:
          "The document can no longer be edited, or the requested change is locked after issue",
        content: { "application/json": { schema: errorResponse } },
      },
    },
  });
}

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/estimates/bulk",
  summary: "Archive or restore estimates",
  description:
    "Requires full Finance access. Send action archive to file up to 500 estimates out of the default lists, or restore to bring archived estimates back. Archiving changes no status, number, PDF, or converted invoice, and archived estimates still open by slug. Ids that are not this company's estimates, or are already in the requested state, are returned in skipped instead of failing the request. List estimates with archived=true to include archived ones.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams,
    body: { required: true, content: { "application/json": { schema: estimateBulkSchema } } },
  },
  responses: {
    200: {
      description: "Which estimates changed and which were skipped",
      content: { "application/json": { schema: estimateBulkResult } },
    },
    ...errors,
    400: {
      description: "Unknown action, or ids missing, malformed, or more than 500",
      content: { "application/json": { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/invoices",
  summary: "List invoices",
  description:
    "Requires Read Finance access. Newest first, without line items or payments; fetch one invoice by slug for those. Filter by status, customerId, recurringInvoiceId for the invoices one recurring invoice schedule created, issue date (from/to) or due date (dueFrom/dueTo); a YYYY-MM-DD bound is a whole UTC calendar day. Archived invoices are left out unless archived=true, which includes them alongside the rest. Without limit or cursor the answer is every matching invoice as a plain array. With either it is one page — the list the list_invoices AI tool reads: up to limit invoices (default 50, at most 100), total, hasMore, and nextCursor to send back as cursor with the same filters.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams,
    query: z.object({
      status: z.enum(["draft", "sent", "paid", "void"]).optional(),
      customerId: z.string().uuid().optional(),
      recurringInvoiceId: z
        .string()
        .uuid()
        .optional()
        .describe("Only the invoices this recurring invoice schedule created."),
      archived: z
        .enum(["true", "false"])
        .optional()
        .describe("true includes archived invoices alongside the rest."),
      from: z.string().optional().describe("Issued on or after: YYYY-MM-DD or an ISO timestamp."),
      to: z.string().optional().describe("Issued on or before; YYYY-MM-DD includes the whole day."),
      dueFrom: z.string().optional().describe("Due on or after."),
      dueTo: z.string().optional().describe("Due on or before; YYYY-MM-DD includes the whole day."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Asks for one page of this many (at most 100; more is cut to 100)."),
      cursor: z
        .string()
        .optional()
        .describe("nextCursor from the previous page, with exactly the same filters."),
    }),
  },
  responses: {
    200: {
      description: "Every matching invoice, or one page of them when limit or cursor is sent",
      content: {
        "application/json": {
          schema: z.union([
            z.array(invoiceListItem),
            z
              .object({
                total: z.number().int(),
                hasMore: z.boolean(),
                nextCursor: z.string().nullable(),
                note: z.string().optional(),
                invoices: z.array(invoiceListItem),
              })
              .openapi("FinanceInvoicePage"),
          ]),
        },
      },
    },
    ...errors,
  },
});

const statsDocuments = z
  .object({
    count: z.number().int().describe("How many documents the figure counts."),
    amountCents: z
      .number()
      .int()
      .describe("What they come to in the home currency, in minor units."),
    ids: z
      .array(z.string().uuid())
      .describe("The documents themselves, for a list to filter to exactly these."),
  })
  .openapi("FinanceStatsDocuments");
const statsCustomer = statsDocuments
  .extend({ id: z.string().uuid(), name: z.string(), slug: z.string() })
  .openapi("FinanceStatsCustomer");
const statsClock = {
  currency: z.string().describe("The company's home currency. Every amount is in it."),
  timeZone: z
    .string()
    .describe(
      "The IANA time zone day boundaries were read in: the company's, or the server's when it has none.",
    ),
  today: z.string().describe("Today in that time zone, as YYYY-MM-DD."),
};
const invoiceStatsResponse = z
  .object({
    ...statsClock,
    issuedInvoices: z.number().int().describe("Invoices ever issued and not voided."),
    outstanding: statsDocuments
      .extend({ customers: z.number().int().describe("Distinct customers who owe it.") })
      .describe(
        "What issued invoices still have due after payments, credit applied, and write-offs, tax included, each at the rate it locked when issued.",
      ),
    ageing: z
      .array(
        statsDocuments.extend({ bucket: z.enum(["current", "1-30", "31-60", "61-90", "90+"]) }),
      )
      .describe(
        "Outstanding by days past the due date, every band in order. current is not yet due; an invoice is overdue from the day after its due date.",
      ),
    overdue: statsDocuments
      .extend({
        oldest: z
          .object({
            id: z.string().uuid(),
            number: z.string(),
            slug: z.string(),
            daysLate: z.number().int(),
          })
          .nullable()
          .describe("The invoice overdue longest, or null with nothing overdue."),
      })
      .describe("Outstanding invoices past their due date."),
    dueSoon: statsDocuments
      .extend({ days: z.number().int() })
      .describe("Outstanding invoices due today or within the next `days` days."),
    paid: statsDocuments
      .extend({
        days: z.number().int(),
        previousCents: z
          .number()
          .int()
          .describe("What came in over the same number of days just before."),
        previousCount: z.number().int(),
      })
      .describe(
        "Payments dated within the last `days` days, today included, at the rate each payment locked; count and ids are the invoices they paid, archived ones included.",
      ),
    daysToPay: z
      .object({
        days: z.number().int(),
        averageDays: z
          .number()
          .nullable()
          .describe("Average days from issue date to last payment, or null with none."),
        count: z.number().int(),
        ids: z.array(z.string().uuid()),
      })
      .describe("Invoices paid in full whose last payment is dated within the last `days` days."),
    largestCustomer: statsCustomer
      .nullable()
      .describe("The customer who owes the most, or null with nothing outstanding."),
    converted: z
      .array(z.string())
      .describe("Other currencies counted, each document at its own locked rate."),
    unconverted: z
      .array(z.object({ currency: z.string(), invoices: z.number().int() }))
      .describe("Currencies with no rate into the home currency, left out of every figure."),
  })
  .openapi("FinanceInvoiceStats");
const estimateStatsResponse = z
  .object({
    ...statsClock,
    issuedEstimates: z.number().int().describe("Estimates ever issued and not voided."),
    open: statsDocuments
      .extend({ customers: z.number().int() })
      .describe(
        "Sent estimates within their valid-until date that are not yet accepted, declined, or invoiced, tax included. Archived estimates are left out.",
      ),
    expiringSoon: statsDocuments
      .extend({
        days: z.number().int(),
        firstValidUntil: z.string().nullable().describe("The soonest valid-until date, YYYY-MM-DD."),
      })
      .describe("Open estimates valid until today or within the next `days` days."),
    acceptedNotInvoiced: statsDocuments
      .extend({
        oldestDaysWaiting: z
          .number()
          .int()
          .nullable()
          .describe("Days since the longest-waiting one was accepted."),
      })
      .describe(
        "Accepted estimates not yet converted to an invoice. An accepted estimate never expires. Archived estimates are left out.",
      ),
    recent: z
      .object({
        days: z.number().int(),
        outcomes: z
          .array(
            statsDocuments.extend({
              outcome: z.enum(["invoiced", "accepted", "open", "expired", "declined"]),
            }),
          )
          .describe(
            "Estimates issued within the last `days` days by where each stands now, every outcome in order. A converted estimate counts as invoiced; an archived one counts only once decided.",
          ),
        acceptance: z
          .object({
            accepted: z.number().int().describe("Accepted or invoiced."),
            decided: z.number().int().describe("Accepted, invoiced, declined, or expired."),
            ids: z.array(z.string().uuid()),
          })
          .describe("The acceptance rate is accepted over decided; open estimates don't count."),
        lost: statsDocuments
          .extend({ declined: z.number().int(), expired: z.number().int() })
          .describe("Declined or expired."),
      })
      .describe("How the estimates issued within the last `days` days went."),
    largestCustomer: statsCustomer
      .nullable()
      .describe("The customer with the most open, or null with nothing open."),
    converted: z
      .array(z.string())
      .describe("Other currencies counted, each estimate at the rate on file for its issue date."),
    unconverted: z
      .array(z.object({ currency: z.string(), estimates: z.number().int() }))
      .describe("Currencies with no rate into the home currency, left out of every figure."),
  })
  .openapi("FinanceEstimateStats");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/invoices/stats",
  operationId: "getInvoiceStats",
  summary: "Sum up the company's invoices",
  description:
    "Requires Read Finance access. The figures Finance → Invoices leads with, in the home currency: what issued invoices still have due after payments, credit, and write-offs, tax included, aged by days past the due date; what is overdue and what falls due in the next 30 days; payments dated in the last 30 days against the 30 before; and the average days from issue to last payment for invoices paid in full in the last 90 days. Each invoice converts at the rate it locked when issued and each payment at the rate it locked the day it was paid. Days are calendar days in the company's time zone: an invoice is overdue from the day after its due date. Drafts and voided invoices count nowhere. Every figure carries the ids of the invoices it counts.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: { params: companyParams },
  responses: {
    200: {
      description: "The invoice figures",
      content: { "application/json": { schema: invoiceStatsResponse } },
    },
    ...errors,
    400: {
      description: "The request named a query parameter; this operation takes none",
      content: { "application/json": { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/estimates/stats",
  operationId: "getEstimateStats",
  summary: "Sum up the company's estimates",
  description:
    "Requires Read Finance access. The figures Finance → Estimates leads with, in the home currency: the open estimates (sent, within their valid-until date, and not yet accepted, declined, or invoiced), tax included; those expiring in the next 14 days; accepted estimates not yet invoiced; and the estimates issued in the last 90 days by where each stands now, with the acceptance rate of those decided and the declined or expired ones. An estimate in another currency converts at the rate on file for its issue date, or the latest rate when none is that old. Days are calendar days in the company's time zone. Drafts and voided estimates count nowhere; archived ones count only in the 90-day figures, once decided. Every figure carries the ids of the estimates it counts.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: { params: companyParams },
  responses: {
    200: {
      description: "The estimate figures",
      content: { "application/json": { schema: estimateStatsResponse } },
    },
    ...errors,
    400: {
      description: "The request named a query parameter; this operation takes none",
      content: { "application/json": { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/invoices/bulk",
  summary: "Archive or restore invoices",
  description:
    "Requires full Finance access. Send action archive to file up to 500 invoices out of the default lists, or restore to bring archived invoices back. Only an invoice with nothing left to collect can be archived: a draft, a void invoice, or an issued one that is paid, credited, or written off. Archiving changes no status, number, payment, PDF, or ledger entry, archived invoices still open by slug, and they still count in balances, statements, and reports. An archived invoice that is owed money again, such as an archived draft that is issued or a paid one whose payment is deleted, is restored automatically. Ids that are not this company's invoices, are already in the requested state, or still have a balance due are returned in skipped instead of failing the request. List invoices with archived=true to include archived ones.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams,
    body: { required: true, content: { "application/json": { schema: invoiceBulkSchema } } },
  },
  responses: {
    200: {
      description: "Which invoices changed and which were skipped",
      content: { "application/json": { schema: invoiceBulkResult } },
    },
    ...errors,
    400: {
      description: "Unknown action, or ids missing, malformed, or more than 500",
      content: { "application/json": { schema: errorResponse } },
    },
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/recurring-invoices/bulk",
  summary: "Archive or restore recurring invoice schedules",
  description:
    "Requires full Finance access. Send action archive to file up to 500 paused or ended schedules out of the default lists, or restore to bring archived schedules back. An active schedule is skipped, since it would keep billing from out of sight, and resuming an archived schedule restores it. Archiving changes no status, cadence, template line, or run history. Ids that are not this company's schedules, are already in the requested state, or are still active are returned in skipped instead of failing the request. List recurring invoices with archived=true to include archived ones.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams,
    body: {
      required: true,
      content: { "application/json": { schema: recurringInvoiceBulkSchema } },
    },
  },
  responses: {
    200: {
      description: "Which schedules changed and which were skipped",
      content: { "application/json": { schema: recurringBulkResult } },
    },
    ...errors,
    400: {
      description: "Unknown action, or ids missing, malformed, or more than 500",
      content: { "application/json": { schema: errorResponse } },
    },
  },
});

const recipientSuggestion = z
  .object({
    email: z.string().describe("Lowercased, and accepted by the invoice and estimate send endpoints."),
    name: z.string().describe("The person's name, or empty when the address is all there is."),
    role: z.string().describe("Role or job title from the strongest source that has one."),
    primary: z.boolean().describe("The customer's primary billing contact."),
    billing: z
      .boolean()
      .describe(
        "The billing email, or a role, title or mailbox that reads as billing or finance (Accounts payable, CFO, ap@, billing@).",
      ),
    sources: z
      .array(z.enum(["billing_email", "customer_contact", "revenue_contact", "deal", "domain"]))
      .describe(
        "Why they are suggested, strongest first: the customer's billing email, a billing contact, a Revenue contact linked to the account, a Revenue contact on one of its Deals, or a Revenue contact at its domain.",
      ),
    dealTitle: z
      .string()
      .nullable()
      .describe("The most recently updated Deal they are on, when a Deal is why they are here."),
    lastEmailedAt: z
      .string()
      .datetime()
      .nullable()
      .describe(
        "The last delivered invoice or estimate email of this customer's that went to them, or outbound email with them as a Revenue contact; null when neither is recorded.",
      ),
  })
  .openapi("FinanceRecipientSuggestion");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/customers/{slug}/recipient-suggestions",
  summary: "Suggest who to email a customer's invoice or estimate to",
  description:
    "The people the send dialog offers as one-click To and Cc recipients: the customer's billing email, its billing contacts, Revenue contacts linked to the account or on its Deals, and Revenue contacts at its domain, subdomains included. A free-mail domain such as gmail.com, or one of the company's own domains, is never matched as a whole. Archived contacts, anyone marked Do not contact, and suppressed addresses are left out. Ranked billing and finance people and the primary contact first, then whoever was emailed most recently, then the rest. Suggesting changes no email; send to the people you choose with the invoice or estimate send endpoint.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams.extend({ slug: z.string() }),
    query: z.object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .describe("At most this many suggestions, best first. Defaults to 50."),
    }),
  },
  responses: {
    200: {
      description: "The customer's people, best first",
      content: {
        "application/json": {
          schema: z.object({
            suggestions: z.array(recipientSuggestion),
            domain: z
              .string()
              .nullable()
              .describe(
                "The domain people were matched at, or null when the customer has none, it is free mail, or it is the company's own.",
              ),
          }),
        },
      },
    },
    ...errors,
  },
});

registry.registerPath({
  method: "post",
  path: "/api/companies/{cid}/recurring-invoices",
  summary: "Create a recurring invoice schedule",
  description:
    "Requires full Finance access. Pass an active subsidiaryId in this company to issue future invoices under that legal entity. Each generated invoice saves the then-current subsidiary details. Null or omitted subsidiaryId uses the company default. An omitted or blank name names the schedule after its customer. Creating the schedule does not generate an invoice immediately.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: companyParams,
    body: {
      required: true,
      content: { "application/json": { schema: recurringInvoiceCreateSchema } },
    },
  },
  responses: {
    200: {
      description: "Recurring invoice schedule created",
      content: { "application/json": { schema: recurringResponse } },
    },
    ...errors,
  },
});

registry.registerPath({
  method: "patch",
  path: "/api/companies/{cid}/recurring-invoices/{slug}",
  summary: "Edit a recurring invoice schedule",
  description:
    "Requires full Finance access. Changing subsidiaryId changes the issuer of future invoices only; previously generated documents retain their saved identity. Pass null to restore the company default issuer or omit the field to preserve its selection. Changing customerId never renames the schedule, and a name, when sent, cannot be blank.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: {
    params: documentParams,
    body: {
      required: true,
      content: { "application/json": { schema: recurringInvoicePatchSchema } },
    },
  },
  responses: {
    200: {
      description: "Recurring invoice schedule updated",
      content: { "application/json": { schema: recurringResponse } },
    },
    ...errors,
  },
});

// ── Paged lists (`services/listPaging.ts`) ────────────────────────────────

/** What every paged list answers beside its rows, ahead of them. */
const pageInfo = {
  total: z.number().int().describe("Rows the filters match, ignoring limit and cursor."),
  hasMore: z.boolean().describe("More rows follow this page."),
  nextCursor: z
    .string()
    .nullable()
    .describe(
      "Send as cursor, with exactly the same filters, for the next page. Null on the last page.",
    ),
  note: z
    .string()
    .optional()
    .describe("While more rows follow: how many this page holds and how to read on."),
};

/** The 400 and 404 a paged list answers with, beside the usual errors. */
const pageErrors = {
  ...errors,
  400: {
    description:
      "A filter that cannot be read (a date, or a range that ends before it starts), or a cursor that is garbled, from another list, or issued for other filters",
    content: { "application/json": { schema: errorResponse } },
  },
  404: {
    description: "A filter names a record this company does not have",
    content: { "application/json": { schema: errorResponse } },
  },
};

const bankingTransactionRow = z
  .object({
    kind: z.enum(["bank", "card"]),
    id: z.string().uuid(),
    date: z.string().datetime(),
    amountCents: z
      .number()
      .int()
      .describe("Signed from the company's side: money in positive, money out negative."),
    currency: z.string(),
    description: z.string(),
    reference: z.string().describe("The bank's reference; empty for card purchases."),
    account: z.object({ feedId: z.string().uuid(), name: z.string() }),
    status: z.enum(["review", "done"]),
    category: z
      .object({ accountId: z.string().uuid(), code: z.string(), name: z.string() })
      .nullable()
      .describe("The chart-of-accounts account it is filed under; null when it has none yet."),
    payments: z
      .array(
        z.object({
          invoiceNumber: z.string(),
          invoiceSlug: z.string(),
          customerName: z.string(),
          amountCents: z.number().int(),
        }),
      )
      .optional()
      .describe("Bank lines: the invoice payments a deposit paid."),
    matchedEntry: z
      .object({ entryId: z.string().uuid(), memo: z.string(), source: z.string() })
      .optional()
      .describe("Bank lines: the posted entry it matched, when that is not a Banking category."),
    cardKind: z.enum(["expense", "refund", "payment"]).optional(),
    postingError: z.string().optional().describe("Card purchases: why posting it failed."),
  })
  .openapi("BankingTransaction");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/banking/transactions",
  summary: "List Banking transactions",
  description:
    "Requires Read Finance access. Bank lines and card purchases in one list, newest first (a bank line before a card purchase at the same instant, then by id): the list the list_banking_transactions AI tool reads. status defaults to review, the To review queue. Every transaction is reachable: a page holds up to limit rows (default 50, at most 200), total counts every match, and while hasMore is true sending nextCursor back as cursor with the same filters reads the next page. A cursor is a keyset position, so filing transactions between pages never skips any. Dates are UTC calendar days, as Banking shows them.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: { params: companyParams, query: bankingQueueQuerySchema },
  responses: {
    200: {
      description: "One page of transactions",
      content: {
        "application/json": {
          schema: z
            .object({ ...pageInfo, transactions: z.array(bankingTransactionRow) })
            .openapi("BankingTransactionPage"),
        },
      },
    },
    ...pageErrors,
  },
});

const ledgerLine = z
  .object({
    id: z.string().uuid(),
    ledgerEntryId: z.string().uuid(),
    accountId: z.string().uuid(),
    debitCents: z.number().int(),
    creditCents: z.number().int(),
    description: z.string(),
    sortOrder: z.number().int(),
  })
  .passthrough();

const reviewedLedgerEntry = z
  .object({
    id: z.string().uuid(),
    companyId: z.string().uuid(),
    date: z.string().datetime(),
    memo: z.string(),
    source: z.string().describe("What posted it: manual, bank_categorization, brex_card_expense, …"),
    sourceRefId: z.string().nullable(),
    reviewStatus: z.enum(["unreviewed", "ai_reviewed", "approved"]),
    lines: z.array(ledgerLine),
    totalCents: z.number().int().describe("The entry's debits."),
    reviewChanges: z.array(
      z.object({
        lineId: z.string().uuid(),
        fromAccountId: z.string().uuid(),
        toAccountId: z.string().uuid(),
      }),
    ),
    categoryLock: z
      .enum(["card", "bank", "reversal", "reversed"])
      .nullable()
      .describe("Why Entry review cannot change its categories, or null when it can."),
    createdAt: z.string().datetime(),
  })
  .passthrough()
  .openapi("ReviewedLedgerEntry");

registry.registerPath({
  method: "get",
  path: "/api/companies/{cid}/finance/transactions",
  summary: "List journal entries for review",
  description:
    "Requires Read Finance access. Entry review's journal with every debit and credit line, newest first (then by id): the list the list_finance_transactions AI tool reads. Every entry is reachable: a page holds up to limit entries (default 50, at most 200), total counts every match, and while hasMore is true sending nextCursor back as cursor with the same filters reads the next page. A cursor is a keyset position, so approving entries between pages never skips any. GET /ledger-entries still answers a plain array of at most 500 for the Finance pages.",
  tags: ["Finance"],
  security: defaultSecurity,
  request: { params: companyParams, query: ledgerReviewQuerySchema },
  responses: {
    200: {
      description: "One page of journal entries",
      content: {
        "application/json": {
          schema: z
            .object({ ...pageInfo, transactions: z.array(reviewedLedgerEntry) })
            .openapi("ReviewedLedgerEntryPage"),
        },
      },
    },
    ...pageErrors,
  },
});
