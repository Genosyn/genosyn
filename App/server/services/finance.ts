import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { Customer } from "../db/entities/Customer.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { EmailProvider } from "../db/entities/EmailProvider.js";
import { Invoice, InvoiceStatus } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerEntry, type LedgerEntrySource } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { Product } from "../db/entities/Product.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import {
  computeLineTotals,
  formatInvoiceNumber,
  formatMoney,
  reconcilePartsToTotal,
} from "../lib/money.js";
import { sendEmail } from "./email.js";
import { renderPdfAttachment } from "./htmlToPdf.js";
import { renderInvoiceHtml } from "./invoiceHtml.js";
import { isPaidInCash, notifyInvoicePaid } from "./invoicePaidNotice.js";
import { documentIssuerFields, resolveDocumentIssuer } from "./subsidiaries.js";
import { Company } from "../db/entities/Company.js";
import {
  findClosedPeriodCovering,
  hasEntryFor,
  type LedgerLineDraft,
  postLedgerEntry,
  requireAccountsByCode,
  reverseLedgerEntriesForSources,
} from "./ledger.js";
import { convertCents, getFinanceSettings } from "./fx.js";
import {
  discountProblem,
  type DocumentDiscount,
  documentTotals,
  NO_DISCOUNT,
} from "../../shared/documentDiscount.js";
import { invoiceArchiveBlocker } from "../../shared/invoiceArchive.js";
import {
  formatGlobalSmtpSender,
  getEffectiveGlobalSmtp,
} from "./globalEmailTransport.js";

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
 *     deleted or an edit raises the total; reverting sent → draft is
 *     forbidden once a number has been minted.
 *   - An issued invoice stays editable (`updateInvoice`) so it can be
 *     corrected and resent under the same number. Its customer and issuer
 *     are fixed at issue, and a revision posts an `invoice_revision` entry
 *     that brings the ledger in line with the new amounts.
 *   - Numbering is gapless per company. We mint inside the same logical
 *     unit-of-work as the issue transition so two concurrent issues
 *     don't race for the same seq.
 */

// ───────────────────────────── Customers ──────────────────────────────

/**
 * A company-unique customer slug derived from `base`, suffixing `-2`, `-3`, …
 * on collision. Shared by the human customer-create route and the AI
 * `create_customer` tool so both mint slugs the same way.
 */
export async function uniqueCustomerSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Customer);
  const root = base || "customer";
  let slug = root;
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

/**
 * A throwaway slug for a fresh draft invoice (the real display number is
 * minted at issue time). Shared by the human create route and the AI
 * `create_invoice` tool.
 */
