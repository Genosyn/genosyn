import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoiceLineItem } from "../db/entities/InvoiceLineItem.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import {
  CustomerCredit,
  type CustomerCreditKind,
} from "../db/entities/CustomerCredit.js";
import { CustomerCreditLine } from "../db/entities/CustomerCreditLine.js";
import { CustomerCreditApplication } from "../db/entities/CustomerCreditApplication.js";
import { CustomerRefund } from "../db/entities/CustomerRefund.js";
import { computeLineTotals, reconcilePartsToTotal, roundHalfAway } from "../lib/money.js";
import { convertCents, getFinanceSettings } from "./fx.js";
import { findClosedPeriodCovering, postLedgerEntry, requireAccountsByCode } from "./ledger.js";
import { recomputeInvoiceTotals } from "./finance.js";

/**
 * Customer-credit service. Phase H of the Finance milestone (M19) — see
 * ROADMAP.md.
 *
 * A credit memo reduces a past sale without cash: issue posts
 * DR 4100 Sales Returns & Allowances / DR 2100 Tax Payable / CR 2400 Customer
 * Credits — it never touches 1200 AR. Spending a credit against an invoice
 * (an application) is the only non-cash way to relieve a receivable, capped so
 * the invoice balance can never go negative. Both the issue and every
 * application/void are explicit forward-posted entries rebuilt from stored
 * carrying amounts, never reverseLedgerEntriesForSources.
 *
 * Deposits, overpayments and cash refunds arrive in Increment 5; this file
 * already routes the credit account by kind so those slot in cleanly.
 */

const AR_CODE = "1200";
const BANK_CODE = "1100";
const RETURNS_CODE = "4100";
const TAX_CODE = "2100";
const FX_GAIN_CODE = "4910";
const FX_LOSS_CODE = "6900";

/** The account a credit of this kind parks its balance in. */
function creditAccountCode(kind: CustomerCreditKind): string {
  return kind === "deposit" ? "2500" : "2400";
}

export function creditOpenCents(credit: CustomerCredit): number {
  return credit.totalCents - credit.appliedCents - credit.refundedCents;
}

