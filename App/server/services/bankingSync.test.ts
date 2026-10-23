import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import cron from "node-cron";

import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Customer } from "../db/entities/Customer.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { InvoicePayment } from "../db/entities/InvoicePayment.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import type { BrexCardTransaction, BrexCashTransaction } from "../integrations/providers/brex.js";
import { WISE_API_VERSION } from "../integrations/providers/wise.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { listBankingAccounts } from "./banking.js";
import {
  bootBankingSync,
  dueFeeds,
  feedSyncStatus,
  FeedNotFoundError,
  isFeedSyncDue,
  retryDelayMs,
  runBankingSyncTick,
  setSyncRequestWaitForTests,
  stopBankingSync,
  syncDueFeeds,
  syncFeed,
  syncFeedForRequest,
  syncResponse,
  whileFeedIdle,
  type BankingSyncDependencies,
  type FeedRef,
} from "./bankingSync.js";
import { createInvoiceDraft, issueInvoice } from "./finance.js";
import { FeedSyncError, setProviderRetrySleepForTests } from "./feedSyncErrors.js";
import { encryptConnectionConfig } from "./integrations.js";
import { recordInvoicePayment } from "./invoicePayments.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { BANK_SYNC_OVERLAP_MS } from "./reconcile.js";
import {
  registerResourceChangeSink,
  registerRoutineTriggerSink,
} from "./resourceEvents.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";

/**
 * Banking's background sync: which accounts it picks up and which it leaves
 * alone, that no account is ever synced twice at once, that one account
 * failing never stops the others, what it records about each attempt — and
 * the regression behind it, an account added in July that nothing synced
 * again, which now catches up on everything posted since by itself.
 *
 * Brex, Stripe and Wise are answered by stand-ins on `fetch`; no request
 * leaves the process.
 */

before(async () => {
  await initTestDb();
  // Live sync, as `initDb` wires it, so a test can see what a sync announces.
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
});
beforeEach(async () => {
  await resetTestDb();
  overrideRuntimeSettingsForTests(null);
  setProviderRetrySleepForTests(async () => undefined);
  setSyncRequestWaitForTests(null);
});
afterEach(() => {
  for (const open of [...shutGates]) open();
  globalThis.fetch = originalFetch;
  setProviderRetrySleepForTests(null);
  setSyncRequestWaitForTests(null);
  overrideRuntimeSettingsForTests(null);
});
after(async () => {
  stopBankingSync();
  await closeTestDb();
});

const originalFetch = globalThis.fetch;
const CO = "co_banking_sync";
const OTHER = "co_banking_sync_other";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BREX_TOKEN = "bxt_test_token";
const STRIPE_KEY = "sk_test_banking";
const WISE_TOKEN = "wise-token-banking";

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Gates a test left shut, opened after it so nothing waits on one for good. */
const shutGates = new Set<() => void>();

/**
 * A promise the test opens when it is ready for the work behind it to go on.
 *
 * While it is shut it keeps the event loop running, as the provider request
 * it stands in for would with its socket. Work waiting on a bare promise holds
 * nothing, so a test whose only other timer is Sync now's wait — unref'd, so
 * it never keeps a server up by itself — left Node an idle process, and
 * node:test cancelled the waiting test and every test after it.
 */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    const running = setInterval(() => undefined, MINUTE);
    open = () => {
      clearInterval(running);
      shutGates.delete(open);
      resolve();
    };
  });
  shutGates.add(open);
  return { opened, open };
}

// ─────────────────────────── stand-in providers ───────────────────────────

type BrexWorld = {
  cashAccounts: Array<{ id: string; balance: number }>;
  /** Newest first, as Brex lists them. */
  cash: Record<string, BrexCashTransaction[]>;
  card: BrexCardTransaction[];
  pageSize: number;
  /** Answer a request some other way — a failure, say. */
  override?: (url: URL) => Response | null;
};

type StripeWorld = {
  payouts: Array<{ id: string; amount: number; arrival_date: number; created: number }>;
  pageSize: number;
  override?: (url: URL) => Response | null;
};

type WiseWorld = {
  lines: Array<{ ref: string; date: Date; value: number }>;
  override?: (url: URL) => Response | null;
};

type Recorded = { url: URL; authorization: string | null };

function page<T extends { id: string }>(items: T[], url: URL, size: number) {
  const start = Number(url.searchParams.get("cursor") ?? "0");
  const slice = items.slice(start, start + size);
  const next = start + size < items.length ? String(start + size) : null;
  return { items: slice, next_cursor: next };
}

function postedSince<T extends { posted_at_date: string }>(items: T[], url: URL): T[] {
  const from = url.searchParams.get("posted_at_start");
  return from ? items.filter((item) => Date.parse(item.posted_at_date) >= Date.parse(from)) : items;
}

