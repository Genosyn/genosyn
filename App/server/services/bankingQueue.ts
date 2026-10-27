import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import type { CardAccountingKind, CardTransaction } from "../db/entities/CardTransaction.js";
import {
  type BankingStatus,
  type HydratedBankTransaction,
  hydrateBankTransactions,
  listBankTransactions,
  listBankingAccounts,
} from "./banking.js";
import { listCardTransactions } from "./cardExpenses.js";
import { getFinanceSettings } from "./fx.js";

/**
 * Banking as an AI Employee reads it: bank lines and card purchases in one
 * list, newest first, the way the Banking page shows them, with the account
 * each came from and the category it is filed under named rather than left as
 * ids. Every amount is signed from the company's side — money in positive,
 * money out negative — so a card purchase reads like the bank payment it is.
 *
 * Reading only. What changes a transaction is the same helper its own row on
 * Banking uses (`bulkBanking`, `manualMatch`, `undoBankTransaction`, …), so an
 * AI Employee and a Member get one set of rules.
 */

type CategoryRef = { accountId: string; code: string; name: string };

export type BankingQueueRow = {
  kind: "bank" | "card";
  id: string;
  date: string;
  amountCents: number;
  currency: string;
  description: string;
  /** The bank's reference; empty for card rows. */
  reference: string;
  account: { feedId: string; name: string };
  /** `review` waits in To review; `done` is explained and in the books. */
  status: BankingStatus;
  /** The category it is filed under; null when it has none yet. */
  category: CategoryRef | null;
  /** Bank rows: the invoice payments a deposit paid, when it paid any. */
  payments?: Array<{ invoiceNumber: string; invoiceSlug: string; customerName: string; amountCents: number }>;
  /** Bank rows: matched to a posted entry that is not a category Banking gave it. */
  matchedEntry?: { entryId: string; memo: string; source: string };
  /** Card rows: `expense`, `refund`, or `payment` (a card bill payment, which has no category). */
  cardKind?: CardAccountingKind;
  /** Card rows: why posting it to the books failed, until it is retried. */
  postingError?: string;
};

export type BankingQueue = {
  transactions: BankingQueueRow[];
  /** How many matched before `limit` cut the list. */
  total: number;
  truncated: boolean;
};

function cardStatus(txn: CardTransaction): BankingStatus {
  return !txn.ledgerEntryId || txn.needsReview ? "review" : "done";
}

function signedCardCents(txn: CardTransaction): number {
  const magnitude = Math.abs(txn.amountCents);
  return txn.accountingKind === "expense" ? -magnitude : magnitude;
}

