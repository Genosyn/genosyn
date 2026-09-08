import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { Company } from "../../db/entities/Company.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { EmployeeRevenueGrant } from "../../db/entities/EmployeeRevenueGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Repository } from "../../db/entities/Repository.js";
import { Routine } from "../../db/entities/Routine.js";
import { RoutineTrigger } from "../../db/entities/RoutineTrigger.js";
import { Run } from "../../db/entities/Run.js";
import { Standdown } from "../../db/entities/Standdown.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { enqueueInboundAutomation, waitForMailAutomation } from "../mail/automationQueue.js";
import { refreshStanddowns } from "../standdowns.js";
import {
  bootProactiveDefaults,
  reconcileProactiveDefaults,
  stopProactiveDefaults,
  sweepProactiveDefaults,
} from "./defaults.js";
import { getProactiveOverview } from "./setup.js";
import { proactiveScope } from "./scopes.js";

before(initTestDb);
beforeEach(async () => {
  stopProactiveDefaults();
  await resetTestDb();
  await refreshStanddowns();
});
after(async () => {
  stopProactiveDefaults();
  await closeTestDb();
});

async function company() {
  return insert(Company, { name: "Default work", slug: randomUUID(), ownerId: randomUUID() });
}

async function worker(companyId: string, account?: MailAccount, businessGrants = true) {
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Customer operations",
    slug: randomUUID(),
    role: "Customer operations",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "fixture",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "fixture-only-no-network" }),
  });
  if (account)
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "send",
    });
  if (businessGrants) {
    await insert(EmployeeFinanceGrant, {
      companyId,
      employeeId: employee.id,
      accessLevel: "invoice",
    });
    await insert(EmployeeRevenueGrant, {
      companyId,
      employeeId: employee.id,
      accessLevel: "write",
    });
    const repository = await insert(Repository, {
      companyId,
      name: "Product",
      slug: randomUUID(),
      origin: "local",
      gitUrl: "",
    });
    await insert(EmployeeRepositoryGrant, {
      employeeId: employee.id,
      repositoryId: repository.id,
      accessLevel: "write",
    });
    const calendar = await insert(CalendarAccount, { companyId, connectionId: randomUUID() });
    await insert(EmployeeCalendarGrant, {
      employeeId: employee.id,
      accountId: calendar.id,
      accessLevel: "read",
    });
  }
  return employee;
}

async function readyCompany() {
  const row = await company();
  const account = await insert(MailAccount, {
    companyId: row.id,
    connectionId: randomUUID(),
    address: "requests@example.test",
    status: "active",
    aiAnalysisEnabled: true,
  });
  const employee = await worker(row.id, account);
  return { company: row, account, employee };
}

async function message(account: MailAccount) {
  const thread = await insert(MailThread, {
    companyId: account.companyId,
    accountId: account.id,
    gmailThreadId: randomUUID(),
  });
  return insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailThreadId: thread.gmailThreadId,
    gmailMessageId: randomUUID(),
    fromEmail: "customer@example.test",
    toEmails: account.address,
    subject: "Please quote for our order",
  });
}

async function assertNativeDefaults(companyId: string) {
  const overview = await getProactiveOverview(companyId);
  assert.equal(overview.automaticSetup, true);
  assert.equal(overview.installations.length, 11);
  assert.equal(Object.keys(overview.defaultAssignments).length, 11);
  const rules = await AppDataSource.getRepository(MailRule).findBy({ companyId });
  assert.equal(rules.length, 5);
  for (const rule of rules) {
    assert.equal(rule.enabled, true);
    assert.equal(rule.createdByUserId, null);
    assert.equal(JSON.parse(rule.actionsJson)[0].mode, "work");
  }
  const routines = await AppDataSource.getRepository(Routine).findBy({
    employeeId: overview.employees[0].id,
  });
  assert.equal(routines.length, 6);
  for (const routine of routines) {
    assert.equal(routine.enabled, true);
    assert.equal(routine.mailDeliveryMode, "draft");
    assert.ok(routine.nextRunAt instanceof Date);
  }
  assert.equal(await AppDataSource.getRepository(RoutineTrigger).countBy({ companyId }), 4);
  assert.equal(await AppDataSource.getRepository(Run).count(), 0);
  return overview;
}

