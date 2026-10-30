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
import { Company } from "../db/entities/Company.js";
import { EmployeeFinanceGrant, FINANCE_ACCESS_RANK } from "../db/entities/EmployeeFinanceGrant.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { deadToolNames, toolGrantRequirements } from "../services/agent/tools/grantDead.js";
import { accountByCode, postLedgerEntry, seedChartOfAccounts } from "../services/ledger.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * "Still waiting on you: three accounts — 1400 Digital Assets, 1500 Due from
 * Affiliate, 6085 Rent." An AI Employee with full Finance access now adds the
 * account itself and files the transactions waiting on it, under the rules a
 * Member's Finance → Accounts follows, audited and journaled like the rest of
 * its bookkeeping. Read and invoice access still cannot change the chart.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let grant: EmployeeFinanceGrant;

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

type ToolAccount = {
  id: string;
  code: string;
  name: string;
  type: string;
  system: boolean;
  archived: boolean;
};

test("adds the three missing accounts, then files the bank line waiting on one of them", async () => {
  for (const [code, name, type] of [
    ["1400", "Digital Assets", "asset"],
    ["1500", "Due from Affiliate", "asset"],
    ["6085", "Rent", "expense"],
  ]) {
    const created = await callTool("create_finance_account", { code, name, type });
    assert.equal(created.status, 200, created.body.error);
    const account = created.body.account as ToolAccount;
    assert.deepEqual(
      [account.code, account.name, account.type, account.system, account.archived],
      [code, name, type, false, false],
    );
  }
  const listed = await callTool("list_finance_accounts");
  const codes = (listed.body.accounts as ToolAccount[]).map((account) => account.code);
  assert.ok(
    ["1400", "1500", "6085"].every((code) => codes.includes(code)),
    "the chart lists them",
  );
  assert.equal(
    (listed.body.accounts as ToolAccount[]).find((account) => account.code === "1100")?.system,
    true,
  );

  // The $950k intercompany transfer can now be filed.
  const feed = await insert(BankFeed, {
    companyId: company.id,
    name: "Wise",
    kind: "csv",
    connectionId: null,
    externalAccountId: null,
    accountId: (await accountByCode(company.id, "1100"))!.id,
  });
  const transfer = await insert(BankTransaction, {
    companyId: company.id,
    feedId: feed.id,
    externalId: null,
    date: new Date("2023-07-01T00:00:00Z"),
    amountCents: -95_000_000,
    description: "Intercompany transfer",
    reference: "",
    raw: "",
  });
  const due = (await accountByCode(company.id, "1500"))!;
  const filed = await callTool("categorize_banking_transactions", {
    accountId: due.id,
    bankTransactionIds: [transfer.id],
  });
  assert.equal(filed.status, 200, filed.body.error);
  assert.deepEqual((filed.body.succeeded as { bank: string[] }).bank, [transfer.id]);

  // Audited as the AI Employee, and in its Journal.
  const audits = await AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: company.id, action: "finance.account.create" },
  });
  assert.equal(audits.length, 3);
  assert.ok(
    audits.every((audit) => audit.actorEmployeeId === employee.id),
    "audited as the employee",
  );
  assert.ok(
    audits.some((audit) => audit.targetLabel === "6085 Rent"),
    "names the account",
  );
  const journal = await AppDataSource.getRepository(JournalEntry).find({
    where: { employeeId: employee.id },
  });
  assert.ok(
    journal.some((entry) => entry.title.includes("added account 6085 Rent")),
    "journaled",
  );
});

