import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";

/**
 * Which invoice payments a bank transaction is linked to.
 *
 * A link is written on the payment (`InvoicePayment.bankTransactionId`), so one
 * deposit can pay several invoices while each payment stays in at most one
 * deposit. Matches made before that still sit on the transaction
 * (`BankTransaction.matchedPaymentId`, one payment each) and are never
 * rewritten, so everything that asks "what does this deposit pay?" or "is this
 * payment spoken for?" reads both through here.
 */

const paymentRepo = () => AppDataSource.getRepository(InvoicePayment);
const transactionRepo = () => AppDataSource.getRepository(BankTransaction);

/** The payments each transaction is linked to, by transaction id. */
export async function linkedPaymentsByTransaction(
  txns: ReadonlyArray<Pick<BankTransaction, "id" | "matchedPaymentId">>,
): Promise<Map<string, InvoicePayment[]>> {
  const byTransaction = new Map<string, InvoicePayment[]>();
  if (txns.length === 0) return byTransaction;
  const olderIds = [
    ...new Set(txns.map((t) => t.matchedPaymentId).filter((id): id is string => !!id)),
  ];
  const [older, linked] = await Promise.all([
    olderIds.length ? paymentRepo().find({ where: { id: In(olderIds) } }) : Promise.resolve([]),
    paymentRepo().find({
      where: { bankTransactionId: In(txns.map((t) => t.id)) },
      order: { createdAt: "ASC", id: "ASC" },
    }),
  ]);
  const olderById = new Map(older.map((payment) => [payment.id, payment]));
  for (const txn of txns) {
    const first = txn.matchedPaymentId ? olderById.get(txn.matchedPaymentId) : undefined;
    byTransaction.set(txn.id, [
      ...(first ? [first] : []),
      ...linked.filter(
        (payment) => payment.bankTransactionId === txn.id && payment.id !== first?.id,
      ),
    ]);
  }
  return byTransaction;
}

/** The payments one transaction is linked to. */
export async function linkedPayments(
  txn: Pick<BankTransaction, "id" | "matchedPaymentId">,
): Promise<InvoicePayment[]> {
  return (await linkedPaymentsByTransaction([txn])).get(txn.id) ?? [];
}

/**
 * How much of a deposit the payments linked to it don't account for yet: all
 * of it for a new deposit, and the rest when one of several payments it made
 * was deleted from its invoice.
 */
export async function unexplainedCents(
  txn: Pick<BankTransaction, "id" | "matchedPaymentId" | "amountCents">,
): Promise<number> {
  const payments = await linkedPayments(txn);
  return txn.amountCents - payments.reduce((sum, payment) => sum + payment.amountCents, 0);
}

/**
 * Every payment of the company already linked to a bank transaction, with the
 * transaction it is linked to. A payment can explain one transaction only, so
 * these are spoken for.
 */
export async function claimedPaymentIds(companyId: string): Promise<Map<string, string>> {
  const [older, linked] = await Promise.all([
    transactionRepo().find({
      where: { companyId, matchedPaymentId: Not(IsNull()) },
      select: ["id", "matchedPaymentId"],
    }),
    // Through the transaction, which carries the company — a payment does not.
    paymentRepo()
      .createQueryBuilder("payment")
      .select(["payment.id", "payment.bankTransactionId"])
      .innerJoin(BankTransaction, "txn", "CAST(txn.id AS text) = payment.bankTransactionId")
      .where("txn.companyId = :companyId", { companyId })
      .getMany(),
  ]);
  const claimed = new Map<string, string>();
  for (const txn of older) claimed.set(txn.matchedPaymentId as string, txn.id);
  for (const payment of linked) claimed.set(payment.id, payment.bankTransactionId as string);
  return claimed;
}

/** The other transaction this payment is already linked to, if one is. */
export async function transactionClaiming(
  companyId: string,
  payment: Pick<InvoicePayment, "id" | "bankTransactionId">,
  exceptTransactionId: string,
): Promise<BankTransaction | null> {
  const select: Array<keyof BankTransaction> = ["id", "date", "description"];
  const older = await transactionRepo().findOne({
    where: { companyId, matchedPaymentId: payment.id, id: Not(exceptTransactionId) },
    select,
  });
  if (older) return older;
  if (!payment.bankTransactionId || payment.bankTransactionId === exceptTransactionId) return null;
  return transactionRepo().findOne({ where: { companyId, id: payment.bankTransactionId }, select });
}

/** Whether any payment is linked to this transaction. */
export async function hasLinkedPayments(
  txn: Pick<BankTransaction, "id" | "matchedPaymentId">,
): Promise<boolean> {
  if (txn.matchedPaymentId) return true;
  return (await paymentRepo().countBy({ bankTransactionId: txn.id })) > 0;
}

/** Take every payment's link to this transaction off it. The payments stay. */
export async function unlinkPayments(txn: Pick<BankTransaction, "id">): Promise<void> {
  await paymentRepo().update({ bankTransactionId: txn.id }, { bankTransactionId: null });
}
