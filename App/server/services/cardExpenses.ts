import { randomUUID } from "node:crypto";
import { type FindOptionsWhere, In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { CardFeed, type CardFeedKind } from "../db/entities/CardFeed.js";
import { type CardAccountingKind, CardTransaction } from "../db/entities/CardTransaction.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import {
  type BrexConfig,
  type BrexCardTransaction,
  getBrexCardTransactionsPage,
} from "../integrations/providers/brex.js";
import { FeedSyncError, withProviderRetry } from "./feedSyncErrors.js";
import { convertCents, getFinanceSettings } from "./fx.js";
import { decryptConnectionConfig } from "./integrations.js";
import { postLedgerEntry } from "./ledger.js";
import { assertRampCardConnection, RAMP_SYNC_OVERLAP_MS, rampCardPages } from "./rampCards.js";

/**
 * How far before the last successful sync the next one asks Brex again, as
 * for a Brex cash account (`BANK_SYNC_OVERLAP_MS`): a purchase that settles
 * late still comes in, and Brex's ids keep the second look free of
 * duplicates. The window starts at the last *successful* sync, however long
 * ago, so a card that missed months catches up on all of them.
 */
const CARD_SYNC_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

type CreateCardFeedInput = {
  companyId: string;
  name: string;
  connectionId: string;
  liabilityAccountId: string;
  defaultExpenseAccountId: string;
  paymentAccountId: string;
};

export type CardSyncResult = {
  inserted: number;
  posted: number;
  failed: number;
};

/** Each kind of card: the Connection provider it reads, and what people call it. */
export const CARD_FEED_PROVIDERS: Record<CardFeedKind, { provider: "brex" | "ramp"; name: string }> = {
  brex_card: { provider: "brex", name: "Brex" },
  ramp_card: { provider: "ramp", name: "Ramp" },
};

/**
 * A settled card transaction as Banking keeps it, whichever provider sent it.
 * Amounts follow Brex's convention, which the books and Banking read: a
 * purchase is positive, a refund or a payment of the card's bill negative.
 */
export type IncomingCardTransaction = {
  cardId: string | null;
  postedAt: Date;
  amountCents: number;
  currency: string;
  description: string;
  providerType: string;
  accountingKind: CardAccountingKind;
  raw: unknown;
};

/**
 * One transaction a provider listed: its id, which dedupes it, and how to
 * read the rest. Only a transaction Genosyn hasn't seen is read, so one the
 * provider later sends something odd about never fails a sync again; `read`
 * throws a `FeedSyncError` on anything Genosyn won't guess about.
 */
export type ListedCardTransaction = {
  externalId: string;
  read: () => IncomingCardTransaction;
};

/**
 * Every transaction a card's provider settled since `postedAtStart` (its
 * whole history without one), a page at a time.
 */
type CardPages = (
  feed: CardFeed,
  postedAtStart: Date | undefined,
) => AsyncIterable<ListedCardTransaction[]>;

async function getBrexConfig(companyId: string, connectionId: string): Promise<BrexConfig> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
    companyId,
    provider: "brex",
  });
  if (!connection) throw new FeedSyncError("connection_missing", "Brex Connection not found");
  let config: Partial<BrexConfig>;
  try {
    config = decryptConnectionConfig(connection) as Partial<BrexConfig>;
  } catch (err) {
    throw new FeedSyncError("credentials", (err as Error).message);
  }
  if (!config.userToken || typeof config.userToken !== "string") {
    throw new FeedSyncError("credentials", "Brex Connection is missing its user token");
  }
  return { userToken: config.userToken };
}

async function requireMappedAccount(
  companyId: string,
  accountId: string,
  type: Account["type"],
  label: string,
): Promise<Account> {
  const account = await AppDataSource.getRepository(Account).findOneBy({
    id: accountId,
    companyId,
  });
  if (!account || account.archivedAt || account.type !== type) {
    throw new Error(label + " must be an active " + type + " account in this company");
  }
  return account;
}

