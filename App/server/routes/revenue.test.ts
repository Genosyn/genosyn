import assert from "node:assert/strict";
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
import { DealStage } from "../db/entities/DealStage.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Suppression } from "../db/entities/Suppression.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { revenueRouter } from "./revenue.js";

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

    const res = await fetch(
      `${baseUrl}/api/companies/${other.id}/revenue/contacts/${mine.id}`,
    );
    assert.equal(res.status, 404);
  });
});

// ── Contacts ───────────────────────────────────────────────────────────────

describe("revenue routes — contacts", () => {
  test("creates, lists and audits a contact", async () => {
    const contact = await createContact();
    assert.equal(contact.name, "Ada Lovelace");

    const list = await call<{ rows: unknown[]; total: number }>(
      "GET",
      "/revenue/contacts",
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 1);
    assert.deepEqual(await auditActions(), ["revenue.contact.create"]);
  });

  test("a duplicate address is a 409 carrying the existing id", async () => {
    const first = await createContact();
    const res = await call<{ error: string; existingId: string }>(
      "POST",
      "/revenue/contacts",
      { name: "Ada Again", email: "ada@example.com" },
    );
    assert.equal(res.status, 409);
    assert.equal(res.body.existingId, first.id);
  });

  test("patching onto somebody else's address is a 409", async () => {
    const first = await createContact("Ada", "ada@example.com");
    const second = await createContact("Grace", "grace@example.com");
    const res = await call<{ existingId: string }>(
      "PATCH",
      `/revenue/contacts/${second.id}`,
      { email: "ada@example.com" },
    );
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
    const res = await fetch(
      `${baseUrl}/api/companies/${companyId}/revenue/contacts?limit=banana`,
    );
    assert.equal(res.status, 400);
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
    const created = await call<{ sortOrder: number; slug: string }>(
      "POST",
      "/revenue/stages",
      { name: "Security Review", probability: 70 },
    );
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

    const removed = await call(
      "DELETE",
      `/revenue/deals/${deal.body.id}/contacts/${contact.id}`,
    );
    assert.equal(removed.status, 200);
    const after = await call<{ contacts: unknown[] }>(
      "GET",
      `/revenue/deals/${deal.body.id}`,
    );
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

    const again = await call<{ id: string; reason: string }>(
      "POST",
      "/revenue/suppressions",
      { email: "ada@example.com", reason: "manual" },
    );
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
    const res = await call(
      "PUT",
      "/revenue/sequences/00000000-0000-0000-0000-000000000000/steps",
      { steps: [] },
    );
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
    const reasons = Object.fromEntries(
      res.body.skipped.map((s) => [s.contactId, s.reason]),
    );
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
    const missing = await call(
      "PATCH",
      "/revenue/signals/00000000-0000-0000-0000-000000000000",
      { name: "x" },
    );
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
    const res = await call<{ rows: unknown[]; total: number }>(
      "GET",
      "/revenue/signal-events",
    );
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
    const span =
      new Date(res.body.period.to).getTime() - new Date(res.body.period.from).getTime();
    // Roughly a year, allowing for month lengths.
    assert.ok(span > 360 * 24 * 3_600_000, "default window should be ~12 months");
  });

  test("mrr, funnel and cac all answer on an empty company", async () => {
    const paths = [
      "/revenue/reports/mrr",
      "/revenue/reports/funnel",
      "/revenue/reports/cac",
    ];
    for (const path of paths) {
      const res = await call("GET", path);
      assert.equal(res.status, 200, `${path} should answer`);
    }
  });

  test("an out-of-range months value is a 400", async () => {
    const res = await fetch(
      `${baseUrl}/api/companies/${companyId}/revenue/reports/mrr?months=999`,
    );
    assert.equal(res.status, 400);
  });
});
