import { type FindOptionsWhere, In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Customer } from "../db/entities/Customer.js";
import { Invoice } from "../db/entities/Invoice.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import { formatMoney } from "../lib/money.js";
import { getFinanceSettings } from "./fx.js";
import {
  InvoicePaymentError,
  type RecordedInvoicePayment,
  recordInvoicePayment,
  removeInvoicePayment,
} from "./invoicePayments.js";
import { unmatch } from "./reconcile.js";

/**
 * Banking: the company's bank accounts and cards, and the transactions on
 * them, as one list a person works through.
 *
 * A bank account here is a `BankFeed` (a CSV upload, Brex Cash, or Stripe
 * payouts) and a card is a `CardFeed` (Brex). A bank transaction waits for
 * review until something explains it — it paid an invoice, it matches a
 * payment or entry already in the books, or someone gave it a category — and
 * `reconciledAt` records that it is done. A card transaction is filed under
 * its card's default category the moment it arrives, so it only waits when
 * that posting failed.
 */

export type BankingStatus = "review" | "done";

export type BankingAccount =
  | { kind: "bank"; feed: BankFeed; toReview: number; total: number }
  | { kind: "card"; feed: CardFeed; toReview: number; total: number };

type FeedCount = { feedId: string; count: number | string };

async function countByFeed(
  entity: typeof BankTransaction | typeof CardTransaction,
  companyId: string,
  open?: "reconciledAt" | "ledgerEntryId",
): Promise<Map<string, number>> {
  const qb = AppDataSource.getRepository(entity)
    .createQueryBuilder("t")
    .select("t.feedId", "feedId")
    .addSelect("COUNT(*)", "count")
    .where("t.companyId = :companyId", { companyId })
    .groupBy("t.feedId");
  if (open) qb.andWhere(`t.${open} IS NULL`);
  const rows = await qb.getRawMany<FeedCount>();
  return new Map(rows.map((row) => [row.feedId, Number(row.count)]));
}

/** Every bank account and card, oldest first, with how many transactions wait on each. */
export async function listBankingAccounts(companyId: string): Promise<BankingAccount[]> {
  const [bankFeeds, cardFeeds, bankTotals, bankOpen, cardTotals, cardOpen] = await Promise.all([
    AppDataSource.getRepository(BankFeed).find({
      where: { companyId },
      order: { createdAt: "ASC" },
    }),
    AppDataSource.getRepository(CardFeed).find({
      where: { companyId },
      order: { createdAt: "ASC" },
    }),
    countByFeed(BankTransaction, companyId),
    countByFeed(BankTransaction, companyId, "reconciledAt"),
    countByFeed(CardTransaction, companyId),
    countByFeed(CardTransaction, companyId, "ledgerEntryId"),
  ]);
  const accounts: BankingAccount[] = [
    ...bankFeeds.map((feed) => ({
      kind: "bank" as const,
      feed,
      toReview: bankOpen.get(feed.id) ?? 0,
      total: bankTotals.get(feed.id) ?? 0,
    })),
    ...cardFeeds.map((feed) => ({
      kind: "card" as const,
      feed,
      toReview: cardOpen.get(feed.id) ?? 0,
      total: cardTotals.get(feed.id) ?? 0,
    })),
  ];
  return accounts.sort((a, b) => a.feed.createdAt.getTime() - b.feed.createdAt.getTime());
}

/** The newest bank transactions, optionally on one account and in one state. */
export async function listBankTransactions(
  companyId: string,
  filter: { feedId?: string; status?: BankingStatus },
): Promise<BankTransaction[]> {
  const where: FindOptionsWhere<BankTransaction> = { companyId };
  if (filter.feedId) where.feedId = filter.feedId;
  if (filter.status === "review") where.reconciledAt = IsNull();
  if (filter.status === "done") where.reconciledAt = Not(IsNull());
  return AppDataSource.getRepository(BankTransaction).find({
    where,
    order: { date: "DESC", createdAt: "DESC" },
    take: 500,
  });
}

// ─────────────────────────── What a line matched ───────────────────────────

/**
 * Starts the notes of a payment Banking recorded from a deposit, so that
 * undoing the deposit can tell it from a payment someone recorded on the
 * invoice by hand — the first is taken off the invoice again, the second
 * stays where it was.
 */
export const BANKING_PAYMENT_NOTE = "Recorded from Banking:";

