import { AppDataSource } from "../db/datasource.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import type { CustomerCredit } from "../db/entities/CustomerCredit.js";
import type { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment, type InvoicePaymentMethod } from "../db/entities/InvoicePayment.js";
import { formatMoney } from "../lib/money.js";
import { createOverpaymentCredit } from "./customerCredits.js";
import {
  assertPaymentNotRecorded,
  DuplicatePaymentError,
  normalizePaymentReference,
  postInvoicePayment,
  recomputeInvoiceTotals,
  reverseInvoicePayment,
} from "./finance.js";

/**
 * Recording and removing a payment a Member received against an invoice.
 *
 * Two doors lead here: Record payment on the invoice itself, and Banking,
 * where a deposit on a bank account is marked as the payment of one or more
 * invoices in one step. Both must keep the same guarantees — one payment
 * settles one invoice once, an overpayment is refused unless its excess
 * becomes a customer credit, and the ledger and the invoice never disagree —
 * so both call these.
 * (The AI Employee `record_payment` tool keeps its own stricter copy: it never
 * records an overpayment.)
 */

/** Why a payment can't be recorded or removed, with the HTTP status to answer. */
export class InvoicePaymentError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "InvoicePaymentError";
    this.status = status;
  }
}

export type RecordInvoicePaymentInput = {
  amountCents: number;
  currency?: string;
  paidAt?: Date;
  method?: InvoicePaymentMethod;
  reference?: string | null;
  notes?: string;
  /**
   * Record what exceeds the balance due as an on-account customer credit
   * instead of refusing the payment.
   */
  allowOverpayment?: boolean;
  /** The asset account the money landed in. `1100 Bank` when unset. */
  bankAccountId?: string | null;
  /** The bank transaction on Banking the payment arrived in, linked from the start. */
  bankTransactionId?: string | null;
};

export type RecordedInvoicePayment = {
  invoice: Invoice;
  /** Null when the whole amount was excess on an invoice already paid. */
  payment: InvoicePayment | null;
  /** The on-account credit the excess became, if there was any. */
  credit: CustomerCredit | null;
  reference: string;
  excessCents: number;
};

