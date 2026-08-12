import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { applyRoutineRecommendations } from "./onboardingRecommendations.js";

let testDir = "";
let company: Company;
let employee: AIEmployee;

before(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), "genosyn-onboarding-sqlite-"));
  AppDataSource.setOptions({
    type: "better-sqlite3",
    database: path.join(testDir, "app.sqlite"),
    synchronize: true,
    dropSchema: true,
    migrations: [],
    logging: false,
  });
  await AppDataSource.initialize();

  company = await AppDataSource.getRepository(Company).save(
    AppDataSource.getRepository(Company).create({
      name: "File-backed Company",
      slug: "file-backed-company",
      ownerId: "owner-1",
      mission: "Help teams focus on valuable work.",
      vision: "Every team operates with clarity.",
    }),
  );
  employee = await AppDataSource.getRepository(AIEmployee).save(
    AppDataSource.getRepository(AIEmployee).create({
      companyId: company.id,
      name: "Ivy",
      slug: "ivy",
      role: "Software Engineer",
      soulBody: "# Ivy's Soul",
    }),
  );
});

after(async () => {
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  if (testDir.startsWith(path.join(tmpdir(), "genosyn-onboarding-sqlite-"))) {
    await rm(testDir, { recursive: true, force: true });
  }
});

test("a separate SQLite transaction cannot roll back an acknowledged onboarding apply", async () => {
  let outerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    outerStarted = resolve;
  });
  let releaseOuter!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseOuter = resolve;
  });

  const outer = AppDataSource.transaction(async (manager) => {
    await manager.getRepository(Company).update(company.id, { name: "Uncommitted name" });
    outerStarted();
    await release;
    throw new Error("roll back unrelated work");
  });
  await started;

  const apply = applyRoutineRecommendations({
    company,
    employee,
    recommendationIds: ["daily-priority-check"],
    actorUserId: "owner-1",
  });
  // Longer than the old sub-second retry window: ordinary imports and company
  // maintenance can hold the single SQLite writer for this long.
  setTimeout(releaseOuter, 1_500);

  await assert.rejects(outer, /roll back unrelated work/);
  const result = await apply;

  assert.equal(result.created.length, 1);
  assert.equal(result.existing.length, 0);
  assert.equal(await AppDataSource.getRepository(Routine).count(), 1);
  assert.equal(await AppDataSource.getRepository(AuditEvent).count(), 1);
  assert.equal(
    (await AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id })).name,
    "File-backed Company",
  );
});
