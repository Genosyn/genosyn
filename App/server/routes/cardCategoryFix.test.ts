import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Company } from "../db/entities/Company.js";
import { type FinanceAccess, Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  balancesByCode,
  type CardBooks,
  cardBooks,
  cardPurchase,
  legacyEntryReview,
  moveOnBanking,
} from "../test/cardFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { cardExpensesRouter } from "./cardExpenses.js";

/**
 * Banking's card category fixes over HTTP. Anyone who can read the company's
 * finances sees the purchases waiting, only full finance access can press
 * Fix, and Fix posts nothing but the entry the person was shown.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let books: CardBooks;
let card: CardTransaction;

const AMOUNT = 12_000;
const SPLIT = { "2300": -AMOUNT, "6000": -AMOUNT, "6200": AMOUNT, "6300": AMOUNT };

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
  app.use("/api/companies/:cid", cardExpensesRouter);
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
  company = await insert(Company, {
    name: "Card fix test",
    slug: `card-fix-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  actingUserId = await member("owner");
  books = await cardBooks(company.id);
  // Entry review moved it to Software, then Banking to Travel.
  const purchase = await cardPurchase(books.feed, { cents: AMOUNT });
  await legacyEntryReview(purchase.posting, books.general, books.software);
  await moveOnBanking(purchase.card, books.travel);
  card = purchase.card;
});

type Line = { accountId: string; debitCents: number; creditCents: number };
type Drift = {
  kind: string;
  transaction: { id: string };
  repair: { kind: string; lines: Line[] } | null;
};
type Body = Record<string, unknown> & { error?: string };

async function call(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function waiting(): Promise<Drift[]> {
  const listed = await call("GET", "/card-transactions/category-drift");
  assert.equal(listed.status, 200);
  return listed.body as Drift[];
}

function fix(lines: Line[], transactionId = card.id) {
  return call("POST", `/card-transactions/${transactionId}/fix-category`, { lines });
}

test("a Member who can read finances sees the purchase waiting, and can't fix it", async () => {
  actingUserId = await member("member", "read");

  const [drift, ...others] = await waiting();
  assert.deepEqual(others, []);
  assert.equal(drift.transaction.id, card.id);
  assert.equal(drift.kind, "split_in_books");

  assert.equal((await fix(drift.repair!.lines)).status, 403);
  assert.deepEqual(await balancesByCode(company.id), SPLIT);
});

test("a Member without finance access doesn't see it", async () => {
  actingUserId = await member("member", "none");

  assert.equal((await call("GET", "/card-transactions/category-drift")).status, 403);
});

test("an owner's Fix posts the entry shown, and nothing is left waiting", async () => {
  const [drift] = await waiting();

  const fixed = await fix(drift.repair!.lines);

  assert.equal(fixed.status, 200, (fixed.body as Body).error);
  assert.equal((fixed.body as Body).expenseAccountId, books.travel.id);
  assert.deepEqual(await balancesByCode(company.id), { "2300": -AMOUNT, "6200": AMOUNT });
  assert.deepEqual(await waiting(), []);
  // Pressed again, there is nothing left to fix.
  const again = await fix(drift.repair!.lines);
  assert.equal(again.status, 409);
  assert.equal(
    (again.body as Body).error,
    "There's nothing to fix: your books hold this purchase under one category",
  );
  assert.deepEqual(await balancesByCode(company.id), { "2300": -AMOUNT, "6200": AMOUNT });
});

test("refuses what isn't an entry, an entry other than the one shown, and another purchase", async () => {
  const [drift] = await waiting();
  const shown = drift.repair!.lines;

  const malformed = await fix([{ accountId: "6000", debitCents: 1.5, creditCents: 0 }]);
  assert.equal(malformed.status, 400);
  const tampered = await fix(
    shown.map((line) => ({
      ...line,
      debitCents: line.debitCents * 2,
      creditCents: line.creditCents * 2,
    })),
  );
  assert.equal(tampered.status, 409);
  assert.match((tampered.body as Body).error ?? "", /changed since you opened it/);
  assert.equal((await fix(shown, randomUUID())).status, 404);
  assert.deepEqual(await balancesByCode(company.id), SPLIT);
});