export async function draftInvoiceSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Invoice);
  for (let i = 0; i < 16; i += 1) {
    const slug = `draft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `draft-${Date.now().toString(36)}`;
}

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
 * Mint the next gapless invoice sequence for a (company, customer)
 * pair. Customers each have their own running counter starting at 1 —
 * "INV-0001" addressed to Acme is a different invoice from "INV-0001"
 * addressed to Globex, and they coexist in the same company without
 * collision. Slug uniqueness within the company is handled at issue
 * time by prefixing the customer slug onto the invoice slug.
 *
 * Read-then-write inside a single request is safe under SQLite (the
 * driver is synchronous and `requireCompanyMember` already serialized
 * us this far). When this project moves to Postgres, swap to
 * `INSERT … RETURNING` against a dedicated counter row.
 */
export async function mintNextInvoiceSeq(
  companyId: string,
  customerId: string,
): Promise<number> {
  const last = await AppDataSource.getRepository(Invoice).findOne({
    where: { companyId, customerId },
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

/** A discount as a create or edit asks for it: either field alone sets it. */
export type DiscountInput = {
  discountPercent?: number;
  discountAmountCents?: number;
};

export type CreateInvoiceDraftInput = DiscountInput & {
  companyId: string;
  customerId: string;
  subsidiaryId?: string | null;
  issueDate?: Date;
  dueDate?: Date;
  currency?: string;
  notes?: string;
  footer?: string;
  lines?: LineDraft[];
  createdById?: string | null;
};

/** The discount an estimate or invoice carries now. */
export function discountOf(doc: DocumentDiscount): DocumentDiscount {
  return {
    discountPercent: Number(doc.discountPercent) || 0,
    discountAmountCents: Number(doc.discountAmountCents) || 0,
  };
}

/**
 * The discount a create or edit asks for, checked. Sending either field
 * replaces the whole discount — the other becomes zero, so switching from a
 * percentage to an amount never leaves both set — and sending neither keeps
 * `current`.
 */
export function requestedDiscount(
  input: DiscountInput,
  current: DocumentDiscount = NO_DISCOUNT,
): DocumentDiscount {
  const next =
    input.discountPercent === undefined && input.discountAmountCents === undefined
      ? current
      : {
          discountPercent: input.discountPercent ?? 0,
          discountAmountCents: input.discountAmountCents ?? 0,
        };
  const problem = discountProblem(next);
  if (problem) throw new Error(problem);
  return next;
}

/** Whether two discounts would charge the customer the same way. */
export function sameDiscount(a: DocumentDiscount, b: DocumentDiscount): boolean {
  return a.discountPercent === b.discountPercent && a.discountAmountCents === b.discountAmountCents;
}

/** Validate the customer and issuer before persisting the new document. */
export async function createInvoiceDraft(input: CreateInvoiceDraftInput): Promise<Invoice> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: input.customerId,
    companyId: input.companyId,
  });
  if (!customer) throw new Error("Invalid customer");
  const discount = requestedDiscount(input);
  const issuer = await resolveDocumentIssuer(input.companyId, input.subsidiaryId);
  const issueDate = input.issueDate ?? new Date();
  const repo = AppDataSource.getRepository(Invoice);
  const invoice = repo.create({
    companyId: input.companyId,
    customerId: customer.id,
    ...issuer,
    slug: await draftInvoiceSlug(input.companyId),
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    dueDate: input.dueDate ?? new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000),
    currency: input.currency ?? customer.currency ?? "USD",
    ...discount,
    notes: input.notes ?? "",
    footer: input.footer ?? "",
    createdById: input.createdById ?? null,
  });
  await repo.save(invoice);
  if (input.lines?.length) await replaceInvoiceLines(invoice, input.lines);
  return recomputeInvoiceTotals(invoice);
}

/** The tax fields a line carries once saved. */
export type LineTaxSnapshot = {
  taxRateId: string | null;
  taxName: string;
  taxPercent: number;
  taxInclusive: boolean;
};

/** A line draft priced the way both document line tables store it. */
export type PricedLine = LineTaxSnapshot & {
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
  lineTaxCents: number;
  lineTotalCents: number;
  sortOrder: number;
};

const NO_TAX: LineTaxSnapshot = {
  taxRateId: null,
  taxName: "",
  taxPercent: 0,
  taxInclusive: false,
};

/**
 * Resolve the snapshotted tax fields for a draft line. Looks up the
 * `TaxRate` once (or returns zeros when none is set) so the line carries
 * its own tax math forever.
 *
 * `kept` holds the snapshots an issued document already carries. A rate the
 * document was issued with keeps that percentage through a later edit, even
 * when the company has since changed the rate: correcting a quantity on a
 * sent invoice must not quietly re-tax every other line on it.
 */
export async function snapshotLineTax(
  companyId: string,
  taxRateId: string | null | undefined,
  kept?: ReadonlyMap<string, LineTaxSnapshot>,
): Promise<LineTaxSnapshot> {
  if (!taxRateId) return NO_TAX;
  const issued = kept?.get(taxRateId);
  if (issued) return issued;
  const rate = await AppDataSource.getRepository(TaxRate).findOneBy({
    id: taxRateId,
    companyId,
  });
  if (!rate) return NO_TAX;
  return {
    taxRateId: rate.id,
    taxName: rate.name,
    taxPercent: rate.ratePercent,
    taxInclusive: rate.inclusive,
  };
}

/** The tax snapshots a document's saved lines carry, by rate id. */
export function keptTaxSnapshots(
  lines: ReadonlyArray<LineTaxSnapshot>,
): Map<string, LineTaxSnapshot> {
  const kept = new Map<string, LineTaxSnapshot>();
  for (const l of lines) {
    if (!l.taxRateId || kept.has(l.taxRateId)) continue;
    kept.set(l.taxRateId, {
      taxRateId: l.taxRateId,
      taxName: l.taxName,
      taxPercent: l.taxPercent,
      taxInclusive: l.taxInclusive,
    });
  }
  return kept;
}

/**
 * Price line drafts without saving them: tax-snapshotted, computed via
 * `lib/money.ts > computeLineTotals()`, and ordered by the supplied
 * `sortOrder` (defaults to input order).
 */
export async function priceLineDrafts(
  companyId: string,
  drafts: ReadonlyArray<LineDraft>,
  kept?: ReadonlyMap<string, LineTaxSnapshot>,
): Promise<PricedLine[]> {
  const priced: PricedLine[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const tax = await snapshotLineTax(companyId, d.taxRateId, kept);
    const totals = computeLineTotals({
      quantity: d.quantity,
      unitPriceCents: d.unitPriceCents,
      taxPercent: tax.taxPercent,
      taxInclusive: tax.taxInclusive,
    });
    priced.push({
      productId: d.productId ?? null,
      description: d.description,
      quantity: d.quantity,
      unitPriceCents: d.unitPriceCents,
      ...tax,
      ...totals,
      sortOrder: d.sortOrder ?? i,
    });
  }
  return priced;
}

/**
 * Whether `drafts` would leave a document's lines exactly as they are — the
 * same items in the same order, at the same quantities, prices and tax rates.
 * The edit form always sends its lines, so a save that only moved a due date
 * must not rewrite (and re-snapshot) the lines of a document already in a
 * customer's hands.
 */
export function linesUnchanged(
  existing: ReadonlyArray<
    Pick<
      PricedLine,
      "productId" | "description" | "quantity" | "unitPriceCents" | "taxRateId" | "sortOrder"
    >
  >,
  drafts: ReadonlyArray<LineDraft>,
): boolean {
  if (existing.length !== drafts.length) return false;
  const saved = [...existing].sort((a, b) => a.sortOrder - b.sortOrder);
  const next = drafts
    .map((draft, i) => ({ draft, order: draft.sortOrder ?? i }))
    .sort((a, b) => a.order - b.order)
    .map(({ draft }) => draft);
  return saved.every((line, i) => {
    const d = next[i];
    return (
      (d.productId ?? null) === line.productId &&
      d.description === line.description &&
      d.quantity === line.quantity &&
      d.unitPriceCents === line.unitPriceCents &&
      (d.taxRateId ?? null) === line.taxRateId
    );
  });
}

/**
 * Replace all line items on an invoice with the supplied drafts. Used
 * by the invoice create flow and the edit flow. Each line is priced by
 * {@link priceLineDrafts}; `kept` carries an issued invoice's tax snapshots.
 */
export async function replaceInvoiceLines(
  invoice: Invoice,
  drafts: LineDraft[],
  kept?: ReadonlyMap<string, LineTaxSnapshot>,
): Promise<InvoiceLineItem[]> {
  const lineRepo = AppDataSource.getRepository(InvoiceLineItem);
  await lineRepo.delete({ invoiceId: invoice.id });
  if (drafts.length === 0) return [];
  const priced = await priceLineDrafts(invoice.companyId, drafts, kept);
  return await lineRepo.save(
    priced.map((line) => lineRepo.create({ invoiceId: invoice.id, ...line })),
  );
}

// ───────────────────────────── Recompute ──────────────────────────────

/**
 * Re-derive `subtotalCents` / `discountCents` / `taxCents` / `totalCents` /
 * `paidCents` / `balanceCents` and the `paid` status from the current lines,
 * discount and payments (`shared/documentDiscount.ts` owns the discount
 * math). Saves and returns the invoice. Idempotent — call after any line,
 * discount or payment write.
 *
 * Status rules:
 *   - Drafts stay drafts (we never auto-issue).
 *   - Voided invoices stay voided (terminal).
 *   - sent ↔ paid flips on the `paidCents >= totalCents` boundary, with
 *     `paidAt` set/cleared accordingly.
 *   - Becoming Paid emails the company's owners and admins a confirmation
 *     (`services/invoicePaidNotice.ts`) — never the customer.
 *   - An archived invoice that is owed money again — an archived draft
 *     issued, a payment deleted, a write-off reversed, a credit unapplied,
 *     an edit that raises the total — comes back to the lists, so nothing
 *     left to collect is ever out of sight (`shared/invoiceArchive.ts`).
 */
export async function recomputeInvoiceTotals(invoice: Invoice): Promise<Invoice> {
  const wasPaid = isPaidInCash(invoice);
  const [lines, payments] = await Promise.all([
    AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: invoice.id },
    }),
    AppDataSource.getRepository(InvoicePayment).find({
      where: { invoiceId: invoice.id },
    }),
  ]);
  const totals = documentTotals(lines, discountOf(invoice));
  const total = totals.totalCents;
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  invoice.subtotalCents = totals.subtotalCents;
  invoice.discountCents = totals.discountCents;
  invoice.taxCents = totals.taxCents;
  invoice.totalCents = total;
  invoice.paidCents = paid;
  // Credits and write-offs settle an invoice without any cash arriving.
  // They live in their own columns (written by the credit / write-off
  // services) so `paidCents` keeps meaning "cash actually collected".
  const settled = paid + invoice.creditedCents + invoice.writtenOffCents;
  invoice.balanceCents = total - settled;
  if (invoice.status !== "draft" && invoice.status !== "void") {
    if (settled >= total && total > 0) {
      // Stamp `paidAt` only when cash was genuinely involved. The finance
      // dashboard buckets "paid this month" on this column, so an invoice
      // cleared purely by a write-off or a credit must never surface there
      // as money collected.
      if (invoice.status !== "paid" && paid > 0) invoice.paidAt = new Date();
      invoice.status = "paid";
    } else {
      invoice.status = "sent";
      invoice.paidAt = null;
    }
  }
  if (invoice.archivedAt && invoiceArchiveBlocker(invoice)) invoice.archivedAt = null;
  const saved = await AppDataSource.getRepository(Invoice).save(invoice);
  if (!wasPaid && isPaidInCash(saved)) await notifyInvoicePaid(saved);
  return saved;
}

// ───────────────────────── Status transitions ──────────────────────────

/**
 * Move a draft to `sent`. Mints the gapless number, sets the slug to
 * `inv-NNNN`, stamps `sentAt`, recomputes totals so the cent columns
 * reflect the latest line edits, and posts the AR / Revenue / Tax-
 * Payable journal entry into the general ledger (Phase B).
 */
export async function issueInvoice(
  invoice: Invoice,
  actorUserId: string | null = null,
): Promise<Invoice> {
  if (invoice.status !== "draft") {
    throw new Error("Only drafts can be issued");
  }
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: invoice.customerId,
    companyId: invoice.companyId,
  });
  if (!customer) {
    throw new Error("Customer for this invoice no longer exists");
  }
  // What to put back if the ledger refuses the entry below.
  const draftState = {
    numberSeq: invoice.numberSeq,
    number: invoice.number,
    slug: invoice.slug,
    status: invoice.status,
    sentAt: invoice.sentAt,
  };
  const seq = await mintNextInvoiceSeq(invoice.companyId, invoice.customerId);
  invoice.numberSeq = seq;
  // Display number carries the customer slug as a prefix, e.g.
  // ACME-CORP-INV-0001, so two customers' first invoices don't both
  // read INV-0001 in the list. The URL slug is just the lowercased
  // number — identical to the old `<customer-slug>-inv-NNNN` shape, so
  // existing URLs stay valid and remain unique per (companyId, slug).
  invoice.number = formatInvoiceNumber(seq, customer.slug);
  invoice.slug = invoice.number.toLowerCase();
  invoice.status = "sent";
  invoice.sentAt = new Date();
  await AppDataSource.getRepository(Invoice).save(invoice);
  // Customer is the account record before and after billing. Issuing its first
  // invoice is the objective transition from prospect to customer.
  const promotedFrom = customer.accountStatus;
  if (customer.accountStatus === "prospect") {
    customer.accountStatus = "customer";
    await AppDataSource.getRepository(Customer).save(customer);
  }
  const recomputed = await recomputeInvoiceTotals(invoice);
  // Auto-post: DR Accounts Receivable / CR Sales Revenue + Tax Payable.
  // Phase B (M19) — see services/ledger.ts and ROADMAP.md.
  try {
    await postInvoiceIssue(recomputed, actorUserId);
  } catch (err) {
    // Issuing is all-or-nothing. The rename above is already committed, and
    // the ledger has real reasons to refuse — a missing exchange rate, a
    // closed period. Leaving the invoice renamed but unposted burned a gapless
    // number for nothing and, worse, moved it to a URL nobody had been told
    // about: the open detail page then reported it as deleted. Put the draft
    // back and let the caller see the ledger's own error.
    Object.assign(recomputed, draftState);
    await AppDataSource.getRepository(Invoice).save(recomputed);
    if (promotedFrom === "prospect") {
      customer.accountStatus = promotedFrom;
      await AppDataSource.getRepository(Customer).save(customer);
    }
    throw err;
  }
  return recomputed;
}

/**
 * Post the journal entry that records issuing this invoice. Idempotent
 * — if an `invoice_issue` entry already exists for this invoice id, no
 * new entry is written (so re-running issue after a partial failure is
 * safe). Skips entirely when the invoice has no value (zero-total
 * draft that someone issued by accident); accountants get a clean
 * trial balance instead of a balanced-but-empty entry.
 */
async function postInvoiceIssue(
  invoice: Invoice,
  actorUserId: string | null,
): Promise<void> {
  if (invoice.totalCents <= 0) return;
  if (await hasEntryFor(invoice.companyId, "invoice_issue", invoice.id)) return;
  await postLedgerEntry({
    companyId: invoice.companyId,
    date: invoice.issueDate,
    memo: `Invoice ${invoice.number} issued`,
    source: "invoice_issue",
    sourceRefId: invoice.id,
    createdById: actorUserId,
    lines: await invoiceIssueLines(invoice),
  });
}

/**
 * The journal lines that record this invoice as issued, as it stands now:
 * DR Accounts Receivable / CR Sales Revenue + Tax Payable, converted to the
 * home currency at the issue date. Empty for an invoice with no value, which
 * books nothing.
 */
async function invoiceIssueLines(invoice: Invoice): Promise<LedgerLineDraft[]> {
  if (invoice.totalCents <= 0) return [];
  const accounts = await requireAccountsByCode(invoice.companyId, [
    "1200",
    "4000",
    "2100",
  ]);
  const ar = accounts.get("1200")!;
  const revenue = accounts.get("4000")!;
  const tax = accounts.get("2100")!;

  // Multi-currency (Phase E): convert each invoice cent column to the
  // company's home currency before posting so the ledger stays in a
  // single reporting currency. The audit columns (origCurrency,
  // origAmountCents, rate) carry the pre-conversion picture so reports
  // can drill back to "what the invoice actually said".
  const settings = await getFinanceSettings(invoice.companyId);
  const home = settings.homeCurrency;
  const total = await convertCents(
    invoice.companyId,
    invoice.totalCents,
    invoice.currency,
    home,
    invoice.issueDate,
  );
  const subtotal = await convertCents(
    invoice.companyId,
    invoice.subtotalCents,
    invoice.currency,
    home,
    invoice.issueDate,
  );
  const taxConverted = await convertCents(
    invoice.companyId,
    invoice.taxCents,
    invoice.currency,
    home,
    invoice.issueDate,
  );

  // Anchor the entry on the converted total (what the customer owes and
  // what a later payment will clear), then reconcile the credit legs onto
  // it. Converting each column independently can leave the legs a cent shy
  // of the total — `round(a)+round(b) !== round(a+b)` — which the ledger
  // would reject as unbalanced (breaking issue for FX invoices). The
  // residual lands on the revenue leg, leaving Tax Payable exact.
  const [revenueCredit, taxCredit] =
    invoice.taxCents > 0
      ? reconcilePartsToTotal(total.converted, [subtotal.converted, taxConverted.converted])
      : [total.converted, 0];
  const lines: LedgerLineDraft[] = [
    {
      accountId: ar.id,
      debitCents: total.converted,
      description: `${invoice.number} — receivable`,
      origCurrency: invoice.currency,
      origAmountCents: invoice.totalCents,
      rate: total.rate,
    },
    {
      accountId: revenue.id,
      creditCents: revenueCredit,
      description: `${invoice.number} — revenue`,
      origCurrency: invoice.currency,
      origAmountCents: invoice.subtotalCents,
      rate: subtotal.rate,
    },
  ];
  if (invoice.taxCents > 0) {
    lines.push({
      accountId: tax.id,
      creditCents: taxCredit,
      description: `${invoice.number} — tax payable`,
      origCurrency: invoice.currency,
      origAmountCents: invoice.taxCents,
      rate: taxConverted.rate,
    });
  }
  return lines;
}

/**
 * Every source that records an invoice as issued: the original posting and
 * the revisions an edit wrote since. Together, keyed on the invoice id, they
 * net to what the invoice says now — so voiding reverses all of them and a
 * revision compares against all of them.
 */
const ISSUE_POSTING_SOURCES: ReadonlyArray<LedgerEntrySource> = [
  "invoice_issue",
  "invoice_revision",
];

/** Signed (debit − credit) balance per account across a set of journal lines. */
function netByAccount(
  lines: ReadonlyArray<{ accountId: string; debitCents?: number; creditCents?: number }>,
): Map<string, number> {
  const net = new Map<string, number>();
  for (const l of lines) {
    net.set(l.accountId, (net.get(l.accountId) ?? 0) + (l.debitCents ?? 0) - (l.creditCents ?? 0));
  }
  return net;
}

/** Journal lines carrying a per-account signed balance; zero accounts drop out. */
function linesForNet(net: ReadonlyMap<string, number>, description: string): LedgerLineDraft[] {
  const lines: LedgerLineDraft[] = [];
  for (const [accountId, cents] of net) {
    if (cents > 0) lines.push({ accountId, debitCents: cents, description });
    else if (cents < 0) lines.push({ accountId, creditCents: -cents, description });
  }
  return lines;
}

/** What the ledger currently says about this invoice having been issued. */
async function currentIssuePosting(invoice: Invoice): Promise<Map<string, number>> {
  const entries = await AppDataSource.getRepository(LedgerEntry).find({
    where: {
      companyId: invoice.companyId,
      source: In([...ISSUE_POSTING_SOURCES]),
      sourceRefId: invoice.id,
    },
    select: ["id"],
  });
  if (entries.length === 0) return new Map();
  const lines = await AppDataSource.getRepository(LedgerLine).find({
    where: { ledgerEntryId: In(entries.map((e) => e.id)), companyId: invoice.companyId },
  });
  return netByAccount(lines);
}

/**
 * Bring the ledger in line with an issued invoice whose amounts, currency or
 * issue date were just edited. Posted entries are never rewritten: the
 * correction is a new `invoice_revision` entry, so the journal shows the
 * original issue and every revision after it.
 *
 * On the same issue date that is one entry carrying the difference. When the
 * issue date moved, the current posting is unwound on the old date and the
 * revised one posted on the new date, so revenue lands in the period the
 * invoice now says it was issued. Payments, credits and write-offs are left
 * alone — `updateInvoice` refuses an edit that would strand them.
 *
 * Returns the number of entries posted (0 when nothing on the books moved).
 */
async function postInvoiceRevision(
  invoice: Invoice,
  previousIssueDate: Date,
  actorUserId: string | null,
): Promise<number> {
  const [current, targetLines] = await Promise.all([
    currentIssuePosting(invoice),
    invoiceIssueLines(invoice),
  ]);
  const label = invoice.number || "invoice";
  const base = {
    companyId: invoice.companyId,
    source: "invoice_revision" as const,
    sourceRefId: invoice.id,
    createdById: actorUserId,
  };
  if (previousIssueDate.getTime() === invoice.issueDate.getTime()) {
    const delta = netByAccount(targetLines);
    for (const [accountId, cents] of current) {
      delta.set(accountId, (delta.get(accountId) ?? 0) - cents);
    }
    const lines = linesForNet(delta, `${label} — revised`);
    if (lines.length === 0) return 0;
    await postLedgerEntry({
      ...base,
      date: invoice.issueDate,
      memo: `Invoice ${label} revised`,
      lines,
    });
    return 1;
  }
  let posted = 0;
  const unwind = linesForNet(
    new Map([...current].map(([accountId, cents]) => [accountId, -cents])),
    `${label} — revised, moved off ${previousIssueDate.toISOString().slice(0, 10)}`,
  );
  if (unwind.length > 0) {
    await postLedgerEntry({
      ...base,
      date: previousIssueDate,
      memo: `Invoice ${label} revised — issue date moved to ${invoice.issueDate
        .toISOString()
        .slice(0, 10)}`,
      lines: unwind,
    });
    posted += 1;
  }
  if (targetLines.length > 0) {
    await postLedgerEntry({
      ...base,
      date: invoice.issueDate,
      memo: `Invoice ${label} revised`,
      lines: targetLines,
    });
    posted += 1;
  }
  return posted;
}

// ───────────────────────── Payment references ─────────────────────────

/** A payment's reference as it is stored and compared: trimmed. */
export function normalizePaymentReference(reference: string | null | undefined): string {
  return (reference ?? "").trim();
}

/** A payment that is already in the books under the same reference. */
export class DuplicatePaymentError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "DuplicatePaymentError";
  }
}

/**
 * The payment already recorded under this reference anywhere in the company,
 * with the invoice it settles, or null. References compare without case or
 * surrounding space. A payment recorded with no reference can't be told apart
 * from another of the same amount, so it never matches.
 */
export async function findPaymentByReference(
  companyId: string,
  reference: string | null | undefined,
): Promise<{ payment: InvoicePayment; invoice: Invoice } | null> {
  const ref = normalizePaymentReference(reference);
  if (!ref) return null;
  const payment = await AppDataSource.getRepository(InvoicePayment)
    .createQueryBuilder("payment")
    .innerJoin(Invoice, "invoice", "CAST(invoice.id AS text) = payment.invoiceId")
    .where("invoice.companyId = :companyId", { companyId })
    .andWhere("LOWER(TRIM(payment.reference)) = LOWER(:reference)", { reference: ref })
    .orderBy("payment.createdAt", "ASC")
    .getOne();
  if (!payment) return null;
  const invoice = await AppDataSource.getRepository(Invoice).findOneBy({
    id: payment.invoiceId,
    companyId,
  });
  return invoice ? { payment, invoice } : null;
}

/**
 * Refuse to record a payment that is already in the books. A reference — the
 * bank transfer id, Stripe charge id or cheque number — names one real-world
 * payment, and one payment settles one invoice once: recording it again,
 * against this invoice or another, would count the same money twice. Shared
 * by the Member route and the AI Employee `record_payment` tool, so neither
 * can record a payment the other already has.
 */
export async function assertPaymentNotRecorded(
  companyId: string,
  invoice: Invoice,
  reference: string | null | undefined,
): Promise<void> {
  const existing = await findPaymentByReference(companyId, reference);
  if (!existing) return;
  const ref = normalizePaymentReference(reference);
  const amount = formatMoney(
    existing.payment.amountCents,
    existing.payment.currency || existing.invoice.currency,
  );
  if (existing.invoice.id === invoice.id) {
    throw new DuplicatePaymentError(
      `Payment "${ref}" (${amount}) is already recorded on this invoice. Recording it again would count the same money twice.`,
    );
  }
  const other = existing.invoice.number || "another invoice";
  throw new DuplicatePaymentError(
    `Payment "${ref}" (${amount}) is already recorded on ${other}. A payment can settle only one invoice — if it belongs here, delete it from ${other} first.`,
  );
}

/** An active asset account of this company that cash can move through. */
async function requireCashAccount(companyId: string, accountId: string): Promise<Account> {
  const account = await AppDataSource.getRepository(Account).findOneBy({
    id: accountId,
    companyId,
  });
  if (!account) throw new Error("Bank account not found");
  if (account.type !== "asset") throw new Error("Cash must move through an asset account");
  if (account.archivedAt) throw new Error("That account is archived");
  return account;
}

/**
 * Post the journal entry for a single received payment: DR Bank /
 * CR Accounts Receivable. Idempotent on `(invoice_payment, payment.id)`.
 *
 * The cash lands in `1100 Bank` unless `bankAccountId` names the asset
 * account it really arrived in — a payment recorded from a bank account
 * that reconciles against its own ledger account, say.
 */
export async function postInvoicePayment(
  invoice: Invoice,
  payment: InvoicePayment,
  actorUserId: string | null,
  options: { bankAccountId?: string | null } = {},
): Promise<void> {
  if (payment.amountCents <= 0) return;
  if (
    await hasEntryFor(invoice.companyId, "invoice_payment", payment.id)
  ) {
    return;
  }
  // Phase E: when the invoice currency differs from home, the rate at
  // payment time will usually differ from the rate at issue. The Bank
  // gets debited at the payment-time rate; AR is cleared at the
  // issue-time rate; the difference lands in 4910 FX Gain or 6900 FX
  // Loss. Same-currency payments fall through with delta = 0 and no
  // FX line.
  const settings = await getFinanceSettings(invoice.companyId);
  const home = settings.homeCurrency;
  const accounts = await requireAccountsByCode(invoice.companyId, [
    "1100",
    "1200",
    "4910",
    "6900",
  ]);
  const bank = options.bankAccountId
    ? await requireCashAccount(invoice.companyId, options.bankAccountId)
    : accounts.get("1100")!;
  const ar = accounts.get("1200")!;
  const fxGain = accounts.get("4910")!;
  const fxLoss = accounts.get("6900")!;

  const atPayment = await convertCents(
    invoice.companyId,
    payment.amountCents,
    invoice.currency,
    home,
    payment.paidAt,
  );
  const atIssue = await convertCents(
    invoice.companyId,
    payment.amountCents,
    invoice.currency,
    home,
    invoice.issueDate,
  );
  const fxDelta = atPayment.converted - atIssue.converted;

  const lines: Array<{
    accountId: string;
    debitCents?: number;
    creditCents?: number;
    description?: string;
    origCurrency?: string;
    origAmountCents?: number;
    rate?: number;
  }> = [
    {
      accountId: bank.id,
      debitCents: atPayment.converted,
      description: payment.reference || invoice.number,
      origCurrency: invoice.currency,
      origAmountCents: payment.amountCents,
      rate: atPayment.rate,
    },
    {
      accountId: ar.id,
      creditCents: atIssue.converted,
      description: invoice.number,
      origCurrency: invoice.currency,
      origAmountCents: payment.amountCents,
      rate: atIssue.rate,
    },
  ];
  if (fxDelta > 0) {
    lines.push({
      accountId: fxGain.id,
      creditCents: fxDelta,
      description: `FX gain on ${invoice.number}`,
    });
  } else if (fxDelta < 0) {
    lines.push({
      accountId: fxLoss.id,
      debitCents: -fxDelta,
      description: `FX loss on ${invoice.number}`,
    });
  }

  await postLedgerEntry({
    companyId: invoice.companyId,
    date: payment.paidAt,
    memo: `Payment for ${invoice.number} (${payment.method})`,
    source: "invoice_payment",
    sourceRefId: payment.id,
    createdById: actorUserId,
    lines,
  });
}

/**
 * Reverse the payment's ledger entry — used when a payment row is
 * deleted. The original entry stays for audit; a new mirroring entry
 * with debits and credits flipped lands alongside.
 */
export async function reverseInvoicePayment(
  invoice: Invoice,
  payment: InvoicePayment,
  actorUserId: string | null,
): Promise<void> {
  await reverseLedgerEntriesForSources({
    companyId: invoice.companyId,
    sources: ["invoice_payment"],
    sourceRefIds: [payment.id],
    reverseAs: "invoice_void",
    reverseRefId: `${payment.id}-deletion`,
    date: new Date(),
    memo: `Payment deletion for ${invoice.number}`,
    createdById: actorUserId,
  });
}

export async function voidInvoice(
  invoice: Invoice,
  actorUserId: string | null = null,
): Promise<Invoice> {
  if (invoice.status === "void") return invoice;
  if (invoice.status === "draft") {
    throw new Error("Drafts cannot be voided — delete them instead");
  }
  // A void means "this invoice should never have been issued", so it may
  // only unwind the *issue* posting. Refusing a settled invoice is not
  // optional bookkeeping politeness: without it, the narrowed reversal
  // below would leave the payment's DR Bank / CR AR live while its
  // offsetting AR debit disappeared, stranding 1200 credit-negative for
  // this invoice. Money that genuinely arrived is given back with a
  // refund or a credit note — never by rewriting history.
  if (invoice.paidCents > 0) {
    throw new Error(
      "This invoice has payments recorded against it and can't be voided. Refund or credit it instead.",
    );
  }
  // Credits applied and write-offs also relieved this invoice's AR through
  // their own postings; voiding would reverse the issue and strand those.
  // Unwind them first (unapply the credit, reverse the write-off) — then the
  // invoice is clean and can be voided.
  if (invoice.creditedCents > 0) {
    throw new Error(
      "This invoice has credit applied to it. Unapply the credit before voiding it.",
    );
  }
  if (invoice.writtenOffCents > 0) {
    throw new Error(
      "This invoice has a write-off against it. Reverse the write-off before voiding it.",
    );
  }
  // The reversal is dated today, so voiding an invoice that was issued
  // inside a closed period would smear that period's revenue into the
  // current one and silently change numbers the books were closed on.
  const closed = await findClosedPeriodCovering(invoice.companyId, invoice.issueDate);
  if (closed) {
    throw new Error(
      `This invoice was issued in the closed period "${closed.name}" and can't be voided. Reopen the period first.`,
    );
  }
  invoice.status = "void";
  invoice.voidedAt = new Date();
  await AppDataSource.getRepository(Invoice).save(invoice);
  // Reverse ONLY the issue posting — the original plus any revisions an edit
  // wrote, which together are what the books say this invoice is worth — and
  // key it off the invoice id so re-voiding is a no-op.
  // `reverseLedgerEntriesForSources` resolves `sources` against
  // `sourceRefIds` as an UNPAIRED CROSS PRODUCT, so naming "invoice_payment"
  // here alongside the payment ids used to reverse every payment too —
  // posting CR Bank and driving cash down by money that was actually
  // collected, with no refund anywhere. Both sources below are keyed on the
  // invoice id and both are meant; never add a second refId.
  await reverseLedgerEntriesForSources({
    companyId: invoice.companyId,
    sources: ISSUE_POSTING_SOURCES,
    sourceRefIds: [invoice.id],
    reverseAs: "invoice_void",
    reverseRefId: invoice.id,
    date: new Date(),
    memo: `Void of invoice ${invoice.number}`,
    createdById: actorUserId,
  });
  return invoice;
}