test("refuses a code already in the chart, and one that is not a code", async () => {
  const duplicate = await callTool("create_finance_account", {
    code: "6000",
    name: "More G&A",
    type: "expense",
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error!, /6000 General & Administrative/);
  const bad = await callTool("create_finance_account", {
    code: "60 85",
    name: "Rent",
    type: "expense",
  });
  assert.equal(bad.status, 400);
  const blank = await callTool("create_finance_account", {
    code: "6085",
    name: "   ",
    type: "expense",
  });
  assert.equal(blank.status, 400);
  const wrongType = await callTool("create_finance_account", {
    code: "6085",
    name: "Rent",
    type: "cost",
  });
  assert.equal(wrongType.status, 400);
});

test("nests under a parent of this company only", async () => {
  const parent = (await accountByCode(company.id, "6000"))!;
  const child = await callTool("create_finance_account", {
    code: "6085",
    name: "Rent",
    type: "expense",
    parentId: parent.id,
  });
  assert.equal(child.status, 200, child.body.error);
  assert.equal((child.body.account as { parentId: string }).parentId, parent.id);
  const elsewhere = randomUUID();
  await seedChartOfAccounts(elsewhere);
  const foreign = (await accountByCode(elsewhere, "6000"))!;
  const refused = await callTool("create_finance_account", {
    code: "6086",
    name: "Parking",
    type: "expense",
    parentId: foreign.id,
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error!, /parent/i);
});

test("renames and archives an unused account, but never a system account or one with a balance", async () => {
  const created = await callTool("create_finance_account", {
    code: "6085",
    name: "Rnet",
    type: "expense",
  });
  const rent = created.body.account as ToolAccount;
  const renamed = await callTool("update_finance_account", {
    accountId: rent.id,
    name: "Rent",
    code: "6090",
  });
  assert.equal(renamed.status, 200, renamed.body.error);
  assert.deepEqual(
    [(renamed.body.account as ToolAccount).code, (renamed.body.account as ToolAccount).name],
    ["6090", "Rent"],
  );

  const bank = (await accountByCode(company.id, "1100"))!;
  const renumberSystem = await callTool("update_finance_account", {
    accountId: bank.id,
    code: "1101",
  });
  assert.equal(renumberSystem.status, 409);
  const archiveSystem = await callTool("update_finance_account", {
    accountId: bank.id,
    archived: true,
  });
  assert.equal(archiveSystem.status, 409);
  const retypeSystem = await callTool("update_finance_account", {
    accountId: bank.id,
    type: "expense",
  });
  assert.equal(retypeSystem.status, 409);
  const renameSystem = await callTool("update_finance_account", {
    accountId: bank.id,
    name: "Operating account",
  });
  assert.equal(renameSystem.status, 200, "a system account may be renamed");

  await postLedgerEntry({
    companyId: company.id,
    date: new Date("2023-07-01T00:00:00Z"),
    memo: "Rent",
    source: "manual",
    sourceRefId: null,
    createdById: null,
    lines: [
      { accountId: rent.id, debitCents: 1_000 },
      { accountId: bank.id, creditCents: 1_000 },
    ],
  });
  const withBalance = await callTool("update_finance_account", {
    accountId: rent.id,
    archived: true,
  });
  assert.equal(withBalance.status, 409);
  assert.match(withBalance.body.error!, /still has a balance/);

  const unused = await callTool("create_finance_account", {
    code: "6099",
    name: "Typo",
    type: "expense",
  });
  const archived = await callTool("update_finance_account", {
    accountId: (unused.body.account as ToolAccount).id,
    archived: true,
  });
  assert.equal(archived.status, 200, archived.body.error);
  assert.equal((archived.body.account as ToolAccount).archived, true);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({ action: "finance.account.update" }),
    3,
    "every successful change is audited",
  );
});

test("another company's account is not found", async () => {
  const elsewhere = randomUUID();
  await seedChartOfAccounts(elsewhere);
  const foreign = (await accountByCode(elsewhere, "6000"))!;
  const result = await callTool("update_finance_account", {
    accountId: foreign.id,
    name: "Mine now",
  });
  assert.equal(result.status, 404);
  assert.equal(
    (await AppDataSource.getRepository(Account).findOneByOrFail({ id: foreign.id })).name,
    "General & Administrative",
  );
});

test("needs full Finance access: read and invoice access cannot change the chart", async () => {
  for (const level of ["read", "invoice"] as const) {
    await AppDataSource.getRepository(EmployeeFinanceGrant).update(
      { id: grant.id },
      { accessLevel: level },
    );
    const create = await callTool("create_finance_account", {
      code: "6085",
      name: "Rent",
      type: "expense",
    });
    assert.equal(create.status, 403, level);
    assert.match(create.body.error!, /"full" finance access/);
    const update = await callTool("update_finance_account", {
      accountId: (await accountByCode(company.id, "6000"))!.id,
      name: "Renamed",
    });
    assert.equal(update.status, 403, level);
  }
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ id: grant.id });
  assert.equal(
    (await callTool("create_finance_account", { code: "6085", name: "Rent", type: "expense" }))
      .status,
    403,
  );
  assert.equal(
    await AppDataSource.getRepository(Account).countBy({ companyId: company.id, code: "6085" }),
    0,
  );
});

test("are granular, deferred tools gated on the full Finance level", async () => {
  for (const name of ["create_finance_account", "update_finance_account"]) {
    const tool = STATIC_TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} is in the manifest`);
    assert.equal("op" in tool.inputSchema.properties, false);
    assert.notEqual(tool.readOnly, true);
    assert.equal(
      toolGrantRequirements(name).find((requirement) => requirement.family === "finance")?.rank,
      FINANCE_ACCESS_RANK.full,
    );
  }
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ id: grant.id });
  const dead = await deadToolNames(employee.id, true);
  assert.equal(dead.has("create_finance_account"), true);
  assert.equal(dead.has("update_finance_account"), true);
});
