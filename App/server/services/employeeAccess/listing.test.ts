import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { EmployeeBaseGrant } from "../../db/entities/EmployeeBaseGrant.js";
import { EmployeeCalendarGrant } from "../../db/entities/EmployeeCalendarGrant.js";
import { EmployeeChartGrant } from "../../db/entities/EmployeeChartGrant.js";
import { EmployeeConnectionGrant } from "../../db/entities/EmployeeConnectionGrant.js";
import { EmployeeDashboardGrant } from "../../db/entities/EmployeeDashboardGrant.js";
import { EmployeeFinanceGrant } from "../../db/entities/EmployeeFinanceGrant.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { EmployeeMarketingGrant } from "../../db/entities/EmployeeMarketingGrant.js";
import { EmployeeMemberBrowserGrant } from "../../db/entities/EmployeeMemberBrowserGrant.js";
import { EmployeeNoteGrant } from "../../db/entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "../../db/entities/EmployeeNotebookGrant.js";
import { EmployeeRecruitingGrant } from "../../db/entities/EmployeeRecruitingGrant.js";
import { EmployeeRepositoryGrant } from "../../db/entities/EmployeeRepositoryGrant.js";
import { EmployeeResourceGrant } from "../../db/entities/EmployeeResourceGrant.js";
import { EmployeeResourceLibraryGrant } from "../../db/entities/EmployeeResourceLibraryGrant.js";
import { EmployeeRevenueGrant } from "../../db/entities/EmployeeRevenueGrant.js";
import { EmployeeRoutineGrant } from "../../db/entities/EmployeeRoutineGrant.js";
import { EmployeeSigningGrant } from "../../db/entities/EmployeeSigningGrant.js";
import { EmployeeDataRoomGrant } from "../../db/entities/EmployeeDataRoomGrant.js";
import { EmployeeVaultGrant } from "../../db/entities/EmployeeVaultGrant.js";
import { Note } from "../../db/entities/Note.js";
import { Notebook } from "../../db/entities/Notebook.js";
import { Resource } from "../../db/entities/Resource.js";
import { User } from "../../db/entities/User.js";
import { overrideRuntimeSettingsForTests } from "../runtimeSettings.js";
import { addEmployee, addMember, seedGrantables, type Grantables } from "../../test/accessFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import {
  ACCESS_KINDS,
  ACCESS_LIST_LIMIT,
  type AccessItem,
  type AccessKind,
  type EmployeeAccessListing,
} from "../../../shared/employeeAccess.js";
import { listEmployeeAccess } from "./listing.js";
import type { Request } from "express";
import {
  accessViewerFrom,
  BROWSER_SESSION_REASON,
  FINANCE_HIDDEN_REASON,
  kindChangeReason,
  MEMBER_BROWSERS_OFF_REASON,
  REPOSITORIES_SHARED_REASON,
  VAULT_MANAGER_REASON,
  type AccessViewer,
} from "./rules.js";

/**
 * The Access page's one read, kind by kind: what is listed (company-scoped,
 * nothing in the trash), what the employee holds and at what level, what
 * reaches it through a notebook or a parent page, and what each viewer may see
 * and change by each kind's own rule.
 */

before(initTestDb);
after(closeTestDb);

let company: Company;
let owner: User;
let colleague: User;
let employee: AIEmployee;
let g: Grantables;

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: `owner-${randomUUID()}@example.test`,
    name: "Olivia Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: `acme-${randomUUID()}`, ownerId: owner.id });
  colleague = await addMember(company.id, "member", { name: "Bob Member" });
  employee = await addEmployee(company.id, "Ada");
  g = await seedGrantables(company.id, { id: owner.id, role: "owner" }, colleague);
});

function viewer(overrides: Partial<AccessViewer> = {}): AccessViewer {
  return { userId: owner.id, role: "owner", viaBearer: false, financeAccess: "full", ...overrides };
}

