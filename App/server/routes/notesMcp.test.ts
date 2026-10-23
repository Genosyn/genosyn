import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "../db/entities/EmployeeNotebookGrant.js";
import { Membership } from "../db/entities/Membership.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * AI Employees read and write notes through their tools while Members edit
 * the same pages in the block editor. These pin that the tools still see and
 * store exactly the Markdown the editor reads and writes (callouts, toggles,
 * tables and all), that trashing a page through a tool takes its sub-pages
 * along like the editor does, and that re-parenting can neither form a cycle
 * nor reach a parent the employee can't write.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let general: Notebook;
let ideas: Notebook;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: testId("founder") });
  await insert(Membership, { companyId: company.id, userId: testId("owner"), role: "owner" });
  employee = await insert(AIEmployee, { companyId: company.id, name: "Ada", slug: "ada", role: "Writer", soulBody: "" });
  general = await insert(Notebook, { companyId: company.id, title: "General", slug: "general", icon: "", sortOrder: 0 });
  ideas = await insert(Notebook, { companyId: company.id, title: "Ideas", slug: "ideas", icon: "", sortOrder: 1 });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

async function tool<T = Record<string, unknown>>(name: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function page(slug: string, extra: Partial<Note> = {}): Promise<Note> {
  return insert(Note, {
    companyId: company.id,
    notebookId: general.id,
    title: slug,
    slug,
    body: "",
    icon: "",
    parentId: null,
    sortOrder: 0,
    archivedAt: null,
    ...extra,
  });
}

async function grant(noteId: string, accessLevel: "read" | "write" = "write") {
  await insert(EmployeeNoteGrant, { employeeId: employee.id, noteId, accessLevel });
}

async function stored(id: string): Promise<Note> {
  return AppDataSource.getRepository(Note).findOneByOrFail({ id });
}

type ToolNote = { note: { slug: string; body: string; archived: boolean; parentId: string | null } };

/** Markdown in the shapes the editor writes: callouts, toggles, to-dos, tables, code. */
const EDITOR_MARKDOWN = [
  "# Launch plan",
  "",
  "> [!WARNING]",
  "> Budget approval needed.",
  "",
  "<details>",
  "<summary>Background</summary>",
  "",
  "- [x] Research done",
  "  - [ ] Nested follow-up",
  "",
  "</details>",
  "",
  "| Metric | Value |",
  "| --- | --- |",
  "| ARR | $1.5M |",
  "",
  "```ts",
  "ship();",
  "```",
  "",
].join("\n");

describe("the editor's Markdown through the tools", () => {
  test("create_note stores the body byte-for-byte and get_note returns it", async () => {
    const created = await tool<ToolNote>("create_note", { title: "Launch plan", body: EDITOR_MARKDOWN });
    assert.equal(created.status, 200);
    const read = await tool<ToolNote>("get_note", { noteSlug: created.body.note.slug });
    assert.equal(read.status, 200);
    assert.equal(read.body.note.body, EDITOR_MARKDOWN);
  });

  test("update_note replaces the body exactly, and search finds text inside callouts and toggles", async () => {
    const note = await page("plan", { body: "old" });
    await grant(note.id);
    assert.equal((await tool("update_note", { noteSlug: "plan", body: EDITOR_MARKDOWN })).status, 200);
    assert.equal((await stored(note.id)).body, EDITOR_MARKDOWN);
    const hits = await tool<{ notes: Array<{ slug: string }> }>("search_notes", { query: "budget approval" });
    assert.deepEqual(hits.body.notes.map((n) => n.slug), ["plan"]);
    const nested = await tool<{ notes: Array<{ slug: string }> }>("search_notes", { query: "nested follow-up" });
    assert.deepEqual(nested.body.notes.map((n) => n.slug), ["plan"]);
  });

  test("a page a Member edited (CRLF, trailing spaces and all) reads back unchanged", async () => {
    const body = "Line one  \r\nLine two\r\n\r\n- item\r\n";
    const note = await page("crlf", { body });
    await grant(note.id, "read");
    const read = await tool<ToolNote>("get_note", { noteSlug: "crlf" });
    assert.equal(read.body.note.body, body);
  });
});

describe("trash through update_note", () => {
  test("archiving a page takes its sub-pages along; restoring brings them back", async () => {
    const parent = await page("parent");
    const child = await page("child", { parentId: parent.id });
    const grandchild = await page("grandchild", { parentId: child.id });
    await grant(parent.id);
    const archived = await tool<ToolNote>("update_note", { noteSlug: "parent", archived: true });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.note.archived, true);
    assert.ok((await stored(child.id)).archivedAt);
    assert.ok((await stored(grandchild.id)).archivedAt);
    const listed = await tool<{ notes: Array<{ slug: string }> }>("list_notes", {});
    assert.deepEqual(listed.body.notes, []);
    await tool("update_note", { noteSlug: "parent", archived: false });
    assert.equal((await stored(child.id)).archivedAt, null);
    assert.equal((await stored(grandchild.id)).archivedAt, null);
  });

  test("read access can't archive", async () => {
    const note = await page("readonly");
    await grant(note.id, "read");
    assert.equal((await tool("update_note", { noteSlug: "readonly", archived: true })).status, 403);
    assert.equal((await stored(note.id)).archivedAt, null);
  });
});

