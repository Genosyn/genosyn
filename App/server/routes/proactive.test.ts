import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Membership } from "../db/entities/Membership.js";
import { Company } from "../db/entities/Company.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailRule } from "../db/entities/MailRule.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineTrigger } from "../db/entities/RoutineTrigger.js";
import { Repository } from "../db/entities/Repository.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { EmployeeRevenueGrant } from "../db/entities/EmployeeRevenueGrant.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeCalendarGrant } from "../db/entities/EmployeeCalendarGrant.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { initTestDb, resetTestDb, closeTestDb, insert } from "../test/dbHarness.js";
import { errorHandler } from "../middleware/error.js";
import { proactiveRouter } from "./proactive.js";
import { proactiveId, installProactiveStarter } from "../services/proactive/setup.js";
import { PROACTIVE_RECIPES } from "../services/proactive/catalogue.js";
import { LIVE_SYNC_KINDS } from "../db/subscribers/resourceChangeSubscriber.js";
import { MAIL_ANALYSIS_CATEGORIES } from "../services/mail/analysis.js";
import type { ProactiveOverview, ProactiveInstallation } from "../../shared/proactive.js";

let server: Server;
let base = "";
let user: User;
let company: Company;
let employee: AIEmployee;
let account: MailAccount;
let actingUserId: string | null;

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
  app.use("/api/companies/:cid", proactiveRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});
