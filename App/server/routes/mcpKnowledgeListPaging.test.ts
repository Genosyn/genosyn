import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { In } from "typeorm";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeNoteGrant } from "../db/entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "../db/entities/EmployeeNotebookGrant.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { PipelineRun } from "../db/entities/PipelineRun.js";
import { errorHandler } from "../middleware/error.js";
import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
} from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The knowledge an AI Employee works through, a page at a time: the Notes it
 * may read (`list_notes`, `search_notes`), its own proactive work reviews
 * (`list_work_reviews`) and a Pipeline's Run history (`list_pipeline_runs`).
 * Each used to stop short — every note with every whole body in one answer, 50
 * search hits, 20 reviews, 50 Runs — with no way past it. They now page by a
 * keyset cursor bound to the list, the company, the employee and the filters,
 * the Grant is applied in the query (never after the page is cut), and a page
 * ends early rather than overflow a tool result.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let other: Company;
let employee: AIEmployee;
let colleague: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  other = await insert(Company, { name: "Globex", slug: "globex", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Operator",
    soulBody: "",
  });
  colleague = await insert(AIEmployee, {
    companyId: company.id,
    name: "Kim",
    slug: "kim",
    role: "Operator",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

type Body = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
};

async function callTool(name: string, body: Record<string, unknown> = {}, bearer = token) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

/** Follow nextCursor to the end, checking the contract on every page. */
async function readEveryPage(
  tool: string,
  rowsKey: string,
  args: Record<string, unknown>,
  between?: (page: number, rows: Array<Record<string, unknown>>) => Promise<void>,
) {
  const rows: Array<Record<string, unknown>> = [];
  const pages: Body[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 400; index++) {
    const page = await callTool(tool, { ...args, ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 200, page.body.error);
    const keys = Object.keys(page.body);
    assert.ok(
      keys.indexOf("hasMore") < keys.indexOf(rowsKey),
      "the page says what follows before its rows",
    );
    pages.push(page.body);
    const pageRows = page.body[rowsKey] as Array<Record<string, unknown>>;
    rows.push(...pageRows);
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null);
      return { rows, ids: rows.map((row) => String(row.id)), pages };
    }
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    if (between) await between(index, pageRows);
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

/**
 * Insert rows in bulk and read them back as stored: expectations come from
 * the database, never from the objects handed to the insert.
 */
async function insertAndReload<T extends { id: string }>(
  entity: new () => T,
  rows: Array<Partial<T> & { id: string }>,
): Promise<T[]> {
  const repo = AppDataSource.getRepository(entity);
  for (let index = 0; index < rows.length; index += 200) {
    await repo.insert(rows.slice(index, index + 200).map((row) => ({ ...row })) as never);
  }
  const stored = await repo.find({ where: { id: In(rows.map((row) => row.id)) } as never });
  const byId = new Map(stored.map((row) => [row.id, row]));
  return rows.map((row) => byId.get(row.id)!);
}

function assertOnce(ids: string[], expected: string[], label: string) {
  assert.equal(new Set(ids).size, ids.length, `${label}: no row twice`);
  assert.deepEqual([...ids].sort(), [...expected].sort(), `${label}: every row`);
}

// ───────────────────────────────── Notes ─────────────────────────────────

async function notebook(slug: string, companyId = company.id): Promise<Notebook> {
  return insert(Notebook, { companyId, title: slug, slug, icon: "", sortOrder: 0 });
}

/** Many notes at once, sharing timestamps and positions as a bulk import leaves them. */
async function notes(
  book: Notebook,
  count: number,
  shape: (index: number) => Partial<Note> = () => ({}),
): Promise<Note[]> {
  const at = new Date("2026-03-01T10:00:00.000Z");
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    companyId: book.companyId,
    notebookId: book.id,
    title: `${book.slug} page ${index}`,
    slug: `${book.slug}-${index}-${randomUUID().slice(0, 6)}`,
    body: `Body of ${book.slug} page ${index}.`,
    icon: "",
    parentId: null,
    sortOrder: index % 3,
    archivedAt: null,
    createdAt: new Date(at.getTime() + Math.floor(index / 7) * 1_000),
    updatedAt: new Date(at.getTime() + Math.floor(index / 5) * 1_000),
    ...shape(index),
  }));
  return insertAndReload(Note, rows);
}

