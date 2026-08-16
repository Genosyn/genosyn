import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { loadOnboardingStatus } from "./onboardingStatus.js";

let company: Company;

before(async () => {
  AppDataSource.setOptions({
    type: "better-sqlite3",
    database: ":memory:",
    synchronize: true,
    dropSchema: true,
    migrations: [],
    logging: false,
  });
  await AppDataSource.initialize();
});

after(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
});

beforeEach(async () => {
  for (const entity of [EmployeeMailAccountGrant, Routine, Skill, AIModel, AIEmployee, Company]) {
    await AppDataSource.getRepository(entity).clear();
  }
  company = await AppDataSource.getRepository(Company).save(
    AppDataSource.getRepository(Company).create({
      name: "Northwind Labs",
      slug: "northwind-labs",
      ownerId: "owner-1",
    }),
  );
});

async function hire(name: string, createdAt?: Date): Promise<AIEmployee> {
  const repo = AppDataSource.getRepository(AIEmployee);
  const employee = await repo.save(
    repo.create({
      companyId: company.id,
      name,
      slug: name.toLowerCase(),
      role: "Executive Assistant",
      soulBody: `# ${name}`,
    }),
  );
  if (createdAt) {
    await repo.update({ id: employee.id }, { createdAt });
    return (await repo.findOneByOrFail({ id: employee.id })) as AIEmployee;
  }
  return employee;
}

async function connectModel(employeeId: string, apiKeyEncrypted: string | null): Promise<AIModel> {
  const repo = AppDataSource.getRepository(AIModel);
  return repo.save(
    repo.create({
      employeeId,
      provider: "anthropic",
      model: "claude-opus-4-6",
      authMode: "apikey",
      isActive: true,
      configJson: JSON.stringify(apiKeyEncrypted ? { apiKeyEncrypted } : {}),
    }),
  );
}

test("a company with no AI Employees starts at the explainer", async () => {
  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.complete, false);
  assert.equal(status.employee, null);
  assert.equal(status.modelConnected, false);
  assert.equal(status.routineCount, 0);
  assert.equal(status.scheduledRoutineCount, 0);
  assert.equal(status.nextRunAt, null);
  assert.equal(status.skillCount, 0);
  assert.equal(status.mailGranted, false);
  assert.equal(status.mailAccessLevel, null);
  assert.equal(status.nextStep, "intro");
});

test("an AI Employee without usable model credentials is not complete", async () => {
  const employee = await hire("Avery");
  await connectModel(employee.id, null);

  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.complete, false);
  assert.equal(status.modelConnected, false);
  assert.equal(status.nextStep, "employee");
  assert.equal(status.employee?.id, employee.id);
  assert.equal(status.employee?.name, "Avery");
});

test("a connected AI Model completes setup even with nothing else configured", async () => {
  const employee = await hire("Avery");
  await connectModel(employee.id, "cipher");

  const status = await loadOnboardingStatus(company.id);

  // Routines, Gmail, and the first request are all genuinely optional — a
  // member who skipped them is finished, not nagged forever.
  assert.equal(status.complete, true);
  assert.equal(status.modelConnected, true);
  assert.equal(status.routineCount, 0);
  assert.equal(status.mailGranted, false);
  assert.equal(status.nextStep, "done");
});

test("the soonest enabled Routine run is reported, and disabled ones are ignored", async () => {
  const employee = await hire("Avery");
  await connectModel(employee.id, "cipher");
  const routines = AppDataSource.getRepository(Routine);
  const soon = new Date("2026-09-01T07:00:00.000Z");
  const later = new Date("2026-09-02T07:00:00.000Z");
  const earliestButOff = new Date("2026-08-30T07:00:00.000Z");

  await routines.save([
    routines.create({
      employeeId: employee.id,
      name: "Weekly look-ahead",
      slug: "weekly-look-ahead",
      cronExpr: "0 16 * * 5",
      enabled: true,
      nextRunAt: later,
    }),
    routines.create({
      employeeId: employee.id,
      name: "Daily brief",
      slug: "daily-brief",
      cronExpr: "0 7 * * 1-5",
      enabled: true,
      nextRunAt: soon,
    }),
    routines.create({
      employeeId: employee.id,
      name: "Paused digest",
      slug: "paused-digest",
      cronExpr: "0 7 * * 1-5",
      enabled: false,
      nextRunAt: earliestButOff,
    }),
  ]);

  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.routineCount, 3);
  assert.equal(status.nextRunAt, soon.toISOString());
});

