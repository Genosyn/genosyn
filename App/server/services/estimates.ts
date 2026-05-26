import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Estimate, EstimateStatus } from "../db/entities/Estimate.js";
import { EstimateLineItem } from "../db/entities/EstimateLineItem.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import {
  computeLineTotals,
  formatEstimateNumber,
  formatMoney,
} from "../lib/money.js";
import { sendEmail } from "./email.js";
import { renderEstimateHtmlForCompany } from "./estimateHtml.js";
import { issueInvoice, type LineDraft } from "./finance.js";

/**
 * Estimate service — pure orchestration over the Estimate + line item
 * entities. Mirrors `services/finance.ts` for invoices, minus payments
 * and ledger posting (estimates do not affect the books — only the
 * invoices they convert into do).
 *
 * Conventions:
 *   - All cent columns are recomputed from the line items; callers never
 *     write them directly.
 *   - Status transitions are forward-only:
 *       draft → sent → accepted | declined | void
 *     A `sent` (or `accepted`) estimate past its `validUntil` is
 *     rendered as `expired` at read time, but the stored status does
 *     not change so changing the system clock can't corrupt records.
 *   - Numbering is gapless per company. Sequence is minted in the same
 *     logical unit-of-work as the issue transition so two concurrent
 *     issues don't race for the same seq.
 *   - Converting an accepted estimate to an invoice is one-shot: the
 *     estimate's `invoiceId` is set and the resulting invoice is
 *     immediately issued so it lands on the books with a real number.
 */

// ───────────────────────────── Numbering ──────────────────────────────

/**
 * Mint the next gapless estimate sequence for a (company, customer)
 * pair — each customer has their own counter starting at 1. Slug
 * uniqueness within the company is handled at issue time by prefixing
 * the customer slug. See `mintNextInvoiceSeq` for the Postgres
 * concurrency note.
 */
export async function mintNextEstimateSeq(
  companyId: string,
  customerId: string,
): Promise<number> {
  const last = await AppDataSource.getRepository(Estimate).findOne({
    where: { companyId, customerId },
    order: { numberSeq: "DESC" },
    select: ["numberSeq"],
  });
  return (last?.numberSeq ?? 0) + 1;
}

// ───────────────────────── Tax + Product snapshots ─────────────────────

async function snapshotTax(
  companyId: string,
  taxRateId: string | null | undefined,
): Promise<{
  taxRateId: string | null;
  taxName: string;
  taxPercent: number;
  taxInclusive: boolean;
}> {
  if (!taxRateId) {
    return { taxRateId: null, taxName: "", taxPercent: 0, taxInclusive: false };
  }
  const rate = await AppDataSource.getRepository(TaxRate).findOneBy({
    id: taxRateId,
    companyId,
  });
  if (!rate) {
    return { taxRateId: null, taxName: "", taxPercent: 0, taxInclusive: false };
  }
  return {
    taxRateId: rate.id,
    taxName: rate.name,
    taxPercent: rate.ratePercent,
    taxInclusive: rate.inclusive,
  };
}

/**
 * Replace all line items on an estimate with the supplied drafts. Used
 * by both the create flow and the draft edit flow. Each line is
 * tax-snapshotted, computed via `lib/money.ts > computeLineTotals()`,
 * and re-ordered by the supplied `sortOrder` (defaults to input order).
 */
