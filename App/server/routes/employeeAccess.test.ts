import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import type { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import type { Company } from "../db/entities/Company.js";
import { EmployeeFinanceGrant } from "../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMemberBrowserGrant } from "../db/entities/EmployeeMemberBrowserGrant.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { Membership, type FinanceAccess } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import type { User } from "../db/entities/User.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { errorHandler } from "../middleware/error.js";
import { AI_BROWSER_REQUEST_HEADER, AI_BROWSER_REQUEST_VALUE } from "../services/browserRequestBoundary.js";
import { ACCESS_ROUTES, GRANT_SOURCES } from "../services/employeeAccess/bulk.js";
import {
  BROWSER_SESSION_REASON,
  FINANCE_HIDDEN_REASON,
  VAULT_MANAGER_REASON,
} from "../services/employeeAccess/rules.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { createVaultItem } from "../services/vault.js";
import { addEmployee, addMember, seedGrantables, type Grantables } from "../test/accessFixtures.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  sessionCookieFor,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  ACCESS_BULK_MAX_ITEMS,
  ACCESS_KINDS,
  ACCESS_KIND_META,
  accessItemKey,
  type AccessBulkAction,
  type AccessBulkItem,
  type AccessBulkResponse,
  type AccessBulkResult,
  type AccessKind,
  type EmployeeAccessListing,
} from "../../shared/employeeAccess.js";

/**
 * One AI Employee's Access page over HTTP, through the real `createApp()`
 * stack with real session cookies and API keys: the listing, and bulk changes
 * replayed through each kind's own route — who may make them (per kind, per
 * viewer, matching what the listing promised), the levels each kind takes,
 * the consent-only Member browsers, partial success, idempotency, company
 * scoping, and that every change is audited exactly as the kind's own panel
 * audits it.
 */

const app = createApp();
app.use(errorHandler);
let server: Server;
let baseUrl = "";
let restoreSecrets: () => void;

before(async () => {
  restoreSecrets = withTestInstanceSecrets();
  await initTestDb();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await closeTestDb();
  restoreSecrets();
});

type Credential = { headers: Record<string, string> };

async function session(user: Pick<User, "id" | "sessionVersion">): Promise<Credential> {
  return { headers: { cookie: await sessionCookieFor(user) } };
}

async function apiKey(user: Pick<User, "id">, companyId: string): Promise<Credential> {
  return { headers: { authorization: `Bearer ${(await mintTestApiKey(user.id, companyId)).token}` } };
}

