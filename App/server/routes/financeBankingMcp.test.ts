import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Account } from "../db/entities/Account.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { BankFeed } from "../db/entities/BankFeed.js";
import { BankTransaction } from "../db/entities/BankTransaction.js";
import { CardFeed } from "../db/entities/CardFeed.js";
import { CardTransaction } from "../db/entities/CardTransaction.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeFinanceGrant, FINANCE_ACCESS_RANK } from "../db/entities/EmployeeFinanceGrant.js";
import { LedgerEntry } from "../db/entities/LedgerEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames, toolGrantRequirements } from "../services/agent/tools/grantDead.js";
import { retryCardTransaction } from "../services/cardExpenses.js";
import { accountByCode, seedChartOfAccounts } from "../services/ledger.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * An AI Employee does the Banking page's bookkeeping itself: it reads the To
 * review queue, files bank lines and card purchases under categories, keeps a
 * card's default category, and approves what that posted in Entry review —
 * through the same helpers a Member's clicks use, with no human sign-off
 * after it.
 */

const DAY = new Date("2026-10-14T00:00:00Z");

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let grant: EmployeeFinanceGrant;
let software: Account;
let bankFeed: BankFeed;
let cardFeed: CardFeed;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Bookkeeper",
    soulBody: "",
  });
  grant = await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "full",
  });
  await seedChartOfAccounts(company.id);
  software = await insert(Account, {
    companyId: company.id,
    code: "6300",
    name: "Software",
    type: "expense",
  });
  bankFeed = await insert(BankFeed, {
    companyId: company.id,
    name: "Checking",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: (await accountByCode(company.id, "1100"))!.id,
  });
  cardFeed = await insert(CardFeed, {
    companyId: company.id,
    name: "Brex card",
    kind: "brex_card",
    connectionId: "conn",
    liabilityAccountId: (await accountByCode(company.id, "2300"))!.id,
    defaultExpenseAccountId: (await accountByCode(company.id, "6000"))!.id,
    paymentAccountId: (await accountByCode(company.id, "1100"))!.id,
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function callTool(name: string, body: Record<string, unknown> = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown> & { error?: string },
  };
}

async function bankLine(amountCents: number, description: string): Promise<BankTransaction> {
  return insert(BankTransaction, {
    companyId: company.id,
    feedId: bankFeed.id,
    externalId: null,
    date: DAY,
    amountCents,
    description,
    reference: "",
    raw: "",
  });
}

/** A card purchase as a sync leaves it: posted under the card's default category, waiting. */
async function cardPurchase(description: string): Promise<CardTransaction> {
  const posted = await retryCardTransaction(
    await insert(CardTransaction, {
      companyId: company.id,
      feedId: cardFeed.id,
      externalId: randomUUID(),
      postedAt: DAY,
      amountCents: 2_500,
      currency: "USD",
      description,
      accountingKind: "expense",
      expenseAccountId: cardFeed.defaultExpenseAccountId,
    }),
  );
  posted.needsReview = true;
  return AppDataSource.getRepository(CardTransaction).save(posted);
}

type QueueRow = {
  kind: string;
  id: string;
  amountCents: number;
  status: string;
  category: { code: string } | null;
};

test("the To review queue lists bank lines and card purchases, signed from the company's side", async () => {
  const line = await bankLine(-4_200, "GITHUB");
  const card = await cardPurchase("Delta Air Lines");

  const result = await callTool("list_banking_transactions");
  assert.equal(result.status, 200, result.body.error);
  const rows = result.body.transactions as QueueRow[];
  assert.deepEqual(
    rows.map((row) => [row.kind, row.id, row.amountCents, row.status]).sort(),
    [
      ["bank", line.id, -4_200, "review"],
      ["card", card.id, -2_500, "review"],
    ].sort(),
  );
  assert.equal(rows.find((row) => row.kind === "card")?.category?.code, "6000");

  const accounts = await callTool("list_banking_accounts");
  assert.equal(accounts.status, 200, accounts.body.error);
  assert.deepEqual(
    (accounts.body.accounts as Array<{ name: string; toReview: number }>).map((account) => [
      account.name,
      account.toReview,
    ]),
    [
      ["Checking", 1],
      ["Brex card", 1],
    ],
  );
});

test("categorizing clears Banking, and approving what it posted needs nobody after the AI", async () => {
  const line = await bankLine(-4_200, "GITHUB");
  const card = await cardPurchase("Figma");

  const categorized = await callTool("categorize_banking_transactions", {
    accountId: software.id,
    bankTransactionIds: [line.id],
    cardTransactionIds: [card.id],
  });
  assert.equal(categorized.status, 200, categorized.body.error);
  assert.deepEqual(categorized.body.succeeded, { bank: [line.id], card: [card.id] });
  assert.deepEqual(categorized.body.skipped, []);

  const queue = await callTool("list_banking_transactions");
  assert.deepEqual(queue.body.transactions, []);
  const done = await callTool("list_banking_transactions", { status: "done" });
  assert.deepEqual(
    (done.body.transactions as QueueRow[]).map((row) => row.category?.code),
    ["6300", "6300"],
  );

  // Entry review: everything Banking posted, approved in one call, final.
  const unreviewed = await AppDataSource.getRepository(LedgerEntry).find({
    where: { companyId: company.id, reviewStatus: "unreviewed" },
  });
  assert.ok(unreviewed.length >= 2);
  const approved = await callTool("review_finance_transactions", {
    transactionIds: unreviewed.map((entry) => entry.id),
  });
  assert.equal(approved.status, 200, approved.body.error);
  assert.deepEqual((approved.body.approved as string[]).sort(), unreviewed.map((e) => e.id).sort());
  for (const entry of await AppDataSource.getRepository(LedgerEntry).findBy({
    companyId: company.id,
  })) {
    assert.equal(entry.reviewStatus, "approved", entry.source);
  }
  const stored = await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
    id: unreviewed[0].id,
  });
  assert.equal(stored.approvedById, null);
  assert.equal(stored.reviewedByEmployeeId, employee.id);

  const audit = await AppDataSource.getRepository(AuditEvent).findBy({
    companyId: company.id,
    actorEmployeeId: employee.id,
  });
  const actions = audit.map((row) => row.action);
  assert.ok(actions.includes("finance.bank_transaction.categorize"));
  assert.ok(actions.includes("finance.banking.bulk_categorize"));
  assert.ok(actions.includes("finance.transaction.bulk_approve"));
});

