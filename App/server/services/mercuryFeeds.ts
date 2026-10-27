import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  describeMercuryTransaction,
  getMercuryTransactionsPage,
  isMercuryOwnAccount,
  isOpenMercuryAccount,
  listMercuryAccounts,
  type MercuryAccount,
  type MercuryConfig,
  type MercuryTransaction,
  type MercuryTransactionsPage,
  mercuryAccountName,
  mercuryAmountCents,
  mercuryLast4,
} from "../integrations/providers/mercury.js";
import { FeedSyncError, withProviderRetry } from "./feedSyncErrors.js";
import { getFinanceSettings } from "./fx.js";
import { decryptConnectionConfig } from "./integrations.js";

/**
 * Mercury accounts as Banking accounts. A `mercury_account` feed is one
 * account at Mercury — checking or savings — named on the feed by Mercury's
 * account id, and its transactions come from Mercury's transaction list,
 * narrowed to that account.
 *
 * Bank transactions are in the company's home currency and reach the books
 * without conversion, and a Mercury account holds US dollars, so one can be
 * added only to books kept in USD. Only settled transactions come in: Mercury
 * calls them `sent`, and a pending one can still change or fail.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Mercury accounts hold US dollars. */
const MERCURY_CURRENCY = "USD";
/**
 * How far before the last update the next one looks again, by the date a
 * transaction posted — a week, as for every bank account
 * (`BANK_SYNC_OVERLAP_MS`), so one that posts late still comes in. Mercury's
 * ids keep the second look free of duplicates.
 */
const SYNC_OVERLAP_MS = 7 * DAY_MS;
/** A backstop against a page loop that never ends. */
const MAX_PAGES = 10_000;

/** One account a Mercury Connection can read, as the Add account picker lists it. */
export type MercuryAccountChoice = {
  /** What a feed stores in `externalAccountId`. */
  id: string;
  name: string;
  /** `checking`, `savings`, … as Mercury says it. */
  kind: string | null;
  accountNumberLast4: string | null;
  /** In cents, as Mercury last reported it. */
  currentCents: number | null;
  availableCents: number | null;
  /** Why this account can't be added to Banking, short enough to sit beside
   *  it in the picker, or null when it can. */
  unavailableReason: string | null;
};

async function getMercuryConfig(companyId: string, connectionId: string): Promise<MercuryConfig> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
    companyId,
    provider: "mercury",
  });
  if (!connection) throw new FeedSyncError("connection_missing", "Mercury Connection not found");
  let config: Partial<MercuryConfig>;
  try {
    config = decryptConnectionConfig(connection) as Partial<MercuryConfig>;
  } catch (err) {
    throw new FeedSyncError("credentials", (err as Error).message);
  }
  if (!config.apiToken || typeof config.apiToken !== "string") {
    throw new FeedSyncError("credentials", "Mercury Connection is missing its API token");
  }
  return { apiToken: config.apiToken };
}

function otherCurrency(homeCurrency: string): string {
  return `Mercury accounts are in USD and your books are in ${homeCurrency}. Banking brings in ${homeCurrency} accounts only.`;
}

/**
 * Every account at Mercury the Connection's token can read, each saying why it
 * can't be added when it can't. Account and routing numbers never leave
 * Mercury: the picker needs the name, the last four digits, and the balance.
 */