async function list(
  v: AccessViewer = viewer(),
  options: { query?: string; limit?: number; employeeId?: string } = {},
): Promise<EmployeeAccessListing> {
  const target = options.employeeId
    ? await AppDataSource.getRepository(AIEmployee).findOneByOrFail({ id: options.employeeId })
    : employee;
  return listEmployeeAccess({
    companyId: company.id,
    employee: target,
    viewer: v,
    query: options.query,
    limit: options.limit,
  });
}

function find(listing: EmployeeAccessListing, kind: AccessKind, resourceId: string | null = null): AccessItem {
  const item = listing.items.find((entry) => entry.kind === kind && entry.resourceId === resourceId);
  assert.ok(item, `${kind}:${resourceId} is listed`);
  return item;
}

function keys(listing: EmployeeAccessListing): string[] {
  return listing.items.map((item) => item.key);
}

describe("listing every kind", () => {
  test("lists one row per grantable thing, sections once, nothing granted yet", async () => {
    const listing = await list();
    assert.equal(listing.employee.id, employee.id);
    assert.equal(listing.limit, ACCESS_LIST_LIMIT);
    assert.deepEqual(
      listing.kinds.map((entry) => entry.kind),
      [...ACCESS_KINDS],
    );
    for (const [kind, id] of [
      ["connection", g.connection.id],
      ["mail_account", g.mailAccount.id],
      ["calendar", g.calendar.id],
      ["repository", g.repository.id],
      ["notebook", g.notebook.id],
      ["note", g.note.id],
      ["note", g.subNote.id],
      ["base", g.base.id],
      ["chart", g.chart.id],
      ["dashboard", g.dashboard.id],
      ["resource", g.resource.id],
      ["vault_item", g.vaultItemId],
      ["vault_item", g.restrictedVaultItemId],
      ["member_browser", g.ownerBrowserId],
      ["member_browser", g.colleagueBrowserId],
    ] as const) {
      const item = find(listing, kind, id);
      assert.equal(item.grant, null, `${kind} starts ungranted`);
      assert.equal(item.key, `${kind}:${id}`);
    }
    for (const kind of ["finance", "revenue", "marketing", "recruiting", "signing", "data_room"] as const) {
      assert.equal(find(listing, kind).grant, null, kind);
    }
    // Every AI Employee holds Routines and the Resources library by default.
    assert.deepEqual(find(listing, "routines").grant, { level: "write", byDefault: true });
    assert.deepEqual(find(listing, "resource_library").grant, { level: "write", byDefault: true });
  });

  test("shows what the employee holds, at its level; kinds without levels hold none", async () => {
    const e = employee.id;
    await insert(EmployeeConnectionGrant, { employeeId: e, connectionId: g.connection.id });
    await insert(EmployeeMailAccountGrant, { employeeId: e, accountId: g.mailAccount.id, accessLevel: "send" });
    await insert(EmployeeCalendarGrant, { employeeId: e, accountId: g.calendar.id, accessLevel: "record" });
    await insert(EmployeeRepositoryGrant, { employeeId: e, repositoryId: g.repository.id, accessLevel: "read" });
    await insert(EmployeeBaseGrant, { employeeId: e, baseId: g.base.id });
    await insert(EmployeeChartGrant, { employeeId: e, chartId: g.chart.id, accessLevel: "write" });
    await insert(EmployeeDashboardGrant, { employeeId: e, dashboardId: g.dashboard.id, accessLevel: "read" });
    await insert(EmployeeResourceGrant, { employeeId: e, resourceId: g.resource.id, accessLevel: "delete" });
    await insert(EmployeeVaultGrant, {
      companyId: company.id,
      employeeId: e,
      vaultItemId: g.vaultItemId,
      accessLevel: "manage",
    });
    await insert(EmployeeMemberBrowserGrant, {
      companyId: company.id,
      employeeId: e,
      memberBrowserId: g.ownerBrowserId,
    });
    await insert(EmployeeResourceLibraryGrant, { companyId: company.id, employeeId: e, accessLevel: "read" });
    await insert(EmployeeRoutineGrant, { companyId: company.id, employeeId: e, accessLevel: "run" });
    await insert(EmployeeFinanceGrant, { companyId: company.id, employeeId: e, accessLevel: "invoice" });
    await insert(EmployeeRevenueGrant, { companyId: company.id, employeeId: e, accessLevel: "send" });
    await insert(EmployeeMarketingGrant, { companyId: company.id, employeeId: e, accessLevel: "operate" });
    await insert(EmployeeRecruitingGrant, { companyId: company.id, employeeId: e, accessLevel: "hire" });
    await insert(EmployeeSigningGrant, { companyId: company.id, employeeId: e, accessLevel: "draft" });

    const listing = await list();
    const level = (kind: AccessKind, id: string | null = null) => find(listing, kind, id).grant;
    assert.deepEqual(level("connection", g.connection.id), { level: null, byDefault: false });
    assert.deepEqual(level("mail_account", g.mailAccount.id), { level: "send", byDefault: false });
    assert.deepEqual(level("calendar", g.calendar.id), { level: "record", byDefault: false });
    assert.deepEqual(level("repository", g.repository.id), { level: "read", byDefault: false });
    assert.deepEqual(level("base", g.base.id), { level: null, byDefault: false });
    assert.deepEqual(level("chart", g.chart.id), { level: "write", byDefault: false });
    assert.deepEqual(level("dashboard", g.dashboard.id), { level: "read", byDefault: false });
    assert.deepEqual(level("resource", g.resource.id), { level: "delete", byDefault: false });
    assert.deepEqual(level("vault_item", g.vaultItemId), { level: "manage", byDefault: false });
    assert.deepEqual(level("member_browser", g.ownerBrowserId), { level: null, byDefault: false });
    assert.deepEqual(level("resource_library"), { level: "read", byDefault: false });
    assert.deepEqual(level("routines"), { level: "run", byDefault: false });
    assert.deepEqual(level("finance"), { level: "invoice", byDefault: false });
    assert.deepEqual(level("revenue"), { level: "send", byDefault: false });
    assert.deepEqual(level("marketing"), { level: "operate", byDefault: false });
    assert.deepEqual(level("recruiting"), { level: "hire", byDefault: false });
    assert.deepEqual(level("signing"), { level: "draft", byDefault: false });
  });

  test("a stored level this build does not know reads as the kind's narrowest", async () => {
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: g.mailAccount.id,
      accessLevel: "teleport" as never,
    });
    await insert(EmployeeRoutineGrant, {
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: "teleport" as never,
    });
    const listing = await list();
    assert.equal(find(listing, "mail_account", g.mailAccount.id).grant?.level, "read");
    // Routines fail closed to read + run, as the MCP seam does.
    assert.equal(find(listing, "routines").grant?.level, "run");
  });

  test("links each row to where it lives", async () => {
    const listing = await list();
    assert.equal(find(listing, "repository", g.repository.id).href, `/repositories/${g.repository.slug}`);
    assert.equal(find(listing, "notebook", g.notebook.id).href, `/notes/${g.notebook.slug}`);
    assert.equal(find(listing, "note", g.note.id).href, `/notes/${g.notebook.slug}/${g.note.slug}`);
    assert.equal(find(listing, "base", g.base.id).href, `/bases/${g.base.slug}`);
    assert.equal(find(listing, "chart", g.chart.id).href, `/explore/charts/${g.chart.slug}`);
    assert.equal(find(listing, "dashboard", g.dashboard.id).href, `/explore/dashboards/${g.dashboard.slug}`);
    assert.equal(find(listing, "resource", g.resource.id).href, `/resources/${g.resource.slug}`);
    assert.equal(find(listing, "finance").href, "/finance/ai-access");
    assert.equal(find(listing, "signing").href, "/signatures/ai-access");
    assert.equal(find(listing, "routines").href, "/routines/ai-access");
    assert.equal(find(listing, "member_browser", g.ownerBrowserId).href, "/settings/browsers");
    assert.equal(find(listing, "member_browser", g.colleagueBrowserId).href, null);
    assert.equal(find(listing, "note", g.note.id).detail, g.notebook.title);
    assert.match(find(listing, "connection", g.connection.id).detail ?? "", /^Stripe · acct_123/);
  });
});