export async function replaceEstimateLines(
  estimate: Estimate,
  drafts: LineDraft[],
): Promise<EstimateLineItem[]> {
  const lineRepo = AppDataSource.getRepository(EstimateLineItem);
  await lineRepo.delete({ estimateId: estimate.id });
  if (drafts.length === 0) return [];
  const built: EstimateLineItem[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const tax = await snapshotTax(estimate.companyId, d.taxRateId);
    const totals = computeLineTotals({
      quantity: d.quantity,
      unitPriceCents: d.unitPriceCents,
      taxPercent: tax.taxPercent,
      taxInclusive: tax.taxInclusive,
    });
    built.push(
      lineRepo.create({
        estimateId: estimate.id,
        productId: d.productId ?? null,
        description: d.description,
        quantity: d.quantity,
        unitPriceCents: d.unitPriceCents,
        taxRateId: tax.taxRateId,
        taxName: tax.taxName,
        taxPercent: tax.taxPercent,
        taxInclusive: tax.taxInclusive,
        ...totals,
        sortOrder: d.sortOrder ?? i,
      }),
    );
  }
  return await lineRepo.save(built);
}

// ───────────────────────────── Recompute ──────────────────────────────

/**
 * Re-derive `subtotalCents` / `taxCents` / `totalCents` from the current
 * lines. Saves and returns the estimate. Idempotent — call after any
 * line write. Status is not touched: estimates carry no payments so
 * there's no automatic status flip equivalent to the invoice `paid`
 * transition.
 */
export async function recomputeEstimateTotals(estimate: Estimate): Promise<Estimate> {
  const lines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
  });
  estimate.subtotalCents = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  estimate.taxCents = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  estimate.totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  return AppDataSource.getRepository(Estimate).save(estimate);
}

// ───────────────────────── Status transitions ──────────────────────────

/**
 * Move a draft to `sent`. Mints the gapless number, sets the slug to
 * `est-NNNN`, stamps `sentAt`, and recomputes totals so the cent columns
 * reflect the latest line edits.
 */
export async function issueEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status !== "draft") {
    throw new Error("Only drafts can be issued");
  }
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: estimate.customerId,
    companyId: estimate.companyId,
  });
  if (!customer) {
    throw new Error("Customer for this estimate no longer exists");
  }
  const seq = await mintNextEstimateSeq(estimate.companyId, estimate.customerId);
  estimate.numberSeq = seq;
  estimate.number = formatEstimateNumber(seq);
  // Slug includes the customer slug so two customers can both have
  // EST-0001 without colliding on the unique (companyId, slug) index.
  estimate.slug = `${customer.slug}-${estimate.number.toLowerCase()}`;
  estimate.status = "sent";
  estimate.sentAt = new Date();
  await AppDataSource.getRepository(Estimate).save(estimate);
  return recomputeEstimateTotals(estimate);
}

export async function acceptEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status === "draft") {
    throw new Error("Issue the estimate before marking it accepted");
  }
  if (estimate.status === "void" || estimate.status === "declined") {
    throw new Error("This estimate cannot be accepted in its current state");
  }
  estimate.status = "accepted";
  estimate.acceptedAt = new Date();
  estimate.declinedAt = null;
  return AppDataSource.getRepository(Estimate).save(estimate);
}

export async function declineEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status === "draft") {
    throw new Error("Issue the estimate before marking it declined");
  }
  if (estimate.status === "void") {
    throw new Error("Voided estimates cannot be declined");
  }
  estimate.status = "declined";
  estimate.declinedAt = new Date();
  estimate.acceptedAt = null;
  return AppDataSource.getRepository(Estimate).save(estimate);
}

export async function voidEstimate(
  estimate: Estimate,
  _actorUserId: string | null = null,
): Promise<Estimate> {
  if (estimate.status === "void") return estimate;
  if (estimate.status === "draft") {
    throw new Error("Drafts cannot be voided — delete them instead");
  }
  estimate.status = "void";
  estimate.voidedAt = new Date();
  return AppDataSource.getRepository(Estimate).save(estimate);
}

/**
 * One-shot conversion of an `accepted` (or `sent`) estimate into a
 * fully issued `Invoice`. The new invoice copies the estimate's lines
 * (already tax-snapshotted), inherits the same currency, and goes
 * straight to `sent` so it lands on the books with a real `INV-####`
 * number and the auto-posted journal entry. The estimate keeps its
 * status but stamps `invoiceId` + `convertedAt` so the UI can show a
 * "Converted to INV-####" badge.
 */