async function call<T = Record<string, unknown>>(
  who: Credential,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...who.headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

let company: Company;
let owner: User;
let colleague: User;
let employee: AIEmployee;
let g: Grantables;
let ownerSession: Credential;

beforeEach(async () => {
  await resetTestDb();
  const created = await createMemberOfNewCompany("owner", { name: "Olivia Owner" });
  company = created.company;
  owner = created.user;
  colleague = await addMember(company.id, "member", { name: "Bob Member" });
  employee = await addEmployee(company.id, "Ada");
  g = await seedGrantables(company.id, { id: owner.id, role: "owner" }, colleague);
  ownerSession = await session(owner);
});

const accessUrl = (employeeId = employee.id, companyId = company.id) =>
  `/api/companies/${companyId}/employees/${employeeId}/access`;

async function listing(who: Credential, employeeId = employee.id, query = ""): Promise<EmployeeAccessListing> {
  const res = await call<EmployeeAccessListing>(
    who,
    "GET",
    `${accessUrl(employeeId)}${query ? `?q=${encodeURIComponent(query)}` : ""}`,
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function bulk(
  who: Credential,
  action: AccessBulkAction,
  items: AccessBulkItem[],
  employeeId = employee.id,
): Promise<AccessBulkResponse> {
  const res = await call<AccessBulkResponse>(who, "POST", `${accessUrl(employeeId)}/bulk`, { action, items });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

function outcomeOf(response: AccessBulkResponse, kind: AccessKind, resourceId: string | null = null): AccessBulkResult {
  const result = response.results.find((entry) => entry.key === accessItemKey(kind, resourceId));
  assert.ok(result, `${kind}:${resourceId} has a result`);
  return result;
}

/** The resource of each resource kind in the fixtures. */
function resourceOf(kind: AccessKind, fixtures: Grantables = g): string | null {
  switch (kind) {
    case "connection":
      return fixtures.connection.id;
    case "mail_account":
      return fixtures.mailAccount.id;
    case "calendar":
      return fixtures.calendar.id;
    case "repository":
      return fixtures.repository.id;
    case "notebook":
      return fixtures.notebook.id;
    case "note":
      return fixtures.note.id;
    case "base":
      return fixtures.base.id;
    case "chart":
      return fixtures.chart.id;
    case "dashboard":
      return fixtures.dashboard.id;
    case "resource":
      return fixtures.resource.id;
    case "vault_item":
      return fixtures.vaultItemId;
    case "member_browser":
      return fixtures.ownerBrowserId;
    default:
      return null;
  }
}

/** A level each kind would not get by default, and another to move it to. */
function levelsFor(kind: AccessKind): { first: string | undefined; second: string | undefined } {
  const levels = ACCESS_KIND_META[kind].levels.map((level) => level.value);
  if (levels.length === 0) return { first: undefined, second: undefined };
  const last = levels[levels.length - 1];
  return { first: last, second: levels[0] === last ? levels[1] : levels[0] };
}

function itemFor(kind: AccessKind, level?: string, fixtures: Grantables = g): AccessBulkItem {
  const item: AccessBulkItem = { kind };
  const id = resourceOf(kind, fixtures);
  if (id) item.resourceId = id;
  if (level && ACCESS_KIND_META[kind].levels.length) item.level = level;
  return item;
}

/** The employee's stored Grant of a kind, read straight from its table. */
async function storedGrant(
  kind: AccessKind,
  employeeId = employee.id,
  fixtures: Grantables = g,
): Promise<{ id: string; level: string | null } | null> {
  const source = GRANT_SOURCES[kind];
  const where: Record<string, unknown> = { employeeId };
  if (source.resourceColumn) where[source.resourceColumn] = resourceOf(kind, fixtures);
  const row = (await AppDataSource.getRepository(source.entity).findOne({ where })) as Record<string, unknown> | null;
  if (!row) return null;
  return { id: String(row.id), level: source.levelColumn ? String(row[source.levelColumn]) : null };
}

async function auditCount(): Promise<number> {
  return AppDataSource.getRepository(AuditEvent).countBy({ companyId: company.id });
}

async function auditSince(count: number): Promise<AuditEvent[]> {
  const rows = await AppDataSource.getRepository(AuditEvent).find({
    where: { companyId: company.id },
    order: { createdAt: "ASC" },
  });
  return rows.slice(count);
}

describe("GET /employees/:eid/access", () => {
  test("any Member reads it; another company's employee and outsiders are refused", async () => {
    const asMember = await listing(await session(colleague));
    assert.ok(asMember.items.length > 15);
    assert.equal(asMember.employee.name, "Ada");

    const other = await createMemberOfNewCompany("owner");
    const theirEmployee = await addEmployee(other.company.id, "Theirs");
    assert.equal((await call(ownerSession, "GET", accessUrl(theirEmployee.id))).status, 404);
    assert.equal((await call(ownerSession, "GET", accessUrl(randomUUID()))).status, 404);
    assert.equal(
      (await call(await session(other.user), "GET", accessUrl())).status,
      403,
      "a Member of another company",
    );
    assert.equal((await call({ headers: {} }, "GET", accessUrl())).status, 401);
  });

  test("validates its parameters", async () => {
    assert.equal((await call(ownerSession, "GET", accessUrl("not-a-uuid"))).status, 400);
    assert.equal((await call(ownerSession, "GET", `${accessUrl()}?q=${"x".repeat(201)}`)).status, 400);
    assert.equal((await call(ownerSession, "GET", `${accessUrl()}?other=1`)).status, 400);
    const searched = await listing(ownerSession, employee.id, "refund");
    assert.deepEqual(
      searched.items.map((item) => item.resourceId).sort(),
      [g.note.id, g.subNote.id].sort(),
    );
  });

  test("an API key lists what API keys may read elsewhere, and says what it cannot", async () => {
    const res = await listing(await apiKey(owner, company.id));
    for (const kind of ["connection", "repository", "vault_item", "member_browser"] as const) {
      assert.equal(res.kinds.find((entry) => entry.kind === kind)?.unavailable, BROWSER_SESSION_REASON);
    }
    assert.ok(res.items.some((item) => item.kind === "mail_account"));
  });
});

describe("POST /employees/:eid/access/bulk — every kind through its own route", () => {
  test("grants, changes and revokes one of every kind, writing each kind's own rows", async () => {
    const granted = await bulk(
      ownerSession,
      "grant",
      ACCESS_KINDS.map((kind) => itemFor(kind, levelsFor(kind).first)),
    );
    for (const kind of ACCESS_KINDS) {
      const result = outcomeOf(granted, kind, resourceOf(kind));
      const meta = ACCESS_KIND_META[kind];
      if (meta.heldByDefault) {
        assert.equal(result.outcome, "unchanged", `${kind}: held by default`);
        continue;
      }
      assert.equal(result.outcome, "granted", `${kind}: ${result.message}`);
      const stored = await storedGrant(kind);
      assert.ok(stored, `${kind} has a row`);
      assert.equal(stored.level, levelsFor(kind).first ?? null, kind);
      assert.equal(result.level, levelsFor(kind).first ?? null, kind);
    }
    assert.equal(granted.summary.granted, ACCESS_KINDS.length - 2);
    assert.equal(granted.summary.unchanged, 2);

    const leveled = ACCESS_KINDS.filter((kind) => ACCESS_KIND_META[kind].levels.length > 0);
    const changed = await bulk(
      ownerSession,
      "set_level",
      leveled.map((kind) => itemFor(kind, levelsFor(kind).second)),
    );
    for (const kind of leveled) {
      const result = outcomeOf(changed, kind, resourceOf(kind));
      assert.equal(result.outcome, "updated", `${kind}: ${result.message}`);
      assert.equal((await storedGrant(kind))?.level, levelsFor(kind).second, kind);
    }

    const revoked = await bulk(ownerSession, "revoke", ACCESS_KINDS.map((kind) => itemFor(kind)));
    for (const kind of ACCESS_KINDS) {
      const result = outcomeOf(revoked, kind, resourceOf(kind));
      if (ACCESS_KIND_META[kind].heldByDefault) {
        assert.equal(result.outcome, "skipped", kind);
        assert.match(result.message ?? "", /cannot be revoked/);
        // The level it was moved to stays.
        assert.equal((await storedGrant(kind))?.level, levelsFor(kind).second, kind);
        continue;
      }
      assert.equal(result.outcome, "revoked", `${kind}: ${result.message}`);
      assert.equal(await storedGrant(kind), null, `${kind} row is gone`);
    }

    const after = await listing(ownerSession);
    for (const item of after.items) {
      if (item.kind === "routines" || item.kind === "resource_library") continue;
      if (item.hidden) continue;
      assert.equal(item.grant, null, `${item.key} shows no Grant afterwards`);
    }
  });

  test("leaves a level out and the kind's own default applies", async () => {
    const res = await bulk(ownerSession, "grant", [
      itemFor("mail_account"),
      itemFor("note"),
      itemFor("chart"),
      itemFor("repository"),
      itemFor("vault_item"),
      itemFor("finance"),
    ]);
    assert.equal(res.summary.granted, 6);
    assert.equal((await storedGrant("mail_account"))?.level, "draft");
    assert.equal((await storedGrant("note"))?.level, "write");
    assert.equal((await storedGrant("chart"))?.level, "read");
    assert.equal((await storedGrant("repository"))?.level, "write");
    assert.equal((await storedGrant("vault_item"))?.level, "use");
    assert.equal((await storedGrant("finance"))?.level, "read");
  });

  test("audits each change exactly as the kind's own route does, called directly", async () => {
    // Two fresh employees: one changed through each kind's own route, the
    // other through the bulk endpoint. Their audit rows must match, row for
    // row, once the employee's own id and name are set aside.
    const direct = await addEmployee(company.id, "Grace");
    const viaBulk = await addEmployee(company.id, "Linus");
    // Each employee's own Grant row has its own id; some kinds audit it as the target.
    const normalize = (rows: AuditEvent[], who: AIEmployee, grantIds: Array<string | undefined>) =>
      rows.map((row) => {
        const scrub = (text: string | null) => {
          let out = (text ?? "").split(who.id).join("<employee>").split(who.name).join("<name>");
          for (const id of grantIds) if (id) out = out.split(id).join("<grant>");
          return out;
        };
        return {
          action: row.action,
          actorUserId: row.actorUserId,
          targetType: row.targetType,
          targetId: scrub(row.targetId),
          targetLabel: scrub(row.targetLabel),
          metadata: scrub(row.metadataJson),
        };
      });

    for (const action of ["grant", "set_level", "revoke"] as const) {
      for (const kind of ACCESS_KINDS) {
        const meta = ACCESS_KIND_META[kind];
        const routes = ACCESS_ROUTES[kind];
        const build = action === "grant" ? routes.grant : action === "set_level" ? routes.setLevel : routes.revoke;
        if (!build) continue;
        // Granting a kind every employee holds changes nothing through bulk.
        if (action === "grant" && meta.heldByDefault) continue;
        const level =
          action === "set_level" ? levelsFor(kind).second : (levelsFor(kind).first ?? null);

        const beforeDirect = await auditCount();
        const directGrant = await storedGrant(kind, direct.id);
        const operation = build({
          employeeId: direct.id,
          resource: resourceOf(kind)
            ? {
                id: resourceOf(kind)!,
                slug:
                  kind === "repository"
                    ? g.repository.slug
                    : kind === "notebook"
                      ? g.notebook.slug
                      : kind === "note"
                        ? g.note.slug
                        : kind === "base"
                          ? g.base.slug
                          : kind === "chart"
                            ? g.chart.slug
                            : kind === "dashboard"
                              ? g.dashboard.slug
                              : kind === "resource"
                                ? g.resource.slug
                                : null,
                ownerUserId: null,
                ownerName: null,
              }
            : null,
          grantId: directGrant?.id ?? randomUUID(),
          level: level ?? null,
        });
        const res = await call(ownerSession, operation.method, `/api/companies/${company.id}${operation.path}`, operation.body);
        assert.ok(res.status < 300, `${action} ${kind} directly: ${res.status} ${JSON.stringify(res.body)}`);
        const directRows = await auditSince(beforeDirect);
        const directIds = [directGrant?.id, (await storedGrant(kind, direct.id))?.id];

        const beforeBulk = await auditCount();
        const bulkGrant = await storedGrant(kind, viaBulk.id);
        const result = await bulk(
          ownerSession,
          action,
          [itemFor(kind, level ?? undefined)],
          viaBulk.id,
        );
        assert.notEqual(result.results[0].outcome, "failed", `${action} ${kind}: ${result.results[0].message}`);
        const bulkRows = await auditSince(beforeBulk);
        const bulkIds = [bulkGrant?.id, (await storedGrant(kind, viaBulk.id))?.id];

        assert.deepEqual(
          normalize(bulkRows, viaBulk, bulkIds),
          normalize(directRows, direct, directIds),
          `${action} ${kind} audits the same rows`,
        );
      }
    }
  });
});

describe("idempotency and partial success", () => {
  test("asking again changes nothing and audits nothing", async () => {
    const items = [itemFor("note", "read"), itemFor("finance", "invoice"), itemFor("base")];
    assert.equal((await bulk(ownerSession, "grant", items)).summary.granted, 3);
    const audited = await auditCount();

    const again = await bulk(ownerSession, "grant", items);
    assert.equal(again.summary.unchanged, 3);
    assert.equal(outcomeOf(again, "note", g.note.id).message, "Already holds Can view.");
    assert.equal(outcomeOf(again, "base", g.base.id).message, "Already granted.");

    const sameLevel = await bulk(ownerSession, "set_level", [itemFor("note", "read"), itemFor("finance", "invoice")]);
    assert.equal(sameLevel.summary.unchanged, 2);

    await bulk(ownerSession, "revoke", items);
    const afterRevoke = await auditCount();
    const revokedAgain = await bulk(ownerSession, "revoke", items);
    assert.equal(revokedAgain.summary.unchanged, 3);
    assert.equal(await auditCount(), afterRevoke);
    assert.equal(afterRevoke - audited, 3, "the one real revoke wrote one row per Grant");
  });

  test("a row asked for twice is changed once", async () => {
    const res = await bulk(ownerSession, "grant", [itemFor("note", "read"), itemFor("note", "write")]);
    assert.equal(res.results.length, 1);
    assert.equal(res.results[0].outcome, "granted");
    assert.equal((await storedGrant("note"))?.level, "read", "the first one asked for wins");
  });

  test("a level change on something not granted, or without levels, is skipped", async () => {
    const res = await bulk(ownerSession, "set_level", [itemFor("note", "read"), itemFor("marketing", "write")]);
    assert.equal(res.summary.skipped, 2);
    assert.match(outcomeOf(res, "note", g.note.id).message ?? "", /Not granted yet/);
  });

  test("one refusal never undoes the others", async () => {
    const other = await createMemberOfNewCompany("owner");
    const theirColleague = await addMember(other.company.id, "member");
    const theirs = await seedGrantables(other.company.id, { id: other.user.id, role: "owner" }, theirColleague);
    const res = await bulk(ownerSession, "grant", [
      itemFor("note", "read"),
      { kind: "member_browser", resourceId: g.colleagueBrowserId },
      { kind: "note", resourceId: theirs.note.id, level: "write" },
      itemFor("revenue", "write"),
    ]);
    assert.equal(outcomeOf(res, "note", g.note.id).outcome, "granted");
    assert.equal(outcomeOf(res, "revenue").outcome, "granted");
    const consent = outcomeOf(res, "member_browser", g.colleagueBrowserId);
    assert.equal(consent.outcome, "failed");
    assert.equal(consent.message, "Only Bob Member can grant this browser — it runs on their computer.");
    const foreign = outcomeOf(res, "note", theirs.note.id);
    assert.equal(foreign.outcome, "failed");
    assert.equal(foreign.status, 404);
    assert.equal(foreign.message, "That note is not in this company.");
    assert.equal(
      await AppDataSource.getRepository(EmployeeNoteGrant).countBy({ noteId: theirs.note.id }),
      0,
    );
    assert.deepEqual(res.summary, { granted: 2, updated: 0, revoked: 0, unchanged: 0, skipped: 0, failed: 2 });
  });

  test("takes a full page of changes at once", async () => {
    const notes: Note[] = [];
    for (let i = 0; i < 40; i += 1) {
      notes.push(
        await insert(Note, {
          companyId: company.id,
          notebookId: g.notebook.id,
          title: `Page ${i}`,
          slug: `page-${i}-${randomUUID().slice(0, 6)}`,
          body: "",
        }),
      );
    }
    const res = await bulk(
      ownerSession,
      "grant",
      notes.map((note) => ({ kind: "note", resourceId: note.id, level: "read" })),
    );
    assert.equal(res.summary.granted, 40);
    assert.equal(await AppDataSource.getRepository(EmployeeNoteGrant).countBy({ employeeId: employee.id }), 40);
  });
});

describe("who may change what: each kind's own rule, as the listing said", () => {
  type Viewer = { name: string; who: () => Promise<Credential>; employee: () => Promise<AIEmployee> };

  async function memberWith(financeAccess: FinanceAccess, role: "member" | "admin" = "member") {
    const user = await addMember(company.id, role, { name: `${role} ${financeAccess}` });
    await AppDataSource.getRepository(Membership).update({ companyId: company.id, userId: user.id }, { financeAccess });
    return user;
  }

  const viewers: Viewer[] = [
    { name: "an owner", who: () => session(owner), employee: () => addEmployee(company.id, "OwnerTarget") },
    {
      name: "an admin",
      who: async () => session(await memberWith("none", "admin")),
      employee: () => addEmployee(company.id, "AdminTarget"),
    },
    {
      name: "a Member without Finance access",
      who: async () => session(await memberWith("none")),
      employee: () => addEmployee(company.id, "MemberTarget"),
    },
    {
      name: "a Member with Finance read",
      who: async () => session(await memberWith("read")),
      employee: () => addEmployee(company.id, "ReaderTarget"),
    },
    {
      name: "a Member with full Finance access",
      who: async () => session(await memberWith("full")),
      employee: () => addEmployee(company.id, "FullTarget"),
    },
    {
      name: "an owner's API key",
      who: () => apiKey(owner, company.id),
      employee: () => addEmployee(company.id, "KeyTarget"),
    },
  ];

  for (const viewer of viewers) {
    test(`${viewer.name}: a row the listing offers is accepted, a locked one refused for the reason it gave`, async () => {
      const who = await viewer.who();
      const target = await viewer.employee();
      const listed = await listing(who, target.id);
      const unavailable = new Set(listed.kinds.filter((entry) => entry.unavailable).map((entry) => entry.kind));
      // Every row of every kind, including the ones the viewer cannot list.
      const items = ACCESS_KINDS.flatMap((kind) => {
        if (ACCESS_KIND_META[kind].heldByDefault) return [];
        if (kind === "member_browser") {
          return [
            { kind, resourceId: g.ownerBrowserId },
            { kind, resourceId: g.colleagueBrowserId },
          ] as AccessBulkItem[];
        }
        if (kind === "vault_item") {
          return [
            { kind, resourceId: g.vaultItemId },
            { kind, resourceId: g.restrictedVaultItemId },
          ] as AccessBulkItem[];
        }
        return [itemFor(kind)];
      });
      const res = await bulk(who, "grant", items, target.id);
      for (const result of res.results) {
        const row = listed.items.find((item) => item.key === result.key);
        if (unavailable.has(result.kind)) {
          assert.equal(result.outcome, "failed", `${result.key} cannot be changed with an API key`);
          assert.equal(result.message, BROWSER_SESSION_REASON, result.key);
          continue;
        }
        if (!row) {
          // Not listed for this viewer at all: a restricted Vault item.
          assert.equal(result.kind, "vault_item", result.key);
          assert.equal(result.outcome, "failed", result.key);
          continue;
        }
        if (row.canChange) {
          assert.equal(result.outcome, "granted", `${viewer.name} may grant ${result.key}: ${result.message}`);
        } else {
          assert.equal(result.outcome, "failed", `${viewer.name} may not grant ${result.key}`);
          assert.equal(result.message, row.reason, `${result.key} is refused for the reason the listing gave`);
          assert.ok(result.status === 403 || result.status === 404, `${result.key}: ${result.status}`);
        }
      }
    });
  }

  test("a Member browser is granted and revoked only by the Member who connected it", async () => {
    const asColleague = await session(colleague);
    const theirs = { kind: "member_browser" as const, resourceId: g.colleagueBrowserId };
    const refused = await bulk(ownerSession, "grant", [theirs]);
    assert.equal(refused.results[0].outcome, "failed");
    assert.equal(await AppDataSource.getRepository(EmployeeMemberBrowserGrant).countBy({ employeeId: employee.id }), 0);

    const granted = await bulk(asColleague, "grant", [theirs]);
    assert.equal(granted.results[0].outcome, "granted");
    const colleagueView = (await listing(asColleague)).items.find((item) => item.resourceId === g.colleagueBrowserId);
    assert.deepEqual(colleagueView?.grant, { level: null, byDefault: false });
    const ownerView = (await listing(ownerSession)).items.find((item) => item.resourceId === g.colleagueBrowserId);
    assert.equal(ownerView?.grant, null);
    assert.equal(ownerView?.hidden, true);

    // An owner cannot take it away either, and is not told whether it exists.
    const ownerRevoke = await bulk(ownerSession, "revoke", [theirs]);
    assert.equal(ownerRevoke.results[0].outcome, "failed");
    assert.equal(await AppDataSource.getRepository(EmployeeMemberBrowserGrant).countBy({ employeeId: employee.id }), 1);
    const revoked = await bulk(asColleague, "revoke", [theirs]);
    assert.equal(revoked.results[0].outcome, "revoked");
    assert.equal(await AppDataSource.getRepository(EmployeeMemberBrowserGrant).countBy({ employeeId: employee.id }), 0);
  });

  test("a Vault item is shared by whoever added it, or an owner or admin — no other Member", async () => {
    const other = await addMember(company.id, "member", { name: "Carol Member" });
    const theirs = await createVaultItem({
      companyId: company.id,
      actor: { userId: colleague.id, role: "member" },
      type: "api_key",
      visibility: "company",
      payload: {
        title: "Bob's key",
        username: "",
        secret: "k",
        websiteUrl: "",
        notes: "",
        totp: null,
        passkeys: [],
        passkeyRegistrationLease: null,
      },
    });
    const item = { kind: "vault_item" as const, resourceId: theirs.id, level: "use" };
    const carol = await bulk(await session(other), "grant", [item]);
    assert.equal(carol.results[0].outcome, "failed");
    assert.equal(carol.results[0].message, VAULT_MANAGER_REASON);
    const bob = await bulk(await session(colleague), "grant", [item]);
    assert.equal(bob.results[0].outcome, "granted");
    const changed = await bulk(ownerSession, "set_level", [{ ...item, level: "manage" }]);
    assert.equal(changed.results[0].outcome, "updated");
  });

  test("what a viewer may not see is never revealed by an outcome", async () => {
    const outsider = await session(await memberWith("none"));
    // Finance: refused the same way whether or not the employee holds it.
    const without = await bulk(outsider, "revoke", [itemFor("finance")]);
    assert.equal(without.results[0].outcome, "failed");
    assert.equal(without.results[0].message, FINANCE_HIDDEN_REASON);
    await insert(EmployeeFinanceGrant, { companyId: company.id, employeeId: employee.id, accessLevel: "read" });
    const withGrant = await bulk(outsider, "revoke", [itemFor("finance")]);
    assert.equal(withGrant.results[0].outcome, without.results[0].outcome);
    assert.equal(withGrant.results[0].message, without.results[0].message);
    assert.equal((await storedGrant("finance"))?.level, "read");
    // A Vault item they cannot share, likewise.
    const vaultNone = await bulk(outsider, "revoke", [itemFor("vault_item")]);
    await bulk(ownerSession, "grant", [itemFor("vault_item")]);
    const vaultSome = await bulk(outsider, "revoke", [itemFor("vault_item")]);
    assert.equal(vaultNone.results[0].outcome, "failed");
    assert.deepEqual(
      { outcome: vaultSome.results[0].outcome, message: vaultSome.results[0].message },
      { outcome: vaultNone.results[0].outcome, message: vaultNone.results[0].message },
    );
  });
});

describe("validation and scope", () => {
  test("zod rejects what no kind takes", async () => {
    const post = (body: unknown) => call(ownerSession, "POST", `${accessUrl()}/bulk`, body);
    const bad: unknown[] = [
      { action: "grant", items: [] },
      { action: "promote", items: [itemFor("note")] },
      { action: "grant", items: [{ kind: "teleport", resourceId: g.note.id }] },
      { action: "grant", items: [{ kind: "note", resourceId: g.note.id, level: "send" }] },
      { action: "grant", items: [{ kind: "note" }] },
      { action: "grant", items: [{ kind: "note", resourceId: "nope" }] },
      { action: "grant", items: [{ kind: "finance", resourceId: g.note.id }] },
      { action: "grant", items: [{ kind: "base", resourceId: g.base.id, level: "read" }] },
      { action: "set_level", items: [{ kind: "note", resourceId: g.note.id }] },
      { action: "grant", items: [itemFor("note")], extra: true },
      {
        action: "grant",
        items: Array.from({ length: ACCESS_BULK_MAX_ITEMS + 1 }, () => ({ kind: "note", resourceId: g.note.id })),
      },
    ];
    for (const body of bad) {
      const res = await post(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
      assert.equal(res.body.error, "ValidationError");
    }
    assert.equal(await AppDataSource.getRepository(EmployeeNoteGrant).count(), 0);
  });

  test("an employee of another company, or no employee, is not found", async () => {
    const other = await createMemberOfNewCompany("owner");
    const theirEmployee = await addEmployee(other.company.id, "Theirs");
    const res = await call(ownerSession, "POST", `${accessUrl(theirEmployee.id)}/bulk`, {
      action: "grant",
      items: [itemFor("note")],
    });
    assert.equal(res.status, 404);
    assert.equal(await AppDataSource.getRepository(EmployeeNoteGrant).count(), 0);
    // A key minted for another company is no credential here.
    const foreignKey = await apiKey(other.user, other.company.id);
    assert.equal(
      (await call(foreignKey, "POST", `${accessUrl()}/bulk`, { action: "grant", items: [itemFor("note")] })).status,
      401,
    );
  });

  test("no AI Employee can reach it: no tool grants access, and an employee's token is no credential", async () => {
    for (const tool of STATIC_TOOLS) {
      assert.doesNotMatch(tool.name, /grant|permission|share_with|access_level/i, tool.name);
    }
    const token = issueMcpToken(employee.id, company.id, { authority: "employee" });
    try {
      const res = await call({ headers: { authorization: `Bearer ${token}` } }, "POST", `${accessUrl()}/bulk`, {
        action: "grant",
        items: [itemFor("finance", "full")],
      });
      assert.equal(res.status, 401);
    } finally {
      revokeMcpToken(token);
    }
    const fromAiBrowser = await call(
      { headers: { ...ownerSession.headers, [AI_BROWSER_REQUEST_HEADER]: AI_BROWSER_REQUEST_VALUE } },
      "POST",
      `${accessUrl()}/bulk`,
      { action: "grant", items: [itemFor("finance", "full")] },
    );
    assert.equal(fromAiBrowser.status, 403);
    assert.equal(await storedGrant("finance"), null);
  });
});
