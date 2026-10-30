import { In, type ObjectLiteral, type SelectQueryBuilder } from "typeorm";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import type { CardAccountingKind } from "../db/entities/CardTransaction.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import {
  type BankingStatus,
  type HydratedBankTransaction,
  hydrateBankTransactions,
  listBankingAccounts,
} from "./banking.js";
import { getFinanceSettings } from "./fx.js";
import { andWhereTokens, tokenizeQuery } from "./likeSearch.js";
import {
  andWhereDateRange,
  asText,
  asUuid,
  CURSOR_INVALID,
  type CursorValue,
  dateRange,
  decodeCursor,
  filterFingerprint,
  finishPage,
  type KeyedRow,
  type KeysetColumn,
  keysetRows,
  ListCursorError,
  ListQueryError,
  type PageInfo,
  type PageLimits,
  pageLimit,
  type PageRequest,
} from "./listPaging.js";

/**
 * Banking as an AI Employee reads it: bank lines and card purchases in one
 * list, newest first, the way the Banking page shows them, with the account
 * each came from and the category it is filed under named rather than left as
 * ids. Every amount is signed from the company's side — money in positive,
 * money out negative — so a card purchase reads like the bank payment it is.
 *
 * The list pages (`services/listPaging.ts`): every transaction is reachable,
 * however many there are, by following `nextCursor`, and the filters a
 * bookkeeper reaches for — the date, the account, the amount, words in the
 * description, the category — narrow it on the server. The REST route
 * `GET /banking/transactions` answers from this same function, so an AI
 * Employee and an API client read one list.
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
  payments?: Array<{
    invoiceNumber: string;
    invoiceSlug: string;
    customerName: string;
    amountCents: number;
  }>;
  /** Bank rows: matched to a posted entry that is not a category Banking gave it. */
  matchedEntry?: { entryId: string; memo: string; source: string };
  /** Card rows: `expense`, `refund`, or `payment` (a card bill payment, which has no category). */
  cardKind?: CardAccountingKind;
  /** Card rows: why posting it to the books failed, until it is retried. */
  postingError?: string;
};

/** What narrows Banking's list. Every field is optional and they combine. */
export type BankingQueueFilter = {
  /** `review` is the To review queue, `done` what is explained; unset is both. */
  status?: BankingStatus;
  kind?: "bank" | "card";
  /** One bank account or card (`bankingAccounts`). */
  feedId?: string;
  /** On or after this day (`YYYY-MM-DD`, UTC) or instant (ISO timestamp). */
  from?: string;
  /** On or before this day (the whole day) or instant. */
  to?: string;
  /** `in` is money in (a positive amount), `out` money out. */
  direction?: "in" | "out";
  /** Smallest amount, in cents, ignoring its sign. */
  minAmountCents?: number;
  /** Largest amount, in cents, ignoring its sign. */
  maxAmountCents?: number;
  /** Words that must all appear in the description (or a bank line's reference). */
  q?: string;
  /** Only transactions filed under this chart-of-accounts account. */
  categoryAccountId?: string;
};

export type BankingQueuePage = PageInfo & { transactions: BankingQueueRow[] };

/** 50 by default, at most 200 at once. */
export const BANKING_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 200 };

const SCOPE = "banking.transactions";

/**
 * A filter this list cannot answer: an amount range that ends before it
 * starts (400), or a bank account, card or category this company does not
 * have (404).
 */
export class BankingQueueError extends ListQueryError {}

/**
 * The filters as an AI tool's body sends them. The REST route reads the same
 * fields from its query string ({@link bankingQueueQuerySchema}).
 */
export const bankingFilterShape = {
  status: z.enum(["review", "done", "all"]).default("review"),
  kind: z.enum(["bank", "card"]).optional(),
  feedId: z.string().uuid().optional(),
  from: z.string().min(1).max(40).optional(),
  to: z.string().min(1).max(40).optional(),
  direction: z.enum(["in", "out"]).optional(),
  minAmountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxAmountCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  categoryAccountId: z.string().uuid().optional(),
};