export async function convertEstimateToInvoice(
  estimate: Estimate,
  actorUserId: string | null,
  opts: { dueInDays?: number } = {},
): Promise<{ estimate: Estimate; invoice: Invoice }> {
  if (estimate.invoiceId) {
    throw new Error("This estimate has already been converted to an invoice");
  }
  if (estimate.status === "draft") {
    throw new Error("Issue the estimate before converting it");
  }
  if (estimate.status === "declined" || estimate.status === "void") {
    throw new Error("This estimate cannot be converted in its current state");
  }
  const lines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
    order: { sortOrder: "ASC" },
  });
  if (lines.length === 0) {
    throw new Error("Cannot convert an empty estimate — add line items first");
  }

  const dueInDays = opts.dueInDays ?? 14;
  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + dueInDays * 24 * 60 * 60 * 1000);

  // Build the invoice in draft, copy the lines, then issue it so we
  // exercise the existing invoice issue path (number mint + ledger
  // post). Numbering for invoices is independent of estimates.
  const invoiceRepo = AppDataSource.getRepository(Invoice);
  const inv = invoiceRepo.create({
    companyId: estimate.companyId,
    customerId: estimate.customerId,
    slug: `draft-${Math.random().toString(36).slice(2, 8)}`,
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    dueDate,
    currency: estimate.currency,
    notes: estimate.notes,
    footer: estimate.footer,
    createdById: actorUserId,
  });
  await invoiceRepo.save(inv);

  const invoiceLineRepo = AppDataSource.getRepository(InvoiceLineItem);
  await invoiceLineRepo.save(
    lines.map((l) =>
      invoiceLineRepo.create({
        invoiceId: inv.id,
        productId: l.productId,
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unitPriceCents,
        taxRateId: l.taxRateId,
        taxName: l.taxName,
        taxPercent: l.taxPercent,
        taxInclusive: l.taxInclusive,
        lineSubtotalCents: l.lineSubtotalCents,
        lineTaxCents: l.lineTaxCents,
        lineTotalCents: l.lineTotalCents,
        sortOrder: l.sortOrder,
      }),
    ),
  );

  const issued = await issueInvoice(inv, actorUserId);

  estimate.invoiceId = issued.id;
  estimate.convertedAt = new Date();
  // If the estimate hadn't been marked accepted yet, mark it now —
  // converting is implicit acceptance.
  if (estimate.status === "sent") {
    estimate.status = "accepted";
    estimate.acceptedAt = estimate.acceptedAt ?? new Date();
  }
  const savedEstimate = await AppDataSource.getRepository(Estimate).save(estimate);
  return { estimate: savedEstimate, invoice: issued };
}

// ─────────────────────────── Hydration ────────────────────────────────

export type EstimateCustomerStub = {
  id: string;
  name: string;
  slug: string;
  email: string;
};

export type EstimateInvoiceStub = {
  id: string;
  slug: string;
  number: string;
  status: string;
};

export type HydratedEstimate = Estimate & {
  customer: EstimateCustomerStub | null;
  lines: EstimateLineItem[];
  invoice: EstimateInvoiceStub | null;
};

/**
 * Bulk-hydrate a list of estimates with their customer stub, line items,
 * and the converted-to invoice (if any).
 */
