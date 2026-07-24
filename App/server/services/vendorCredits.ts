import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { Vendor } from "../db/entities/Vendor.js";
import { Bill } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { VendorCredit } from "../db/entities/VendorCredit.js";
import { VendorCreditLine } from "../db/entities/VendorCreditLine.js";
import { VendorCreditApplication } from "../db/entities/VendorCreditApplication.js";
import { VendorRefund } from "../db/entities/VendorRefund.js";
import { roundHalfAway } from "../lib/money.js";
import { convertCents, getFinanceSettings } from "./fx.js";
import { findClosedPeriodCovering, postLedgerEntry, requireAccountsByCode } from "./ledger.js";
import { recomputeBillTotals } from "./bills.js";

/**
 * Vendor-credit service — the AP mirror of customerCredits.ts. Phase H of the
 * Finance milestone (M19) — see ROADMAP.md.
 *
 * Issue posts DR 1300 Vendor Credits / CR <each line's expense account> /
 * CR 2100 Tax Payable, reversing a bill's expense + input tax and parking the
 * value as an asset (the supplier owes us). Apply relieves what we still owe
 * (DR 2200 AP / CR 1300); refund brings the supplier's cash in (DR 1100 /
 * CR 1300). Because the parking account is an ASSET, the FX gain/loss sign is
 * the opposite of the AR side — every posting is covered by balanced-entry
 * tests.
 */

const AP_CODE = "2200";
const BANK_CODE = "1100";
const VENDOR_CREDITS_CODE = "1300";
const TAX_CODE = "2100";
const FX_GAIN_CODE = "4910";
const FX_LOSS_CODE = "6900";

type LedgerDraftLine = {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  description?: string;
};

export function vendorCreditOpenCents(c: VendorCredit): number {
  return c.totalCents - c.appliedCents - c.refundedCents;
}

// ─────────────────────────── Numbering + loaders ───────────────────────

async function mintNextSeq(companyId: string, vendorId: string): Promise<number> {
  const last = await AppDataSource.getRepository(VendorCredit).findOne({
    where: { companyId, vendorId },
    order: { numberSeq: "DESC" },
    select: ["numberSeq"],
  });
  return (last?.numberSeq ?? 0) + 1;
}

function formatNumber(seq: number, prefix?: string): string {
  const p = prefix ? `${prefix.toUpperCase()}-` : "";
  return `${p}VCN-${String(seq).padStart(4, "0")}`;
}