function bankingPaymentNote(feed: BankFeed, txn: BankTransaction): string {
  const description = txn.description.trim() || "bank transaction";
  return `${BANKING_PAYMENT_NOTE} ${feed.name} · ${description}`.slice(0, 2000);
}

function recordedFromBanking(payment: Pick<InvoicePayment, "notes">): boolean {
  return payment.notes.startsWith(BANKING_PAYMENT_NOTE);
}

export type BankTransactionMatch =
  | {
      kind: "payment";
      paymentId: string;
      invoiceId: string;
      invoiceNumber: string;
      invoiceSlug: string;
      customerName: string;
      amountCents: number;
      /** Banking recorded this payment from the deposit, so undoing removes it. */
      recordedHere: boolean;
    }
  | {
      kind: "ledger_entry";
      entryId: string;
      memo: string;
      source: string;
      sourceRefId: string | null;
      /** The category the line was filed under, when it was categorized here. */
      categoryAccountId: string | null;
    };

export type HydratedBankTransaction = BankTransaction & { match: BankTransactionMatch | null };

export async function hydrateBankTransactions(
  companyId: string,
  txns: BankTransaction[],
): Promise<HydratedBankTransaction[]> {
  if (txns.length === 0) return [];
  const paymentIds = [
    ...new Set(txns.map((t) => t.matchedPaymentId).filter((x): x is string => !!x)),
  ];
  const entryIds = [
    ...new Set(txns.map((t) => t.matchedLedgerEntryId).filter((x): x is string => !!x)),
  ];
  const feedIds = [...new Set(txns.map((t) => t.feedId))];
  const [payments, entries, entryLines, feeds] = await Promise.all([
    paymentIds.length
      ? AppDataSource.getRepository(InvoicePayment).find({ where: { id: In(paymentIds) } })
      : Promise.resolve([]),
    entryIds.length
      ? AppDataSource.getRepository(LedgerEntry).find({ where: { id: In(entryIds), companyId } })
      : Promise.resolve([]),
    entryIds.length
      ? AppDataSource.getRepository(LedgerLine).find({
          where: { ledgerEntryId: In(entryIds), companyId },
        })
      : Promise.resolve([]),
    AppDataSource.getRepository(BankFeed).find({ where: { id: In(feedIds), companyId } }),
  ]);
  const invIds = [...new Set(payments.map((p) => p.invoiceId))];
  const invoices = invIds.length
    ? await AppDataSource.getRepository(Invoice).find({ where: { id: In(invIds), companyId } })
    : [];
  const customerIds = [...new Set(invoices.map((i) => i.customerId))];
  const customers = customerIds.length
    ? await AppDataSource.getRepository(Customer).find({
        where: { id: In(customerIds), companyId },
      })
    : [];
  const invById = new Map(invoices.map((i) => [i.id, i]));
  const custById = new Map(customers.map((c) => [c.id, c]));
  const payById = new Map(payments.map((p) => [p.id, p]));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const feedAccount = new Map(feeds.map((f) => [f.id, f.accountId]));
  return txns.map((t) => {
    let match: BankTransactionMatch | null = null;
    if (t.matchedPaymentId) {
      const p = payById.get(t.matchedPaymentId);
      const inv = p ? invById.get(p.invoiceId) : null;
      if (p && inv) {
        match = {
          kind: "payment",
          paymentId: p.id,
          invoiceId: inv.id,
          invoiceNumber: inv.number || "(draft)",
          invoiceSlug: inv.slug,
          customerName: custById.get(inv.customerId)?.name ?? "—",
          amountCents: p.amountCents,
          recordedHere: recordedFromBanking(p),
        };
      }
    } else if (t.matchedLedgerEntryId) {
      const e = entryById.get(t.matchedLedgerEntryId);
      if (e) {
        const categorizedHere = e.source === "bank_categorization" && e.sourceRefId === t.id;
        const bankAccountId = feedAccount.get(t.feedId);
        const categoryLine = categorizedHere
          ? entryLines.find((l) => l.ledgerEntryId === e.id && l.accountId !== bankAccountId)
          : undefined;
        match = {
          kind: "ledger_entry",
          entryId: e.id,
          memo: e.memo,
          source: e.source,
          sourceRefId: e.sourceRefId,
          categoryAccountId: categoryLine?.accountId ?? null,
        };
      }
    }
    return { ...t, match };
  });
}

// ─────────────────────── Paying an invoice from a deposit ──────────────────