// ──────────────────────────── Editing ────────────────────────────────

/** An edit the invoice's state forbids, with the status the route answers. */
export class InvoiceEditError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = "InvoiceEditError";
  }
}

export type InvoiceEditInput = DiscountInput & {
  subsidiaryId?: string | null;
  customerId?: string;
  issueDate?: Date;
  dueDate?: Date;
  currency?: string;
  notes?: string;
  footer?: string;
  lines?: LineDraft[];
};

export type InvoiceEditResult = {
  invoice: Invoice;
  /** The fields whose value actually changed — what the History row names. */
  changed: string[];
  /** The invoice was already issued, so the customer holds an older copy. */
  afterIssue: boolean;
  previousTotalCents: number;
  /** Journal entries posted to correct the books. */
  revisionEntries: number;
};

/** Same calendar day in UTC: all a date field in the edit form can say. */
export function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

/** Write already-priced lines as an invoice's complete set of lines. */
async function saveInvoiceLines(
  invoice: Invoice,
  lines: ReadonlyArray<PricedLine | InvoiceLineItem>,
): Promise<void> {
  const lineRepo = AppDataSource.getRepository(InvoiceLineItem);
  await lineRepo.delete({ invoiceId: invoice.id });
  if (lines.length === 0) return;
  await lineRepo.save(lines.map((line) => lineRepo.create({ ...line, invoiceId: invoice.id })));
}