test("boot activates existing ready companies and later discovery activates newly created companies", async () => {
  const existing = await readyCompany();
  assert.equal(existing.company.proactiveAutoSetup, true);
  await bootProactiveDefaults();
  stopProactiveDefaults();
  const first = await assertNativeDefaults(existing.company.id);
  const later = await readyCompany();
  await sweepProactiveDefaults();
  await assertNativeDefaults(later.company.id);
  assert.deepEqual(
    (await getProactiveOverview(existing.company.id)).defaultAssignments,
    first.defaultAssignments,
  );
});

test("multiple eligible employees get one stable owner for each company and mailbox responsibility", async () => {
  const fixture = await readyCompany();
  const preferred = await worker(fixture.company.id, fixture.account);
  await AppDataSource.getRepository(MailAccount).update(fixture.account.id, {
    aiAnalysisEmployeeId: preferred.id,
  });
  await Promise.all([
    reconcileProactiveDefaults(fixture.company.id),
    reconcileProactiveDefaults(fixture.company.id),
  ]);
  const overview = await getProactiveOverview(fixture.company.id);
  for (const recipe of overview.recipes.filter((row) => row.id !== "work-followthrough")) {
    const installed = overview.installations.filter((row) => row.recipeId === recipe.id);
    assert.equal(installed.length, 1, recipe.id);
    if (recipe.requirements.includes("mail")) assert.equal(installed[0].employeeId, preferred.id);
  }
  await AppDataSource.getRepository(MailAccount).update(fixture.account.id, {
    aiAnalysisEmployeeId: fixture.employee.id,
  });
  await reconcileProactiveDefaults(fixture.company.id);
  assert.deepEqual(
    (await getProactiveOverview(fixture.company.id)).defaultAssignments,
    overview.defaultAssignments,
  );
});

