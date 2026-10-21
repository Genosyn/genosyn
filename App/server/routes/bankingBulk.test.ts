import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Company } from "../db/entities/Company.js";
import { type FinanceAccess, Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { type CardBooks, cardBooks, cardPurchase, reload } from "../test/cardFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { financeRouter } from "./finance.js";

/**
 * Banking's bulk bar over HTTP. Only full finance access can use it, the body
 * is checked before anything runs, and each bank transaction it categorizes
 * leaves the audit row its own Categorize would.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let books: CardBooks;
let bankLine: BankTransaction;
let card: CardTransaction;

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
    name: "Bulk test",
    slug: `bulk-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  actingUserId = await member("owner");
  books = await cardBooks(company.id);
  const feed = await insert(BankFeed, {
    companyId: company.id,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: books.bank.id,
  });
  bankLine = await insert(BankTransaction, {
    companyId: company.id,
    feedId: feed.id,
    externalId: null,
    date: new Date("2026-03-18T00:00:00Z"),
    amountCents: -4_200,
    description: "GITHUB",
    reference: "",
    raw: "",
  });
  card = (await cardPurchase(books.feed, { cents: 12_000 })).card;
});

async function bulk(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/banking/bulk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

test("categorizes a selection and answers with what went through", async () => {
  const response = await bulk({
    action: "categorize",
    accountId: books.software.id,
    bankTransactionIds: [bankLine.id],
    cardTransactionIds: [card.id],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    action: "categorize",
    succeeded: { bank: [bankLine.id], card: [card.id] },
    skipped: [],
  });
  assert.ok((await reload(BankTransaction, bankLine.id)).reconciledAt);
  assert.equal((await reload(CardTransaction, card.id)).expenseAccountId, books.software.id);

  const audit = await AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: company.id },
  });
  assert.deepEqual(audit.map((row) => [row.action, row.targetId]).sort(), [
    ["finance.bank_transaction.categorize", bankLine.id],
    ["finance.banking.bulk_categorize", null],
  ]);
});

test("only full finance access can use the bulk bar", async () => {
  actingUserId = await member("member", "read");
  const response = await bulk({ action: "send_to_review", cardTransactionIds: [card.id] });
  assert.equal(response.status, 403);
  assert.equal((await reload(CardTransaction, card.id)).needsReview, false);
});

test("checks the body before anything runs", async () => {
  for (const body of [
    { action: "categorize", cardTransactionIds: [card.id] },
    { action: "mark_reviewed" },
    { action: "approve", cardTransactionIds: [card.id] },
    {
      action: "mark_reviewed",
      cardTransactionIds: Array.from({ length: 201 }, () => randomUUID()),
    },
    {
      action: "mark_reviewed",
      bankTransactionIds: Array.from({ length: 150 }, () => randomUUID()),
      cardTransactionIds: Array.from({ length: 51 }, () => randomUUID()),
    },
  ]) {
    const response = await bulk(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(response.body.error, "ValidationError");
  }
  assert.equal((await reload(CardTransaction, card.id)).expenseAccountId, books.general.id);
});

test("a category from another company is not found", async () => {
  const response = await bulk({
    action: "categorize",
    accountId: randomUUID(),
    cardTransactionIds: [card.id],
  });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Category not found");
});