export const bankingQueueQuerySchema = z
  .object({
    status: bankingFilterShape.status.describe(
      "review (default) is the To review queue; done is explained and in the books; all is both.",
    ),
    kind: bankingFilterShape.kind.describe("Only bank lines or only card purchases."),
    feedId: bankingFilterShape.feedId.describe(
      "One bank account or card, from GET /banking/accounts.",
    ),
    from: bankingFilterShape.from.describe(
      "On or after this date: YYYY-MM-DD is a calendar day in UTC, as Banking shows dates; an ISO timestamp is that instant.",
    ),
    to: bankingFilterShape.to.describe(
      "On or before this date: YYYY-MM-DD includes that whole day (UTC); an ISO timestamp is that instant.",
    ),
    direction: bankingFilterShape.direction.describe(
      "in is money in (positive amountCents), out is money out (negative).",
    ),
    minAmountCents: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Smallest amount in cents, ignoring sign."),
    maxAmountCents: z.coerce
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe("Largest amount in cents, ignoring sign."),
    q: bankingFilterShape.q.describe(
      "Words that must all appear in the description, or a bank line's reference.",
    ),
    categoryAccountId: bankingFilterShape.categoryAccountId.describe(
      "Only transactions filed under this chart-of-accounts account.",
    ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe(
        `Rows per page, default ${BANKING_PAGE.defaultLimit}; more than ${BANKING_PAGE.maxLimit} is cut to ${BANKING_PAGE.maxLimit}.`,
      ),
    cursor: z
      .string()
      .min(1)
      .max(1_000)
      .optional()
      .describe("nextCursor from the previous page, sent with exactly the same filters."),
  })
  .strict();

/** The filters a tool body or query string carried, as {@link bankingQueue} takes them. */
export function bankingFilterFrom(input: {
  status: "review" | "done" | "all";
  kind?: "bank" | "card";
  feedId?: string;
  from?: string;
  to?: string;
  direction?: "in" | "out";
  minAmountCents?: number;
  maxAmountCents?: number;
  q?: string;
  categoryAccountId?: string;
}): BankingQueueFilter {
  return {
    status: input.status === "all" ? undefined : input.status,
    kind: input.kind,
    feedId: input.feedId,
    from: input.from,
    to: input.to,
    direction: input.direction,
    minAmountCents: input.minAmountCents,
    maxAmountCents: input.maxAmountCents,
    q: input.q,
    categoryAccountId: input.categoryAccountId,
  };
}

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

/** Quoted for raw SQL on either driver. */
function quote(identifier: string): string {
  return AppDataSource.driver.escape(identifier);
}

/**
 * A bank line is filed under `account` when Banking categorized it there and
 * the books still hold it there: its category entry, with any category change
 * Entry review once approved for it (`ledger_reclass`, from before bank
 * categories were locked to Banking), leaves money on that account — exactly
 * what the row's `category` shows (`bookedLines`).
 */
function bankFiledUnder(param: string): string {
  const e = quote("e");
  const l = quote("l");
  const r = quote("r");
  const f = quote("f");
  const col = (alias: string, name: string) => `${alias}.${quote(name)}`;
  return [
    `t.matchedLedgerEntryId IS NOT NULL`,
    `EXISTS (SELECT 1 FROM ${quote("ledger_entries")} ${e} WHERE ${col(e, "id")} = ${asUuid("t.matchedLedgerEntryId")} AND ${col(e, "companyId")} = t.companyId AND ${col(e, "source")} = 'bank_categorization' AND ${col(e, "sourceRefId")} = ${asText("t.id")})`,
    `NOT EXISTS (SELECT 1 FROM ${quote("bank_feeds")} ${f} WHERE ${col(f, "id")} = ${asUuid("t.feedId")} AND ${col(f, "accountId")} = :${param})`,
    `(SELECT COALESCE(SUM(${col(l, "debitCents")} - ${col(l, "creditCents")}), 0) FROM ${quote("ledger_lines")} ${l} WHERE ${col(l, "companyId")} = t.companyId AND ${col(l, "accountId")} = :${param} AND (${col(l, "ledgerEntryId")} = t.matchedLedgerEntryId OR ${col(l, "ledgerEntryId")} IN (SELECT ${asText(col(r, "id"))} FROM ${quote("ledger_entries")} ${r} WHERE ${col(r, "companyId")} = t.companyId AND ${col(r, "source")} = 'ledger_reclass' AND ${col(r, "sourceRefId")} = t.matchedLedgerEntryId))) <> 0`,
  ].join(" AND ");
}

type ResolvedFilter = BankingQueueFilter & { range: ReturnType<typeof dateRange> };

function amountClauses<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  filter: ResolvedFilter,
): SelectQueryBuilder<T> {
  if (filter.minAmountCents !== undefined) {
    qb.andWhere("ABS(t.amountCents) >= :minAmount", { minAmount: filter.minAmountCents });
  }
  if (filter.maxAmountCents !== undefined) {
    qb.andWhere("ABS(t.amountCents) <= :maxAmount", { maxAmount: filter.maxAmountCents });
  }
  return qb;
}

