import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { Company } from "../db/entities/Company.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { undoBankTransaction } from "../services/banking.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts } from "../services/ledger.js";
import { categorizeBankTransaction } from "../services/reconcile.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * Listing reversed entries that still carry a category Entry review gave
 * them: owners and admins read the list, nobody else does, and reading it
 * posts nothing.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;

before(async () => {
  await initTestDb();
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function member(role: Role, financeAccess?: "read" | "full"): Promise<string> {
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

/**
 * A bank transaction undone on Banking, whose Undo Entry review then moved
 * from General & Administrative to Bad Debt Expense, as it could before the
 * fix.
 */
async function undoReviewedBeforeTheFix(): Promise<void> {
  const bank = (await accountByCode(company.id, "1100"))!;
  const general = (await accountByCode(company.id, "6000"))!;
  const badDebt = (await accountByCode(company.id, "6100"))!;
  const feed = await insert(BankFeed, {
    companyId: company.id,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: bank.id,
  });
  const txn = await insert(BankTransaction, {
    companyId: company.id,
    feedId: feed.id,
    externalId: null,
    date: new Date("2026-10-14T00:00:00Z"),
    amountCents: -4_200,
    description: "GITHUB",
    reference: "",
    raw: "",
  });
  await undoBankTransaction(await categorizeBankTransaction(txn, general.id, null), null);
  const undo = await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
    companyId: company.id,
    source: "bank_categorization_void",
  });
  await postLedgerEntry({
    companyId: company.id,
    date: undo.date,
    memo: "Approved category changes for Uncategorize GITHUB",
    source: "ledger_reclass",
    sourceRefId: undo.id,
    reviewStatus: "approved",
    lines: [
      { accountId: general.id, debitCents: 4_200 },
      { accountId: badDebt.id, creditCents: 4_200 },
    ],
  });
}

beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, {
    name: "Drift test",
    slug: `drift-test-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  await seedChartOfAccounts(company.id);
  await undoReviewedBeforeTheFix();
});

type Drift = { kind: string; leftover: Array<{ code: string; cents: number }> };

async function drift(query = ""): Promise<{ status: number; body: { drift?: Drift[]; error?: string } }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/ledger-review-drift${query}`);
  return { status: response.status, body: (await response.json()) as { drift?: Drift[] } };
}

test("owners and admins see what an undone transaction left behind, and nothing is posted", async () => {
  for (const role of ["owner", "admin"] as const) {
    actingUserId = await member(role);
    const entries = await AppDataSource.getRepository(LedgerEntry).count();

    const response = await drift();

    assert.equal(response.status, 200, response.body.error);
    assert.deepEqual(
      response.body.drift?.map((d) => ({
        kind: d.kind,
        leftover: d.leftover.map(({ code, cents }) => ({ code, cents })),
      })),
      [
        {
          kind: "left_behind",
          leftover: [
            { code: "6000", cents: 4_200 },
            { code: "6100", cents: -4_200 },
          ],
        },
      ],
    );
    assert.equal(await AppDataSource.getRepository(LedgerEntry).count(), entries);
  }
});

test("members can't read it, even with full finance access", async () => {
  for (const access of ["full", "read"] as const) {
    actingUserId = await member("member", access);

    const response = await drift();

    assert.equal(response.status, 403);
    assert.equal(response.body.drift, undefined);
  }
});

test("a query it doesn't take is refused", async () => {
  actingUserId = await member("owner");

  assert.equal((await drift("?repair=1")).status, 400);
});