/**
 * Edit an invoice. A draft takes any change. An issued invoice — sent or
 * paid — stays editable so a mistake can be corrected and the invoice resent
 * under the same number, within what keeps it the same invoice and keeps the
 * books whole:
 *
 *   - Its customer and issuer are fixed at issue: the number belongs to that
 *     customer, from that legal entity. Void and duplicate it to change them.
 *   - Its total must stay positive, and can't drop below what is already
 *     settled — paid, credited or written off.
 *   - Once money is applied its currency is fixed, and so is the issue date of
 *     a foreign-currency invoice, whose payments cleared the receivable at
 *     that date's exchange rate.
 *   - A change to its amounts — lines or discount — currency or issue date
 *     posts an `invoice_revision` entry ({@link postInvoiceRevision}), so it
 *     is refused inside a closed period like any other posting. If the ledger
 *     refuses the entry, the edit is put back and the ledger's reason surfaces.
 *
 * An issued invoice's unchanged lines are left exactly as saved, and changed
 * ones keep the tax rates it was issued with. Nothing here emails the
 * customer; resending is its own step.
 */
export async function updateInvoice(
  invoice: Invoice,
  input: InvoiceEditInput,
  actorUserId: string | null,
): Promise<InvoiceEditResult> {
  if (invoice.status === "void") {
    throw new InvoiceEditError("Voided invoices cannot be edited", 409);
  }
  const companyId = invoice.companyId;
  const issued = invoice.status !== "draft";
  const repo = AppDataSource.getRepository(Invoice);
  const existingLines = await AppDataSource.getRepository(InvoiceLineItem).find({
    where: { invoiceId: invoice.id },
    order: { sortOrder: "ASC" },
  });
  const previousDiscount = discountOf(invoice);
  const previous = {
    subsidiaryId: invoice.subsidiaryId,
    issuerSnapshot: invoice.issuerSnapshot,
    customerId: invoice.customerId,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    currency: invoice.currency,
    notes: invoice.notes,
    footer: invoice.footer,
    ...previousDiscount,
  };
  const previousTotals = documentTotals(existingLines, previousDiscount);
  let nextDiscount: DocumentDiscount;
  try {
    nextDiscount = requestedDiscount(input, previousDiscount);
  } catch (err) {
    throw new InvoiceEditError((err as Error).message, 400);
  }
  const discountChanged = !sameDiscount(nextDiscount, previousDiscount);

  const customerChanged = input.customerId !== undefined && input.customerId !== invoice.customerId;
  const subsidiaryChanged =
    input.subsidiaryId !== undefined && input.subsidiaryId !== invoice.subsidiaryId;
  const currencyChanged = input.currency !== undefined && input.currency !== invoice.currency;
  const issueDateChanged =
    input.issueDate !== undefined && !sameUtcDay(input.issueDate, invoice.issueDate);
  const dueDateChanged = input.dueDate !== undefined && !sameUtcDay(input.dueDate, invoice.dueDate);
  const linesChanged = input.lines !== undefined && !linesUnchanged(existingLines, input.lines);
  // A draft re-prices whatever lines it is sent, picking up current tax rates.
  // An issued invoice only re-prices lines that actually changed.
  const priced =
    input.lines !== undefined && (!issued || linesChanged)
      ? await priceLineDrafts(
          companyId,
          input.lines,
          issued ? keptTaxSnapshots(existingLines) : undefined,
        )
      : null;
  const nextTotals = documentTotals(priced ?? existingLines, nextDiscount);
  // On an issued invoice the same day keeps the stored moment.
  const nextIssueDate =
    input.issueDate !== undefined && (!issued || issueDateChanged)
      ? input.issueDate
      : invoice.issueDate;

  const label = invoice.number || "This invoice";
  const amountsChanged =
    nextTotals.totalCents !== previousTotals.totalCents ||
    nextTotals.subtotalCents !== previousTotals.subtotalCents ||
    nextTotals.taxCents !== previousTotals.taxCents;
  const ledgerMoves = issued && (amountsChanged || currencyChanged || issueDateChanged);

  if (issued) {
    if (customerChanged) {
      throw new InvoiceEditError(
        `The customer can't change after an invoice is issued — ${label} is numbered for them. Void it and duplicate it to bill someone else.`,
        409,
      );
    }
    if (subsidiaryChanged) {
      throw new InvoiceEditError(
        "The issuer can't change after an invoice is issued. Void it and duplicate it to issue it from another entity.",
        409,
      );
    }
    const settled = invoice.paidCents + invoice.creditedCents + invoice.writtenOffCents;
    if (currencyChanged && settled > 0) {
      throw new InvoiceEditError(
        "The currency can't change once a payment, credit or write-off is recorded against the invoice.",
        409,
      );
    }
    if (issueDateChanged && settled > 0) {
      const { homeCurrency } = await getFinanceSettings(companyId);
      if (invoice.currency.toUpperCase() !== homeCurrency.toUpperCase()) {
        throw new InvoiceEditError(
          `The issue date of a ${invoice.currency} invoice can't change once money is applied to it — its payments, credits and write-offs were booked at the original date's exchange rate.`,
          409,
        );
      }
    }
    if (nextTotals.totalCents <= 0) {
      throw new InvoiceEditError(
        "An issued invoice must keep a positive total. Void it instead to cancel it.",
        400,
      );
    }
    if (nextTotals.totalCents < settled) {
      throw new InvoiceEditError(
        `The new total of ${formatMoney(nextTotals.totalCents, invoice.currency)} is less than the ${formatMoney(settled, invoice.currency)} already paid, credited or written off. Remove a payment, credit or write-off first.`,
        400,
      );
    }
    if (ledgerMoves) {
      const closedNow = await findClosedPeriodCovering(companyId, previous.issueDate);
      if (closedNow) {
        throw new InvoiceEditError(
          `${label} was issued in the closed period "${closedNow.name}", so its amounts and dates can't change. Reopen the period first.`,
          409,
        );
      }
      if (issueDateChanged) {
        const closedNext = await findClosedPeriodCovering(companyId, nextIssueDate);
        if (closedNext) {
          throw new InvoiceEditError(
            `The new issue date falls in the closed period "${closedNext.name}". Reopen it or choose another date.`,
            409,
          );
        }
      }
    }
  }

  let customer: Customer | null = null;
  if (customerChanged) {
    customer = await AppDataSource.getRepository(Customer).findOneBy({
      id: input.customerId,
      companyId,
    });
    if (!customer) throw new InvoiceEditError("Invalid customer", 400);
  }
  if (subsidiaryChanged) {
    Object.assign(invoice, await resolveDocumentIssuer(companyId, input.subsidiaryId ?? null));
  }

  const changed: string[] = [];
  if (customerChanged) changed.push("customer");
  if (subsidiaryChanged) changed.push("issuer");
  if (issueDateChanged) changed.push("issueDate");
  if (dueDateChanged) changed.push("dueDate");
  if (currencyChanged) changed.push("currency");
  if (input.notes !== undefined && input.notes !== invoice.notes) changed.push("notes");
  if (input.footer !== undefined && input.footer !== invoice.footer) changed.push("footer");
  if (linesChanged) changed.push("lines");
  if (discountChanged) changed.push("discount");

  if (customer) invoice.customerId = customer.id;
  Object.assign(invoice, nextDiscount);
  if (input.notes !== undefined) invoice.notes = input.notes;
  if (input.footer !== undefined) invoice.footer = input.footer;
  if (input.currency !== undefined) invoice.currency = input.currency;
  invoice.issueDate = nextIssueDate;
  if (input.dueDate !== undefined && (!issued || dueDateChanged)) invoice.dueDate = input.dueDate;
  await repo.save(invoice);
  if (priced) await saveInvoiceLines(invoice, priced);
  const recomputed = await recomputeInvoiceTotals(invoice);

  let revisionEntries = 0;
  if (ledgerMoves) {
    try {
      revisionEntries = await postInvoiceRevision(recomputed, previous.issueDate, actorUserId);
    } catch (err) {
      // The books refused the change (a missing exchange rate, an archived
      // account). Put the invoice back so the document never says something
      // the ledger doesn't.
      Object.assign(recomputed, previous);
      await repo.save(recomputed);
      if (priced) await saveInvoiceLines(recomputed, existingLines);
      await recomputeInvoiceTotals(recomputed);
      throw new InvoiceEditError((err as Error).message, 400);
    }
  }
  return {
    invoice: recomputed,
    changed,
    afterIssue: issued,
    previousTotalCents: previousTotals.totalCents,
    revisionEntries,
  };
}