describe("re-parenting through update_note", () => {
  test("moving a page under its own sub-page is refused (it used to create a cycle)", async () => {
    const a = await page("a");
    await page("b", { parentId: a.id });
    await grant(a.id);
    const res = await tool<{ error: string }>("update_note", { noteSlug: "a", parentSlug: "b" });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /descendants/);
    assert.equal((await stored(a.id)).parentId, null);
  });

  test("moving a page up beside its parent works (it used to be refused)", async () => {
    const a = await page("a");
    const b = await page("b", { parentId: a.id });
    const c = await page("c", { parentId: b.id });
    await grant(a.id);
    const res = await tool<ToolNote>("update_note", { noteSlug: "c", parentSlug: "a" });
    assert.equal(res.status, 200);
    assert.equal((await stored(c.id)).parentId, a.id);
  });

  test("a parent in another notebook is refused", async () => {
    const mine = await page("mine");
    const elsewhere = await page("elsewhere", { notebookId: ideas.id });
    await grant(mine.id);
    await grant(elsewhere.id);
    const res = await tool("update_note", { noteSlug: "mine", parentSlug: "elsewhere" });
    assert.equal(res.status, 400);
    assert.equal((await stored(mine.id)).parentId, null);
  });

  test("a parent the employee can't write is refused", async () => {
    const mine = await page("mine");
    const theirs = await page("theirs");
    await grant(mine.id);
    await grant(theirs.id, "read");
    assert.equal((await tool("update_note", { noteSlug: "mine", parentSlug: "theirs" })).status, 403);
    const hidden = await page("hidden");
    assert.equal((await tool("update_note", { noteSlug: "mine", parentSlug: "hidden" })).status, 403);
    assert.equal((await stored(mine.id)).parentId, null);
    void hidden;
  });

  test("a notebook Grant covers both the page and its new parent", async () => {
    const a = await page("a");
    const b = await page("b");
    await insert(EmployeeNotebookGrant, { employeeId: employee.id, notebookId: general.id, accessLevel: "write" });
    assert.equal((await tool("update_note", { noteSlug: "b", parentSlug: "a" })).status, 200);
    assert.equal((await stored(b.id)).parentId, a.id);
  });
});

describe("delete_note", () => {
  test("still re-parents the page's children one level up", async () => {
    const parent = await page("parent");
    const child = await page("child", { parentId: parent.id });
    await grant(parent.id);
    assert.equal((await tool("delete_note", { noteSlug: "parent" })).status, 200);
    assert.equal((await stored(child.id)).parentId, null);
  });
});