function bankQuery(companyId: string, filter: ResolvedFilter): SelectQueryBuilder<BankTransaction> {
  const qb = AppDataSource.getRepository(BankTransaction)
    .createQueryBuilder("t")
    .where("t.companyId = :companyId", { companyId });
  if (filter.feedId) qb.andWhere("t.feedId = :feedId", { feedId: filter.feedId });
  if (filter.status === "review") qb.andWhere("t.reconciledAt IS NULL");
  if (filter.status === "done") qb.andWhere("t.reconciledAt IS NOT NULL");
  andWhereDateRange(qb, "t.date", filter.range, "date");
  if (filter.direction === "in") qb.andWhere("t.amountCents > 0");
  if (filter.direction === "out") qb.andWhere("t.amountCents < 0");
  amountClauses(qb, filter);
  if (filter.q) andWhereTokens(qb, ["t.description", "t.reference"], tokenizeQuery(filter.q), "q");
  if (filter.categoryAccountId) {
    qb.andWhere(bankFiledUnder("category"), { category: filter.categoryAccountId });
  }
  return qb;
}

function cardQuery(companyId: string, filter: ResolvedFilter): SelectQueryBuilder<CardTransaction> {
  const qb = AppDataSource.getRepository(CardTransaction)
    .createQueryBuilder("t")
    .where("t.companyId = :companyId", { companyId });
  if (filter.feedId) qb.andWhere("t.feedId = :feedId", { feedId: filter.feedId });
  if (filter.status === "review") {
    qb.andWhere("(t.ledgerEntryId IS NULL OR t.needsReview = :waiting)", { waiting: true });
  }
  if (filter.status === "done") {
    qb.andWhere("t.ledgerEntryId IS NOT NULL AND t.needsReview = :waiting", { waiting: false });
  }
  andWhereDateRange(qb, "t.postedAt", filter.range, "date");
  // A purchase is money out; a refund, and a card bill payment, are money in.
  if (filter.direction === "out")
    qb.andWhere("t.accountingKind = :expense", { expense: "expense" });
  if (filter.direction === "in")
    qb.andWhere("t.accountingKind <> :expense", { expense: "expense" });
  amountClauses(qb, filter);
  if (filter.q) andWhereTokens(qb, ["t.description"], tokenizeQuery(filter.q), "q");
  if (filter.categoryAccountId) {
    qb.andWhere("t.expenseAccountId = :category AND t.accountingKind <> :payment", {
      category: filter.categoryAccountId,
      payment: "payment",
    });
  }
  return qb;
}

/**
 * One order across both tables: newest first, a bank line before a card
 * purchase dated the same instant, then by id. The middle key is a constant
 * per table, so a cursor after a card purchase still says exactly which bank
 * lines on that date were already shown.
 */
const BANK_KEYS: KeysetColumn[] = [
  { column: "t.date", direction: "DESC", type: "timestamp" },
  { literal: 0, direction: "ASC" },
  { column: "t.id", direction: "DESC", type: "string" },
];
const CARD_KEYS: KeysetColumn[] = [
  { column: "t.postedAt", direction: "DESC", type: "timestamp" },
  { literal: 1, direction: "ASC" },
  { column: "t.id", direction: "DESC", type: "string" },
];

type Fetched = { kind: "bank"; txn: BankTransaction } | { kind: "card"; txn: CardTransaction };

function instantOf(entry: Fetched): number {
  return (entry.kind === "bank" ? entry.txn.date : entry.txn.postedAt).getTime();
}

/**
 * The same order the two queries sort by, for merging their pages. Instants
 * compare first; the database's own text for the timestamp breaks a tie
 * inside one millisecond, as the database itself would.
 */
function newestFirst(a: KeyedRow<Fetched>, b: KeyedRow<Fetched>): number {
  const byInstant = instantOf(b.row) - instantOf(a.row);
  if (byInstant !== 0) return byInstant;
  const [aText, aRank, aId] = a.key;
  const [bText, bRank, bId] = b.key;
  if (aText !== bText) return aText < bText ? 1 : -1;
  if (aRank !== bRank) return Number(aRank) - Number(bRank);
  return aId < bId ? 1 : aId > bId ? -1 : 0;
}

async function feedNames(companyId: string): Promise<Map<string, string>> {
  const [banks, cards] = await Promise.all([
    AppDataSource.getRepository(BankFeed).find({ where: { companyId }, select: ["id", "name"] }),
    AppDataSource.getRepository(CardFeed).find({ where: { companyId }, select: ["id", "name"] }),
  ]);
  return new Map([...banks, ...cards].map((feed) => [feed.id, feed.name]));
}

async function assertFilterTargets(companyId: string, filter: BankingQueueFilter): Promise<void> {
  if (filter.feedId) {
    const [bank, card] = await Promise.all([
      AppDataSource.getRepository(BankFeed).existsBy({ id: filter.feedId, companyId }),
      AppDataSource.getRepository(CardFeed).existsBy({ id: filter.feedId, companyId }),
    ]);
    if (!bank && !card) {
      throw new BankingQueueError(
        "No bank account or card with that feedId. List them with list_banking_accounts (GET /banking/accounts).",
        404,
      );
    }
  }
  if (filter.categoryAccountId) {
    const exists = await AppDataSource.getRepository(Account).existsBy({
      id: filter.categoryAccountId,
      companyId,
    });
    if (!exists) {
      throw new BankingQueueError(
        "No chart-of-accounts account with that categoryAccountId. List them with list_finance_accounts.",
        404,
      );
    }
  }
}