test("later Grants become ready automatically without replacing existing assignments", async () => {
  const row = await company();
  const employee = await worker(row.id, undefined, false);
  await reconcileProactiveDefaults(row.id);
  const initial = await getProactiveOverview(row.id);
  assert.deepEqual(initial.installations.map((entry) => entry.recipeId).sort(), [
    "discover-improvements",
    "work-followthrough",
  ]);
  const account = await insert(MailAccount, {
    companyId: row.id,
    connectionId: randomUUID(),
    address: "new@example.test",
    aiAnalysisEnabled: true,
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  await sweepProactiveDefaults();
  assert.equal(
    (await getProactiveOverview(row.id)).installations.some(
      (entry) => entry.recipeId === "quote-requests",
    ),
    false,
  );
  await insert(EmployeeFinanceGrant, {
    companyId: row.id,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
  await sweepProactiveDefaults();
  const ready = await getProactiveOverview(row.id);
  assert.ok(ready.installations.some((entry) => entry.recipeId === "quote-requests"));
  for (const [scope, id] of Object.entries(initial.defaultAssignments))
    assert.equal(ready.defaultAssignments[scope], id);
});

test("reconciliation preserves paused custom work and deleted defaults across later sweeps", async () => {
  const fixture = await readyCompany();
  await reconcileProactiveDefaults(fixture.company.id);
  const initial = await getProactiveOverview(fixture.company.id);
  const quote = initial.installations.find((row) => row.recipeId === "quote-requests")!;
  const spam = initial.installations.find((row) => row.recipeId === "spam-cleanup")!;
  const overdue = initial.installations.find((row) => row.recipeId === "overdue-invoices")!;
  await AppDataSource.getRepository(MailRule).update(quote.id, {
    enabled: false,
    name: "Our reviewed quote process",
  });
  await AppDataSource.getRepository(MailRule).delete(spam.id);
  await AppDataSource.getRepository(Routine).delete(overdue.id);
  await sweepProactiveDefaults();
  await reconcileProactiveDefaults(fixture.company.id);
  const saved = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: quote.id });
  assert.equal(saved.enabled, false);
  assert.equal(saved.name, "Our reviewed quote process");
  assert.equal(await AppDataSource.getRepository(MailRule).existsBy({ id: spam.id }), false);
  assert.equal(await AppDataSource.getRepository(Routine).existsBy({ id: overdue.id }), false);
  assert.deepEqual(
    (await getProactiveOverview(fixture.company.id)).defaultAssignments,
    initial.defaultAssignments,
  );
});

test("Standdowns and company automatic-setup opt-out stay pending until released", async () => {
  const fixture = await readyCompany();
  const standdown = await insert(Standdown, {
    companyId: fixture.company.id,
    scope: "company",
    placedAt: new Date(),
  });
  await refreshStanddowns();
  await sweepProactiveDefaults();
  assert.equal((await getProactiveOverview(fixture.company.id)).installations.length, 0);
  await AppDataSource.getRepository(Standdown).update(standdown.id, { liftedAt: new Date() });
  await refreshStanddowns();
  await AppDataSource.getRepository(Company).update(fixture.company.id, {
    proactiveAutoSetup: false,
  });
  await sweepProactiveDefaults();
  assert.equal((await getProactiveOverview(fixture.company.id)).installations.length, 0);
  await AppDataSource.getRepository(Company).update(fixture.company.id, {
    proactiveAutoSetup: true,
  });
  await sweepProactiveDefaults();
  await assertNativeDefaults(fixture.company.id);
});

test("the first incoming message installs defaults before ordinary processing without replaying history", async () => {
  const fixture = await readyCompany();
  const historical = await message(fixture.account);
  const incoming = await message(fixture.account);
  const calls: string[] = [];
  const options = {
    defaultEffects: {
      analyzeInbound: async (_account: MailAccount, current: MailMessage) => {
        assert.equal(
          await AppDataSource.getRepository(MailRule).countBy({ companyId: fixture.company.id }),
          5,
        );
        assert.equal(current.id, incoming.id);
        calls.push("analysis");
        return null;
      },
      applyRules: async () => {
        calls.push("rules");
      },
      dispatchReceived: async () => {
        calls.push("pipelines");
      },
    },
  };
  await enqueueInboundAutomation(incoming, options);
  await waitForMailAutomation(fixture.account.id);
  await enqueueInboundAutomation(incoming, options);
  await waitForMailAutomation(fixture.account.id);
  assert.deepEqual(calls, ["analysis", "rules", "pipelines"]);
  const deliveries = await AppDataSource.getRepository(MailInboundAutomation).find();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].messageId, incoming.id);
  assert.equal(deliveries[0].status, "succeeded");
  assert.equal(
    await AppDataSource.getRepository(MailMessage).existsBy({ id: historical.id }),
    true,
  );
  await assertNativeDefaults(fixture.company.id);
});

test("a temporary setup failure retains incoming mail and existing automation while a later sweep repairs defaults", async (context) => {
  const fixture = await readyCompany();
  const incoming = await message(fixture.account);
  const warning = context.mock.method(console, "warn", () => {});
  const calls: string[] = [];
  await enqueueInboundAutomation(incoming, {
    defaultEffects: {
      reconcileDefaults: async () => {
        throw new Error("Temporary setup storage failure");
      },
      analyzeInbound: async () => {
        calls.push("analysis");
        return null;
      },
      applyRules: async () => {
        calls.push("rules");
      },
      dispatchReceived: async () => {
        calls.push("pipelines");
      },
    },
  });
  await waitForMailAutomation(fixture.account.id);
  assert.equal(warning.mock.callCount(), 1);
  assert.deepEqual(calls, ["analysis", "rules", "pipelines"]);
  const delivery = await AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({
    messageId: incoming.id,
  });
  assert.equal(delivery.status, "succeeded");
  assert.equal(await AppDataSource.getRepository(MailMessage).existsBy({ id: incoming.id }), true);
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);
  await sweepProactiveDefaults();
  const overview = await assertNativeDefaults(fixture.company.id);
  assert.ok(
    overview.defaultAssignments[
      proactiveScope("quote-requests", fixture.account.id, fixture.employee.id)
    ],
  );
  assert.deepEqual(calls, ["analysis", "rules", "pipelines"]);
});
