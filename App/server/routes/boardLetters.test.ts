import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BoardLetter } from "../db/entities/BoardLetter.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Notification } from "../db/entities/Notification.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { boardLettersRouter } from "./boardLetters.js";
import { placeStanddown, stopStanddowns } from "../services/standdowns.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let owner: User;
let admin: User;
let member: User;
let outsider: User;
let writer: AIEmployee;
let auditor: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
          secondFactorAt: Date.now(),
        }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", boardLettersRouter);
  // Another router on the same mount: the letters guard must not reach it.
  const neighbour = express.Router({ mergeParams: true });
  neighbour.get("/neighbour", (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/companies/:cid", neighbour);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  stopStanddowns();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  stopStanddowns();
  const user = (email: string, name: string) =>
    insert(User, { email, name, passwordHash: "x", sessionVersion: 0 });
  owner = await user("letters-owner@example.test", "Owner");
  admin = await user("letters-admin@example.test", "Admin");
  member = await user("letters-member@example.test", "Member");
  outsider = await user("letters-outsider@example.test", "Outsider");
  company = await insert(Company, { name: "Sunwise", slug: "letters-sunwise", ownerId: owner.id });
  otherCompany = await insert(Company, {
    name: "Other",
    slug: "letters-other",
    ownerId: outsider.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
  // No AI Model on either: nothing in these tests may reach a provider.
  writer = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "letters-ada",
    role: "Chief executive",
    soulBody: "",
  });
  auditor = await insert(AIEmployee, {
    companyId: company.id,
    name: "Otto",
    slug: "letters-otto",
    role: "Auditor",
    soulBody: "",
  });
  actingUserId = owner.id;
});

type Doc = Record<string, unknown>;

async function call<T = Doc>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function letter(values: Partial<BoardLetter> = {}): Promise<BoardLetter> {
  return insert(BoardLetter, {
    companyId: company.id,
    number: 1,
    month: "2026-09",
    periodStart: new Date("2026-09-01T00:00:00Z"),
    periodEnd: new Date("2026-10-01T00:00:00Z"),
    timeZone: "",
    status: "ready",
    triggerKind: "schedule",
    attempts: 1,
    startedAt: new Date("2026-10-01T06:00:00Z"),
    writtenAt: new Date("2026-10-01T06:01:00Z"),
    writerEmployeeId: writer.id,
    writerName: "Ada",
    writerRole: "Chief executive",
    auditStatus: "clean",
    auditorEmployeeId: auditor.id,
    auditorName: "Otto",
    summary: "On track.",
    body: "We finished 2 Runs.",
    figuresJson: JSON.stringify({ figures: [], goals: [] }),
    ...values,
  });
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition never held");
}

const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/board-letters"],
  ["GET", "/board-letters/settings"],
  [
    "PUT",
    "/board-letters/settings",
    { enabled: false, writerEmployeeId: null, auditorEmployeeId: null },
  ],
  ["POST", "/board-letters/write", {}],
  ["GET", "/board-letters/1"],
  ["POST", "/board-letters/1/audit", {}],
  ["POST", "/board-letters/1/read", {}],
];