describe("company scoping and the trash", () => {
  test("another company's things never appear, even with a stray Grant pointing at them", async () => {
    const otherOwner = await insert(User, {
      email: `other-${randomUUID()}@example.test`,
      name: "Other",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const other = await insert(Company, { name: "Other", slug: `other-${randomUUID()}`, ownerId: otherOwner.id });
    const theirColleague = await addMember(other.id, "member");
    const theirs = await seedGrantables(other.id, { id: otherOwner.id, role: "owner" }, theirColleague);
    // Rows that should never exist, pointing across the boundary.
    await insert(EmployeeNoteGrant, { employeeId: employee.id, noteId: theirs.note.id, accessLevel: "write" });
    await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: theirs.connection.id });
    await insert(EmployeeVaultGrant, {
      companyId: other.id,
      employeeId: employee.id,
      vaultItemId: theirs.vaultItemId,
      accessLevel: "use",
    });
    const listing = await list();
    const ids = new Set(listing.items.map((item) => item.resourceId));
    for (const id of [
      theirs.note.id,
      theirs.connection.id,
      theirs.vaultItemId,
      theirs.mailAccount.id,
      theirs.colleagueBrowserId,
      theirs.notebook.id,
      theirs.resource.id,
    ]) {
      assert.equal(ids.has(id), false, `${id} belongs to another company`);
    }
  });

  test("notes in the trash are not offered, even ones the employee holds", async () => {
    await insert(EmployeeNoteGrant, { employeeId: employee.id, noteId: g.archivedNote.id, accessLevel: "write" });
    const listing = await list();
    assert.equal(keys(listing).includes(`note:${g.archivedNote.id}`), false);
    assert.equal(keys(listing).includes(`note:${g.note.id}`), true);
  });
});

