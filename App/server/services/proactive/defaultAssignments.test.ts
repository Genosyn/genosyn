import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import type { EntityManager } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Company } from "../../db/entities/Company.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { Routine } from "../../db/entities/Routine.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { initTestDb, resetTestDb, closeTestDb, insert } from "../../test/dbHarness.js";
import { initializeProactiveDefaults, readProactiveDefaults } from "./defaultsState.js";
import { proactiveScope } from "./scopes.js";
import { proactiveId, installProactiveStarter, setProactiveAutomaticSetup } from "./setup.js";

let company: Company;
let employee: AIEmployee;
let account: MailAccount;
before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  company = await insert(Company, { name: "Automatic", slug: randomUUID(), ownerId: randomUUID() });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "quotes@example.test",
  });
  employee = await worker();
});
async function worker() {
  const row = await insert(AIEmployee, {
    companyId: company.id,
    name: "Commercial",
    slug: randomUUID(),
    role: "Sales",
  });
  await insert(AIModel, {
    employeeId: row.id,
    provider: "openai",
    model: "fixture",
    isActive: true,
    authMode: "apikey",
    configJson: JSON.stringify({ apiKeyEncrypted: "fixture-only" }),
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: row.id,
    accountId: account.id,
    accessLevel: "send",
  });
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: row.id,
    accessLevel: "invoice",
  });
  return row;
}
function input(employeeId = employee.id, recipeId = "quote-requests") {
  return {
    recipeId,
    employeeId,
    accountId: account.id,
    delivery: "draft" as const,
    instruction: "Prepare accurate work from the actual request and keep its Workstream.",
  };
}
async function savedState() {
  const saved = await AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id });
  return readProactiveDefaults(saved.proactiveDefaultsJson);
}

test("new companies are on by default and automatic work has a system actor and draft ceiling", async () => {
  assert.equal(company.proactiveAutoSetup, true);
  const installed = await installProactiveStarter(company.id, null, input(), { automatic: true });
  const rule = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: installed.id });
  assert.equal(rule.enabled, true);
  assert.equal(rule.createdByUserId, null);
  assert.equal(JSON.parse(rule.actionsJson)[0].mode, "work");
  assert.equal(
    (await savedState()).assignments[proactiveScope("quote-requests", account.id, employee.id)],
    rule.id,
  );
  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    targetId: rule.id,
  });
  assert.equal(audit.actorKind, "system");
  assert.equal(audit.actorUserId, null);
  assert.equal(JSON.parse(audit.metadataJson).automatic, true);
  await assert.rejects(
    installProactiveStarter(
      company.id,
      null,
      { ...input(), delivery: "soul" },
      { automatic: true },
    ),
    /prepares drafts/,
  );
});

test("simultaneous workers claim one mailbox responsibility atomically", async () => {
  const other = await worker();
  const results = await Promise.allSettled([
    installProactiveStarter(company.id, null, input(), { automatic: true }),
    installProactiveStarter(company.id, null, input(other.id), { automatic: true }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 1);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({ action: "proactive.enable" }),
    1,
  );
  assert.equal(Object.keys((await savedState()).assignments).length, 1);
});

for (const scenario of [
  {
    name: "AI Model is disconnected",
    revoke: () => AppDataSource.getRepository(AIModel).delete({ employeeId: employee.id }),
    message: /Connect an active AI Model/,
  },
  {
    name: "mailbox Grant is revoked",
    revoke: () =>
      AppDataSource.getRepository(EmployeeMailAccountGrant).delete({
        employeeId: employee.id,
        accountId: account.id,
      }),
    message: /Grant Draft access/,
  },
]) {
  test(`automatic setup leaves no reservation when its ${scenario.name} after preflight`, async (t) => {
    const transaction = AppDataSource.transaction.bind(AppDataSource);
    // Initial readiness uses the actual database. Revoke at the transaction
    // boundary to simulate an assignment queued behind another writer.
    const intercepted = t.mock.method(
      AppDataSource,
      "transaction",
      async (work: (manager: EntityManager) => Promise<unknown>) => {
        intercepted.mock.restore();
        await scenario.revoke();
        return transaction(work);
      },
    );

    await assert.rejects(
      installProactiveStarter(company.id, null, input(), { automatic: true }),
      scenario.message,
    );
    assert.equal(intercepted.mock.callCount(), 1, "initial readiness passed before revocation");
    assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "proactive.enable" }),
      0,
    );
    assert.deepEqual((await savedState()).assignments, {});
  });
}

test("deletion is durable across reconciliation and a Member can deliberately assign it again", async () => {
  const installed = await installProactiveStarter(company.id, null, input(), { automatic: true });
  await AppDataSource.getRepository(MailRule).delete(installed.id);
  await initializeProactiveDefaults(company.id);
  await assert.rejects(
    installProactiveStarter(company.id, null, input(), { automatic: true }),
    /already assigned or removed/,
  );
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);
  await installProactiveStarter(company.id, company.ownerId, input());
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 1);
});

