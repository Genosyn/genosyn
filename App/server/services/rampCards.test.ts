import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { LedgerLine } from "../db/entities/LedgerLine.js";
import {
  forgetRampTokensForTests,
  RAMP_SCOPES,
  type RampCashback,
  type RampTransaction,
  type RampTransfer,
} from "../integrations/providers/ramp.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { BankingAccountError, changeFeedConnection, listBankingAccounts } from "./banking.js";
import { syncFeed } from "./bankingSync.js";
import { createCardFeed, syncCardFeed } from "./cardExpenses.js";
import { setProviderRetrySleepForTests } from "./feedSyncErrors.js";
import { encryptConnectionConfig } from "./integrations.js";
import { accountByCode, seedChartOfAccounts } from "./ledger.js";
import { RAMP_SYNC_OVERLAP_MS } from "./rampCards.js";

/**
 * A Ramp card on Banking: which Connection makes one, the three lists a sync
 * walks — card transactions, bill payments, cashback — and what each puts in
 * the books, how far back a later sync looks, and how a failure reads.
 * api.ramp.com is answered by a stand-in on `fetch`.
 */

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  forgetRampTokensForTests();
  setProviderRetrySleepForTests(async () => undefined);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  setProviderRetrySleepForTests(null);
});
after(closeTestDb);

const originalFetch = globalThis.fetch;
const CO = "co_ramp_cards";
const DAY = 24 * 60 * 60 * 1000;
const CLIENT = { clientId: "ramp_id_cards", clientSecret: "ramp_sec_cards" };

function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function purchase(id: string, usedAt: Date, cents: number, extra: Partial<RampTransaction> = {}): RampTransaction {
  return {
    id,
    entity_amount: { value: cents, currency: "USD" },
    minor_unit_conversion_rate: 100,
    state: "CLEARED",
    user_transaction_time: usedAt.toISOString(),
    settlement_date: new Date(usedAt.getTime() + 2 * DAY).toISOString(),
    merchant_name: `Merchant ${id}`,
    merchant_descriptor: `MERCHANT ${id}`,
    card_id: "card-1",
    ...extra,
  };
}

function transfer(id: string, at: Date, cents: number, status = "COMPLETED"): RampTransfer {
  return {
    id,
    amount: { amount: cents, currency_code: "USD", minor_unit_conversion_rate: 100 },
    status,
    created_at: at.toISOString(),
  };
}

function cashback(id: string, at: Date, cents: number): RampCashback {
  return {
    id,
    amount: { amount: cents, currency_code: "USD", minor_unit_conversion_rate: 100 },
    created_at: at.toISOString(),
  };
}

type World = {
  transactions: RampTransaction[];
  transfers: RampTransfer[];
  cashbacks: RampCashback[];
  /** Items a page, so a test can make a list span pages. */
  pageSize: number;
  /** Answer the token request some other way. */
  token?: () => Response;
  /** Where a `next` link points: Ramp's API, or somewhere a link must never send the token. */
  nextHost?: string;
};

type Request = { path: string; params: URLSearchParams; auth: string };

