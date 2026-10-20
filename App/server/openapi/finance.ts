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
    "Requires Read Finance access. Newest first, without line items or payments; fetch one invoice by slug for those. Filter by status, customerId, or recurringInvoiceId for the invoices one recurring invoice schedule created. Archived invoices are left out unless archived=true, which includes them alongside the rest.",
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
    }),
  },
  responses: {
    200: {
      description: "Invoices, newest first",
      content: { "application/json": { schema: z.array(invoiceListItem) } },
    },
    ...errors,
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