describe("who may reach letters to the board", () => {
  test("a Member reaches none of it, reads included", async () => {
    await letter();
    actingUserId = member.id;
    for (const [method, path, body] of ROUTES) {
      const response = await call(method, path, body);
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    // The guard is this router's own: a neighbouring route is untouched.
    assert.equal((await call("GET", "/neighbour")).status, 200);
  });

  test("owners and admins read the letters and their settings", async () => {
    await letter();
    for (const userId of [owner.id, admin.id]) {
      actingUserId = userId;
      const list = await call<{ letters: Doc[]; settings: Doc }>("GET", "/board-letters");
      assert.equal(list.status, 200);
      assert.equal(list.body.letters.length, 1);
      assert.equal(list.body.letters[0].monthLabel, "September 2026");
      assert.equal("body" in list.body.letters[0], false);
      const one = await call("GET", "/board-letters/1");
      assert.equal(one.status, 200);
      assert.equal(one.body.body, "We finished 2 Runs.");
    }
  });

  test("another company's owner reaches nothing here", async () => {
    await letter();
    actingUserId = outsider.id;
    for (const [method, path, body] of ROUTES) {
      const response = await call(method, path, body);
      assert.ok(
        response.status === 403 || response.status === 404,
        `${method} ${path}: ${response.status}`,
      );
    }
    // And their own company has no letter No. 1.
    assert.equal((await call("GET", "/board-letters/1", undefined, otherCompany.id)).status, 404);
  });
});

describe("the settings", () => {
  test("appoint the writer and the auditor, and read back who appointed it", async () => {
    actingUserId = admin.id;
    const saved = await call<Doc & { auditorAppointedBy: Doc; writer: Doc; auditor: Doc }>(
      "PUT",
      "/board-letters/settings",
      { enabled: true, writerEmployeeId: writer.id, auditorEmployeeId: auditor.id },
    );
    assert.equal(saved.status, 200);
    assert.equal(saved.body.enabled, true);
    assert.equal(saved.body.writer.name, "Ada");
    assert.equal(saved.body.auditor.name, "Otto");
    assert.equal(saved.body.auditorAppointedBy.name, "Admin");
    const read = await call<Doc & { waiting: string }>("GET", "/board-letters/settings");
    assert.equal(read.status, 200);
    assert.match(read.body.waiting, /Ada needs a connected AI Model/);
  });

  test("refuse a writer auditing itself, and AI Employees of another company", async () => {
    const self = await call<{ error: string }>("PUT", "/board-letters/settings", {
      enabled: true,
      writerEmployeeId: writer.id,
      auditorEmployeeId: writer.id,
    });
    assert.equal(self.status, 400);
    assert.match(self.body.error, /other than the writer/);
    const stranger = await insert(AIEmployee, {
      companyId: otherCompany.id,
      name: "Stranger",
      slug: "letters-stranger",
      role: "Spy",
      soulBody: "",
    });
    const foreign = await call("PUT", "/board-letters/settings", {
      enabled: false,
      writerEmployeeId: writer.id,
      auditorEmployeeId: stranger.id,
    });
    assert.equal(foreign.status, 400);
  });

  test("validate the body at the boundary", async () => {
    for (const body of [
      {},
      { enabled: true, writerEmployeeId: "not-a-uuid", auditorEmployeeId: null },
      { enabled: "yes", writerEmployeeId: null, auditorEmployeeId: null },
      {
        enabled: false,
        writerEmployeeId: null,
        auditorEmployeeId: null,
        auditorInstructions: "be kind",
      },
    ]) {
      const response = await call("PUT", "/board-letters/settings", body);
      assert.equal(response.status, 400, JSON.stringify(body));
    }
  });
});

describe("writing and auditing on request", () => {
  test("needs a writer, and refuses while it is stood down", async () => {
    const none = await call<{ error: string }>("POST", "/board-letters/write", {});
    assert.equal(none.status, 400);
    await call("PUT", "/board-letters/settings", {
      enabled: false,
      writerEmployeeId: writer.id,
      auditorEmployeeId: null,
    });
    await placeStanddown({
      companyId: company.id,
      scope: "employee",
      scopeId: writer.id,
      reason: "Hold",
      placedByUserId: owner.id,
    });
    const held = await call<{ error: string }>("POST", "/board-letters/write", {});
    assert.equal(held.status, 409);
    assert.match(held.body.error, /stood down/);
  });

  test("starts the letter and answers before it is written", async () => {
    await call("PUT", "/board-letters/settings", {
      enabled: false,
      writerEmployeeId: writer.id,
      auditorEmployeeId: null,
    });
    const started = await call<Doc>("POST", "/board-letters/write", {});
    assert.equal(started.status, 202);
    assert.equal(started.body.number, 1);
    assert.equal(started.body.status, "writing");
    assert.equal(started.body.triggerKind, "manual");
    // Ada has no AI Model, so the background work fails fast and says why.
    await eventually(async () => {
      const row = await AppDataSource.getRepository(BoardLetter).findOneBy({
        companyId: company.id,
      });
      return row?.status === "failed";
    });
    const detail = await call<Doc>("GET", "/board-letters/1");
    assert.match(String(detail.body.errorMessage), /needs a connected AI Model/);
    // A body is refused even on an action that takes none.
    assert.equal((await call("POST", "/board-letters/write", { force: true })).status, 400);
  });

  test("audits again only a letter without an opinion", async () => {
    await letter({ auditStatus: "clean" });
    const refused = await call<{ error: string }>("POST", "/board-letters/1/audit", {});
    assert.equal(refused.status, 409);
    assert.equal((await call("POST", "/board-letters/7/audit", {})).status, 404);
    assert.equal((await call("POST", "/board-letters/x/audit", {})).status, 400);
    assert.equal((await call("GET", "/board-letters/0")).status, 400);
  });
});

describe("reading a letter", () => {
  async function bell(userId: string, letterId: string): Promise<Notification> {
    return insert(Notification, {
      companyId: company.id,
      userId,
      kind: "board_letter_ready",
      title: "Letter No. 1 to the board · September 2026",
      body: "On track.",
      link: "/c/letters-sunwise/tldrs/letters/1",
      actorKind: "ai",
      actorId: writer.id,
      entityKind: "board_letter",
      entityId: letterId,
    });
  }

  async function readAt(id: string): Promise<Date | null> {
    return (await AppDataSource.getRepository(Notification).findOneByOrFail({ id })).readAt;
  }

  test("marks the reader's own notification read, and nobody else's", async () => {
    const sent = await letter({ deliveredAt: new Date("2026-10-01T06:02:00Z") });
    const ownerBell = await bell(owner.id, sent.id);
    const adminBell = await bell(admin.id, sent.id);

    const read = await call("POST", "/board-letters/1/read", {});
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, { ok: true });
    assert.ok(await readAt(ownerBell.id));
    assert.equal(await readAt(adminBell.id), null);
    // Again, or with nothing left unread, it still answers the same.
    assert.equal((await call("POST", "/board-letters/1/read", {})).status, 200);
  });

  test("is refused a Member who still holds a bell row from their time as admin", async () => {
    const sent = await letter({ deliveredAt: new Date("2026-10-01T06:02:00Z") });
    const kept = await bell(member.id, sent.id);
    actingUserId = member.id;
    assert.equal((await call("POST", "/board-letters/1/read", {})).status, 403);
    assert.equal(await readAt(kept.id), null);
  });

  test("validates the letter and the body at the boundary", async () => {
    await letter();
    assert.equal((await call("POST", "/board-letters/7/read", {})).status, 404);
    assert.equal((await call("POST", "/board-letters/x/read", {})).status, 400);
    assert.equal((await call("POST", "/board-letters/1/read", { all: true })).status, 400);
  });
});