/** Stand in for api.ramp.com, answering from `world` and recording each request. */
function installRamp(world: World): Request[] {
  const requests: Request[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.ramp.com", "every request goes to Ramp's API");
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    requests.push({ path: url.pathname, params: url.searchParams, auth });
    if (url.pathname === "/developer/v1/token") {
      if (world.token) return world.token();
      assert.equal(new URLSearchParams(String(init?.body)).get("scope"), RAMP_SCOPES.join(" "));
      return respond({ access_token: "ramp_business_tok_cards", token_type: "Bearer", expires_in: 864_000 });
    }
    assert.equal(auth, "Bearer ramp_business_tok_cards");
    const from = url.searchParams.get("from_date");
    const after = (at: string | null | undefined) => !from || Date.parse(at ?? "") > Date.parse(from);
    let items: Array<{ id: string }>;
    if (url.pathname === "/developer/v1/transactions") {
      const state = url.searchParams.get("state");
      items = world.transactions.filter(
        (item) => after(item.user_transaction_time) && (!state || item.state === state),
      );
    } else if (url.pathname === "/developer/v1/transfers") {
      const status = url.searchParams.get("status");
      items = world.transfers.filter((item) => after(item.created_at) && (!status || item.status === status));
    } else if (url.pathname === "/developer/v1/cashbacks") {
      items = world.cashbacks.filter((item) => after(item.created_at));
    } else {
      return respond({ error_v2: { error_code: "DEVELOPER_7000", message: `unexpected ${url.pathname}` } }, 500);
    }
    const start = url.searchParams.get("start");
    const from_ = start ? items.findIndex((item) => item.id === start) + 1 : 0;
    const data = items.slice(from_, from_ + world.pageSize);
    const more = from_ + world.pageSize < items.length;
    const next = new URL(url.pathname, world.nextHost ?? "https://api.ramp.com");
    next.searchParams.set("start", data[data.length - 1]?.id ?? "");
    return respond({ data, page: { next: more ? next.toString() : null } });
  }) as typeof fetch;
  return requests;
}

function world(overrides: Partial<World> = {}): World {
  return { transactions: [], transfers: [], cashbacks: [], pageSize: 100, ...overrides };
}

async function rampConnection(label = "Ramp") {
  return insert(IntegrationConnection, {
    companyId: CO,
    provider: "ramp",
    label,
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig({ ...CLIENT }, CO),
  });
}

async function books() {
  await seedChartOfAccounts(CO);
  return {
    bank: (await accountByCode(CO, "1100"))!,
    payable: (await accountByCode(CO, "2300"))!,
    general: (await accountByCode(CO, "6000"))!,
  };
}

async function rampCard(connectionId: string) {
  const { bank, payable, general } = await books();
  const feed = await insert(CardFeed, {
    companyId: CO,
    name: "Ramp card",
    kind: "ramp_card",
    connectionId,
    liabilityAccountId: payable.id,
    defaultExpenseAccountId: general.id,
    paymentAccountId: bank.id,
  });
  return { feed, bank, payable, general };
}

async function cardRows(feedId: string): Promise<CardTransaction[]> {
  return AppDataSource.getRepository(CardTransaction).find({
    where: { feedId },
    order: { postedAt: "ASC" },
  });
}

/** Each posting's lines as `account:debit:credit`, and its memo. */
async function posting(entryId: string | null) {
  assert.ok(entryId, "the transaction is in the books");
  const entry = await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({ id: entryId });
  const lines = await AppDataSource.getRepository(LedgerLine).find({ where: { ledgerEntryId: entryId } });
  return {
    memo: entry.memo,
    source: entry.source,
    lines: lines.map((line) => `${line.accountId}:${line.debitCents}:${line.creditCents}`).sort(),
  };
}

describe("adding a Ramp card", () => {
  test("a Ramp Connection makes a Ramp card, and only a card provider's Connection makes one", async () => {
    const { bank, payable, general } = await books();
    const connection = await rampConnection();
    const requests = installRamp(world());
    const feed = await createCardFeed({
      companyId: CO,
      name: "Ramp card",
      connectionId: connection.id,
      liabilityAccountId: payable.id,
      defaultExpenseAccountId: general.id,
      paymentAccountId: bank.id,
    });
    assert.equal(feed.kind, "ramp_card");
    assert.deepEqual(
      requests.map((request) => request.path).filter((path) => path !== "/developer/v1/token"),
      ["/developer/v1/transactions", "/developer/v1/transfers", "/developer/v1/cashbacks"],
      "it proved the Connection reads every list the card syncs",
    );

    const stripe = await insert(IntegrationConnection, {
      companyId: CO,
      provider: "stripe",
      label: "Stripe",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({ apiKey: "sk_test" }, CO),
    });
    await assert.rejects(
      createCardFeed({
        companyId: CO,
        name: "Not a card",
        connectionId: stripe.id,
        liabilityAccountId: payable.id,
        defaultExpenseAccountId: general.id,
        paymentAccountId: bank.id,
      }),
      /A card syncs through a Brex or Ramp Connection/,
    );
  });

  test("an app without every scope is refused before the card is added", async () => {
    const { bank, payable, general } = await books();
    const connection = await rampConnection();
    installRamp(world({ token: () => respond({ error: "invalid_scope" }, 400) }));
    await assert.rejects(
      createCardFeed({
        companyId: CO,
        name: "Ramp card",
        connectionId: connection.id,
        liabilityAccountId: payable.id,
        defaultExpenseAccountId: general.id,
        paymentAccountId: bank.id,
      }),
      /Ramp card access failed\. Allow transactions:read, transfers:read and cashbacks:read/,
    );
    assert.equal(await AppDataSource.getRepository(CardFeed).count(), 0);
  });
});

