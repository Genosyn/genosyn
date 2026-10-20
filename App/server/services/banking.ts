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
import { formatMoney } from "../lib/money.js";
import {
  linkedPayments,
  linkedPaymentsByTransaction,
  unexplainedCents,
} from "./bankPaymentLinks.js";
import { getFinanceSettings } from "./fx.js";
import {
  InvoicePaymentError,
  type RecordedInvoicePayment,
  recordInvoicePayment,
  removeInvoicePayment,
} from "./invoicePayments.js";
import { bookedLines } from "./ledger.js";
import { unmatch } from "./reconcile.js";

/**
 * Banking: the company's bank accounts and cards, and the transactions on
 * them, as one list a person works through.
 *
 * A bank account here is a `BankFeed` (a CSV upload, Brex Cash, or Stripe
 * payouts) and a card is a `CardFeed` (Brex). A bank transaction waits for
 * review until something explains it — it paid one or more invoices, it
 * matches a payment or entry already in the books, or someone gave it a
 * category — and `reconciledAt` records that it is done. A card transaction is filed under
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

/**
 * Take a bank account off Banking. Its transactions go with it, and what they
 * put in the books stays: a payment recorded from one of its deposits stays on
 * its invoice, no longer linked to a transaction that is gone.
 */
export async function removeBankFeed(feed: BankFeed): Promise<void> {
  const transactions = AppDataSource.getRepository(BankTransaction);
  const ids = (await transactions.find({ where: { feedId: feed.id }, select: ["id"] })).map(
    (txn) => txn.id,
  );
  for (let i = 0; i < ids.length; i += 500) {
    await AppDataSource.getRepository(InvoicePayment).update(
      { bankTransactionId: In(ids.slice(i, i + 500)) },
      { bankTransactionId: null },
    );
  }
  await transactions.delete({ feedId: feed.id });
  await AppDataSource.getRepository(BankFeed).delete({ id: feed.id });
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

/** One invoice payment a bank transaction is linked to. */
export type BankTransactionPayment = {
  paymentId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceSlug: string;
  customerName: string;
  amountCents: number;
  /** Banking recorded this payment from the deposit, so undoing removes it. */
  recordedHere: boolean;
};

export type BankTransactionMatch =
  | {
      /**
       * The invoice payments the transaction is: one, or several when one
       * deposit paid several invoices. A transaction in review with payments
       * here paid them with part of its money, and the rest waits.
       */
      kind: "payments";
      payments: BankTransactionPayment[];
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
  const entryIds = [
    ...new Set(txns.map((t) => t.matchedLedgerEntryId).filter((x): x is string => !!x)),
  ];
  const feedIds = [...new Set(txns.map((t) => t.feedId))];
  const [linked, entries, entryLines, feeds] = await Promise.all([
    linkedPaymentsByTransaction(txns),
    entryIds.length
      ? AppDataSource.getRepository(LedgerEntry).find({ where: { id: In(entryIds), companyId } })
      : Promise.resolve([]),
    // As the books hold them now, so a categorization Entry review once moved
    // names the category it was moved to.
    bookedLines(companyId, entryIds),
    AppDataSource.getRepository(BankFeed).find({ where: { id: In(feedIds), companyId } }),
  ]);
  const invIds = [...new Set([...linked.values()].flat().map((p) => p.invoiceId))];
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
  const entryById = new Map(entries.map((e) => [e.id, e]));
  const feedAccount = new Map(feeds.map((f) => [f.id, f.accountId]));
  return txns.map((t) => {
    let match: BankTransactionMatch | null = null;
    const payments = (linked.get(t.id) ?? [])
      .flatMap((p): BankTransactionPayment[] => {
        const inv = invById.get(p.invoiceId);
        if (!inv) return [];
        return [
          {
            paymentId: p.id,
            invoiceId: inv.id,
            invoiceNumber: inv.number || "(draft)",
            invoiceSlug: inv.slug,
            customerName: custById.get(inv.customerId)?.name ?? "—",
            amountCents: p.amountCents,
            recordedHere: recordedFromBanking(p),
          },
        ];
      })
      .sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber, "en", { numeric: true }));
    if (payments.length > 0) {
      match = { kind: "payments", payments };
    } else if (t.matchedLedgerEntryId) {
      const e = entryById.get(t.matchedLedgerEntryId);
      if (e) {
        const categorizedHere = e.source === "bank_categorization" && e.sourceRefId === t.id;
        const bankAccountId = feedAccount.get(t.feedId);
        const categoryLine = categorizedHere
          ? entryLines.get(e.id)?.find((l) => l.accountId !== bankAccountId)
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

// ─────────────────────── Paying invoices from a deposit ────────────────────

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
  /** What is still due is exactly what is left of the deposit. */
  exactAmount: boolean;
  /** The bank's description names the customer or the invoice number. */
  mentioned: boolean;
  score: number;
};

/** Several of one customer's open invoices that add up to exactly what is left of a deposit. */
export type OpenInvoiceSet = {
  customerName: string;
  /** Oldest due first. */
  invoiceIds: string[];
};

export type DepositInvoiceOptions = {
  /**
   * What is left of the deposit to put on invoices: all of it, unless part
   * already paid some and one of those payments was deleted since.
   */
  remainingCents: number;
  /** The invoices it could pay, best guess first. */
  invoices: OpenInvoiceCandidate[];
  /** One customer's invoices that add up to exactly `remainingCents`, best guess first. */
  sets: OpenInvoiceSet[];
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

/** How many choices the search for invoice sets weighs, in all, before it stops looking. */
const SET_SEARCH_STEPS = 100_000;
/** How many sets of one customer's invoices are weighed against each other. */
const SETS_PER_CUSTOMER = 3;
/** How many sets are suggested for one deposit — one per customer. */
const MAX_SETS = 3;

/**
 * Up to `limit` sets of two or more of `items` whose balances add up to
 * exactly `target`, trying the earliest items first. `budget.steps` is shared
 * across calls, so a company with many customers owing many invoices can't
 * make the search take long: it stops looking, and the person ticks the
 * invoices themselves.
 */
function setsAddingUpTo(
  items: Invoice[],
  target: number,
  budget: { steps: number },
  limit: number,
): Invoice[][] {
  // What items i… add up to, so a branch that can't reach the target stops.
  const after = new Array<number>(items.length + 1).fill(0);
  for (let i = items.length - 1; i >= 0; i -= 1) after[i] = after[i + 1] + items[i].balanceCents;
  const found: Invoice[][] = [];
  const picked: Invoice[] = [];
  const walk = (from: number, sum: number): void => {
    for (let i = from; i < items.length; i += 1) {
      if (found.length >= limit || budget.steps <= 0 || sum + after[i] < target) return;
      budget.steps -= 1;
      const next = sum + items[i].balanceCents;
      if (next > target) continue;
      picked.push(items[i]);
      if (next < target) walk(i + 1, next);
      else if (picked.length >= 2) found.push([...picked]);
      picked.pop();
    }
  };
  walk(0, 0);
  return found;
}

/**
 * Sets of one customer's open invoices that a deposit pays exactly — a
 * customer settling several invoices with one transfer. A customer usually
 * pays its oldest invoices first, so those are tried first. Best guess first:
 * the bank's description naming the customer or the invoices, then a set that
 * is everything the customer owes, then its oldest invoices, then fewer.
 */
function exactInvoiceSets(
  invoices: Invoice[],
  target: number,
  customerName: (customerId: string) => string,
  named: { customer: (customerId: string) => boolean; invoice: (invoice: Invoice) => boolean },
): OpenInvoiceSet[] {
  const byCustomer = new Map<string, Invoice[]>();
  for (const invoice of invoices) {
    byCustomer.set(invoice.customerId, [...(byCustomer.get(invoice.customerId) ?? []), invoice]);
  }
  const budget = { steps: SET_SEARCH_STEPS };
  const best: Array<{ set: OpenInvoiceSet; score: number }> = [];
  for (const [customerId, owed] of byCustomer) {
    const fits = owed
      .filter((invoice) => invoice.balanceCents <= target)
      .sort(
        (a, b) =>
          a.dueDate.getTime() - b.dueDate.getTime() ||
          a.number.localeCompare(b.number, "en", { numeric: true }),
      );
    if (fits.length < 2) continue;
    let pick: { set: OpenInvoiceSet; score: number } | null = null;
    for (const found of setsAddingUpTo(fits, target, budget, SETS_PER_CUSTOMER)) {
      const oldest = found.every((invoice, i) => invoice === fits[i]);
      const score =
        (named.customer(customerId) ? 0.4 : 0) +
        (found.some(named.invoice) ? 0.3 : 0) +
        (found.length === owed.length ? 0.2 : 0) +
        (oldest ? 0.1 : 0) -
        found.length / 100;
      if (!pick || score > pick.score) {
        pick = {
          set: { customerName: customerName(customerId), invoiceIds: found.map((inv) => inv.id) },
          score,
        };
      }
    }
    if (pick) best.push(pick);
  }
  return best
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SETS)
    .map((entry) => entry.set);
}

/**
 * The invoices a deposit could be the payment of: every issued invoice with
 * money still due, in the company's home currency (bank transactions are
 * home-currency), best guess first. An exact amount and the bank naming the
 * customer or invoice put it near the top. Beside them, the sets of one
 * customer's invoices that add up to exactly the deposit, for a customer that
 * paid several at once.
 */
export async function openInvoicesForBankTransaction(
  txn: BankTransaction,
): Promise<DepositInvoiceOptions> {
  const remainingCents = txn.amountCents > 0 && !txn.reconciledAt ? await unexplainedCents(txn) : 0;
  const nothing: DepositInvoiceOptions = {
    remainingCents: Math.max(remainingCents, 0),
    invoices: [],
    sets: [],
  };
  if (remainingCents <= 0) return nothing;
  const { homeCurrency } = await getFinanceSettings(txn.companyId);
  const invoices = (
    await AppDataSource.getRepository(Invoice).find({
      where: { companyId: txn.companyId, status: "sent", currency: homeCurrency },
    })
  ).filter((inv) => inv.balanceCents > 0);
  if (invoices.length === 0) return nothing;
  const customers = await AppDataSource.getRepository(Customer).find({
    where: { id: In([...new Set(invoices.map((i) => i.customerId))]), companyId: txn.companyId },
    select: ["id", "name"],
  });
  const nameById = new Map(customers.map((c) => [c.id, c.name]));
  const said = words(`${txn.description} ${txn.reference}`);
  const saidText = said.join(" ");
  const saidSet = new Set(said);
  const customerName = (customerId: string) => nameById.get(customerId) ?? "—";
  const named = {
    customer: (customerId: string) => namesCustomer(customerName(customerId), saidSet),
    invoice: (invoice: Invoice) => namesInvoiceNumber(invoice.number, saidText, said),
  };
  const sets = exactInvoiceSets(invoices, remainingCents, customerName, named);
  // The best set's invoices rise with it, so the list agrees with the suggestion.
  const inBestSet = new Set(sets[0]?.invoiceIds ?? []);
  const day = 24 * 60 * 60 * 1000;
  const ranked = invoices
    .map((inv): OpenInvoiceCandidate => {
      const exactAmount = inv.balanceCents === remainingCents;
      const mentioned = named.invoice(inv) || named.customer(inv.customerId);
      const score =
        (exactAmount
          ? 0.5
          : inBestSet.has(inv.id)
            ? 0.3
            : inv.balanceCents > remainingCents
              ? 0.1
              : 0.05) +
        (mentioned ? 0.4 : 0) -
        Math.min(Math.abs(inv.dueDate.getTime() - txn.date.getTime()) / day, 365) / 3650;
      return {
        invoiceId: inv.id,
        slug: inv.slug,
        number: inv.number,
        customerName: customerName(inv.customerId),
        currency: inv.currency,
        totalCents: inv.totalCents,
        balanceCents: inv.balanceCents,
        issueDate: inv.issueDate.toISOString(),
        dueDate: inv.dueDate.toISOString(),
        exactAmount,
        mentioned,
        score,
      };
    })
    .sort((a, b) => b.score - a.score);
  // Every invoice a suggested set names is in the list, where it can be ticked.
  const inSets = new Set(sets.flatMap((set) => set.invoiceIds));
  const shown = ranked.slice(0, 200);
  shown.push(...ranked.slice(200).filter((candidate) => inSets.has(candidate.invoiceId)));
  return { remainingCents, invoices: shown, sets };
}

/** One invoice a deposit paid, and how much of the deposit went to it. */
export type InvoiceShare = { invoiceId: string; amountCents: number };

export type PaidFromDeposit = {
  invoice: Invoice;
  recorded: RecordedInvoicePayment & { payment: InvoicePayment };
};

/**
 * Mark invoices paid with a deposit, in one step: record a payment on each
 * for its share of the deposit — dated the day the money arrived, posted to
 * the bank account it arrived in, linked to the deposit — and mark the
 * deposit done. Customers often settle several invoices with one transfer, so
 * one deposit can pay several invoices, and a share can pay part of one.
 *
 * The shares add up to exactly the deposit — or to what is left of it, when
 * part already paid invoices and one of those payments was deleted since —
 * and none is more than what is still due on its invoice, in the home
 * currency bank transactions are in. A bigger share is refused rather than
 * split, because its excess would become a customer credit that undoing the
 * deposit could not take back; the invoice page records an overpayment, and
 * the deposit can then be matched to it here.
 *
 * All or nothing: when one payment can't be recorded, any recorded before it
 * come off their invoices again and the deposit stays in review.
 */
export async function payInvoicesFromBankTransaction(
  txn: BankTransaction,
  shares: InvoiceShare[],
  actorUserId: string | null,
): Promise<{ transaction: BankTransaction; paid: PaidFromDeposit[] }> {
  if (txn.reconciledAt) {
    throw new InvoicePaymentError(
      "This transaction is already matched or categorized. Undo that first.",
      409,
    );
  }
  if (txn.amountCents <= 0) {
    throw new InvoicePaymentError("Only money coming in can pay an invoice.", 400);
  }
  if (shares.length === 0) {
    throw new InvoicePaymentError("Choose the invoices this deposit paid.", 400);
  }
  if (shares.some((share) => !Number.isSafeInteger(share.amountCents) || share.amountCents <= 0)) {
    throw new InvoicePaymentError("Each invoice needs an amount above zero.", 400);
  }
  if (new Set(shares.map((share) => share.invoiceId)).size !== shares.length) {
    throw new InvoicePaymentError("Each invoice can be listed only once.", 400);
  }
  const feed = await AppDataSource.getRepository(BankFeed).findOneBy({
    id: txn.feedId,
    companyId: txn.companyId,
  });
  if (!feed) throw new InvoicePaymentError("The bank account for this transaction is gone.", 404);
  const { homeCurrency } = await getFinanceSettings(txn.companyId);
  const money = (cents: number) => formatMoney(cents, homeCurrency);

  const remaining = await unexplainedCents(txn);
  const total = shares.reduce((sum, share) => sum + share.amountCents, 0);
  if (total !== remaining) {
    const deposit =
      remaining === txn.amountCents
        ? `the ${money(remaining)} deposit`
        : `the ${money(remaining)} left of this deposit`;
    throw new InvoicePaymentError(
      total < remaining
        ? `These add up to ${money(total)}, ${money(remaining - total)} less than ${deposit}.`
        : `These add up to ${money(total)}, ${money(total - remaining)} more than ${deposit}.`,
      400,
    );
  }

  const invoices = await AppDataSource.getRepository(Invoice).find({
    where: { id: In(shares.map((share) => share.invoiceId)), companyId: txn.companyId },
  });
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));
  const plan = shares.map((share) => {
    const invoice = byId.get(share.invoiceId);
    if (!invoice) throw new InvoicePaymentError("Invoice not found", 404);
    const label = invoice.number || "This invoice";
    if (invoice.status === "draft") {
      throw new InvoicePaymentError(
        `${label} is a draft. Issue it before recording payments.`,
        409,
      );
    }
    if (invoice.status === "void") {
      throw new InvoicePaymentError(`${label} is voided, so it can't be paid.`, 409);
    }
    if (invoice.currency !== homeCurrency) {
      throw new InvoicePaymentError(
        `${label} is billed in ${invoice.currency}, and bank transactions are in ${homeCurrency}. Record the payment on the invoice, then match it here.`,
        400,
      );
    }
    if (invoice.balanceCents <= 0) {
      throw new InvoicePaymentError(`${label} is already paid.`, 409);
    }
    if (share.amountCents > invoice.balanceCents) {
      throw new InvoicePaymentError(
        `${money(share.amountCents)} is more than the ${money(invoice.balanceCents)} still due on ${label}. To keep the extra as a customer credit, record the payment on the invoice, then match it here.`,
        400,
      );
    }
    return { invoice, label, amountCents: share.amountCents };
  });

  // Claim the deposit before recording anything, so a second click — or a
  // second tab — can't pay it twice.
  const transactions = AppDataSource.getRepository(BankTransaction);
  const reconciledAt = new Date();
  const claim = await transactions.update(
    { id: txn.id, companyId: txn.companyId, reconciledAt: IsNull() },
    { reconciledAt, reconciledById: actorUserId },
  );
  if (!claim.affected) {
    throw new InvoicePaymentError(
      "This transaction was just matched or categorized. Reload to see what explains it.",
      409,
    );
  }

  const paid: PaidFromDeposit[] = [];
  try {
    for (const { invoice, label, amountCents } of plan) {
      const recorded = await recordInvoicePayment(
        invoice,
        {
          amountCents,
          currency: invoice.currency,
          paidAt: txn.date,
          method: "bank_transfer",
          // A bank's own reference is free text that can repeat (a customer's
          // standing "ACME RETAINER"), and a payment reference must be unique,
          // so the payment carries the transaction in its notes instead.
          reference: "",
          notes: bankingPaymentNote(feed, txn),
          bankAccountId: feed.accountId,
          bankTransactionId: txn.id,
        },
        actorUserId,
      );
      const payment = recorded.payment;
      if (!payment) throw new InvoicePaymentError(`${label} is already paid.`, 409);
      paid.push({ invoice: recorded.invoice, recorded: { ...recorded, payment } });
    }
  } catch (err) {
    // Take back what was recorded, newest first. Should taking one back fail
    // too, it stays linked to the deposit, which shows it in review with an
    // Undo — never as a payment nothing points to.
    for (const { invoice, recorded } of [...paid].reverse()) {
      await removeInvoicePayment(invoice, recorded.payment.id, actorUserId).catch(() => undefined);
    }
    await transactions.update(
      { id: txn.id, companyId: txn.companyId },
      { reconciledAt: null, reconciledById: null },
    );
    throw err;
  }

  txn.matchedPaymentId = null;
  txn.matchedLedgerEntryId = null;
  txn.reconciledAt = reconciledAt;
  txn.reconciledById = actorUserId;
  return { transaction: await transactions.save(txn), paid };
}

/**
 * Undo whatever explains a transaction, putting it back to review. A category
 * is reversed (`unmatch`), and so is every payment Banking recorded from this
 * deposit: each comes off its invoice, which owes that money again. A payment
 * someone recorded on the invoice themselves stays there — only the link goes.
 */
export async function undoBankTransaction(
  txn: BankTransaction,
  actorUserId: string | null,
): Promise<{
  transaction: BankTransaction;
  removedPayments: Array<{ invoice: Invoice; payment: InvoicePayment }>;
}> {
  const removedPayments: Array<{ invoice: Invoice; payment: InvoicePayment }> = [];
  for (const payment of await linkedPayments(txn)) {
    if (!recordedFromBanking(payment)) continue;
    const invoice = await AppDataSource.getRepository(Invoice).findOneBy({
      id: payment.invoiceId,
      companyId: txn.companyId,
    });
    if (invoice) removedPayments.push(await removeInvoicePayment(invoice, payment.id, actorUserId));
  }
  const fresh = removedPayments.length
    ? await AppDataSource.getRepository(BankTransaction).findOneByOrFail({
        id: txn.id,
        companyId: txn.companyId,
      })
    : txn;
  return { transaction: await unmatch(fresh), removedPayments };
}