async function grantNotebook(book: Notebook, who = employee) {
  await insert(EmployeeNotebookGrant, { employeeId: who.id, notebookId: book.id, accessLevel: "read" });
}

async function grantNote(note: Note, who = employee) {
  await insert(EmployeeNoteGrant, { employeeId: who.id, noteId: note.id, accessLevel: "read" });
}

describe("list_notes", () => {
  test("pages every readable note once, sharing positions and timestamps, past any old cap", async () => {
    const book = await notebook("handbook");
    const all = await notes(book, 230);
    await grantNotebook(book);

    for (const limit of [1, 37, 200]) {
      if (limit === 1) {
        // One page at a time through the first stretch, to cross many ties.
        const first = await callTool("list_notes", { limit: 1 });
        assert.equal(first.body.total, 230);
        assert.equal((first.body.notes as unknown[]).length, 1);
        continue;
      }
      const { ids, pages } = await readEveryPage("list_notes", "notes", { limit });
      assertOnce(ids, all.map((note) => note.id), `limit ${limit}`);
      assert.equal(pages[0].total, 230);
    }
    // The list is in the sidebar's order: position, then the oldest first.
    const { rows } = await readEveryPage("list_notes", "notes", { limit: 200 });
    const order = rows.map((row) => all.find((note) => note.id === row.id)!);
    for (let index = 1; index < order.length; index++) {
      const [a, b] = [order[index - 1], order[index]];
      assert.ok(
        a.sortOrder < b.sortOrder ||
          (a.sortOrder === b.sortOrder &&
            (a.createdAt.getTime() < b.createdAt.getTime() ||
              (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id))),
        `row ${index} is in order`,
      );
    }
  });

  test("applies the Grants in the query: a page is never short, and only readable notes count", async () => {
    const granted = await notebook("granted");
    const hidden = await notebook("hidden");
    const mine = await notes(granted, 40);
    // Unreadable notes interleave with readable ones in every order column.
    await notes(hidden, 120);
    // One page in the hidden notebook is granted directly, with its children.
    const [parent] = await notes(hidden, 1, () => ({ title: "Granted page", sortOrder: 0 }));
    const children = await notes(hidden, 3, () => ({ parentId: parent.id, sortOrder: 1 }));
    await grantNotebook(granted);
    await grantNote(parent);
    // Another company's notebook, wrongly granted, still reads nothing.
    const foreign = await notebook("foreign", other.id);
    await notes(foreign, 10);
    await grantNotebook(foreign);

    const expected = [...mine, parent, ...children].map((note) => note.id);
    const { ids, pages } = await readEveryPage("list_notes", "notes", { limit: 10 });
    assertOnce(ids, expected, "readable notes");
    assert.equal(pages[0].total, expected.length);
    for (const page of pages.slice(0, -1)) {
      assert.equal((page.notes as unknown[]).length, 10, "every page but the last is full");
    }

    // A colleague with no Grants reads nothing at all.
    const colleagueToken = issueMcpToken(colleague.id, company.id, { authority: "employee" });
    try {
      const nothing = await callTool("list_notes", {}, colleagueToken);
      assert.equal(nothing.status, 200);
      assert.equal(nothing.body.total, 0);
      assert.deepEqual(nothing.body.notes, []);
      assert.equal(nothing.body.hasMore, false);
    } finally {
      revokeMcpToken(colleagueToken);
    }
  });

  test("previews bodies the way get_note reads them, and says when one goes on", async () => {
    const book = await notebook("docs");
    await grantNotebook(book);
    const long = "Quarterly plan. ".repeat(400);
    const [big] = await notes(book, 1, () => ({ body: long, title: "Big", sortOrder: 0 }));
    const [small] = await notes(book, 1, () => ({ body: "Short.", title: "Small", sortOrder: 1 }));

    const listed = await callTool("list_notes", {});
    const rows = listed.body.notes as Array<{ id: string; body: string; bodyTruncated: boolean }>;
    const bigRow = rows.find((row) => row.id === big.id)!;
    const smallRow = rows.find((row) => row.id === small.id)!;
    assert.equal(bigRow.body, long.slice(0, 300));
    assert.equal(bigRow.bodyTruncated, true);
    assert.equal(smallRow.body, "Short.");
    assert.equal(smallRow.bodyTruncated, false);
    assert.match(listed.body.note ?? "", /get_note/);

    // get_note still reads the whole body, unredacted, as before.
    const full = await callTool("get_note", { noteSlug: big.slug });
    assert.equal((full.body.note as unknown as { body: string }).body, long);
    // The preview is the start of exactly what get_note returns.
    assert.ok(long.startsWith(bigRow.body));
  });

  test("filters by notebook, parent page and archive, alone and combined", async () => {
    const one = await notebook("one");
    const two = await notebook("two");
    await grantNotebook(one);
    await grantNotebook(two);
    const inOne = await notes(one, 12);
    const inTwo = await notes(two, 5);
    const [parent] = inOne;
    const kids = await notes(one, 4, () => ({ parentId: parent.id }));
    const archivedKid = (await notes(one, 1, () => ({ parentId: parent.id, archivedAt: new Date() })))[0];
    const archived = (await notes(two, 2, () => ({ archivedAt: new Date() })));

    const ids = async (args: Record<string, unknown>) =>
      (await readEveryPage("list_notes", "notes", { limit: 5, ...args })).ids;

    assertOnce(await ids({}), [...inOne, ...inTwo, ...kids].map((n) => n.id), "unarchived");
    assertOnce(
      await ids({ includeArchived: true }),
      [...inOne, ...inTwo, ...kids, archivedKid, ...archived].map((n) => n.id),
      "with archived",
    );
    assertOnce(await ids({ notebookSlug: "two" }), inTwo.map((n) => n.id), "one notebook");
    assertOnce(
      await ids({ notebookSlug: "two", includeArchived: true }),
      [...inTwo, ...archived].map((n) => n.id),
      "one notebook, archived too",
    );
    assertOnce(await ids({ parentSlug: parent.slug }), kids.map((n) => n.id), "children");
    assertOnce(
      await ids({ parentSlug: parent.slug, includeArchived: true, notebookSlug: "one" }),
      [...kids, archivedKid].map((n) => n.id),
      "children, archived too, in their notebook",
    );
    assert.equal((await callTool("list_notes", { notebookSlug: "nope" })).status, 404);

    // A parent the employee cannot read is refused, not listed around.
    const secret = await notebook("secret");
    const [locked] = await notes(secret, 1);
    const denied = await callTool("list_notes", { parentSlug: locked.slug });
    assert.equal(denied.status, 403);
  });

  test("archiving and deleting notes between pages skips and repeats nothing else", async () => {
    const book = await notebook("ops");
    await grantNotebook(book);
    const all = await notes(book, 90);
    const seen = new Set<string>();
    const gone = new Set<string>();
    const { ids } = await readEveryPage("list_notes", "notes", { limit: 20 }, async (page, rows) => {
      // Archive part of the page just read — it leaves the list behind the
      // cursor — and delete a note the list has not reached yet.
      const shown = rows.map((row) => String(row.id));
      shown.forEach((id) => seen.add(id));
      await AppDataSource.getRepository(Note).update(shown.slice(0, 5), { archivedAt: new Date() });
      const ahead = all.find((note) => !seen.has(note.id) && !gone.has(note.id));
      if (ahead && page < 2) {
        await AppDataSource.getRepository(Note).delete({ id: ahead.id });
        gone.add(ahead.id);
      }
    });
    assert.equal(gone.size, 2);
    assertOnce(
      ids,
      all.filter((note) => !gone.has(note.id)).map((note) => note.id),
      "every note still there",
    );
  });

  test("ends a page early rather than overflow a tool result, and carries on from there", async () => {
    const book = await notebook("wide");
    await grantNotebook(book);
    const all = await notes(book, 200, (index) => ({
      title: `A long, descriptive page title number ${index} `.repeat(4),
      body: "x".repeat(2_000),
    }));
    const first = await callTool("list_notes", { limit: 200 });
    const shown = (first.body.notes as unknown[]).length;
    assert.ok(shown < 200, `the page was cut to fit (${shown})`);
    assert.equal(first.body.hasMore, true);
    assert.ok(JSON.stringify(first.body, null, 2).length < 60_000);
    const { ids } = await readEveryPage("list_notes", "notes", { limit: 200 });
    assertOnce(ids, all.map((note) => note.id), "every note across the cut pages");
  });

  test("cuts a large limit and refuses a cursor from another list, filter set, employee or a garbled one", async () => {
    const book = await notebook("big");
    const other_ = await notebook("other");
    await grantNotebook(book);
    await grantNotebook(other_);
    await notes(book, 260);
    await notes(other_, 3);
    const clamped = await callTool("list_notes", { limit: 5_000 });
    assert.equal(clamped.status, 200);
    assert.equal((clamped.body.notes as unknown[]).length <= 200, true);
    assert.equal(clamped.body.total, 263);

    const page = await callTool("list_notes", { limit: 10 });
    const cursor = page.body.nextCursor!;
    const otherFilters = await callTool("list_notes", { limit: 10, cursor, notebookSlug: "big" });
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const otherList = await callTool("search_notes", { query: "page", cursor });
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);
    const garbled = await callTool("list_notes", { cursor: "not-a-cursor" });
    assert.equal(garbled.status, 400);
    assert.equal(garbled.body.error, CURSOR_INVALID);

    // A colleague with the same Grants cannot carry on the employee's list.
    await grantNotebook(book, colleague);
    await grantNotebook(other_, colleague);
    const colleagueToken = issueMcpToken(colleague.id, company.id, { authority: "employee" });
    try {
      const theirs = await callTool("list_notes", { limit: 10, cursor }, colleagueToken);
      assert.equal(theirs.status, 400);
      assert.equal(theirs.body.error, CURSOR_OTHER_FILTERS);
    } finally {
      revokeMcpToken(colleagueToken);
    }
  });
});