describe("access that reaches a note through something else", () => {
  test("a notebook's Grant reaches every page in it", async () => {
    await insert(EmployeeNotebookGrant, { employeeId: employee.id, notebookId: g.notebook.id, accessLevel: "read" });
    const listing = await list();
    for (const id of [g.note.id, g.subNote.id]) {
      const item = find(listing, "note", id);
      assert.equal(item.grant, null);
      assert.deepEqual(item.inherited, {
        level: "read",
        fromKind: "notebook",
        fromId: g.notebook.id,
        fromLabel: g.notebook.title,
      });
    }
  });

  test("a page's Grant reaches its sub-pages at every depth, and the higher level wins", async () => {
    const deep = await insert(Note, {
      companyId: company.id,
      notebookId: g.notebook.id,
      parentId: g.subNote.id,
      title: "Deep page",
      slug: `deep-${randomUUID()}`,
      body: "Three levels down.",
    });
    await insert(EmployeeNoteGrant, { employeeId: employee.id, noteId: g.note.id, accessLevel: "write" });
    let listing = await list();
    assert.deepEqual(find(listing, "note", g.note.id).grant, { level: "write", byDefault: false });
    for (const id of [g.subNote.id, deep.id]) {
      assert.deepEqual(find(listing, "note", id).inherited, {
        level: "write",
        fromKind: "note",
        fromId: g.note.id,
        fromLabel: g.note.title,
      });
    }
    // A read Grant on the notebook does not lower the page's write.
    await insert(EmployeeNotebookGrant, { employeeId: employee.id, notebookId: g.notebook.id, accessLevel: "read" });
    listing = await list();
    assert.equal(find(listing, "note", deep.id).inherited?.level, "write");
    assert.equal(find(listing, "note", deep.id).inherited?.fromKind, "note");
  });

  test("a page in another notebook is not reached", async () => {
    const elsewhere = await insert(Notebook, { companyId: company.id, title: "Elsewhere", slug: `else-${randomUUID()}` });
    const page = await insert(Note, {
      companyId: company.id,
      notebookId: elsewhere.id,
      title: "Unrelated",
      slug: `unrelated-${randomUUID()}`,
      body: "",
    });
    await insert(EmployeeNotebookGrant, { employeeId: employee.id, notebookId: g.notebook.id, accessLevel: "write" });
    const listing = await list();
    assert.equal(find(listing, "note", page.id).inherited, null);
  });
});

