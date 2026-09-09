import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Skill } from "../db/entities/Skill.js";
import { TldrSettings } from "../db/entities/TldrSettings.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { updateTldrSettings } from "../services/tldrs.js";
import { EMPLOYEE_TEMPLATES, personalizeTemplateSoul } from "../services/templates.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { employeesRouter } from "./employees.js";

type ApiResponse<T> = { status: number; body: T };

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let owner: User;
let company: Company;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-template-hire-"));
  mutableConfig.dataDir = path.join(root, "data");
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
  app.use("/api/companies/:cid/employees", employeesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  fs.rmSync(mutableConfig.dataDir, { recursive: true, force: true });
  owner = await insert(User, {
    email: "template-hire-owner@example.com",
    name: "Template Hire Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Orbit Labs",
    slug: "orbit-labs",
    ownerId: owner.id,
    mission: "Help every customer adopt reliable software.",
    vision: "A world where preventable churn disappears.",
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
});

async function hire(
  name: string,
  role: string,
  templateId?: string,
): Promise<ApiResponse<AIEmployee & { error?: string }>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}/employees`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, role, templateId }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as AIEmployee,
  };
}

describe("hiring an AI Employee from a template", () => {
  for (const direction of [
    { mission: "", vision: "" },
    { mission: "  \n", vision: "Clear vision" },
    { mission: "Clear mission", vision: "\t" },
  ]) {
    test(`requires company mission and vision before hiring: ${JSON.stringify(direction)}`, async () => {
      await AppDataSource.getRepository(Company).update({ id: company.id }, direction);

      const response = await hire("Avery", "Executive Assistant", "executive-assistant");

      assert.equal(response.status, 400);
      assert.equal(
        response.body.error,
        "Set your company mission and vision before hiring an AI Employee.",
      );
      assert.equal(await AppDataSource.getRepository(AIEmployee).count(), 0);
      assert.equal(await AppDataSource.getRepository(Skill).count(), 0);
      assert.equal(await AppDataSource.getRepository(Routine).count(), 0);
      assert.equal(await AppDataSource.getRepository(TldrSettings).count(), 0);
      assert.equal(fs.existsSync(mutableConfig.dataDir), false);
    });
  }

  test("also requires company direction for a hire without a template", async () => {
    await AppDataSource.getRepository(Company).update({ id: company.id }, { vision: "" });
    const response = await hire("Quinn", "Researcher");
    assert.equal(response.status, 400);
    assert.equal(await AppDataSource.getRepository(AIEmployee).count(), 0);
  });

  test("hiring succeeds after company direction is saved", async () => {
    await AppDataSource.getRepository(Company).update(
      { id: company.id },
      { mission: "", vision: "" },
    );
    assert.equal((await hire("Avery", "Executive Assistant", "executive-assistant")).status, 400);
    await AppDataSource.getRepository(Company).update(
      { id: company.id },
      {
        mission: "Help teams focus on meaningful work.",
        vision: "Every team works with clarity.",
      },
    );

    const response = await hire("  Avery  ", "  Executive Assistant  ", "executive-assistant");
    assert.equal(response.status, 200);
    assert.equal(response.body.name, "Avery");
    assert.equal(response.body.role, "Executive Assistant");
    assert.equal(await AppDataSource.getRepository(AIEmployee).count(), 1);
  });

  test("blank names and roles cannot produce an unusable hire", async () => {
    assert.equal((await hire("  ", "Executive Assistant")).status, 400);
    assert.equal((await hire("Avery", "\n \t")).status, 400);
    assert.equal(await AppDataSource.getRepository(AIEmployee).count(), 0);
  });

  test("authentication and company role checks precede the direction requirement", async () => {
    await AppDataSource.getRepository(Company).update({ id: company.id }, { mission: "" });
    actingUserId = null;
    assert.equal((await hire("Avery", "Executive Assistant")).status, 401);
    actingUserId = owner.id;
    await AppDataSource.getRepository(Membership).update(
      { companyId: company.id, userId: owner.id },
      { role: "member" },
    );
    assert.equal((await hire("Avery", "Executive Assistant")).status, 403);
    assert.equal(await AppDataSource.getRepository(AIEmployee).count(), 0);
  });

  test("a template provides its Soul and Skills without scheduling unreviewed Routines", async () => {
    for (const [index, template] of EMPLOYEE_TEMPLATES.entries()) {
      const response = await hire(`New hire ${index}`, template.role, template.id);
      assert.equal(response.status, 200);
      assert.equal(
        await AppDataSource.getRepository(Skill).countBy({ employeeId: response.body.id }),
        template.skills.length,
      );
      assert.equal(
        await AppDataSource.getRepository(Routine).countBy({ employeeId: response.body.id }),
        0,
      );
    }
  });

  test("starts one daily TLDR schedule with the first AI Employee", async () => {
    const beforeHire = Date.now();
    const first = await hire("Marguerite", "VP of Go to Market", "revops-analyst");
    const afterHire = Date.now();

    assert.equal(first.status, 200);
    const firstSchedule = await AppDataSource.getRepository(TldrSettings).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(firstSchedule.employeeId, first.body.id);
    assert.equal(firstSchedule.enabled, true);
    assert.equal(firstSchedule.cadence, "daily");
    assert(firstSchedule.nextRunAt);
    assert(firstSchedule.nextRunAt.getTime() >= beforeHire + 24 * 60 * 60_000);
    assert(firstSchedule.nextRunAt.getTime() <= afterHire + 24 * 60 * 60_000);

    await updateTldrSettings(company.id, {
      enabled: false,
      cadence: "daily",
      employeeId: first.body.id,
    });

    const second = await hire("Nadia", "Account Executive", "account-executive");

    assert.equal(second.status, 200);
    const unchangedSchedule = await AppDataSource.getRepository(TldrSettings).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(unchangedSchedule.id, firstSchedule.id);
    assert.equal(unchangedSchedule.employeeId, first.body.id);
    assert.equal(unchangedSchedule.enabled, false);
    assert.equal(unchangedSchedule.nextRunAt, null);
  });

  // The three templates a hard-coded substitution list had drifted away from.
  for (const templateId of ["revops-analyst", "account-executive", "paid-marketing"]) {
    test(`renames the ${templateId} Soul to the chosen name`, async () => {
      const template = EMPLOYEE_TEMPLATES.find((t) => t.id === templateId);
      assert(template, `missing template ${templateId}`);

      const response = await hire("Marguerite", template.role, templateId);

      assert.equal(response.status, 200);
      assert(response.body.soulBody.includes("Marguerite"));
      assert.doesNotMatch(response.body.soulBody, new RegExp(`\\b${template.name}\\b`));
    });
  }

  test("leaves no template protagonist name behind, for every template", async () => {
    const placeholders = EMPLOYEE_TEMPLATES.map((t) => t.name);

    for (const [index, template] of EMPLOYEE_TEMPLATES.entries()) {
      const name = `Hire ${index}`;
      const response = await hire(name, template.role, template.id);

      assert.equal(response.status, 200, `hiring from ${template.id} failed`);
      assert(
        response.body.soulBody.includes(name),
        `${template.id} Soul does not mention the chosen name`,
      );
      for (const placeholder of placeholders) {
        assert.doesNotMatch(
          response.body.soulBody,
          new RegExp(`\\b${placeholder}\\b`),
          `${template.id} Soul still mentions ${placeholder}`,
        );
      }
    }
  });

  test("inserts a name containing regex replacement syntax literally", () => {
    const template = EMPLOYEE_TEMPLATES[0];
    assert(template);

    const soul = personalizeTemplateSoul(template, "$& & $`");

    assert(soul.includes("$& & $`"));
    assert.doesNotMatch(soul, new RegExp(`\\b${template.name}\\b`));
  });
});