/** Stand in for api.brex.com, api.stripe.com and api.wise.com, recording every request. */
function installProviders(worlds: { brex?: BrexWorld; stripe?: StripeWorld; wise?: WiseWorld }) {
  const requests: Recorded[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.hostname === "api.brex.com" && worlds.brex) {
      const brex = worlds.brex;
      const overridden = brex.override?.(url);
      if (overridden) return overridden;
      if (url.pathname === "/v2/accounts/cash") {
        return respond({
          items: brex.cashAccounts.map((account, index) => ({
            id: account.id,
            name: `Cash ${index + 1}`,
            status: "ACTIVE",
            current_balance: { amount: account.balance, currency: "USD" },
            available_balance: { amount: account.balance, currency: "USD" },
            account_number: "000123456789",
            routing_number: "121000000",
            primary: index === 0,
          })),
          next_cursor: null,
        });
      }
      const cash = /^\/v2\/transactions\/cash\/(.+)$/.exec(url.pathname);
      if (cash) {
        const items = postedSince(brex.cash[decodeURIComponent(cash[1])] ?? [], url);
        return respond(page(items, url, brex.pageSize));
      }
      if (url.pathname === "/v2/transactions/card/primary") {
        return respond(page(postedSince(brex.card, url), url, brex.pageSize));
      }
    }
    if (url.hostname === "api.stripe.com" && worlds.stripe) {
      const stripe = worlds.stripe;
      const overridden = stripe.override?.(url);
      if (overridden) return overridden;
      if (url.pathname === "/v1/payouts") {
        const gte = url.searchParams.get("created[gte]");
        const after = url.searchParams.get("starting_after");
        let list = [...stripe.payouts].sort((a, b) => b.created - a.created);
        if (gte) list = list.filter((payout) => payout.created >= Number(gte));
        if (after) list = list.slice(list.findIndex((payout) => payout.id === after) + 1);
        const data = list.slice(0, stripe.pageSize).map((payout) => ({
          ...payout,
          status: "paid",
          currency: "usd",
          description: `STRIPE PAYOUT ${payout.id}`,
        }));
        return respond({ object: "list", data, has_more: list.length > stripe.pageSize });
      }
    }
    if (url.hostname === "api.wise.com" && worlds.wise) {
      const wise = worlds.wise;
      const overridden = wise.override?.(url);
      if (overridden) return overridden;
      const V = `/${WISE_API_VERSION}`;
      if (url.pathname === `${V}/profiles/30000001/balances`) {
        return respond([
          {
            id: 200001,
            currency: "USD",
            type: "STANDARD",
            amount: { value: 2_500.5, currency: "USD" },
            creationTime: ago(400 * DAY).toISOString(),
          },
        ]);
      }
      if (url.pathname.endsWith("/statement.json")) {
        const from = Date.parse(url.searchParams.get("intervalStart") ?? "");
        const to = Date.parse(url.searchParams.get("intervalEnd") ?? "");
        return respond({
          transactions: wise.lines
            .filter((line) => line.date.getTime() >= from && line.date.getTime() <= to)
            .map((line) => ({
              type: line.value < 0 ? "DEBIT" : "CREDIT",
              date: line.date.toISOString(),
              amount: { value: line.value, currency: "USD" },
              totalFees: { value: 0, currency: "USD" },
              details: { type: "DEPOSIT", description: `Wise ${line.ref}` },
              referenceNumber: line.ref,
            })),
        });
      }
    }
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      return originalFetch(input, init);
    }
    throw new Error(`No stand-in for ${url.href}`);
  }) as typeof fetch;
  return { requests };
}

function cashTxn(id: string, posted: Date, cents: number, description = `BREX ${id}`): BrexCashTransaction {
  return {
    id,
    description,
    amount: { amount: cents, currency: "USD" },
    initiated_at_date: day(posted),
    posted_at_date: day(posted),
    type: "PAYMENT",
    transfer_id: `tr_${id}`,
  };
}

function cardTxn(id: string, posted: Date, cents: number): BrexCardTransaction {
  return {
    id,
    card_id: "card_1",
    description: `CARD ${id}`,
    amount: { amount: cents, currency: "USD" },
    initiated_at_date: day(posted),
    posted_at_date: day(posted),
    type: "PURCHASE",
  };
}

// ─────────────────────────── fixtures ───────────────────────────

async function connection(
  provider: "brex" | "stripe" | "wise",
  config: Record<string, string>,
  companyId = CO,
): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId,
    provider,
    label: `${provider} test`,
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig(config, companyId),
  });
}

async function books(companyId = CO) {
  await seedChartOfAccounts(companyId);
  return {
    bank: (await accountByCode(companyId, "1100"))!,
    payable: (await accountByCode(companyId, "2300"))!,
    general: (await accountByCode(companyId, "6000"))!,
  };
}

async function bankFeed(values: Partial<BankFeed> & Pick<BankFeed, "kind">): Promise<BankFeed> {
  const companyId = values.companyId ?? CO;
  const bank = (await accountByCode(companyId, "1100"))!;
  return insert(BankFeed, {
    companyId,
    name: `${values.kind} feed`,
    accountId: bank.id,
    connectionId: null,
    externalAccountId: null,
    lastSyncAt: null,
    ...values,
  });
}

async function cardFeed(values: Partial<CardFeed> & Pick<CardFeed, "connectionId">): Promise<CardFeed> {
  const companyId = values.companyId ?? CO;
  const { bank, payable, general } = {
    bank: (await accountByCode(companyId, "1100"))!,
    payable: (await accountByCode(companyId, "2300"))!,
    general: (await accountByCode(companyId, "6000"))!,
  };
  return insert(CardFeed, {
    companyId,
    name: "Brex card",
    kind: "brex_card",
    liabilityAccountId: payable.id,
    defaultExpenseAccountId: general.id,
    paymentAccountId: bank.id,
    lastSyncAt: null,
    ...values,
  });
}

const reloadBank = (id: string) => AppDataSource.getRepository(BankFeed).findOneByOrFail({ id });
const reloadCard = (id: string) => AppDataSource.getRepository(CardFeed).findOneByOrFail({ id });
const bankRef = (feed: BankFeed): FeedRef => ({ kind: "bank", companyId: feed.companyId, id: feed.id });
const cardRef = (feed: CardFeed): FeedRef => ({ kind: "card", companyId: feed.companyId, id: feed.id });

async function linesOn(feedId: string): Promise<BankTransaction[]> {
  return AppDataSource.getRepository(BankTransaction).find({
    where: { feedId },
    order: { date: "ASC" },
  });
}

/**
 * Dependencies that never reach a provider, for the scheduler's own rules.
 * Like the real syncs, a successful one moves the account's cursor on.
 */
function recordingDependencies(overrides: Partial<BankingSyncDependencies> = {}) {
  const synced: string[] = [];
  const dependencies: BankingSyncDependencies = {
    syncBank: async (feed) => {
      synced.push(`bank:${feed.name}`);
      await AppDataSource.getRepository(BankFeed).update({ id: feed.id }, { lastSyncAt: new Date() });
      return 0;
    },
    autoMatch: async () => 0,
    syncCard: async (feed) => {
      synced.push(`card:${feed.name}`);
      await AppDataSource.getRepository(CardFeed).update({ id: feed.id }, { lastSyncAt: new Date() });
      return { inserted: 0, posted: 0, failed: 0 };
    },
    ...overrides,
  };
  return { synced, dependencies };
}

// ─────────────────────────── when an account is due ───────────────────────────

