import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import type { MercuryAccount, MercuryTransaction } from "../integrations/providers/mercury.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { listBankingAccounts } from "./banking.js";
import { syncFeed } from "./bankingSync.js";
import { FeedSyncError, setProviderRetrySleepForTests } from "./feedSyncErrors.js";
import { setHomeCurrency } from "./fx.js";
import { encryptConnectionConfig } from "./integrations.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import {
  assertMercuryAccountFeed,
  listMercuryAccountsForConnection,
  syncMercuryAccountFeed,
} from "./mercuryFeeds.js";

/**
 * A Mercury account on Banking: which accounts can become one, the checks
 * before one does, and the sync that walks its settled transactions — the
 * whole history once, then again from a week before the last sync by the date
 * each posted — without ever adding one twice. api.mercury.com is answered by
 * a stand-in on `fetch`.
 */

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  setProviderRetrySleepForTests(async () => undefined);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setProviderRetrySleepForTests(null);
});
after(closeTestDb);

const originalFetch = globalThis.fetch;
const CO = "co_mercury_feeds";
const TOKEN = "secret-token:mercury_production_rma_feeds";
const DAY = 24 * 60 * 60 * 1000;
const CHECKING_ID = "8f3c2a8e-7b6d-4c5e-9f1a-2b3c4d5e6f70";
const SAVINGS_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const CLOSED_ID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

const CHECKING: MercuryAccount = {
  id: CHECKING_ID,
  name: "Mercury Checking ••1234",
  nickname: "Operating",
  status: "active",
  type: "mercury",
  kind: "checking",
  accountNumber: "202211111234",
  routingNumber: "091311229",
  availableBalance: 48_120.5,
  currentBalance: 48_212.33,
  createdAt: "2023-02-01T15:00:00Z",
  legalBusinessName: "Acme Inc",
};
const SAVINGS: MercuryAccount = {
  ...CHECKING,
  id: SAVINGS_ID,
  name: "Mercury Savings ••9876",
  nickname: null,
  kind: "savings",
  accountNumber: "202211119876",
  currentBalance: 250_000,
  availableBalance: 250_000,
};
const CLOSED: MercuryAccount = { ...CHECKING, id: CLOSED_ID, nickname: "Old checking", status: "archived" };
const PAYEE: MercuryAccount = {
  ...CHECKING,
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  name: "Landlord LLC",
  nickname: null,
  type: "recipient",
};

let sequence = 0;

function txn(
  createdAt: Date,
  amount: number,
  extra: Partial<MercuryTransaction> = {},
): MercuryTransaction {
  sequence += 1;
  const id = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
  return {
    id,
    accountId: CHECKING_ID,
    amount,
    status: "sent",
    createdAt: createdAt.toISOString(),
    postedAt: new Date(createdAt.getTime() + DAY).toISOString(),
    kind: amount < 0 ? "outgoingPayment" : "externalTransfer",
    counterpartyName: amount < 0 ? "AWS" : "Globex Corp",
    counterpartyNickname: null,
    bankDescription: amount < 0 ? "AMAZON WEB SERVICES" : "GLOBEX CORP INV-1042",
    note: null,
    externalMemo: amount < 0 ? null : "INV-1042",
    ...extra,
  };
}

type World = {
  accounts: MercuryAccount[];
  transactions: MercuryTransaction[];
  pageSize: number;
};

type TransactionCall = URLSearchParams;

