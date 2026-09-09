import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { homeRouter } from "./home.js";

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let member: User;
let outsider: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", homeRouter);
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
});

beforeEach(async () => {
  await resetTestDb();
  member = await insert(User, {
    email: "member@example.test",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  outsider = await insert(User, {
    email: "outsider@example.test",
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: member.id });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Engineer",
  });
  const repository = await insert(Repository, {
    companyId: company.id,
    name: "Product",
    slug: "product",
    gitUrl: "",
    origin: "local",
  });
  for (let index = 0; index < 10; index += 1) {
    await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: repository.id,
      employeeId: employee.id,
      title: `Review ${index}`,
      instruction: "Review this change",
      status: "ready",
      updatedAt: new Date(Date.UTC(2026, 8, 9, 9, index)),
    });
  }
  actingUserId = member.id;
});

const url = (query = "") => `${baseUrl}/api/companies/${company.id}/home/repository-work${query}`;

describe("Home Repository AI work pagination", () => {
  test("lets an ordinary Member read the default preview and continue through the backlog", async () => {
    const first = await fetch(url());
    assert.equal(first.status, 200);
    const preview = (await first.json()) as { items: Array<{ title: string }>; total: number };
    assert.equal(preview.items.length, 8);
    assert.equal(preview.total, 10);
    assert.equal(preview.items[0].title, "Review 9");

    const next = await fetch(url("?offset=8&limit=8"));
    assert.equal(next.status, 200);
    const page = (await next.json()) as { items: Array<{ title: string }>; total: number };
    assert.deepEqual(
      page.items.map((row) => row.title),
      ["Review 1", "Review 0"],
    );
    assert.equal(page.total, 10);
  });

  test("rejects malformed, unbounded, and unknown paging parameters", async () => {
    for (const query of [
      "?offset=-1",
      "?offset=1.5",
      "?offset=no",
      "?limit=0",
      "?limit=51",
      "?limit=1.5",
      "?other=1",
    ]) {
      const response = await fetch(url(query));
      assert.equal(response.status, 400, query);
      const body = (await response.json()) as { error: string };
      assert.equal(body.error, "ValidationError", query);
    }
  });

  test("does not expose company work to a non-member or a signed-out visitor", async () => {
    actingUserId = outsider.id;
    assert.equal((await fetch(url())).status, 403);
    actingUserId = null;
    assert.equal((await fetch(url())).status, 401);
  });

  test("keeps Repository work browser-only on both Home endpoints", async () => {
    const tokenBody = "a".repeat(43);
    await insert(ApiKey, {
      companyId: company.id,
      userId: member.id,
      name: "Automation",
      prefix: tokenBody.slice(0, 8),
      tokenHash: hashApiToken(tokenBody),
      lastUsedAt: new Date(),
    });
    actingUserId = null;
    const headers = { Authorization: `Bearer gen_${tokenBody}` };
    assert.equal((await fetch(url(), { headers })).status, 403);

    const response = await fetch(`${baseUrl}/api/companies/${company.id}/home`, { headers });
    assert.equal(response.status, 200);
    const home = (await response.json()) as {
      repositoryWork: unknown[];
      repositoryWorkCount: number;
    };
    assert.deepEqual(home.repositoryWork, []);
    assert.equal(home.repositoryWorkCount, 0);
  });
});