describe("isFeedSyncDue", () => {
  const NOW = new Date("2026-10-23T10:00:00.000Z");
  const INTERVAL = 30 * MINUTE;
  const healthy = {
    lastSyncAt: new Date(NOW.getTime() - 10 * MINUTE),
    lastSyncAttemptAt: new Date(NOW.getTime() - 10 * MINUTE),
    lastSyncError: "",
    lastSyncErrorKind: "",
    syncFailureCount: 0,
    nextSyncAt: null,
  };

  test("an account that never synced is due at once", () => {
    assert.equal(isFeedSyncDue({ ...healthy, lastSyncAt: null, lastSyncAttemptAt: null }, NOW, INTERVAL), true);
  });

  test("a healthy account is due once the interval has passed since it last synced", () => {
    assert.equal(isFeedSyncDue(healthy, NOW, INTERVAL), false);
    assert.equal(
      isFeedSyncDue({ ...healthy, lastSyncAt: new Date(NOW.getTime() - 30 * MINUTE) }, NOW, INTERVAL),
      true,
    );
    // Months behind is just as due — the catch-up starts from its cursor.
    assert.equal(
      isFeedSyncDue({ ...healthy, lastSyncAt: new Date(NOW.getTime() - 97 * DAY) }, NOW, INTERVAL),
      true,
    );
  });

  test("a cursor from the future is due, rather than waiting for the clock to catch up", () => {
    assert.equal(
      isFeedSyncDue({ ...healthy, lastSyncAt: new Date(NOW.getTime() + 3 * DAY) }, NOW, INTERVAL),
      true,
    );
  });

  test("a failing account waits for its backoff", () => {
    const failing = {
      ...healthy,
      lastSyncError: "Brex didn't answer",
      lastSyncErrorKind: "provider_unavailable",
      syncFailureCount: 2,
      nextSyncAt: new Date(NOW.getTime() + 5 * MINUTE),
    };
    assert.equal(isFeedSyncDue(failing, NOW, INTERVAL), false);
    assert.equal(
      isFeedSyncDue({ ...failing, nextSyncAt: new Date(NOW.getTime() - 1) }, NOW, INTERVAL),
      true,
    );
    assert.equal(isFeedSyncDue({ ...failing, nextSyncAt: null }, NOW, INTERVAL), true);
  });

  test("a rejected token is tried again as soon as its Connection is reconnected", () => {
    const rejected = {
      ...healthy,
      lastSyncAttemptAt: new Date(NOW.getTime() - 20 * MINUTE),
      lastSyncError: "Brex rejected the token",
      lastSyncErrorKind: "auth",
      syncFailureCount: 1,
      nextSyncAt: new Date(NOW.getTime() + 40 * MINUTE),
    };
    assert.equal(isFeedSyncDue(rejected, NOW, INTERVAL), false);
    assert.equal(
      isFeedSyncDue(rejected, NOW, INTERVAL, new Date(NOW.getTime() - 5 * MINUTE)),
      true,
      "reconnected after the failure",
    );
    assert.equal(
      isFeedSyncDue(rejected, NOW, INTERVAL, new Date(NOW.getTime() - 30 * MINUTE)),
      false,
      "a Connection last changed before the failure fixed nothing",
    );
    // A busy provider isn't fixed by touching the Connection.
    assert.equal(
      isFeedSyncDue(
        { ...rejected, lastSyncErrorKind: "rate_limited" },
        NOW,
        INTERVAL,
        new Date(NOW.getTime() - 5 * MINUTE),
      ),
      false,
    );
  });
});

describe("retryDelayMs", () => {
  test("a busy provider is tried again within minutes, then less often", () => {
    const interval = 30 * MINUTE;
    assert.deepEqual(
      [1, 2, 3, 4].map((n) => retryDelayMs("provider_unavailable", n, interval)),
      [5 * MINUTE, 10 * MINUTE, 20 * MINUTE, 40 * MINUTE],
    );
    assert.equal(retryDelayMs("rate_limited", 40, interval), 6 * HOUR, "never past six hours");
    assert.equal(retryDelayMs("internal", 40, 12 * HOUR), 12 * HOUR, "or the interval, if longer");
  });

  test("a failure only a person can fix waits an hour, then up to a day", () => {
    assert.deepEqual(
      [1, 2, 3].map((n) => retryDelayMs("auth", n, 30 * MINUTE)),
      [HOUR, 2 * HOUR, 4 * HOUR],
    );
    assert.equal(retryDelayMs("connection_missing", 30, 30 * MINUTE), DAY);
  });

  test("never sooner than the provider asked", () => {
    assert.equal(retryDelayMs("rate_limited", 1, 30 * MINUTE, 45 * MINUTE), 45 * MINUTE);
    assert.equal(retryDelayMs("rate_limited", 1, 30 * MINUTE, 1_000), 5 * MINUTE);
  });
});

// ─────────────────────────── the background pass ───────────────────────────