/** Stand in for api.mercury.com, answering from `world`, and record each transaction request. */
function installMercury(world: World): TransactionCall[] {
  const calls: TransactionCall[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.mercury.com");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    if (url.pathname === "/api/v1/accounts") {
      return Response.json({ accounts: world.accounts, page: {} });
    }
    if (url.pathname === "/api/v1/transactions") {
      calls.push(url.searchParams);
      const accountIds = url.searchParams.getAll("accountId");
      const statuses = url.searchParams.getAll("status");
      const postedStart = url.searchParams.get("postedStart");
      const matching = world.transactions
        .filter((t) => accountIds.length === 0 || accountIds.includes(t.accountId ?? ""))
        .filter((t) => statuses.length === 0 || statuses.includes(t.status))
        .filter((t) => !postedStart || (!!t.postedAt && Date.parse(t.postedAt) >= Date.parse(postedStart)))
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      const after = url.searchParams.get("start_after");
      const from = after ? matching.findIndex((t) => t.id === after) + 1 : 0;
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), world.pageSize);
      const page = matching.slice(from, from + limit);
      const more = from + limit < matching.length;
      return Response.json({ transactions: page, page: more ? { nextPage: page[page.length - 1].id } : {} });
    }
    return Response.json({ errors: { message: `unexpected ${url.pathname}` } }, { status: 404 });
  }) as typeof fetch;
  return calls;
}

function world(overrides: Partial<World> = {}): World {
  return { accounts: [CHECKING, SAVINGS, CLOSED, PAYEE], transactions: [], pageSize: 1000, ...overrides };
}

async function setup() {
  await seedChartOfAccounts(CO);
  const bank = (await accountByCode(CO, "1100"))!;
  const connection = await insert(IntegrationConnection, {
    companyId: CO,
    provider: "mercury",
    label: "Mercury",
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig({ apiToken: TOKEN }, CO),
  });
  return { bank, connection };
}

async function mercuryFeed(connectionId: string, accountId: string, values: Partial<BankFeed> = {}) {
  return insert(BankFeed, {
    companyId: CO,
    name: "Mercury Operating",
    kind: "mercury_account",
    connectionId,
    externalAccountId: CHECKING_ID,
    accountId,
    lastSyncAt: null,
    ...values,
  });
}

async function linesOn(feedId: string): Promise<BankTransaction[]> {
  return AppDataSource.getRepository(BankTransaction).find({
    where: { feedId },
    order: { date: "ASC" },
  });
}

describe("listMercuryAccountsForConnection", () => {
  test("lists the company's own accounts, open first, and says why one can't be added", async () => {
    const { bank, connection } = await setup();
    installMercury(world());
    await mercuryFeed(connection.id, bank.id, { externalAccountId: SAVINGS_ID, name: "Mercury Savings" });
    assert.deepEqual(await listMercuryAccountsForConnection(CO, connection.id), [
      {
        id: CHECKING_ID,
        name: "Operating",
        kind: "checking",
        accountNumberLast4: "1234",
        currentCents: 4_821_233,
        availableCents: 4_812_050,
        unavailableReason: null,
      },
      {
        id: SAVINGS_ID,
        name: "Mercury Savings ••9876",
        kind: "savings",
        accountNumberLast4: "9876",
        currentCents: 25_000_000,
        availableCents: 25_000_000,
        unavailableReason: "Already on Banking as “Mercury Savings”",
      },
      {
        id: CLOSED_ID,
        name: "Old checking",
        kind: "checking",
        accountNumberLast4: "1234",
        currentCents: 4_821_233,
        availableCents: 4_812_050,
        unavailableReason: "Closed in Mercury",
      },
    ]);
  });

  test("offers nothing to books kept in another currency", async () => {
    const { connection } = await setup();
    await setHomeCurrency(CO, "EUR");
    installMercury(world({ accounts: [CHECKING] }));
    const [choice] = await listMercuryAccountsForConnection(CO, connection.id);
    assert.equal(choice.unavailableReason, "Your books are in EUR");
  });
});

