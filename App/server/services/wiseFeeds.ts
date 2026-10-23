import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  activeWiseProfiles,
  describeWiseTransaction,
  getWiseBalanceStatement,
  listWiseBalances,
  listWiseProfiles,
  type WiseBalance,
  type WiseConfig,
  type WiseStatementTransaction,
  wiseAmountCents,
  wiseProfileName,
  wiseTransactionKey,
} from "../integrations/providers/wise.js";
import { FeedSyncError, withProviderRetry } from "./feedSyncErrors.js";
import { getFinanceSettings } from "./fx.js";
import { decryptConnectionConfig } from "./integrations.js";

/**
 * Wise balances as Banking accounts. A `wise_balance` feed is one balance —
 * one currency on one Wise profile — named on the feed as
 * `<profileId>:<balanceId>`, and its transactions come from that balance's
 * statement.
 *
 * Bank transactions are in the company's home currency and reach the books
 * without conversion (`categorizeBankTransaction`, `payInvoicesFromBankTransaction`),
 * so only a balance in the home currency can be added: a EUR balance read as
 * dollars would put the wrong amount in the books. Wise keeps one balance per
 * currency, so the company's other balances are listed but not offered.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Each statement request covers at most a year; Wise allows 469 days. */
const STATEMENT_WINDOW_MS = 365 * DAY_MS;
/**
 * How far before the last update the next one looks again. Wise dates a line
 * by when the transaction was created, not when it reached the balance, so
 * one that reaches the balance days later can land behind the last update.
 * Line keys make the second look free of duplicates.
 */
const SYNC_OVERLAP_MS = 30 * DAY_MS;
/** Where a history walk starts when Wise doesn't say when a balance opened. */
const WISE_LAUNCH = new Date("2011-01-01T00:00:00.000Z");

export type WiseBalanceChoice = {
  /** What a feed stores in `externalAccountId`. */
  id: string;
  profileName: string;
  profileType: string;
  currency: string;
  /** Available to spend, in hundredths of the balance's currency. */
  availableCents: number | null;
  /** Why this balance can't be added to Banking, short enough to sit beside
   *  it in the picker, or null when it can. */
  unavailableReason: string | null;
};

export function wiseBalanceRef(profileId: string | number, balanceId: string | number): string {
  return `${profileId}:${balanceId}`;
}

export function parseWiseBalanceRef(
  ref: string | null | undefined,
): { profileId: string; balanceId: string } | null {
  const match = /^(\d+):(\d+)$/.exec(ref ?? "");
  return match ? { profileId: match[1], balanceId: match[2] } : null;
}

async function getWiseConfig(companyId: string, connectionId: string): Promise<WiseConfig> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
    companyId,
    provider: "wise",
  });
  if (!connection) throw new FeedSyncError("connection_missing", "Wise Connection not found");
  let config: Partial<WiseConfig>;
  try {
    config = decryptConnectionConfig(connection) as Partial<WiseConfig>;
  } catch (err) {
    throw new FeedSyncError("credentials", (err as Error).message);
  }
  if (!config.apiToken || typeof config.apiToken !== "string") {
    throw new FeedSyncError("credentials", "Wise Connection is missing its API token");
  }
  return { apiToken: config.apiToken };
}

function otherCurrency(currency: string, homeCurrency: string): string {
  return `This balance is in ${currency} and your books are in ${homeCurrency}. Banking brings in ${homeCurrency} balances only.`;
}

/**
 * Every balance the Connection's token can read, business profiles first, each
 * saying why it can't be added when it can't. Account details never leave
 * Wise: the picker needs the profile, the currency, and what is in it.
 */
export async function listWiseBalancesForConnection(
  companyId: string,
  connectionId: string,
): Promise<WiseBalanceChoice[]> {
  const config = await getWiseConfig(companyId, connectionId);
  const [{ homeCurrency }, profiles, feeds] = await Promise.all([
    getFinanceSettings(companyId),
    listWiseProfiles(config.apiToken),
    AppDataSource.getRepository(BankFeed).find({ where: { companyId, kind: "wise_balance" } }),
  ]);
  const onBanking = new Map(feeds.map((feed) => [feed.externalAccountId, feed.name]));
  const isBusiness = (type: string) => (type?.toUpperCase() === "BUSINESS" ? 1 : 0);
  const ordered = activeWiseProfiles(profiles).sort((a, b) => isBusiness(b.type) - isBusiness(a.type));
  const choices: WiseBalanceChoice[] = [];
  for (const profile of ordered) {
    for (const balance of await listWiseBalances(config.apiToken, profile.id)) {
      const id = wiseBalanceRef(profile.id, balance.id);
      const feedName = onBanking.get(id);
      choices.push({
        id,
        profileName: wiseProfileName(profile),
        profileType: profile.type,
        currency: balance.currency,
        availableCents: wiseAmountCents(balance.amount?.value),
        unavailableReason:
          feedName !== undefined
            ? `Already on Banking as “${feedName}”`
            : balance.currency === homeCurrency
              ? null
              : `Your books are in ${homeCurrency}`,
      });
    }
  }
  return choices;
}

async function findWiseBalance(
  config: WiseConfig,
  ref: { profileId: string; balanceId: string },
): Promise<WiseBalance | null> {
  const balances = await withProviderRetry(() => listWiseBalances(config.apiToken, ref.profileId));
  return balances.find((balance) => String(balance.id) === ref.balanceId) ?? null;
}

/**
 * Check a balance can become a Banking account before the feed is saved: the
 * Connection's token reads it, it is in the home currency, it isn't on
 * Banking already, and Wise releases its statement — the last is where a
 * profile outside the regions Wise serves statements to fails, now rather
 * than on the first update.
 */