describe("syncDueFeeds", () => {
  test("picks up every connected account, and leaves CSV and archived ones alone", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const stripe = await connection("stripe", { apiKey: STRIPE_KEY });
    const wise = await connection("wise", { apiToken: WISE_TOKEN });
    await bankFeed({ kind: "brex_cash", name: "Brex cash", connectionId: brex.id, externalAccountId: "cash_1" });
    await bankFeed({ kind: "stripe_payouts", name: "Stripe", connectionId: stripe.id });
    await bankFeed({ kind: "wise_balance", name: "Wise", connectionId: wise.id, externalAccountId: "30000001:200001" });
    await cardFeed({ name: "Card", connectionId: brex.id });
    // Never synced in the background:
    await bankFeed({ kind: "csv", name: "Checking" });
    await bankFeed({ kind: "brex_cash", name: "Archived cash", connectionId: brex.id, externalAccountId: "cash_2", archivedAt: ago(DAY) });
    await cardFeed({ name: "Archived card", connectionId: brex.id, archivedAt: ago(DAY) });
    await bankFeed({ kind: "brex_cash", name: "No Connection", connectionId: null, externalAccountId: "cash_3" });

    const { synced, dependencies } = recordingDependencies();
    const pass = await syncDueFeeds({ dependencies });
    assert.deepEqual(synced.sort(), ["bank:Brex cash", "bank:Stripe", "bank:Wise", "card:Card"]);
    assert.deepEqual(pass, { due: 4, synced: 4, failed: 0, skipped: 0, cleared: 0 });
  });

  test("an account synced within the interval waits for the next pass", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    await bankFeed({ kind: "brex_cash", name: "Fresh", connectionId: brex.id, externalAccountId: "cash_1", lastSyncAt: ago(5 * MINUTE) });
    await bankFeed({ kind: "brex_cash", name: "Stale", connectionId: brex.id, externalAccountId: "cash_2", lastSyncAt: ago(31 * MINUTE) });
    const { synced, dependencies } = recordingDependencies();
    await syncDueFeeds({ dependencies });
    assert.deepEqual(synced, ["bank:Stale"]);

    // The interval is the operator's, read on every pass.
    overrideRuntimeSettingsForTests({ banking: { syncIntervalMinutes: 5 } });
    synced.length = 0;
    await syncDueFeeds({ dependencies });
    assert.deepEqual(synced, ["bank:Fresh"], "only the one not just synced by the last pass");
  });

  test("switched off at Admin → Runtime, nothing syncs on its own", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    await bankFeed({ kind: "brex_cash", name: "Cash", connectionId: brex.id, externalAccountId: "cash_1" });
    overrideRuntimeSettingsForTests({ banking: { syncEnabled: false } });
    const { synced, dependencies } = recordingDependencies();
    const pass = await syncDueFeeds({ dependencies });
    assert.deepEqual(synced, []);
    assert.equal(pass.due, 0);
  });

  test("the account that waited longest goes first", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    await bankFeed({ kind: "brex_cash", name: "Yesterday", connectionId: brex.id, externalAccountId: "a", lastSyncAt: ago(DAY) });
    await bankFeed({ kind: "brex_cash", name: "Never", connectionId: brex.id, externalAccountId: "b" });
    await bankFeed({ kind: "brex_cash", name: "Last month", connectionId: brex.id, externalAccountId: "c", lastSyncAt: ago(30 * DAY) });
    const due = await dueFeeds(new Date(), 30 * MINUTE);
    assert.deepEqual(
      due.map(({ feed }) => feed.name),
      ["Never", "Last month", "Yesterday"],
    );
  });

  test("one account failing never stops the others", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const broken = await bankFeed({ kind: "brex_cash", name: "Broken", connectionId: brex.id, externalAccountId: "a" });
    const fine = await bankFeed({ kind: "brex_cash", name: "Fine", connectionId: brex.id, externalAccountId: "b" });
    const card = await cardFeed({ name: "Card", connectionId: brex.id });
    const { synced, dependencies } = recordingDependencies({
      syncBank: async (feed) => {
        if (feed.name === "Broken") throw new Error("boom");
        synced.push(`bank:${feed.name}`);
        return 2;
      },
    });
    const pass = await syncDueFeeds({ dependencies });
    assert.deepEqual(pass, { due: 3, synced: 2, failed: 1, skipped: 0, cleared: 0 });
    assert.deepEqual(synced.sort(), ["bank:Fine", "card:Card"]);
    assert.equal((await reloadBank(broken.id)).lastSyncError, "The sync stopped on an unexpected error");
    assert.equal((await reloadBank(fine.id)).lastSyncError, "");
    assert.ok((await reloadCard(card.id)).lastSyncAttemptAt);
  });

  test("a mark a stopped process left is cleared; a sync running now keeps its own", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const abandoned = await bankFeed({
      kind: "brex_cash",
      name: "Abandoned",
      connectionId: brex.id,
      externalAccountId: "a",
      lastSyncAt: ago(5 * MINUTE),
      syncStartedAt: ago(40 * MINUTE),
    });
    const running = await bankFeed({ kind: "brex_cash", name: "Running", connectionId: brex.id, externalAccountId: "b", lastSyncAt: ago(5 * MINUTE) });
    const hold = gate();
    const inFlight = syncFeed(bankRef(running), {
      dependencies: {
        syncBank: async () => {
          await hold.opened;
          return 0;
        },
        autoMatch: async () => 0,
      },
    });
    // Wait until the running sync has marked itself.
    for (let i = 0; i < 100 && !(await reloadBank(running.id)).syncStartedAt; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok((await reloadBank(running.id)).syncStartedAt);

    const pass = await syncDueFeeds({ dependencies: recordingDependencies().dependencies });
    assert.equal(pass.cleared, 1);
    assert.equal((await reloadBank(abandoned.id)).syncStartedAt, null);
    assert.ok((await reloadBank(running.id)).syncStartedAt, "the live sync is still syncing");
    hold.open();
    await inFlight;
    assert.equal((await reloadBank(running.id)).syncStartedAt, null);
  });
});

describe("one sync per account", () => {
  test("a second request for an account already syncing shares the first", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "a" });
    const hold = gate();
    let calls = 0;
    const dependencies: Partial<BankingSyncDependencies> = {
      syncBank: async () => {
        calls += 1;
        await hold.opened;
        return 3;
      },
      autoMatch: async () => 1,
    };
    const first = syncFeed(bankRef(feed), { dependencies });
    const second = syncFeed(bankRef(feed), { dependencies });
    assert.equal(first, second, "the same sync");

    // The background pass skips it rather than starting another.
    const pass = await syncDueFeeds({ dependencies: recordingDependencies().dependencies });
    assert.deepEqual([pass.due, pass.skipped, pass.synced], [1, 1, 0]);

    hold.open();
    assert.deepEqual(await first, { status: "synced", kind: "bank", inserted: 3, matched: 1 });
    assert.equal(calls, 1);
    // Done, a new request is a new sync.
    hold.open();
    await syncFeed(bankRef(feed), { dependencies });
    assert.equal(calls, 2);
  });

  test("two ticks at once run one pass", async () => {
    const [first, second] = await Promise.all([runBankingSyncTick(), runBankingSyncTick()]);
    assert.ok(first, "the first tick ran its pass");
    assert.equal(second, null, "the second found it running");
  });

  test("removing an account waits for its sync, so nothing it writes outlives it", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "a" });
    const hold = gate();
    const sync = syncFeed(bankRef(feed), {
      dependencies: {
        syncBank: async (synced) => {
          await hold.opened;
          await insert(BankTransaction, {
            companyId: CO,
            feedId: synced.id,
            externalId: "late",
            date: new Date(),
            amountCents: 100,
          });
          return 1;
        },
        autoMatch: async () => 0,
      },
    });
    let removed = false;
    const removal = whileFeedIdle(bankRef(feed), async () => {
      await AppDataSource.getRepository(BankTransaction).delete({ feedId: feed.id });
      await AppDataSource.getRepository(BankFeed).delete({ id: feed.id });
      removed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(removed, false, "waits while the sync runs");
    // A sync asked for meanwhile shares the one running rather than starting another.
    hold.open();
    await sync;
    await removal;
    assert.equal(removed, true);
    assert.equal((await linesOn(feed.id)).length, 0, "no transaction left behind");
  });

  test("while an account is being changed, a sync asked for is busy", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "a" });
    const hold = gate();
    const change = whileFeedIdle(bankRef(feed), () => hold.opened);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await syncFeed(bankRef(feed)), { status: "busy" });
    await assert.rejects(whileFeedIdle(bankRef(feed), async () => undefined), /syncing right now/);
    const pass = await syncDueFeeds({ dependencies: recordingDependencies().dependencies });
    assert.equal(pass.skipped, 1);
    hold.open();
    await change;
  });
});

