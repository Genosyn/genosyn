import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { Company } from "../db/entities/Company.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { type FinanceAccess, Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import {
  WISE_API_VERSION,
  WISE_SCA_MESSAGE,
  type WiseStatementTransaction,
} from "../integrations/providers/wise.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * Adding a Wise balance on Banking over HTTP: the picker's list, the checks
 * the server makes before saving a feed, who may do either, and an update
 * that brings the balance's transactions in.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let connection: IntegrationConnection;
let bank: Account;

const originalFetch = globalThis.fetch;
const V = `/${WISE_API_VERSION}`;
const TOKEN = "wise-route-token";
const REF = "30000001:200001";

const PROFILES = [
  { id: 30000001, type: "BUSINESS", businessName: "Acme Inc", currentState: "VISIBLE" },
];
const USD = {
  id: 200001,
  currency: "USD",
  type: "STANDARD",
  amount: { value: 2500, currency: "USD" },
  creationTime: new Date(Date.now() - 60 * 86_400_000).toISOString(),
};
const EUR = { ...USD, id: 200002, currency: "EUR", amount: { value: 90, currency: "EUR" } };

let wiseRequests: URL[] = [];
let statement: () => Response;

function respond(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function wiseLine(referenceNumber: string, daysAgo: number, value: number): WiseStatementTransaction {
  return {
    type: value < 0 ? "DEBIT" : "CREDIT",
    date: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    amount: { value, currency: "USD" },
    details: { type: "DEPOSIT", description: `Wise ${referenceNumber}` },
    referenceNumber,
  };
}

before(async () => {
  await initTestDb();
  // Requests to Wise are answered here; the test's own requests to the router
  // go to the real loopback server.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.wise.com") return originalFetch(input, init);
    wiseRequests.push(url);
    if (url.pathname === `${V}/profiles`) return respond(PROFILES);
    if (url.pathname === `${V}/profiles/30000001/balances`) return respond([USD, EUR]);
    if (url.pathname.endsWith("/statement.json")) return statement();
    return respond({ message: "unexpected" }, 500);
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

async function member(role: Role, financeAccess?: FinanceAccess): Promise<string> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.com`,
    name: role,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role,
    ...(financeAccess ? { financeAccess } : {}),
  });
  return user.id;
}

beforeEach(async () => {
  await resetTestDb();
  wiseRequests = [];
  // Dated once: Wise's lines keep their dates from one statement to the next.
  const lines = [wiseLine("TRANSFER-1", 5, 1200), wiseLine("CARD-2", 3, -42.1)];
  statement = () => respond({ transactions: lines });
  company = await insert(Company, {
    name: "Wise test",
    slug: `wise-test-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  actingUserId = await member("owner");
  await seedChartOfAccounts(company.id);
  bank = (await accountByCode(company.id, "1100"))!;
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "wise",
    label: "Wise",
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig({ apiToken: TOKEN }, company.id),
  });
});

type Body = Record<string, unknown> & { error?: string };

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

function addWise(values: Record<string, unknown> = {}) {
  return call("POST", "/bank-feeds", {
    name: "Wise USD",
    kind: "wise_balance",
    accountId: bank.id,
    connectionId: connection.id,
    externalAccountId: REF,
    ...values,
  });
}