describe("assertMercuryAccountFeed", () => {
  test("checks the account is on the Connection, open, in the books' currency, and new to Banking", async () => {
    const { bank, connection } = await setup();
    installMercury(world());
    await assertMercuryAccountFeed(CO, connection.id, CHECKING_ID);
    await assert.rejects(assertMercuryAccountFeed(CO, connection.id, " "), /Choose a Mercury account/);
    await assert.rejects(
      assertMercuryAccountFeed(CO, connection.id, PAYEE.id),
      /That account isn't on this Mercury Connection/,
    );
    await assert.rejects(assertMercuryAccountFeed(CO, connection.id, CLOSED_ID), /That Mercury account is closed/);

    const feed = await mercuryFeed(connection.id, bank.id);
    await assert.rejects(
      assertMercuryAccountFeed(CO, connection.id, CHECKING_ID),
      /This Mercury account is already on Banking as “Mercury Operating”/,
    );
    // The account itself, pointed at another Connection, is not a duplicate.
    await assertMercuryAccountFeed(CO, connection.id, CHECKING_ID, { exceptFeedId: feed.id });

    await setHomeCurrency(CO, "GBP");
    await assert.rejects(
      assertMercuryAccountFeed(CO, connection.id, SAVINGS_ID),
      /Mercury accounts are in USD and your books are in GBP/,
    );
  });

  test("refuses a Connection that isn't Mercury", async () => {
    await setup();
    const wise = await insert(IntegrationConnection, {
      companyId: CO,
      provider: "wise",
      label: "Wise",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({ apiToken: "w" }, CO),
    });
    await assert.rejects(
      assertMercuryAccountFeed(CO, wise.id, CHECKING_ID),
      (err: unknown) => err instanceof FeedSyncError && err.kind === "connection_missing",
    );
  });
});

describe("syncMercuryAccountFeed", () => {
  test("the first sync walks the whole history, settled transactions only, page by page", async () => {
    const { bank, connection } = await setup();
    const feed = await mercuryFeed(connection.id, bank.id);
    const deposit = txn(ago(700 * DAY), 1_250);
    const bill = txn(ago(300 * DAY), -86.4);
    const w = world({
      pageSize: 2,
      transactions: [
        deposit,
        bill,
        txn(ago(200 * DAY), 0.0, { counterpartyName: "Card check" }),
        txn(ago(2 * DAY), -50, { status: "pending", postedAt: null }),
        txn(ago(100 * DAY), -12, { status: "failed", postedAt: null }),
        txn(ago(50 * DAY), 300, { accountId: SAVINGS_ID }),
        txn(ago(10 * DAY), 75.5, { counterpartyName: "", bankDescription: "INTEREST", externalMemo: null }),
      ],
    });
    const calls = installMercury(w);
    const now = new Date();
    assert.equal(await syncMercuryAccountFeed(feed, now), 3);

    const lines = await linesOn(feed.id);
    assert.deepEqual(
      lines.map((line) => [line.externalId, line.amountCents, line.description, line.reference]),
      [
        [deposit.id, 125_000, "Globex Corp", "GLOBEX CORP INV-1042 · INV-1042"],
        [bill.id, -8_640, "AWS", "AMAZON WEB SERVICES"],
        [w.transactions[6].id, 7_550, "INTEREST", ""],
      ],
    );
    assert.equal(lines[0].date.toISOString(), deposit.postedAt, "dated when it posted");

    // The whole history, this account's settled transactions, oldest first.
    for (const params of calls) {
      assert.deepEqual(params.getAll("accountId"), [CHECKING_ID]);
      assert.deepEqual(params.getAll("status"), ["sent"]);
      assert.equal(params.get("order"), "asc");
      assert.equal(params.get("postedStart"), null);
      assert.equal(params.get("start"), null);
    }
    assert.equal(calls.length, 2, "two pages of two");
    assert.equal(calls[1].get("start_after"), bill.id);

    const saved = await AppDataSource.getRepository(BankFeed).findOneByOrFail({ id: feed.id });
    assert.ok(Math.abs(saved.lastSyncAt!.getTime() - now.getTime()) < 1000, "the cursor moved to now");
    assert.equal(saved.balanceCents, 4_821_233);
    assert.equal(saved.balanceCurrency, "USD");
  });

  test("a later sync asks for what posted since a week before the last, and adds nothing twice", async () => {
    const { bank, connection } = await setup();
    const lastSyncAt = ago(3 * DAY);
    const feed = await mercuryFeed(connection.id, bank.id, { lastSyncAt });
    const known = txn(ago(20 * DAY), 100);
    await insert(BankTransaction, {
      companyId: CO,
      feedId: feed.id,
      externalId: known.id,
      date: new Date(known.postedAt!),
      amountCents: 10_000,
      description: "Globex Corp",
    });
    // A check deposited weeks ago that only posted yesterday still comes in.
    const lateCheck = txn(ago(40 * DAY), 900, {
      kind: "checkDeposit",
      counterpartyName: "Initech",
      postedAt: ago(DAY).toISOString(),
    });
    const settledAgain = { ...known, postedAt: ago(5 * DAY).toISOString() };
    const calls = installMercury(world({ transactions: [lateCheck, settledAgain] }));
    assert.equal(await syncMercuryAccountFeed(feed), 1);
    assert.equal(
      calls[0].get("postedStart"),
      new Date(lastSyncAt.getTime() - 7 * DAY).toISOString(),
    );
    assert.deepEqual(
      (await linesOn(feed.id)).map((line) => line.externalId).sort(),
      [known.id, lateCheck.id].sort(),
    );
  });

  test("an account that is gone, or books in another currency, fail with what is wrong", async () => {
    const { bank, connection } = await setup();
    const feed = await mercuryFeed(connection.id, bank.id);
    installMercury(world({ accounts: [SAVINGS] }));
    await assert.rejects(
      syncMercuryAccountFeed(feed),
      (err: unknown) => err instanceof FeedSyncError && err.kind === "account_missing",
    );
    installMercury(world());
    await setHomeCurrency(CO, "EUR");
    await assert.rejects(
      syncMercuryAccountFeed(feed),
      (err: unknown) => err instanceof FeedSyncError && err.kind === "unsupported",
    );
  });

  test("a settled transaction with no amount stops the sync rather than guessing", async () => {
    const { bank, connection } = await setup();
    const feed = await mercuryFeed(connection.id, bank.id);
    const broken = txn(ago(DAY), Number.NaN);
    installMercury(world({ transactions: [{ ...broken, amount: null as unknown as number }] }));
    await assert.rejects(syncMercuryAccountFeed(feed), (err: unknown) => {
      assert.ok(err instanceof FeedSyncError);
      assert.equal(err.kind, "bad_data");
      assert.match(err.message, new RegExp(`Mercury transaction ${broken.id} has no usable amount`));
      return true;
    });
  });
});