test("a single review posts its category change at once and locks the entry", async () => {
  const general = (await accountByCode(company.id, "6000"))!;
  const bank = (await accountByCode(company.id, "1100"))!;
  const entry = await insert(LedgerEntry, {
    companyId: company.id,
    date: DAY,
    memo: "Adobe",
    source: "manual",
    reviewStatus: "unreviewed",
  });
  const { LedgerLine } = await import("../db/entities/LedgerLine.js");
  const expense = await insert(LedgerLine, {
    companyId: company.id,
    ledgerEntryId: entry.id,
    accountId: general.id,
    debitCents: 900,
  });
  await insert(LedgerLine, {
    companyId: company.id,
    ledgerEntryId: entry.id,
    accountId: bank.id,
    creditCents: 900,
  });

  const reviewed = await callTool("review_finance_transaction", {
    transactionId: entry.id,
    changes: [{ lineId: expense.id, accountId: software.id }],
    note: "Adobe is software.",
  });
  assert.equal(reviewed.status, 200, reviewed.body.error);
  assert.equal(reviewed.body.status, "approved");
  const reclass = await AppDataSource.getRepository(LedgerEntry).findOneByOrFail({
    companyId: company.id,
    source: "ledger_reclass",
    sourceRefId: entry.id,
  });
  assert.equal(reclass.reviewStatus, "approved");

  const again = await callTool("review_finance_transaction", { transactionId: entry.id });
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "already_approved");
});

