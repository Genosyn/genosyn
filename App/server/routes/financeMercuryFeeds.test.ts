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
import type { MercuryAccount, MercuryTransaction } from "../integrations/providers/mercury.js";
import { errorHandler } from "../middleware/error.js";
import { encryptConnectionConfig } from "../services/integrations.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * Adding a Mercury account on Banking over HTTP: the picker's list, the checks
 * the server makes before saving a feed, who may do either, and a sync that
 * brings the account's transactions in.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let connection: IntegrationConnection;
let bank: Account;

const originalFetch = globalThis.fetch;
const TOKEN = "secret-token:mercury_production_rma_route";
const CHECKING_ID = "8f3c2a8e-7b6d-4c5e-9f1a-2b3c4d5e6f70";
const CLOSED_ID = "0f0f0f0f-1e1e-4d2d-8c3c-4b4b4b4b4b4b";

const CHECKING: MercuryAccount = {
  id: CHECKING_ID,
  name: "Mercury Checking ••1234",
  nickname: null,
  status: "active",
  type: "mercury",
  kind: "checking",
  accountNumber: "202211111234",
  routingNumber: "091311229",
  availableBalance: 2_400,
  currentBalance: 2_500,
  legalBusinessName: "Acme Inc",
};
const CLOSED: MercuryAccount = { ...CHECKING, id: CLOSED_ID, name: "Old checking", status: "deleted" };

let mercuryRequests: URL[] = [];
let transactions: () => Response;

function mercuryTxn(id: string, daysAgo: number, amount: number): MercuryTransaction {
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  return {
    id,
    accountId: CHECKING_ID,
    amount,
    status: "sent",
    createdAt: at,
    postedAt: at,
    counterpartyName: amount < 0 ? "Gusto" : "Globex Corp",
    bankDescription: amount < 0 ? "GUSTO PAYROLL" : "GLOBEX CORP",
  };
}

