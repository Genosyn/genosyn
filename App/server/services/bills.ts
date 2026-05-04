import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Bill, BillStatus } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { BillPayment } from "../db/entities/BillPayment.js";
import { Vendor } from "../db/entities/Vendor.js";
import { TaxRate } from "../db/entities/TaxRate.js";
import { computeLineTotals } from "../lib/money.js";
import { convertCents, getFinanceSettings } from "./fx.js";
import {
  hasEntryFor,
  postLedgerEntry,
  requireAccountsByCode,
  reverseLedgerEntriesForSources,
} from "./ledger.js";

/**
 * Bills service. Phase G of the Finance milestone (M19) — see
 * ROADMAP.md.
 *
 * Mirrors the invoice service: lifecycle (draft → sent → paid → void),
 * gapless per-company numbering with `BIL-NNNN` display, snapshot-on-
 * line tax math, and auto-post hooks into the general ledger:
 *
 *   - Issue: DR Expense (per line) / CR 2200 Accounts Payable
 *   - Pay:   DR Accounts Payable / CR Bank, with FX gain/loss for
 *            foreign-currency bills (mirrors the invoice payment side)
 *   - Void:  reverses every entry tied to the bill
 */

export async function loadBillBySlug(
  companyId: string,
  slug: string,
): Promise<Bill | null> {
  return AppDataSource.getRepository(Bill).findOneBy({ companyId, slug });
}

export async function loadVendorBySlug(
  companyId: string,
  slug: string,
): Promise<Vendor | null> {
  return AppDataSource.getRepository(Vendor).findOneBy({ companyId, slug });
}

// ─────────────────────────── Numbering ─────────────────────────────────

export async function mintNextBillSeq(companyId: string): Promise<number> {
  const last = await AppDataSource.getRepository(Bill).findOne({
    where: { companyId },
    order: { numberSeq: "DESC" },
    select: ["numberSeq"],
  });
  return (last?.numberSeq ?? 0) + 1;
}

function formatBillNumber(seq: number): string {
  return `BIL-${String(seq).padStart(4, "0")}`;
}

// ─────────────────────────── Line replace ─────────────────────────────

export type BillLineDraft = {
  expenseAccountId?: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId?: string | null;
  sortOrder?: number;
};

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