export async function assertWiseBalanceFeed(
  companyId: string,
  connectionId: string,
  externalAccountId: string,
  now = new Date(),
  options: {
    /** The feed being pointed at another Connection, which is on Banking already. */
    exceptFeedId?: string;
  } = {},
): Promise<void> {
  const ref = parseWiseBalanceRef(externalAccountId);
  if (!ref) throw new Error("Choose a Wise balance");
  const config = await getWiseConfig(companyId, connectionId);
  const balance = await findWiseBalance(config, ref);
  if (!balance) throw new Error("That balance isn't on this Wise Connection");
  const { homeCurrency } = await getFinanceSettings(companyId);
  if (balance.currency !== homeCurrency) throw new Error(otherCurrency(balance.currency, homeCurrency));
  const existing = await AppDataSource.getRepository(BankFeed).findOneBy({
    companyId,
    kind: "wise_balance",
    externalAccountId,
  });
  if (existing && existing.id !== options.exceptFeedId) {
    throw new Error(`This Wise balance is already on Banking as “${existing.name}”.`);
  }
  await getWiseBalanceStatement(config.apiToken, ref.profileId, ref.balanceId, {
    currency: balance.currency,
    intervalStart: new Date(now.getTime() - DAY_MS),
    intervalEnd: now,
  });
}

type WiseBankLine = {
  externalId: string;
  date: Date;
  amountCents: number;
  description: string;
  reference: string;
};

/** A statement line as a bank transaction, or null for one that moved no money. */
function bankLine(transaction: WiseStatementTransaction, currency: string): WiseBankLine | null {
  const label = transaction.referenceNumber?.trim() || "without a reference number";
  const amountCents = wiseAmountCents(transaction.amount?.value);
  if (amountCents === null) {
    throw new FeedSyncError("bad_data", `Wise transaction ${label} has no usable amount`);
  }
  const lineCurrency = (transaction.amount.currency ?? "").toUpperCase();
  if (lineCurrency !== currency) {
    throw new FeedSyncError(
      "bad_data",
      `Wise transaction ${label} is in ${lineCurrency || "no currency"}, not ${currency}`,
    );
  }
  const date = new Date(transaction.date);
  if (Number.isNaN(date.getTime())) {
    throw new FeedSyncError("bad_data", `Wise transaction ${label} has an invalid date`);
  }
  if (amountCents === 0) return null;
  return {
    externalId: wiseTransactionKey(transaction, date, amountCents),
    date,
    amountCents,
    description: describeWiseTransaction(transaction),
    reference: transaction.referenceNumber?.trim() ?? "",
  };
}

/**
 * Bring in a Wise balance's transactions. The first update walks the whole
 * statement history, a year per request from the day the balance opened;
 * later ones look again from 30 days before the last. Every line is keyed
 * (`wiseTransactionKey`), so looking twice never adds a line twice, and an
 * update that fails halfway leaves `lastSyncAt` alone so the next one starts
 * over from the same place.
 */
export async function syncWiseBalanceFeed(feed: BankFeed, now = new Date()): Promise<number> {
  if (feed.kind !== "wise_balance") throw new Error("Feed is not a Wise balance feed");
  if (!feed.connectionId) {
    throw new FeedSyncError("connection_missing", "Wise feed has no Connection — pick one first");
  }
  const ref = parseWiseBalanceRef(feed.externalAccountId);
  if (!ref) throw new FeedSyncError("account_missing", "Wise feed has no balance — pick one first");
  const config = await getWiseConfig(feed.companyId, feed.connectionId);
  const balance = await findWiseBalance(config, ref);
  if (!balance) {
    throw new FeedSyncError(
      "account_missing",
      "This Wise balance is no longer on the Connection — it may have been closed.",
    );
  }
  const { homeCurrency } = await getFinanceSettings(feed.companyId);
  if (balance.currency !== homeCurrency) {
    throw new FeedSyncError("unsupported", otherCurrency(balance.currency, homeCurrency));
  }

  const transactionRepo = AppDataSource.getRepository(BankTransaction);
  const existing = await transactionRepo.find({ where: { feedId: feed.id }, select: ["externalId"] });
  const seen = new Set(existing.map((row) => row.externalId).filter((id): id is string => !!id));
  const opened = balance.creationTime ? new Date(balance.creationTime) : WISE_LAUNCH;
  const from = feed.lastSyncAt
    ? new Date(feed.lastSyncAt.getTime() - SYNC_OVERLAP_MS)
    : Number.isNaN(opened.getTime())
      ? WISE_LAUNCH
      : opened;

  let inserted = 0;
  for (let start = from; start.getTime() < now.getTime(); ) {
    const end = new Date(Math.min(start.getTime() + STATEMENT_WINDOW_MS, now.getTime()));
    const statement = await withProviderRetry(() =>
      getWiseBalanceStatement(config.apiToken, ref.profileId, ref.balanceId, {
        currency: balance.currency,
        intervalStart: start,
        intervalEnd: end,
      }),
    );
    const fresh: BankTransaction[] = [];
    for (const transaction of statement.transactions) {
      const line = bankLine(transaction, balance.currency);
      if (!line || seen.has(line.externalId)) continue;
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
    start = end;
  }

  // Only the cursor and the balance: a `save` of this copy would write every
  // column it loaded back over the sync status kept on the same row.
  const values: Partial<BankFeed> = { lastSyncAt: now };
  const availableCents = wiseAmountCents(balance.amount?.value);
  if (availableCents !== null) {
    values.balanceCents = availableCents;
    values.balanceCurrency = balance.currency;
    values.balanceAt = now;
  }
  await AppDataSource.getRepository(BankFeed).update(
    { id: feed.id, companyId: feed.companyId },
    values,
  );
  Object.assign(feed, values);
  return inserted;
}