describe("search_notes", () => {
  test("reaches every match past 50, most recently edited first, with a snippet", async () => {
    const book = await notebook("kb");
    await grantNotebook(book);
    const matches = await notes(book, 130, (index) => ({
      title: `Runbook ${index}`,
      body: `${"Intro text. ".repeat(60)}The escalation policy for page ${index}.`,
    }));
    await notes(book, 40, (index) => ({ title: `Unrelated ${index}`, body: "Nothing to see." }));
    // Archived matches stay out, as on the Notes page.
    await notes(book, 5, () => ({ title: "Runbook old", body: "escalation policy", archivedAt: new Date() }));

    const { ids, rows, pages } = await readEveryPage("search_notes", "notes", {
      query: "Escalation POLICY",
    });
    assertOnce(ids, matches.map((note) => note.id), "every match");
    assert.equal(pages[0].total, 130);
    assert.equal((pages[0].notes as unknown[]).length, 20, "20 by default");
    for (let index = 1; index < rows.length; index++) {
      const [a, b] = [rows[index - 1], rows[index]];
      assert.ok(
        String(a.updatedAt) > String(b.updatedAt) ||
          (String(a.updatedAt) === String(b.updatedAt) && String(a.id) > String(b.id)),
        "newest edit first, ties by id",
      );
    }
    const first = rows[0] as { snippet: string; body: string; bodyTruncated: boolean };
    assert.match(first.snippet, /escalation policy/i);
    assert.equal(first.bodyTruncated, true);
    assert.equal(first.body.length, 300);
  });

  test("reads only what the Grants allow, in one notebook when asked, and deletions between pages skip nothing", async () => {
    const open = await notebook("open");
    const shut = await notebook("shut");
    await grantNotebook(open);
    const readable = await notes(open, 60, (index) => ({ body: `invoice terms ${index}` }));
    await notes(shut, 60, (index) => ({ body: `invoice terms ${index}` }));
    const elsewhere = await notebook("elsewhere");
    await grantNotebook(elsewhere);
    const elsewhereHits = await notes(elsewhere, 7, () => ({ body: "invoice terms" }));

    const gone = new Set<string>();
    const { ids } = await readEveryPage(
      "search_notes",
      "notes",
      { query: "invoice terms", limit: 9 },
      async (page) => {
        if (page !== 1) return;
        // Delete readable matches the search has not reached yet: the least
        // recently edited, which come last.
        const later = readable.slice(0, 3);
        await AppDataSource.getRepository(Note).delete(later.map((note) => note.id));
        later.forEach((note) => gone.add(note.id));
      },
    );
    assertOnce(
      ids,
      [...readable, ...elsewhereHits].filter((note) => !gone.has(note.id)).map((note) => note.id),
      "readable matches",
    );

    const scoped = await readEveryPage("search_notes", "notes", {
      query: "invoice terms",
      notebookSlug: "elsewhere",
    });
    assertOnce(scoped.ids, elsewhereHits.map((note) => note.id), "one notebook");
    assert.equal((await callTool("search_notes", { query: "x", notebookSlug: "nope" })).status, 404);
    const blank = await callTool("search_notes", { query: "   " });
    assert.equal(blank.status, 200);
    assert.equal(blank.body.total, 0);
  });

  test("a cursor is bound to its words", async () => {
    const book = await notebook("kb");
    await grantNotebook(book);
    await notes(book, 40, () => ({ body: "alpha beta" }));
    const page = await callTool("search_notes", { query: "alpha beta", limit: 5 });
    const again = await callTool("search_notes", {
      query: "beta  alpha",
      limit: 5,
      cursor: page.body.nextCursor,
    });
    assert.equal(again.status, 400);
    assert.equal(again.body.error, CURSOR_OTHER_FILTERS);
    const clamped = await callTool("search_notes", { query: "alpha", limit: 999 });
    assert.equal((clamped.body.notes as unknown[]).length, 40, "cut to 50, of which 40 exist");
  });
});