describe("syncFeed refuses what has nothing to sync", () => {
  test("another company's account, or one that is gone", async () => {
    await books();
    await books(OTHER);
    const brex = await connection("brex", { userToken: BREX_TOKEN }, OTHER);
    const theirs = await bankFeed({ companyId: OTHER, kind: "brex_cash", connectionId: brex.id, externalAccountId: "a" });
    await assert.rejects(syncFeed({ kind: "bank", companyId: CO, id: theirs.id }), FeedNotFoundError);
    await assert.rejects(
      syncFeed({ kind: "card", companyId: CO, id: "00000000-0000-4000-8000-000000000000" }),
      FeedNotFoundError,
    );
    assert.equal((await reloadBank(theirs.id)).syncStartedAt, null);
  });

  test("a CSV account or an archived one, without writing any status", async () => {
    await books();
    const csv = await bankFeed({ kind: "csv" });
    await assert.rejects(syncFeed(bankRef(csv)), (err) => {
      assert.ok(err instanceof FeedSyncError);
      assert.equal(err.kind, "unsupported");
      assert.match(err.message, /only be imported via CSV/);
      return true;
    });
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const archived = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "a", archivedAt: ago(DAY) });
    await assert.rejects(syncFeed(bankRef(archived)), /archived/);
    for (const id of [csv.id, archived.id]) {
      const row = await reloadBank(id);
      assert.equal(row.lastSyncAttemptAt, null);
      assert.equal(row.lastSyncError, "");
    }
  });
});

// ─────────────────────────── what each attempt records ───────────────────────────

describe("sync status", () => {
  test("a sync marks itself while it runs, and a success clears any failure", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({
      kind: "brex_cash",
      connectionId: brex.id,
      externalAccountId: "a",
      lastSyncError: "Brex didn't answer",
      lastSyncErrorDetail: "no answer",
      lastSyncErrorKind: "provider_unavailable",
      syncFailureCount: 4,
      nextSyncAt: ago(MINUTE),
    });
    let markedWhileRunning: Date | null = null;
    const outcome = await syncFeed(bankRef(feed), {
      dependencies: {
        syncBank: async () => {
          markedWhileRunning = (await reloadBank(feed.id)).syncStartedAt;
          return 2;
        },
        autoMatch: async () => 1,
      },
    });
    assert.deepEqual(outcome, { status: "synced", kind: "bank", inserted: 2, matched: 1 });
    assert.ok(markedWhileRunning, "Syncing… while it ran");
    const row = await reloadBank(feed.id);
    assert.equal(row.syncStartedAt, null);
    assert.ok(row.lastSyncAttemptAt && Date.now() - row.lastSyncAttemptAt.getTime() < MINUTE);
    assert.deepEqual(
      [row.lastSyncError, row.lastSyncErrorDetail, row.lastSyncErrorKind, row.syncFailureCount, row.nextSyncAt],
      ["", "", "", 0, null],
    );
  });

  test("a provider error is recorded in plain words, and backs off a little more each time", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "cash_1", lastSyncAt: ago(2 * HOUR) });
    const { requests } = installProviders({
      brex: {
        cashAccounts: [{ id: "cash_1", balance: 100 }],
        cash: {},
        card: [],
        pageSize: 100,
        override: () => respond({ message: "Service Unavailable" }, 503),
      },
    });
    const first = await syncFeed(bankRef(feed));
    assert.equal(first.status, "failed");
    assert.equal(requests.length, 3, "asked three times before it gave up");
    let row = await reloadBank(feed.id);
    assert.equal(row.lastSyncErrorKind, "provider_unavailable");
    assert.equal(row.lastSyncError, "Brex had a problem on its side");
    assert.equal(row.lastSyncErrorDetail, "Service Unavailable · HTTP 503 · GET /v2/accounts/cash");
    assert.equal(row.syncFailureCount, 1);
    const firstWait = row.nextSyncAt!.getTime() - row.lastSyncAttemptAt!.getTime();
    assert.equal(firstWait, 5 * MINUTE);
    assert.equal(row.syncStartedAt, null);
    assert.equal(row.lastSyncAt?.getTime(), feed.lastSyncAt?.getTime(), "the cursor stays put");

    await syncFeed(bankRef(feed));
    row = await reloadBank(feed.id);
    assert.equal(row.syncFailureCount, 2);
    assert.equal(row.nextSyncAt!.getTime() - row.lastSyncAttemptAt!.getTime(), 10 * MINUTE);

    // The Connection itself is fine: a busy Brex says nothing about the token.
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({ id: brex.id });
    assert.equal(conn.status, "connected");
  });

  test("a rejected token is an auth failure, and the Connection stops showing as connected", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", name: "Brex Primary", connectionId: brex.id, externalAccountId: "cash_1" });
    const { requests } = installProviders({
      brex: {
        cashAccounts: [],
        cash: {},
        card: [],
        pageSize: 100,
        override: () => respond({ message: "Unauthorized" }, 401),
      },
    });
    const outcome = await syncFeed(bankRef(feed));
    assert.deepEqual(outcome.status, "failed");
    assert.equal(requests.length, 1, "a rejected token is never asked again");
    assert.equal(requests[0].authorization, `Bearer ${BREX_TOKEN}`);
    const row = await reloadBank(feed.id);
    assert.equal(row.lastSyncErrorKind, "auth");
    assert.equal(row.lastSyncError, "Brex rejected the token");
    assert.equal(row.nextSyncAt!.getTime() - row.lastSyncAttemptAt!.getTime(), HOUR);
    const conn = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({ id: brex.id });
    assert.equal(conn.status, "expired");
    assert.equal(conn.statusMessage, "Brex rejected the token. Reconnect it to keep Brex Primary syncing on Banking.");

    // Marking the Connection is not a fix of itself: the next pass waits.
    assert.equal((await dueFeeds(new Date(), 30 * MINUTE)).length, 0);
    // Reconnecting is: the next pass tries straight away.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await AppDataSource.getRepository(IntegrationConnection).save({
      ...conn,
      status: "connected",
      statusMessage: "",
      encryptedConfig: encryptConnectionConfig({ userToken: "bxt_rotated" }, CO),
    });
    assert.deepEqual(
      (await dueFeeds(new Date(), 30 * MINUTE)).map(({ feed: due }) => due.id),
      [feed.id],
    );
  });

  test("a Connection that was removed says so, and its account is fixed by choosing another", async () => {
    await books();
    const feed = await cardFeed({ connectionId: "00000000-0000-4000-8000-00000000dead" });
    const outcome = await syncFeed(cardRef(feed));
    assert.equal(outcome.status, "failed");
    const row = await reloadCard(feed.id);
    assert.equal(row.lastSyncErrorKind, "connection_missing");
    assert.equal(row.lastSyncError, "The Brex Connection this account used was removed");
    assert.equal(row.lastSyncErrorDetail, "Brex Connection not found");
  });

  test("the status the Banking page reads says all of it", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "a", lastSyncAt: new Date("2026-10-23T09:00:00Z") });
    const now = new Date("2026-10-23T09:10:00Z");
    assert.deepEqual(feedSyncStatus("bank", feed, now), {
      mode: "automatic",
      intervalMinutes: 30,
      syncing: false,
      startedAt: null,
      lastAttemptAt: null,
      lastSuccessAt: "2026-10-23T09:00:00.000Z",
      failureCount: 0,
      error: null,
      nextAttemptAt: "2026-10-23T09:30:00.000Z",
    });
    const csv = await bankFeed({ kind: "csv", lastSyncAt: new Date("2026-10-20T00:00:00Z") });
    assert.equal(feedSyncStatus("bank", csv, now).mode, "import");
    assert.equal(feedSyncStatus("bank", csv, now).nextAttemptAt, null);
    // A connected account the background sync can't reach is synced by hand.
    for (const unreachable of [{ ...feed, archivedAt: now }, { ...feed, connectionId: null }]) {
      assert.equal(feedSyncStatus("bank", unreachable, now).mode, "manual");
      assert.equal(feedSyncStatus("bank", unreachable, now).nextAttemptAt, null);
    }
    overrideRuntimeSettingsForTests({ banking: { syncEnabled: false } });
    assert.equal(feedSyncStatus("bank", feed, now).mode, "manual");
    assert.equal(feedSyncStatus("bank", feed, now).nextAttemptAt, null);
    overrideRuntimeSettingsForTests(null);
    const failing = { ...feed, lastSyncError: "Brex rejected the token", lastSyncErrorKind: "no-longer-a-kind", nextSyncAt: new Date("2026-10-23T08:00:00Z") };
    const status = feedSyncStatus("bank", failing, now);
    assert.equal(status.error?.kind, "internal", "a kind this build doesn't know never crashes the page");
    assert.equal(status.nextAttemptAt, now.toISOString(), "an overdue retry is due now, not in the past");
  });
});

