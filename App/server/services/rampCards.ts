import { AppDataSource } from "../db/datasource.js";
import type { CardFeed } from "../db/entities/CardFeed.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import {
  describeRampTransaction,
  getRampCashbacksPage,
  getRampTransactionsPage,
  getRampTransfersPage,
  type RampCashback,
  type RampConfig,
  type RampCurrencyAmount,
  type RampPage,
  type RampPageOptions,
  rampMinorToCents,
  rampNextCursor,
  type RampTransaction,
  rampTransactionAmount,
  type RampTransfer,
} from "../integrations/providers/ramp.js";
import type { IncomingCardTransaction, ListedCardTransaction } from "./cardExpenses.js";
import { FeedSyncError, withProviderRetry } from "./feedSyncErrors.js";
import { decryptConnectionConfig } from "./integrations.js";

/**
 * A Ramp card on Banking. Ramp keeps a card balance's activity in three lists,
 * and a card reads all of them — the three kinds of line on a Ramp statement:
 *
 *   - settled card transactions (`/transactions`, state `CLEARED`): purchases,
 *     and refunds as negative amounts;
 *   - transfer payments (`/transfers`, status `COMPLETED`): the payments from
 *     the business's bank account that settle the Ramp bill;
 *   - cashback (`/cashbacks`): what Ramp credited back to the card balance.
 *
 * Each becomes a `CardTransaction` on the card, and the books treat them as a
 * Brex card's: a purchase is filed under the card's default category and waits
 * for review, a refund — and cashback, a credit against the same spending —
 * comes back under that category, and a bill payment moves what is owed on
 * the card against the bank account. Leaving cashback out would leave the
 * card owing more in the books than Ramp says it does.
 *
 * Transfers and cashback are keyed `transfer:<id>` and `cashback:<id>`, so
 * their ids can never meet a card transaction's on the same card.
 */

/** Ramp's state for a card transaction that has settled. */
const SETTLED = "CLEARED";
/** Ramp's status for a bill payment that reached Ramp. */
const PAID = "COMPLETED";
/**
 * How far before the last sync the next one asks Ramp again. Ramp's date
 * filter reads when the card was used, not when the purchase settled, and a
 * hotel or car rental can settle weeks after the card was used — so a card
 * looks back a month, not the week a Brex card does. Ramp's ids keep the
 * second look free of duplicates.
 */
export const RAMP_SYNC_OVERLAP_MS = 30 * 24 * 60 * 60 * 1000;
/** A backstop against a page loop that never ends. */
const MAX_PAGES = 10_000;

async function getRampConfig(companyId: string, connectionId: string): Promise<RampConfig> {
  const connection = await AppDataSource.getRepository(IntegrationConnection).findOneBy({
    id: connectionId,
    companyId,
    provider: "ramp",
  });
  if (!connection) throw new FeedSyncError("connection_missing", "Ramp Connection not found");
  let config: Partial<RampConfig>;
  try {
    config = decryptConnectionConfig(connection) as Partial<RampConfig>;
  } catch (err) {
    throw new FeedSyncError("credentials", (err as Error).message);
  }
  if (!config.clientId || typeof config.clientId !== "string") {
    throw new FeedSyncError("credentials", "Ramp Connection is missing its client ID");
  }
  if (!config.clientSecret || typeof config.clientSecret !== "string") {
    throw new FeedSyncError("credentials", "Ramp Connection is missing its client secret");
  }
  return { clientId: config.clientId, clientSecret: config.clientSecret };
}

/** Check a Ramp Connection can read everything a Ramp card syncs. */
export async function assertRampCardConnection(
  companyId: string,
  connectionId: string,
): Promise<void> {
  const config = await getRampConfig(companyId, connectionId);
  try {
    await getRampTransactionsPage(config, { pageSize: 2 });
    await getRampTransfersPage(config, { pageSize: 2 });
    await getRampCashbacksPage(config, { pageSize: 2 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      "Ramp card access failed. Allow transactions:read, transfers:read and cashbacks:read on the Ramp app. " +
        message,
    );
  }
}

function parseDate(value: string | null | undefined, what: string): Date {
  const date = value
    ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value)
    : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new FeedSyncError("bad_data", `${what} has an invalid date`);
  }
  return date;
}