// ────────────────────────────── Work reviews ──────────────────────────────

async function reviews(
  count: number,
  shape: (index: number) => Partial<Approval> = () => ({}),
): Promise<Approval[]> {
  const at = new Date("2026-02-01T09:00:00.000Z");
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    companyId: company.id,
    kind: "proactive_work" as const,
    routineId: "",
    employeeId: employee.id,
    title: `Plan ${index}`,
    summary: `Summary ${index}`,
    // A payload the history never reads.
    payloadJson: "not json — reading it would fail",
    status: index % 3 === 0 ? ("rejected" as const) : ("approved" as const),
    requestedAt: new Date(at.getTime() + Math.floor(index / 4) * 60_000),
    ...shape(index),
  }));
  return insertAndReload(Approval, rows);
}

describe("list_work_reviews", () => {
  test("pages the whole history once, newest first, past the old 20", async () => {
    const mine = await reviews(75);
    // Another employee's reviews, another kind and another company stay out.
    await reviews(10, () => ({ employeeId: colleague.id }));
    await reviews(10, () => ({ kind: "routine" as Approval["kind"] }));
    await reviews(10, () => ({ companyId: other.id }));

    const { ids, rows, pages } = await readEveryPage("list_work_reviews", "reviews", { limit: 8 });
    assertOnce(ids, mine.map((row) => row.id), "every review");
    assert.equal(pages[0].total, 75);
    for (let index = 1; index < rows.length; index++) {
      const [a, b] = [rows[index - 1], rows[index]];
      assert.ok(
        String(a.requestedAt) > String(b.requestedAt) ||
          (String(a.requestedAt) === String(b.requestedAt) && String(a.id) > String(b.id)),
      );
    }
    const defaults = await callTool("list_work_reviews");
    assert.equal((defaults.body.reviews as unknown[]).length, 20, "20 by default");
    const clamped = await callTool("list_work_reviews", { limit: 1_000 });
    assert.equal((clamped.body.reviews as unknown[]).length, 75, "cut to 100, of which 75 exist");
  });

  test("filters by status, and a cursor is bound to it", async () => {
    const mine = await reviews(40);
    const rejected = mine.filter((row) => row.status === "rejected").map((row) => row.id);
    const { ids } = await readEveryPage("list_work_reviews", "reviews", {
      status: "rejected",
      limit: 4,
    });
    assertOnce(ids, rejected, "rejected");
    const page = await callTool("list_work_reviews", { status: "rejected", limit: 4 });
    const swapped = await callTool("list_work_reviews", {
      status: "approved",
      limit: 4,
      cursor: page.body.nextCursor,
    });
    assert.equal(swapped.status, 400);
    assert.equal(swapped.body.error, CURSOR_OTHER_FILTERS);
  });

  test("redacts titles and summaries as before and never shows the plan's payload", async () => {
    await reviews(1, () => ({
      title: "Rotate api_key=sk-live-abcdef0123456789abcdef",
      summary: "Customer pasted password=hunter2-very-secret into the ticket.",
    }));
    const listed = await callTool("list_work_reviews");
    const [row] = listed.body.reviews as Array<Record<string, unknown>>;
    assert.equal("payloadJson" in row, false);
    assert.doesNotMatch(JSON.stringify(listed.body), /sk-live-abcdef|hunter2-very-secret/);
    assert.match(String(row.outcome), /Do not repeat|verify the result/);
  });
});