async function draftSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(VendorCredit);
  for (let i = 0; i < 16; i += 1) {
    const slug = `vcndraft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `vcndraft-${Date.now().toString(36)}`;
}

export async function loadVendorCreditBySlug(companyId: string, slug: string): Promise<VendorCredit | null> {
  return AppDataSource.getRepository(VendorCredit).findOneBy({ companyId, slug });
}

export async function listVendorCredits(companyId: string): Promise<VendorCredit[]> {
  return AppDataSource.getRepository(VendorCredit).find({
    where: { companyId },
    order: { createdAt: "DESC" },
  });
}

export async function getVendorCreditLines(creditId: string): Promise<VendorCreditLine[]> {
  return AppDataSource.getRepository(VendorCreditLine).find({
    where: { creditId },
    order: { sortOrder: "ASC" },
  });
}

export async function listVendorCreditApplications(creditId: string): Promise<VendorCreditApplication[]> {
  return AppDataSource.getRepository(VendorCreditApplication).find({
    where: { creditId },
    order: { createdAt: "ASC" },
  });
}

export async function listVendorApplicationsForBill(billId: string): Promise<VendorCreditApplication[]> {
  return AppDataSource.getRepository(VendorCreditApplication).find({
    where: { billId },
    order: { createdAt: "ASC" },
  });
}

export async function listVendorCreditRefunds(creditId: string): Promise<VendorRefund[]> {
  return AppDataSource.getRepository(VendorRefund).find({
    where: { creditId },
    order: { createdAt: "ASC" },
  });
}

export async function loadVendorRefundById(companyId: string, id: string): Promise<VendorRefund | null> {
  return AppDataSource.getRepository(VendorRefund).findOneBy({ id, companyId });
}

async function refreshBillAfterCredit(bill: Bill): Promise<Bill> {
  const apps = await AppDataSource.getRepository(VendorCreditApplication).find({
    where: { billId: bill.id, reversedAt: IsNull() },
    select: ["amountCents"],
  });
  bill.creditedCents = apps.reduce((s, a) => s + a.amountCents, 0);
  return recomputeBillTotals(bill);
}

// ─────────────────────────────── Create + issue ────────────────────────

export async function createVendorCreditFromBill(
  bill: Bill,
  opts: { mode: "full" | "amount"; amountCents?: number; reason?: string; notes?: string },
  actorUserId: string | null,
): Promise<VendorCredit> {
  const repo = AppDataSource.getRepository(VendorCredit);
  const credit = await repo.save(
    repo.create({
      companyId: bill.companyId,
      vendorId: bill.vendorId,
      status: "draft",
      numberSeq: 0,
      number: "",
      slug: await draftSlug(bill.companyId),
      sourceBillId: bill.id,
      currency: bill.currency,
      reason: opts.reason ?? "",
      notes: opts.notes ?? "",
      issueDate: new Date(),
      createdById: actorUserId,
    }),
  );
  const lineRepo = AppDataSource.getRepository(VendorCreditLine);
  const billLines = await AppDataSource.getRepository(BillLineItem).find({
    where: { billId: bill.id },
    order: { sortOrder: "ASC" },
  });
  if (opts.mode === "full") {
    await lineRepo.save(
      billLines.map((l) =>
        lineRepo.create({
          creditId: credit.id,
          expenseAccountId: l.expenseAccountId,
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
    const expenseAccountId = billLines.find((l) => l.expenseAccountId)?.expenseAccountId ?? null;
    if (!expenseAccountId) throw new Error("The bill has no expense line to credit against");
    await lineRepo.save(
      lineRepo.create({
        creditId: credit.id,
        expenseAccountId,
        description: `Credit against ${bill.number || bill.slug}`,
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
  return recomputeTotals(credit);
}

async function recomputeTotals(credit: VendorCredit): Promise<VendorCredit> {
  const lines = await getVendorCreditLines(credit.id);
  credit.subtotalCents = lines.reduce((s, l) => s + l.lineSubtotalCents, 0);
  credit.taxCents = lines.reduce((s, l) => s + l.lineTaxCents, 0);
  credit.totalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  return AppDataSource.getRepository(VendorCredit).save(credit);
}

export async function issueVendorCredit(
  credit: VendorCredit,
  actorUserId: string | null,
): Promise<VendorCredit> {
  if (credit.status !== "draft") throw new Error("Only a draft vendor credit can be issued");
  if (credit.totalCents <= 0) throw new Error("A vendor credit must have a positive total");

  // Cumulative cap against the source bill (subtotal, tax, total).
  if (credit.sourceBillId) {
    const bill = await AppDataSource.getRepository(Bill).findOneBy({
      id: credit.sourceBillId,
      companyId: credit.companyId,
    });
    if (!bill) throw new Error("Source bill no longer exists");
    if (bill.currency !== credit.currency) {
      throw new Error("Vendor credit currency must match the source bill");
    }
    const prior = await AppDataSource.getRepository(VendorCredit).find({
      where: {
        companyId: credit.companyId,
        sourceBillId: bill.id,
        status: "issued",
      },
      select: ["subtotalCents", "taxCents", "totalCents"],
    });
    if (prior.reduce((s, m) => s + m.subtotalCents, 0) + credit.subtotalCents > bill.subtotalCents) {
      throw new Error("Vendor credits would exceed the bill's net (pre-tax) amount");
    }
    if (prior.reduce((s, m) => s + m.taxCents, 0) + credit.taxCents > bill.taxCents) {
      throw new Error("Vendor credits would exceed the bill's tax");
    }
    if (prior.reduce((s, m) => s + m.totalCents, 0) + credit.totalCents > bill.totalCents) {
      throw new Error("Vendor credits would exceed the bill total");
    }
  }

  const settings = await getFinanceSettings(credit.companyId);
  const home = settings.homeCurrency;
  const rateDate = await creditRateDate(credit);
  const accounts = await requireAccountsByCode(credit.companyId, [VENDOR_CREDITS_CODE, TAX_CODE]);

  // Convert each line's subtotal to home and credit its expense account; DR
  // 1300 by the exact sum of all credit legs, so the entry balances to the cent.
  const lines = await getVendorCreditLines(credit.id);
  const lineRepo = AppDataSource.getRepository(VendorCreditLine);
  const creditLines: LedgerDraftLine[] = [];
  let homeSubtotal = 0;
  for (const l of lines) {
    if (!l.expenseAccountId || l.lineSubtotalCents === 0) {
      l.homeSubtotalCents = 0;
      await lineRepo.save(l);
      continue;
    }
    const homeSub = (await convertCents(credit.companyId, l.lineSubtotalCents, credit.currency, home, rateDate)).converted;
    l.homeSubtotalCents = homeSub;
    await lineRepo.save(l);
    homeSubtotal += homeSub;
    creditLines.push({ accountId: l.expenseAccountId, creditCents: homeSub, description: `Vendor credit ${l.description}` });
  }
  const homeTax = credit.taxCents > 0
    ? (await convertCents(credit.companyId, credit.taxCents, credit.currency, home, rateDate)).converted
    : 0;
  if (homeTax > 0) {
    creditLines.push({ accountId: accounts.get(TAX_CODE)!.id, creditCents: homeTax, description: "Vendor credit tax" });
  }
  const homeTotal = homeSubtotal + homeTax;
  if (homeTotal <= 0) throw new Error("Converted vendor credit rounds to zero");

  const vendor = await AppDataSource.getRepository(Vendor).findOneBy({ id: credit.vendorId, companyId: credit.companyId });
  const seq = await mintNextSeq(credit.companyId, credit.vendorId);
  credit.numberSeq = seq;
  credit.number = formatNumber(seq, vendor?.slug);
  credit.slug = credit.number.toLowerCase();
  credit.status = "issued";
  credit.issuedAt = new Date();
  credit.homeSubtotalCents = homeSubtotal;
  credit.homeTaxCents = homeTax;
  credit.homeTotalCents = homeTotal;
  await AppDataSource.getRepository(VendorCredit).save(credit);

  await postLedgerEntry({
    companyId: credit.companyId,
    date: credit.issueDate,
    memo: `Vendor credit ${credit.number}`,
    source: "vendor_credit_issue",
    sourceRefId: credit.id,
    createdById: actorUserId,
    lines: [
      { accountId: accounts.get(VENDOR_CREDITS_CODE)!.id, debitCents: homeTotal, description: `Vendor credit ${credit.number}` },
      ...creditLines,
    ],
  });
  return credit;
}

async function creditRateDate(credit: VendorCredit): Promise<Date> {
  if (credit.sourceBillId) {
    const bill = await AppDataSource.getRepository(Bill).findOneBy({
      id: credit.sourceBillId,
      companyId: credit.companyId,
    });
    if (bill) return bill.issueDate;
  }
  return credit.issueDate;
}

// ─────────────────────────────── Apply ─────────────────────────────────

export async function applyVendorCredit(
  credit: VendorCredit,
  bill: Bill,
  amountCents: number,
  actorUserId: string | null,
): Promise<VendorCreditApplication> {
  if (credit.status !== "issued") throw new Error("Only an issued vendor credit can be applied");
  if (bill.status !== "sent" && bill.status !== "paid") {
    throw new Error("A vendor credit can only be applied to an issued bill");
  }
  if (bill.vendorId !== credit.vendorId) throw new Error("Credit and bill belong to different vendors");
  if (bill.currency !== credit.currency) throw new Error("Credit and bill must be in the same currency");
  const amount = Math.trunc(amountCents);
  const cap = Math.min(vendorCreditOpenCents(credit), bill.balanceCents);
  if (amount <= 0) throw new Error("Application amount must be positive");
  if (amount > cap) {
    throw new Error(
      `Application ${amount} exceeds the room available (credit open ${vendorCreditOpenCents(credit)}, bill balance ${bill.balanceCents})`,
    );
  }
  const appliedAt = new Date();
  const closed = await findClosedPeriodCovering(credit.companyId, appliedAt);
  if (closed) throw new Error(`That date falls in the closed period "${closed.name}".`);

  const settings = await getFinanceSettings(credit.companyId);
  const apCents = (await convertCents(credit.companyId, amount, bill.currency, settings.homeCurrency, bill.issueDate)).converted;
  const isFinalDraw = amount === vendorCreditOpenCents(credit);
  const creditCents = isFinalDraw
    ? credit.homeTotalCents - credit.homeAppliedCents - credit.homeRefundedCents
    : roundHalfAway((amount * credit.homeTotalCents) / credit.totalCents);
  const fxCents = creditCents - apCents;

  const accounts = await requireAccountsByCode(credit.companyId, [AP_CODE, VENDOR_CREDITS_CODE, FX_GAIN_CODE, FX_LOSS_CODE]);
  const lines: LedgerDraftLine[] = [
    { accountId: accounts.get(AP_CODE)!.id, debitCents: apCents, description: `Apply ${credit.number} to ${bill.number}` },
    { accountId: accounts.get(VENDOR_CREDITS_CODE)!.id, creditCents: creditCents, description: `Apply ${credit.number}` },
  ];
  // Parking account is an asset, so the sign is opposite the AR side: consuming
  // more asset than AP relieved is a loss.
  if (fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, debitCents: fxCents, description: "FX on vendor credit application" });
  } else if (fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, creditCents: -fxCents, description: "FX on vendor credit application" });
  }

  const appRepo = AppDataSource.getRepository(VendorCreditApplication);
  const application = await appRepo.save(
    appRepo.create({
      companyId: credit.companyId,
      creditId: credit.id,
      billId: bill.id,
      amountCents: amount,
      apCents,
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
    memo: `Vendor credit ${credit.number} applied to ${bill.number}`,
    source: "vendor_credit_apply",
    sourceRefId: application.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines,
  });

  credit.appliedCents += amount;
  credit.homeAppliedCents += creditCents;
  await AppDataSource.getRepository(VendorCredit).save(credit);
  await refreshBillAfterCredit(bill);
  return application;
}

export async function unapplyVendorCredit(
  application: VendorCreditApplication,
  actorUserId: string | null,
): Promise<void> {
  if (application.reversedAt) throw new Error("This application has already been reversed");
  const credit = await AppDataSource.getRepository(VendorCredit).findOneBy({ id: application.creditId, companyId: application.companyId });
  if (!credit) throw new Error("Credit not found");
  const bill = await AppDataSource.getRepository(Bill).findOneBy({ id: application.billId, companyId: application.companyId });
  const date = new Date();
  const closed = await findClosedPeriodCovering(application.companyId, date);
  if (closed) throw new Error(`The reversal would post into the closed period "${closed.name}".`);

  const accounts = await requireAccountsByCode(application.companyId, [AP_CODE, VENDOR_CREDITS_CODE, FX_GAIN_CODE, FX_LOSS_CODE]);
  const lines: LedgerDraftLine[] = [
    { accountId: accounts.get(AP_CODE)!.id, creditCents: application.apCents, description: "Unapply vendor credit" },
    { accountId: accounts.get(VENDOR_CREDITS_CODE)!.id, debitCents: application.creditCents, description: "Unapply vendor credit" },
  ];
  if (application.fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, creditCents: application.fxCents, description: "FX reversal" });
  } else if (application.fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, debitCents: -application.fxCents, description: "FX reversal" });
  }
  await postLedgerEntry({
    companyId: application.companyId,
    date,
    memo: `Unapply vendor credit ${credit.number}`,
    source: "vendor_credit_unapply",
    sourceRefId: application.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines,
  });

  application.reversedAt = date;
  application.reversedById = actorUserId;
  await AppDataSource.getRepository(VendorCreditApplication).save(application);
  credit.appliedCents -= application.amountCents;
  credit.homeAppliedCents -= application.creditCents;
  await AppDataSource.getRepository(VendorCredit).save(credit);
  if (bill) await refreshBillAfterCredit(bill);
}

export async function voidVendorCredit(
  credit: VendorCredit,
  actorUserId: string | null,
): Promise<VendorCredit> {
  if (credit.status !== "issued") throw new Error("Only an issued vendor credit can be voided");
  if (credit.appliedCents !== 0 || credit.refundedCents !== 0) {
    throw new Error("Unapply and un-refund this credit before voiding it");
  }
  const date = new Date();
  const closed = await findClosedPeriodCovering(credit.companyId, date);
  if (closed) throw new Error(`The void would post into the closed period "${closed.name}".`);

  const accounts = await requireAccountsByCode(credit.companyId, [VENDOR_CREDITS_CODE, TAX_CODE]);
  const lines = await getVendorCreditLines(credit.id);
  // Mirror of issue: DR each expense (its stored home subtotal) + DR 2100 tax
  // / CR 1300 total.
  const draft: LedgerDraftLine[] = [];
  for (const l of lines) {
    if (l.expenseAccountId && l.homeSubtotalCents > 0) {
      draft.push({ accountId: l.expenseAccountId, debitCents: l.homeSubtotalCents, description: `Void ${credit.number}` });
    }
  }
  if (credit.homeTaxCents > 0) {
    draft.push({ accountId: accounts.get(TAX_CODE)!.id, debitCents: credit.homeTaxCents, description: `Void ${credit.number} tax` });
  }
  draft.push({ accountId: accounts.get(VENDOR_CREDITS_CODE)!.id, creditCents: credit.homeTotalCents, description: `Void ${credit.number}` });
  await postLedgerEntry({
    companyId: credit.companyId,
    date,
    memo: `Void vendor credit ${credit.number}`,
    source: "vendor_credit_void",
    sourceRefId: credit.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines: draft,
  });

  credit.status = "void";
  credit.voidedAt = date;
  return AppDataSource.getRepository(VendorCredit).save(credit);
}

// ─────────────────────────────── Refund ────────────────────────────────

async function resolveBankAccount(companyId: string, bankAccountId: string | null | undefined): Promise<Account> {
  if (bankAccountId) {
    const account = await AppDataSource.getRepository(Account).findOneBy({ id: bankAccountId, companyId });
    if (!account) throw new Error("Bank account not found");
    if (account.type !== "asset") throw new Error("Cash must move through an asset account");
    if (account.archivedAt) throw new Error("That account is archived");
    return account;
  }
  return (await requireAccountsByCode(companyId, [BANK_CODE])).get(BANK_CODE)!;
}

export async function refundVendorCredit(
  credit: VendorCredit,
  input: { amountCents: number; refundedAt?: Date; method?: string; reference?: string; notes?: string; bankAccountId?: string | null },
  actorUserId: string | null,
): Promise<VendorRefund> {
  if (credit.status !== "issued") throw new Error("Only an issued vendor credit can be refunded");
  const amount = Math.trunc(input.amountCents);
  const open = vendorCreditOpenCents(credit);
  if (amount <= 0) throw new Error("Refund amount must be positive");
  if (amount > open) throw new Error(`Refund ${amount} exceeds the credit's open balance ${open}`);
  const refundedAt = input.refundedAt ?? new Date();
  const closed = await findClosedPeriodCovering(credit.companyId, refundedAt);
  if (closed) throw new Error(`That date falls in the closed period "${closed.name}".`);

  const settings = await getFinanceSettings(credit.companyId);
  const bankCents = (await convertCents(credit.companyId, amount, credit.currency, settings.homeCurrency, refundedAt)).converted;
  const isFinalDraw = amount === open;
  const creditCents = isFinalDraw
    ? credit.homeTotalCents - credit.homeAppliedCents - credit.homeRefundedCents
    : roundHalfAway((amount * credit.homeTotalCents) / credit.totalCents);
  const fxCents = creditCents - bankCents;

  const bank = await resolveBankAccount(credit.companyId, input.bankAccountId);
  const accounts = await requireAccountsByCode(credit.companyId, [VENDOR_CREDITS_CODE, FX_GAIN_CODE, FX_LOSS_CODE]);
  // Cash in from the supplier: DR Bank / CR 1300.
  const lines: LedgerDraftLine[] = [
    { accountId: bank.id, debitCents: bankCents, description: `Vendor refund ${credit.number}` },
    { accountId: accounts.get(VENDOR_CREDITS_CODE)!.id, creditCents: creditCents, description: `Vendor refund ${credit.number}` },
  ];
  if (fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, debitCents: fxCents, description: "FX on vendor refund" });
  } else if (fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, creditCents: -fxCents, description: "FX on vendor refund" });
  }

  const repo = AppDataSource.getRepository(VendorRefund);
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
    memo: `Vendor refund of ${credit.number}`,
    source: "vendor_refund",
    sourceRefId: refund.id,
    createdById: actorUserId,
    lines,
  });
  credit.refundedCents += amount;
  credit.homeRefundedCents += creditCents;
  await AppDataSource.getRepository(VendorCredit).save(credit);
  return refund;
}