describe("who may see and change what — each kind's own rule", () => {
  test("an owner may change every row they can see, but not another Member's browser", async () => {
    const listing = await list();
    for (const item of listing.items) {
      if (item.key === `member_browser:${g.colleagueBrowserId}`) continue;
      assert.equal(item.canChange, true, `${item.key}: ${item.reason}`);
      assert.equal(item.reason, null);
      assert.equal(item.hidden, false);
    }
    const theirs = find(listing, "member_browser", g.colleagueBrowserId);
    assert.equal(theirs.canChange, false);
    assert.equal(theirs.hidden, true);
    assert.equal(theirs.grant, null);
    assert.equal(theirs.label, "Bob Member's browser");
    assert.equal(theirs.reason, "Only Bob Member can grant this browser — it runs on their computer.");
  });

  test("another Member's browser never shows whom it is granted to", async () => {
    await insert(EmployeeMemberBrowserGrant, {
      companyId: company.id,
      employeeId: employee.id,
      memberBrowserId: g.colleagueBrowserId,
    });
    const asOwner = find(await list(), "member_browser", g.colleagueBrowserId);
    assert.equal(asOwner.grant, null);
    assert.equal(asOwner.hidden, true);
    const asColleague = find(
      await list(viewer({ userId: colleague.id, role: "member", financeAccess: "none" })),
      "member_browser",
      g.colleagueBrowserId,
    );
    assert.deepEqual(asColleague.grant, { level: null, byDefault: false });
    assert.equal(asColleague.canChange, true);
    assert.match(asColleague.label, /^Home desktop /, "its owner sees the browser's own name");
    assert.equal(asColleague.detail, "Your browser");
  });

  test("a plain Member may change notes, Bases, charts and Resources, and is told why not elsewhere", async () => {
    const listing = await list(viewer({ userId: colleague.id, role: "member", financeAccess: "read" }));
    const open: AccessKind[] = ["notebook", "note", "base", "chart", "dashboard", "resource"];
    for (const item of listing.items) {
      if (open.includes(item.kind)) {
        assert.equal(item.canChange, true, item.key);
        continue;
      }
      if (item.kind === "member_browser" || item.kind === "vault_item") continue;
      assert.equal(item.canChange, false, item.key);
      assert.match(item.reason ?? "", /^Only owners and admins can /, item.key);
    }
    assert.equal(find(listing, "mail_account", g.mailAccount.id).reason, "Only owners and admins can grant Mailboxes.");
    assert.equal(find(listing, "finance").reason, "Only owners and admins can change Finance access.");
    // Their own browser is theirs to grant.
    assert.equal(find(listing, "member_browser", g.colleagueBrowserId).canChange, true);
  });

  test("an admin may change what an owner may", async () => {
    const admin = await addMember(company.id, "admin");
    const listing = await list(viewer({ userId: admin.id, role: "admin" }));
    for (const kind of ["connection", "mail_account", "calendar", "repository", "routines", "finance", "signing"] as const) {
      const item = listing.items.find((entry) => entry.kind === kind);
      assert.equal(item?.canChange, true, kind);
    }
    // The Vault manages sharing for owners and admins whoever added the item.
    assert.equal(find(listing, "vault_item", g.restrictedVaultItemId).canChange, true);
  });

  test("Data room access is hidden from Members, whatever their Finance access", async () => {
    await insert(EmployeeDataRoomGrant, { companyId: company.id, employeeId: employee.id, accessLevel: "share" });
    const member = find(await list(viewer({ userId: colleague.id, role: "member", financeAccess: "full" })), "data_room");
    assert.equal(member.hidden, true);
    assert.equal(member.grant, null);
    assert.equal(member.canChange, false);
    assert.equal(member.reason, "Only owners and admins can change Data room access.");
    const admin = await addMember(company.id, "admin");
    const shown = find(await list(viewer({ userId: admin.id, role: "admin" })), "data_room");
    assert.deepEqual(shown.grant, { level: "share", byDefault: false });
    assert.equal(shown.href, "/data-rooms/ai-access");
  });

  test("Finance is hidden from a Member without Finance access, visible read-only with it", async () => {
    await insert(EmployeeFinanceGrant, { companyId: company.id, employeeId: employee.id, accessLevel: "full" });
    const none = find(await list(viewer({ userId: colleague.id, role: "member", financeAccess: "none" })), "finance");
    assert.equal(none.hidden, true);
    assert.equal(none.grant, null);
    assert.equal(none.reason, FINANCE_HIDDEN_REASON);
    const reader = find(await list(viewer({ userId: colleague.id, role: "member", financeAccess: "read" })), "finance");
    assert.equal(reader.hidden, false);
    assert.deepEqual(reader.grant, { level: "full", byDefault: false });
    assert.equal(reader.canChange, false);
  });

  test("a Vault item's Grants show only to its managers; a restricted item to nobody else at all", async () => {
    await insert(EmployeeVaultGrant, {
      companyId: company.id,
      employeeId: employee.id,
      vaultItemId: g.vaultItemId,
      accessLevel: "use",
    });
    const member = await list(viewer({ userId: colleague.id, role: "member", financeAccess: "none" }));
    const shared = find(member, "vault_item", g.vaultItemId);
    assert.equal(shared.hidden, true);
    assert.equal(shared.grant, null);
    assert.equal(shared.canChange, false);
    assert.equal(shared.reason, VAULT_MANAGER_REASON);
    assert.equal(keys(member).includes(`vault_item:${g.restrictedVaultItemId}`), false);
    const asOwner = find(await list(), "vault_item", g.vaultItemId);
    assert.deepEqual(asOwner.grant, { level: "use", byDefault: false });
  });

  test("an API key lists no Connection, Repository, Vault item or Member browser", async () => {
    const listing = await list(viewer({ viaBearer: true }));
    for (const kind of ["connection", "repository", "vault_item", "member_browser"] as const) {
      const status = listing.kinds.find((entry) => entry.kind === kind);
      assert.equal(status?.unavailable, BROWSER_SESSION_REASON, kind);
      assert.equal(listing.items.some((item) => item.kind === kind), false, kind);
    }
    assert.equal(find(listing, "mail_account", g.mailAccount.id).canChange, true);
  });

  test("a connected app's token is a bearer credential like a key, and an owner's role is read from the request", () => {
    const base = { userId: owner.id, companyRole: "owner", membership: { financeAccess: "none" } };
    const session = accessViewerFrom(base as unknown as Request);
    assert.deepEqual(session, { userId: owner.id, role: "owner", viaBearer: false, financeAccess: "full" });
    const key = accessViewerFrom({ ...base, apiKey: { id: "k" } } as unknown as Request);
    assert.equal(key.viaBearer, true);
    const app = accessViewerFrom({ ...base, connectedApp: { id: "a" } } as unknown as Request);
    assert.equal(app.viaBearer, true);
    const member = accessViewerFrom({
      userId: colleague.id,
      companyRole: "member",
      membership: { financeAccess: "read" },
    } as unknown as Request);
    assert.deepEqual(member, { userId: colleague.id, role: "member", viaBearer: false, financeAccess: "read" });
  });

  test("Member browsers turned off on the install are unavailable, with the reason", async () => {
    overrideRuntimeSettingsForTests({ agent: { memberBrowsersEnabled: false } });
    try {
      const listing = await list();
      assert.equal(
        listing.kinds.find((entry) => entry.kind === "member_browser")?.unavailable,
        MEMBER_BROWSERS_OFF_REASON,
      );
      assert.equal(listing.items.some((item) => item.kind === "member_browser"), false);
    } finally {
      overrideRuntimeSettingsForTests(null);
    }
  });

  test("shared SaaS mode keeps Repository Grants read-only, as their routes do", () => {
    // The rule alone: switching modes mid-process would also change how the
    // Vault's test rows decrypt, which is not what this is about.
    const mutable = config.security as { multiTenant: boolean };
    const before = mutable.multiTenant;
    mutable.multiTenant = true;
    try {
      assert.equal(kindChangeReason("repository", viewer()), REPOSITORIES_SHARED_REASON);
      assert.equal(kindChangeReason("note", viewer()), null);
    } finally {
      mutable.multiTenant = before;
    }
    assert.equal(kindChangeReason("repository", viewer()), null);
  });
});

