import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { type FinanceAccess, Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import type { BrexCashTransaction } from "../integrations/providers/brex.js";
import { errorHandler } from "../middleware/error.js";
import { setSyncRequestWaitForTests, whileFeedIdle } from "../services/bankingSync.js";
import { setProviderRetrySleepForTests } from "../services/feedSyncErrors.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import { overrideRuntimeSettingsForTests } from "../services/runtimeSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { cardExpensesRouter } from "./cardExpenses.js";
import { financeRouter } from "./finance.js";

/**
 * Banking's sync over HTTP: the status each account carries in the overview,
 * Sync now for a bank account and a card — its answers when it works, fails,
 * runs long, or collides — pointing an account at another Connection, and
 * who may do each, in which company. Brex is a stand-in on `fetch`.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let brex: IntegrationConnection;
let bank: Account;

const originalFetch = globalThis.fetch;
const TOKEN = "bxt_route_token";
const DAY = 24 * 60 * 60 * 1000;

type BrexAnswer = (url: URL) => Response | null;
let brexAnswer: BrexAnswer | null = null;
let brexRequests: URL[] = [];
let cashAccounts = ["cash_1"];
let cash: BrexCashTransaction[] = [];

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A date and time with no offset — the only form Brex's date filters read. */
const BREX_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

function cashTxn(id: string, daysAgo: number, cents: number): BrexCashTransaction {
  const posted = new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
  return {
    id,
    description: `BREX ${id}`,
    amount: { amount: cents, currency: "USD" },
    initiated_at_date: posted,
    posted_at_date: posted,
    type: "PAYMENT",
    transfer_id: null,
  };
}

before(async () => {
  await initTestDb();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.brex.com") return originalFetch(input, init);
    brexRequests.push(url);
    const answered = brexAnswer?.(url);
    if (answered) return answered;
    // As Brex does: a date with an offset — toISOString()'s `Z` — is refused outright.
    const since = url.searchParams.get("posted_at_start");
    if (since !== null && !BREX_DATE_TIME.test(since)) return respond({ message: "Bad request" }, 400);
    if (url.pathname === "/v2/accounts/cash") {
      return respond({
        items: cashAccounts.map((id, index) => ({
          id,
          name: `Cash ${index + 1}`,
          status: "ACTIVE",
          current_balance: { amount: 4_821_000, currency: "USD" },
          available_balance: { amount: 4_821_000, currency: "USD" },
          account_number: "000123456789",
          routing_number: "121000000",
          primary: index === 0,
        })),
        next_cursor: null,
      });
    }
    if (url.pathname.startsWith("/v2/transactions/cash/")) return respond({ items: cash, next_cursor: null });
    if (url.pathname === "/v2/transactions/card/primary") {
      return respond({
        items: [
          {
            id: "card_tx_1",
            card_id: "card_1",
            description: "Delta Air Lines",
            amount: { amount: 18_900, currency: "USD" },
            posted_at_date: new Date(Date.now() - DAY).toISOString().slice(0, 10),
            type: "PURCHASE",
          },
        ],
        next_cursor: null,
      });
    }
    return respond({ message: `unexpected ${url.pathname}` }, 500);
  }) as typeof fetch;

  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", financeRouter);
  app.use("/api/companies/:cid", cardExpensesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function member(target: Company, role: Role, financeAccess?: FinanceAccess): Promise<string> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.com`,
    name: role,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, {
    companyId: target.id,
    userId: user.id,
    role,
    ...(financeAccess ? { financeAccess } : {}),
  });
  return user.id;
}

beforeEach(async () => {
  await resetTestDb();
  brexAnswer = null;
  brexRequests = [];
  cashAccounts = ["cash_1"];
  cash = [cashTxn("tx_1", 2, 125_000), cashTxn("tx_2", 1, -4_210)];
  setProviderRetrySleepForTests(async () => undefined);
  company = await insert(Company, { name: "Sync test", slug: `sync-${randomUUID()}`, ownerId: randomUUID() });
  otherCompany = await insert(Company, { name: "Other", slug: `other-${randomUUID()}`, ownerId: randomUUID() });
  actingUserId = await member(company, "owner");
  await seedChartOfAccounts(company.id);
  await seedChartOfAccounts(otherCompany.id);
  bank = (await accountByCode(company.id, "1100"))!;
  brex = await brexConnection(company.id, "Brex (Ops)");
});

afterEach(() => {
  setProviderRetrySleepForTests(null);
  setSyncRequestWaitForTests(null);
  overrideRuntimeSettingsForTests(null);
});

function brexConnection(companyId: string, label: string): Promise<IntegrationConnection> {
  return insert(IntegrationConnection, {
    companyId,
    provider: "brex",
    label,
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig({ userToken: TOKEN }, companyId),
  });
}

function brexCash(values: Partial<BankFeed> = {}): Promise<BankFeed> {
  return insert(BankFeed, {
    companyId: company.id,
    name: "Brex Primary",
    kind: "brex_cash",
    accountId: bank.id,
    connectionId: brex.id,
    externalAccountId: "cash_1",
    lastSyncAt: null,
    ...values,
  });
}

async function brexCard(values: Partial<CardFeed> = {}): Promise<CardFeed> {
  const payable = (await accountByCode(company.id, "2300"))!;
  const general = (await accountByCode(company.id, "6000"))!;
  return insert(CardFeed, {
    companyId: company.id,
    name: "Brex card",
    kind: "brex_card",
    connectionId: brex.id,
    liabilityAccountId: payable.id,
    defaultExpenseAccountId: general.id,
    paymentAccountId: bank.id,
    lastSyncAt: null,
    ...values,
  });
}

type Body = Record<string, unknown> & { error?: string };

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Body };
}

type AccountBody = {
  kind: string;
  feed: { id: string; name: string };
  toReview: number;
  total: number;
  provider: string | null;
  sync: {
    mode: string;
    syncing: boolean;
    lastSuccessAt: string | null;
    error: { kind: string; message: string; detail: string } | null;
    nextAttemptAt: string | null;
    intervalMinutes: number;
  };
  connection: { id: string; label: string; provider: string; status: string } | null;
  balance: { cents: number; currency: string } | null;
};

async function accounts(): Promise<AccountBody[]> {
  const listed = await call("GET", "/banking/accounts");
  assert.equal(listed.status, 200);
  return listed.body as unknown as AccountBody[];
}

describe("GET /banking/accounts", () => {
  test("each account carries how its sync is doing, its Connection and its balance", async () => {
    const feed = await brexCash();
    await insert(BankFeed, {
      companyId: company.id,
      name: "Checking",
      kind: "csv",
      accountId: bank.id,
      lastSyncAt: new Date("2026-10-20T00:00:00Z"),
    });
    assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 200);

    const [primary, checking] = await accounts();
    assert.equal(primary.provider, "brex");
    assert.deepEqual(primary.connection, {
      id: brex.id,
      label: "Brex (Ops)",
      provider: "brex",
      status: "connected",
      statusMessage: "",
    });
    assert.deepEqual(primary.balance && { cents: primary.balance.cents, currency: primary.balance.currency }, {
      cents: 4_821_000,
      currency: "USD",
    });
    assert.equal(primary.sync.mode, "automatic");
    assert.equal(primary.sync.syncing, false);
    assert.equal(primary.sync.error, null);
    assert.equal(primary.sync.intervalMinutes, 30);
    assert.ok(primary.sync.lastSuccessAt);
    assert.deepEqual([primary.toReview, primary.total], [2, 2]);

    assert.equal(checking.provider, null);
    assert.equal(checking.connection, null);
    assert.equal(checking.balance, null);
    assert.equal(checking.sync.mode, "import");
    assert.equal(checking.sync.lastSuccessAt, "2026-10-20T00:00:00.000Z");
    assert.equal(checking.sync.nextAttemptAt, null);
  });

  test("a failed sync is in the overview, in plain words with the details", async () => {
    const feed = await brexCash();
    brexAnswer = () => respond({ message: "Unauthorized" }, 401);
    await call("POST", `/bank-feeds/${feed.id}/sync`);
    const [primary] = await accounts();
    assert.deepEqual(primary.sync.error, {
      kind: "auth",
      message: "Brex rejected the token",
      detail: "Unauthorized · HTTP 401 · GET /v2/accounts/cash",
    });
    assert.ok(primary.sync.nextAttemptAt);
    assert.equal(primary.connection?.status, "expired", "the Connection is marked too");
  });

  test("an account whose Connection was removed has none, and says the background sync is off when it is", async () => {
    await brexCash({ connectionId: randomUUID() });
    overrideRuntimeSettingsForTests({ banking: { syncEnabled: false } });
    const [primary] = await accounts();
    assert.equal(primary.connection, null);
    assert.equal(primary.sync.mode, "manual");
  });

  test("only this company's accounts and Connections", async () => {
    await brexCash();
    const theirConnection = await brexConnection(otherCompany.id, "Their Brex");
    const theirBank = (await accountByCode(otherCompany.id, "1100"))!;
    await insert(BankFeed, {
      companyId: otherCompany.id,
      name: "Their Brex",
      kind: "brex_cash",
      accountId: theirBank.id,
      connectionId: theirConnection.id,
      externalAccountId: "cash_1",
    });
    // A feed here pointing at another company's Connection shows no Connection.
    await brexCash({ name: "Pointing elsewhere", connectionId: theirConnection.id, externalAccountId: "cash_9" });
    const listed = await accounts();
    assert.deepEqual(listed.map((account) => account.feed.name), ["Brex Primary", "Pointing elsewhere"]);
    assert.equal(listed[1].connection, null);
  });

  test("a read-only Member reads it; a Member without finance access doesn't", async () => {
    await brexCash();
    actingUserId = await member(company, "member", "read");
    assert.equal((await call("GET", "/banking/accounts")).status, 200);
    actingUserId = await member(company, "member", "none");
    assert.equal((await call("GET", "/banking/accounts")).status, 403);
    // An owner of another company is no Member here.
    actingUserId = await member(otherCompany, "owner");
    assert.equal((await call("GET", "/banking/accounts")).status, 403);
  });
});

describe("Sync now after Brex refused every sync since July", () => {
  /** How the accounts were left: the first sync in July worked, every one after was refused. */
  function refusedSinceJuly(detail: string) {
    return {
      lastSyncAt: new Date(Date.now() - 98 * DAY),
      lastSyncAttemptAt: new Date(Date.now() - 60 * 60 * 1000),
      lastSyncError: "Brex refused the request",
      lastSyncErrorDetail: detail,
      lastSyncErrorKind: "provider_error",
      syncFailureCount: 6,
      nextSyncAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    };
  }

  test("a bank account and a card sync again, ask for the date as Brex reads it, and stop saying they failed", async () => {
    const cashFeed = await brexCash(refusedSinceJuly("Bad request · HTTP 400 · GET /v2/transactions/cash/cash_1"));
    const cardFeed = await brexCard(refusedSinceJuly("Bad request · HTTP 400 · GET /v2/transactions/card/primary"));
    const before = await accounts();
    assert.deepEqual(
      before.map((account) => account.sync.error?.message),
      ["Brex refused the request", "Brex refused the request"],
    );

    const bankSync = await call("POST", `/bank-feeds/${cashFeed.id}/sync`);
    assert.equal(bankSync.status, 200, JSON.stringify(bankSync.body));
    assert.deepEqual(bankSync.body, { inserted: 2, matched: 0 });
    const cardSync = await call("POST", `/card-feeds/${cardFeed.id}/sync`);
    assert.equal(cardSync.status, 200, JSON.stringify(cardSync.body));
    assert.deepEqual(cardSync.body, { inserted: 1, posted: 1, failed: 0 });

    const dated = brexRequests.filter((url) => url.pathname.startsWith("/v2/transactions/"));
    assert.equal(dated.length, 2);
    for (const url of dated) {
      const since = url.searchParams.get("posted_at_start") ?? "";
      assert.match(since, BREX_DATE_TIME, `${url.pathname} sent ${since}`);
      const weekBeforeJuly = Date.now() - 105 * DAY;
      assert.ok(Math.abs(Date.parse(`${since}Z`) - weekBeforeJuly) < 60_000, "a week before the last sync that worked");
    }

    const after = await accounts();
    for (const account of after) {
      assert.equal(account.sync.error, null, account.feed.name);
      assert.ok(account.sync.lastSuccessAt && Date.parse(account.sync.lastSuccessAt) > Date.now() - 60_000);
    }
  });
});

describe("POST /bank-feeds/:id/sync", () => {
  test("brings new transactions in and answers with what came in", async () => {
    const feed = await brexCash();
    const synced = await call("POST", `/bank-feeds/${feed.id}/sync`);
    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body, { inserted: 2, matched: 0 });
    const again = await call("POST", `/bank-feeds/${feed.id}/sync`);
    assert.deepEqual(again.body, { inserted: 0, matched: 0 }, "nothing twice");
    const row = await AppDataSource.getRepository(BankFeed).findOneByOrFail({ id: feed.id });
    assert.ok(row.lastSyncAttemptAt);
    assert.equal(row.lastSyncError, "");
  });

  test("a sync that fails is a 400 with why, and the account keeps saying so", async () => {
    const feed = await brexCash();
    brexAnswer = () => respond({ message: "Service Unavailable" }, 503);
    const failed = await call("POST", `/bank-feeds/${feed.id}/sync`);
    assert.equal(failed.status, 400);
    assert.deepEqual(failed.body, {
      error: "Brex had a problem on its side",
      kind: "provider_unavailable",
      detail: "Service Unavailable · HTTP 503 · GET /v2/accounts/cash",
    });
    const row = await AppDataSource.getRepository(BankFeed).findOneByOrFail({ id: feed.id });
    assert.equal(row.lastSyncErrorKind, "provider_unavailable");
    assert.equal(row.syncFailureCount, 1);

    // Brex is back: the next Sync now clears it.
    brexAnswer = null;
    assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 200);
    assert.equal((await accounts())[0].sync.error, null);
  });

  test("a closed Brex account is named as such", async () => {
    const feed = await brexCash();
    cashAccounts = ["cash_other"];
    const failed = await call("POST", `/bank-feeds/${feed.id}/sync`);
    assert.equal(failed.status, 400);
    assert.equal(failed.body.kind, "account_missing");
    assert.match(failed.body.error ?? "", /no longer on the Connection/);
  });

  test("a sync still running after the wait is a 202 and carries on", async () => {
    const feed = await brexCash();
    setSyncRequestWaitForTests(20);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Brex answers only after the request has been told it is still syncing.
    const slow = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.brex.com") await held;
      return slow(input, init);
    }) as typeof fetch;
    try {
      const pending = await call("POST", `/bank-feeds/${feed.id}/sync`);
      assert.equal(pending.status, 202);
      assert.deepEqual(pending.body, { syncing: true });
      assert.equal((await accounts())[0].sync.syncing, true, "Syncing… meanwhile");
      release();
      for (let i = 0; i < 200 && (await accounts())[0].sync.syncing; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const [done] = await accounts();
      assert.equal(done.sync.syncing, false);
      assert.equal(done.total, 2);
    } finally {
      globalThis.fetch = slow;
    }
  });

  test("an account being changed is a 409", async () => {
    const feed = await brexCash();
    let release!: () => void;
    const change = whileFeedIdle(
      { kind: "bank", companyId: company.id, id: feed.id },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const busy = await call("POST", `/bank-feeds/${feed.id}/sync`);
    assert.equal(busy.status, 409);
    assert.match(busy.body.error ?? "", /syncing right now/);
    release();
    await change;
  });

  test("a CSV account has nothing to sync", async () => {
    const csv = await insert(BankFeed, { companyId: company.id, name: "Checking", kind: "csv", accountId: bank.id });
    const refused = await call("POST", `/bank-feeds/${csv.id}/sync`);
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? "", /only be imported via CSV/);
  });

  test("validates the id, and finds only this company's accounts", async () => {
    const bad = await call("POST", "/bank-feeds/not-a-uuid/sync");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "ValidationError");
    assert.equal((await call("POST", `/bank-feeds/${randomUUID()}/sync`)).status, 404);

    const theirBank = (await accountByCode(otherCompany.id, "1100"))!;
    const theirs = await insert(BankFeed, {
      companyId: otherCompany.id,
      name: "Theirs",
      kind: "brex_cash",
      accountId: theirBank.id,
      connectionId: brex.id,
      externalAccountId: "cash_1",
    });
    assert.equal((await call("POST", `/bank-feeds/${theirs.id}/sync`)).status, 404);
    assert.equal(brexRequests.length, 0, "Brex is never asked for another company's account");
  });

  test("needs full finance access", async () => {
    const feed = await brexCash();
    actingUserId = await member(company, "member", "read");
    assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 403);
    actingUserId = await member(company, "member", "none");
    assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 403);
    actingUserId = await member(company, "member", "full");
    assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 200);
    actingUserId = null;
    assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 401);
  });
});

describe("POST /card-feeds/:feedId/sync", () => {
  test("brings purchases in, and answers a failure with why", async () => {
    const feed = await brexCard();
    const synced = await call("POST", `/card-feeds/${feed.id}/sync`);
    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body, { inserted: 1, posted: 1, failed: 0 });

    brexAnswer = () => respond({ message: "Forbidden" }, 403);
    const failed = await call("POST", `/card-feeds/${feed.id}/sync`);
    assert.equal(failed.status, 400);
    assert.equal(failed.body.error, "Brex won't let this token read card transactions");
    assert.equal(failed.body.kind, "permission");
    const card = (await accounts()).find((account) => account.kind === "card")!;
    assert.equal(card.sync.error?.kind, "permission");
  });

  test("validates, scopes and gates like the rest of Banking", async () => {
    const feed = await brexCard();
    assert.equal((await call("POST", "/card-feeds/nope/sync")).status, 400);
    assert.equal((await call("POST", `/card-feeds/${randomUUID()}/sync`)).status, 404);
    // Under a company this owner isn't a Member of, nothing is reached.
    assert.equal((await call("POST", `/card-feeds/${feed.id}/sync`, undefined, otherCompany.id)).status, 403);
    // Under the other company, as its owner, the card isn't there.
    actingUserId = await member(otherCompany, "owner");
    assert.equal((await call("POST", `/card-feeds/${feed.id}/sync`, undefined, otherCompany.id)).status, 404);
    actingUserId = await member(company, "member", "read");
    assert.equal((await call("POST", `/card-feeds/${feed.id}/sync`)).status, 403);
  });
});

describe("PATCH — pointing an account at another Connection", () => {
  test("a bank account whose Connection was removed syncs again through another", async () => {
    const feed = await brexCash({
      connectionId: randomUUID(),
      lastSyncError: "The Brex Connection this account used was removed",
      lastSyncErrorKind: "connection_missing",
      syncFailureCount: 3,
      nextSyncAt: new Date(Date.now() + DAY),
    });
    const changed = await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: brex.id });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.connectionId, brex.id);
    const row = await AppDataSource.getRepository(BankFeed).findOneByOrFail({ id: feed.id });
    assert.deepEqual(
      [row.connectionId, row.lastSyncError, row.lastSyncErrorKind, row.syncFailureCount, row.nextSyncAt],
      [brex.id, "", "", 0, null],
    );
    assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 200);
  });

  test("the new Connection has to reach the same account, and be the right provider", async () => {
    const feed = await brexCash();
    cashAccounts = ["cash_other"];
    const missing = await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: brex.id });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error ?? "", /Brex Cash account not found on this Connection/);

    const stripe = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "stripe",
      label: "Stripe",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig({ apiKey: "sk_test" }, company.id),
    });
    const wrong = await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: stripe.id });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error, "That Connection isn't Brex.");

    const theirs = await brexConnection(otherCompany.id, "Their Brex");
    const foreign = await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: theirs.id });
    assert.equal(foreign.status, 400);
    assert.equal(foreign.body.error, "Connection not found");

    const csv = await insert(BankFeed, { companyId: company.id, name: "Checking", kind: "csv", accountId: bank.id });
    const none = await call("PATCH", `/bank-feeds/${csv.id}`, { connectionId: brex.id });
    assert.equal(none.status, 400);
    assert.match(none.body.error ?? "", /CSV account/);

    const row = await AppDataSource.getRepository(BankFeed).findOneByOrFail({ id: feed.id });
    assert.equal(row.connectionId, brex.id, "nothing changed");
  });

  test("validates its body and id, scopes by company, and needs full finance access", async () => {
    const feed = await brexCash();
    assert.equal((await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: "nope" })).status, 400);
    assert.equal((await call("PATCH", `/bank-feeds/${feed.id}`, {})).status, 400);
    assert.equal((await call("PATCH", "/bank-feeds/nope", { connectionId: brex.id })).status, 400);
    assert.equal(
      (await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: brex.id }, otherCompany.id)).status,
      403,
    );
    actingUserId = await member(otherCompany, "owner");
    assert.equal(
      (await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: brex.id }, otherCompany.id)).status,
      404,
      "another company's owner can't reach this account through their own company",
    );
    actingUserId = await member(company, "member", "read");
    assert.equal((await call("PATCH", `/bank-feeds/${feed.id}`, { connectionId: brex.id })).status, 403);
  });

  test("a card is pointed at another Brex Connection that can read card transactions", async () => {
    const spare = await brexConnection(company.id, "Brex (Finance)");
    const feed = await brexCard({ connectionId: randomUUID() });
    const changed = await call("PATCH", `/card-feeds/${feed.id}`, { connectionId: spare.id });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.connectionId, spare.id);

    brexAnswer = (url) => (url.pathname === "/v2/transactions/card/primary" ? respond({ message: "Forbidden" }, 403) : null);
    const refused = await call("PATCH", `/card-feeds/${feed.id}`, { connectionId: brex.id });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? "", /Grant transactions\.card\.readonly/);
    assert.equal((await call("PATCH", `/card-feeds/${feed.id}`, { connectionId: "x" })).status, 400);
    actingUserId = await member(company, "member", "read");
    assert.equal((await call("PATCH", `/card-feeds/${feed.id}`, { connectionId: spare.id })).status, 403);
  });
});

describe("DELETE while a sync runs", () => {
  test("waits for the sync, so none of its transactions outlive the account", async () => {
    const feed = await brexCash();
    setSyncRequestWaitForTests(10);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.startsWith("/v2/transactions/cash/")) await held;
      return slow(input, init);
    }) as typeof fetch;
    try {
      assert.equal((await call("POST", `/bank-feeds/${feed.id}/sync`)).status, 202);
      const removal = call("DELETE", `/bank-feeds/${feed.id}`);
      await new Promise((resolve) => setTimeout(resolve, 30));
      release();
      assert.equal((await removal).status, 200);
      assert.equal(await AppDataSource.getRepository(BankFeed).countBy({ id: feed.id }), 0);
      assert.equal(await AppDataSource.getRepository(BankTransaction).countBy({ feedId: feed.id }), 0);
    } finally {
      globalThis.fetch = slow;
    }
  });

  test("a card already in the books still can't be removed", async () => {
    const feed = await brexCard();
    await call("POST", `/card-feeds/${feed.id}/sync`);
    const refused = await call("DELETE", `/card-feeds/${feed.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error ?? "", /audit trail/);
    assert.equal((await call("DELETE", "/card-feeds/nope")).status, 400);
  });
});
