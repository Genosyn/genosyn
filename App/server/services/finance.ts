import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Customer } from "../db/entities/Customer.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { EmailProvider } from "../db/entities/EmailProvider.js";
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
import { renderPdfAttachment } from "./htmlToPdf.js";
import { renderInvoiceHtml } from "./invoiceHtml.js";
import { Company } from "../db/entities/Company.js";
import {
  hasEntryFor,
  postLedgerEntry,
  requireAccountsByCode,
  reverseLedgerEntriesForSources,
} from "./ledger.js";
import { convertCents, getFinanceSettings } from "./fx.js";
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
  const recomputed = await recomputeInvoiceTotals(invoice);
  // Auto-post: DR Accounts Receivable / CR Sales Revenue + Tax Payable.
  // Phase B (M19) — see services/ledger.ts and ROADMAP.md.
  await postInvoiceIssue(recomputed, actorUserId);
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

  const lines = [
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
      creditCents: subtotal.converted,
      description: `${invoice.number} — revenue`,
      origCurrency: invoice.currency,
      origAmountCents: invoice.subtotalCents,
      rate: subtotal.rate,
    },
  ];
  if (invoice.taxCents > 0) {
    lines.push({
      accountId: tax.id,
      creditCents: taxConverted.converted,
      description: `${invoice.number} — tax payable`,
      origCurrency: invoice.currency,
      origAmountCents: invoice.taxCents,
      rate: taxConverted.rate,
    });
  }
  await postLedgerEntry({
    companyId: invoice.companyId,
    date: invoice.issueDate,
    memo: `Invoice ${invoice.number} issued`,
    source: "invoice_issue",
    sourceRefId: invoice.id,
    createdById: actorUserId,
    lines,
  });
}

/**
 * Post the journal entry for a single received payment: DR Bank /
 * CR Accounts Receivable. Idempotent on `(invoice_payment, payment.id)`.
 */
export async function postInvoicePayment(
  invoice: Invoice,
  payment: InvoicePayment,
  actorUserId: string | null,
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
  const bank = accounts.get("1100")!;
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
  invoice.status = "void";
  invoice.voidedAt = new Date();
  await AppDataSource.getRepository(Invoice).save(invoice);
  // Reverse the issue + every payment posting tied to this invoice. Use
  // `invoice_void` as the new source so the audit trail makes the void
  // story obvious; the reversal is keyed off the invoice id (not a
  // payment id) so re-voiding the same invoice is a no-op.
  const payments = await AppDataSource.getRepository(InvoicePayment).find({
    where: { invoiceId: invoice.id },
    select: ["id"],
  });
  await reverseLedgerEntriesForSources({
    companyId: invoice.companyId,
    sources: ["invoice_issue", "invoice_payment"],
    sourceRefIds: [invoice.id, ...payments.map((p) => p.id)],
    reverseAs: "invoice_void",
    reverseRefId: invoice.id,
    date: new Date(),
    memo: `Void of invoice ${invoice.number}`,
    createdById: actorUserId,
  });
  return invoice;
}

// ─────────────────────────── Duplicate ───────────────────────────────

/**
 * Create a fresh `draft` invoice that copies the customer, currency,
 * notes, footer, and (tax-snapshotted) line items from `source`. Used
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
    slug,
    numberSeq: 0,
    number: "",
    status: "draft",
    issueDate,
    dueDate,
    currency: source.currency,
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

export type InvoiceEmailDetails = {
  toAddress: string;
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
  fromAddress: string;
  replyTo: string;
  pdfRequested: boolean;
  pdfAttached: boolean;
  hasMessage: boolean;
  errorMessage: string;
};

async function resolveInvoiceEmailSenderPreview(
  companyId: string,
): Promise<Omit<InvoiceEmailDetails, "toAddress">> {
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
  const [customer, sender] = await Promise.all([
    AppDataSource.getRepository(Customer).findOneBy({
      id: invoice.customerId,
      companyId,
    }),
    resolveInvoiceEmailSenderPreview(companyId),
  ]);
  if (!customer) throw new Error("Customer not found");
  return {
    toAddress: customer.email,
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
  options: { message?: string; attachPdf?: boolean } = {},
): Promise<{
  status: "sent" | "skipped" | "failed";
  logId: string;
  errorMessage: string;
  transport: string;
  toAddress: string;
  fromAddress: string;
  replyTo: string;
  pdfRequested: boolean;
  pdfAttached: boolean;
  hasMessage: boolean;
}> {
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
  const [company, settings, sender] = await Promise.all([
    AppDataSource.getRepository(Company).findOneBy({ id: companyId }),
    getFinanceSettings(companyId),
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
    `Invoice ${invoice.number || "(draft)"} from your supplier — ` +
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
    to: customer.email,
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
    toAddress: customer.email,
    fromAddress: sender.fromAddress,
    replyTo: sender.replyTo,
    pdfRequested,
    pdfAttached,
    hasMessage: Boolean(message),
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
