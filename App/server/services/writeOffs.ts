import { IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { Invoice } from "../db/entities/Invoice.js";
import {
  InvoiceWriteOff,
  type InvoiceWriteOffKind,
} from "../db/entities/InvoiceWriteOff.js";
import { convertCents, getFinanceSettings } from "./fx.js";
import { findClosedPeriodCovering, postLedgerEntry, requireAccountsByCode } from "./ledger.js";
import { recomputeInvoiceTotals } from "./finance.js";

/**
 * Write-off service. Phase H of the Finance milestone (M19) — see ROADMAP.md.
 *
 * A write-off settles a receivable without cash and without reversing the
 * sale: DR 6100 Bad Debt Expense (or a chosen expense account) / CR 1200
 * Accounts Receivable. Both legs use the invoice's issue-date rate, so the
 * entry is always balanced by construction and never carries an FX leg.
 *
 * Postings are not wrapped in a DB transaction (postLedgerEntry is
 * non-transactional under sqlite — see ledger.ts). We create the write-off
 * row first, then post; a failure between the two leaves an unposted row that
 * a later reversal can still clean up, which is safer than an unbacked ledger
 * entry. This mirrors the existing invoice-issue flow.
 */

const BAD_DEBT_CODE = "6100";
const AR_CODE = "1200";

export type CreateWriteOffInput = {
  amountCents: number;
  kind: InvoiceWriteOffKind;
  /** Optional override for the debit account (default 6100 Bad Debt Expense);
   *  useful for a settlement discount or FX residual an accountant would rather
   *  book to G&A or sales returns. Must be an expense account in the company. */
  expenseAccountId?: string | null;
  writeOffDate?: Date;
  note?: string;
};

async function sumOpenWriteOffs(invoiceId: string): Promise<number> {
  const rows = await AppDataSource.getRepository(InvoiceWriteOff).find({
    where: { invoiceId, reversedAt: IsNull() },
    select: ["amountCents"],
  });
  return rows.reduce((sum, r) => sum + r.amountCents, 0);
}

/** Re-derive the invoice's `writtenOffCents` from its non-reversed write-offs,
 *  then recompute balance + status. The write-off column is service-owned;
 *  recomputeInvoiceTotals reads it but never resets it. */
async function refreshInvoiceAfterWriteOff(invoice: Invoice): Promise<Invoice> {
  invoice.writtenOffCents = await sumOpenWriteOffs(invoice.id);
  return recomputeInvoiceTotals(invoice);
}

async function resolveExpenseAccount(
  companyId: string,
  expenseAccountId: string | null | undefined,
): Promise<Account> {
  if (expenseAccountId) {
    const account = await AppDataSource.getRepository(Account).findOneBy({
      id: expenseAccountId,
      companyId,
    });
    if (!account) throw new Error("Expense account not found");
    if (account.type !== "expense") {
      throw new Error("A write-off must post to an expense account");
    }
    if (account.archivedAt) throw new Error("That expense account is archived");
    return account;
  }
  const byCode = await requireAccountsByCode(companyId, [BAD_DEBT_CODE]);
  return byCode.get(BAD_DEBT_CODE)!;
}

export async function listInvoiceWriteOffs(
  companyId: string,
  invoiceId: string,
): Promise<InvoiceWriteOff[]> {
  return AppDataSource.getRepository(InvoiceWriteOff).find({
    where: { companyId, invoiceId },
    order: { createdAt: "ASC" },
  });
}

export async function createInvoiceWriteOff(
  invoice: Invoice,
  input: CreateWriteOffInput,
  actorUserId: string | null,
): Promise<InvoiceWriteOff> {
  if (invoice.status !== "sent" && invoice.status !== "paid") {
    // A draft has no invoice_issue posting, so CR 1200 would have no offsetting
    // debit; a void has already had its AR reversed.
    throw new Error("Only an issued invoice (sent or paid) can be written off");
  }
  const amountCents = Math.trunc(input.amountCents);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("Write-off amount must be a positive whole number of cents");
  }
  if (amountCents > invoice.balanceCents) {
    throw new Error(
      `Write-off ${amountCents} exceeds the invoice's open balance ${invoice.balanceCents}`,
    );
  }
  const date = input.writeOffDate ?? new Date();
  const closed = await findClosedPeriodCovering(invoice.companyId, date);
  if (closed) {
    throw new Error(
      `That date falls in the closed period "${closed.name}". Reopen it or choose another date.`,
    );
  }
  const settings = await getFinanceSettings(invoice.companyId);
  const { converted: homeCents } = await convertCents(
    invoice.companyId,
    amountCents,
    invoice.currency,
    settings.homeCurrency,
    invoice.issueDate,
  );
  if (homeCents <= 0) throw new Error("Converted write-off amount rounds to zero");
  const expense = await resolveExpenseAccount(invoice.companyId, input.expenseAccountId);
  const ar = (await requireAccountsByCode(invoice.companyId, [AR_CODE])).get(AR_CODE)!;

  const repo = AppDataSource.getRepository(InvoiceWriteOff);
  const label = invoice.number || invoice.slug;
  const writeOff = await repo.save(
    repo.create({
      companyId: invoice.companyId,
      invoiceId: invoice.id,
      kind: input.kind,
      amountCents,
      homeCents,
      currency: invoice.currency,
      expenseAccountId: expense.id,
      writeOffDate: date,
      note: input.note ?? "",
      createdById: actorUserId,
      reversedAt: null,
      reversedById: null,
    }),
  );

  await postLedgerEntry({
    companyId: invoice.companyId,
    date,
    memo: `Write-off (${input.kind === "bad_debt" ? "bad debt" : "residual"}) for ${label}`,
    source: "invoice_writeoff",
    sourceRefId: writeOff.id,
    createdById: actorUserId,
    // Giving up on a real debt deserves an owner's countersign; an immaterial
    // residual clears on its own.
    reviewStatus: input.kind === "bad_debt" ? "unreviewed" : "approved",
    lines: [
      { accountId: expense.id, debitCents: homeCents, description: `Write-off ${label}` },
      { accountId: ar.id, creditCents: homeCents, description: `Write-off ${label}` },
    ],
  });

  await refreshInvoiceAfterWriteOff(invoice);
  return writeOff;
}