// ─────────────────────────── Duplicate ───────────────────────────────

/**
 * Create a fresh `draft` invoice that copies the customer, currency,
 * discount, notes, footer, and (tax-snapshotted) line items from `source`. Used
 * by the "Duplicate" action on any invoice regardless of status — you
 * can fork a paid or void invoice back into a new draft without
 * touching the original (and without copying payments).
 *
 * The new invoice gets a brand-new `draft-…` slug, `numberSeq = 0`,
 * `number = ""`, and `issueDate` / `dueDate` reset to "today + 14
 * days" so the dates are sensible defaults instead of stale copies.
 * Status timestamps (`sentAt`, `paidAt`, `voidedAt`) and payments are
 * intentionally not carried over.
 */
export async function duplicateInvoice(
  source: Invoice,
  actorUserId: string | null,
): Promise<Invoice> {
  const repo = AppDataSource.getRepository(Invoice);
  const slug = await uniqueDraftInvoiceSlug(source.companyId);
  const issueDate = new Date();
  const dueDate = new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000);
  const draft = repo.create({
    companyId: source.companyId,
    customerId: source.customerId,
    subsidiaryId: source.subsidiaryId,
    issuerSnapshot: source.issuerSnapshot,
    slug,
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    dueDate,
    currency: source.currency,
    ...discountOf(source),
    notes: source.notes,
    footer: source.footer,
    createdById: actorUserId,
  });
  await repo.save(draft);

  const sourceLines = await AppDataSource.getRepository(InvoiceLineItem).find({
    where: { invoiceId: source.id },
    order: { sortOrder: "ASC" },
  });
  if (sourceLines.length > 0) {
    const lineRepo = AppDataSource.getRepository(InvoiceLineItem);
    await lineRepo.save(
      sourceLines.map((l) =>
        lineRepo.create({
          invoiceId: draft.id,
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
  }
  return recomputeInvoiceTotals(draft);
}

async function uniqueDraftInvoiceSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Invoice);
  for (let i = 0; i < 16; i += 1) {
    const slug = `draft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `draft-${Date.now().toString(36)}`;
}

// ──────────────────────────── Archive ─────────────────────────────────

export type InvoiceArchiveAction = "archive" | "restore";

export type InvoiceArchiveOutcome = {
  /** Invoices whose archived state changed, in request order. */
  changed: Invoice[];
  /** Ids left as they were, each with the reason. */
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Archive or restore a set of invoices in one call — the list page's bulk
 * action, and the single-row and detail-page actions too.
 *
 * Archiving files an invoice out of the default lists and nothing else: its
 * status, number, payments, PDF, and ledger entries stay exactly as they
 * were, and it still counts in every balance, statement, and report. Only an
 * invoice with nothing left to collect can be archived
 * (`invoiceArchiveBlocker`); `recomputeInvoiceTotals` brings one back if it
 * is owed money again. An id that is not this company's invoice, is already
 * in the requested state, or still has a balance due is skipped with a
 * reason rather than failing the rest of the batch.
 */
export async function setInvoicesArchived(
  companyId: string,
  ids: string[],
  action: InvoiceArchiveAction,
): Promise<InvoiceArchiveOutcome> {
  const requested = [...new Set(ids)];
  if (requested.length === 0) return { changed: [], skipped: [] };
  const repo = AppDataSource.getRepository(Invoice);
  const found = await repo.findBy({ companyId, id: In(requested) });
  const byId = new Map(found.map((invoice) => [invoice.id, invoice]));
  const archivedAt = action === "archive" ? new Date() : null;
  const changed: Invoice[] = [];
  const skipped: InvoiceArchiveOutcome["skipped"] = [];
  for (const id of requested) {
    const invoice = byId.get(id);
    const blocker = invoice && action === "archive" ? invoiceArchiveBlocker(invoice) : null;
    if (!invoice) {
      skipped.push({ id, reason: "Invoice not found" });
    } else if (action === "archive" && invoice.archivedAt) {
      skipped.push({ id, reason: "Already archived" });
    } else if (action === "restore" && !invoice.archivedAt) {
      skipped.push({ id, reason: "Not archived" });
    } else if (blocker) {
      skipped.push({ id, reason: blocker });
    } else {
      invoice.archivedAt = archivedAt;
      changed.push(invoice);
    }
  }
  // Only `archivedAt` is written, so a payment recorded since the read above
  // keeps the balance it set. A partial `save` rather than a bulk UPDATE: the
  // live-sync subscriber needs each row to tell open pages to refetch.
  if (changed.length > 0) {
    await repo.save(changed.map((invoice) => ({ id: invoice.id, archivedAt: invoice.archivedAt })));
  }
  return { changed, skipped };
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
export type DisplayStatus = InvoiceStatus | "overdue" | "written_off" | "credited";

export function displayStatus(invoice: Invoice, now: Date = new Date()): DisplayStatus {
  // A fully-settled invoice with no cash against it was cleared by a write-off
  // or a credit note (recomputeInvoiceTotals flips it to "paid" once settled
  // but only stamps paidAt when cash was involved). Surface that as its own
  // status rather than a misleading "paid". Write-off takes precedence in the
  // rare mixed case.
  if (invoice.status === "paid" && invoice.paidCents === 0) {
    if (invoice.writtenOffCents > 0) return "written_off";
    if (invoice.creditedCents > 0) return "credited";
  }
  if (invoice.status === "sent" && invoice.dueDate.getTime() < now.getTime()) {
    return "overdue";
  }
  return invoice.status;
}

// ─────────────────────────── Email send ────────────────────────────────

export type InvoiceEmailDetails = {
  toAddress: string;
  alwaysCcAddress: string;
  fromAddress: string;
  replyTo: string;
  configured: boolean;
  source: "company_provider" | "global_smtp" | "console";
};

export type InvoiceResendActivity = {
  id: string;
  createdAt: Date;
  status: "sent" | "skipped" | "failed";
  toAddress: string;
  ccAddress: string;
  fromAddress: string;
  replyTo: string;
  pdfRequested: boolean;
  pdfAttached: boolean;
  hasMessage: boolean;
  errorMessage: string;
};

async function resolveInvoiceEmailSenderPreview(
  companyId: string,
): Promise<Omit<InvoiceEmailDetails, "toAddress" | "alwaysCcAddress">> {
  const provider = await AppDataSource.getRepository(EmailProvider).findOne({
    where: { companyId, isDefault: true, enabled: true },
  });
  if (provider) {
    return {
      fromAddress: provider.fromAddress,
      replyTo: provider.replyTo,
      configured: true,
      source: "company_provider",
    };
  }

  const global = await getEffectiveGlobalSmtp();
  return {
    fromAddress: formatGlobalSmtpSender(global.settings),
    replyTo: "",
    configured: global.configured && Boolean(global.settings.host),
    source: global.configured ? "global_smtp" : "console",
  };
}

/** Resolve the addresses shown in the resend confirmation modal. */
export async function getInvoiceEmailDetails(
  companyId: string,
  invoice: Invoice,
): Promise<InvoiceEmailDetails> {
  const [customer, sender, settings] = await Promise.all([
    AppDataSource.getRepository(Customer).findOneBy({
      id: invoice.customerId,
      companyId,
    }),
    resolveInvoiceEmailSenderPreview(companyId),
    getFinanceSettings(companyId),
  ]);
  if (!customer) throw new Error("Customer not found");
  return {
    toAddress: customer.email,
    alwaysCcAddress: settings.invoiceCcEmails.join(", "),
    ...sender,
  };
}

/**
 * Read the durable manual-resend entries for an invoice from the company audit
 * trail. EmailLog remains the delivery audit; these compact events are the
 * invoice-specific activity feed correlation.
 */
export async function listInvoiceResendActivities(
  companyId: string,
  invoiceId: string,
): Promise<InvoiceResendActivity[]> {
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where: {
      companyId,
      action: "invoice.email.resend",
      targetType: "invoice",
      targetId: invoiceId,
    },
    order: { createdAt: "DESC" },
  });

  return rows.map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadataJson || "{}") as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    const status =
      metadata.status === "sent" ||
      metadata.status === "skipped" ||
      metadata.status === "failed"
        ? metadata.status
        : "failed";
    return {
      id: row.id,
      createdAt: row.createdAt,
      status,
      toAddress: typeof metadata.toAddress === "string" ? metadata.toAddress : "",
      ccAddress: typeof metadata.ccAddress === "string" ? metadata.ccAddress : "",
      fromAddress:
        typeof metadata.fromAddress === "string" ? metadata.fromAddress : "",
      replyTo: typeof metadata.replyTo === "string" ? metadata.replyTo : "",
      pdfRequested: metadata.pdfRequested === true,
      pdfAttached: metadata.pdfAttached === true,
      hasMessage: metadata.hasMessage === true,
      errorMessage:
        typeof metadata.errorMessage === "string" ? metadata.errorMessage : "",
    };
  });
}

export type InvoiceSendResult = {
  status: "sent" | "skipped" | "failed";
  logId: string;
  errorMessage: string;
  transport: string;
  toAddress: string;
  ccAddress: string;
  fromAddress: string;
  replyTo: string;
  pdfRequested: boolean;
  pdfAttached: boolean;
  hasMessage: boolean;
};

/**
 * Resolve who an invoice email would be addressed to, throwing the same
 * errors {@link sendInvoiceEmail} would.
 *
 * Split out so `/invoices/:slug/send` can refuse *before* auto-issuing a
 * draft. Issuing mints the gapless number and re-slugs the row from `draft-…`
 * to `inv-nnnn`, so a failure discovered afterwards left the caller holding a
 * URL that no longer resolved — the open detail page then reported a
 * perfectly live invoice as deleted.
 */
export async function resolveInvoiceRecipients(
  companyId: string,
  invoice: Invoice,
  options: { to?: string[] } = {},
): Promise<{ customer: Customer; to: string[] }> {
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: invoice.customerId,
    companyId,
  });
  if (!customer) throw new Error("Customer not found");
  if (!customer.email && options.to === undefined) {
    throw new Error("Customer has no email address — add one before sending");
  }
  const to = normalizeRecipientAddresses(
    options.to ?? (customer.email ? [customer.email] : []),
  );
  if (to.length === 0) throw new Error("Add at least one To recipient");
  return { customer, to };
}

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
  options: {
    message?: string;
    attachPdf?: boolean;
    to?: string[];
    cc?: string[];
  } = {},
): Promise<InvoiceSendResult> {
  const [{ customer, to }, settings] = await Promise.all([
    resolveInvoiceRecipients(companyId, invoice, options),
    getFinanceSettings(companyId),
  ]);
  const cc = normalizeRecipientAddresses([
    ...settings.invoiceCcEmails,
    ...(options.cc ?? []),
  ]).filter(
    (address) => !to.some((toAddress) => toAddress.toLowerCase() === address.toLowerCase()),
  );
  const toAddress = to.join(", ");
  const ccAddress = cc.join(", ");
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
  const [company, sender] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: companyId }),
    resolveInvoiceEmailSenderPreview(companyId),
  ]);
  const htmlInput = {
    invoice,
    customer,
    lines,
    payments,
    companyName: company?.name ?? "",
    defaultFromBlock: settings.defaultFromBlock,
    defaultFooter: settings.defaultFooter,
  };
  const invoiceHtml = renderInvoiceHtml(htmlInput);
  const message = options.message?.trim() ?? "";
  const emailHtml = message
    ? renderInvoiceHtml({ ...htmlInput, emailMessage: message })
    : invoiceHtml;
  const pdfRequested = options.attachPdf ?? true;
  // Attach a PDF copy so the customer gets a portable, printable document
  // rather than only the inline HTML body. If Chromium isn't available we
  // log and send without the attachment — the HTML body still carries the
  // full invoice, so a render hiccup never blocks the send.
  const attachments = pdfRequested
    ? await renderPdfAttachment(
        invoiceHtml,
        `${invoice.number || "invoice"}.pdf`,
        "invoice",
      )
    : undefined;
  const pdfAttached = Boolean(attachments?.length);
  const text =
    (message ? `${message}\n\n` : "") +
    `Invoice ${invoice.number || "(draft)"} from ${documentIssuerFields(invoice, htmlInput).companyName || "your supplier"} — ` +
    `${formatMoney(invoice.balanceCents, invoice.currency)} due ` +
    `${invoice.dueDate.toISOString().slice(0, 10)}.\n\n` +
    (pdfAttached
      ? `The invoice is attached as a PDF.`
      : pdfRequested
        ? `The PDF attachment could not be generated; the invoice is included in this email.`
        : `The invoice is included in this email.`);
  const subject = `Invoice ${invoice.number || "(draft)"} — ${formatMoney(
    invoice.totalCents,
    invoice.currency,
  )}`;
  const result = await sendEmail({
    to: toAddress,
    cc: ccAddress || undefined,
    subject,
    text,
    html: emailHtml,
    attachments,
    companyId,
    purpose: "other",
    triggeredByUserId,
  });
  return {
    status: result.status,
    logId: result.logId,
    errorMessage: result.errorMessage,
    transport: result.transport,
    toAddress,
    ccAddress,
    fromAddress: sender.fromAddress,
    replyTo: sender.replyTo,
    pdfRequested,
    pdfAttached,
    hasMessage: Boolean(message),
  };
}

function normalizeRecipientAddresses(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.flatMap((address) => {
    const trimmed = address.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) return [];
    seen.add(key);
    return [trimmed];
  });
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
