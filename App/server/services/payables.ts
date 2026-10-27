import { AppDataSource } from "../db/datasource.js";
import { Bill } from "../db/entities/Bill.js";
import { BillLineItem } from "../db/entities/BillLineItem.js";
import { BillPayment, type BillPaymentMethod } from "../db/entities/BillPayment.js";
import { Vendor } from "../db/entities/Vendor.js";
import { formatMoney } from "../lib/money.js";
import { toSlug } from "../lib/slug.js";
import {
  type BillLineDraft,
  postBillPayment,
  recomputeBillTotals,
  replaceBillLines,
  reverseBillPayment,
} from "./bills.js";

/**
 * Accounts payable writes — vendors, bill drafts, and bill payments — shared
 * by Finance → Bills and an AI Employee's payables tools, so both keep one set
 * of rules: lines and header fields change only on a draft, only drafts are
 * deleted, a draft or voided bill takes no payment, a payment never exceeds
 * the balance due, and a payment the ledger refuses (a closed period) leaves
 * nothing behind. Issuing and voiding stay in `bills.ts`.
 */

/** A refused payables write; `status` is the HTTP answer. */
export class PayablesError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PayablesError";
  }
}

export type VendorFields = {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  taxNumber?: string;
  currency?: string;
  notes?: string;
};

async function uniqueVendorSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Vendor);
  let slug = base || "vendor";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

export async function createVendor(
  companyId: string,
  fields: VendorFields & { name: string },
  actorUserId: string | null,
): Promise<Vendor> {
  const repo = AppDataSource.getRepository(Vendor);
  return repo.save(
    repo.create({
      companyId,
      name: fields.name,
      slug: await uniqueVendorSlug(companyId, toSlug(fields.name)),
      email: fields.email ?? "",
      phone: fields.phone ?? "",
      address: fields.address ?? "",
      taxNumber: fields.taxNumber ?? "",
      currency: fields.currency ?? "USD",
      notes: fields.notes ?? "",
      createdById: actorUserId,
    }),
  );
}

export async function updateVendor(
  vendor: Vendor,
  fields: VendorFields & { archived?: boolean },
): Promise<Vendor> {
  if (fields.name !== undefined) vendor.name = fields.name;
  if (fields.email !== undefined) vendor.email = fields.email;
  if (fields.phone !== undefined) vendor.phone = fields.phone;
  if (fields.address !== undefined) vendor.address = fields.address;
  if (fields.taxNumber !== undefined) vendor.taxNumber = fields.taxNumber;
  if (fields.currency !== undefined) vendor.currency = fields.currency;
  if (fields.notes !== undefined) vendor.notes = fields.notes;
  if (fields.archived !== undefined) vendor.archivedAt = fields.archived ? new Date() : null;
  return AppDataSource.getRepository(Vendor).save(vendor);
}

/** A vendor with bills stays: archive it instead, or delete the bills first. */
export async function deleteVendor(vendor: Vendor): Promise<void> {
  const bills = await AppDataSource.getRepository(Bill).count({
    where: { companyId: vendor.companyId, vendorId: vendor.id },
  });
  if (bills > 0) {
    throw new PayablesError("Vendor has bills. Archive instead or delete the bills first.", 409);
  }
  await AppDataSource.getRepository(Vendor).delete({ id: vendor.id });
}

export type BillFields = {
  vendorId?: string;
  vendorRef?: string;
  issueDate?: Date;
  dueDate?: Date;
  currency?: string;
  notes?: string;
  lines?: BillLineDraft[];
};

async function draftBillSlug(companyId: string): Promise<string> {
  const repo = AppDataSource.getRepository(Bill);
  for (let i = 0; i < 16; i += 1) {
    const slug = `bdraft-${Math.random().toString(36).slice(2, 8)}`;
    if (!(await repo.findOneBy({ companyId, slug }))) return slug;
  }
  return `bdraft-${Date.now().toString(36)}`;
}

async function companyVendor(companyId: string, vendorId: string): Promise<Vendor> {
  const vendor = await AppDataSource.getRepository(Vendor).findOneBy({
    id: vendorId,
    companyId,
  });
  if (!vendor) throw new PayablesError("Invalid vendor", 400);
  return vendor;
}

/** A draft bill, due in 14 days unless told otherwise, in the vendor's currency by default. */
export async function createBillDraft(
  companyId: string,
  fields: BillFields & { vendorId: string },
  actorUserId: string | null,
): Promise<Bill> {
  const vendor = await companyVendor(companyId, fields.vendorId);
  const issueDate = fields.issueDate ?? new Date();
  const repo = AppDataSource.getRepository(Bill);
  const bill = await repo.save(
    repo.create({
      companyId,
      vendorId: vendor.id,
      slug: await draftBillSlug(companyId),
      numberSeq: 0,
      number: "",
      vendorRef: fields.vendorRef ?? "",
      status: "draft",
      issueDate,
      dueDate: fields.dueDate ?? new Date(issueDate.getTime() + 14 * 24 * 60 * 60 * 1000),
      currency: fields.currency ?? vendor.currency ?? "USD",
      notes: fields.notes ?? "",
      createdById: actorUserId,
    }),
  );
  if (fields.lines && fields.lines.length > 0) await replaceBillLines(bill, fields.lines);
  return recomputeBillTotals(bill);
}