test("only Routines that will actually fire count as scheduled", async () => {
  const employee = await hire("Avery");
  const routines = AppDataSource.getRepository(Routine);
  await routines.save([
    routines.create({
      employeeId: employee.id,
      name: "Daily brief",
      slug: "daily-brief",
      cronExpr: "0 7 * * 1-5",
      enabled: true,
      nextRunAt: new Date("2026-09-01T07:00:00.000Z"),
    }),
    // `registerRoutine` nulls nextRunAt when a Routine is switched off, so a
    // summary must not describe this one as running on its own schedule.
    routines.create({
      employeeId: employee.id,
      name: "Paused digest",
      slug: "paused-digest",
      cronExpr: "0 7 * * 1-5",
      enabled: false,
      nextRunAt: null,
    }),
  ]);

  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.routineCount, 2);
  assert.equal(status.scheduledRoutineCount, 1);
});

test("the strongest mailbox access level is reported, not just that a Grant exists", async () => {
  const employee = await hire("Avery");
  const grants = AppDataSource.getRepository(EmployeeMailAccountGrant);
  await grants.save([
    grants.create({ employeeId: employee.id, accountId: "account-1", accessLevel: "read" }),
    grants.create({ employeeId: employee.id, accountId: "account-2", accessLevel: "send" }),
    grants.create({ employeeId: employee.id, accountId: "account-3", accessLevel: "draft" }),
  ]);

  const status = await loadOnboardingStatus(company.id);

  // Reporting "you press send" about a `send` Grant would misstate a safety
  // property, so the summary needs the level and not just a count.
  assert.equal(status.mailGranted, true);
  assert.equal(status.mailAccessLevel, "send");
});

test("no mailbox Grant reports no access level", async () => {
  await hire("Avery");

  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.mailGranted, false);
  assert.equal(status.mailAccessLevel, null);
});

test("Skills are counted, because hiring without a template creates none", async () => {
  const employee = await hire("Avery");
  const skills = AppDataSource.getRepository(Skill);
  await skills.save([
    skills.create({
      employeeId: employee.id,
      name: "Inbox triage",
      slug: "inbox-triage",
      body: "# Inbox triage",
    }),
    skills.create({
      employeeId: employee.id,
      name: "Meeting prep",
      slug: "meeting-prep",
      body: "# Meeting prep",
    }),
  ]);

  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.skillCount, 2);
});

test("a template-less hire reports no Skills", async () => {
  await hire("Avery");

  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.skillCount, 0);
});

test("the guide follows the company's first hire when no employee is named", async () => {
  const first = await hire("Avery", new Date("2026-08-01T00:00:00.000Z"));
  await hire("Sam", new Date("2026-08-05T00:00:00.000Z"));

  const status = await loadOnboardingStatus(company.id);

  assert.equal(status.employee?.id, first.id);
});

test("naming an AI Employee reports that one, not the company's first hire", async () => {
  const first = await hire("Avery", new Date("2026-08-01T00:00:00.000Z"));
  const second = await hire("Sam", new Date("2026-08-05T00:00:00.000Z"));
  // Avery is fully set up; Sam is not. A summary headed "Sam" must not report
  // Avery's model, Skills, or mailbox access.
  await connectModel(first.id, "cipher");
  const grants = AppDataSource.getRepository(EmployeeMailAccountGrant);
  await grants.save(
    grants.create({ employeeId: first.id, accountId: "account-1", accessLevel: "send" }),
  );
  const skills = AppDataSource.getRepository(Skill);
  await skills.save(
    skills.create({
      employeeId: first.id,
      name: "Inbox triage",
      slug: "inbox-triage",
      body: "# Inbox triage",
    }),
  );

  const status = await loadOnboardingStatus(company.id, second.id);

  assert.equal(status.employee?.id, second.id);
  assert.equal(status.employee?.name, "Sam");
  assert.equal(status.modelConnected, false);
  assert.equal(status.complete, false);
  assert.equal(status.skillCount, 0);
  assert.equal(status.mailGranted, false);
  assert.equal(status.mailAccessLevel, null);
});

test("an AI Employee id from another company resolves to nothing", async () => {
  const other = await AppDataSource.getRepository(Company).save(
    AppDataSource.getRepository(Company).create({
      name: "Someone Else",
      slug: "someone-else-scoped",
      ownerId: "owner-2",
    }),
  );
  const mine = await hire("Avery");
  await connectModel(mine.id, "cipher");

  const status = await loadOnboardingStatus(other.id, mine.id);

  assert.equal(status.employee, null);
  assert.equal(status.modelConnected, false);
  assert.equal(status.nextStep, "intro");
});

test("another company's AI Employees never leak in", async () => {
  const other = await AppDataSource.getRepository(Company).save(
    AppDataSource.getRepository(Company).create({
      name: "Someone Else",
      slug: "someone-else",
      ownerId: "owner-2",
    }),
  );
  await hire("Avery");

  const status = await loadOnboardingStatus(other.id);

  assert.equal(status.employee, null);
  assert.equal(status.nextStep, "intro");
});