export async function listMercuryAccountsForConnection(
  companyId: string,
  connectionId: string,
): Promise<MercuryAccountChoice[]> {
  const config = await getMercuryConfig(companyId, connectionId);
  const [{ homeCurrency }, accounts, feeds] = await Promise.all([
    getFinanceSettings(companyId),
    listMercuryAccounts(config.apiToken),
    AppDataSource.getRepository(BankFeed).find({ where: { companyId, kind: "mercury_account" } }),
  ]);
  const onBanking = new Map(feeds.map((feed) => [feed.externalAccountId, feed.name]));
  // Open accounts first, in the order Mercury lists them.
  const ordered = accounts
    .filter(isMercuryOwnAccount)
    .sort((a, b) => Number(isOpenMercuryAccount(b)) - Number(isOpenMercuryAccount(a)));
  return ordered.map((account) => {
    const feedName = onBanking.get(account.id);
    return {
      id: account.id,
      name: mercuryAccountName(account),
      kind: account.kind ?? null,
      accountNumberLast4: mercuryLast4(account),
      currentCents: mercuryAmountCents(account.currentBalance),
      availableCents: mercuryAmountCents(account.availableBalance),
      unavailableReason:
        feedName !== undefined
          ? `Already on Banking as “${feedName}”`
          : !isOpenMercuryAccount(account)
            ? "Closed in Mercury"
            : homeCurrency === MERCURY_CURRENCY
              ? null
              : `Your books are in ${homeCurrency}`,
    };
  });
}

async function findMercuryAccount(
  config: MercuryConfig,
  accountId: string,
): Promise<MercuryAccount | null> {
  const accounts = await withProviderRetry(() => listMercuryAccounts(config.apiToken));
  return accounts.find((account) => account.id === accountId && isMercuryOwnAccount(account)) ?? null;
}

/**
 * Check an account can become a Banking account before the feed is saved: the
 * Connection's token reads it and its transactions, it is open, the books are
 * in USD, and it isn't on Banking already.
 */
export async function assertMercuryAccountFeed(
  companyId: string,
  connectionId: string,
  externalAccountId: string,
  options: {
    /** The feed being pointed at another Connection, which is on Banking already. */
    exceptFeedId?: string;
  } = {},
): Promise<void> {
  const accountId = externalAccountId.trim();
  if (!accountId) throw new Error("Choose a Mercury account");
  const config = await getMercuryConfig(companyId, connectionId);
  const account = await findMercuryAccount(config, accountId);
  if (!account) throw new Error("That account isn't on this Mercury Connection");
  if (!isOpenMercuryAccount(account)) throw new Error("That Mercury account is closed");
  const { homeCurrency } = await getFinanceSettings(companyId);
  if (homeCurrency !== MERCURY_CURRENCY) throw new Error(otherCurrency(homeCurrency));
  const existing = await AppDataSource.getRepository(BankFeed).findOneBy({
    companyId,
    kind: "mercury_account",
    externalAccountId: accountId,
  });
  if (existing && existing.id !== options.exceptFeedId) {
    throw new Error(`This Mercury account is already on Banking as “${existing.name}”.`);
  }
  await getMercuryTransactionsPage(config.apiToken, { accountId, limit: 1 });
}

type MercuryBankLine = {
  externalId: string;
  date: Date;
  amountCents: number;
  description: string;
  reference: string;
};

/**
 * A settled transaction as a bank transaction, or null for one that hasn't
 * settled or moved no money.
 */
function bankLine(transaction: MercuryTransaction): MercuryBankLine | null {
  if ((transaction.status ?? "").toLowerCase() !== "sent") return null;
  const amountCents = mercuryAmountCents(transaction.amount);
  if (amountCents === null) {
    throw new FeedSyncError("bad_data", `Mercury transaction ${transaction.id} has no usable amount`);
  }
  // Settled is when it reached the account, which is the date the bank shows.
  const date = new Date(transaction.postedAt || transaction.createdAt);
  if (Number.isNaN(date.getTime())) {
    throw new FeedSyncError("bad_data", `Mercury transaction ${transaction.id} has an invalid date`);
  }
  if (amountCents === 0) return null;
  const description = describeMercuryTransaction(transaction);
  return {
    externalId: transaction.id,
    date,
    amountCents,
    description,
    // What the bank and the payer wrote, which can name an invoice the
    // counterparty's name alone doesn't.
    reference: [transaction.bankDescription, transaction.externalMemo]
      .map((part) => part?.trim() ?? "")
      .filter((part) => part && part !== description)
      .join(" · "),
  };
}