export async function voidVendorRefund(
  refund: VendorRefund,
  actorUserId: string | null,
): Promise<VendorRefund> {
  if (refund.reversedAt) throw new Error("This refund has already been reversed");
  const credit = await AppDataSource.getRepository(VendorCredit).findOneBy({ id: refund.creditId, companyId: refund.companyId });
  if (!credit) throw new Error("Credit not found");
  const date = new Date();
  const closed = await findClosedPeriodCovering(refund.companyId, date);
  if (closed) throw new Error(`The reversal would post into the closed period "${closed.name}".`);

  const accounts = await requireAccountsByCode(refund.companyId, [VENDOR_CREDITS_CODE, FX_GAIN_CODE, FX_LOSS_CODE]);
  const lines: LedgerDraftLine[] = [
    { accountId: refund.bankAccountId, creditCents: refund.bankCents, description: "Vendor refund reversal" },
    { accountId: accounts.get(VENDOR_CREDITS_CODE)!.id, debitCents: refund.creditCents, description: "Vendor refund reversal" },
  ];
  if (refund.fxCents > 0) {
    lines.push({ accountId: accounts.get(FX_LOSS_CODE)!.id, creditCents: refund.fxCents, description: "FX reversal" });
  } else if (refund.fxCents < 0) {
    lines.push({ accountId: accounts.get(FX_GAIN_CODE)!.id, debitCents: -refund.fxCents, description: "FX reversal" });
  }
  await postLedgerEntry({
    companyId: refund.companyId,
    date,
    memo: `Reversal of vendor refund ${refund.id.slice(0, 8)}`,
    source: "vendor_refund_void",
    sourceRefId: refund.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines,
  });
  refund.reversedAt = date;
  refund.reversedById = actorUserId;
  await AppDataSource.getRepository(VendorRefund).save(refund);
  credit.refundedCents -= refund.amountCents;
  credit.homeRefundedCents -= refund.creditCents;
  await AppDataSource.getRepository(VendorCredit).save(credit);
  return refund;
}
