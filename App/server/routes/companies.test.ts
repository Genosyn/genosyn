import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Notebook } from "../db/entities/Notebook.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { companiesRouter } from "./companies.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies", companiesRouter);
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
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
    mission: "Help independent teams make better decisions.",
    vision: "Every team can run a calm, evidence-led company.",
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("company routes", () => {
  test("returns company direction from list and detail routes", async () => {
    const list = await call<Array<{ id: string; mission: string; vision: string }>>("GET", "");
    assert.equal(list.status, 200);
    assert.equal(list.body[0].id, company.id);
    assert.equal(list.body[0].mission, company.mission);
    assert.equal(list.body[0].vision, company.vision);

    const detail = await call<{ mission: string; vision: string }>("GET", `/${company.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.mission, company.mission);
    assert.equal(detail.body.vision, company.vision);
  });

  test("creates a company with trimmed optional direction", async () => {
    const created = await call<{ name: string; mission: string; vision: string }>("POST", "", {
      name: "  New Co  ",
      mission: "  Make planning accessible.  ",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.name, "New Co");
    assert.equal(created.body.mission, "Make planning accessible.");
    assert.equal(created.body.vision, "");
  });

  test("creates a company without direction for backwards compatibility", async () => {
    const created = await call<{ mission: string; vision: string }>("POST", "", {
      name: "Role only",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.mission, "");
    assert.equal(created.body.vision, "");
  });

  test("makes a newly created company visible to the Member's next list refresh", async () => {
    const created = await call<{
      id: string;
      name: string;
      slug: string;
      role: Role;
      requireTwoFactor: boolean;
    }>("POST", "", { name: "Switch Here" });
    assert.equal(created.status, 200);

    const list = await call<
      Array<{
        id: string;
        name: string;
        slug: string;
        role: Role;
        requireTwoFactor: boolean;
      }>
    >("GET", "");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.find((candidate) => candidate.id === created.body.id),
      created.body,
    );

    const membership = await AppDataSource.getRepository(Membership).findOneByOrFail({
      companyId: created.body.id,
      userId: actingUserId!,
    });
    assert.equal(membership.role, "owner");
    const notebook = await AppDataSource.getRepository(Notebook).findOneByOrFail({
      companyId: created.body.id,
      slug: "general",
    });
    assert.equal(notebook.title, "General");
    assert.equal(notebook.createdById, actingUserId);
  });

  test("returns a unique routable slug for each same-name company", async () => {
    const first = await call<{ id: string; slug: string }>("POST", "", {
      name: "Repeated Name",
    });
    const second = await call<{ id: string; slug: string }>("POST", "", {
      name: "Repeated Name",
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.slug, "repeated-name");
    assert.equal(second.body.slug, "repeated-name-2");

    const list = await call<Array<{ id: string; slug: string }>>("GET", "");
    assert.equal(list.status, 200);
    assert.equal(
      list.body.find((candidate) => candidate.id === first.body.id)?.slug,
      first.body.slug,
    );
    assert.equal(
      list.body.find((candidate) => candidate.id === second.body.id)?.slug,
      second.body.slug,
    );
  });

  test("rejects unauthenticated creation without writing partial rows", async () => {
    const companyCount = await AppDataSource.getRepository(Company).count();
    const membershipCount = await AppDataSource.getRepository(Membership).count();
    const notebookCount = await AppDataSource.getRepository(Notebook).count();
    actingUserId = null;

    const response = await call("POST", "", { name: "Must Not Exist" });

    assert.equal(response.status, 401);
    assert.equal(await AppDataSource.getRepository(Company).count(), companyCount);
    assert.equal(await AppDataSource.getRepository(Membership).count(), membershipCount);
    assert.equal(await AppDataSource.getRepository(Notebook).count(), notebookCount);
  });

  test("rejects invalid creation input without writing partial rows", async () => {
    const companyCount = await AppDataSource.getRepository(Company).count();
    const membershipCount = await AppDataSource.getRepository(Membership).count();
    const notebookCount = await AppDataSource.getRepository(Notebook).count();

    const response = await call("POST", "", { name: "   " });

    assert.equal(response.status, 400);
    assert.equal(await AppDataSource.getRepository(Company).count(), companyCount);
    assert.equal(await AppDataSource.getRepository(Membership).count(), membershipCount);
    assert.equal(await AppDataSource.getRepository(Notebook).count(), notebookCount);
  });

  test("updates either field independently and trims its value", async () => {
    const updated = await call<{ mission: string; vision: string }>("PATCH", `/${company.id}`, {
      mission: "  Focus the week's highest-impact work.  ",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.mission, "Focus the week's highest-impact work.");
    assert.equal(updated.body.vision, company.vision);
  });

  test("rejects oversized context without changing stored values", async () => {
    const response = await call("PATCH", `/${company.id}`, { vision: "x".repeat(2_001) });
    assert.equal(response.status, 400);
    const stored = await AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id });
    assert.equal(stored.vision, company.vision);
  });
});