test("a locked card entry points the AI at Banking instead of refusing without a way out", async () => {
  const card = await cardPurchase("Delta Air Lines");
  const { LedgerLine } = await import("../db/entities/LedgerLine.js");
  const [expenseLine] = await AppDataSource.getRepository(LedgerLine).findBy({
    ledgerEntryId: card.ledgerEntryId!,
    accountId: cardFeed.defaultExpenseAccountId,
  });
  const result = await callTool("review_finance_transaction", {
    transactionId: card.ledgerEntryId!,
    changes: [{ lineId: expenseLine.id, accountId: software.id }],
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error!, /categorize_banking_transactions/);
});

test("marking reviewed keeps a card's default category; a bank line needs one first", async () => {
  const line = await bankLine(-1_000, "Coffee");
  const card = await cardPurchase("Office supplies");
  const result = await callTool("mark_banking_transactions_reviewed", {
    bankTransactionIds: [line.id],
    cardTransactionIds: [card.id],
  });
  assert.equal(result.status, 200, result.body.error);
  assert.deepEqual(result.body.succeeded, { bank: [], card: [card.id] });
  assert.deepEqual(
    (result.body.skipped as Array<{ id: string }>).map((skip) => skip.id),
    [line.id],
  );
  const stored = await AppDataSource.getRepository(CardTransaction).findOneByOrFail({ id: card.id });
  assert.equal(stored.needsReview, false);
  assert.equal(stored.expenseAccountId, cardFeed.defaultExpenseAccountId);
});

test("undo puts a categorized bank line back in To review", async () => {
  const line = await bankLine(-4_200, "GITHUB");
  await callTool("categorize_banking_transactions", {
    accountId: software.id,
    bankTransactionIds: [line.id],
  });
  const undone = await callTool("undo_bank_transaction", { transactionId: line.id });
  assert.equal(undone.status, 200, undone.body.error);
  const stored = await AppDataSource.getRepository(BankTransaction).findOneByOrFail({ id: line.id });
  assert.equal(stored.reconciledAt, null);
});

test("finance levels gate Banking exactly like the rest of Finance", async () => {
  const line = await bankLine(-4_200, "GITHUB");
  grant.accessLevel = "read";
  await AppDataSource.getRepository(EmployeeFinanceGrant).save(grant);

  assert.equal((await callTool("list_banking_transactions")).status, 200);
  const refused = await callTool("categorize_banking_transactions", {
    accountId: software.id,
    bankTransactionIds: [line.id],
  });
  assert.equal(refused.status, 403);
  assert.equal((await callTool("review_finance_transactions", { transactionIds: [randomUUID()] })).status, 403);

  // Levels answer at dispatch and in retry preflight; with no grant at all,
  // every Banking tool reads as dead.
  const rank = (name: string) =>
    toolGrantRequirements(name).find((requirement) => requirement.family === "finance")?.rank;
  assert.equal(rank("list_banking_transactions"), FINANCE_ACCESS_RANK.read);
  assert.equal(rank("pay_invoices_from_bank_transaction"), FINANCE_ACCESS_RANK.invoice);
  assert.equal(rank("categorize_banking_transactions"), FINANCE_ACCESS_RANK.full);
  assert.equal(rank("review_finance_transactions"), FINANCE_ACCESS_RANK.full);
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ id: grant.id });
  const dead = await deadToolNames(employee.id, true);
  assert.equal(dead.has("list_banking_transactions"), true);
  assert.equal(dead.has("categorize_banking_transactions"), true);
});

test("in a Member's chat, approving needs an owner or admin, as Entry review does", async () => {
  const user = await insert(User, {
    name: "Member",
    email: "member@example.com",
    passwordHash: "hash",
    sessionVersion: 0,
  });
  const member = await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role: "member",
    financeAccess: "full",
  });
  revokeMcpToken(token);
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: user.id,
    requesterSessionVersion: 0,
  });
  const line = await bankLine(-4_200, "GITHUB");
  const categorized = await callTool("categorize_banking_transactions", {
    accountId: software.id,
    bankTransactionIds: [line.id],
  });
  assert.equal(categorized.status, 200, categorized.body.error);
  const entryId = (
    await AppDataSource.getRepository(BankTransaction).findOneByOrFail({ id: line.id })
  ).matchedLedgerEntryId!;
  assert.equal((await callTool("review_finance_transaction", { transactionId: entryId })).status, 403);

  member.role = "admin";
  await AppDataSource.getRepository(Membership).save(member);
  const approved = await callTool("review_finance_transaction", { transactionId: entryId });
  assert.equal(approved.status, 200, approved.body.error);
});