describe("GET /bank-feeds/wise-balances", () => {
  test("lists the Connection's balances for anyone who can read the finances", async () => {
    actingUserId = await member("member", "read");
    const listed = await call("GET", `/bank-feeds/wise-balances?connectionId=${connection.id}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [
      {
        id: "30000001:200001",
        profileName: "Acme Inc",
        profileType: "BUSINESS",
        currency: "USD",
        availableCents: 250_000,
        unavailableReason: null,
      },
      {
        id: "30000001:200002",
        profileName: "Acme Inc",
        profileType: "BUSINESS",
        currency: "EUR",
        availableCents: 9_000,
        unavailableReason: "Your books are in USD",
      },
    ]);
  });

  test("needs a real Connection id, and a Member without finance access sees nothing", async () => {
    const bad = await call("GET", "/bank-feeds/wise-balances?connectionId=nope");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "A valid Wise connectionId is required");
    const unknown = await call("GET", `/bank-feeds/wise-balances?connectionId=${randomUUID()}`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "Wise Connection not found");

    actingUserId = await member("member", "none");
    const hidden = await call("GET", `/bank-feeds/wise-balances?connectionId=${connection.id}`);
    assert.equal(hidden.status, 403);
    assert.equal(wiseRequests.length, 0);
  });
});

describe("POST /bank-feeds for a Wise balance", () => {
  test("saves the feed once Wise releases the balance's statement", async () => {
    const added = await addWise();
    assert.equal(added.status, 200);
    assert.equal(added.body.kind, "wise_balance");
    assert.equal(added.body.connectionId, connection.id);
    assert.equal(added.body.externalAccountId, REF);
    assert.equal(added.body.accountId, bank.id);
    assert.ok(wiseRequests.some((url) => url.pathname.endsWith("/statement.json")));
    const saved = await AppDataSource.getRepository(BankFeed).findOneByOrFail({
      id: added.body.id as string,
    });
    assert.equal(saved.companyId, company.id);
    assert.equal(saved.lastSyncAt, null);
  });

  test("needs the Connection and the balance", async () => {
    const noConnection = await addWise({ connectionId: null });
    assert.equal(noConnection.status, 400);
    assert.equal(noConnection.body.error, "Wise feeds need a connectionId");
    const noBalance = await addWise({ externalAccountId: null });
    assert.equal(noBalance.status, 400);
    assert.equal(noBalance.body.error, "Wise feeds need a balance");
    assert.equal(wiseRequests.length, 0);
    assert.equal(await AppDataSource.getRepository(BankFeed).count(), 0);
  });

  test("refuses another currency, a second copy, and a statement Wise holds back — saying why", async () => {
    const euros = await addWise({ externalAccountId: "30000001:200002" });
    assert.equal(euros.status, 400);
    assert.equal(
      euros.body.error,
      "This balance is in EUR and your books are in USD. Banking brings in USD balances only.",
    );

    assert.equal((await addWise()).status, 200);
    const again = await addWise({ name: "Wise again" });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, "This Wise balance is already on Banking as “Wise USD”.");

    await AppDataSource.getRepository(BankFeed).clear();
    statement = () => respond({}, 403, { "x-2fa-approval": "ott", "x-2fa-approval-result": "REJECTED" });
    const held = await addWise();
    assert.equal(held.status, 400);
    assert.equal(held.body.error, WISE_SCA_MESSAGE);
    assert.equal(await AppDataSource.getRepository(BankFeed).count(), 0);
  });

  test("a Member with read-only finance access can't add one", async () => {
    actingUserId = await member("member", "read");
    const added = await addWise();
    assert.equal(added.status, 403);
    assert.equal(wiseRequests.length, 0);
    assert.equal(await AppDataSource.getRepository(BankFeed).count(), 0);
  });

  test("a Wise balance can't post to anything but an asset account", async () => {
    const revenue = (await accountByCode(company.id, "4000"))!;
    const added = await addWise({ accountId: revenue.id });
    assert.equal(added.status, 400);
    assert.equal(added.body.error, "Bank feeds reconcile against asset accounts only");
  });
});

describe("POST /bank-feeds/:id/sync for a Wise balance", () => {
  test("brings the transactions in, and the account shows them waiting", async () => {
    const added = await addWise();
    const feedId = added.body.id as string;

    const synced = await call("POST", `/bank-feeds/${feedId}/sync`);
    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body, { inserted: 2, matched: 0 });

    const listed = await call("GET", `/bank-transactions?feedId=${feedId}`);
    assert.equal(listed.status, 200);
    const rows = listed.body as unknown as Array<{ reference: string; amountCents: number }>;
    assert.deepEqual(
      rows.map((row) => [row.reference, row.amountCents]),
      [
        ["CARD-2", -4_210],
        ["TRANSFER-1", 120_000],
      ],
    );

    const accounts = await call("GET", "/banking/accounts");
    const wise = (accounts.body as unknown as Array<{ kind: string; feed: { id: string }; toReview: number; total: number }>)
      .find((account) => account.feed.id === feedId);
    assert.deepEqual(
      wise && { kind: wise.kind, toReview: wise.toReview, total: wise.total },
      { kind: "bank", toReview: 2, total: 2 },
    );

    // A second update finds nothing new.
    assert.deepEqual((await call("POST", `/bank-feeds/${feedId}/sync`)).body, {
      inserted: 0,
      matched: 0,
    });
  });

  test("an update Wise refuses reports why and changes nothing", async () => {
    const added = await addWise();
    const feedId = added.body.id as string;
    statement = () => respond({ error: "invalid_token" }, 401);
    const synced = await call("POST", `/bank-feeds/${feedId}/sync`);
    assert.equal(synced.status, 400);
    assert.match(synced.body.error ?? "", /Wise rejected the API token/);
    const feed = await AppDataSource.getRepository(BankFeed).findOneByOrFail({ id: feedId });
    assert.equal(feed.lastSyncAt, null);
  });
});
