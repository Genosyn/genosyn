import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice, InvoiceStatus } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { Product } from "../db/entities/Product.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import {
  computeLineTotals,
  formatInvoiceNumber,
  formatMoney,
} from "../lib/money.js";
import { sendEmail } from "./email.js";
import { renderInvoiceHtml } from "./invoiceHtml.js";

/**
 * Finance service — pure orchestration over the Phase A entities. Routes
 * stay thin (parse, validate, delegate); all business rules live here.
 *
 * Conventions:
 *   - All cent columns are recomputed from the line items + payments;
 *     callers never write them directly.
 *   - Status transitions move forward only:
 *       draft → sent → paid (via balance) → void (terminal)
 *     Reverting paid → sent happens automatically when payments are
 *     deleted; reverting sent → draft is forbidden once a number has
 *     been minted.
 *   - Numbering is gapless per company. We mint inside the same logical
 *     unit-of-work as the issue transition so two concurrent issues
 *     don't race for the same seq.
 */

// ───────────────────────────── Customers ──────────────────────────────

export async function findCustomerByName(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<Customer | null> {
  const qb = AppDataSource.getRepository(Customer)
    .createQueryBuilder("c")
    .where("c.companyId = :companyId", { companyId })
    .andWhere("LOWER(c.name) = LOWER(:name)", { name: name.trim() });
  if (excludeId) qb.andWhere("c.id != :excludeId", { excludeId });
  return qb.getOne();
}

// ───────────────────────────── Numbering ──────────────────────────────

/**
 * Mint the next gapless invoice sequence for a company. Read-then-write
 * inside a single request is safe under SQLite (synchronous driver) and
 * `requireCompanyMember` already serialized us this far. When this
 * project moves to Postgres, swap to `INSERT … RETURNING` against a
 * dedicated counter row to make this concurrent-safe.
 */
export async function mintNextInvoiceSeq(companyId: string): Promise<number> {
  const last = await AppDataSource.getRepository(Invoice).findOne({
    where: { companyId },
    order: { numberSeq: "DESC" },
    select: ["numberSeq"],
  });
  return (last?.numberSeq ?? 0) + 1;
}

// ───────────────────────── Tax + Product snapshots ─────────────────────

export type LineDraft = {
  productId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

/**
 * Resolve the snapshotted tax fields for a draft line. Looks up the
 * `TaxRate` once (or returns zeros when none is set) so the line carries
 * its own tax math forever.
 */
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
 * Replace all line items on an invoice with the supplied drafts. Used
 * by both the invoice create flow and the draft edit flow. Each line is
 * tax-snapshotted, computed via `lib/money.ts > computeLineTotals()`,
 * and re-ordered by the supplied `sortOrder` (defaults to input order).
 */
export async function replaceInvoiceLines(
  invoice: Invoice,
  drafts: LineDraft[],
): Promise<InvoiceLineItem[]> {
  const lineRepo = AppDataSource.getRepository(InvoiceLineItem);
  await lineRepo.delete({ invoiceId: invoice.id });
  if (drafts.length === 0) return [];
  const built: InvoiceLineItem[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const tax = await snapshotTax(invoice.companyId, d.taxRateId);
    const totals = computeLineTotals({
      quantity: d.quantity,
      unitPriceCents: d.unitPriceCents,
      taxPercent: tax.taxPercent,
      taxInclusive: tax.taxInclusive,
    });
    built.push(
      lineRepo.create({
        invoiceId: invoice.id,
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
 * Re-derive `subtotalCents` / `taxCents` / `totalCents` / `paidCents` /
 * `balanceCents` and the `paid` status from the current lines + payments.
 * Saves and returns the invoice. Idempotent — call after any line or
 * payment write.
 *
 * Status rules:
 *   - Drafts stay drafts (we never auto-issue).
 *   - Voided invoices stay voided (terminal).
 *   - sent ↔ paid flips on the `paidCents >= totalCents` boundary, with
 *     `paidAt` set/cleared accordingly.
 */
export async function recomputeInvoiceTotals(invoice: Invoice): Promise<Invoice> {
  const [lines, payments] = await Promise.all([
    AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: invoice.id },
    }),
    AppDataSource.getRepository(InvoicePayment).find({
      where: { invoiceId: invoice.id },
    }),
  ]);
  const subtotal = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  const tax = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  const total = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  invoice.subtotalCents = subtotal;
  invoice.taxCents = tax;
  invoice.totalCents = total;
  invoice.paidCents = paid;
  invoice.balanceCents = total - paid;
  if (invoice.status !== "draft" && invoice.status !== "void") {
    if (paid >= total && total > 0) {
      if (invoice.status !== "paid") invoice.paidAt = new Date();
      invoice.status = "paid";
    } else {
      invoice.status = "sent";
      invoice.paidAt = null;
    }
  }
  return AppDataSource.getRepository(Invoice).save(invoice);
}

// ───────────────────────── Status transitions ──────────────────────────

/**
 * Move a draft to `sent`. Mints the gapless number, sets the slug to
 * `inv-NNNN`, stamps `sentAt`, recomputes totals so the cent columns
 * reflect the latest line edits.
 */
export async function issueInvoice(invoice: Invoice): Promise<Invoice> {
  if (invoice.status !== "draft") {
    throw new Error("Only drafts can be issued");
  }
  const seq = await mintNextInvoiceSeq(invoice.companyId);
  invoice.numberSeq = seq;
  invoice.number = formatInvoiceNumber(seq);
  invoice.slug = invoice.number.toLowerCase();
  invoice.status = "sent";
  invoice.sentAt = new Date();
  await AppDataSource.getRepository(Invoice).save(invoice);
  return recomputeInvoiceTotals(invoice);
}

export async function voidInvoice(invoice: Invoice): Promise<Invoice> {
  if (invoice.status === "void") return invoice;
  if (invoice.status === "draft") {
    throw new Error("Drafts cannot be voided — delete them instead");
  }
  invoice.status = "void";
  invoice.voidedAt = new Date();
  return AppDataSource.getRepository(Invoice).save(invoice);
}

// ─────────────────────────── Hydration ────────────────────────────────

export type CustomerStub = {
  id: string;
  name: string;
  slug: string;
  email: string;
};

export type HydratedInvoice = Invoice & {
  customer: CustomerStub | null;
  lines: InvoiceLineItem[];
  payments: InvoicePayment[];
};

/**
 * Bulk-hydrate a list of invoices with their customer stub + line item +
 * payment children. Three queries instead of N×3 — important for the
 * list view, where 100+ rows are common.
 */
export async function hydrateInvoices(
  companyId: string,
  invoices: Invoice[],
): Promise<HydratedInvoice[]> {
  if (invoices.length === 0) return [];
  const ids = invoices.map((i) => i.id);
  const customerIds = [...new Set(invoices.map((i) => i.customerId))];
  const [customers, lines, payments] = await Promise.all([
    AppDataSource.getRepository(Customer).find({
      where: { id: In(customerIds), companyId },
      select: ["id", "name", "slug", "email"],
    }),
    AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: In(ids) },
      order: { sortOrder: "ASC" },
    }),
    AppDataSource.getRepository(InvoicePayment).find({
      where: { invoiceId: In(ids) },
      order: { paidAt: "ASC" },
    }),
  ]);
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const linesByInvoice = new Map<string, InvoiceLineItem[]>();
  for (const l of lines) {
    const arr = linesByInvoice.get(l.invoiceId) ?? [];
    arr.push(l);
    linesByInvoice.set(l.invoiceId, arr);
  }
  const paymentsByInvoice = new Map<string, InvoicePayment[]>();
  for (const p of payments) {
    const arr = paymentsByInvoice.get(p.invoiceId) ?? [];
    arr.push(p);
    paymentsByInvoice.set(p.invoiceId, arr);
  }
  return invoices.map((inv) => ({
    ...inv,
    customer: customerById.get(inv.customerId) ?? null,
    lines: linesByInvoice.get(inv.id) ?? [],
    payments: paymentsByInvoice.get(inv.id) ?? [],
  }));
}

// ─────────────────────────── Display helpers ──────────────────────────

/**
 * Compute the *displayed* status for a UI badge — adds the synthetic
 * "overdue" bucket for sent invoices past `dueDate`. Stored status stays
 * `sent` so changing the system clock doesn't corrupt anything.
 */
export type DisplayStatus = InvoiceStatus | "overdue";

export function displayStatus(invoice: Invoice, now: Date = new Date()): DisplayStatus {
  if (invoice.status === "sent" && invoice.dueDate.getTime() < now.getTime()) {
    return "overdue";
  }
  return invoice.status;
}

// ─────────────────────────── Email send ────────────────────────────────

/**
 * Email the rendered HTML invoice to the customer's `email`. Uses the
 * company's default `EmailProvider` if one exists, falling back to the
 * global SMTP block (or console). Returns the email log id so the UI
 * can deep-link to the delivery record.
 */
export async function sendInvoiceEmail(
  companyId: string,
  invoice: Invoice,
  triggeredByUserId: string | null,
): Promise<{ status: "sent" | "skipped" | "failed"; logId: string; errorMessage: string }> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: invoice.customerId,
    companyId,
  });
  if (!customer) throw new Error("Customer not found");
  if (!customer.email) {
    throw new Error("Customer has no email address — add one before sending");
  }
  const [lines, payments] = await Promise.all([
    AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: invoice.id },
      order: { sortOrder: "ASC" },
    }),
    AppDataSource.getRepository(InvoicePayment).find({
      where: { invoiceId: invoice.id },
      order: { paidAt: "ASC" },
    }),
  ]);
  const html = renderInvoiceHtml({ invoice, customer, lines, payments });
  const text =
    `Invoice ${invoice.number || "(draft)"} from your supplier — ` +
    `${formatMoney(invoice.balanceCents, invoice.currency)} due ` +
    `${invoice.dueDate.toISOString().slice(0, 10)}.\n\n` +
    `Open the attached HTML invoice in your browser to print or save as PDF.`;
  const subject = `Invoice ${invoice.number || "(draft)"} — ${formatMoney(
    invoice.totalCents,
    invoice.currency,
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

export async function loadCustomerBySlug(
  companyId: string,
  slug: string,
): Promise<Customer | null> {
  return AppDataSource.getRepository(Customer).findOneBy({ companyId, slug });
}

export async function loadProductBySlug(
  companyId: string,
  slug: string,
): Promise<Product | null> {
  return AppDataSource.getRepository(Product).findOneBy({ companyId, slug });
}

export async function loadInvoiceBySlug(
  companyId: string,
  slug: string,
): Promise<Invoice | null> {
  return AppDataSource.getRepository(Invoice).findOneBy({ companyId, slug });
}