export async function assertBrexCardConnection(
  companyId: string,
  connectionId: string,
): Promise<void> {
  const config = await getBrexConfig(companyId, connectionId);
  try {
    await getBrexCardTransactionsPage(config.userToken, { limit: 1 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Brex Card access failed. Grant transactions.card.readonly on the user token. " + message,
    );
  }
}

/** Check a Connection can read what a card of this kind syncs. */
export async function assertCardConnection(
  companyId: string,
  connectionId: string,
  kind: CardFeedKind,
): Promise<void> {
  if (kind === "ramp_card") await assertRampCardConnection(companyId, connectionId);
  else await assertBrexCardConnection(companyId, connectionId);
}

/** The kind of card a Connection syncs — a Brex card or a Ramp card — by its provider. */
async function cardKindOfConnection(companyId: string, connectionId: string): Promise<CardFeedKind> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOne({
    where: { id: connectionId, companyId },
    select: { id: true, provider: true },
  });
  if (!connection) throw new Error("Connection not found");
  const kind = (Object.keys(CARD_FEED_PROVIDERS) as CardFeedKind[]).find(
    (candidate) => CARD_FEED_PROVIDERS[candidate].provider === connection.provider,
  );
  if (!kind) throw new Error("A card syncs through a Brex or Ramp Connection");
  return kind;
}

/**
 * Add a card to Banking. Which provider it reads follows from the Connection:
 * a Brex Connection makes a Brex card, a Ramp Connection a Ramp card.
 */
export async function createCardFeed(input: CreateCardFeedInput): Promise<CardFeed> {
  const kind = await cardKindOfConnection(input.companyId, input.connectionId);
  await Promise.all([
    requireMappedAccount(input.companyId, input.liabilityAccountId, "liability", "Card liability"),
    requireMappedAccount(
      input.companyId,
      input.defaultExpenseAccountId,
      "expense",
      "Default category",
    ),
    requireMappedAccount(input.companyId, input.paymentAccountId, "asset", "Payment account"),
    assertCardConnection(input.companyId, input.connectionId, kind),
  ]);
  const repo = AppDataSource.getRepository(CardFeed);
  return repo.save(
    repo.create({
      companyId: input.companyId,
      name: input.name,
      kind,
      connectionId: input.connectionId,
      liabilityAccountId: input.liabilityAccountId,
      defaultExpenseAccountId: input.defaultExpenseAccountId,
      paymentAccountId: input.paymentAccountId,
    }),
  );
}

function classifyCardTransaction(
  transaction: Pick<BrexCardTransaction, "type" | "amount">,
): CardAccountingKind {
  const type = (transaction.type ?? "").toUpperCase();
  if (type === "COLLECTION" || type === "PAYMENT" || type === "CARD_PAYMENT") {
    return "payment";
  }
  if ((transaction.amount?.amount ?? 0) < 0) return "refund";
  return "expense";
}

function parsePostedDate(value: string, transactionId: string): Date {
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T12:00:00.000Z" : value);
  if (Number.isNaN(date.getTime())) {
    throw new FeedSyncError(
      "bad_data",
      "Brex card transaction " + transactionId + " has an invalid posted date",
    );
  }
  return date;
}