// ──────────────────────────── Pipeline Run history ────────────────────────────

async function pipeline(slug: string, companyId = company.id, graph?: unknown): Promise<Pipeline> {
  return insert(Pipeline, {
    companyId,
    name: slug,
    slug,
    description: "",
    enabled: true,
    graphJson: JSON.stringify(
      graph ?? { nodes: [{ id: "t", type: "trigger.manual", x: 0, y: 0, config: {} }], edges: [] },
    ),
  });
}

async function runs(
  of: Pipeline,
  count: number,
  shape: (index: number) => Partial<PipelineRun> = () => ({}),
): Promise<PipelineRun[]> {
  const at = new Date("2026-01-10T08:00:00.000Z");
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    pipelineId: of.id,
    startedAt: new Date(at.getTime() + Math.floor(index / 6) * 3_600_000),
    finishedAt: null,
    status: (index % 4 === 0 ? "failed" : "completed") as PipelineRun["status"],
    triggerKind: (index % 2 === 0 ? "webhook" : "schedule") as PipelineRun["triggerKind"],
    triggerNodeId: "t",
    inputJson: "{}",
    outputJson: "{}",
    logContent: "a long log ".repeat(50),
    errorMessage: index % 4 === 0 ? `step failed on value ${index}` : null,
    ...shape(index),
  }));
  return insertAndReload(PipelineRun, rows);
}

