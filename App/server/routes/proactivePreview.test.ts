import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { TldrSettings } from "../db/entities/TldrSettings.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { reconcileProactiveDefaults } from "../services/proactive/defaults.js";
import type { ProactiveDefaultsPreview } from "../services/proactive/preview.js";
import { ensureDefaultTldrSchedule, updateTldrSettings } from "../services/tldrs.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { proactiveRouter } from "./proactive.js";

let server: Server;
let base = "";
let actingUserId: string | null = null;
let owner: User;
let company: Company;
let maya: AIEmployee;

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

async function hire(name: string, withModel = true): Promise<AIEmployee> {
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name,
    slug: name.toLowerCase(),
    role: "Operations",
    soulBody: `# ${name}`,
  });
  if (withModel) {
    await insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "test",
      authMode: "apikey",
      isActive: true,
      configJson: JSON.stringify({ apiKeyEncrypted: "cipher" }),
    });
  }
  return employee;
}

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: `owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Preview Co",
    slug: `preview-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  maya = await hire("Maya");
});

async function preview(employeeId = maya.id, query = `employeeId=${employeeId}`) {
  const response = await fetch(`${base}/api/companies/${company.id}/proactive/preview?${query}`);
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as ProactiveDefaultsPreview & { error?: string },
  };
}

const ALONE = [
  ["advance-responsibilities", "Weekdays at 08:00"],
  ["work-followthrough", "Every 30 minutes"],
  ["improve-own-work", "Fridays at 15:00"],
  ["discover-improvements", "Mondays at 11:00"],
];

describe("the standing work Automatic setup would give an employee", () => {
  test("lists a ready employee's starters in plain words", async () => {
    const response = await preview();

    assert.equal(response.status, 200);
    assert.equal(response.body.automaticSetup, true);
    assert.equal(response.body.employeeReady, true);
    assert.deepEqual(
      response.body.starters.map((row) => [row.recipeId, row.schedule]),
      ALONE,
    );
    assert(response.body.starters.every((row) => row.name.length > 0 && !row.installed));
    assert.equal(
      response.body.starters.find((row) => row.recipeId === "work-followthrough")?.name,
      "Follow through on open work",
    );
  });

  test("is what the sweep then installs, no more and no fewer", async () => {
    const before = await preview();
    await reconcileProactiveDefaults(company.id);

    const routines = await AppDataSource.getRepository(Routine).find({
      where: { employeeId: maya.id },
    });
    const installedNames = routines.map((routine) => routine.name).sort();
    assert.deepEqual(installedNames, before.body.starters.map((row) => row.name).sort());

    const after = await preview();
    assert.deepEqual(
      after.body.starters.map((row) => row.recipeId),
      before.body.starters.map((row) => row.recipeId),
    );
    assert(after.body.starters.every((row) => row.installed));
  });

  test("previews an employee with no AI Model as what they get once one is connected", async () => {
    const quinn = await hire("Quinn", false);

    const response = await preview(quinn.id);

    assert.equal(response.body.employeeReady, false);
    assert.deepEqual(
      response.body.starters.map((row) => row.recipeId),
      ALONE.map(([id]) => id),
    );
    // And the sweep gives them nothing yet, as the flag says.
    await reconcileProactiveDefaults(company.id);
    assert.equal(await AppDataSource.getRepository(Routine).countBy({ employeeId: quinn.id }), 0);
  });

  test("reports the switch off without hiding what it would add", async () => {
    await AppDataSource.getRepository(Company).update(
      { id: company.id },
      { proactiveAutoSetup: false },
    );

    const response = await preview();

    assert.equal(response.body.automaticSetup, false);
    assert.deepEqual(
      response.body.starters.map((row) => row.recipeId),
      ALONE.map(([id]) => id),
    );
    assert(response.body.starters.every((row) => !row.installed));
  });

  test("a second employee gets the personal work; the shared work stays where it is", async () => {
    await reconcileProactiveDefaults(company.id);
    const ben = await hire("Ben");

    const response = await preview(ben.id);

    assert.deepEqual(
      response.body.starters.map((row) => row.recipeId),
      ["advance-responsibilities", "improve-own-work"],
    );
    assert(response.body.starters.every((row) => !row.installed));
    // Maya keeps her own four.
    const mine = await preview(maya.id);
    assert.deepEqual(
      mine.body.starters.map((row) => row.recipeId),
      ALONE.map(([id]) => id),
    );
    assert(mine.body.starters.every((row) => row.installed));
  });
});

describe("the TLDR briefing beside it", () => {
  test("is the daily briefing the first hire started", async () => {
    await ensureDefaultTldrSchedule(company.id, maya.id);

    const response = await preview();

    assert.deepEqual(response.body.briefing, {
      schedule: "Daily",
      writerName: "Maya",
      writerIsEmployee: true,
    });
  });

  test("names another employee when someone else writes it", async () => {
    await ensureDefaultTldrSchedule(company.id, maya.id);
    const ben = await hire("Ben");

    const response = await preview(ben.id);

    assert.deepEqual(response.body.briefing, {
      schedule: "Daily",
      writerName: "Maya",
      writerIsEmployee: false,
    });
  });

  test("follows the cadence the TLDRs page was set to", async () => {
    await ensureDefaultTldrSchedule(company.id, maya.id);
    await updateTldrSettings(company.id, {
      enabled: true,
      cadence: "weekly",
      employeeId: maya.id,
    });

    assert.equal((await preview()).body.briefing?.schedule, "Weekly");
  });

  test("is absent when it is paused or has no writer", async () => {
    assert.equal((await preview()).body.briefing, null);

    await ensureDefaultTldrSchedule(company.id, maya.id);
    await AppDataSource.getRepository(TldrSettings).update(
      { companyId: company.id },
      { enabled: false },
    );
    assert.equal((await preview()).body.briefing, null);

    await AppDataSource.getRepository(TldrSettings).update(
      { companyId: company.id },
      { enabled: true, employeeId: null },
    );
    assert.equal((await preview()).body.briefing, null);
  });
});

describe("who may ask, and about whom", () => {
  test("requires authentication", async () => {
    actingUserId = null;
    assert.equal((await preview()).status, 401);
  });

  test("any Member of the company may read it", async () => {
    const member = await insert(User, {
      email: `member-${randomUUID()}@example.com`,
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
    actingUserId = member.id;

    const response = await preview();

    assert.equal(response.status, 200);
    assert.equal(response.body.starters.length, ALONE.length);
  });

  test("someone outside the company may not", async () => {
    const outsider = await insert(User, {
      email: `outsider-${randomUUID()}@example.com`,
      name: "Outsider",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = outsider.id;

    assert.equal((await preview()).status, 403);
  });

  test("validates the query", async () => {
    assert.equal((await preview(maya.id, "")).status, 400);
    assert.equal((await preview(maya.id, "employeeId=not-a-uuid")).status, 400);
    assert.equal((await preview(maya.id, `employeeId=${maya.id}&surprise=1`)).status, 400);
  });

  test("does not reveal an employee from another company", async () => {
    const elsewhere = await insert(Company, {
      name: "Elsewhere",
      slug: `elsewhere-${randomUUID()}`,
      ownerId: owner.id,
    });
    const stranger = await insert(AIEmployee, {
      companyId: elsewhere.id,
      name: "Stranger",
      slug: "stranger",
      role: "Operations",
      soulBody: "",
    });

    const response = await preview(stranger.id);

    assert.equal(response.status, 404);
    assert.equal(response.body.error, "AI Employee not found");
  });
});