/**
 * Bring in a Mercury account's settled transactions. The first update walks
 * the whole history — Mercury reads from the first transaction when not told
 * otherwise — and later ones ask for what posted since a week before the
 * last, however long ago that was. Every transaction is keyed by Mercury's
 * id, so looking twice never adds one twice, and an update that fails halfway
 * leaves `lastSyncAt` alone so the next one starts over from the same place.
 */
export async function syncMercuryAccountFeed(feed: BankFeed, now = new Date()): Promise<number> {
  if (feed.kind !== "mercury_account") throw new Error("Feed is not a Mercury account feed");
  if (!feed.connectionId) {
    throw new FeedSyncError("connection_missing", "Mercury feed has no Connection — pick one first");
  }
  const accountId = feed.externalAccountId;
  if (!accountId) {
    throw new FeedSyncError("account_missing", "Mercury feed has no account — pick one first");
  }
  const config = await getMercuryConfig(feed.companyId, feed.connectionId);
  const account = await findMercuryAccount(config, accountId);
  if (!account) {
    throw new FeedSyncError(
      "account_missing",
      "This Mercury account is no longer on the Connection — it may have been closed.",
    );
  }
  const { homeCurrency } = await getFinanceSettings(feed.companyId);
  if (homeCurrency !== MERCURY_CURRENCY) {
    throw new FeedSyncError("unsupported", otherCurrency(homeCurrency));
  }

  const transactionRepo = AppDataSource.getRepository(BankTransaction);
  const existing = await transactionRepo.find({ where: { feedId: feed.id }, select: ["externalId"] });
  const seen = new Set(existing.map((row) => row.externalId).filter((id): id is string => !!id));
  const postedStart = feed.lastSyncAt
    ? new Date(feed.lastSyncAt.getTime() - SYNC_OVERLAP_MS).toISOString()
    : undefined;

  let inserted = 0;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      throw new FeedSyncError("bad_data", "Mercury kept returning transaction pages past the end");
    }
    const batch: MercuryTransactionsPage = await withProviderRetry(() =>
      getMercuryTransactionsPage(config.apiToken, {
        accountId,
        statuses: ["sent"],
        postedStart,
        order: "asc",
        cursor,
      }),
    );
    const fresh: BankTransaction[] = [];
    for (const transaction of batch.transactions) {
      if (seen.has(transaction.id)) continue;
      // The list is narrowed to this account; one from another is never its line.
      if (transaction.accountId && transaction.accountId !== accountId) continue;
      const line = bankLine(transaction);
      if (!line) continue;
      seen.add(line.externalId);
      fresh.push(
        transactionRepo.create({
          companyId: feed.companyId,
          feedId: feed.id,
          externalId: line.externalId,
          date: line.date,
          amountCents: line.amountCents,
          description: line.description,
          reference: line.reference,
          raw: JSON.stringify(transaction),
        }),
      );
    }
    if (fresh.length > 0) {
      await transactionRepo.save(fresh);
      inserted += fresh.length;
    }
    const next = batch.nextCursor;
    if (!next) break;
    if (seenCursors.has(next)) {
      throw new FeedSyncError("bad_data", "Mercury returned a repeated transaction cursor");
    }
    seenCursors.add(next);
    cursor = next;
  }

  // Only the cursor and the balance: a `save` of this copy would write every
  // column it loaded back over the sync status kept on the same row.
  const values: Partial<BankFeed> = { lastSyncAt: now };
  const currentCents = mercuryAmountCents(account.currentBalance);
  if (currentCents !== null) {
    values.balanceCents = currentCents;
    values.balanceCurrency = MERCURY_CURRENCY;
    values.balanceAt = now;
  }
  await AppDataSource.getRepository(BankFeed).update(
    { id: feed.id, companyId: feed.companyId },
    values,
  );
  Object.assign(feed, values);
  return inserted;
}
