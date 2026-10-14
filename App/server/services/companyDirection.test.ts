import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Goal } from "../db/entities/Goal.js";
import {
  companyHasGoal,
  companyIdsWithGoal,
  hasCompanyDirection,
  hasWrittenDirection,
  primaryGoal,
} from "./companyDirection.js";

let company: Company;
let other: Company;

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

async function makeCompany(slug: string, direction: Partial<Company> = {}): Promise<Company> {
  const repo = AppDataSource.getRepository(Company);
  return repo.save(repo.create({ name: slug, slug, ownerId: "owner-1", ...direction }));
}

async function makeGoal(owner: Company, values: Partial<Goal> = {}): Promise<Goal> {
  const repo = AppDataSource.getRepository(Goal);
  return repo.save(
    repo.create({
      companyId: owner.id,
      title: "Reach 50 paying customers",
      slug: `goal-${Math.random().toString(36).slice(2)}`,
      targetValue: 50,
      ...values,
    }),
  );
}

beforeEach(async () => {
  await AppDataSource.getRepository(Goal).clear();
  await AppDataSource.getRepository(Company).clear();
  company = await makeCompany("northwind");
  other = await makeCompany("elsewhere");
});

describe("a written mission and vision", () => {
  test("needs both, and ignores whitespace", () => {
    assert.equal(hasWrittenDirection({ mission: "Make it", vision: "See it" }), true);
    for (const direction of [
      { mission: "", vision: "" },
      { mission: " \n\t", vision: "See it" },
      { mission: "Make it", vision: "  " },
    ])
      assert.equal(hasWrittenDirection(direction), false, JSON.stringify(direction));
    assert.equal(hasWrittenDirection(null), false);
    assert.equal(hasWrittenDirection(undefined), false);
  });
});

describe("a company's Goal", () => {
  test("an active top-level Goal is direction by itself", async () => {
    assert.equal(await companyHasGoal(company.id), false);
    assert.equal(await hasCompanyDirection(company), false);

    await makeGoal(company);

    assert.equal(await companyHasGoal(company.id), true);
    assert.equal(await hasCompanyDirection(company), true);
  });

  test("a sub-goal alone is not a Goal the company has written", async () => {
    const parent = await makeGoal(company, { status: "archived" });
    await makeGoal(company, { parentGoalId: parent.id });

    assert.equal(await companyHasGoal(company.id), false);
    assert.equal(await hasCompanyDirection(company), false);
  });

  test("a Goal that is archived, achieved or missed is no longer steering", async () => {
    for (const status of ["archived", "achieved", "missed"] as const) {
      await AppDataSource.getRepository(Goal).clear();
      await makeGoal(company, { status });
      assert.equal(await companyHasGoal(company.id), false, status);
    }
  });

  test("another company's Goal does not count", async () => {
    await makeGoal(other);

    assert.equal(await companyHasGoal(company.id), false);
    assert.equal(await hasCompanyDirection(company), false);
    assert.equal(await hasCompanyDirection(other), true);
  });

  test("a Goal and a mission with no vision are each judged on their own", async () => {
    const mission = await makeCompany("mission-only", { mission: "Make it" });
    assert.equal(await hasCompanyDirection(mission), false);
    await makeGoal(mission);
    assert.equal(await hasCompanyDirection(mission), true);
  });
});

describe("hasCompanyDirection", () => {
  test("a mission and a vision stay enough without a Goal", async () => {
    const written = await makeCompany("written", { mission: "Make it", vision: "See it" });

    assert.equal(await hasCompanyDirection(written), true);
  });

  test("a missing company has none", async () => {
    assert.equal(await hasCompanyDirection(null), false);
    assert.equal(await hasCompanyDirection(undefined), false);
  });
});

describe("primaryGoal", () => {
  async function created(goal: Goal, at: string) {
    await AppDataSource.getRepository(Goal).update({ id: goal.id }, { createdAt: new Date(at) });
  }

  test("is the oldest active Goal at the top of the tree", async () => {
    // The column keeps whole seconds, so the order is set by hand.
    const newer = await makeGoal(company, { title: "Newer" });
    const older = await makeGoal(company, { title: "Older" });
    const subGoal = await makeGoal(company, { title: "Sub-goal", parentGoalId: older.id });
    const archived = await makeGoal(company, { title: "Archived", status: "archived" });
    await created(archived, "2025-11-01T00:00:00.000Z");
    await created(subGoal, "2025-12-01T00:00:00.000Z");
    await created(older, "2026-01-01T00:00:00.000Z");
    await created(newer, "2026-02-01T00:00:00.000Z");

    assert.equal((await primaryGoal(company.id))?.id, older.id);
  });

  test("is nothing when the company has no active top-level Goal", async () => {
    await makeGoal(company, { status: "achieved" });
    await makeGoal(other);

    assert.equal(await primaryGoal(company.id), null);
  });
});

describe("companyIdsWithGoal", () => {
  test("answers for many companies in one pass", async () => {
    await makeGoal(company);
    await makeGoal(company, { title: "A second Goal" });

    const ids = await companyIdsWithGoal([company.id, other.id]);

    assert.deepEqual([...ids], [company.id]);
  });

  test("an empty list asks nothing", async () => {
    assert.deepEqual([...(await companyIdsWithGoal([]))], []);
  });
});