describe("list_pipeline_runs", () => {
  test("pages a Pipeline's whole history once, newest first, past the old 50", async () => {
    const billing = await pipeline("billing");
    const all = await runs(billing, 260);
    await runs(await pipeline("other-one"), 20);
    const { ids, rows, pages } = await readEveryPage("list_pipeline_runs", "runs", {
      pipelineId: "billing",
      limit: 45,
    });
    assertOnce(ids, all.map((run) => run.id), "every Run");
    assert.equal(pages[0].total, 260);
    assert.equal((pages[0].pipeline as { slug: string }).slug, "billing");
    for (let index = 1; index < rows.length; index++) {
      const [a, b] = [rows[index - 1], rows[index]];
      assert.ok(
        String(a.startedAt) > String(b.startedAt) ||
          (String(a.startedAt) === String(b.startedAt) && String(a.id) > String(b.id)),
      );
      assert.equal("logContent" in b, false, "a listing carries no log");
    }
    const defaults = await callTool("list_pipeline_runs", { pipelineId: billing.id });
    assert.equal((defaults.body.runs as unknown[]).length, 50, "50 by default");
    // Cut to 200, not refused — and here cut further to fit a tool result.
    const clamped = await callTool("list_pipeline_runs", { pipelineId: billing.id, limit: 9_999 });
    assert.equal(clamped.status, 200);
    const shown = (clamped.body.runs as unknown[]).length;
    assert.ok(shown > 50 && shown <= 200, `a large page (${shown})`);
    assert.equal(clamped.body.hasMore, true);
  });

  test("filters by status, trigger and start date, alone and combined", async () => {
    const billing = await pipeline("billing");
    const all = await runs(billing, 120);
    const ids = async (args: Record<string, unknown>) =>
      (await readEveryPage("list_pipeline_runs", "runs", { pipelineId: "billing", limit: 13, ...args }))
        .ids;
    const day = (run: PipelineRun) => run.startedAt.toISOString().slice(0, 10);
    assertOnce(await ids({ status: "failed" }), all.filter((r) => r.status === "failed").map((r) => r.id), "status");
    assertOnce(
      await ids({ triggerKind: "webhook" }),
      all.filter((r) => r.triggerKind === "webhook").map((r) => r.id),
      "trigger",
    );
    assertOnce(
      await ids({ from: "2026-01-11", to: "2026-01-11" }),
      all.filter((r) => day(r) === "2026-01-11").map((r) => r.id),
      "one UTC day",
    );
    assertOnce(
      await ids({ status: "failed", triggerKind: "webhook", from: "2026-01-11" }),
      all
        .filter((r) => r.status === "failed" && r.triggerKind === "webhook" && day(r) >= "2026-01-11")
        .map((r) => r.id),
      "combined",
    );
    const backwards = await callTool("list_pipeline_runs", {
      pipelineId: "billing",
      from: "2026-02-01",
      to: "2026-01-01",
    });
    assert.equal(backwards.status, 400);
  });

  test("keeps the error text from an employee that could not build the Pipeline, on every page", async () => {
    const billing = await pipeline("billing", company.id, {
      nodes: [
        { id: "t", type: "trigger.manual", x: 0, y: 0, config: {} },
        {
          id: "charge",
          type: "integration.invoke",
          x: 260,
          y: 0,
          config: { connectionId: randomUUID(), toolName: "stripe_create_charge" },
        },
      ],
      edges: [{ id: "e1", fromNodeId: "t", toNodeId: "charge" }],
    });
    await runs(billing, 30, () => ({ status: "failed", errorMessage: "card 4242 declined" }));
    const { rows } = await readEveryPage("list_pipeline_runs", "runs", { pipelineId: "billing", limit: 7 });
    assert.equal(rows.length, 30);
    assert.ok(rows.every((row) => row.errorMessage === null));
    assert.ok(rows.every((row) => row.status === "failed"));
  });

  test("binds a cursor to its Pipeline, filters and company; another company's Pipeline is not there", async () => {
    const billing = await pipeline("billing");
    const digest = await pipeline("digest");
    await runs(billing, 30);
    await runs(digest, 30);
    const page = await callTool("list_pipeline_runs", { pipelineId: "billing", limit: 5 });
    const elsewhere = await callTool("list_pipeline_runs", {
      pipelineId: "digest",
      limit: 5,
      cursor: page.body.nextCursor,
    });
    assert.equal(elsewhere.status, 400);
    assert.equal(elsewhere.body.error, CURSOR_OTHER_FILTERS);
    const filtered = await callTool("list_pipeline_runs", {
      pipelineId: "billing",
      status: "failed",
      limit: 5,
      cursor: page.body.nextCursor,
    });
    assert.equal(filtered.body.error, CURSOR_OTHER_FILTERS);

    const theirs = await pipeline("theirs", other.id);
    await runs(theirs, 5);
    assert.equal((await callTool("list_pipeline_runs", { pipelineId: theirs.id })).status, 404);
    assert.equal((await callTool("list_pipeline_runs", { pipelineId: "theirs" })).status, 404);
  });
});