export async function replaceBillLines(
  bill: Bill,
  drafts: BillLineDraft[],
): Promise<BillLineItem[]> {
  const repo = AppDataSource.getRepository(BillLineItem);
  await repo.delete({ billId: bill.id });
  if (drafts.length === 0) return [];
  const built: BillLineItem[] = [];
  for (let i = 0; i < drafts.length; i += 1) {
    const d = drafts[i];
    const tax = await snapshotTax(bill.companyId, d.taxRateId);
    const totals = computeLineTotals({
      quantity: d.quantity,
      unitPriceCents: d.unitPriceCents,
      taxPercent: tax.taxPercent,
      taxInclusive: tax.taxInclusive,
    });
    built.push(
      repo.create({
        billId: bill.id,
        expenseAccountId: d.expenseAccountId ?? null,
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
  return repo.save(built);
}

// ────────────────────────── Recompute ─────────────────────────────────

export async function recomputeBillTotals(bill: Bill): Promise<Bill> {
  const [lines, payments] = await Promise.all([
    AppDataSource.getRepository(BillLineItem).find({ where: { billId: bill.id } }),
    AppDataSource.getRepository(BillPayment).find({ where: { billId: bill.id } }),
  ]);
  const subtotal = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  const tax = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  const total = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const paid = payments.reduce((s, p) => s + p.amountCents, 0);
  bill.subtotalCents = subtotal;
  bill.taxCents = tax;
  bill.totalCents = total;
  bill.paidCents = paid;
  bill.balanceCents = total - paid;
  if (bill.status !== "draft" && bill.status !== "void") {
    if (paid >= total && total > 0) {
      if (bill.status !== "paid") bill.paidAt = new Date();
      bill.status = "paid";
    } else {
      bill.status = "sent";
      bill.paidAt = null;
    }
  }
  return AppDataSource.getRepository(Bill).save(bill);
}

// ────────────────────────── Issue ─────────────────────────────────────

export async function issueBill(
  bill: Bill,
  actorUserId: string | null = null,
): Promise<Bill> {
  if (bill.status !== "draft") throw new Error("Only drafts can be issued");
  // Each line must have an expense account picked before issue.
  const lines = await AppDataSource.getRepository(BillLineItem).find({
    where: { billId: bill.id },
  });
  if (lines.length === 0) throw new Error("Add at least one line before issuing");
  for (const l of lines) {
    if (!l.expenseAccountId) {
      throw new Error("Pick an expense account on every line before issuing");
    }
  }
  const seq = await mintNextBillSeq(bill.companyId);
  bill.numberSeq = seq;
  bill.number = formatBillNumber(seq);
  bill.slug = bill.number.toLowerCase();
  bill.status = "sent";
  bill.receivedAt = new Date();
  await AppDataSource.getRepository(Bill).save(bill);
  const recomputed = await recomputeBillTotals(bill);
  await postBillIssue(recomputed, lines, actorUserId);
  return recomputed;
}

async function postBillIssue(
  bill: Bill,
  lines: BillLineItem[],
  actorUserId: string | null,
): Promise<void> {
  if (bill.totalCents <= 0) return;
  if (await hasEntryFor(bill.companyId, "manual", `bill_issue:${bill.id}`)) return;
  const accounts = await requireAccountsByCode(bill.companyId, ["2100", "2200"]);
  const ap = accounts.get("2200")!;
  const tax = accounts.get("2100")!;

  const settings = await getFinanceSettings(bill.companyId);
  const home = settings.homeCurrency;

  // Build per-line debits to each line's expense account.
  type Entry = {
    accountId: string;
    debitCents?: number;
    creditCents?: number;
    description?: string;
    origCurrency?: string;
    origAmountCents?: number;
    rate?: number;
  };
  const entryLines: Entry[] = [];
  for (const l of lines) {
    if (!l.expenseAccountId) continue;
    const conv = await convertCents(
      bill.companyId,
      l.lineSubtotalCents,
      bill.currency,
      home,
      bill.issueDate,
    );
    entryLines.push({
      accountId: l.expenseAccountId,
      debitCents: conv.converted,
      description: `${bill.number} — ${l.description}`,
      origCurrency: bill.currency,
      origAmountCents: l.lineSubtotalCents,
      rate: conv.rate,
    });
  }
  if (bill.taxCents > 0) {
    // Tax on a bill is reclaimable / due to authority depending on
    // jurisdiction; for Phase G it lands in the same Tax Payable
    // account as invoice tax (negative on the credit side reflects
    // tax we've paid that offsets what we owe). A jurisdiction-aware
    // split lands with the composable tax engine.
    const conv = await convertCents(
      bill.companyId,
      bill.taxCents,
      bill.currency,
      home,
      bill.issueDate,
    );
    entryLines.push({
      accountId: tax.id,
      debitCents: conv.converted,
      description: `${bill.number} — tax`,
      origCurrency: bill.currency,
      origAmountCents: bill.taxCents,
      rate: conv.rate,
    });
  }
  // AP credit balances the entry.
  const totalConv = await convertCents(
    bill.companyId,
    bill.totalCents,
    bill.currency,
    home,
    bill.issueDate,
  );
  entryLines.push({
    accountId: ap.id,
    creditCents: totalConv.converted,
    description: `${bill.number} — payable`,
    origCurrency: bill.currency,
    origAmountCents: bill.totalCents,
    rate: totalConv.rate,
  });

  await postLedgerEntry({
    companyId: bill.companyId,
    date: bill.issueDate,
    memo: `Bill ${bill.number} received`,
    // We use `manual` source because LedgerEntrySource doesn't enumerate
    // bill_* yet — adding them would mean a follow-up migration to
    // widen the column. The sourceRefId carries our own discriminator
    // so `hasEntryFor` and the void-reversal path stay precise.
    source: "manual",
    sourceRefId: `bill_issue:${bill.id}`,
    createdById: actorUserId,
    lines: entryLines,
  });
}

// ────────────────────────── Payments ──────────────────────────────────

export async function postBillPayment(
  bill: Bill,
  payment: BillPayment,
  actorUserId: string | null,
): Promise<void> {
  if (payment.amountCents <= 0) return;
  if (await hasEntryFor(bill.companyId, "manual", `bill_payment:${payment.id}`))
    return;
  const settings = await getFinanceSettings(bill.companyId);
  const home = settings.homeCurrency;
  const accounts = await requireAccountsByCode(bill.companyId, [
    "1100",
    "2200",
    "4910",
    "6900",
  ]);
  const bank = accounts.get("1100")!;
  const ap = accounts.get("2200")!;
  const fxGain = accounts.get("4910")!;
  const fxLoss = accounts.get("6900")!;

  const atPayment = await convertCents(
    bill.companyId,
    payment.amountCents,
    bill.currency,
    home,
    payment.paidAt,
  );
  const atIssue = await convertCents(
    bill.companyId,
    payment.amountCents,
    bill.currency,
    home,
    bill.issueDate,
  );
  // We owed `atIssue` home dollars per unit of foreign currency on the
  // bill; we're now paying `atPayment` home dollars. If the home
  // currency strengthened, we paid less than we owed = FX gain.
  const fxDelta = atIssue.converted - atPayment.converted;

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
      accountId: ap.id,
      debitCents: atIssue.converted,
      description: bill.number,
      origCurrency: bill.currency,
      origAmountCents: payment.amountCents,
      rate: atIssue.rate,
    },
    {
      accountId: bank.id,
      creditCents: atPayment.converted,
      description: payment.reference || bill.number,
      origCurrency: bill.currency,
      origAmountCents: payment.amountCents,
      rate: atPayment.rate,
    },
  ];
  if (fxDelta > 0) {
    lines.push({
      accountId: fxGain.id,
      creditCents: fxDelta,
      description: `FX gain on ${bill.number}`,
    });
  } else if (fxDelta < 0) {
    lines.push({
      accountId: fxLoss.id,
      debitCents: -fxDelta,
      description: `FX loss on ${bill.number}`,
    });
  }
  await postLedgerEntry({
    companyId: bill.companyId,
    date: payment.paidAt,
    memo: `Payment for ${bill.number} (${payment.method})`,
    source: "manual",
    sourceRefId: `bill_payment:${payment.id}`,
    createdById: actorUserId,
    lines,
  });
}

export async function reverseBillPayment(
  bill: Bill,
  payment: BillPayment,
  actorUserId: string | null,
): Promise<void> {
  await reverseLedgerEntriesForSources({
    companyId: bill.companyId,
    sources: ["manual"],
    sourceRefIds: [`bill_payment:${payment.id}`],
    reverseAs: "manual",
    reverseRefId: `bill_payment_reversal:${payment.id}`,
    date: new Date(),
    memo: `Payment deletion for ${bill.number}`,
    createdById: actorUserId,
  });
}

// ────────────────────────── Void ──────────────────────────────────────

export async function voidBill(
  bill: Bill,
  actorUserId: string | null = null,
): Promise<Bill> {
  if (bill.status === "void") return bill;
  if (bill.status === "draft") {
    throw new Error("Drafts cannot be voided — delete them instead");
  }
  bill.status = "void";
  bill.voidedAt = new Date();
  await AppDataSource.getRepository(Bill).save(bill);
  const payments = await AppDataSource.getRepository(BillPayment).find({
    where: { billId: bill.id },
    select: ["id"],
  });
  await reverseLedgerEntriesForSources({
    companyId: bill.companyId,
    sources: ["manual"],
    sourceRefIds: [
      `bill_issue:${bill.id}`,
      ...payments.map((p) => `bill_payment:${p.id}`),
    ],
    reverseAs: "manual",
    reverseRefId: `bill_void:${bill.id}`,
    date: new Date(),
    memo: `Void of bill ${bill.number}`,
    createdById: actorUserId,
  });
  return bill;
}

// ────────────────────────── Hydration ─────────────────────────────────

export type VendorStub = { id: string; name: string; slug: string };

export type HydratedBill = Bill & {
  vendor: VendorStub | null;
  lines: BillLineItem[];
  payments: BillPayment[];
};

export async function hydrateBills(
  companyId: string,
  bills: Bill[],
): Promise<HydratedBill[]> {
  if (bills.length === 0) return [];
  const ids = bills.map((b) => b.id);
  const vendorIds = [...new Set(bills.map((b) => b.vendorId))];
  const [vendors, lines, payments] = await Promise.all([
    AppDataSource.getRepository(Vendor).find({
      where: { id: In(vendorIds), companyId },
      select: ["id", "name", "slug"],
    }),
    AppDataSource.getRepository(BillLineItem).find({
      where: { billId: In(ids) },
      order: { sortOrder: "ASC" },
    }),
    AppDataSource.getRepository(BillPayment).find({
      where: { billId: In(ids) },
      order: { paidAt: "ASC" },
    }),
  ]);
  const vById = new Map(vendors.map((v) => [v.id, v]));
  const linesByBill = new Map<string, BillLineItem[]>();
  for (const l of lines) {
    const arr = linesByBill.get(l.billId) ?? [];
    arr.push(l);
    linesByBill.set(l.billId, arr);
  }
  const paysByBill = new Map<string, BillPayment[]>();
  for (const p of payments) {
    const arr = paysByBill.get(p.billId) ?? [];
    arr.push(p);
    paysByBill.set(p.billId, arr);
  }
  return bills.map((b) => ({
    ...b,
    vendor: vById.get(b.vendorId) ?? null,
    lines: linesByBill.get(b.id) ?? [],
    payments: paysByBill.get(b.id) ?? [],
  }));
}

export type BillDisplayStatus = BillStatus | "overdue";

export function billDisplayStatus(
  bill: Bill,
  now: Date = new Date(),
): BillDisplayStatus {
  if (bill.status === "sent" && bill.dueDate.getTime() < now.getTime()) {
    return "overdue";
  }
  return bill.status;
}