before(async () => {
  await initTestDb();
  // Requests to Mercury are answered here; the test's own requests to the
  // router go to the real loopback server.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "api.mercury.com") return originalFetch(input, init);
    mercuryRequests.push(url);
    if (url.pathname === "/api/v1/accounts") return Response.json({ accounts: [CHECKING, CLOSED], page: {} });
    if (url.pathname === "/api/v1/transactions") return transactions();
    return Response.json({ errors: { message: "unexpected" } }, { status: 500 });
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
  mercuryRequests = [];
  // Dated once: the same transactions answer every sync.
  const page = [mercuryTxn("11111111-0000-4000-8000-000000000001", 5, 1_200), mercuryTxn("11111111-0000-4000-8000-000000000002", 3, -42.1)];
  transactions = () => Response.json({ transactions: page, page: {} });
  company = await insert(Company, {
    name: "Mercury test",
    slug: `mercury-test-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  actingUserId = await member("owner");
  await seedChartOfAccounts(company.id);
  bank = (await accountByCode(company.id, "1100"))!;
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "mercury",
    label: "Mercury",
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

function addMercury(values: Record<string, unknown> = {}) {
  return call("POST", "/bank-feeds", {
    name: "Mercury checking",
    kind: "mercury_account",
    accountId: bank.id,
    connectionId: connection.id,
    externalAccountId: CHECKING_ID,
    ...values,
  });
}

describe("GET /bank-feeds/mercury-accounts", () => {
  test("lists the Connection's accounts for anyone who can read the finances", async () => {
    actingUserId = await member("member", "read");
    const listed = await call("GET", `/bank-feeds/mercury-accounts?connectionId=${connection.id}`);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [
      {
        id: CHECKING_ID,
        name: "Mercury Checking ••1234",
        kind: "checking",
        accountNumberLast4: "1234",
        currentCents: 250_000,
        availableCents: 240_000,
        unavailableReason: null,
      },
      {
        id: CLOSED_ID,
        name: "Old checking",
        kind: "checking",
        accountNumberLast4: "1234",
        currentCents: 250_000,
        availableCents: 240_000,
        unavailableReason: "Closed in Mercury",
      },
    ]);
  });

  test("needs a real Connection id, and a Member without finance access sees nothing", async () => {
    const bad = await call("GET", "/bank-feeds/mercury-accounts?connectionId=nope");
    assert.equal(bad.status, 400);
    const unknown = await call("GET", `/bank-feeds/mercury-accounts?connectionId=${randomUUID()}`);
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "Mercury Connection not found");

    actingUserId = await member("member", "none");
    const hidden = await call("GET", `/bank-feeds/mercury-accounts?connectionId=${connection.id}`);
    assert.equal(hidden.status, 403);
    assert.equal(mercuryRequests.length, 0);
  });
});

describe("POST /bank-feeds for a Mercury account", () => {
  test("saves the feed once the token reads the account's transactions", async () => {
    const added = await addMercury();
    assert.equal(added.status, 200);
    assert.equal(added.body.kind, "mercury_account");
    assert.equal(added.body.connectionId, connection.id);
    assert.equal(added.body.externalAccountId, CHECKING_ID);
    assert.ok(mercuryRequests.some((url) => url.pathname === "/api/v1/transactions"));
    const saved = await AppDataSource.getRepository(BankFeed).findOneByOrFail({
      id: added.body.id as string,
    });
    assert.equal(saved.companyId, company.id);
    assert.equal(saved.lastSyncAt, null);
  });

  test("needs the Connection and the account, and refuses a closed one or a second copy", async () => {
    const noConnection = await addMercury({ connectionId: null });
    assert.equal(noConnection.status, 400);
    assert.equal(noConnection.body.error, "Mercury feeds need a connectionId");
    const noAccount = await addMercury({ externalAccountId: null });
    assert.equal(noAccount.status, 400);
    assert.equal(noAccount.body.error, "Mercury feeds need an account");

    const closed = await addMercury({ externalAccountId: CLOSED_ID });
    assert.equal(closed.status, 400);
    assert.equal(closed.body.error, "That Mercury account is closed");

    assert.equal((await addMercury()).status, 200);
    const again = await addMercury({ name: "Mercury again" });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, "This Mercury account is already on Banking as “Mercury checking”.");
    assert.equal(await AppDataSource.getRepository(BankFeed).count(), 1);
  });

  test("a Member with read-only finance access can't add one", async () => {
    actingUserId = await member("member", "read");
    const added = await addMercury();
    assert.equal(added.status, 403);
    assert.equal(mercuryRequests.length, 0);
    assert.equal(await AppDataSource.getRepository(BankFeed).count(), 0);
  });
});

describe("POST /bank-feeds/:id/sync for a Mercury account", () => {
  test("brings the transactions in, then finds nothing new", async () => {
    const added = await addMercury();
    const feedId = added.body.id as string;

    const synced = await call("POST", `/bank-feeds/${feedId}/sync`);
    assert.equal(synced.status, 200);
    assert.deepEqual(synced.body, { inserted: 2, matched: 0 });

    const listed = await call("GET", `/bank-transactions?feedId=${feedId}`);
    const rows = listed.body as unknown as Array<{ description: string; amountCents: number }>;
    assert.deepEqual(
      rows.map((row) => [row.description, row.amountCents]),
      [
        ["Gusto", -4_210],
        ["Globex Corp", 120_000],
      ],
    );
    assert.deepEqual((await call("POST", `/bank-feeds/${feedId}/sync`)).body, {
      inserted: 0,
      matched: 0,
    });
  });

  test("a sync Mercury refuses reports why and changes nothing", async () => {
    const added = await addMercury();
    const feedId = added.body.id as string;
    transactions = () =>
      Response.json({ errors: { errorCode: "invalidToken", message: "Invalid token" } }, { status: 401 });
    const synced = await call("POST", `/bank-feeds/${feedId}/sync`);
    assert.equal(synced.status, 400);
    assert.equal(synced.body.error, "Mercury rejected the API token");
    assert.equal(synced.body.kind, "auth");
    const feed = await AppDataSource.getRepository(BankFeed).findOneByOrFail({ id: feedId });
    assert.equal(feed.lastSyncAt, null);
  });
});