export type OpenInvoiceCandidate = {
  invoiceId: string;
  slug: string;
  number: string;
  customerName: string;
  currency: string;
  totalCents: number;
  balanceCents: number;
  issueDate: string;
  dueDate: string;
  /** The deposit is exactly what is still due. */
  exactAmount: boolean;
  /** The bank's description names the customer or the invoice number. */
  mentioned: boolean;
  /** The deposit is more than what is still due, so it can't pay this invoice here. */
  exceedsBalance: boolean;
  score: number;
};

/** Lowercase words, punctuation dropped: "ACME-CORP INV#12" → "acme corp inv 12". */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Words in a company name that say nothing about which company it is. */
const GENERIC_NAME_WORDS = new Set([
  "and",
  "ag",
  "bv",
  "co",
  "company",
  "corp",
  "corporation",
  "gmbh",
  "group",
  "inc",
  "limited",
  "llc",
  "llp",
  "ltd",
  "plc",
  "pty",
  "sa",
  "the",
]);

function namesCustomer(customerName: string, said: Set<string>): boolean {
  return words(customerName).some(
    (word) => word.length >= 3 && !GENERIC_NAME_WORDS.has(word) && said.has(word),
  );
}

/** "ACME-CORP-INV-0012" is named by the full number, or by "INV 0012" / "invoice 12". */
function namesInvoiceNumber(number: string, saidText: string, said: string[]): boolean {
  if (!number) return false;
  if (` ${saidText} `.includes(` ${words(number).join(" ")} `)) return true;
  const digits = /(\d+)\s*$/.exec(number)?.[1];
  if (!digits) return false;
  const bare = String(Number(digits));
  return said.some(
    (word, i) =>
      (word === "inv" || word === "invoice") &&
      (said[i + 1] === digits || said[i + 1] === bare),
  ) || said.includes(`inv${digits}`) || said.includes(`inv${bare}`);
}

/**
 * The invoices a deposit could be the payment of: every issued invoice with
 * money still due, in the company's home currency (bank transactions are
 * home-currency), best guess first. An exact amount and the bank naming the
 * customer or invoice put it near the top; a deposit bigger than what is due
 * is listed but can't settle it here.
 */