export async function hydrateEstimates(
  companyId: string,
  estimates: Estimate[],
): Promise<HydratedEstimate[]> {
  if (estimates.length === 0) return [];
  const ids = estimates.map((e) => e.id);
  const customerIds = [...new Set(estimates.map((e) => e.customerId))];
  const invoiceIds = [
    ...new Set(
      estimates.map((e) => e.invoiceId).filter((x): x is string => !!x),
    ),
  ];
  const [customers, lines, invoices] = await Promise.all([
    AppDataSource.getRepository(Customer).find({
      where: { id: In(customerIds), companyId },
      select: ["id", "name", "slug", "email"],
    }),
    AppDataSource.getRepository(EstimateLineItem).find({
      where: { estimateId: In(ids) },
      order: { sortOrder: "ASC" },
    }),
    invoiceIds.length
      ? AppDataSource.getRepository(Invoice).find({
          where: { id: In(invoiceIds), companyId },
          select: ["id", "slug", "number", "status"],
        })
      : Promise.resolve([] as Invoice[]),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const linesByEstimate = new Map<string, EstimateLineItem[]>();
  for (const l of lines) {
    const arr = linesByEstimate.get(l.estimateId) ?? [];
    arr.push(l);
    linesByEstimate.set(l.estimateId, arr);
  }
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  return estimates.map((est) => ({
    ...est,
    customer: customerById.get(est.customerId) ?? null,
    lines: linesByEstimate.get(est.id) ?? [],
    invoice: est.invoiceId
      ? invoiceById.get(est.invoiceId) ?? null
      : null,
  }));
}

// ─────────────────────────── Display helpers ──────────────────────────

/**
 * Compute the *displayed* status for a UI badge — adds the synthetic
 * "expired" bucket for sent estimates past `validUntil`, and "invoiced"
 * for estimates that have been converted. Stored status is untouched
 * so changing the system clock doesn't corrupt anything.
 */
export type DisplayEstimateStatus =
  | EstimateStatus
  | "expired"
  | "invoiced";

export function displayEstimateStatus(
  estimate: Pick<Estimate, "status" | "validUntil" | "invoiceId">,
  now: Date = new Date(),
): DisplayEstimateStatus {
  if (estimate.invoiceId) return "invoiced";
  if (
    (estimate.status === "sent" || estimate.status === "accepted") &&
    new Date(estimate.validUntil).getTime() < now.getTime()
  ) {
    return "expired";
  }
  return estimate.status;
}

// ─────────────────────────── Email send ────────────────────────────────

/**
 * Email the rendered HTML estimate to the customer's `email`. Uses the
 * company's default `EmailProvider` if one exists, falling back to the
 * global SMTP block (or console). Returns the email log id so the UI
 * can deep-link to the delivery record.
 */
export async function sendEstimateEmail(
  companyId: string,
  estimate: Estimate,
  triggeredByUserId: string | null,
): Promise<{ status: "sent" | "skipped" | "failed"; logId: string; errorMessage: string }> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: estimate.customerId,
    companyId,
  });
  if (!customer) throw new Error("Customer not found");
  if (!customer.email) {
    throw new Error("Customer has no email address — add one before sending");
  }
  const lines = await AppDataSource.getRepository(EstimateLineItem).find({
    where: { estimateId: estimate.id },
    order: { sortOrder: "ASC" },
  });
  const html = await renderEstimateHtmlForCompany(
    companyId,
    estimate,
    customer,
    lines,
  );
  const text =
    `Estimate ${estimate.number || "(draft)"} — total ` +
    `${formatMoney(estimate.totalCents, estimate.currency)} valid until ` +
    `${estimate.validUntil.toISOString().slice(0, 10)}.\n\n` +
    `Open the attached HTML estimate in your browser to print or save as PDF.`;
  const subject = `Estimate ${estimate.number || "(draft)"} — ${formatMoney(
    estimate.totalCents,
    estimate.currency,
  )}`;
  const result = await sendEmail({
    to: customer.email,
    subject,
    text,
    html,
    companyId,
    purpose: "other",
    triggeredByUserId,
  });
  return {
    status: result.status,
    logId: result.logId,
    errorMessage: result.errorMessage,
  };
}

// ──────────────────────── Lookup helpers ──────────────────────────────

export async function loadEstimateBySlug(
  companyId: string,
  slug: string,
): Promise<Estimate | null> {
  return AppDataSource.getRepository(Estimate).findOneBy({ companyId, slug });
}