export type CreditLineDraft = {
  productId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

// ─────────────────────────── Numbering + slugs ─────────────────────────

async function mintNextCreditSeq(companyId: string, customerId: string): Promise<number> {
  const last = await AppDataSource.getRepository(CustomerCredit).findOne({
    where: { companyId, customerId },
    order: { numberSeq: "DESC" },
    select: ["numberSeq"],
  });
  return (last?.numberSeq ?? 0) + 1;
}

function formatCreditNumber(seq: number, prefix?: string): string {
  const p = prefix ? `${prefix.toUpperCase()}-` : "";
  return `${p}CN-${String(seq).padStart(4, "0")}`;
}

async function draftCreditSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(CustomerCredit);
  for (let i = 0; i < 16; i += 1) {
    const slug = `cndraft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `cndraft-${Date.now().toString(36)}`;
}

// ─────────────────────────────── Tax snapshot ──────────────────────────

async function snapshotTax(
  companyId: string,
  taxRateId: string | null | undefined,
): Promise<{ taxRateId: string | null; taxName: string; taxPercent: number; taxInclusive: boolean }> {
  if (!taxRateId) return { taxRateId: null, taxName: "", taxPercent: 0, taxInclusive: false };
  const rate = await AppDataSource.getRepository(TaxRate).findOneBy({ id: taxRateId, companyId });
  if (!rate) return { taxRateId: null, taxName: "", taxPercent: 0, taxInclusive: false };
  return {
    taxRateId: rate.id,
    taxName: rate.name,
    taxPercent: rate.ratePercent,
    taxInclusive: rate.inclusive,
  };
}

async function recomputeCreditTotals(credit: CustomerCredit): Promise<CustomerCredit> {
  const lines = await AppDataSource.getRepository(CustomerCreditLine).find({
    where: { creditId: credit.id },
  });
  credit.subtotalCents = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  credit.taxCents = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  credit.totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  return AppDataSource.getRepository(CustomerCredit).save(credit);
}

// ─────────────────────────────── Loaders ───────────────────────────────

export async function loadCreditBySlug(
  companyId: string,
  slug: string,
): Promise<CustomerCredit | null> {
  return AppDataSource.getRepository(CustomerCredit).findOneBy({ companyId, slug });
}

export async function listCustomerCredits(companyId: string): Promise<CustomerCredit[]> {
  return AppDataSource.getRepository(CustomerCredit).find({
    where: { companyId },
    order: { createdAt: "DESC" },
  });
}

export async function getCreditLines(creditId: string): Promise<CustomerCreditLine[]> {
  return AppDataSource.getRepository(CustomerCreditLine).find({
    where: { creditId },
    order: { sortOrder: "ASC" },
  });
}

export async function listCreditApplications(
  creditId: string,
): Promise<CustomerCreditApplication[]> {
  return AppDataSource.getRepository(CustomerCreditApplication).find({
    where: { creditId },
    order: { createdAt: "ASC" },
  });
}

export async function listApplicationsForInvoice(
  invoiceId: string,
): Promise<CustomerCreditApplication[]> {
  return AppDataSource.getRepository(CustomerCreditApplication).find({
    where: { invoiceId },
    order: { createdAt: "ASC" },
  });
}

// ─────────────────── creditedCents maintenance on the invoice ───────────

async function refreshInvoiceAfterCredit(invoice: Invoice): Promise<Invoice> {
  const apps = await AppDataSource.getRepository(CustomerCreditApplication).find({
    where: { invoiceId: invoice.id, reversedAt: IsNull() },
    select: ["amountCents"],
  });
  invoice.creditedCents = apps.reduce((s, a) => s + a.amountCents, 0);
  return recomputeInvoiceTotals(invoice);
}

// ─────────────────────────────── Create ────────────────────────────────

async function buildCreditLinesFromDrafts(
  credit: CustomerCredit,
  drafts: CreditLineDraft[],
): Promise<void> {
  const repo = AppDataSource.getRepository(CustomerCreditLine);
  await repo.delete({ creditId: credit.id });
  const rows: CustomerCreditLine[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const tax = await snapshotTax(credit.companyId, d.taxRateId);
    const totals = computeLineTotals({
      quantity: d.quantity,
      unitPriceCents: d.unitPriceCents,
      taxPercent: tax.taxPercent,
      taxInclusive: tax.taxInclusive,
    });
    rows.push(
      repo.create({
        creditId: credit.id,
        productId: d.productId ?? null,
        description: d.description,
        quantity: d.quantity,
        unitPriceCents: d.unitPriceCents,
        ...tax,
        ...totals,
        sortOrder: d.sortOrder ?? i,
      }),
    );
  }
  if (rows.length) await repo.save(rows);
}

export type CreateCreditInput = {
  customerId: string;
  currency: string;
  sourceInvoiceId?: string | null;
  lines: CreditLineDraft[];
  reason?: string;
  notes?: string;
  issueDate?: Date;
};

export async function createCreditNoteDraft(
  companyId: string,
  input: CreateCreditInput,
  actorUserId: string | null,
): Promise<CustomerCredit> {
  if (input.lines.length === 0) throw new Error("A credit note needs at least one line");
  const repo = AppDataSource.getRepository(CustomerCredit);
  const credit = await repo.save(
    repo.create({
      companyId,
      customerId: input.customerId,
      kind: "credit_memo",
      status: "draft",
      numberSeq: 0,
      number: "",
      slug: await draftCreditSlug(companyId),
      sourceInvoiceId: input.sourceInvoiceId ?? null,
      currency: input.currency,
      reason: input.reason ?? "",
      notes: input.notes ?? "",
      issueDate: input.issueDate ?? new Date(),
      createdById: actorUserId,
    }),
  );
  await buildCreditLinesFromDrafts(credit, input.lines);
  return recomputeCreditTotals(credit);
}

/**
 * Raise a credit memo directly from an invoice. `mode: "full"` copies every
 * invoice line VERBATIM (snapshots and all) so the memo mirrors the sale
 * exactly; `mode: "amount"` adds a single ex-tax adjustment line. Returns a
 * draft — the caller issues it.
 */
export async function createCreditNoteFromInvoice(
  invoice: Invoice,
  opts: { mode: "full" | "amount"; amountCents?: number; reason?: string; notes?: string },
  actorUserId: string | null,
): Promise<CustomerCredit> {
  const repo = AppDataSource.getRepository(CustomerCredit);
  const credit = await repo.save(
    repo.create({
      companyId: invoice.companyId,
      customerId: invoice.customerId,
      kind: "credit_memo",
      status: "draft",
      numberSeq: 0,
      number: "",
      slug: await draftCreditSlug(invoice.companyId),
      sourceInvoiceId: invoice.id,
      currency: invoice.currency,
      reason: opts.reason ?? "",
      notes: opts.notes ?? "",
      issueDate: new Date(),
      createdById: actorUserId,
    }),
  );
  const lineRepo = AppDataSource.getRepository(CustomerCreditLine);
  if (opts.mode === "full") {
    const invLines = await AppDataSource.getRepository(InvoiceLineItem).find({
      where: { invoiceId: invoice.id },
      order: { sortOrder: "ASC" },
    });
    await lineRepo.save(
      invLines.map((l) =>
        lineRepo.create({
          creditId: credit.id,
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
  } else {
    const amount = Math.trunc(opts.amountCents ?? 0);
    if (amount <= 0) throw new Error("Credit amount must be positive");
    await lineRepo.save(
      lineRepo.create({
        creditId: credit.id,
        productId: null,
        description: `Credit against ${invoice.number || invoice.slug}`,
        quantity: 1,
        unitPriceCents: amount,
        taxRateId: null,
        taxName: "",
        taxPercent: 0,
        taxInclusive: false,
        lineSubtotalCents: amount,
        lineTaxCents: 0,
        lineTotalCents: amount,
        sortOrder: 0,
      }),
    );
  }
  return recomputeCreditTotals(credit);
}

// ─────────────────────────────── Issue ─────────────────────────────────

export async function issueCreditNote(
  credit: CustomerCredit,
  actorUserId: string | null,
): Promise<CustomerCredit> {
  if (credit.status !== "draft") throw new Error("Only a draft credit note can be issued");
  if (credit.totalCents <= 0) throw new Error("A credit note must have a positive total");

  // Cumulative cap against the source invoice, enforced at issue on subtotal,
  // tax AND total independently and in document currency — so several draft
  // memos can't collude to over-credit a sale, and a memo never reverses more
  // tax or revenue than the invoice recognized.
  if (credit.sourceInvoiceId) {
    const invoice = await AppDataSource.getRepository(Invoice).findOneBy({
      id: credit.sourceInvoiceId,
      companyId: credit.companyId,
    });
    if (!invoice) throw new Error("Source invoice no longer exists");
    if (invoice.currency !== credit.currency) {
      throw new Error("Credit note currency must match the source invoice");
    }
    const priorMemos = await AppDataSource.getRepository(CustomerCredit).find({
      where: {
        companyId: credit.companyId,
        sourceInvoiceId: invoice.id,
        kind: "credit_memo",
        status: "issued",
      },
      select: ["subtotalCents", "taxCents", "totalCents"],
    });
    const priorSub = priorMemos.reduce((s, m) => s + m.subtotalCents, 0);
    const priorTax = priorMemos.reduce((s, m) => s + m.taxCents, 0);
    const priorTotal = priorMemos.reduce((s, m) => s + m.totalCents, 0);
    if (priorSub + credit.subtotalCents > invoice.subtotalCents) {
      throw new Error("Credit notes would exceed the invoice's net (pre-tax) amount");
    }
    if (priorTax + credit.taxCents > invoice.taxCents) {
      throw new Error("Credit notes would exceed the invoice's tax");
    }
    if (priorTotal + credit.totalCents > invoice.totalCents) {
      throw new Error("Credit notes would exceed the invoice total");
    }
  }

  const settings = await getFinanceSettings(credit.companyId);
  const home = settings.homeCurrency;
  const rateDate = await creditRateDate(credit);
  const homeTotal = (await convertCents(credit.companyId, credit.totalCents, credit.currency, home, rateDate)).converted;
  const homeSubRaw = (await convertCents(credit.companyId, credit.subtotalCents, credit.currency, home, rateDate)).converted;
  const homeTaxRaw = (await convertCents(credit.companyId, credit.taxCents, credit.currency, home, rateDate)).converted;
  const [homeSubtotal, homeTax] = reconcilePartsToTotal(homeTotal, [homeSubRaw, homeTaxRaw]);
  if (homeTotal <= 0) throw new Error("Converted credit total rounds to zero");

  const accounts = await requireAccountsByCode(credit.companyId, [RETURNS_CODE, TAX_CODE, creditAccountCode(credit.kind)]);
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: credit.customerId,
    companyId: credit.companyId,
  });

  const seq = await mintNextCreditSeq(credit.companyId, credit.customerId);
  credit.numberSeq = seq;
  credit.number = formatCreditNumber(seq, customer?.slug);
  credit.slug = credit.number.toLowerCase();
  credit.status = "issued";
  credit.issuedAt = new Date();
  credit.homeSubtotalCents = homeSubtotal;
  credit.homeTaxCents = homeTax;
  credit.homeTotalCents = homeTotal;
  await AppDataSource.getRepository(CustomerCredit).save(credit);

  const lines: Array<{ accountId: string; debitCents?: number; creditCents?: number; description?: string }> = [];
  if (homeSubtotal > 0) {
    lines.push({ accountId: accounts.get(RETURNS_CODE)!.id, debitCents: homeSubtotal, description: `Credit ${credit.number}` });
  }
  if (homeTax > 0) {
    lines.push({ accountId: accounts.get(TAX_CODE)!.id, debitCents: homeTax, description: `Credit ${credit.number} tax` });
  }
  lines.push({ accountId: accounts.get(creditAccountCode(credit.kind))!.id, creditCents: homeTotal, description: `Credit ${credit.number}` });

  await postLedgerEntry({
    companyId: credit.companyId,
    date: credit.issueDate,
    memo: `Credit note ${credit.number}`,
    source: "credit_note_issue",
    sourceRefId: credit.id,
    createdById: actorUserId,
    lines,
  });
  return credit;
}

async function creditRateDate(credit: CustomerCredit): Promise<Date> {
  // A memo is a correction to a past sale, so value it at that sale's rate.
  if (credit.sourceInvoiceId) {
    const inv = await AppDataSource.getRepository(Invoice).findOneBy({
      id: credit.sourceInvoiceId,
      companyId: credit.companyId,
    });
    if (inv) return inv.issueDate;
  }
  return credit.issueDate;
}

// ─────────────────────────────── Apply ─────────────────────────────────

export async function applyCustomerCredit(
  credit: CustomerCredit,
  invoice: Invoice,
  amountCents: number,
  actorUserId: string | null,
): Promise<CustomerCreditApplication> {
  if (credit.status !== "issued") throw new Error("Only an issued credit can be applied");
  if (invoice.status !== "sent" && invoice.status !== "paid") {
    throw new Error("A credit can only be applied to an issued invoice");
  }
  if (invoice.customerId !== credit.customerId) {
    throw new Error("Credit and invoice belong to different customers");
  }
  if (invoice.currency !== credit.currency) {
    throw new Error("Credit and invoice must be in the same currency");
  }
  const amount = Math.trunc(amountCents);
  const cap = Math.min(creditOpenCents(credit), invoice.balanceCents);
  if (amount <= 0) throw new Error("Application amount must be positive");
  if (amount > cap) {
    throw new Error(
      `Application ${amount} exceeds the room available (credit open ${creditOpenCents(credit)}, invoice balance ${invoice.balanceCents})`,
    );
  }
  const appliedAt = new Date();
  const closed = await findClosedPeriodCovering(credit.companyId, appliedAt);
  if (closed) throw new Error(`That date falls in the closed period "${closed.name}".`);

  const settings = await getFinanceSettings(credit.companyId);
  const home = settings.homeCurrency;
  // Relieve AR at the rate the invoice booked it.
  const arCents = (await convertCents(credit.companyId, amount, invoice.currency, home, invoice.issueDate)).converted;
  // Consume the credit's home carrying value; the final draw takes the exact
  // remaining home balance so the sum of applications equals homeTotalCents.
  const isFinalDraw = amount === creditOpenCents(credit);
  const creditCents = isFinalDraw
    ? credit.homeTotalCents - credit.homeAppliedCents - credit.homeRefundedCents
    : roundHalfAway((amount * credit.homeTotalCents) / credit.totalCents);
  const fxCents = creditCents - arCents;

  const accounts = await requireAccountsByCode(credit.companyId, [
    AR_CODE,
    creditAccountCode(credit.kind),
    FX_GAIN_CODE,
    FX_LOSS_CODE,
  ]);
  const lines: Array<{ accountId: string; debitCents?: number; creditCents?: number; description?: string }> = [
    { accountId: accounts.get(creditAccountCode(credit.kind))!.id, debitCents: creditCents, description: `Apply ${credit.number}` },
    { accountId: accounts.get(AR_CODE)!.id, creditCents: arCents, description: `Apply ${credit.number} to ${invoice.number}` },
  ];
  if (fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, creditCents: fxCents, description: "FX on credit application" });
  } else if (fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, debitCents: -fxCents, description: "FX on credit application" });
  }

  const appRepo = AppDataSource.getRepository(CustomerCreditApplication);
  const application = await appRepo.save(
    appRepo.create({
      companyId: credit.companyId,
      creditId: credit.id,
      invoiceId: invoice.id,
      amountCents: amount,
      arCents,
      creditCents,
      fxCents,
      appliedAt,
      createdById: actorUserId,
      reversedAt: null,
      reversedById: null,
    }),
  );
  await postLedgerEntry({
    companyId: credit.companyId,
    date: appliedAt,
    memo: `Credit ${credit.number} applied to ${invoice.number}`,
    source: "credit_note_apply",
    sourceRefId: application.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines,
  });

  credit.appliedCents += amount;
  credit.homeAppliedCents += creditCents;
  await AppDataSource.getRepository(CustomerCredit).save(credit);
  await refreshInvoiceAfterCredit(invoice);
  return application;
}

// ─────────────────────────────── Unapply ───────────────────────────────

export async function unapplyCustomerCredit(
  application: CustomerCreditApplication,
  actorUserId: string | null,
): Promise<void> {
  if (application.reversedAt) throw new Error("This application has already been reversed");
  const credit = await AppDataSource.getRepository(CustomerCredit).findOneBy({
    id: application.creditId,
    companyId: application.companyId,
  });
  if (!credit) throw new Error("Credit not found");
  const invoice = await AppDataSource.getRepository(Invoice).findOneBy({
    id: application.invoiceId,
    companyId: application.companyId,
  });
  const date = new Date();
  const closed = await findClosedPeriodCovering(application.companyId, date);
  if (closed) throw new Error(`The reversal would post into the closed period "${closed.name}".`);

  const accounts = await requireAccountsByCode(application.companyId, [
    AR_CODE,
    creditAccountCode(credit.kind),
    FX_GAIN_CODE,
    FX_LOSS_CODE,
  ]);
  const lines: Array<{ accountId: string; debitCents?: number; creditCents?: number; description?: string }> = [
    { accountId: accounts.get(AR_CODE)!.id, debitCents: application.arCents, description: "Unapply credit" },
    { accountId: accounts.get(creditAccountCode(credit.kind))!.id, creditCents: application.creditCents, description: "Unapply credit" },
  ];
  if (application.fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, debitCents: application.fxCents, description: "FX reversal" });
  } else if (application.fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, creditCents: -application.fxCents, description: "FX reversal" });
  }
  await postLedgerEntry({
    companyId: application.companyId,
    date,
    memo: `Unapply credit ${credit.number}`,
    source: "credit_note_unapply",
    sourceRefId: application.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines,
  });

  application.reversedAt = date;
  application.reversedById = actorUserId;
  await AppDataSource.getRepository(CustomerCreditApplication).save(application);

  credit.appliedCents -= application.amountCents;
  credit.homeAppliedCents -= application.creditCents;
  await AppDataSource.getRepository(CustomerCredit).save(credit);
  if (invoice) await refreshInvoiceAfterCredit(invoice);
}

// ─────────────────────────────── Void ──────────────────────────────────

export async function voidCreditNote(
  credit: CustomerCredit,
  actorUserId: string | null,
): Promise<CustomerCredit> {
  if (credit.kind !== "credit_memo") {
    // A deposit or overpayment was born from cash; unwinding one must return
    // that cash via a refund, not a void that would credit Bank for nothing.
    throw new Error("Only a credit memo can be voided; refund a deposit or overpayment instead");
  }
  if (credit.status !== "issued") throw new Error("Only an issued credit note can be voided");
  if (credit.appliedCents !== 0 || credit.refundedCents !== 0) {
    throw new Error("Unapply and un-refund this credit before voiding it");
  }
  const date = new Date();
  const closed = await findClosedPeriodCovering(credit.companyId, date);
  if (closed) throw new Error(`The void would post into the closed period "${closed.name}".`);

  const accounts = await requireAccountsByCode(credit.companyId, [RETURNS_CODE, TAX_CODE, creditAccountCode(credit.kind)]);
  const lines: Array<{ accountId: string; debitCents?: number; creditCents?: number; description?: string }> = [
    { accountId: accounts.get(creditAccountCode(credit.kind))!.id, debitCents: credit.homeTotalCents, description: `Void ${credit.number}` },
  ];
  if (credit.homeSubtotalCents > 0) {
    lines.push({ accountId: accounts.get(RETURNS_CODE)!.id, creditCents: credit.homeSubtotalCents, description: `Void ${credit.number}` });
  }
  if (credit.homeTaxCents > 0) {
    lines.push({ accountId: accounts.get(TAX_CODE)!.id, creditCents: credit.homeTaxCents, description: `Void ${credit.number} tax` });
  }
  await postLedgerEntry({
    companyId: credit.companyId,
    date,
    memo: `Void credit note ${credit.number}`,
    source: "credit_note_void",
    sourceRefId: credit.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines,
  });

  credit.status = "void";
  credit.voidedAt = date;
  return AppDataSource.getRepository(CustomerCredit).save(credit);
}

// ───────────────── Deposits + overpayments (Increment 5) ────────────────

type LedgerDraftLine = {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  description?: string;
};

async function resolveBankAccount(
  companyId: string,
  bankAccountId: string | null | undefined,
): Promise<Account> {
  if (bankAccountId) {
    const account = await AppDataSource.getRepository(Account).findOneBy({
      id: bankAccountId,
      companyId,
    });
    if (!account) throw new Error("Bank account not found");
    if (account.type !== "asset") throw new Error("Cash must move through an asset account");
    if (account.archivedAt) throw new Error("That account is archived");
    return account;
  }
  return (await requireAccountsByCode(companyId, [BANK_CODE])).get(BANK_CODE)!;
}

/** An issued, line-less credit (deposit / overpayment): totals are set
 *  directly since recomputeCreditTotals is line-based. */
async function issuedCreditShell(args: {
  companyId: string;
  customerId: string;
  kind: CustomerCreditKind;
  currency: string;
  amountCents: number;
  homeCents: number;
  issueDate: Date;
  notes?: string;
  actorUserId: string | null;
}): Promise<CustomerCredit> {
  const repo = AppDataSource.getRepository(CustomerCredit);
  const customer = await AppDataSource.getRepository(Customer).findOneBy({
    id: args.customerId,
    companyId: args.companyId,
  });
  const seq = await mintNextCreditSeq(args.companyId, args.customerId);
  const number = formatCreditNumber(seq, customer?.slug);
  return repo.save(
    repo.create({
      companyId: args.companyId,
      customerId: args.customerId,
      kind: args.kind,
      status: "issued",
      numberSeq: seq,
      number,
      slug: number.toLowerCase(),
      sourceInvoiceId: null,
      currency: args.currency,
      subtotalCents: args.amountCents,
      taxCents: 0,
      totalCents: args.amountCents,
      homeSubtotalCents: args.homeCents,
      homeTaxCents: 0,
      homeTotalCents: args.homeCents,
      reason: "",
      notes: args.notes ?? "",
      issueDate: args.issueDate,
      createdById: args.actorUserId,
      issuedAt: new Date(),
    }),
  );
}

export async function createDeposit(
  companyId: string,
  input: {
    customerId: string;
    amountCents: number;
    currency: string;
    bankAccountId?: string | null;
    issueDate?: Date;
    notes?: string;
  },
  actorUserId: string | null,
): Promise<CustomerCredit> {
  const amount = Math.trunc(input.amountCents);
  if (amount <= 0) throw new Error("Deposit amount must be positive");
  const issueDate = input.issueDate ?? new Date();
  const closed = await findClosedPeriodCovering(companyId, issueDate);
  if (closed) throw new Error(`That date falls in the closed period "${closed.name}".`);
  const settings = await getFinanceSettings(companyId);
  const homeCents = (
    await convertCents(companyId, amount, input.currency, settings.homeCurrency, issueDate)
  ).converted;
  if (homeCents <= 0) throw new Error("Converted deposit rounds to zero");
  const bank = await resolveBankAccount(companyId, input.bankAccountId);
  const deposits = (await requireAccountsByCode(companyId, ["2500"])).get("2500")!;
  const credit = await issuedCreditShell({
    companyId,
    customerId: input.customerId,
    kind: "deposit",
    currency: input.currency,
    amountCents: amount,
    homeCents,
    issueDate,
    notes: input.notes,
    actorUserId,
  });
  // Cash in, parked as unearned revenue (2500). No tax leg — correct for US
  // sales tax; a VAT tax-point on advances would post output tax here and is
  // out of scope (see ROADMAP M19).
  await postLedgerEntry({
    companyId,
    date: issueDate,
    memo: `Deposit ${credit.number}`,
    source: "credit_note_issue",
    sourceRefId: credit.id,
    createdById: actorUserId,
    lines: [
      { accountId: bank.id, debitCents: homeCents, description: `Deposit ${credit.number}` },
      { accountId: deposits.id, creditCents: homeCents, description: `Deposit ${credit.number}` },
    ],
  });
  return credit;
}

/** Book the excess of a customer overpayment as an on-account credit
 *  (DR Bank / CR 2400). Called by the payment route when allowOverpayment is
 *  set and the payment exceeds the invoice balance. */
export async function createOverpaymentCredit(
  companyId: string,
  args: {
    customerId: string;
    amountCents: number;
    currency: string;
    bankAccountId?: string | null;
    paidAt: Date;
  },
  actorUserId: string | null,
): Promise<CustomerCredit> {
  const amount = Math.trunc(args.amountCents);
  if (amount <= 0) throw new Error("Overpayment must be positive");
  const settings = await getFinanceSettings(companyId);
  const homeCents = (
    await convertCents(companyId, amount, args.currency, settings.homeCurrency, args.paidAt)
  ).converted;
  const bank = await resolveBankAccount(companyId, args.bankAccountId);
  const credits = (await requireAccountsByCode(companyId, ["2400"])).get("2400")!;
  const credit = await issuedCreditShell({
    companyId,
    customerId: args.customerId,
    kind: "overpayment",
    currency: args.currency,
    amountCents: amount,
    homeCents,
    issueDate: args.paidAt,
    actorUserId,
  });
  await postLedgerEntry({
    companyId,
    date: args.paidAt,
    memo: `Overpayment credit ${credit.number}`,
    source: "credit_note_issue",
    sourceRefId: credit.id,
    createdById: actorUserId,
    lines: [
      { accountId: bank.id, debitCents: homeCents, description: `Overpayment ${credit.number}` },
      { accountId: credits.id, creditCents: homeCents, description: `Overpayment ${credit.number}` },
    ],
  });
  return credit;
}

// ─────────────────────────────── Refunds ───────────────────────────────

export async function listCreditRefunds(creditId: string): Promise<CustomerRefund[]> {
  return AppDataSource.getRepository(CustomerRefund).find({
    where: { creditId },
    order: { createdAt: "ASC" },
  });
}

export async function loadRefundById(companyId: string, id: string): Promise<CustomerRefund | null> {
  return AppDataSource.getRepository(CustomerRefund).findOneBy({ id, companyId });
}

export async function refundCustomerCredit(
  credit: CustomerCredit,
  input: {
    amountCents: number;
    refundedAt?: Date;
    method?: string;
    reference?: string;
    notes?: string;
    bankAccountId?: string | null;
  },
  actorUserId: string | null,
): Promise<CustomerRefund> {
  if (credit.status !== "issued") throw new Error("Only an issued credit can be refunded");
  const amount = Math.trunc(input.amountCents);
  const open = creditOpenCents(credit);
  if (amount <= 0) throw new Error("Refund amount must be positive");
  if (amount > open) throw new Error(`Refund ${amount} exceeds the credit's open balance ${open}`);
  const refundedAt = input.refundedAt ?? new Date();
  const closed = await findClosedPeriodCovering(credit.companyId, refundedAt);
  if (closed) throw new Error(`That date falls in the closed period "${closed.name}".`);

  const settings = await getFinanceSettings(credit.companyId);
  const bankCents = (
    await convertCents(credit.companyId, amount, credit.currency, settings.homeCurrency, refundedAt)
  ).converted;
  const isFinalDraw = amount === open;
  const creditCents = isFinalDraw
    ? credit.homeTotalCents - credit.homeAppliedCents - credit.homeRefundedCents
    : roundHalfAway((amount * credit.homeTotalCents) / credit.totalCents);
  const fxCents = creditCents - bankCents;

  const bank = await resolveBankAccount(credit.companyId, input.bankAccountId);
  const accounts = await requireAccountsByCode(credit.companyId, [
    creditAccountCode(credit.kind),
    FX_GAIN_CODE,
    FX_LOSS_CODE,
  ]);
  const lines: LedgerDraftLine[] = [
    { accountId: accounts.get(creditAccountCode(credit.kind))!.id, debitCents: creditCents, description: `Refund ${credit.number}` },
    { accountId: bank.id, creditCents: bankCents, description: `Refund ${credit.number}` },
  ];
  if (fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, creditCents: fxCents, description: "FX on refund" });
  } else if (fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, debitCents: -fxCents, description: "FX on refund" });
  }

  const repo = AppDataSource.getRepository(CustomerRefund);
  const refund = await repo.save(
    repo.create({
      companyId: credit.companyId,
      creditId: credit.id,
      amountCents: amount,
      creditCents,
      bankCents,
      fxCents,
      currency: credit.currency,
      bankAccountId: bank.id,
      refundedAt,
      method: input.method ?? "",
      reference: input.reference ?? "",
      notes: input.notes ?? "",
      createdById: actorUserId,
      reversedAt: null,
      reversedById: null,
    }),
  );
  await postLedgerEntry({
    companyId: credit.companyId,
    date: refundedAt,
    memo: `Refund of ${credit.number}`,
    source: "customer_refund",
    sourceRefId: refund.id,
    createdById: actorUserId,
    lines,
  });

  credit.refundedCents += amount;
  credit.homeRefundedCents += creditCents;
  await AppDataSource.getRepository(CustomerCredit).save(credit);
  return refund;
}