export async function openInvoicesForBankTransaction(
  txn: BankTransaction,
): Promise<OpenInvoiceCandidate[]> {
  if (txn.amountCents <= 0) return [];
  const { homeCurrency } = await getFinanceSettings(txn.companyId);
  const invoices = (
    await AppDataSource.getRepository(Invoice).find({
      where: { companyId: txn.companyId, status: "sent", currency: homeCurrency },
    })
  ).filter((inv) => inv.balanceCents > 0);
  if (invoices.length === 0) return [];
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { id: In([...new Set(invoices.map((i) => i.customerId))]), companyId: txn.companyId },
    select: ["id", "name"],
  });
  const nameById = new Map(customers.map((c) => [c.id, c.name]));
  const said = words(`${txn.description} ${txn.reference}`);
  const saidText = said.join(" ");
  const saidSet = new Set(said);
  const day = 24 * 60 * 60 * 1000;
  return invoices
    .map((inv) => {
      const customerName = nameById.get(inv.customerId) ?? "—";
      const exactAmount = inv.balanceCents === txn.amountCents;
      const exceedsBalance = txn.amountCents > inv.balanceCents;
      const mentioned =
        namesInvoiceNumber(inv.number, saidText, said) || namesCustomer(customerName, saidSet);
      const score =
        (exactAmount ? 0.5 : exceedsBalance ? 0 : 0.1) +
        (mentioned ? 0.4 : 0) -
        Math.min(Math.abs(inv.dueDate.getTime() - txn.date.getTime()) / day, 365) / 3650;
      return {
        invoiceId: inv.id,
        slug: inv.slug,
        number: inv.number,
        customerName,
        currency: inv.currency,
        totalCents: inv.totalCents,
        balanceCents: inv.balanceCents,
        issueDate: inv.issueDate.toISOString(),
        dueDate: inv.dueDate.toISOString(),
        exactAmount,
        mentioned,
        exceedsBalance,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 200);
}

/**
 * Mark an invoice paid with a deposit, in one step: record the deposit as a
 * payment on the invoice — dated the day the money arrived, posted to the
 * bank account it arrived in — and match the deposit to that payment.
 *
 * A deposit pays one invoice, up to what is still due on it. A bigger deposit
 * is refused rather than split, because its excess would become a customer
 * credit that undoing the match could not take back; the invoice page records
 * an overpayment, and the deposit can then be matched to it here.
 */
export async function payInvoiceFromBankTransaction(
  txn: BankTransaction,
  invoiceId: string,
  actorUserId: string | null,
): Promise<{ transaction: BankTransaction; invoice: Invoice; recorded: RecordedInvoicePayment }> {
  if (txn.reconciledAt) {
    throw new InvoicePaymentError(
      "This transaction is already matched or categorized. Undo that first.",
      409,
    );
  }
  if (txn.amountCents <= 0) {
    throw new InvoicePaymentError("Only money coming in can pay an invoice.", 400);
  }
  const feed = await AppDataSource.getRepository(BankFeed).findOneBy({
    id: txn.feedId,
    companyId: txn.companyId,
  });
  if (!feed) throw new InvoicePaymentError("The bank account for this transaction is gone.", 404);
  const invoice = await AppDataSource.getRepository(Invoice).findOneBy({
    id: invoiceId,
    companyId: txn.companyId,
  });
  if (!invoice) throw new InvoicePaymentError("Invoice not found", 404);
  const label = invoice.number || "This invoice";
  const { homeCurrency } = await getFinanceSettings(txn.companyId);
  if (invoice.currency !== homeCurrency) {
    throw new InvoicePaymentError(
      `${label} is billed in ${invoice.currency}, and bank transactions are in ${homeCurrency}. Record the payment on the invoice, then match it here.`,
      400,
    );
  }
  if (invoice.status !== "draft" && invoice.status !== "void" && invoice.balanceCents <= 0) {
    throw new InvoicePaymentError(`${label} is already paid.`, 409);
  }
  if (invoice.status === "sent" && txn.amountCents > invoice.balanceCents) {
    throw new InvoicePaymentError(
      `This deposit is ${formatMoney(txn.amountCents - invoice.balanceCents, invoice.currency)} more than the ${formatMoney(invoice.balanceCents, invoice.currency)} still due on ${label}. To keep the extra as a customer credit, record the payment on the invoice, then match it here.`,
      400,
    );
  }
  const recorded = await recordInvoicePayment(
    invoice,
    {
      amountCents: txn.amountCents,
      currency: invoice.currency,
      paidAt: txn.date,
      method: "bank_transfer",
      // A bank's own reference is free text that can repeat (a customer's
      // standing "ACME RETAINER"), and a payment reference must be unique, so
      // the payment carries the transaction in its notes instead.
      reference: "",
      notes: bankingPaymentNote(feed, txn),
      bankAccountId: feed.accountId,
    },
    actorUserId,
  );
  if (!recorded.payment) {
    throw new InvoicePaymentError(`${label} is already paid.`, 409);
  }
  txn.matchedPaymentId = recorded.payment.id;
  txn.matchedLedgerEntryId = null;
  txn.reconciledAt = new Date();
  txn.reconciledById = actorUserId;
  const transaction = await AppDataSource.getRepository(BankTransaction).save(txn);
  return { transaction, invoice: recorded.invoice, recorded };
}

/**
 * Undo whatever explains a transaction, putting it back to review. A category
 * is reversed (`unmatch`), and so is a payment Banking recorded from this
 * deposit: it comes off its invoice, which owes that money again. A payment
 * someone recorded on the invoice themselves stays there — only the link goes.
 */
export async function undoBankTransaction(
  txn: BankTransaction,
  actorUserId: string | null,
): Promise<{ transaction: BankTransaction; removedPayment: { invoice: Invoice; payment: InvoicePayment } | null }> {
  if (txn.matchedPaymentId) {
    const payment = await AppDataSource.getRepository(InvoicePayment).findOneBy({
      id: txn.matchedPaymentId,
    });
    const invoice = payment
      ? await AppDataSource.getRepository(Invoice).findOneBy({
          id: payment.invoiceId,
          companyId: txn.companyId,
        })
      : null;
    if (payment && invoice && recordedFromBanking(payment)) {
      const removed = await removeInvoicePayment(invoice, payment.id, actorUserId);
      const transaction = await AppDataSource.getRepository(BankTransaction).findOneByOrFail({
        id: txn.id,
        companyId: txn.companyId,
      });
      return { transaction, removedPayment: removed };
    }
  }
  return { transaction: await unmatch(txn), removedPayment: null };
}