async function postCardTransaction(feed: CardFeed, transaction: CardTransaction): Promise<boolean> {
  if (transaction.ledgerEntryId) return false;
  const magnitude = Math.abs(transaction.amountCents);
  if (!Number.isSafeInteger(magnitude) || magnitude === 0) {
    throw new Error("Card transaction amount must be a non-zero safe integer");
  }
  const settings = await getFinanceSettings(feed.companyId);
  const converted = await convertCents(
    feed.companyId,
    magnitude,
    transaction.currency,
    settings.homeCurrency,
    transaction.postedAt,
  );
  const provider = CARD_FEED_PROVIDERS[feed.kind]?.name ?? "Brex";
  const description =
    transaction.description || provider + " card transaction " + transaction.externalId;

  let source: "brex_card_expense" | "brex_card_refund" | "brex_card_payment";
  let lines: Array<{
    accountId: string;
    debitCents?: number;
    creditCents?: number;
    description: string;
    origCurrency: string;
    origAmountCents: number;
    rate: number;
  }>;

  if (transaction.accountingKind === "payment") {
    source = "brex_card_payment";
    lines = [
      {
        accountId: feed.liabilityAccountId,
        debitCents: converted.converted,
        description,
        origCurrency: transaction.currency,
        origAmountCents: magnitude,
        rate: converted.rate,
      },
      {
        accountId: feed.paymentAccountId,
        creditCents: converted.converted,
        description,
        origCurrency: transaction.currency,
        origAmountCents: magnitude,
        rate: converted.rate,
      },
    ];
  } else {
    if (!transaction.expenseAccountId) {
      throw new Error("Card expense has no expense category");
    }
    if (transaction.accountingKind === "refund") {
      source = "brex_card_refund";
      lines = [
        {
          accountId: feed.liabilityAccountId,
          debitCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
        {
          accountId: transaction.expenseAccountId,
          creditCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
      ];
    } else {
      source = "brex_card_expense";
      lines = [
        {
          accountId: transaction.expenseAccountId,
          debitCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
        {
          accountId: feed.liabilityAccountId,
          creditCents: converted.converted,
          description,
          origCurrency: transaction.currency,
          origAmountCents: magnitude,
          rate: converted.rate,
        },
      ];
    }
  }

  const existingEntry = await AppDataSource.getRepository(LedgerEntry).findOneBy({
    companyId: feed.companyId,
    source,
    sourceRefId: transaction.id,
  });
  if (existingEntry) {
    transaction.ledgerEntryId = existingEntry.id;
    transaction.postingError = "";
    await AppDataSource.getRepository(CardTransaction).save(transaction);
    return true;
  }

  const { entry } = await postLedgerEntry({
    companyId: feed.companyId,
    date: transaction.postedAt,
    memo: provider + " card · " + description,
    source,
    sourceRefId: transaction.id,
    createdById: null,
    lines,
  });
  transaction.ledgerEntryId = entry.id;
  transaction.postingError = "";
  await AppDataSource.getRepository(CardTransaction).save(transaction);
  return true;
}

async function recordPostingResult(feed: CardFeed, transaction: CardTransaction): Promise<boolean> {
  try {
    return await postCardTransaction(feed, transaction);
  } catch (err) {
    transaction.postingError = err instanceof Error ? err.message : String(err);
    await AppDataSource.getRepository(CardTransaction).save(transaction);
    return false;
  }
}

/** A Brex card transaction in Banking's terms. */
function readBrexCardTransaction(remote: BrexCardTransaction): IncomingCardTransaction {
  if (!remote.amount || !Number.isSafeInteger(remote.amount.amount)) {
    throw new FeedSyncError(
      "bad_data",
      "Brex card transaction " + remote.id + " has no safe integer amount",
    );
  }
  return {
    cardId: remote.card_id ?? null,
    postedAt: parsePostedDate(remote.posted_at_date, remote.id),
    amountCents: remote.amount.amount,
    currency: (remote.amount.currency ?? "USD").toUpperCase(),
    description: remote.description || "Brex card transaction",
    providerType: remote.type ?? "",
    accountingKind: classifyCardTransaction(remote),
    raw: remote,
  };
}

/** A Brex card's settled transactions — purchases, refunds and collections alike. */
async function* brexCardPages(
  feed: CardFeed,
  postedAtStart: Date | undefined,
): AsyncIterable<ListedCardTransaction[]> {
  const config = await getBrexConfig(feed.companyId, feed.connectionId);
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await withProviderRetry(() =>
      getBrexCardTransactionsPage(config.userToken, {
        cursor,
        limit: 100,
        postedAtStart,
      }),
    );
    yield (page.items ?? []).map((remote) => ({
      externalId: remote.id,
      read: () => readBrexCardTransaction(remote),
    }));
    const next = page.next_cursor ?? undefined;
    if (!next) break;
    if (seenCursors.has(next)) {
      throw new FeedSyncError("bad_data", "Brex returned a repeated card transaction cursor");
    }
    seenCursors.add(next);
    cursor = next;
  }
}

/** Where each kind of card reads from, and how far back a sync looks again. */
const CARD_SOURCES: Record<CardFeedKind, { pages: CardPages; overlapMs: number }> = {
  brex_card: { pages: brexCardPages, overlapMs: CARD_SYNC_OVERLAP_MS },
  ramp_card: { pages: rampCardPages, overlapMs: RAMP_SYNC_OVERLAP_MS },
};

/**
 * Bring in a card's settled transactions and put each in the books under the
 * card's default category, waiting for review. The first sync walks the whole
 * history; later ones ask for what was posted since a little before the last
 * successful sync — a week for Brex, a month for Ramp. A purchase whose
 * posting failed before is posted again on every sync, so one that waited on
 * a closed period goes in once the period reopens.
 */
export async function syncCardFeed(feed: CardFeed, now = new Date()): Promise<CardSyncResult> {
  const source = CARD_SOURCES[feed.kind];
  if (!source) throw new Error("Feed is not a card feed");
  const transactionRepo = AppDataSource.getRepository(CardTransaction);
  // Ids only, for dedupe: a card's history only grows, and every row carries
  // the provider's whole payload. The ones still to post are read in full.
  const known = new Set(
    (await transactionRepo.find({ where: { feedId: feed.id }, select: ["id", "externalId"] })).map(
      (transaction) => transaction.externalId,
    ),
  );
  const pendingPosts = await transactionRepo.find({
    where: { feedId: feed.id, ledgerEntryId: IsNull() },
    order: { postedAt: "ASC", createdAt: "ASC" },
  });
  const postedAtStart = feed.lastSyncAt
    ? new Date(feed.lastSyncAt.getTime() - source.overlapMs)
    : undefined;
  let inserted = 0;

  for await (const page of source.pages(feed, postedAtStart)) {
    for (const listed of page) {
      if (known.has(listed.externalId)) continue;
      const remote = listed.read();
      const row = await transactionRepo.save(
        transactionRepo.create({
          companyId: feed.companyId,
          feedId: feed.id,
          externalId: listed.externalId,
          cardId: remote.cardId,
          postedAt: remote.postedAt,
          amountCents: remote.amountCents,
          currency: remote.currency,
          description: remote.description,
          providerType: remote.providerType,
          accountingKind: remote.accountingKind,
          expenseAccountId:
            remote.accountingKind === "payment" ? null : feed.defaultExpenseAccountId,
          // Filed under the default category, and waiting for someone to keep
          // it or pick another. A card bill payment has no category to pick.
          needsReview: remote.accountingKind !== "payment",
          raw: JSON.stringify(remote.raw),
        }),
      );
      known.add(listed.externalId);
      pendingPosts.push(row);
      inserted += 1;
    }
  }

  let posted = 0;
  for (const transaction of pendingPosts) {
    if (await recordPostingResult(feed, transaction)) posted += 1;
  }
  // Only the cursor: a `save` of this copy would write every column it loaded
  // back over the sync status kept on the same row.
  await AppDataSource.getRepository(CardFeed).update(
    { id: feed.id, companyId: feed.companyId },
    { lastSyncAt: now },
  );
  feed.lastSyncAt = now;
  return {
    inserted,
    posted,
    failed: pendingPosts.length - posted,
  };
}

export async function retryCardTransaction(transaction: CardTransaction): Promise<CardTransaction> {
  const feed = await AppDataSource.getRepository(CardFeed).findOneBy({
    id: transaction.feedId,
    companyId: transaction.companyId,
  });
  if (!feed) throw new Error("Card feed not found");
  try {
    await postCardTransaction(feed, transaction);
  } catch (err) {
    transaction.postingError = err instanceof Error ? err.message : String(err);
    await AppDataSource.getRepository(CardTransaction).save(transaction);
    throw err;
  }
  return transaction;
}

/**
 * Move a card purchase to another category: the one place its category
 * changes (`shared/cardCategory.ts`). The reclassification moves the amount
 * out of the category the purchase is filed under now, which only the
 * purchase itself knows — not the category its first entry was posted to.
 *
 * Picking a category reviews the purchase, the one it already has included,
 * once it is in the books.
 */
export async function reclassifyCardTransaction(
  transaction: CardTransaction,
  expenseAccountId: string,
  actorUserId: string | null,
): Promise<CardTransaction> {
  if (transaction.accountingKind === "payment") {
    throw new Error("Card payments do not have an expense category");
  }
  await requireMappedAccount(
    transaction.companyId,
    expenseAccountId,
    "expense",
    "Expense category",
  );
  const repo = AppDataSource.getRepository(CardTransaction);
  if (transaction.expenseAccountId === expenseAccountId) {
    if (!transaction.ledgerEntryId || !transaction.needsReview) return transaction;
    transaction.needsReview = false;
    return repo.save(transaction);
  }
  const oldExpenseAccountId = transaction.expenseAccountId;
  transaction.expenseAccountId = expenseAccountId;

  if (!transaction.ledgerEntryId || !oldExpenseAccountId) {
    await repo.save(transaction);
    await retryCardTransaction(transaction);
    transaction.needsReview = false;
    return repo.save(transaction);
  }

  const settings = await getFinanceSettings(transaction.companyId);
  const converted = await convertCents(
    transaction.companyId,
    Math.abs(transaction.amountCents),
    transaction.currency,
    settings.homeCurrency,
    transaction.postedAt,
  );
  const description = "Reclassify " + (transaction.description || transaction.externalId);
  const lines =
    transaction.accountingKind === "refund"
      ? [
          {
            accountId: oldExpenseAccountId,
            debitCents: converted.converted,
            description,
          },
          {
            accountId: expenseAccountId,
            creditCents: converted.converted,
            description,
          },
        ]
      : [
          {
            accountId: expenseAccountId,
            debitCents: converted.converted,
            description,
          },
          {
            accountId: oldExpenseAccountId,
            creditCents: converted.converted,
            description,
          },
        ];
  await postLedgerEntry({
    companyId: transaction.companyId,
    date: new Date(),
    memo: description,
    source: "brex_card_reclass",
    sourceRefId: transaction.id + ":" + randomUUID(),
    createdById: actorUserId,
    lines,
  });
  transaction.reclassifiedAt = new Date();
  transaction.postingError = "";
  transaction.needsReview = false;
  return repo.save(transaction);
}

export type CardReviewOutcome = {
  /** Now in the state asked for, whether or not they were already. */
  done: string[];
  skipped: Array<{ id: string; reason: string }>;
};

/**
 * Mark card purchases reviewed, keeping their categories, or send them back
 * to review. Only the flag changes: their books stay exactly as they are. A
 * purchase not yet in the books waits in To review anyway, so it can't be
 * marked reviewed until it is. An id that is not this company's card
 * transaction, or is a card bill payment, is skipped with a reason rather
 * than failing the rest.
 */
export async function setCardTransactionsReview(
  companyId: string,
  ids: string[],
  needsReview: boolean,
): Promise<CardReviewOutcome> {
  const requested = [...new Set(ids)];
  if (requested.length === 0) return { done: [], skipped: [] };
  const repo = AppDataSource.getRepository(CardTransaction);
  const found = await repo.findBy({ companyId, id: In(requested) });
  const byId = new Map(found.map((transaction) => [transaction.id, transaction]));
  const done: string[] = [];
  const changed: string[] = [];
  const skipped: CardReviewOutcome["skipped"] = [];
  for (const id of requested) {
    const transaction = byId.get(id);
    if (!transaction) {
      skipped.push({ id, reason: "Transaction not found" });
    } else if (transaction.accountingKind === "payment") {
      skipped.push({ id, reason: "A card bill payment has no category to review" });
    } else if (!transaction.ledgerEntryId) {
      if (needsReview) done.push(id);
      else skipped.push({ id, reason: "It isn't in your books yet, so retry it first" });
    } else {
      done.push(id);
      if (transaction.needsReview !== needsReview) changed.push(id);
    }
  }
  // A partial `save` rather than a bulk UPDATE: the live-sync subscriber
  // needs each row to tell open pages to refetch.
  if (changed.length > 0) {
    await repo.save(changed.map((id) => ({ id, needsReview })));
  }
  return { done, skipped };
}

export async function loadCardFeed(companyId: string, feedId: string): Promise<CardFeed | null> {
  return AppDataSource.getRepository(CardFeed).findOneBy({
    id: feedId,
    companyId,
  });
}

/**
 * The newest card transactions, optionally on one card. `review` holds the
 * ones waiting for someone to look at their category, and the ones whose
 * posting failed; `done` the reviewed ones in the books.
 */
export async function listCardTransactions(
  companyId: string,
  feedId?: string,
  status?: "review" | "done",
): Promise<CardTransaction[]> {
  const base: FindOptionsWhere<CardTransaction> = { companyId };
  if (feedId) base.feedId = feedId;
  const where: FindOptionsWhere<CardTransaction>[] =
    status === "review"
      ? [
          { ...base, ledgerEntryId: IsNull() },
          { ...base, needsReview: true },
        ]
      : status === "done"
        ? [{ ...base, ledgerEntryId: Not(IsNull()), needsReview: false }]
        : [base];
  return AppDataSource.getRepository(CardTransaction).find({
    where,
    order: { postedAt: "DESC", createdAt: "DESC" },
    take: 500,
  });
}

/** A card with purchases in the books stays: they are part of the audit trail. */
export class CardFeedInUseError extends Error {
  constructor() {
    super(
      "A synced card feed cannot be deleted because its ledger entries are part of the accounting audit trail",
    );
    this.name = "CardFeedInUseError";
  }
}

export async function deleteEmptyCardFeed(feed: CardFeed): Promise<void> {
  const count = await AppDataSource.getRepository(CardTransaction).count({
    where: { feedId: feed.id },
  });
  if (count > 0) throw new CardFeedInUseError();
  await AppDataSource.getRepository(CardFeed).delete({ id: feed.id });
}