export async function recordInvoicePayment(
  invoice: Invoice,
  input: RecordInvoicePaymentInput,
  actorUserId: string | null,
): Promise<RecordedInvoicePayment> {
  if (invoice.status === "draft") {
    throw new InvoicePaymentError("Issue the invoice before recording payments", 409);
  }
  if (invoice.status === "void") {
    throw new InvoicePaymentError("Voided invoices cannot be paid", 409);
  }
  // The ledger applies the payment in the invoice's currency
  // (postInvoicePayment never reads payment.currency), so a mismatched code
  // would silently misbook cash and the paid/balance math. Refuse it rather
  // than corrupt the books.
  if (input.currency && input.currency !== invoice.currency) {
    throw new InvoicePaymentError(
      `Record the payment in the invoice's currency (${invoice.currency}). Multi-currency payments aren't supported — the amount is always applied in ${invoice.currency}.`,
      400,
    );
  }
  // A payment already in the books — on this invoice or any other — is not
  // recorded twice under the same reference. Checked before the balance, so a
  // duplicate on a settled invoice is never steered into an overpayment credit.
  const reference = normalizePaymentReference(input.reference);
  try {
    await assertPaymentNotRecorded(invoice.companyId, invoice, reference);
  } catch (err) {
    throw new InvoicePaymentError(
      (err as Error).message,
      err instanceof DuplicatePaymentError ? err.status : 400,
    );
  }
  // Overpayment splits into the applied portion (a normal payment) and the
  // excess (an on-account customer credit, DR Bank / CR 2400), instead of
  // driving AR negative. Off by default, so a caller that doesn't ask keeps
  // the refuse-overpayment guarantee.
  if (input.amountCents > invoice.balanceCents && !input.allowOverpayment) {
    throw new InvoicePaymentError(
      invoice.balanceCents <= 0
        ? "This invoice is already fully paid. Turn on overpayment to record the excess as a customer credit."
        : `Payment exceeds the ${formatMoney(invoice.balanceCents, invoice.currency)} balance due. Turn on overpayment to record the excess as a customer credit.`,
      400,
    );
  }
  const paidAt = input.paidAt ?? new Date();
  const applied = Math.min(input.amountCents, Math.max(invoice.balanceCents, 0));
  const excess = input.amountCents - applied;
  const repo = AppDataSource.getRepository(InvoicePayment);
  let payment: InvoicePayment | null = null;
  let credit: CustomerCredit | null = null;
  try {
    // No payment row when the whole amount is excess (invoice already
    // settled) — the excess is purely a customer credit.
    if (applied > 0) {
      payment = await repo.save(
        repo.create({
          invoiceId: invoice.id,
          amountCents: applied,
          currency: input.currency ?? invoice.currency,
          paidAt,
          method: input.method ?? "other",
          reference,
          notes: input.notes ?? "",
          bankTransactionId: input.bankTransactionId ?? null,
          createdById: actorUserId,
        }),
      );
      await postInvoicePayment(invoice, payment, actorUserId, {
        bankAccountId: input.bankAccountId ?? null,
      });
    }
    if (excess > 0) {
      credit = await createOverpaymentCredit(
        invoice.companyId,
        {
          customerId: invoice.customerId,
          amountCents: excess,
          currency: invoice.currency,
          bankAccountId: input.bankAccountId ?? null,
          paidAt,
        },
        actorUserId,
      );
    }
  } catch (err) {
    // Keep the GL and sub-ledger consistent: if the applied payment posted
    // but the excess credit failed, reverse the payment before bailing.
    if (payment) {
      await reverseInvoicePayment(invoice, payment, actorUserId);
      await repo.delete({ id: payment.id });
    }
    throw new InvoicePaymentError((err as Error).message, 400);
  }
  const recomputed = await recomputeInvoiceTotals(invoice);
  return { invoice: recomputed, payment, credit, reference, excessCents: excess };
}

/**
 * Take a payment back off its invoice: reverse its journal entry (the original
 * stays for the audit trail) and delete the row. The bank transaction it came
 * in is no longer fully explained, so it goes back to the Banking review list
 * rather than pointing at a payment that is gone. When that deposit paid other
 * invoices too, their payments stay on them and linked to it, and what is left
 * of the deposit waits for review.
 */
export async function removeInvoicePayment(
  invoice: Invoice,
  paymentId: string,
  actorUserId: string | null,
): Promise<{ invoice: Invoice; payment: InvoicePayment }> {
  // Voiding already reversed every payment posting for this invoice. Deleting
  // a payment now would reverse the same entry a second time (the two
  // reversals use different keys, so the idempotency guard misses it),
  // double-crediting Bank. Block it — the payment rows stay as history.
  if (invoice.status === "void") {
    throw new InvoicePaymentError(
      "This invoice is voided — its payments were already reversed and can't be deleted.",
      409,
    );
  }
  const repo = AppDataSource.getRepository(InvoicePayment);
  const payment = await repo.findOneBy({ id: paymentId, invoiceId: invoice.id });
  if (!payment) throw new InvoicePaymentError("Payment not found", 404);
  // Reverse the ledger entry first so the audit trail captures the original
  // posting + the reversal — then hard-delete the payment row.
  await reverseInvoicePayment(invoice, payment, actorUserId);
  await repo.delete({ id: payment.id });
  const transactions = AppDataSource.getRepository(BankTransaction);
  await transactions.update(
    { companyId: invoice.companyId, matchedPaymentId: payment.id },
    { matchedPaymentId: null, reconciledAt: null, reconciledById: null },
  );
  if (payment.bankTransactionId) {
    await transactions.update(
      { companyId: invoice.companyId, id: payment.bankTransactionId },
      { reconciledAt: null, reconciledById: null },
    );
  }
  return { invoice: await recomputeInvoiceTotals(invoice), payment };
}
