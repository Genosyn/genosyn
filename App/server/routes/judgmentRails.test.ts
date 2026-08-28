import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AdSpendEvent } from "../db/entities/AdSpendEvent.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { budgetsRouter } from "./budgets.js";
import { companyPoliciesRouter } from "./companyPolicies.js";

/**
 * The Budgets and Policies HTTP boundary: member reads, admin writes, the
 * unforbiddable-tools guard, and the spent-this-month readout the page
 * renders headroom from.
 */

let server: Server;
let baseUrl = "";
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
  app.use("/api/companies/:cid", budgetsRouter);
  app.use("/api/companies/:cid", companyPoliciesRouter);
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

let owner: User;
let viewer: User;

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, {
    email: "founder@example.com",
    name: "Founder",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  viewer = await insert(User, {
    email: "viewer@example.com",
    name: "Viewer",
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId: company.id, userId: viewer.id, role: "member" as Role });
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

describe("budgets over HTTP", () => {
  test("admin creates; member reads with headroom; member cannot write", async () => {
    const created = await call<{ id: string }>("POST", "/budgets", {
      name: "Ads month",
      amountMinor: 10_000,
    });
    assert.equal(created.status, 200);
    await insert(AdSpendEvent, {
      companyId: company.id,
      connectionId: testId("conn"),
      employeeId: "",
      platform: "google-ads",
      adAccountRef: "",
      campaignRef: "",
      toolName: "ads_update_budget",
      mutationKind: "budget_increase",
      amountMinor: 4_000,
      currency: "USD",
    });
    actingUserId = viewer.id;
    const listed = await call<Array<{ spentThisMonthMinor: number }>>("GET", "/budgets");
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].spentThisMonthMinor, 4_000);
    assert.equal(
      (await call("POST", "/budgets", { name: "X", amountMinor: 1 })).status,
      403,
    );
    assert.equal((await call("DELETE", `/budgets/${created.body.id}`)).status, 403);
  });

  test("a budget cannot scope to another company's connection or employee", async () => {
    assert.equal(
      (
        await call("POST", "/budgets", {
          name: "X",
          amountMinor: 1,
          connectionId: "00000000-0000-4000-8000-000000000001",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("POST", "/budgets", {
          name: "X",
          amountMinor: 1,
          employeeId: "00000000-0000-4000-8000-000000000002",
        })
      ).status,
      400,
    );
  });
});

describe("company policies over HTTP", () => {
  test("admin writes, member reads; discovery tools cannot be forbidden", async () => {
    const created = await call<{ id: string }>("POST", "/company-policies", {
      title: "No competitor mail",
      blockedRecipientDomains: "rival.com",
    });
    assert.equal(created.status, 200);
    const refused = await call<{ error: string }>("POST", "/company-policies", {
      title: "Brick discovery",
      forbiddenTools: "find_tools",
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /cannot be forbidden/);
    assert.equal(
      (
        await call("PATCH", `/company-policies/${created.body.id}`, {
          forbiddenTools: "call_tool",
        })
      ).status,
      400,
    );

    actingUserId = viewer.id;
    const listed = await call<Array<{ title: string }>>("GET", "/company-policies");
    assert.equal(listed.status, 200);
    assert.equal(listed.body[0].title, "No competitor mail");
    assert.equal(
      (await call("POST", "/company-policies", { title: "X" })).status,
      403,
    );
  });
});