beforeEach(async () => {
  await resetTestDb();
  user = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = user.id;
  company = await insert(Company, {
    name: "Proactive company",
    slug: `proactive-${randomUUID()}`,
    ownerId: user.id,
  });
  await insert(Membership, { companyId: company.id, userId: user.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Maya",
    slug: "maya",
    role: "Operations",
    soulBody: "Prepare accurate work. Draft customer replies.",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "test",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "do-not-serialize-credential" }),
  });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "support@example.com",
    status: "active",
    aiAnalysisEnabled: true,
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel: "draft",
  });
  await insert(EmployeeFinanceGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "invoice",
  });
});
async function request(method = "GET", body?: unknown, suffix = "", cid = company.id) {
  const response = await fetch(`${base}/api/companies/${cid}/proactive${suffix}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}
function input(recipeId = "quote-requests", extra = {}) {
  return {
    recipeId,
    employeeId: employee.id,
    accountId: account.id,
    delivery: "draft" as const,
    instruction: "Read source records. Prepare accurate work and keep a Workstream.",
    ...extra,
  };
}

test("catalogue covers all examples with known classifier categories and resource Triggers", () => {
  assert.equal(new Set(PROACTIVE_RECIPES.map((recipe) => recipe.id)).size, 13);
  for (const recipe of PROACTIVE_RECIPES) {
    if (recipe.category)
      assert.ok((MAIL_ANALYSIS_CATEGORIES as readonly string[]).includes(recipe.category));
    if (recipe.triggerKind) assert.ok(LIVE_SYNC_KINDS.includes(recipe.triggerKind));
    assert.ok(recipe.brief.length > 100);
    assert.ok(recipe.acceptanceCriteria.length > 50);
  }
});
test("overview is scoped and exposes readiness without model credentials or Souls", async () => {
  const other = await insert(AIEmployee, {
    companyId: randomUUID(),
    slug: "foreign",
    name: "Foreign employee",
    role: "Operations",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: randomUUID(),
    accessLevel: "send",
  });
  const { status, body } = await request();
  assert.equal(status, 200);
  const view = body as ProactiveOverview;
  assert.equal(view.recipes.length, 13);
  assert.equal(view.employees.length, 1);
  assert.equal(view.employees[0].modelReady, true);
  assert.equal(view.employees[0].mailGrants.length, 1);
  assert.equal(view.mailboxes[0].analysisReady, true);
  assert.equal(view.mailboxes[0].analysisEmployeeId, employee.id);
  assert.equal(view.automaticSetup, true);
  assert.deepEqual(view.defaultAssignments, {});
  assert.doesNotMatch(JSON.stringify(view), /do-not-serialize|soulBody|configJson/);
  assert.ok(!JSON.stringify(view).includes(other.id));
});
test("authentication and company membership are required", async () => {
  actingUserId = null;
  assert.equal((await request()).status, 401);
  actingUserId = user.id;
  assert.equal((await request("GET", undefined, "", randomUUID())).status, 403);
});

test("automatic setup is an admin-only company setting with strict validation", async () => {
  assert.equal((await request("PATCH", { enabled: false }, "/defaults")).status, 200);
  assert.equal((await request()).body.automaticSetup, false);
  assert.equal(
    (await request("PATCH", { enabled: true, defaultAssignments: {} }, "/defaults")).status,
    400,
  );
  assert.equal((await request("PATCH", { enabled: "true" }, "/defaults")).status, 400);
  assert.equal((await request("PATCH", { enabled: true }, "/defaults", randomUUID())).status, 403);
  await AppDataSource.getRepository(Membership).update(
    { companyId: company.id, userId: user.id },
    { role: "member" },
  );
  assert.equal((await request("PATCH", { enabled: true }, "/defaults")).status, 403);
  assert.equal((await request()).body.automaticSetup, false);
});

test("turning automatic setup off preserves existing work and its individual pause state", async () => {
  const installed = await request("POST", input());
  assert.equal((await request("PATCH", { enabled: false }, `/${installed.body.id}`)).status, 200);
  assert.equal((await request("PATCH", { enabled: false }, "/defaults")).status, 200);
  assert.equal((await request("PATCH", { enabled: true }, "/defaults")).status, 200);
  const view = (await request()).body as ProactiveOverview;
  assert.equal(view.installations.length, 1);
  assert.equal(view.installations[0].enabled, false);
  assert.equal(view.automaticSetup, true);
  const events = await AppDataSource.getRepository(AuditEvent).findBy({
    action: "proactive.automatic_setup",
  });
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.actorUserId === user.id && event.actorKind === "user"));
});
test("ordinary Members may inspect but cannot enable or pause standing work", async () => {
  const enabled = await request("POST", input());
  await AppDataSource.getRepository(Membership).update(
    { companyId: company.id, userId: user.id },
    { role: "member" },
  );
  assert.equal((await request()).status, 200);
  assert.equal((await request("POST", input())).status, 403);
  assert.equal((await request("PATCH", { enabled: false }, `/${enabled.body.id}`)).status, 403);
});
test("an admin may enable a starter and the audit names the responsible Member", async () => {
  await AppDataSource.getRepository(Membership).update(
    { companyId: company.id, userId: user.id },
    { role: "admin" },
  );
  const result = await request("POST", input());
  assert.equal(result.status, 200);
  const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
    targetId: result.body.id,
    action: "proactive.enable",
  });
  assert.equal(audit.actorUserId, user.id);
});
test("quote setup creates a native category rule with work mode and the reviewed instruction", async () => {
  const result = await request("POST", input());
  assert.equal(result.status, 200);
  const rule = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: result.body.id });
  assert.deepEqual(JSON.parse(rule.conditionsJson), { category: "quote_request" });
  const action = JSON.parse(rule.actionsJson)[0];
  assert.equal(action.mode, "work");
  assert.equal(action.employeeId, employee.id);
  assert.ok(action.instruction.startsWith(input().instruction));
  assert.ok(action.instruction.includes(account.id));
  assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
});
test("repeat setup preserves customized instructions and a paused state", async () => {
  const first = await request("POST", input());
  await request("PATCH", { enabled: false }, `/${first.body.id}`);
  const second = await request(
    "POST",
    input("quote-requests", { instruction: "Changed incoming request" }),
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.id, first.body.id);
  assert.equal(second.body.enabled, false);
  const rule = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: first.body.id });
  assert.ok(rule.actionsJson.includes(input().instruction));
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 1);
});
test("concurrent attempts converge on one durable rule and one audit", async () => {
  const results = await Promise.all([
    installProactiveStarter(company.id, user.id, input()),
    installProactiveStarter(company.id, user.id, input()),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 1);
  assert.equal(
    await AppDataSource.getRepository(AuditEvent).countBy({ action: "proactive.enable" }),
    1,
  );
});
test("the same starter can have distinct employee and mailbox ownership", async () => {
  const first = await request("POST", input());
  const secondAccount = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "sales@example.com",
    status: "active",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: secondAccount.id,
    accessLevel: "draft",
  });
  const second = await request("POST", input("quote-requests", { accountId: secondAccount.id }));
  assert.equal(second.status, 200);
  assert.notEqual(first.body.id, second.body.id);
});
test("send according to Soul requires a Send Grant and explicit delivery selection", async () => {
  assert.equal((await request("POST", input("quote-requests", { delivery: "soul" }))).status, 400);
  await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
    { employeeId: employee.id },
    { accessLevel: "send" },
  );
  const result = await request("POST", input("quote-requests", { delivery: "soul" }));
  assert.equal(result.status, 200);
  assert.equal(result.body.delivery, "soul");
  const rule = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: result.body.id });
  assert.equal(JSON.parse(rule.actionsJson)[0].mode, "reply");
});
for (const reason of [
  "mail-read-only",
  "no-finance",
  "no-model",
  "inactive-model",
  "paused-mailbox",
  "analysis-disabled",
] as const) {
  test(`readiness refuses ${reason} without partially creating work`, async () => {
    if (reason === "mail-read-only")
      await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
        { employeeId: employee.id },
        { accessLevel: "read" },
      );
    if (reason === "no-finance")
      await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ employeeId: employee.id });
    if (reason === "no-model")
      await AppDataSource.getRepository(AIModel).delete({ employeeId: employee.id });
    if (reason === "inactive-model")
      await AppDataSource.getRepository(AIModel).update(
        { employeeId: employee.id },
        { configJson: "{}" },
      );
    if (reason === "paused-mailbox")
      await AppDataSource.getRepository(MailAccount).update(
        { id: account.id },
        { status: "paused" },
      );
    if (reason === "analysis-disabled")
      await AppDataSource.getRepository(MailAccount).update(
        { id: account.id },
        { aiAnalysisEnabled: false },
      );
    assert.equal((await request("POST", input())).status, 400);
    assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);
    assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
  });
}
test("foreign employees, mailboxes, and installations cannot be used", async () => {
  assert.equal(
    (await request("POST", input("quote-requests", { employeeId: randomUUID() }))).status,
    404,
  );
  assert.equal(
    (await request("POST", input("quote-requests", { accountId: randomUUID() }))).status,
    404,
  );
  assert.equal((await request("PATCH", { enabled: false }, `/${randomUUID()}`)).status, 404);
});

for (const missing of ["model", "grant", "company"] as const) {
  test(`a pinned analysis reader missing ${missing} blocks setup even when the worker is ready`, async () => {
    const reader = await insert(AIEmployee, {
      companyId: missing === "company" ? randomUUID() : company.id,
      name: "Inbox reader",
      slug: "inbox-reader",
      role: "Triage",
    });
    if (missing !== "grant")
      await insert(EmployeeMailAccountGrant, {
        employeeId: reader.id,
        accountId: account.id,
        accessLevel: "read",
      });
    if (missing !== "model")
      await insert(AIModel, {
        employeeId: reader.id,
        provider: "openai",
        model: "test",
        isActive: true,
        configJson: JSON.stringify({ apiKeyEncrypted: "test-only" }),
      });
    await AppDataSource.getRepository(MailAccount).update(
      { id: account.id },
      { aiAnalysisEmployeeId: reader.id },
    );
    const overview = (await request()).body as ProactiveOverview;
    assert.equal(overview.employees.find((row) => row.id === employee.id)?.modelReady, true);
    assert.equal(overview.mailboxes[0].analysisReady, false);
    const result = await request("POST", input());
    assert.equal(result.status, 400);
    assert.match(result.body.error, /AI analysis reader.*Read access.*connected AI Model/);
    assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);
  });
}

test("a stale pinned analysis model uses the reader's connected active model", async () => {
  await AppDataSource.getRepository(MailAccount).update(
    { id: account.id },
    {
      aiAnalysisEmployeeId: employee.id,
      aiAnalysisModelId: randomUUID(),
    },
  );
  const overview = (await request()).body as ProactiveOverview;
  assert.equal(overview.mailboxes[0].analysisReady, true);
  assert.equal((await request("POST", input())).status, 200);
});
test("server schemas reject unknown authority fields, missing scope, and malformed input", async () => {
  for (const payload of [
    input("missing"),
    input("quote-requests", { accountId: null }),
    input("quote-requests", { instruction: " " }),
    input("quote-requests", { grantAccess: true }),
    input("quote-requests", { delivery: "unrestricted" }),
    input("quote-requests", { employeeId: "not-a-uuid" }),
  ]) {
    assert.ok([400, 404].includes((await request("POST", payload)).status));
  }
  assert.equal((await request("GET", undefined, "?unexpected=1")).status, 400);
  assert.equal(
    (await request("PATCH", { enabled: true, instruction: "change" }, `/${randomUUID()}`)).status,
    400,
  );
});
test("scheduled work creates one Routine plus its rate-limited Trigger and persisted draft ceiling", async () => {
  const result = await request("POST", input("overdue-invoices"));
  assert.equal(result.status, 200);
  const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
    id: result.body.id,
  });
  assert.equal(routine.mailDeliveryMode, "draft");
  assert.equal(routine.enabled, true);
  assert.ok(routine.nextRunAt && routine.nextRunAt > new Date());
  assert.ok(routine.acceptanceCriteria.length > 50);
  const trigger = await AppDataSource.getRepository(RoutineTrigger).findOneByOrFail({
    routineId: routine.id,
  });
  assert.equal(trigger.kind, "invoice");
  assert.equal(trigger.minIntervalSec, 3600);
  assert.ok((result.body as ProactiveInstallation).href.includes(routine.slug));
  await request("POST", input("overdue-invoices"));
  assert.equal(await AppDataSource.getRepository(Routine).count(), 1);
  assert.equal(await AppDataSource.getRepository(RoutineTrigger).count(), 1);
});
test("scheduled drafts cannot be changed to automatic sending through setup", async () => {
  await AppDataSource.getRepository(EmployeeMailAccountGrant).update(
    { employeeId: employee.id },
    { accessLevel: "send" },
  );
  assert.equal(
    (await request("POST", input("overdue-invoices", { delivery: "soul" }))).status,
    400,
  );
});
test("pausing clears the next schedule and resuming restores it without losing the ceiling", async () => {
  const result = await request("POST", input("overdue-invoices"));
  assert.equal((await request("PATCH", { enabled: false }, `/${result.body.id}`)).status, 200);
  let routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: result.body.id });
  assert.equal(routine.enabled, false);
  assert.equal(routine.nextRunAt, null);
  assert.equal(routine.mailDeliveryMode, "draft");
  assert.equal((await request("PATCH", { enabled: true }, `/${result.body.id}`)).status, 200);
  routine = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: result.body.id });
  assert.equal(routine.enabled, true);
  assert.ok(routine.nextRunAt);
});
test("resuming rechecks revoked Grants and does not silently change category rules", async () => {
  const result = await request("POST", input());
  await request("PATCH", { enabled: false }, `/${result.body.id}`);
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ employeeId: employee.id });
  assert.equal((await request("PATCH", { enabled: true }, `/${result.body.id}`)).status, 400);
  assert.equal(
    (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: result.body.id })).enabled,
    false,
  );
});
test("all twelve starters can be installed with the required actual resource Grants", async () => {
  const repository = await insert(Repository, {
    companyId: company.id,
    name: "Product",
    slug: "product",
    origin: "local",
    gitUrl: "",
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
  await insert(EmployeeRevenueGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "write",
  });
  const calendar = await insert(CalendarAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "calendar@example.com",
  });
  await insert(EmployeeCalendarGrant, {
    employeeId: employee.id,
    accountId: calendar.id,
    accessLevel: "read",
  });
  for (const recipe of PROACTIVE_RECIPES) {
    const result = await request(
      "POST",
      input(recipe.id, { accountId: recipe.requirements.includes("mail") ? account.id : null }),
    );
    assert.equal(result.status, 200, `${recipe.id}: ${JSON.stringify(result.body)}`);
  }
  const overview = (await request()).body as ProactiveOverview;
  assert.equal(overview.installations.length, 13);
  assert.equal(await AppDataSource.getRepository(MailRule).count(), 5);
  assert.equal(await AppDataSource.getRepository(Routine).count(), 8);
  for (const routine of await AppDataSource.getRepository(Routine).find()) {
    assert.equal(routine.selfReviewOnly, routine.slug.startsWith("proactive-improve-own-work-"));
  }
});

test("own-work review needs only a connected model and installs an immutable suggestion scope", async () => {
  await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({ employeeId: employee.id });
  await AppDataSource.getRepository(EmployeeFinanceGrant).delete({ employeeId: employee.id });
  const result = await request("POST", input("improve-own-work", { accountId: null }));
  assert.equal(result.status, 200);
  const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
    id: result.body.id,
  });
  assert.equal(routine.selfReviewOnly, true);
  assert.equal(routine.mailDeliveryMode, "draft");
  assert.equal(routine.cronExpr, "0 15 * * 5");
  assert.equal(await AppDataSource.getRepository(RoutineTrigger).count(), 0);
  assert.equal(
    (await request("POST", input("improve-own-work", { accountId: null, selfReviewOnly: false })))
      .status,
    400,
  );
  assert.equal(
    (await request("PATCH", { enabled: true, selfReviewOnly: false }, `/${routine.id}`)).status,
    400,
  );
  assert.equal(
    (await request("POST", input("improve-own-work", { accountId: null, delivery: "soul" })))
      .status,
    400,
  );
});
test("a deleted mailbox never hides its still-existing restricted Routine", async () => {
  const result = await request("POST", input("overdue-invoices"));
  await AppDataSource.getRepository(MailAccount).delete({ id: account.id });
  const overview = (await request()).body as ProactiveOverview;
  assert.equal(overview.installations.length, 1);
  assert.equal(overview.installations[0].id, result.body.id);
  assert.ok(overview.installations[0].configurationIssue);
  assert.equal((await request("PATCH", { enabled: false }, `/${result.body.id}`)).status, 200);
  assert.equal((await request("PATCH", { enabled: true }, `/${result.body.id}`)).status, 400);
  const routine = await AppDataSource.getRepository(Routine).findOneByOrFail({
    id: result.body.id,
  });
  assert.equal(routine.mailDeliveryMode, "draft");
  assert.equal(routine.enabled, false);
});
test("resuming a customized native rule sends the Member back to its own editor", async () => {
  const result = await request("POST", input());
  await AppDataSource.getRepository(MailRule).update(
    { id: result.body.id },
    { enabled: false, conditionsJson: JSON.stringify({ from: "customer@example.com" }) },
  );
  const resumed = await request("PATCH", { enabled: true }, `/${result.body.id}`);
  assert.equal(resumed.status, 400);
  assert.match(resumed.body.error, /customized/);
});
test("a foreign Repository Grant cannot satisfy a company starter", async () => {
  const repository = await insert(Repository, {
    companyId: randomUUID(),
    name: "Foreign",
    slug: "foreign",
    gitUrl: "",
    origin: "local",
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
  const result = await request("POST", input("customer-code-issues"));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Write access to a Repository/);
});
test("unknown Finance access values never satisfy read readiness", async () => {
  await AppDataSource.getRepository(EmployeeFinanceGrant).update(
    { employeeId: employee.id },
    { accessLevel: "future-level" as "read" },
  );
  const result = await request("POST", input("overdue-invoices"));
  assert.equal(result.status, 400);
  assert.match(result.body.error, /Read access in Finance/);
});
test("stable native ids distinguish company, employee, recipe, and mailbox without depending on prose", () => {
  const id = proactiveId(company.id, employee.id, "quote-requests", account.id);
  assert.match(id, /^[a-f\d]{8}-[a-f\d]{4}-5[a-f\d]{3}-a[a-f\d]{3}-[a-f\d]{12}$/);
  for (const other of [
    proactiveId(randomUUID(), employee.id, "quote-requests", account.id),
    proactiveId(company.id, randomUUID(), "quote-requests", account.id),
    proactiveId(company.id, employee.id, "spam-cleanup", account.id),
    proactiveId(company.id, employee.id, "quote-requests", null),
  ])
    assert.notEqual(id, other);
});