export async function voidCustomerRefund(
  refund: CustomerRefund,
  actorUserId: string | null,
): Promise<CustomerRefund> {
  if (refund.reversedAt) throw new Error("This refund has already been reversed");
  const credit = await AppDataSource.getRepository(CustomerCredit).findOneBy({
    id: refund.creditId,
    companyId: refund.companyId,
  });
  if (!credit) throw new Error("Credit not found");
  const date = new Date();
  const closed = await findClosedPeriodCovering(refund.companyId, date);
  if (closed) throw new Error(`The reversal would post into the closed period "${closed.name}".`);

  const accounts = await requireAccountsByCode(refund.companyId, [
    creditAccountCode(credit.kind),
    FX_GAIN_CODE,
    FX_LOSS_CODE,
  ]);
  const lines: LedgerDraftLine[] = [
    { accountId: refund.bankAccountId, debitCents: refund.bankCents, description: "Refund reversal" },
    { accountId: accounts.get(creditAccountCode(credit.kind))!.id, creditCents: refund.creditCents, description: "Refund reversal" },
  ];
  if (refund.fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, debitCents: refund.fxCents, description: "FX reversal" });
  } else if (refund.fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, creditCents: -refund.fxCents, description: "FX reversal" });
  }
  await postLedgerEntry({
    companyId: refund.companyId,
    date,
    memo: `Reversal of refund ${refund.id.slice(0, 8)}`,
    source: "customer_refund_void",
    sourceRefId: refund.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines,
  });

  refund.reversedAt = date;
  refund.reversedById = actorUserId;
  await AppDataSource.getRepository(CustomerRefund).save(refund);

  credit.refundedCents -= refund.amountCents;
  credit.homeRefundedCents -= refund.creditCents;
  await AppDataSource.getRepository(CustomerCredit).save(credit);
  return refund;
}