/**
 * Edit a bill. Notes, the vendor's reference, and the due date change on any
 * bill that isn't void; the vendor, issue date, currency, and lines only on a
 * draft, because an issued bill's lines are already in the books.
 */
export async function updateBill(bill: Bill, fields: BillFields): Promise<Bill> {
  if (bill.status === "void") throw new PayablesError("Voided bills cannot be edited", 409);
  const draftOnly =
    fields.vendorId !== undefined ||
    fields.issueDate !== undefined ||
    fields.currency !== undefined ||
    fields.lines !== undefined;
  if (draftOnly && bill.status !== "draft") {
    throw new PayablesError("Lines and header (vendor/date/currency) are draft-only", 409);
  }
  if (fields.notes !== undefined) bill.notes = fields.notes;
  if (fields.vendorRef !== undefined) bill.vendorRef = fields.vendorRef;
  if (fields.dueDate !== undefined) bill.dueDate = fields.dueDate;
  if (fields.vendorId !== undefined) {
    bill.vendorId = (await companyVendor(bill.companyId, fields.vendorId)).id;
  }
  if (fields.issueDate !== undefined) bill.issueDate = fields.issueDate;
  if (fields.currency !== undefined) bill.currency = fields.currency;
  await AppDataSource.getRepository(Bill).save(bill);
  if (fields.lines !== undefined) await replaceBillLines(bill, fields.lines);
  return recomputeBillTotals(bill);
}

/** A draft has no number and nothing in the books; an issued bill is voided instead. */
export async function deleteDraftBill(bill: Bill): Promise<void> {
  if (bill.status !== "draft") {
    throw new PayablesError("Only drafts can be deleted — void issued bills instead", 409);
  }
  await AppDataSource.getRepository(BillLineItem).delete({ billId: bill.id });
  await AppDataSource.getRepository(BillPayment).delete({ billId: bill.id });
  await AppDataSource.getRepository(Bill).delete({ id: bill.id });
}

export type BillPaymentFields = {
  amountCents: number;
  currency?: string;
  paidAt?: Date;
  method?: BillPaymentMethod;
  reference?: string;
  notes?: string;
};

/**
 * Record money paid to the vendor against an issued bill and post it
 * (DR Accounts Payable / CR Bank). Paying past the balance would drive
 * Accounts Payable negative with no vendor credit to track it, so the amount
 * is capped at what is still due.
 */
export async function recordBillPayment(
  bill: Bill,
  fields: BillPaymentFields,
  actorUserId: string | null,
): Promise<{ bill: Bill; payment: BillPayment }> {
  if (bill.status === "draft") throw new PayablesError("Issue the bill before paying", 409);
  if (bill.status === "void") throw new PayablesError("Voided bills cannot be paid", 409);
  if (fields.amountCents > bill.balanceCents) {
    throw new PayablesError(
      bill.balanceCents <= 0
        ? "This bill is already fully paid."
        : `Payment exceeds the ${formatMoney(bill.balanceCents, bill.currency)} balance due. Record at most that amount.`,
      400,
    );
  }
  const repo = AppDataSource.getRepository(BillPayment);
  const payment = await repo.save(
    repo.create({
      billId: bill.id,
      amountCents: fields.amountCents,
      currency: fields.currency ?? bill.currency,
      paidAt: fields.paidAt ?? new Date(),
      method: fields.method ?? "other",
      reference: fields.reference ?? "",
      notes: fields.notes ?? "",
      createdById: actorUserId,
    }),
  );
  try {
    await postBillPayment(bill, payment, actorUserId);
  } catch (err) {
    // Typically a closed period covering the payment date.
    await repo.delete({ id: payment.id });
    throw new PayablesError((err as Error).message, 400);
  }
  return { bill: await recomputeBillTotals(bill), payment };
}

/**
 * Take a payment off a bill and reverse its posting. A voided bill's payments
 * were reversed by the void already; reversing one again would double-debit
 * Bank.
 */
export async function removeBillPayment(
  bill: Bill,
  paymentId: string,
  actorUserId: string | null,
): Promise<{ bill: Bill; payment: BillPayment }> {
  if (bill.status === "void") {
    throw new PayablesError(
      "This bill is voided — its payments were already reversed and can't be deleted.",
      409,
    );
  }
  const repo = AppDataSource.getRepository(BillPayment);
  const payment = await repo.findOneBy({ id: paymentId, billId: bill.id });
  if (!payment) throw new PayablesError("Payment not found", 404);
  await reverseBillPayment(bill, payment, actorUserId);
  await repo.delete({ id: payment.id });
  return { bill: await recomputeBillTotals(bill), payment };
}