// ─────────────────────────── catching up — the regression ───────────────────────────

describe("catching up after months without a sync", () => {
  test("a Brex account last synced in July is brought up to date by the background pass alone", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const july = ago(97 * DAY);
    const feed = await bankFeed({
      kind: "brex_cash",
      name: "Brex Primary",
      connectionId: brex.id,
      externalAccountId: "cash_1",
      lastSyncAt: july,
    });
    // What the July sync brought in.
    await insert(BankTransaction, {
      companyId: CO,
      feedId: feed.id,
      externalId: "tx_july",
      date: ago(99 * DAY),
      amountCents: 5_000,
      description: "JULY",
    });
    const posted = [
      cashTxn("tx_oct", ago(1 * DAY), -12_000),
      cashTxn("tx_sep", ago(30 * DAY), 250_000),
      cashTxn("tx_aug_2", ago(60 * DAY), -4_210),
      cashTxn("tx_aug_1", ago(75 * DAY), 99_00),
      cashTxn("tx_july", ago(99 * DAY), 5_000),
      cashTxn("tx_june", ago(130 * DAY), 7_000),
    ];
    const { requests } = installProviders({
      brex: { cashAccounts: [{ id: "cash_1", balance: 48_212_033 }], cash: { cash_1: posted }, card: [], pageSize: 2 },
    });

    // Nobody presses anything: the pass finds it due and syncs it.
    const pass = await syncDueFeeds();
    assert.deepEqual([pass.due, pass.synced, pass.failed], [1, 1, 0]);

    const transactionRequests = requests.filter((r) => r.url.pathname.startsWith("/v2/transactions/cash/"));
    const since = transactionRequests[0].url.searchParams.get("posted_at_start");
    assert.equal(since, new Date(july.getTime() - BANK_SYNC_OVERLAP_MS).toISOString(), "from a week before the last sync that worked");
    assert.ok(transactionRequests.every((r) => r.url.searchParams.get("posted_at_start") === since), "every page asks for the same window");
    assert.equal(transactionRequests.length, 3, "every page of the window is walked");

    const lines = await linesOn(feed.id);
    assert.deepEqual(
      lines.map((line) => line.externalId),
      ["tx_july", "tx_aug_1", "tx_aug_2", "tx_sep", "tx_oct"],
      "everything since July, the July line once, nothing from before the window",
    );
    const row = await reloadBank(feed.id);
    assert.ok(row.lastSyncAt && row.lastSyncAt.getTime() > july.getTime() + 96 * DAY, "the cursor moved to now");
    assert.equal(row.balanceCents, 48_212_033);
    assert.equal(row.balanceCurrency, "USD");
    assert.equal(row.lastSyncError, "");

    // In step now: the next pass leaves it until the interval passes.
    requests.length = 0;
    assert.equal((await syncDueFeeds()).due, 0);
    assert.equal(requests.length, 0);
  });

  test("a sync that fails halfway keeps its cursor, so the next one asks for the same window", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const july = ago(97 * DAY);
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "cash_1", lastSyncAt: july });
    let failing = true;
    const posted = [cashTxn("tx_3", ago(DAY), 300), cashTxn("tx_2", ago(2 * DAY), 200), cashTxn("tx_1", ago(3 * DAY), 100)];
    const { requests } = installProviders({
      brex: {
        cashAccounts: [{ id: "cash_1", balance: 600 }],
        cash: { cash_1: posted },
        card: [],
        pageSize: 2,
        // The second page keeps failing.
        override: (url) => (failing && url.searchParams.get("cursor") === "2" ? respond({ message: "Bad Gateway" }, 502) : null),
      },
    });
    assert.equal((await syncFeed(bankRef(feed))).status, "failed");
    assert.deepEqual((await linesOn(feed.id)).map((l) => l.externalId).sort(), ["tx_2", "tx_3"], "the first page is kept");
    assert.equal((await reloadBank(feed.id)).lastSyncAt?.getTime(), july.getTime());

    failing = false;
    requests.length = 0;
    const outcome = await syncFeed(bankRef(feed));
    assert.deepEqual(outcome, { status: "synced", kind: "bank", inserted: 1, matched: 0 });
    const since = requests.find((r) => r.url.pathname.startsWith("/v2/transactions/cash/"))!.url.searchParams.get("posted_at_start");
    assert.equal(since, new Date(july.getTime() - BANK_SYNC_OVERLAP_MS).toISOString());
    assert.equal((await linesOn(feed.id)).length, 3);
  });

  test("a card catches up the same way, and its first sync walks its whole history", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await cardFeed({ connectionId: brex.id });
    const world: BrexWorld = {
      cashAccounts: [],
      cash: {},
      card: [cardTxn("c3", ago(2 * DAY), 300), cardTxn("c2", ago(200 * DAY), 200), cardTxn("c1", ago(900 * DAY), 100)],
      pageSize: 2,
    };
    const { requests } = installProviders({ brex: world });
    const first = await syncFeed(cardRef(feed));
    assert.deepEqual(first, { status: "synced", kind: "card", inserted: 3, posted: 3, failed: 0 });
    assert.ok(requests.every((r) => !r.url.searchParams.has("posted_at_start")), "the first sync asks for everything");
    assert.equal(requests.length, 2);

    const synced = await reloadCard(feed.id);
    world.card.unshift(cardTxn("c4", ago(0.5 * DAY), 400));
    requests.length = 0;
    const second = await syncFeed(cardRef(feed));
    assert.deepEqual(second, { status: "synced", kind: "card", inserted: 1, posted: 1, failed: 0 });
    assert.equal(
      requests[0].url.searchParams.get("posted_at_start"),
      new Date(synced.lastSyncAt!.getTime() - 7 * DAY).toISOString(),
    );
    const rows = await AppDataSource.getRepository(CardTransaction).find({ where: { feedId: feed.id } });
    assert.equal(rows.length, 4);
    assert.ok(rows.every((row) => row.ledgerEntryId && row.needsReview), "each in the books, waiting for review");
  });

  test("Stripe payouts are asked for from a week before the last sync, every page", async () => {
    await books();
    const stripe = await connection("stripe", { apiKey: STRIPE_KEY });
    const feed = await bankFeed({ kind: "stripe_payouts", connectionId: stripe.id });
    const seconds = (date: Date) => Math.floor(date.getTime() / 1000);
    const world: StripeWorld = {
      payouts: [
        { id: "po_1", amount: 10_000, created: seconds(ago(400 * DAY)), arrival_date: seconds(ago(398 * DAY)) },
        { id: "po_2", amount: 20_000, created: seconds(ago(40 * DAY)), arrival_date: seconds(ago(38 * DAY)) },
        { id: "po_3", amount: 30_000, created: seconds(ago(4 * DAY)), arrival_date: seconds(ago(2 * DAY)) },
      ],
      pageSize: 2,
    };
    const { requests } = installProviders({ stripe: world });
    assert.equal((await syncFeed(bankRef(feed))).status, "synced");
    assert.equal(requests.length, 2, "two pages");
    assert.ok(requests.every((r) => !r.url.searchParams.has("created[gte]")));
    assert.equal(requests[0].authorization, `Bearer ${STRIPE_KEY}`);
    assert.deepEqual((await linesOn(feed.id)).map((l) => l.externalId), ["po_1", "po_2", "po_3"]);

    const synced = await reloadBank(feed.id);
    world.payouts.push({ id: "po_4", amount: 40_000, created: seconds(ago(HOUR)), arrival_date: seconds(new Date()) });
    requests.length = 0;
    assert.deepEqual(await syncFeed(bankRef(feed)), { status: "synced", kind: "bank", inserted: 1, matched: 0 });
    assert.equal(
      requests[0].url.searchParams.get("created[gte]"),
      String(Math.floor((synced.lastSyncAt!.getTime() - BANK_SYNC_OVERLAP_MS) / 1000)),
    );
  });

  test("a Wise balance looks again at the month before its last sync, and keeps its balance", async () => {
    await books();
    const wise = await connection("wise", { apiToken: WISE_TOKEN });
    const last = ago(97 * DAY);
    const feed = await bankFeed({ kind: "wise_balance", connectionId: wise.id, externalAccountId: "30000001:200001", lastSyncAt: last });
    const { requests } = installProviders({
      wise: { lines: [{ ref: "TRANSFER-1", date: ago(50 * DAY), value: 1_200 }, { ref: "CARD-2", date: ago(DAY), value: -42.1 }] },
    });
    assert.deepEqual(await syncFeed(bankRef(feed)), { status: "synced", kind: "bank", inserted: 2, matched: 0 });
    const statement = requests.find((r) => r.url.pathname.endsWith("/statement.json"))!;
    assert.equal(statement.url.searchParams.get("intervalStart"), new Date(last.getTime() - 30 * DAY).toISOString());
    const row = await reloadBank(feed.id);
    assert.equal(row.balanceCents, 250_050);
    assert.equal(row.balanceCurrency, "USD");
  });
});

