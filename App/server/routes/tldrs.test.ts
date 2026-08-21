import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Tldr } from "../db/entities/Tldr.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { tldrsRouter } from "./tldrs.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let owner: User;
let member: User;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
          secondFactorAt: Date.now(),
        }
      : null;
    next();
  });
  app.use("/api/companies/:cid", tldrsRouter);
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
  owner = await insert(User, {
    email: "tldr-route-owner@example.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "tldr-route-member@example.test",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "tldr-route-acme", ownerId: owner.id });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "tldr-route-other",
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey-route",
    role: "Chief of staff",
    soulBody: "",
  });
  actingUserId = owner.id;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: {
      connection: "close",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function readyTldr(companyId = company.id): Promise<Tldr> {
  const now = new Date("2026-08-20T12:00:00.000Z");
  return insert(Tldr, {
    companyId,
    employeeId: employee.id,
    employeeName: employee.name,
    employeeSlug: employee.slug,
    employeeRole: employee.role,
    employeeAvatarKey: null,
    status: "ready",
    triggerKind: "schedule",
    periodStart: new Date(now.getTime() - 4 * 60 * 60_000),
    periodEnd: now,
    title: "Morning update",
    summary: "One useful sentence.",
    body: "## Done\n\nImportant work shipped.",
    sourceStatsJson: JSON.stringify({
      journalEntries: 1,
      routineRuns: 2,
      channelMessages: 3,
      channels: 1,
    }),
    errorMessage: "",
    finishedAt: now,
  });
}

describe("TLDR route contract and authorization", () => {
  test("lets an admin configure and synchronously reports an empty generation window", async () => {
    const saved = await call<{
      enabled: boolean;
      cadence: string;
      employeeId: string | null;
      lastCoveredAt: string | null;
      lastAttemptAt: string | null;
    }>("PUT", "/tldrs/settings", {
      enabled: false,
      cadence: "eight_hours",
      employeeId: employee.id,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.cadence, "eight_hours");
    assert.equal(saved.body.employeeId, employee.id);
    assert.ok(Object.hasOwn(saved.body, "lastCoveredAt"));
    assert.ok(Object.hasOwn(saved.body, "lastAttemptAt"));

    const generated = await call<{ status: string }>("POST", "/tldrs/generate", {});
    assert.equal(generated.status, 200);
    assert.deepEqual(generated.body, { status: "empty" });
  });

  test("returns the list envelope and keeps dismissal private to one Member", async () => {
    const tldr = await readyTldr();
    actingUserId = member.id;
    const list = await call<{
      items: Array<{ id: string; dismissed: boolean; sourceStats: Record<string, number> }>;
      total: number;
      unreadCount: number;
    }>("GET", "/tldrs");
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.unreadCount, 1);
    assert.equal(list.body.items[0].id, tldr.id);
    assert.equal(list.body.items[0].dismissed, false);
    assert.deepEqual(Object.keys(list.body.items[0].sourceStats).sort(), [
      "channelMessages",
      "channels",
      "journalEntries",
      "routineRuns",
    ]);

    const dismissed = await call<{ id: string; dismissed: boolean }>(
      "POST",
      `/tldrs/${tldr.id}/dismiss`,
      {},
    );
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.dismissed, true);
    const again = await call("POST", `/tldrs/${tldr.id}/dismiss`, {});
    assert.equal(again.status, 200);
    assert.equal((await call<{ unreadCount: number }>("GET", "/tldrs")).body.unreadCount, 0);

    actingUserId = owner.id;
    assert.equal((await call<{ unreadCount: number }>("GET", "/tldrs")).body.unreadCount, 1);
  });

  test("allows Member reads and dismissals but reserves settings and generation for admins", async () => {
    const tldr = await readyTldr();
    actingUserId = member.id;
    const defaults = await call<{ enabled: boolean; cadence: string; employeeId: string | null }>(
      "GET",
      "/tldrs/settings",
    );
    assert.equal(defaults.status, 200);
    assert.equal(defaults.body.enabled, true);
    assert.equal(defaults.body.cadence, "daily");
    assert.equal(defaults.body.employeeId, null);
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          enabled: false,
          cadence: "daily",
          employeeId: employee.id,
        })
      ).status,
      403,
    );
    assert.equal((await call("POST", "/tldrs/generate", {})).status, 403);
    assert.equal((await call("POST", `/tldrs/${tldr.id}/dismiss`, {})).status, 200);
    actingUserId = owner.id;
    assert.equal(
      (await call("POST", `/tldrs/${tldr.id}/dismiss`, {}, otherCompany.id)).status,
      404,
    );
  });

  test("rejects unknown cadence and extra body fields at the zod boundary", async () => {
    assert.equal(
      (
        await call("PUT", "/tldrs/settings", {
          enabled: false,
          cadence: "hourly",
          employeeId: employee.id,
        })
      ).status,
      400,
    );
    assert.equal((await call("POST", "/tldrs/generate", { surprise: true })).status, 400);
  });
});