describe("a Mercury account on Banking", () => {
  test("syncs like any connected account, and shows its provider and balance", async () => {
    const { bank, connection } = await setup();
    const feed = await mercuryFeed(connection.id, bank.id);
    installMercury(world({ transactions: [txn(ago(5 * DAY), 42)] }));
    const outcome = await syncFeed({ kind: "bank", companyId: CO, id: feed.id });
    assert.deepEqual(outcome, { status: "synced", kind: "bank", inserted: 1, matched: 0 });
    const [account] = await listBankingAccounts(CO);
    assert.equal(account.provider, "mercury");
    assert.deepEqual(account.connection?.provider, "mercury");
    assert.equal(account.balance?.cents, 4_821_233);
    assert.equal(account.sync.mode, "automatic");
  });

  test("a rejected token fails the sync in Mercury's terms and marks the Connection expired", async () => {
    const { bank, connection } = await setup();
    const feed = await mercuryFeed(connection.id, bank.id);
    globalThis.fetch = (async () =>
      Response.json({ errors: { errorCode: "invalidToken", message: "Invalid token" } }, { status: 401 })) as typeof fetch;
    const outcome = await syncFeed({ kind: "bank", companyId: CO, id: feed.id });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.failure.kind, "auth");
    assert.equal(outcome.failure.message, "Mercury rejected the API token");
    const after = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({ id: connection.id });
    assert.equal(after.status, "expired");
  });
});