async function categoriesById(
  companyId: string,
  ids: Array<string | null | undefined>,
): Promise<Map<string, CategoryRef>> {
  const wanted = [...new Set(ids.filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const accounts = await AppDataSource.getRepository(Account).find({
    where: { companyId, id: In(wanted) },
    select: ["id", "code", "name"],
  });
  return new Map(
    accounts.map((account) => [
      account.id,
      { accountId: account.id, code: account.code, name: account.name },
    ]),
  );
}

function bankRow(
  txn: HydratedBankTransaction,
  feedName: string,
  currency: string,
  categories: Map<string, CategoryRef>,
): BankingQueueRow {
  const row: BankingQueueRow = {
    kind: "bank",
    id: txn.id,
    date: txn.date.toISOString(),
    amountCents: txn.amountCents,
    currency,
    description: txn.description,
    reference: txn.reference,
    account: { feedId: txn.feedId, name: feedName },
    status: txn.reconciledAt ? "done" : "review",
    category: null,
  };
  const match = txn.match;
  if (match?.kind === "payments") {
    row.payments = match.payments.map((payment) => ({
      invoiceNumber: payment.invoiceNumber,
      invoiceSlug: payment.invoiceSlug,
      customerName: payment.customerName,
      amountCents: payment.amountCents,
    }));
  } else if (match?.kind === "ledger_entry") {
    if (match.categoryAccountId) {
      row.category = categories.get(match.categoryAccountId) ?? null;
    } else {
      row.matchedEntry = { entryId: match.entryId, memo: match.memo, source: match.source };
    }
  }
  return row;
}

function cardRow(
  txn: CardTransaction,
  feedName: string,
  categories: Map<string, CategoryRef>,
): BankingQueueRow {
  const row: BankingQueueRow = {
    kind: "card",
    id: txn.id,
    date: txn.postedAt.toISOString(),
    amountCents: signedCardCents(txn),
    currency: txn.currency,
    description: txn.description,
    reference: "",
    account: { feedId: txn.feedId, name: feedName },
    status: cardStatus(txn),
    category:
      txn.accountingKind === "payment" || !txn.expenseAccountId
        ? null
        : (categories.get(txn.expenseAccountId) ?? null),
    cardKind: txn.accountingKind,
  };
  if (txn.postingError) row.postingError = txn.postingError;
  return row;
}

/**
 * Banking's transactions, newest first. `status` defaults to everything; the
 * To review queue is `review`. `kind` narrows to bank lines or card purchases,
 * and `feedId` to one bank account or card (`bankingAccounts`).
 */
export async function bankingQueue(
  companyId: string,
  filter: {
    status?: BankingStatus;
    kind?: "bank" | "card";
    feedId?: string;
    limit?: number;
  },
): Promise<BankingQueue> {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const [accounts, bankTxns, cardTxns, settings] = await Promise.all([
    listBankingAccounts(companyId),
    filter.kind === "card"
      ? Promise.resolve([])
      : listBankTransactions(companyId, { feedId: filter.feedId, status: filter.status }),
    filter.kind === "bank"
      ? Promise.resolve([])
      : listCardTransactions(companyId, filter.feedId, filter.status),
    getFinanceSettings(companyId),
  ]);
  const feedNames = new Map(accounts.map((account) => [account.feed.id, account.feed.name]));
  const hydrated = await hydrateBankTransactions(companyId, bankTxns);
  const categories = await categoriesById(companyId, [
    ...hydrated.map((txn) =>
      txn.match?.kind === "ledger_entry" ? txn.match.categoryAccountId : null,
    ),
    ...cardTxns.map((txn) => txn.expenseAccountId),
  ]);
  const rows = [
    ...hydrated.map((txn) =>
      bankRow(txn, feedNames.get(txn.feedId) ?? "", settings.homeCurrency, categories),
    ),
    ...cardTxns.map((txn) => cardRow(txn, feedNames.get(txn.feedId) ?? "", categories)),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    transactions: rows.slice(0, limit),
    total: rows.length,
    truncated: rows.length > limit,
  };
}

export type BankingAccountSummary = {
  feedId: string;
  kind: "bank" | "card";
  name: string;
  /** The chart-of-accounts account its money posts to: the bank account, or the card's liability. */
  ledgerAccountId: string;
  /** A card's default category, which new purchases are filed under. */
  defaultCategoryAccountId?: string;
  toReview: number;
  total: number;
  provider: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  balance: { cents: number; currency: string; at: string } | null;
};

/** Every bank account and card on Banking, with how many transactions wait on each. */
export async function bankingAccounts(companyId: string): Promise<BankingAccountSummary[]> {
  const accounts = await listBankingAccounts(companyId);
  return accounts.map((account) => {
    const summary: BankingAccountSummary = {
      feedId: account.feed.id,
      kind: account.kind,
      name: account.feed.name,
      ledgerAccountId:
        account.kind === "bank" ? account.feed.accountId : account.feed.liabilityAccountId,
      toReview: account.toReview,
      total: account.total,
      provider: account.provider,
      lastSyncedAt: account.sync.lastSuccessAt,
      syncError: account.sync.error?.message ?? null,
      balance: account.balance,
    };
    if (account.kind === "card") {
      summary.defaultCategoryAccountId = account.feed.defaultExpenseAccountId;
    }
    return summary;
  });
}