describe("bounded reads", () => {
  test("each kind lists at most the limit, says so, and still lists every row it holds", async () => {
    const extra: Note[] = [];
    for (let i = 0; i < 6; i += 1) {
      extra.push(
        await insert(Note, {
          companyId: company.id,
          notebookId: g.notebook.id,
          title: `Page ${i}`,
          slug: `zz-page-${i}`,
          body: "x".repeat(10_000),
        }),
      );
    }
    // The last page by slug, so it falls outside a limit of three.
    await insert(EmployeeNoteGrant, { employeeId: employee.id, noteId: extra[5].id, accessLevel: "read" });
    const listing = await list(viewer(), { limit: 3 });
    const notes = listing.items.filter((item) => item.kind === "note");
    assert.equal(listing.kinds.find((entry) => entry.kind === "note")?.truncated, true);
    assert.equal(notes.length, 4, "three from the walk, plus the one it holds");
    assert.ok(notes.some((item) => item.resourceId === extra[5].id));
    assert.equal(listing.kinds.find((entry) => entry.kind === "base")?.truncated, false);
  });

  test("a trash full of pages costs a few more reads, never the live pages", async () => {
    for (let i = 0; i < 9; i += 1) {
      await insert(Note, {
        companyId: company.id,
        notebookId: g.notebook.id,
        title: `Trashed ${i}`,
        slug: `aa-trashed-${i}`,
        body: "gone",
        archivedAt: new Date(),
      });
    }
    // Every trashed page sorts before the live ones; the walk pages past them.
    const listing = await list(viewer(), { limit: 2 });
    const notes = listing.items.filter((item) => item.kind === "note");
    assert.equal(notes.length, 2);
    assert.ok(notes.every((item) => !item.label.startsWith("Trashed")));
  });

  test("a search reaches rows past the limit, across kinds", async () => {
    for (let i = 0; i < 5; i += 1) {
      await insert(Resource, {
        companyId: company.id,
        title: `Filler ${i}`,
        slug: `a-filler-${i}`,
        sourceKind: "text",
        bodyText: "",
        status: "ready",
      });
    }
    const unlimited = await list(viewer(), { limit: 2 });
    assert.equal(unlimited.items.some((item) => item.resourceId === g.resource.id), false);
    const searched = await list(viewer(), { limit: 2, query: "brand" });
    assert.deepEqual(
      searched.items.map((item) => item.resourceId),
      [g.resource.id],
    );
    const sections = await list(viewer(), { query: "finance" });
    assert.deepEqual(keys(sections), ["finance"]);
    const vault = await list(viewer(), { query: "bank portal" });
    assert.deepEqual(keys(vault), [`vault_item:${g.restrictedVaultItemId}`]);
    const browsers = await list(viewer(), { query: "bob" });
    assert.deepEqual(keys(browsers), [`member_browser:${g.colleagueBrowserId}`]);
  });
});