// ─────────────────────────── same as Sync now ───────────────────────────

describe("what a background sync brings in", () => {
  test("lands in To review and is matched to the payment already recorded, as Sync now does", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "cash_1", lastSyncAt: ago(2 * DAY) });
    const customer = await insert(Customer, { companyId: CO, name: "Globex LLC", slug: "globex", email: "ap@globex.example", currency: "USD" });
    const draft = await createInvoiceDraft({
      companyId: CO,
      customerId: customer.id,
      currency: "USD",
      issueDate: ago(20 * DAY),
      dueDate: ago(-10 * DAY),
      lines: [{ description: "Retainer", quantity: 1, unitPriceCents: 120_000 }],
    });
    const invoice = await issueInvoice(draft);
    const recorded = await recordInvoicePayment(
      invoice,
      { amountCents: 120_000, method: "bank_transfer", paidAt: ago(DAY), reference: "GLOBEX-OCT" },
      null,
    );
    installProviders({
      brex: {
        cashAccounts: [{ id: "cash_1", balance: 120_000 }],
        cash: { cash_1: [cashTxn("tx_globex", ago(DAY), 120_000, "GLOBEX WIRE"), cashTxn("tx_github", ago(DAY), -4_210, "GITHUB")] },
        card: [],
        pageSize: 100,
      },
    });
    const pass = await syncDueFeeds();
    assert.equal(pass.synced, 1);
    const [deposit, github] = (await linesOn(feed.id)).sort((a, b) => b.amountCents - a.amountCents);
    const payment = await AppDataSource.getRepository(InvoicePayment).findOneByOrFail({ id: recorded.payment!.id });
    assert.equal(payment.bankTransactionId, deposit.id, "matched to the recorded payment");
    assert.ok(deposit.reconciledAt);
    assert.equal(github.reconciledAt, null, "the rest waits in To review");
    const accounts = await listBankingAccounts(CO);
    assert.deepEqual(
      accounts.map((account) => [account.toReview, account.total, account.sync.error]),
      [[1, 2, null]],
    );
  });

  test("tells open pages to refresh, but fires Routine events only for what came in", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "cash_1", lastSyncAt: ago(2 * HOUR) });
    const ui: string[] = [];
    const triggers: string[] = [];
    registerResourceChangeSink((companyId, kind) => ui.push(`${companyId}:${kind}`));
    registerRoutineTriggerSink((companyId, kind) => triggers.push(`${companyId}:${kind}`));
    const flushed = () => new Promise((resolve) => setTimeout(resolve, 250));
    const world: BrexWorld = { cashAccounts: [{ id: "cash_1", balance: 1 }], cash: { cash_1: [] }, card: [], pageSize: 100 };
    installProviders({ brex: world });

    await syncFeed(bankRef(feed));
    await flushed();
    assert.ok(ui.includes(`${CO}:reconcile`), "Banking pages refresh");
    assert.equal(triggers.length, 0, "a sync that found nothing starts no Routine");

    world.cash.cash_1.push(cashTxn("tx_new", ago(HOUR), 500));
    ui.length = 0;
    await syncFeed(bankRef(feed));
    await flushed();
    assert.ok(triggers.includes(`${CO}:reconcile`), "a new transaction is an event");
  });
});