describe("syncing a Ramp card", () => {
  test("the first sync walks every list into the books: purchases, refunds, bill payments and cashback", async () => {
    const connection = await rampConnection();
    const { feed, bank, payable, general } = await rampCard(connection.id);
    const flight = purchase("p1", ago(400 * DAY), 12_345, { merchant_name: "Lufthansa" });
    const requests = installRamp(
      world({
        pageSize: 1,
        // A next link on another host must never be followed as it is.
        nextHost: "https://elsewhere.example",
        transactions: [
          flight,
          purchase("r1", ago(390 * DAY), -4_000, {
            merchant_name: "Lufthansa",
            original_transaction_id: "p1",
          }),
          purchase("pending", ago(DAY), 999, { state: "PENDING" }),
        ],
        transfers: [
          transfer("t1", ago(380 * DAY), 50_000),
          transfer("t2", ago(379 * DAY), 50_000, "ERROR"),
        ],
        cashbacks: [cashback("c1", ago(370 * DAY), 2_700)],
      }),
    );

    const outcome = await syncFeed({ kind: "card", companyId: CO, id: feed.id });
    assert.deepEqual(outcome, { status: "synced", kind: "card", inserted: 4, posted: 4, failed: 0 });

    const rows = await cardRows(feed.id);
    assert.deepEqual(
      rows.map((row) => [row.externalId, row.amountCents, row.accountingKind, row.needsReview, row.description]),
      [
        ["p1", 12_345, "expense", true, "Lufthansa"],
        ["r1", -4_000, "refund", true, "Lufthansa"],
        ["transfer:t1", -50_000, "payment", false, "Ramp bill payment"],
        ["cashback:c1", -2_700, "refund", true, "Ramp cashback"],
      ],
    );
    assert.equal(
      rows[0].postedAt.toISOString(),
      flight.settlement_date,
      "a purchase is dated when it settled, not when the card was used",
    );
    assert.equal(rows[0].cardId, "card-1");

    // Each in the books as a Brex card's would be.
    const [buy, refund, payment, credit] = await Promise.all(rows.map((row) => posting(row.ledgerEntryId)));
    assert.deepEqual(buy, {
      memo: "Ramp card · Lufthansa",
      source: "brex_card_expense",
      lines: [`${general.id}:12345:0`, `${payable.id}:0:12345`].sort(),
    });
    assert.deepEqual(refund.lines, [`${payable.id}:4000:0`, `${general.id}:0:4000`].sort());
    assert.equal(refund.source, "brex_card_refund");
    assert.deepEqual(payment.lines, [`${payable.id}:50000:0`, `${bank.id}:0:50000`].sort());
    assert.equal(payment.source, "brex_card_payment");
    assert.deepEqual(credit.lines, [`${payable.id}:2700:0`, `${general.id}:0:2700`].sort());

    // Settled only, and the whole history: no lower bound on a first sync.
    const lists = requests.filter((request) => request.path !== "/developer/v1/token");
    for (const request of lists) assert.equal(request.params.get("from_date"), null);
    assert.ok(lists.filter((r) => r.path === "/developer/v1/transactions").every((r) => r.params.get("state") === "CLEARED"));
    assert.ok(lists.filter((r) => r.path === "/developer/v1/transfers").every((r) => r.params.get("status") === "COMPLETED"));
    // Every page after the first asked for by its cursor alone.
    assert.deepEqual(
      lists.filter((r) => r.path === "/developer/v1/transactions").map((r) => r.params.get("start")),
      [null, "p1"],
    );
    assert.equal(requests.filter((request) => request.path === "/developer/v1/token").length, 1);
  });

  test("a later sync looks back a month by when the card was used, and adds nothing twice", async () => {
    const connection = await rampConnection();
    const { feed } = await rampCard(connection.id);
    const w = world({
      transactions: [purchase("old", ago(90 * DAY), 1_000)],
      transfers: [transfer("t-old", ago(80 * DAY), 1_000)],
      cashbacks: [cashback("c-old", ago(70 * DAY), 10)],
    });
    installRamp(w);
    const firstAt = ago(10 * DAY);
    assert.deepEqual(await syncCardFeed(feed, firstAt), { inserted: 3, posted: 3, failed: 0 });

    // A hotel stay used before that sync settles only now, and a new purchase.
    w.transactions.push(
      purchase("hotel", new Date(firstAt.getTime() - 20 * DAY), 45_000),
      purchase("new", ago(DAY), 2_500),
    );
    const requests = installRamp(w);
    assert.deepEqual(await syncCardFeed(feed, new Date()), { inserted: 2, posted: 2, failed: 0 });
    const asked = requests.filter((request) => request.path !== "/developer/v1/token");
    assert.equal(asked.length, 3);
    for (const request of asked) {
      assert.equal(
        request.params.get("from_date"),
        new Date(firstAt.getTime() - RAMP_SYNC_OVERLAP_MS).toISOString(),
      );
    }
    assert.deepEqual(
      (await cardRows(feed.id)).map((row) => row.externalId).sort(),
      ["cashback:c-old", "hotel", "new", "old", "transfer:t-old"],
    );
  });

  test("a transaction with no amount Genosyn can read stops the sync and names it", async () => {
    const connection = await rampConnection();
    const { feed } = await rampCard(connection.id);
    installRamp(
      world({
        transactions: [purchase("broken", ago(DAY), 100, { entity_amount: null, amount: null, currency_code: null })],
      }),
    );
    const outcome = await syncFeed({ kind: "card", companyId: CO, id: feed.id });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.failure.kind, "bad_data");
    assert.equal(outcome.failure.message, "Ramp sent a transaction Genosyn couldn't read");
    assert.match(outcome.failure.detail, /Ramp card transaction broken has no usable amount/);
  });

  test("a rejected secret fails the sync in Ramp's terms and marks the Connection expired", async () => {
    const connection = await rampConnection();
    const { feed } = await rampCard(connection.id);
    installRamp(world({ token: () => respond({ error: "invalid_client" }, 401) }));
    const outcome = await syncFeed({ kind: "card", companyId: CO, id: feed.id });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assert.equal(outcome.failure.kind, "auth");
    assert.equal(outcome.failure.message, "Ramp rejected the client ID and secret");
    const after = await AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({ id: connection.id });
    assert.equal(after.status, "expired");
  });
});

describe("a Ramp card on Banking", () => {
  test("names Ramp as its provider", async () => {
    const connection = await rampConnection();
    await rampCard(connection.id);
    const [account] = await listBankingAccounts(CO);
    assert.equal(account.kind, "card");
    assert.equal(account.provider, "ramp");
  });

  test("moves to another Ramp Connection that reads the same lists, and never to Brex", async () => {
    const connection = await rampConnection();
    const { feed } = await rampCard(connection.id);
    const other = await rampConnection("Ramp (finance team)");
    installRamp(world());
    const moved = await changeFeedConnection("card", feed, other.id);
    assert.equal(moved.connectionId, other.id);

    const brex = await insert(IntegrationConnection, {
      companyId: CO,
      provider: "brex",
      label: "Brex",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({ userToken: "bxt_x" }, CO),
    });
    await assert.rejects(
      changeFeedConnection("card", feed, brex.id),
      (err: unknown) => err instanceof BankingAccountError && err.message === "That Connection isn't Ramp.",
    );
  });
});
