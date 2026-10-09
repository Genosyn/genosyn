import { z } from "zod";
import {
  estimateCreateSchema,
  estimatePatchSchema,
  invoiceCreateSchema,
  invoicePatchSchema,
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
  })
  .openapi("FinanceInvoice");
const estimateResponse = documentIdentity
  .extend({
    status: z.enum(["draft", "sent", "accepted", "declined", "void"]),
    validUntil: z.string().datetime(),
  })
  .openapi("FinanceEstimate");
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
    response: invoiceResponse,
  },
  {
    path: "estimates",
    label: "estimate",
    create: estimateCreateSchema,
    patch: estimatePatchSchema,
    response: estimateResponse,
  },
] as const) {
  registry.registerPath({
    method: "post",
    path: `/api/companies/{cid}/${document.path}`,
    summary: `Create a draft ${document.label}`,
    description:
      "Requires full Finance access. Pass subsidiaryId to select an active legal entity in this company; omit it or pass null for the company default. Subsidiary details are saved on the draft and used in its email and PDF. Creating a draft does not issue or email it.",
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
    description:
      "Requires full Finance access. Subsidiary selection, customer, issue date, currency, and lines can change only while the document is a draft. Changing subsidiaryId saves fresh issuer details; null restores the company default. Omitting the field or retaining its current value preserves the saved snapshot. An issued document's issuer cannot change.",
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
        description: "Document is voided or the requested field is locked after issue",
        content: { "application/json": { schema: errorResponse } },
      },
    },
  });
}

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