// ─────────────────────────── Sync now from a request ───────────────────────────

describe("syncFeedForRequest", () => {
  test("answers with the counts when the sync is quick", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "cash_1" });
    installProviders({
      brex: { cashAccounts: [{ id: "cash_1", balance: 1 }], cash: { cash_1: [cashTxn("tx", ago(DAY), 100)] }, card: [], pageSize: 100 },
    });
    const outcome = await syncFeedForRequest(bankRef(feed));
    assert.deepEqual(outcome, { status: "synced", kind: "bank", inserted: 1, matched: 0 });
    assert.deepEqual(syncResponse(outcome), { status: 200, body: { inserted: 1, matched: 0 } });
  });

  test("answers that it is still syncing when the sync is long, and carries on", async () => {
    await books();
    const brex = await connection("brex", { userToken: BREX_TOKEN });
    const feed = await bankFeed({ kind: "brex_cash", connectionId: brex.id, externalAccountId: "cash_1" });
    setSyncRequestWaitForTests(30);
    const hold = gate();
    installProviders({
      brex: { cashAccounts: [{ id: "cash_1", balance: 1 }], cash: { cash_1: [cashTxn("tx", ago(DAY), 100)] }, card: [], pageSize: 100 },
    });
    const slowFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      await hold.opened;
      return slowFetch(input, init);
    }) as typeof fetch;
    const outcome = await syncFeedForRequest(bankRef(feed));
    assert.deepEqual(outcome, { status: "syncing" });
    assert.deepEqual(syncResponse(outcome), { status: 202, body: { syncing: true } });
    assert.ok((await reloadBank(feed.id)).syncStartedAt, "Syncing… on the account meanwhile");
    hold.open();
    // The sync it answered for finishes on its own.
    for (let i = 0; i < 200 && (await reloadBank(feed.id)).syncStartedAt; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const row = await reloadBank(feed.id);
    assert.equal(row.syncStartedAt, null);
    assert.equal(row.lastSyncError, "");
    assert.equal((await linesOn(feed.id)).length, 1);
  });

  test("answers a failure with the card's line, its kind and the details", () => {
    assert.deepEqual(
      syncResponse({
        status: "failed",
        failure: {
          kind: "auth",
          message: "Brex rejected the token",
          detail: "Unauthorized · HTTP 401",
          retryAfterMs: null,
          connectionStatus: "expired",
        },
      }),
      {
        status: 400,
        body: { error: "Brex rejected the token", kind: "auth", detail: "Unauthorized · HTTP 401" },
      },
    );
    assert.equal(syncResponse({ status: "busy" }).status, 409);
    assert.deepEqual(syncResponse({ status: "synced", kind: "card", inserted: 2, posted: 1, failed: 1 }), {
      status: 200,
      body: { inserted: 2, posted: 1, failed: 1 },
    });
  });
});

describe("bootBankingSync", () => {
  test("registers one every-minute task, and stopping it removes it", () => {
    const named = () => [...cron.getTasks().values()].filter((task) => task.name === "banking-sync");
    stopBankingSync();
    assert.equal(named().length, 0);
    bootBankingSync();
    bootBankingSync();
    assert.equal(named().length, 1, "booting twice is one task");
    assert.equal(named()[0].getPattern(), "* * * * *");
    stopBankingSync();
    assert.equal(named().length, 0);
  });
});