/** A positive amount in hundredths, and its currency, from one of Ramp's minor-unit amounts. */
function magnitude(amount: RampCurrencyAmount | null | undefined, what: string) {
  const cents = rampMinorToCents(amount?.amount, amount?.minor_unit_conversion_rate);
  if (cents === null || cents === 0) {
    throw new FeedSyncError("bad_data", `${what} has no usable amount`);
  }
  return { cents: Math.abs(cents), currency: (amount?.currency_code ?? "USD").toUpperCase() };
}

/** A settled card transaction in Banking's terms: a purchase positive, a refund negative. */
function readRampTransaction(remote: RampTransaction): IncomingCardTransaction {
  const label = `Ramp card transaction ${remote.id}`;
  const amount = rampTransactionAmount(remote);
  if (!amount || amount.cents === 0) {
    throw new FeedSyncError("bad_data", `${label} has no usable amount`);
  }
  return {
    cardId: remote.card_id ?? null,
    postedAt: parseDate(remote.settlement_date || remote.user_transaction_time, label),
    amountCents: amount.cents,
    currency: amount.currency,
    description: describeRampTransaction(remote),
    providerType: remote.original_transaction_id ? "REFUND" : "TRANSACTION",
    accountingKind: amount.cents < 0 ? "refund" : "expense",
    raw: remote,
  };
}

/** A payment of the Ramp bill, which lowers what is owed on the card. */
function readRampTransfer(remote: RampTransfer): IncomingCardTransaction {
  const label = `Ramp bill payment ${remote.id}`;
  const amount = magnitude(remote.amount, label);
  return {
    cardId: null,
    postedAt: parseDate(remote.created_at, label),
    // Brex's convention: a payment against the card is negative.
    amountCents: -amount.cents,
    currency: amount.currency,
    description: "Ramp bill payment",
    providerType: "TRANSFER",
    accountingKind: "payment",
    raw: remote,
  };
}

/** Cashback credited to the card balance, which comes back like a refund. */
function readRampCashback(remote: RampCashback): IncomingCardTransaction {
  const label = `Ramp cashback ${remote.id}`;
  const amount = magnitude(remote.amount, label);
  return {
    cardId: null,
    postedAt: parseDate(remote.created_at, label),
    amountCents: -amount.cents,
    currency: amount.currency,
    description: "Ramp cashback",
    providerType: "CASHBACK",
    accountingKind: "refund",
    raw: remote,
  };
}

/** Walk one of Ramp's lists from the first page to the last, following its cursors. */
async function* walk<T>(
  what: string,
  fetchPage: (start: string | undefined) => Promise<RampPage<T>>,
): AsyncIterable<T[]> {
  const seenCursors = new Set<string>();
  let start: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await withProviderRetry(() => fetchPage(start));
    yield batch.data;
    const next = rampNextCursor(batch);
    if (!next) return;
    if (seenCursors.has(next)) {
      throw new FeedSyncError("bad_data", `Ramp returned a repeated ${what} cursor`);
    }
    seenCursors.add(next);
    start = next;
  }
  throw new FeedSyncError("bad_data", `Ramp kept returning ${what} pages`);
}

/**
 * Every settled transaction, bill payment and cashback on a Ramp card since
 * `postedAtStart` (its whole history without one), a page at a time.
 */
export async function* rampCardPages(
  feed: CardFeed,
  postedAtStart: Date | undefined,
): AsyncIterable<ListedCardTransaction[]> {
  const config = await getRampConfig(feed.companyId, feed.connectionId);
  const since: RampPageOptions = { fromDate: postedAtStart };

  for await (const page of walk("transaction", (start) =>
    getRampTransactionsPage(config, { ...since, start, state: SETTLED }),
  )) {
    yield page
      .filter((remote) => (remote.state ?? SETTLED).toUpperCase() === SETTLED)
      .map((remote) => ({ externalId: remote.id, read: () => readRampTransaction(remote) }));
  }

  for await (const page of walk("payment", (start) =>
    getRampTransfersPage(config, { ...since, start, status: PAID }),
  )) {
    yield page
      .filter((remote) => (remote.status ?? PAID).toUpperCase() === PAID)
      .map((remote) => ({
        externalId: `transfer:${remote.id}`,
        read: () => readRampTransfer(remote),
      }));
  }

  for await (const page of walk("cashback", (start) =>
    getRampCashbacksPage(config, { ...since, start }),
  )) {
    yield page.map((remote) => ({
      externalId: `cashback:${remote.id}`,
      read: () => readRampCashback(remote),
    }));
  }
}