test("automatic company opt-out cannot alter an existing paused or customized installation", async () => {
  const installed = await installProactiveStarter(company.id, company.ownerId, input());
  await AppDataSource.getRepository(MailRule).update(installed.id, {
    enabled: false,
    name: "My reviewed rule",
  });
  await setProactiveAutomaticSetup(company.id, company.ownerId, false);
  await assert.rejects(
    installProactiveStarter(company.id, null, input(employee.id, "newsletter-cleanup"), {
      automatic: true,
    }),
    /is off/,
  );
  await setProactiveAutomaticSetup(company.id, company.ownerId, true);
  const saved = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: installed.id });
  assert.equal(saved.enabled, false);
  assert.equal(saved.name, "My reviewed rule");
  assert.equal(Object.keys((await savedState()).assignments).length, 1);
});

test("upgrade adopts previously deleted installations once and no longer depends on audit retention", async () => {
  const deletedId = proactiveId(company.id, employee.id, "quote-requests", account.id);
  await insert(AuditEvent, {
    companyId: company.id,
    action: "proactive.enable",
    targetId: deletedId,
    metadataJson: JSON.stringify({
      recipeId: "quote-requests",
      employeeId: employee.id,
      accountId: account.id,
    }),
  });
  await initializeProactiveDefaults(company.id);
  await AppDataSource.getRepository(AuditEvent).clear();
  await initializeProactiveDefaults(company.id);
  assert.equal(
    (await savedState()).assignments[proactiveScope("quote-requests", account.id, employee.id)],
    deletedId,
  );
  await assert.rejects(
    installProactiveStarter(company.id, null, input(), { automatic: true }),
    /already assigned or removed/,
  );
});

test("native category handovers reserve responsibility even when paused and differently named", async () => {
  const rule = await insert(MailRule, {
    companyId: company.id,
    accountId: account.id,
    name: "Our quote process",
    enabled: false,
    conditionsJson: JSON.stringify({ category: "quote_request", from: "preferred.example" }),
    actionsJson: JSON.stringify([
      { type: "handToEmployee", employeeId: employee.id, mode: "draft", instruction: "Custom" },
    ]),
  });
  await initializeProactiveDefaults(company.id);
  assert.equal(
    (await savedState()).assignments[proactiveScope("quote-requests", account.id, employee.id)],
    rule.id,
  );
  await assert.rejects(
    installProactiveStarter(company.id, null, input(), { automatic: true }),
    /already assigned or removed/,
  );
});

test("company responsibilities reserve one owner across mailboxes and retain scheduled delivery limits", async () => {
  const installed = await installProactiveStarter(
    company.id,
    null,
    input(employee.id, "overdue-invoices"),
    { automatic: true },
  );
  const otherMailbox = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "billing@example.test",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: otherMailbox.id,
    accessLevel: "send",
  });
  await assert.rejects(
    installProactiveStarter(
      company.id,
      null,
      { ...input(employee.id, "overdue-invoices"), accountId: otherMailbox.id },
      { automatic: true },
    ),
    /already assigned or removed/,
  );
  const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: installed.id });
  assert.equal(routine.mailDeliveryMode, "draft");
  assert.equal(await AppDataSource.getRepository(Routine).count(), 1);
});

test("mailbox-scoped native Routines are adopted even without an audit receipt", async () => {
  const id = proactiveId(company.id, employee.id, "customer-commitments", account.id);
  await insert(Routine, {
    id,
    employeeId: employee.id,
    name: "Existing commitments",
    slug: `proactive-customer-commitments-${id.slice(0, 8)}`,
    cronExpr: "0 */4 * * *",
    body: "Custom",
    mailDeliveryMode: "draft",
    enabled: false,
  });
  await initializeProactiveDefaults(company.id);
  assert.equal(
    (await savedState()).assignments[
      proactiveScope("customer-commitments", account.id, employee.id)
    ],
    id,
  );
});

test("invalid saved state fails closed and remains intact", async () => {
  await AppDataSource.getRepository(Company).update(company.id, {
    proactiveDefaultsJson: "invalid",
  });
  await assert.rejects(initializeProactiveDefaults(company.id), /could not read/);
  await assert.rejects(
    installProactiveStarter(company.id, null, input(), { automatic: true }),
    /could not read/,
  );
  assert.equal(
    (await AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id }))
      .proactiveDefaultsJson,
    "invalid",
  );
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);
});

test("unrelated company receipts and unknown recipes cannot reserve this company's work", async () => {
  await insert(AuditEvent, {
    companyId: randomUUID(),
    action: "proactive.enable",
    targetId: randomUUID(),
    metadataJson: JSON.stringify({
      recipeId: "quote-requests",
      employeeId: employee.id,
      accountId: account.id,
    }),
  });
  await insert(AuditEvent, {
    companyId: company.id,
    action: "proactive.enable",
    targetId: randomUUID(),
    metadataJson: JSON.stringify({
      recipeId: "unknown",
      employeeId: employee.id,
      accountId: account.id,
    }),
  });
  await initializeProactiveDefaults(company.id);
  assert.deepEqual((await savedState()).assignments, {});
});
