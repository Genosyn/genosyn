import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Team } from "../db/entities/Team.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { teamsRouter } from "./teams.js";

/**
 * Teams outlived the org chart they were first drawn in: they still group AI
 * Employees, show on each employee's card, and answer `list_teams`. These pin
 * the HTTP side — in particular that a team's member list is people, not a
 * reporting structure.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let operations: Team;
let ada: AIEmployee;
let bo: AIEmployee;

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
  app.use("/api/companies/:cid", teamsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function member(email: string, role: Role, companyId: string): Promise<User> {
  const user = await insert(User, { email, name: email, passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  const viewer = await member("viewer@example.com", "member", company.id);
  operations = await insert(Team, { companyId: company.id, name: "Operations", slug: "ops" });
  // Inserted out of name order, to see the member list sort them.
  bo = await insert(AIEmployee, {
    companyId: company.id,
    name: "Bo",
    slug: "bo",
    role: "Writer",
    soulBody: "",
    teamId: operations.id,
  });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
    teamId: operations.id,
  });
  await insert(AIEmployee, {
    companyId: company.id,
    name: "Cy",
    slug: "cy",
    role: "Librarian",
    soulBody: "",
  });
  actingUserId = viewer.id;
});

async function call<T>(method: string, path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, { method });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("a team's members over HTTP", () => {
  test("lists the employees on the team by name, with no reporting line", async () => {
    const listed = await call<Array<Record<string, unknown>>>(
      "GET",
      `/teams/${operations.id}/members`,
    );
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body, [
      { id: ada.id, slug: "ada", name: "Ada", role: "Analyst" },
      { id: bo.id, slug: "bo", name: "Bo", role: "Writer" },
    ]);
  });

  test("another company's team is not found, even by a Member of this one", async () => {
    const elsewhere = await insert(Company, {
      name: "Elsewhere",
      slug: "elsewhere",
      ownerId: company.ownerId,
    });
    const theirs = await insert(Team, { companyId: elsewhere.id, name: "Theirs", slug: "theirs" });
    const missing = await call<{ error: string }>("GET", `/teams/${theirs.id}/members`);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, "Team not found");
  });

  test("the team list counts members and hides archived teams unless asked", async () => {
    await insert(Team, {
      companyId: company.id,
      name: "Legacy",
      slug: "legacy",
      archivedAt: new Date(),
    });
    const live = await call<Array<{ slug: string; memberCount: number }>>("GET", "/teams");
    assert.deepEqual(
      live.body.map(({ slug, memberCount }) => ({ slug, memberCount })),
      [{ slug: "ops", memberCount: 2 }],
    );
    const all = await call<Array<{ slug: string }>>("GET", "/teams?includeArchived=true");
    assert.deepEqual(
      all.body.map(({ slug }) => slug),
      ["legacy", "ops"],
    );
  });

  test("deleting a team detaches its employees rather than deleting them", async () => {
    assert.equal((await call("DELETE", `/teams/${operations.id}`)).status, 200);
    const employees = await AppDataSource.getRepository(AIEmployee).find({
      order: { name: "ASC" },
    });
    assert.deepEqual(
      employees.map(({ name, teamId }) => ({ name, teamId })),
      [
        { name: "Ada", teamId: null },
        { name: "Bo", teamId: null },
        { name: "Cy", teamId: null },
      ],
    );
  });

  test("a signed-out request is refused", async () => {
    actingUserId = null;
    assert.equal((await call("GET", `/teams/${operations.id}/members`)).status, 401);
  });
});