export async function reverseInvoiceWriteOff(
  writeOff: InvoiceWriteOff,
  actorUserId: string | null,
): Promise<InvoiceWriteOff> {
  if (writeOff.reversedAt) throw new Error("This write-off has already been reversed");
  const date = new Date();
  const closed = await findClosedPeriodCovering(writeOff.companyId, date);
  if (closed) {
    throw new Error(
      `The reversal would post into the closed period "${closed.name}". Reopen it first.`,
    );
  }
  const ar = (await requireAccountsByCode(writeOff.companyId, [AR_CODE])).get(AR_CODE)!;

  // Explicit forward-posted mirror rebuilt from the row's carrying amount, not
  // reverseLedgerEntriesForSources (which cross-products its inputs). Also the
  // bad-debt-recovery path: undoing a write-off puts the receivable back.
  await postLedgerEntry({
    companyId: writeOff.companyId,
    date,
    memo: `Reversal of write-off ${writeOff.id.slice(0, 8)}`,
    source: "invoice_writeoff_reversal",
    sourceRefId: writeOff.id,
    createdById: actorUserId,
    reviewStatus: "approved",
    lines: [
      { accountId: ar.id, debitCents: writeOff.homeCents, description: "Write-off reversal" },
      {
        accountId: writeOff.expenseAccountId,
        creditCents: writeOff.homeCents,
        description: "Write-off reversal",
      },
    ],
  });

  writeOff.reversedAt = date;
  writeOff.reversedById = actorUserId;
  await AppDataSource.getRepository(InvoiceWriteOff).save(writeOff);

  const invoice = await AppDataSource.getRepository(Invoice).findOneBy({
    id: writeOff.invoiceId,
    companyId: writeOff.companyId,
  });
  if (invoice) await refreshInvoiceAfterWriteOff(invoice);
  return writeOff;
}
