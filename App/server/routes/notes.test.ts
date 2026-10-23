import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { notebooksRouter } from "./notebooks.js";
import { notesRouter } from "./notes.js";
import { notePlainText, notePreview, noteSnippet } from "../../shared/notePreview.js";

/**
 * The Notes API over real HTTP, as the Notion-like editor uses it: the light
 * outline the sidebar refetches on every save, search with snippets,
 * autosave with a version that refuses to overwrite someone else's save,
 * trash that takes sub-pages along, drag-to-move, and duplicate. Every route
 * is member-level and scoped to its company.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let otherCompany: Company;
let owner: User;
let general: Notebook;
let ideas: Notebook;

before(async () => {
  await initTestDb();
  const app = express();
  // The app's own body limit, so a long note reaches validation rather than a 413.
  app.use(express.json({ limit: "1mb" }));
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", notesRouter);
  app.use("/api/companies/:cid", notebooksRouter);
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
  const user = await insert(User, { email, name: email.split("@")[0], passwordHash: "x", sessionVersion: 0 });
  await insert(Membership, { companyId, userId: user.id, role });
  return user;
}

beforeEach(async () => {
  await resetTestDb();
  const founder = await insert(User, { email: "founder@example.com", name: "Founder", passwordHash: "x", sessionVersion: 0 });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: founder.id });
  otherCompany = await insert(Company, { name: "Other", slug: "other", ownerId: founder.id });
  owner = await member("owner@example.com", "owner" as Role, company.id);
  general = await insert(Notebook, { companyId: company.id, title: "General", slug: "general", icon: "", sortOrder: 0 });
  ideas = await insert(Notebook, { companyId: company.id, title: "Ideas", slug: "ideas", icon: "", sortOrder: 1000 });
  actingUserId = owner.id;
});

type Response<T> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  companyId = company.id,
): Promise<Response<T>> {
  const res = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

let seq = 0;
async function page(slug: string, extra: Partial<Note> = {}): Promise<Note> {
  seq++;
  return insert(Note, {
    companyId: company.id,
    notebookId: general.id,
    title: slug.toUpperCase(),
    slug,
    body: `Body of ${slug}`,
    icon: "",
    parentId: null,
    sortOrder: seq * 1000,
    archivedAt: null,
    ...extra,
  });
}

async function stored(id: string): Promise<Note> {
  return AppDataSource.getRepository(Note).findOneByOrFail({ id });
}

type ApiNote = Note & { version?: string; preview?: string; snippet?: string; body?: string };

describe("access", () => {
  test("signed-out requests are refused", async () => {
    actingUserId = null;
    assert.equal((await call("GET", "/notes")).status, 401);
  });

  test("a non-member is refused", async () => {
    const stranger = await member("stranger@example.com", "owner" as Role, otherCompany.id);
    actingUserId = stranger.id;
    assert.equal((await call("GET", "/notes")).status, 403);
  });

  test("an ordinary Member can do everything a page needs", async () => {
    const plain = await member("member@example.com", "member" as Role, company.id);
    actingUserId = plain.id;
    const created = await call<ApiNote>("POST", "/notes", { title: "Mine" });
    assert.equal(created.status, 200);
    assert.equal((await call("PATCH", `/notes/${created.body.slug}`, { body: "x" })).status, 200);
  });

  test("another company's page is unreachable by slug", async () => {
    const theirs = await insert(Note, {
      companyId: otherCompany.id,
      notebookId: general.id,
      title: "Secret",
      slug: "secret",
      body: "classified",
      icon: "",
      parentId: null,
      sortOrder: 0,
      archivedAt: null,
    });
    assert.equal((await call("GET", "/notes/secret")).status, 404);
    assert.equal((await call("PATCH", "/notes/secret", { body: "pwned" })).status, 404);
    assert.equal((await call("POST", "/notes/secret/move", { index: 0 })).status, 404);
    assert.equal((await call("POST", "/notes/secret/duplicate", {})).status, 404);
    assert.equal((await stored(theirs.id)).body, "classified");
  });
});

describe("listing", () => {
  test("the outline view sends a preview instead of each body", async () => {
    await page("plan", { body: "# Plan\n\nShip **fast** with [docs](https://x.dev).\n\n- one\n- two" });
    const full = await call<ApiNote[]>("GET", "/notes");
    assert.equal(full.body[0].body, "# Plan\n\nShip **fast** with [docs](https://x.dev).\n\n- one\n- two");
    const outline = await call<ApiNote[]>("GET", "/notes?view=outline");
    assert.equal(outline.status, 200);
    assert.equal("body" in outline.body[0], false);
    assert.equal(outline.body[0].preview, "Plan Ship fast with docs. one two");
    assert.equal(outline.body[0].slug, "plan");
  });

  test("filters by trash and notebook, and validates the query", async () => {
    await page("live");
    await page("gone", { archivedAt: new Date() });
    await page("idea", { notebookId: ideas.id });
    assert.deepEqual((await call<ApiNote[]>("GET", "/notes")).body.map((n) => n.slug).sort(), ["idea", "live"]);
    assert.deepEqual((await call<ApiNote[]>("GET", "/notes?archived=true")).body.map((n) => n.slug), ["gone"]);
    assert.deepEqual((await call<ApiNote[]>("GET", "/notes?notebookSlug=ideas")).body.map((n) => n.slug), ["idea"]);
    assert.equal((await call("GET", "/notes?notebookSlug=missing")).status, 404);
    assert.equal((await call("GET", "/notes?view=everything")).status, 400);
  });
});

describe("search", () => {
  test("matches words in any order across title and body, with snippets in the outline view", async () => {
    await page("runbook", { title: "Deploy runbook", body: "Steps to roll back a release when the canary fails." });
    await page("other", { body: "Nothing relevant" });
    const hits = await call<ApiNote[]>("GET", "/notes/search?q=canary%20release&view=outline");
    assert.deepEqual(hits.body.map((n) => n.slug), ["runbook"]);
    assert.equal("body" in hits.body[0], false);
    assert.match(hits.body[0].snippet ?? "", /release when the canary/);
  });

  test("scopes to a notebook; an empty query finds nothing", async () => {
    await page("a", { body: "shared word" });
    await page("b", { body: "shared word", notebookId: ideas.id });
    assert.deepEqual((await call<ApiNote[]>("GET", "/notes/search?q=shared&notebookSlug=ideas")).body.map((n) => n.slug), ["b"]);
    assert.deepEqual((await call<ApiNote[]>("GET", "/notes/search?q=")).body, []);
    assert.equal((await call("GET", "/notes/search?q=x&notebookSlug=missing")).status, 404);
  });

  test("trashed pages don't show up", async () => {
    await page("gone", { body: "needle", archivedAt: new Date() });
    assert.deepEqual((await call<ApiNote[]>("GET", "/notes/search?q=needle")).body, []);
  });
});

describe("creating", () => {
  test("a page lands in the default notebook, a sub-page under its parent", async () => {
    const top = await call<ApiNote>("POST", "/notes", { title: "Untitled" });
    assert.equal(top.status, 200);
    assert.ok(top.body.version);
    const child = await call<ApiNote>("POST", "/notes", { title: "Untitled", parentSlug: top.body.slug });
    assert.equal(child.body.parentId, top.body.id);
    assert.equal(child.body.notebookId, top.body.notebookId);
    assert.notEqual(child.body.slug, top.body.slug);
  });

  test("validates the request", async () => {
    assert.equal((await call("POST", "/notes", {})).status, 400);
    assert.equal((await call("POST", "/notes", { title: "x".repeat(201) })).status, 400);
    assert.equal((await call("POST", "/notes", { title: "x", parentSlug: "missing" })).status, 400);
    assert.equal((await call("POST", "/notes", { title: "x", notebookSlug: "missing" })).status, 400);
  });
});

describe("autosave", () => {
  test("a save returns the next version, and saving from it succeeds", async () => {
    const note = await page("doc");
    const opened = await call<ApiNote>("GET", "/notes/doc");
    const first = await call<ApiNote>("PATCH", "/notes/doc", { body: "one", baseVersion: opened.body.version });
    assert.equal(first.status, 200);
    assert.notEqual(first.body.version, opened.body.version);
    const second = await call<ApiNote>("PATCH", "/notes/doc", { body: "two", baseVersion: first.body.version });
    assert.equal(second.status, 200);
    assert.equal((await stored(note.id)).body, "two");
  });

  test("a save from an outdated version is refused with the current page", async () => {
    const note = await page("doc", { body: "base" });
    const opened = await call<ApiNote>("GET", "/notes/doc");
    // Someone else (an AI Employee) saves in the meantime — even within the same second.
    await AppDataSource.getRepository(Note).update({ id: note.id }, { body: "base\n\nAI addition" });
    const refused = await call<{ error: string; note: ApiNote }>("PATCH", "/notes/doc", {
      body: "my edit",
      baseVersion: opened.body.version,
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.note.body, "base\n\nAI addition");
    assert.ok(refused.body.note.version);
    assert.equal((await stored(note.id)).body, "base\n\nAI addition");
    const retried = await call("PATCH", "/notes/doc", { body: "merged", baseVersion: refused.body.note.version });
    assert.equal(retried.status, 200);
  });

  test("without a base version a save still goes through (older clients)", async () => {
    const note = await page("doc");
    assert.equal((await call("PATCH", "/notes/doc", { body: "plain" })).status, 200);
    assert.equal((await stored(note.id)).body, "plain");
  });

  test("a stale base version doesn't block trashing or moving", async () => {
    await page("doc");
    assert.equal((await call("PATCH", "/notes/doc", { archived: true, baseVersion: "stale" })).status, 200);
  });

  test("the version catches a change of title or icon too", async () => {
    const note = await page("doc");
    const opened = await call<ApiNote>("GET", "/notes/doc");
    await AppDataSource.getRepository(Note).update({ id: note.id }, { icon: "x" });
    assert.equal((await call("PATCH", "/notes/doc", { title: "T", baseVersion: opened.body.version })).status, 409);
  });

  test("bodies are capped and titles required", async () => {
    await page("doc");
    assert.equal((await call("PATCH", "/notes/doc", { body: "x".repeat(200_001) })).status, 400);
    assert.equal((await call("PATCH", "/notes/doc", { title: "" })).status, 400);
    assert.equal((await call("PATCH", "/notes/doc", { baseVersion: "" , body: "x"})).status, 400);
  });

  test("a save records who edited; trashing does not", async () => {
    const other = await member("other@example.com", "member" as Role, company.id);
    const note = await page("doc", { lastEditedById: other.id });
    await call("PATCH", "/notes/doc", { archived: true });
    assert.equal((await stored(note.id)).lastEditedById, other.id);
    await call("PATCH", "/notes/doc", { archived: false });
    await call("PATCH", "/notes/doc", { body: "edit" });
    assert.equal((await stored(note.id)).lastEditedById, owner.id);
  });
});

describe("trash", () => {
  test("trashing a page takes its sub-pages along", async () => {
    const parent = await page("parent");
    const child = await page("child", { parentId: parent.id });
    const grandchild = await page("grandchild", { parentId: child.id });
    const sibling = await page("sibling");
    const res = await call("PATCH", "/notes/parent", { archived: true });
    assert.equal(res.status, 200);
    assert.ok((await stored(parent.id)).archivedAt);
    assert.ok((await stored(child.id)).archivedAt);
    assert.ok((await stored(grandchild.id)).archivedAt);
    assert.equal((await stored(sibling.id)).archivedAt, null);
    const live = await call<ApiNote[]>("GET", "/notes");
    assert.deepEqual(live.body.map((n) => n.slug), ["sibling"]);
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({ action: "note.archive", targetId: parent.id });
    assert.deepEqual(JSON.parse(audit.metadataJson), { subPages: 2 });
  });

  test("restoring brings back what went with it, not what was trashed on its own", async () => {
    const parent = await page("parent");
    const keptOut = await page("kept-out", { parentId: parent.id, archivedAt: new Date(Date.now() - 60_000) });
    const child = await page("child", { parentId: parent.id });
    await call("PATCH", "/notes/parent", { archived: true });
    await call("PATCH", "/notes/parent", { archived: false });
    assert.equal((await stored(parent.id)).archivedAt, null);
    assert.equal((await stored(child.id)).archivedAt, null);
    assert.ok((await stored(keptOut.id)).archivedAt);
  });

  test("a page restored while its parent is still in the trash comes back at the top level", async () => {
    const parent = await page("parent");
    const child = await page("child", { parentId: parent.id });
    await call("PATCH", "/notes/parent", { archived: true });
    await call("PATCH", "/notes/child", { archived: false });
    const restored = await stored(child.id);
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.parentId, null);
  });

  test("deleting forever keeps the children, one level up", async () => {
    const parent = await page("parent");
    const child = await page("child", { parentId: parent.id });
    assert.equal((await call("DELETE", "/notes/parent")).status, 200);
    assert.equal((await stored(child.id)).parentId, null);
  });
});

describe("re-parenting through PATCH", () => {
  test("moving a page up beside its parent works (it used to be refused)", async () => {
    const a = await page("a");
    const b = await page("b", { parentId: a.id });
    const c = await page("c", { parentId: b.id });
    const res = await call("PATCH", "/notes/c", { parentSlug: "a" });
    assert.equal(res.status, 200);
    assert.equal((await stored(c.id)).parentId, a.id);
  });

  test("moving a page under its own sub-page is refused (it used to create a cycle)", async () => {
    const a = await page("a");
    await page("b", { parentId: a.id });
    const res = await call<{ error: string }>("PATCH", "/notes/a", { parentSlug: "b" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /descendants/);
    assert.equal((await stored(a.id)).parentId, null);
  });

  test("a parent move is recorded in History", async () => {
    const a = await page("a");
    const b = await page("b");
    await call("PATCH", "/notes/b", { parentSlug: "a" });
    assert.ok(await AppDataSource.getRepository(AuditEvent).findOneBy({ action: "note.move", targetId: b.id }));
    void a;
  });
});

describe("move", () => {
  async function order(parentId: string | null, notebookId = general.id) {
    const rows = await AppDataSource.getRepository(Note).find({
      where: { companyId: company.id, notebookId, ...(parentId ? { parentId } : {}) },
      order: { sortOrder: "ASC" },
    });
    return rows.filter((r) => r.parentId === parentId && !r.archivedAt).map((r) => r.slug);
  }

  test("reorders a page among its siblings", async () => {
    await page("one");
    await page("two");
    await page("three");
    const res = await call<ApiNote>("POST", "/notes/three/move", { index: 0 });
    assert.equal(res.status, 200);
    assert.deepEqual(await order(null), ["three", "one", "two"]);
    const sorts = (await AppDataSource.getRepository(Note).find({ order: { sortOrder: "ASC" } })).map((n) => n.sortOrder);
    assert.deepEqual(sorts, [1000, 2000, 3000]);
  });

  test("nests a page as another's last sub-page", async () => {
    const parent = await page("parent");
    await page("existing", { parentId: parent.id });
    const loose = await page("loose");
    const res = await call("POST", "/notes/loose/move", { parentSlug: "parent" });
    assert.equal(res.status, 200);
    assert.equal((await stored(loose.id)).parentId, parent.id);
    assert.deepEqual(await order(parent.id), ["existing", "loose"]);
  });

  test("moves a page to another notebook with its sub-pages", async () => {
    const parent = await page("parent");
    const child = await page("child", { parentId: parent.id });
    const res = await call("POST", "/notes/parent/move", { notebookSlug: "ideas", parentSlug: null, index: 0 });
    assert.equal(res.status, 200);
    assert.equal((await stored(parent.id)).notebookId, ideas.id);
    assert.equal((await stored(child.id)).notebookId, ideas.id);
    assert.equal((await stored(child.id)).parentId, parent.id);
    assert.ok(await AppDataSource.getRepository(AuditEvent).findOneBy({ action: "note.move", targetId: parent.id }));
  });

  test("a position change is not an edit: nobody's last-edited time moves", async () => {
    const one = await page("one", { updatedAt: new Date("2026-01-01T00:00:00.000Z") } as Partial<Note>);
    const two = await page("two");
    await AppDataSource.getRepository(Note).query(`UPDATE "notes" SET "updatedAt" = '2026-01-01 00:00:00'`);
    await call("POST", "/notes/two/move", { index: 0 });
    assert.equal((await stored(one.id)).updatedAt.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal((await stored(two.id)).updatedAt.toISOString(), "2026-01-01T00:00:00.000Z");
    assert.equal(await AppDataSource.getRepository(AuditEvent).count({ where: { action: "note.move" } }), 0);
  });

  test("refuses cycles, trashed parents, other notebooks' parents and unknowns", async () => {
    const a = await page("a");
    await page("b", { parentId: a.id });
    await page("trashed", { archivedAt: new Date() });
    await page("elsewhere", { notebookId: ideas.id });
    assert.equal((await call("POST", "/notes/a/move", { parentSlug: "b" })).status, 400);
    assert.equal((await call("POST", "/notes/a/move", { parentSlug: "a" })).status, 400);
    assert.equal((await call("POST", "/notes/a/move", { parentSlug: "trashed" })).status, 400);
    assert.equal((await call("POST", "/notes/a/move", { parentSlug: "elsewhere" })).status, 400);
    assert.equal((await call("POST", "/notes/a/move", { parentSlug: "missing" })).status, 400);
    assert.equal((await call("POST", "/notes/a/move", { notebookSlug: "missing" })).status, 400);
    assert.equal((await call("POST", "/notes/trashed/move", { index: 0 })).status, 400);
    assert.equal((await call("POST", "/notes/missing/move", { index: 0 })).status, 404);
    assert.equal((await call("POST", "/notes/a/move", { index: -1 })).status, 400);
    assert.equal((await call("POST", "/notes/a/move", { index: "first" })).status, 400);
  });
});

describe("duplicate", () => {
  test("copies title, body and icon right after the original", async () => {
    const parent = await page("parent");
    const source = await page("source", { parentId: parent.id, body: "# Copy me", icon: "x" });
    await page("after", { parentId: parent.id });
    const employee = await insert(AIEmployee, { companyId: company.id, name: "Ada", slug: "ada", role: "Analyst", soulBody: "" });
    await insert(EmployeeNoteGrant, { employeeId: employee.id, noteId: source.id, accessLevel: "write" });
    const res = await call<ApiNote>("POST", "/notes/source/duplicate", {});
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "SOURCE (copy)");
    assert.equal(res.body.body, "# Copy me");
    assert.equal(res.body.icon, "x");
    assert.equal(res.body.parentId, parent.id);
    assert.equal(res.body.slug, "source-2");
    assert.deepEqual(await order(parent.id), ["source", "source-2", "after"]);
    assert.equal(await AppDataSource.getRepository(EmployeeNoteGrant).count({ where: { noteId: res.body.id } }), 0);
  });

  test("refuses trashed pages and unexpected fields", async () => {
    await page("gone", { archivedAt: new Date() });
    await page("live");
    assert.equal((await call("POST", "/notes/gone/duplicate", {})).status, 400);
    assert.equal((await call("POST", "/notes/live/duplicate", { title: "x" })).status, 400);
  });

  async function order(parentId: string) {
    const rows = await AppDataSource.getRepository(Note).find({ where: { companyId: company.id, parentId }, order: { sortOrder: "ASC" } });
    return rows.map((r) => r.slug);
  }
});

describe("previews", () => {
  test("notePlainText strips Markdown, callouts, toggles and tables", () => {
    const md = [
      "# Title",
      "",
      "> [!WARNING]",
      "> Careful **now**",
      "",
      "<details>",
      "<summary>More</summary>",
      "",
      "- [x] done item",
      "",
      "</details>",
      "",
      "| a | b |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```js",
      "code()",
      "```",
    ].join("\n");
    assert.equal(notePlainText(md), "Title Careful now More done item a b 1 2 code()");
  });

  test("notePreview cuts long text at a word", () => {
    const preview = notePreview(`${"word ".repeat(60)}end`, 40);
    assert.ok(preview.length <= 41);
    assert.ok(preview.endsWith("…"));
    assert.equal(notePreview("short"), "short");
    assert.equal(notePreview(""), "");
  });

  test("noteSnippet centres on the match", () => {
    const body = `${"intro ".repeat(40)}the needle is here ${"outro ".repeat(40)}`;
    const snippet = noteSnippet(body, "needle", 60);
    assert.match(snippet, /needle/);
    assert.ok(snippet.startsWith("…"));
    assert.equal(noteSnippet("no match here", "zzz"), "no match here");
  });
});
