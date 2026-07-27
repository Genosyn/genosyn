import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { Activity } from "../db/entities/Activity.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Contact } from "../db/entities/Contact.js";
import { Deal } from "../db/entities/Deal.js";
import { DealHistoryEvent } from "../db/entities/DealHistoryEvent.js";
import { DealStage } from "../db/entities/DealStage.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Suppression } from "../db/entities/Suppression.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { revenueRouter } from "./revenue.js";
import { revenueOperationsRouter } from "./revenueOperations.js";

/**
 * Route-level tests for the Revenue HTTP surface.
 *
 * These run the real router over the real services against an in-memory
 * database — the only things faked are the two layers that are not this file's
 * subject: the cookie session (a middleware that stamps `req.session` the way
 * `cookie-session` would) and the mount point. Everything downstream of
 * `requireAuth` is genuine, which is the point: the bugs worth catching here
 * are status codes, guard scoping and route-ordering, and all three are
 * invisible to a service test.
 *
 * The app is booted once and listens on an ephemeral port, so the assertions
 * are made against actual HTTP responses rather than a mocked `res`. A mocked
 * response object cannot tell you that `/revenue/deals/board` is being matched
 * by `/revenue/deals/:id`, which is exactly the class of mistake this file
 * exists to catch.
 */

let server: Server;
let baseUrl: string;

/** Whose session the next request carries. Mutated per test. */
let actingUserId: string | null = null;

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
  app.use("/api/companies/:cid", revenueRouter);
  app.use("/api/companies/:cid", revenueOperationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  await closeTestDb();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

let companyId: string;
let ownerId: string;
let memberId: string;

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
  });
  ownerId = owner.id;
  memberId = member.id;
  companyId = company.id;
  await insert(Membership, { companyId, userId: ownerId, role: "owner" as Role });
  await insert(Membership, { companyId, userId: memberId, role: "member" as Role });
  actingUserId = ownerId;
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function auditActions(): Promise<string[]> {
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where: { companyId },
  });
  return rows.map((r) => r.action);
}

async function createContact(name = "Ada Lovelace", email = "ada@example.com") {
  const res = await call<{ id: string; name: string }>("POST", "/revenue/contacts", {
    name,
    email,
  });
  assert.equal(res.status, 201);
  return res.body;
}

// ── Guards ─────────────────────────────────────────────────────────────────

describe("revenue routes — auth and company scoping", () => {
  test("rejects an unauthenticated request", async () => {
    actingUserId = null;
    const res = await call("GET", "/revenue/contacts");
    assert.equal(res.status, 401);
    assert.equal(res.body.error, "Unauthorized");
  });

  test("rejects a user who is not a member of the company", async () => {
    const stranger = await insert(User, {
      email: "stranger@example.com",
      name: "Stranger",
      passwordHash: "x",
      sessionVersion: 0,
    });
    actingUserId = stranger.id;
    const res = await call("GET", "/revenue/contacts");
    assert.equal(res.status, 403);
  });

  test("a contact in another company is a 404, not a leak", async () => {
    const mine = await createContact();
    const other = await insert(Company, {
      name: "Other",
      slug: "other",
      ownerId,
    });
    await insert(Membership, { companyId: other.id, userId: ownerId, role: "owner" as Role });

    const res = await fetch(`${baseUrl}/api/companies/${other.id}/revenue/contacts/${mine.id}`);
    assert.equal(res.status, 404);
  });
});

// ── Contacts ───────────────────────────────────────────────────────────────