/**
 * Banking's transactions, newest first, one page at a time. `status` unset is
 * both states; the To review queue is `review`. Follow `nextCursor` with the
 * same filters until `hasMore` is false to read every one. `budgetChars`
 * ends a page early when its rows would not fit an AI Employee's tool result.
 */
export async function bankingQueue(
  companyId: string,
  filter: BankingQueueFilter,
  page: PageRequest & { budgetChars?: number } = {},
): Promise<BankingQueuePage> {
  if (
    filter.minAmountCents !== undefined &&
    filter.maxAmountCents !== undefined &&
    filter.minAmountCents > filter.maxAmountCents
  ) {
    throw new BankingQueueError("minAmountCents must not be more than maxAmountCents");
  }
  const resolved: ResolvedFilter = { ...filter, range: dateRange(filter.from, filter.to) };
  const fingerprint = filterFingerprint(companyId, {
    status: filter.status,
    kind: filter.kind,
    feedId: filter.feedId,
    range: resolved.range,
    direction: filter.direction,
    minAmountCents: filter.minAmountCents,
    maxAmountCents: filter.maxAmountCents,
    q: filter.q ? tokenizeQuery(filter.q).map((token) => token.raw) : undefined,
    categoryAccountId: filter.categoryAccountId,
  });
  const after = page.cursor ? decodeCursor(SCOPE, fingerprint, page.cursor) : null;
  if (after && (after.length !== 3 || (after[1] !== 0 && after[1] !== 1))) {
    throw new ListCursorError(CURSOR_INVALID);
  }
  await assertFilterTargets(companyId, filter);
  const limit = pageLimit(page.limit, BANKING_PAGE);
  const wantBank = filter.kind !== "card";
  const wantCard = filter.kind !== "bank";

  const [bankTotal, cardTotal, bankRows, cardRows] = await Promise.all([
    wantBank ? bankQuery(companyId, resolved).getCount() : Promise.resolve(0),
    wantCard ? cardQuery(companyId, resolved).getCount() : Promise.resolve(0),
    wantBank
      ? keysetRows(bankQuery(companyId, resolved), {
          keys: BANK_KEYS,
          after: after as CursorValue[] | null,
          limit,
          prefix: "bank",
        })
      : Promise.resolve([]),
    wantCard
      ? keysetRows(cardQuery(companyId, resolved), {
          keys: CARD_KEYS,
          after: after as CursorValue[] | null,
          limit,
          prefix: "card",
        })
      : Promise.resolve([]),
  ]);
  // Each query brought up to limit + 1 rows after the cursor, so the first
  // limit + 1 of the two merged are the first limit + 1 of the whole list.
  const merged: KeyedRow<Fetched>[] = [
    ...bankRows.map(({ row, key }) => ({ row: { kind: "bank" as const, txn: row }, key })),
    ...cardRows.map(({ row, key }) => ({ row: { kind: "card" as const, txn: row }, key })),
  ].sort(newestFirst);
  const shown = merged.slice(0, limit);

  const [names, settings, hydrated] = await Promise.all([
    feedNames(companyId),
    getFinanceSettings(companyId),
    hydrateBankTransactions(
      companyId,
      shown.flatMap((entry) => (entry.row.kind === "bank" ? [entry.row.txn] : [])),
    ),
  ]);
  const hydratedById = new Map(hydrated.map((txn) => [txn.id, txn]));
  const categories = await categoriesById(companyId, [
    ...hydrated.map((txn) =>
      txn.match?.kind === "ledger_entry" ? txn.match.categoryAccountId : null,
    ),
    ...shown.map((entry) => (entry.row.kind === "card" ? entry.row.txn.expenseAccountId : null)),
  ]);
  const present = (entry: Fetched): BankingQueueRow =>
    entry.kind === "bank"
      ? bankRow(
          hydratedById.get(entry.txn.id)!,
          names.get(entry.txn.feedId) ?? "",
          settings.homeCurrency,
          categories,
        )
      : cardRow(entry.txn, names.get(entry.txn.feedId) ?? "", categories);

  const { rows, ...info } = finishPage({
    fetched: merged,
    limit,
    total: bankTotal + cardTotal,
    noun: "transactions",
    scope: SCOPE,
    fingerprint,
    present,
    budgetChars: page.budgetChars,
  });
  return { ...info, transactions: rows };
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