describe("revenue routes — contacts", () => {
  test("creates, lists and audits a contact", async () => {
    const contact = await createContact();
    assert.equal(contact.name, "Ada Lovelace");

    const list = await call<{ rows: unknown[]; total: number }>("GET", "/revenue/contacts");
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.deepEqual(await auditActions(), ["revenue.contact.create"]);
  });

  test("a duplicate address is a 409 carrying the existing id", async () => {
    const first = await createContact();
    const res = await call<{ error: string; existingId: string }>("POST", "/revenue/contacts", {
      name: "Ada Again",
      email: "ada@example.com",
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.existingId, first.id);
  });

  test("patching onto somebody else's address is a 409", async () => {
    const first = await createContact("Ada", "ada@example.com");
    const second = await createContact("Grace", "grace@example.com");
    const res = await call<{ existingId: string }>("PATCH", `/revenue/contacts/${second.id}`, {
      email: "ada@example.com",
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.existingId, first.id);
  });

  test("detail carries the timeline and the open deals", async () => {
    const contact = await createContact();
    await call("POST", "/revenue/activities", {
      kind: "note",
      subject: "Intro call booked",
      contactId: contact.id,
    });
    const deal = await call<{ id: string }>("POST", "/revenue/deals", {
      title: "Acme expansion",
      primaryContactId: contact.id,
      amountCents: 50_000,
    });
    assert.equal(deal.status, 201);

    const res = await call<{
      contact: { id: string };
      activities: Array<{ kind: string }>;
      openDeals: Array<{ id: string }>;
    }>("GET", `/revenue/contacts/${contact.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.contact.id, contact.id);
    assert.equal(res.body.openDeals.length, 1);
    // The note plus the `deal_created` the deal service wrote — the timeline
    // includes activities on the contact's deals.
    const kinds = res.body.activities.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ["deal_created", "note"]);
  });

  test("archive then restore round-trips", async () => {
    const contact = await createContact();
    const archived = await call<{ archivedAt: string | null }>(
      "POST",
      `/revenue/contacts/${contact.id}/archive`,
    );
    assert.equal(archived.status, 200);
    assert.notEqual(archived.body.archivedAt, null);

    const hidden = await call<{ total: number }>("GET", "/revenue/contacts");
    assert.equal(hidden.body.total, 0);

    const restored = await call<{ archivedAt: string | null }>(
      "POST",
      `/revenue/contacts/${contact.id}/restore`,
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.archivedAt, null);

    const visible = await call<{ total: number }>("GET", "/revenue/contacts");
    assert.equal(visible.body.total, 1);
  });

  test("a nonsense pagination value is a 400, not a 500", async () => {
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/revenue/contacts?limit=banana`);
    assert.equal(res.status, 400);
  });

  test("assigns a Contact to an AI Employee or Member and keeps one owner", async () => {
    const employee = await insert(AIEmployee, {
      companyId,
      name: "Revenue owner",
      slug: "revenue-owner",
      role: "Account executive",
    });
    const created = await call<{
      id: string;
      ownerId: string | null;
      ownerEmployeeId: string | null;
    }>("POST", "/revenue/contacts", {
      name: "Owned contact",
      email: "owned@example.com",
      ownerEmployeeId: employee.id,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.ownerEmployeeId, employee.id);
    assert.equal(created.body.ownerId, null);

    const updated = await call<{
      ownerId: string | null;
      ownerEmployeeId: string | null;
    }>("PATCH", `/revenue/contacts/${created.body.id}`, { ownerId });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.ownerId, ownerId);
    assert.equal(updated.body.ownerEmployeeId, null);
  });

  test("a missing contact is a 404", async () => {
    const res = await call("GET", "/revenue/contacts/00000000-0000-0000-0000-000000000000");
    assert.equal(res.status, 404);
  });
});

// ── Stages ─────────────────────────────────────────────────────────────────

describe("revenue routes — stages", () => {
  test("the first read seeds the default ladder", async () => {
    const res = await call<Array<{ name: string; kind: string }>>("GET", "/revenue/stages");
    assert.equal(res.status, 200);
    assert.ok(res.body.length >= 7);
    assert.equal(res.body[0].name, "New");
    assert.ok(res.body.some((s) => s.kind === "won"));
  });

  test("a new stage lands at the end of the board", async () => {
    const before = await call<Array<{ sortOrder: number }>>("GET", "/revenue/stages");
    const highest = Math.max(...before.body.map((s) => s.sortOrder));
    const created = await call<{ sortOrder: number; slug: string }>("POST", "/revenue/stages", {
      name: "Security Review",
      probability: 70,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.sortOrder, highest + 1);
    assert.equal(created.body.slug, "security-review");
  });

  test("reorder rewrites sortOrder wholesale", async () => {
    const initial = await call<Array<{ id: string }>>("GET", "/revenue/stages");
    const reversed = [...initial.body].reverse().map((s) => s.id);
    const res = await call<Array<{ id: string }>>("POST", "/revenue/stages/reorder", {
      orderedIds: reversed,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((s) => s.id),
      reversed,
    );
  });

  test("archiving a stage holding an open deal is refused with 409", async () => {
    const stages = await call<Array<{ id: string; kind: string }>>("GET", "/revenue/stages");
    const first = stages.body.find((s) => s.kind === "open")!;
    const deal = await call<{ id: string }>("POST", "/revenue/deals", {
      title: "Sitting in New",
      stageId: first.id,
    });
    assert.equal(deal.status, 201);

    const refused = await call<{ error: string }>("DELETE", `/revenue/stages/${first.id}`);
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /1 open deal /);

    // The stage survived the refusal.
    const stage = await AppDataSource.getRepository(DealStage).findOneBy({ id: first.id });
    assert.equal(stage?.archivedAt, null);

    // Move the deal out, and the same call now succeeds.
    const elsewhere = stages.body.find((s) => s.kind === "open" && s.id !== first.id)!;
    await call("POST", `/revenue/deals/${deal.body.id}/stage`, { stageId: elsewhere.id });
    const archived = await call("DELETE", `/revenue/stages/${first.id}`);
    assert.equal(archived.status, 200);
  });

  test("a won deal does not block archiving its stage", async () => {
    const stages = await call<Array<{ id: string; kind: string }>>("GET", "/revenue/stages");
    const won = stages.body.find((s) => s.kind === "won")!;
    const deal = await call<{ id: string }>("POST", "/revenue/deals", { title: "Closed" });
    await call("POST", `/revenue/deals/${deal.body.id}/stage`, { stageId: won.id });

    const res = await call("DELETE", `/revenue/stages/${won.id}`);
    assert.equal(res.status, 200);
  });
});

// ── Deals ──────────────────────────────────────────────────────────────────

describe("revenue routes — deals", () => {
  test("/revenue/deals/board resolves to the board, not to :id", async () => {
    await call("POST", "/revenue/deals", { title: "On the board", amountCents: 1_000 });
    const res = await call<{ columns: Array<{ stage: { name: string }; deals: unknown[] }> }>(
      "GET",
      "/revenue/deals/board",
    );
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.columns));
    assert.ok(res.body.columns.length >= 7);
    assert.equal(res.body.columns[0].deals.length, 1);
  });

  test("an unknown stage on create is a 400, not a 500", async () => {
    const res = await call<{ error: string }>("POST", "/revenue/deals", {
      title: "Bad stage",
      stageId: "00000000-0000-0000-0000-000000000000",
    });
    assert.equal(res.status, 400);
  });

  test("moving into a won stage closes the deal and logs it", async () => {
    const stages = await call<Array<{ id: string; kind: string }>>("GET", "/revenue/stages");
    const won = stages.body.find((s) => s.kind === "won")!;
    const deal = await call<{ id: string }>("POST", "/revenue/deals", {
      title: "Winnable",
      amountCents: 120_000,
    });

    const moved = await call<{ status: string; closedAt: string | null; stageKind: string }>(
      "POST",
      `/revenue/deals/${deal.body.id}/stage`,
      { stageId: won.id },
    );
    assert.equal(moved.status, 200);
    assert.equal(moved.body.status, "won");
    assert.notEqual(moved.body.closedAt, null);

    // The stage move must leave an activity behind — the funnel report reads it.
    const activities = await AppDataSource.getRepository(Activity).find({
      where: { companyId, dealId: deal.body.id },
    });
    assert.ok(activities.some((a) => a.kind === "deal_won"));
    assert.ok((await auditActions()).includes("revenue.deal.stage"));
  });

  test("a lost move records the reason", async () => {
    const stages = await call<Array<{ id: string; kind: string }>>("GET", "/revenue/stages");
    const lost = stages.body.find((s) => s.kind === "lost")!;
    const deal = await call<{ id: string }>("POST", "/revenue/deals", { title: "Loseable" });
    const moved = await call<{ status: string; lostReason: string }>(
      "POST",
      `/revenue/deals/${deal.body.id}/stage`,
      { stageId: lost.id, lostReason: "Went with a competitor" },
    );
    assert.equal(moved.body.status, "lost");
    assert.equal(moved.body.lostReason, "Went with a competitor");
  });

  test("detail carries the timeline and the buying committee", async () => {
    const contact = await createContact();
    const deal = await call<{ id: string }>("POST", "/revenue/deals", { title: "Committee" });
    const added = await call("POST", `/revenue/deals/${deal.body.id}/contacts`, {
      contactId: contact.id,
      role: "Economic buyer",
    });
    assert.equal(added.status, 201);

    const res = await call<{
      deal: { id: string };
      activities: unknown[];
      contacts: Array<{ role: string; contact: { id: string } | null }>;
    }>("GET", `/revenue/deals/${deal.body.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.contacts.length, 1);
    assert.equal(res.body.contacts[0].role, "Economic buyer");
    assert.equal(res.body.contacts[0].contact?.id, contact.id);

    const removed = await call("DELETE", `/revenue/deals/${deal.body.id}/contacts/${contact.id}`);
    assert.equal(removed.status, 200);
    const after = await call<{ contacts: unknown[] }>("GET", `/revenue/deals/${deal.body.id}`);
    assert.equal(after.body.contacts.length, 0);
  });

  test("attaching a contact from another company is refused", async () => {
    const other = await insert(Contact, {
      companyId: "co_somewhere_else",
      name: "Outsider",
      email: "out@example.com",
    });
    const deal = await call<{ id: string }>("POST", "/revenue/deals", { title: "Guarded" });
    const res = await call("POST", `/revenue/deals/${deal.body.id}/contacts`, {
      contactId: other.id,
    });
    assert.equal(res.status, 400);
  });

  test("archiving hides a deal from the list", async () => {
    const deal = await call<{ id: string }>("POST", "/revenue/deals", { title: "Gone" });
    const archived = await call("POST", `/revenue/deals/${deal.body.id}/archive`);
    assert.equal(archived.status, 200);
    const list = await call<{ total: number }>("GET", "/revenue/deals");
    assert.equal(list.body.total, 0);
    const stored = await AppDataSource.getRepository(Deal).findOneBy({ id: deal.body.id });
    assert.notEqual(stored?.archivedAt, null);
  });
});

// ── Activities ─────────────────────────────────────────────────────────────

describe("revenue routes — activities", () => {
  test("a human may log a note", async () => {
    const contact = await createContact();
    const res = await call<{ kind: string; subject: string }>("POST", "/revenue/activities", {
      kind: "call",
      subject: "Discovery",
      bodyText: "Budget confirmed.",
      contactId: contact.id,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, "call");
  });

  test("derived kinds cannot be forged through the API", async () => {
    // `deal_won` is evidence the funnel report counts. Only the deal service
    // may write it; a client posting one would fabricate a conversion.
    for (const kind of ["deal_won", "stage_change", "email_out", "unsubscribe"]) {
      const res = await call("POST", "/revenue/activities", { kind, subject: "nope" });
      assert.equal(res.status, 400, `${kind} should be rejected`);
    }
  });

  test("a link to another company's contact is refused", async () => {
    const outsider = await insert(Contact, {
      companyId: "co_somewhere_else",
      name: "Outsider",
      email: "out2@example.com",
    });
    const res = await call("POST", "/revenue/activities", {
      kind: "note",
      subject: "leak",
      contactId: outsider.id,
    });
    assert.equal(res.status, 400);
  });

  test("the list filters by kind", async () => {
    const contact = await createContact();
    await call("POST", "/revenue/activities", {
      kind: "note",
      subject: "n",
      contactId: contact.id,
    });
    await call("POST", "/revenue/activities", {
      kind: "meeting",
      subject: "m",
      contactId: contact.id,
    });
    const res = await fetch(
      `${baseUrl}/api/companies/${companyId}/revenue/activities?kinds=meeting`,
    );
    const body = (await res.json()) as { rows: Array<{ kind: string }>; total: number };
    assert.equal(body.total, 1);
    assert.equal(body.rows[0].kind, "meeting");
  });

  test("gets, corrects, exports, and deletes a manual activity", async () => {
    const created = await call<{ id: string }>("POST", "/revenue/activities", {
      kind: "note",
      subject: "Original note",
      bodyText: "Cleanup target",
    });
    const read = await call<{ id: string }>("GET", `/revenue/activities/${created.body.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.id, created.body.id);
    const updated = await call<{ subject: string }>(
      "PATCH",
      `/revenue/activities/${created.body.id}`,
      { subject: "Corrected note" },
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.subject, "Corrected note");

    const exported = await fetch(
      `${baseUrl}/api/companies/${companyId}/revenue/activities/export?q=corrected`,
    );
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(await exported.text(), /Corrected note/);

    const removed = await call("DELETE", `/revenue/activities/${created.body.id}`);
    assert.equal(removed.status, 200);
    assert.equal(
      (await call<{ total: number }>("GET", "/revenue/activities?q=corrected")).body.total,
      0,
    );
  });

  test("refuses to edit machine-recorded activity evidence", async () => {
    const machine = await insert(Activity, {
      companyId,
      kind: "signal",
      subject: "Product threshold",
      occurredAt: new Date(),
    });
    const res = await call("PATCH", `/revenue/activities/${machine.id}`, {
      subject: "Rewritten",
    });
    assert.equal(res.status, 400);
  });
});

// ── Suppressions ───────────────────────────────────────────────────────────

describe("revenue routes — suppressions", () => {
  test("creating is idempotent and normalizes the address", async () => {
    const first = await call<{ id: string; email: string }>("POST", "/revenue/suppressions", {
      email: "  Ada@Example.COM ",
      reason: "unsubscribe",
    });
    assert.equal(first.status, 201);
    assert.equal(first.body.email, "ada@example.com");

    const again = await call<{ id: string; reason: string }>("POST", "/revenue/suppressions", {
      email: "ada@example.com",
      reason: "manual",
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, first.body.id);
    // The original, stronger reason survives.
    assert.equal(again.body.reason, "unsubscribe");

    const rows = await AppDataSource.getRepository(Suppression).find({ where: { companyId } });
    assert.equal(rows.length, 1);
  });

  test("an unusable address is a 400", async () => {
    const res = await call("POST", "/revenue/suppressions", {
      email: "not an address",
      reason: "manual",
    });
    assert.equal(res.status, 400);
  });

  test("the list filters by reason and searches the address", async () => {
    await call("POST", "/revenue/suppressions", { email: "a@x.com", reason: "bounce" });
    await call("POST", "/revenue/suppressions", { email: "b@y.com", reason: "unsubscribe" });

    const byReason = await fetch(
      `${baseUrl}/api/companies/${companyId}/revenue/suppressions?reason=bounce`,
    );
    const filtered = (await byReason.json()) as { total: number };
    assert.equal(filtered.total, 1);

    const bySearch = await fetch(
      `${baseUrl}/api/companies/${companyId}/revenue/suppressions?q=y.com`,
    );
    const searched = (await bySearch.json()) as { rows: Array<{ email: string }> };
    assert.equal(searched.rows[0].email, "b@y.com");
  });

  test("deleting an unknown row is a 404, and a real one is audited", async () => {
    const missing = await call(
      "DELETE",
      "/revenue/suppressions/00000000-0000-0000-0000-000000000000",
    );
    assert.equal(missing.status, 404);

    const row = await call<{ id: string }>("POST", "/revenue/suppressions", {
      email: "c@z.com",
      reason: "complaint",
    });
    const res = await call("DELETE", `/revenue/suppressions/${row.body.id}`);
    assert.equal(res.status, 200);
    assert.ok((await auditActions()).includes("revenue.suppression.delete"));
  });
});

// ── Revenue operations ────────────────────────────────────────────────────

describe("revenue routes — operating system", () => {
  test("creates a prospect account, assigns a follow-up, and returns it in the queue", async () => {
    const account = await call<{ id: string; accountStatus: string }>("POST", "/revenue/accounts", {
      name: "Prospect Co",
      domain: "https://www.prospect.example",
      ownerId,
    });
    assert.equal(account.status, 201);
    assert.equal(account.body.accountStatus, "prospect");

    const task = await call<{ id: string }>("POST", "/revenue/follow-ups", {
      subject: "Send the security questionnaire",
      customerId: account.body.id,
      assignedUserId: ownerId,
      dueAt: "2026-08-01T09:00:00.000Z",
      reminderAt: "2026-08-01T08:00:00.000Z",
      priority: "high",
    });
    assert.equal(task.status, 201);
    const queue = await call<{ rows: Array<{ id: string; assigneeName: string }> }>(
      "GET",
      "/revenue/follow-ups?state=all",
    );
    assert.equal(queue.status, 200);
    assert.equal(queue.body.rows[0].id, task.body.id);
    assert.equal(queue.body.rows[0].assigneeName, "Owner");
  });

  test("lets a Revenue member read accounts without Finance access", async () => {
    await call("POST", "/revenue/accounts", {
      name: "Member-visible prospect",
      domain: "member-visible.example",
    });

    actingUserId = memberId;
    const accounts = await call<{ rows: Array<{ name: string }> }>("GET", "/revenue/accounts");

    assert.equal(accounts.status, 200);
    assert.ok(accounts.body.rows.some((account) => account.name === "Member-visible prospect"));
  });

  test("previews, confirms, audits, and exposes archived Accounts after a merge", async () => {
    const source = await call<{ id: string; name: string }>("POST", "/revenue/accounts", {
      name: "Duplicate Account",
      domain: "duplicate-account.example",
    });
    const target = await call<{ id: string; name: string }>("POST", "/revenue/accounts", {
      name: "Canonical Account",
      domain: "canonical-account.example",
    });
    const contact = await call<{ id: string }>("POST", "/revenue/contacts", {
      name: "Merge Contact",
      email: "merge-contact@example.com",
      customerId: source.body.id,
    });
    const deal = await call<{ id: string }>("POST", "/revenue/deals", {
      title: "Merge Deal",
      customerId: source.body.id,
      primaryContactId: contact.body.id,
    });
    assert.equal(deal.status, 201);

    const preview = await call<{ counts: { contacts: number; deals: number } }>(
      "GET",
      `/revenue/accounts/${source.body.id}/merge-preview?targetAccountId=${target.body.id}`,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.counts.contacts, 1);
    assert.equal(preview.body.counts.deals, 1);

    const refused = await call("POST", `/revenue/accounts/${source.body.id}/merge`, {
      targetAccountId: target.body.id,
      confirmSourceName: "not the source name",
    });
    assert.equal(refused.status, 409);

    const merged = await call<{ target: { id: string }; operationId: string }>(
      "POST",
      `/revenue/accounts/${source.body.id}/merge`,
      {
        targetAccountId: target.body.id,
        confirmSourceName: source.body.name,
      },
    );
    assert.equal(merged.status, 200);
    assert.equal(merged.body.target.id, target.body.id);
    assert.ok((await auditActions()).includes("revenue.account.merge"));

    const active = await call<{ rows: Array<{ id: string }> }>("GET", "/revenue/accounts");
    assert.deepEqual(
      active.body.rows.map((account) => account.id),
      [target.body.id],
    );
    const all = await call<{ rows: Array<{ id: string; archivedAt: string | null }> }>(
      "GET",
      "/revenue/accounts?includeArchived=true",
    );
    assert.equal(all.body.rows.length, 2);
    assert.ok(all.body.rows.find((account) => account.id === source.body.id)?.archivedAt);

    const restored = await call("POST", `/revenue/accounts/${source.body.id}/restore`);
    assert.equal(restored.status, 409);

    const undone = await call("POST", `/revenue/operations/${merged.body.operationId}/undo`, {
      confirm: "UNDO",
    });
    assert.equal(undone.status, 200);
    const activeAfterUndo = await call<{ rows: Array<{ id: string }> }>("GET", "/revenue/accounts");
    assert.ok(activeAfterUndo.body.rows.some((account) => account.id === source.body.id));
    assert.ok((await auditActions()).includes("revenue.operation.undo"));
  });

  test("uses controlled classifications and typed fields for filterable deal data", async () => {
    const field = await call<{ key: string }>("POST", "/revenue/custom-fields", {
      resourceType: "deal",
      name: "Plan interest",
      fieldType: "select",
      options: ["Growth", "Enterprise"],
    });
    assert.equal(field.status, 201);
    assert.equal(field.body.key, "plan_interest");

    const deal = await call<{ id: string; source: string }>("POST", "/revenue/deals", {
      title: "Enterprise evaluation",
      source: "Inbound",
      ownerId,
    });
    assert.equal(deal.status, 201);
    assert.equal(deal.body.source, "inbound");

    const values = await call("PUT", `/revenue/custom-values/deal/${deal.body.id}`, {
      values: { plan_interest: "Enterprise" },
    });
    assert.equal(values.status, 200);
    const filtered = await call<{ rows: Array<{ id: string }>; total: number }>(
      "GET",
      "/revenue/deals?customFieldKey=plan_interest&customFieldValue=enterprise",
    );
    assert.equal(filtered.body.total, 1);
    assert.equal(filtered.body.rows[0].id, deal.body.id);
  });

  test("round-trips a partnership, Reply-All contacts, and a formal document link", async () => {
    const partnership = await call<{ id: string }>("POST", "/revenue/partnerships", {
      name: "Cloud Partner",
      type: "Technology",
      status: "Active",
      ownerId,
    });
    assert.equal(partnership.status, 201);
    const contact = await createContact("Partner lead", "partner@example.com");
    const linked = await call("POST", `/revenue/partnerships/${partnership.body.id}/contacts`, {
      contactId: contact.id,
      isPrimary: true,
      replyAll: true,
    });
    assert.equal(linked.status, 201);
    const document = await call("POST", "/revenue/documents", {
      kind: "contract",
      title: "Partner agreement",
      partnershipId: partnership.body.id,
      externalUrl: "https://docs.example/partner-agreement",
    });
    assert.equal(document.status, 201);
    const documentId = (document.body as { id: string }).id;
    const renamed = await call<{ title: string }>("PATCH", `/revenue/documents/${documentId}`, {
      title: "Signed partner agreement",
      notes: "Countersigned",
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.title, "Signed partner agreement");

    const detail = await call<{
      contacts: Array<{ replyAll: boolean }>;
      documents: Array<{ title: string }>;
    }>("GET", `/revenue/partnerships/${partnership.body.id}`);
    assert.equal(detail.body.contacts[0].replyAll, true);
    assert.equal(detail.body.documents[0].title, "Signed partner agreement");
    assert.equal((await call("DELETE", `/revenue/documents/${documentId}`)).status, 200);
    assert.equal(
      (await call<{ documents: unknown[] }>("GET", `/revenue/partnerships/${partnership.body.id}`))
        .body.documents.length,
      0,
    );
  });

  test("previews, commits, and rolls back a CSV migration with a durable row map", async () => {
    const input = {
      resourceType: "contact",
      sourceKind: "csv",
      sourceLabel: "contacts.csv",
      mapping: { name: "full_name", email: "address" },
      rows: [
        {
          sourceId: "csv-1",
          values: { full_name: "Imported person", address: "imported@example.com" },
        },
      ],
    };
    const preview = await call<{ createCount: number }>("POST", "/revenue/imports/preview", input);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.createCount, 1);
    const batch = await call<{ id: string; status: string }>("POST", "/revenue/imports", input);
    assert.equal(batch.status, 201);
    assert.equal(batch.body.status, "completed");
    const rollback = await call<{ deleted: number; blocked: unknown[] }>(
      "POST",
      `/revenue/imports/${batch.body.id}/rollback`,
    );
    assert.equal(rollback.status, 200);
    assert.equal(rollback.body.deleted, 1);
    assert.deepEqual(rollback.body.blocked, []);
  });

  test("installs migration fields and commits a linked Account, Contact, and Deal row", async () => {
    const preset = await call<{ created: unknown[] }>(
      "POST",
      "/revenue/custom-fields/base-migration-preset",
    );
    assert.equal(preset.status, 201);
    assert.equal(preset.body.created.length, 12);
    const input = {
      sourceKind: "csv",
      sourceLabel: "legacy.csv",
      mapping: {
        account: { name: "company", domain: "domain" },
        contact: { name: "person", email: "email" },
        deal: { title: "opportunity" },
      },
      rows: [
        {
          sourceId: "csv-1",
          values: {
            company: "Linked Co",
            domain: "linked.example",
            person: "Linked Person",
            email: "person@linked.example",
            opportunity: "Linked Deal",
          },
        },
      ],
    };
    const preview = await call<{ createCount: number }>(
      "POST",
      "/revenue/imports/linked/preview",
      input,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.createCount, 1);
    const batch = await call<{ id: string; resourceType: string }>(
      "POST",
      "/revenue/imports/linked",
      input,
    );
    assert.equal(batch.status, 201);
    assert.equal(batch.body.resourceType, "account_contact_deal");
    const retrieved = await call<{ id: string; rowMapJson: string }>(
      "GET",
      `/revenue/imports/${batch.body.id}`,
    );
    assert.equal(retrieved.status, 200);
    assert.equal(retrieved.body.id, batch.body.id);
    assert.match(retrieved.body.rowMapJson, /csv-1/);
  });
});

// ── AI access ──────────────────────────────────────────────────────────────

describe("revenue routes — AI access", () => {
  async function anEmployee() {
    return insert(AIEmployee, {
      companyId,
      name: "Rev",
      slug: "rev",
      role: "Account executive",
    });
  }

  test("any member may read the grant list", async () => {
    actingUserId = memberId;
    const res = await call<{ grants: unknown[]; candidates: unknown[] }>(
      "GET",
      "/revenue/ai-access",
    );
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.grants));
    assert.ok(Array.isArray(res.body.candidates));
  });

  test("a plain member cannot grant access", async () => {
    const employee = await anEmployee();
    actingUserId = memberId;
    const res = await call("PUT", `/revenue/ai-access/${employee.id}`, {
      accessLevel: "write",
    });
    assert.equal(res.status, 403);
  });

  test("an owner can grant, re-grant and revoke", async () => {
    const employee = await anEmployee();
    const granted = await call<{ grant: { id: string; accessLevel: string } }>(
      "PUT",
      `/revenue/ai-access/${employee.id}`,
      { accessLevel: "write" },
    );
    assert.equal(granted.status, 200);
    assert.equal(granted.body.grant.accessLevel, "write");

    // PUT is an upsert: a second call moves the level rather than conflicting.
    const raised = await call<{ grant: { id: string; accessLevel: string } }>(
      "PUT",
      `/revenue/ai-access/${employee.id}`,
      { accessLevel: "send" },
    );
    assert.equal(raised.body.grant.accessLevel, "send");
    assert.equal(raised.body.grant.id, granted.body.grant.id);

    const revoked = await call("DELETE", `/revenue/ai-access/${granted.body.grant.id}`);
    assert.equal(revoked.status, 200);
    const empty = await call<{ grants: unknown[] }>("GET", "/revenue/ai-access");
    assert.equal(empty.body.grants.length, 0);
  });

  test("granting to an employee of another company is a 404", async () => {
    const outsider = await insert(AIEmployee, {
      companyId: "co_somewhere_else",
      name: "Nope",
      slug: "nope",
      role: "SDR",
    });
    const res = await call("PUT", `/revenue/ai-access/${outsider.id}`, {
      accessLevel: "read",
    });
    assert.equal(res.status, 404);
  });

  test("an invalid access level is a 400", async () => {
    const employee = await anEmployee();
    const res = await call("PUT", `/revenue/ai-access/${employee.id}`, {
      accessLevel: "superuser",
    });
    assert.equal(res.status, 400);
  });

  /**
   * The regression this file exists for. The AI-access guard is registered with
   * `.use()`, so without `onRoutePaths` scoping it would also run for every
   * other route on this router — and, once mounted, for sibling routers sharing
   * `/api/companies/:cid`. A plain member must still be able to write a contact.
   */
  test("the admin guard does not leak onto the rest of the router", async () => {
    actingUserId = memberId;
    const res = await call("POST", "/revenue/contacts", {
      name: "Member's contact",
      email: "member-made@example.com",
    });
    assert.equal(res.status, 201);
  });
});

// ── Sequences ──────────────────────────────────────────────────────────────

describe("revenue routes — sequences", () => {
  async function aSequence(name = "Q3 Outbound") {
    const employee = await insert(AIEmployee, {
      companyId,
      name: `SDR ${name}`,
      slug: `sdr-${name.toLowerCase().replace(/\s+/g, "-")}`,
      role: "SDR",
    });
    const res = await call<{ id: string; status: string; autoSend: boolean }>(
      "POST",
      "/revenue/sequences",
      {
        name,
        mailAccountId: "00000000-0000-0000-0000-0000000000aa",
        employeeId: employee.id,
        brief: "Be brief and specific.",
      },
    );
    assert.equal(res.status, 201);
    return res.body;
  }

  test("creates in draft with autoSend off, and audits the flag", async () => {
    const sequence = await aSequence();
    assert.equal(sequence.status, "draft");
    assert.equal(sequence.autoSend, false);
    assert.ok((await auditActions()).includes("revenue.sequence.create"));
  });

  test("detail carries the ladder and the enrolment counts", async () => {
    const sequence = await aSequence();
    const put = await call<Array<{ sortOrder: number; instruction: string }>>(
      "PUT",
      `/revenue/sequences/${sequence.id}/steps`,
      {
        steps: [
          { name: "Opener", instruction: "Introduce ourselves.", delayDays: 0 },
          { name: "Bump", instruction: "Follow up.", delayDays: 3 },
        ],
      },
    );
    assert.equal(put.status, 200);
    assert.deepEqual(
      put.body.map((s) => s.sortOrder),
      [0, 1],
    );

    const res = await call<{
      sequence: { stepCount: number; enrollmentCounts: Record<string, number> };
      steps: unknown[];
    }>("GET", `/revenue/sequences/${sequence.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.steps.length, 2);
    assert.equal(res.body.sequence.stepCount, 2);
    assert.equal(res.body.sequence.enrollmentCounts.active, 0);
  });

  test("replacing the ladder on a missing sequence is a 404", async () => {
    const res = await call("PUT", "/revenue/sequences/00000000-0000-0000-0000-000000000000/steps", {
      steps: [],
    });
    assert.equal(res.status, 404);
  });

  test("bulk enrol reports partial success rather than refusing the batch", async () => {
    const sequence = await aSequence();
    const ok = await createContact("Enrollable", "enrol@example.com");
    const noEmail = await call<{ id: string }>("POST", "/revenue/contacts", {
      name: "No Address",
    });
    await call("POST", "/revenue/suppressions", {
      email: "blocked@example.com",
      reason: "unsubscribe",
    });
    const blocked = await createContact("Blocked", "blocked@example.com");

    const res = await call<{
      enrolled: number;
      skipped: Array<{ contactId: string; reason: string }>;
    }>("POST", `/revenue/sequences/${sequence.id}/enroll`, {
      contactIds: [ok.id, noEmail.body.id, blocked.id],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.enrolled, 1);
    const reasons = Object.fromEntries(res.body.skipped.map((s) => [s.contactId, s.reason]));
    assert.equal(reasons[noEmail.body.id], "no_email");
    assert.equal(reasons[blocked.id], "suppressed");
  });

  test("enrolments list, then a manual stop lands as stopped_manual", async () => {
    const sequence = await aSequence();
    const contact = await createContact("Stoppable", "stop@example.com");
    await call("POST", `/revenue/sequences/${sequence.id}/enroll`, {
      contactIds: [contact.id],
    });

    const list = await call<{
      rows: Array<{ id: string; status: string; contact: { name: string } | null }>;
      total: number;
    }>("GET", `/revenue/sequences/${sequence.id}/enrollments`);
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.equal(list.body.rows[0].contact?.name, "Stoppable");

    const stopped = await call<{ status: string; stoppedReason: string }>(
      "POST",
      `/revenue/enrollments/${list.body.rows[0].id}/stop`,
      { reason: "They asked us to pause" },
    );
    assert.equal(stopped.status, 200);
    // The route fixes the terminal status: a client may not assert "they
    // unsubscribed" and manufacture consent evidence.
    assert.equal(stopped.body.status, "stopped_manual");
    assert.equal(stopped.body.stoppedReason, "They asked us to pause");
  });

  test("stopping an unknown enrolment is a 404", async () => {
    const res = await call(
      "POST",
      "/revenue/enrollments/00000000-0000-0000-0000-000000000000/stop",
      {},
    );
    assert.equal(res.status, 404);
  });

  test("enrolling into a missing sequence is a 404", async () => {
    const contact = await createContact();
    const res = await call(
      "POST",
      "/revenue/sequences/00000000-0000-0000-0000-000000000000/enroll",
      { contactIds: [contact.id] },
    );
    assert.equal(res.status, 404);
  });
});

// ── Signals ────────────────────────────────────────────────────────────────

describe("revenue routes — signals", () => {
  async function aSignal(name = "Trial ending") {
    const res = await call<{ id: string; enabled: boolean; slug: string }>(
      "POST",
      "/revenue/signals",
      {
        name,
        sql: "SELECT 1",
        cron: "0 9 * * *",
        dedupeKeyColumn: "account_id",
      },
    );
    assert.equal(res.status, 201);
    return res.body;
  }

  test("creates disabled and audits it", async () => {
    const signal = await aSignal();
    assert.equal(signal.enabled, false);
    assert.equal(signal.slug, "trial-ending");
    assert.ok((await auditActions()).includes("revenue.signal.create"));
  });

  test("an unrunnable cron is a 400, not a rejected promise", async () => {
    const res = await call<{ error: string }>("POST", "/revenue/signals", {
      name: "Broken",
      cron: "not a cron",
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /cron/i);
  });

  test("patching a missing signal is a 404 and a bad cron on patch is a 400", async () => {
    const missing = await call("PATCH", "/revenue/signals/00000000-0000-0000-0000-000000000000", {
      name: "x",
    });
    assert.equal(missing.status, 404);

    const signal = await aSignal();
    const bad = await call("PATCH", `/revenue/signals/${signal.id}`, { cron: "nope" });
    assert.equal(bad.status, 400);

    const good = await call<{ enabled: boolean }>("PATCH", `/revenue/signals/${signal.id}`, {
      enabled: true,
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.enabled, true);
  });

  test("/revenue/signal-events is not swallowed by /revenue/signals/:id", async () => {
    await aSignal();
    const res = await call<{ rows: unknown[]; total: number }>("GET", "/revenue/signal-events");
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 0);
    assert.ok(Array.isArray(res.body.rows));
  });

  test("detail carries the signal and its recent events", async () => {
    const signal = await aSignal();
    const res = await call<{ signal: { id: string }; events: { rows: unknown[] } }>(
      "GET",
      `/revenue/signals/${signal.id}`,
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.signal.id, signal.id);
    assert.deepEqual(res.body.events.rows, []);
  });

  test("testing a missing signal is a 404", async () => {
    const res = await call(
      "POST",
      "/revenue/signals/00000000-0000-0000-0000-000000000000/test",
      {},
    );
    assert.equal(res.status, 404);
  });
});

// ── Historical Deal import ─────────────────────────────────────────────────

describe("revenue routes — historical Deal import", () => {
  test("requires preview and confirmation, then exposes import-scoped undo", async () => {
    const newStage = await insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
    });
    const qualifiedStage = await insert(DealStage, {
      companyId,
      name: "Qualified",
      slug: "qualified",
      sortOrder: 1,
      probability: 40,
      kind: "open",
    });
    const deal = await insert(Deal, {
      companyId,
      title: "Historical API Deal",
      stageId: qualifiedStage.id,
      amountCents: 50_000,
      currency: "USD",
      status: "open",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      archivedAt: null,
    });
    const payload = {
      batchKey: "route-cutover-1",
      sourceSystem: "legacy-crm",
      rows: [
        {
          sourceRecordId: "legacy-deal-1",
          dealId: deal.id,
          historyCompleteness: "complete",
          originalCreatedAt: "2024-01-01T00:00:00.000Z",
          initialStageId: newStage.id,
          events: [
            {
              sourceEventId: "stage-qualified",
              eventType: "stage_changed",
              effectiveAt: "2024-01-10T00:00:00.000Z",
              fromStageId: newStage.id,
              toStageId: qualifiedStage.id,
            },
          ],
        },
      ],
    };

    const preview = await call<{ dryRun: boolean; accepted: number; imported: number }>(
      "POST",
      "/revenue/deal-history/import",
      payload,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.body.dryRun, true);
    assert.equal(preview.body.accepted, 2);
    assert.equal(preview.body.imported, 0);
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({ where: { dealId: deal.id } }),
      0,
    );

    const unconfirmed = await call("POST", "/revenue/deal-history/import", {
      ...payload,
      dryRun: false,
    });
    assert.equal(unconfirmed.status, 400);

    const committed = await call<{ imported: number; operationId: string }>(
      "POST",
      "/revenue/deal-history/import",
      { ...payload, dryRun: false, confirm: "IMPORT" },
    );
    assert.equal(committed.status, 200);
    assert.equal(committed.body.imported, 2);
    assert.ok(committed.body.operationId);

    const undo = await call("POST", `/revenue/operations/${committed.body.operationId}/undo`, {
      confirm: "UNDO",
    });
    assert.equal(undo.status, 200);
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({ where: { dealId: deal.id } }),
      0,
    );
  });

  test("rejects malformed contracts before the importer runs", async () => {
    const invalidBodies = [
      {
        batchKey: "short",
        sourceSystem: "legacy-crm",
        rows: [],
      },
      {
        batchKey: "valid-batch-key",
        sourceSystem: "",
        rows: [],
      },
      {
        batchKey: "valid-batch-key",
        sourceSystem: "legacy-crm",
        rows: [
          {
            sourceRecordId: "legacy-deal",
            dealId: "not-a-uuid",
            historyCompleteness: "complete",
            events: [],
          },
        ],
      },
      {
        batchKey: "valid-batch-key",
        sourceSystem: "legacy-crm",
        rows: [
          {
            sourceRecordId: "legacy-deal",
            dealId: randomUUID(),
            historyCompleteness: "partial",
            events: [
              {
                sourceEventId: "amount",
                eventType: "amount_changed",
                effectiveAt: "not-a-date",
                toAmountCents: -1,
                currency: "US",
              },
            ],
          },
        ],
      },
    ];

    for (const body of invalidBodies) {
      const response = await call("POST", "/revenue/deal-history/import", body);
      assert.equal(response.status, 400);
    }
    assert.equal(await AppDataSource.getRepository(DealHistoryEvent).count(), 0);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).count({
        where: { companyId, action: "revenue.deal_history.import" },
      }),
      0,
    );
  });

  test("returns multi-status for a failed row even when it has no event decisions", async () => {
    const newStage = await insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
    });
    const target = await insert(Deal, {
      companyId,
      title: "Snapshot validation",
      stageId: newStage.id,
      amountCents: 10_000,
      currency: "USD",
      status: "open",
      archivedAt: null,
    });

    const response = await call<{ failed: number; rows: Array<{ errors: string[] }> }>(
      "POST",
      "/revenue/deal-history/import",
      {
        batchKey: "snapshot-without-time",
        sourceSystem: "legacy-crm",
        rows: [
          {
            sourceRecordId: "snapshot-without-time",
            dealId: target.id,
            historyCompleteness: "snapshot_only",
            events: [],
          },
        ],
      },
    );

    assert.equal(response.status, 207);
    assert.equal(response.body.failed, 1);
    assert.match(response.body.rows[0].errors.join(" "), /requires snapshotAt/);
  });

  test("commits valid rows in a mixed batch and returns every rejected event decision", async () => {
    const newStage = await insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
    });
    const target = await insert(Deal, {
      companyId,
      title: "Mixed import",
      stageId: newStage.id,
      amountCents: 10_000,
      currency: "USD",
      status: "open",
      archivedAt: null,
    });

    const response = await call<{
      imported: number;
      rejected: number;
      operationId: string;
      rows: Array<{ status: string; decisions: Array<{ sourceId: string; reason?: string }> }>;
    }>("POST", "/revenue/deal-history/import", {
      batchKey: "mixed-route-import",
      sourceSystem: "legacy-crm",
      dryRun: false,
      confirm: "IMPORT",
      rows: [
        {
          sourceRecordId: "mixed-route-import",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceEventId: "valid-amount",
              eventType: "amount_changed",
              effectiveAt: "2024-01-01T00:00:00.000Z",
              fromAmountCents: 5_000,
              toAmountCents: 10_000,
              fromCurrency: "EUR",
              toCurrency: "USD",
            },
            {
              sourceEventId: "invalid-owner",
              eventType: "owner_changed",
              effectiveAt: "2024-01-02T00:00:00.000Z",
              toOwnerId: randomUUID(),
              toOwnerEmployeeId: randomUUID(),
            },
          ],
        },
      ],
    });

    assert.equal(response.status, 207);
    assert.equal(response.body.imported, 1);
    assert.equal(response.body.rejected, 1);
    assert.equal(response.body.rows[0].status, "partial");
    assert.match(
      response.body.rows[0].decisions.find((row) => row.sourceId === "invalid-owner")?.reason ?? "",
      /both owner types/,
    );
    assert.equal(
      await AppDataSource.getRepository(DealHistoryEvent).count({
        where: { companyId, dealId: target.id },
      }),
      1,
    );
  });

  test("maps every typed boundary and records only one audit event for an exact replay", async () => {
    const newStage = await insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
    });
    const target = await insert(Deal, {
      companyId,
      title: "Typed route import",
      stageId: newStage.id,
      amountCents: 10_000,
      currency: "USD",
      status: "open",
      archivedAt: null,
    });
    const nextOwnerId = randomUUID();
    const payload = {
      batchKey: "typed-route-import",
      sourceSystem: "legacy-crm",
      dryRun: false,
      confirm: "IMPORT",
      rows: [
        {
          sourceRecordId: "typed-route-record",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceEventId: "amount",
              eventType: "amount_changed",
              effectiveAt: "2024-01-01T00:00:00.000Z",
              fromAmountCents: 5_000,
              toAmountCents: 10_000,
              fromCurrency: "EUR",
              toCurrency: "USD",
              sourceActor: "Legacy member",
              metadata: { sourceLine: 42 },
            },
            {
              sourceEventId: "owner",
              eventType: "owner_changed",
              effectiveAt: "2024-01-02T00:00:00.000Z",
              fromOwnerId: null,
              toOwnerId: nextOwnerId,
            },
            {
              sourceEventId: "expected-close",
              eventType: "expected_close_changed",
              effectiveAt: "2024-01-03T00:00:00.000Z",
              fromExpectedCloseDate: "2024-03-01T00:00:00.000Z",
              toExpectedCloseDate: null,
            },
          ],
        },
      ],
    };

    const first = await call<{ operationId: string; imported: number }>(
      "POST",
      "/revenue/deal-history/import",
      payload,
    );
    const replay = await call<{ operationId: string; replayed: boolean; duplicates: number }>(
      "POST",
      "/revenue/deal-history/import",
      payload,
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.imported, 3);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.operationId, first.body.operationId);
    assert.equal(replay.body.duplicates, 3);

    const events = await AppDataSource.getRepository(DealHistoryEvent).find({
      where: { companyId, dealId: target.id },
      order: { occurredAt: "ASC" },
    });
    assert.equal(events[0].currency, "USD");
    assert.equal(events[1].toOwnerId, nextOwnerId);
    const expectedCloseMetadata = JSON.parse(events[2].metadataJson) as Record<string, unknown>;
    assert.equal(expectedCloseMetadata.fromExpectedCloseDate, "2024-03-01T00:00:00.000Z");
    assert.equal(expectedCloseMetadata.toExpectedCloseDate, null);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).count({
        where: { companyId, action: "revenue.deal_history.import" },
      }),
      1,
    );
  });

  test("returns a conflict for batch-key reuse and exposes history imports in operation APIs", async () => {
    const newStage = await insert(DealStage, {
      companyId,
      name: "New",
      slug: "new",
      sortOrder: 0,
      probability: 10,
      kind: "open",
    });
    const target = await insert(Deal, {
      companyId,
      title: "Operation API import",
      stageId: newStage.id,
      amountCents: 10_000,
      currency: "USD",
      status: "open",
      archivedAt: null,
    });
    const payload = {
      batchKey: "operation-route-import",
      sourceSystem: "legacy-crm",
      dryRun: false,
      confirm: "IMPORT",
      rows: [
        {
          sourceRecordId: "operation-route-record",
          dealId: target.id,
          historyCompleteness: "partial",
          events: [
            {
              sourceEventId: "amount",
              eventType: "amount_changed",
              effectiveAt: "2024-01-01T00:00:00.000Z",
              fromAmountCents: 5_000,
              toAmountCents: 10_000,
            },
          ],
        },
      ],
    };
    const committed = await call<{ operationId: string }>(
      "POST",
      "/revenue/deal-history/import",
      payload,
    );
    assert.equal(committed.status, 200);

    const collision = await call("POST", "/revenue/deal-history/import", {
      ...payload,
      rows: [{ ...payload.rows[0], sourceRecordId: "different-record" }],
    });
    assert.equal(collision.status, 409);
    assert.match(String(collision.body.error), /batch key was already used/);

    const operations = await call<{
      total: number;
      rows: Array<{ id: string; kind: string; status: string }>;
    }>("GET", "/revenue/operations?kind=history_import");
    assert.equal(operations.status, 200);
    assert.equal(operations.body.total, 1);
    assert.equal(operations.body.rows[0].id, committed.body.operationId);
    assert.equal(operations.body.rows[0].kind, "history_import");

    const detail = await call<{
      operation: { id: string; kind: string };
      rows: Array<{ entityType: string; action: string }>;
      rowTotal: number;
    }>("GET", `/revenue/operations/${committed.body.operationId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.operation.kind, "history_import");
    assert.equal(detail.body.rowTotal, 1);
    assert.equal(detail.body.rows[0].entityType, "deal_history_event");
    assert.equal(detail.body.rows[0].action, "import_history_event");
  });
});

// ── Reports ────────────────────────────────────────────────────────────────

describe("revenue routes — reports", () => {
  test("overview defaults its window instead of 500ing on a missing period", async () => {
    const res = await call<{ period: { from: string; to: string } }>(
      "GET",
      "/revenue/reports/overview",
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.period.from);
    assert.ok(res.body.period.to);
    const span = new Date(res.body.period.to).getTime() - new Date(res.body.period.from).getTime();
    // Roughly a year, allowing for month lengths.
    assert.ok(span > 360 * 24 * 3_600_000, "default window should be ~12 months");
  });

  test("mrr, funnel and cac all answer on an empty company", async () => {
    const paths = ["/revenue/reports/mrr", "/revenue/reports/funnel", "/revenue/reports/cac"];
    for (const path of paths) {
      const res = await call("GET", path);
      assert.equal(res.status, 200, `${path} should answer`);
    }
  });

  test("an out-of-range months value is a 400", async () => {
    const res = await fetch(`${baseUrl}/api/companies/${companyId}/revenue/reports/mrr?months=999`);
    assert.equal(res.status, 400);
  });
});
