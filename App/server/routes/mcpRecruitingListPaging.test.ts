import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";
import { In } from "typeorm";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRecruitingGrant } from "../db/entities/EmployeeRecruitingGrant.js";
import { RecruitingApplication } from "../db/entities/RecruitingApplication.js";
import { RecruitingOpening } from "../db/entities/RecruitingOpening.js";
import { errorHandler } from "../middleware/error.js";
import { CURSOR_OTHER_FILTERS, CURSOR_OTHER_LIST } from "../services/listPaging.js";
import { isTokenTainted, issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { setScreeningAutoKickForTests } from "../services/recruiting/screeningQueue.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Recruiting's two lists, a page at a time. `list_openings` read the newest 500
 * Openings and only then sorted them by status, so past 500 an open Opening
 * could be missing while closed ones filled the answer; it now sorts in the
 * query. `list_applications` paged by offset — skipping an applicant every time
 * one ahead of the offset moved out of the filtered stage — and stopped at an
 * offset of 100,000; it now pages by a keyset cursor, every sort included.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let root = "";
let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let other: Company;
let employee: AIEmployee;

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-recruiting-paging-"));
  mutableConfig.dataDir = path.join(root, "data");
  setScreeningAutoKickForTests(false);
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
  setScreeningAutoKickForTests(true);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, { name: "Acme", slug: `acme-${randomUUID()}`, ownerId: "owner" });
  other = await insert(Company, { name: "Globex", slug: `globex-${randomUUID()}`, ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Riley",
    slug: "riley",
    role: "Recruiter",
    soulBody: "",
  });
  await insert(EmployeeRecruitingGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel: "read",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

type Body = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
  rows?: Array<Record<string, unknown>>;
};

async function callTool(name: string, body: Record<string, unknown> = {}, bearer = token) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function readEveryPage(
  tool: string,
  args: Record<string, unknown>,
  between?: (page: number, rows: Array<Record<string, unknown>>) => Promise<void>,
) {
  const rows: Array<Record<string, unknown>> = [];
  const pages: Body[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < 400; index++) {
    const page = await callTool(tool, { ...args, ...(cursor ? { cursor } : {}) });
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    rows.push(...page.body.rows!);
    if (!page.body.hasMore) return { rows, ids: rows.map((row) => String(row.id)), pages };
    assert.match(page.body.note ?? "", /nextCursor/);
    if (between) await between(index, page.body.rows!);
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

function assertOnce(ids: string[], expected: string[], label: string) {
  assert.equal(new Set(ids).size, ids.length, `${label}: no row twice`);
  assert.deepEqual([...ids].sort(), [...expected].sort(), `${label}: every row`);
}

const AT = new Date("2026-04-01T12:00:00.000Z");

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

async function openings(
  count: number,
  shape: (index: number) => Partial<RecruitingOpening> = () => ({}),
): Promise<RecruitingOpening[]> {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    companyId: company.id,
    slug: `role-${index}-${randomUUID().slice(0, 6)}`,
    title: `Role ${index}`,
    status: (["open", "draft", "closed"] as const)[index % 3],
    createdAt: new Date(AT.getTime() + Math.floor(index / 6) * 60_000),
    updatedAt: new Date(AT.getTime() + index * 1_000),
    ...shape(index),
  }));
  return insertAndReload(RecruitingOpening, rows);
}

const RANK: Record<string, number> = { open: 0, draft: 1, closed: 2 };

describe("list_openings", () => {
  test("pages every Opening once: open first, then drafts, then closed, newest posted first in each", async () => {
    const all = await openings(140);
    await openings(5, () => ({ companyId: other.id }));
    const { rows, ids, pages } = await readEveryPage("list_openings", { limit: 11 });
    assertOnce(ids, all.map((row) => row.id), "every Opening");
    assert.equal(pages[0].total, 140);
    const byId = new Map(all.map((row) => [row.id, row]));
    for (let index = 1; index < rows.length; index++) {
      const a = byId.get(String(rows[index - 1].id))!;
      const b = byId.get(String(rows[index].id))!;
      const order =
        RANK[a.status] - RANK[b.status] ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        (a.id > b.id ? -1 : 1);
      assert.ok(order < 0, `row ${index} is in order`);
    }
    // The listing row, as before: counts and links, no description.
    assert.equal("description" in rows[0], false);
    assert.equal(typeof rows[0].applicationCount, "number");
  });

  test("an open Opening never hides behind a cut: 520 newer closed ones, three old open ones first", async () => {
    const old = await openings(3, (index) => ({
      status: "open",
      createdAt: new Date(AT.getTime() - 86_400_000 * 400 - index),
      updatedAt: new Date(AT.getTime() - 86_400_000 * 400),
      title: `Evergreen ${index}`,
    }));
    await openings(520, () => ({ status: "closed" }));
    const first = await callTool("list_openings", { limit: 5 });
    assert.equal(first.status, 200);
    assert.equal(first.body.total, 523);
    assertOnce(
      first.body.rows!.slice(0, 3).map((row) => String(row.id)),
      old.map((row) => row.id),
      "the open ones lead",
    );
    const { ids } = await readEveryPage("list_openings", { limit: 100 });
    assert.equal(ids.length, 523);
    assert.equal(new Set(ids).size, 523);
  });

  test("filters by status and title words, and a cursor is bound to them", async () => {
    const all = await openings(60, (index) => ({ title: index % 4 === 0 ? `Design lead ${index}` : `Engineer ${index}` }));
    const ids = async (args: Record<string, unknown>) => (await readEveryPage("list_openings", { limit: 7, ...args })).ids;
    assertOnce(await ids({ status: "draft" }), all.filter((r) => r.status === "draft").map((r) => r.id), "drafts");
    assertOnce(await ids({ query: "DESIGN" }), all.filter((r) => r.title.startsWith("Design")).map((r) => r.id), "words");
    assertOnce(
      await ids({ query: "design", status: "open" }),
      all.filter((r) => r.title.startsWith("Design") && r.status === "open").map((r) => r.id),
      "both",
    );
    const page = await callTool("list_openings", { limit: 7 });
    const swapped = await callTool("list_openings", { limit: 7, status: "open", cursor: page.body.nextCursor });
    assert.equal(swapped.status, 400);
    assert.equal(swapped.body.error, CURSOR_OTHER_FILTERS);
    const otherList = await callTool("list_applications", { cursor: page.body.nextCursor });
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);
    const clamped = await callTool("list_openings", { limit: 5_000 });
    assert.equal(clamped.status, 200);
    assert.equal(clamped.body.rows!.length <= 100, true);
  });

  test("needs a Recruiting Grant", async () => {
    await AppDataSource.getRepository(EmployeeRecruitingGrant).delete({ employeeId: employee.id });
    await openings(3);
    const refused = await callTool("list_openings");
    assert.equal(refused.status, 403);
  });
});

async function applications(
  opening: RecruitingOpening,
  count: number,
  shape: (index: number) => Partial<RecruitingApplication> = () => ({}),
): Promise<RecruitingApplication[]> {
  const rows = Array.from({ length: count }, (_, index) => ({
    id: randomUUID(),
    companyId: opening.companyId,
    openingId: opening.id,
    candidateName: `Candidate ${index}`,
    candidateEmail: `candidate${index}@example.test`,
    stage: "applied" as const,
    stageChangedAt: AT,
    score: index % 5 === 0 ? null : (index * 7) % 100,
    createdAt: new Date(AT.getTime() + Math.floor(index / 5) * 60_000),
    updatedAt: AT,
    ...shape(index),
  }));
  return insertAndReload(RecruitingApplication, rows);
}

describe("list_applications", () => {
  test("pages every application once in each sort, ties and unscored ones included", async () => {
    const [opening] = await openings(1, () => ({ status: "open" }));
    const all = await applications(opening, 135);
    const [theirOpening] = await openings(1, () => ({ companyId: other.id }));
    await applications(theirOpening, 5);
    const byId = new Map(all.map((row) => [row.id, row]));

    for (const sort of ["newest", "oldest", "score"] as const) {
      const { ids, rows, pages } = await readEveryPage("list_applications", { sort, limit: 12 });
      assertOnce(ids, all.map((row) => row.id), sort);
      assert.equal(pages[0].total, 135);
      for (let index = 1; index < rows.length; index++) {
        const a = byId.get(String(rows[index - 1].id))!;
        const b = byId.get(String(rows[index].id))!;
        const time = a.createdAt.getTime() - b.createdAt.getTime();
        const id = a.id < b.id ? -1 : 1;
        const order =
          sort === "oldest"
            ? time || id
            : sort === "newest"
              ? -time || -id
              : (b.score ?? -1) - (a.score ?? -1) || -time || -id;
        assert.ok(order < 0, `${sort}: row ${index} is in order`);
      }
    }
    // Unscored applications come after every scored one.
    const { rows } = await readEveryPage("list_applications", { sort: "score", limit: 100 });
    const firstUnscored = rows.findIndex((row) => row.score === null);
    assert.ok(firstUnscored > 0);
    assert.ok(rows.slice(firstUnscored).every((row) => row.score === null));
  });

  test("moving applicants out of the filtered stage between pages skips nobody", async () => {
    const [opening] = await openings(1, () => ({ status: "open" }));
    const all = await applications(opening, 80);
    const moved = new Set<string>();
    const { ids } = await readEveryPage(
      "list_applications",
      { openingId: opening.id, stage: "applied", limit: 10 },
      async (_page, rows) => {
        // Screen everyone just read — an offset would now skip ten.
        const shown = rows.map((row) => String(row.id));
        await AppDataSource.getRepository(RecruitingApplication).update(shown, { stage: "screening" });
        shown.forEach((id) => moved.add(id));
      },
    );
    assertOnce(ids, all.map((row) => row.id), "every applicant once");
    assert.equal(moved.size, 70);
  });

  test("filters alone and combined, and the read taints the turn on every page", async () => {
    const [backend] = await openings(1, () => ({ status: "open", title: "Backend" }));
    const [data] = await openings(1, () => ({ status: "open", title: "Data" }));
    const a = await applications(backend, 40, (index) => ({
      stage: index % 2 ? "interview" : "applied",
      candidateName: index % 8 === 0 ? `Grace ${index}` : `Alan ${index}`,
      screenStatus: index % 3 === 0 ? "scored" : "none",
    }));
    const b = await applications(data, 20, () => ({ stage: "rejected" }));
    const ids = async (args: Record<string, unknown>) =>
      (await readEveryPage("list_applications", { limit: 6, ...args })).ids;
    assertOnce(await ids({ openingId: data.id }), b.map((r) => r.id), "one Opening");
    assertOnce(
      await ids({ stage: "active" }),
      a.map((r) => r.id),
      "active leaves the rejected out",
    );
    assertOnce(await ids({ query: "grace" }), a.filter((r) => r.candidateName.startsWith("Grace")).map((r) => r.id), "words");
    assertOnce(
      await ids({ minScore: 50, sort: "score" }),
      [...a, ...b].filter((r) => r.score !== null && r.score >= 50).map((r) => r.id),
      "score floor",
    );
    assertOnce(
      await ids({ openingId: backend.id, stage: "interview", screenStatus: "scored" }),
      a.filter((r) => r.stage === "interview" && r.screenStatus === "scored").map((r) => r.id),
      "combined",
    );
    assert.equal(isTokenTainted(token), true, "applicants are strangers");
    const page = await callTool("list_applications", { limit: 3 });
    assert.match(page.body.note ?? "", /untrusted data from a stranger/);
    assert.match(page.body.note ?? "", /nextCursor/);
  });

  test("an older Skill's offset still starts its first page, and the cursor carries on from there", async () => {
    const [opening] = await openings(1, () => ({ status: "open" }));
    const all = await applications(opening, 30);
    const everything = (await readEveryPage("list_applications", { limit: 100 })).ids;
    const skipped = await callTool("list_applications", { offset: 10, limit: 5 });
    assert.equal(skipped.status, 200);
    assert.deepEqual(skipped.body.rows!.map((row) => row.id), everything.slice(10, 15));
    const next = await callTool("list_applications", { limit: 5, cursor: skipped.body.nextCursor });
    assert.deepEqual(next.body.rows!.map((row) => row.id), everything.slice(15, 20));
    assert.equal(all.length, 30);
  });

  test("cuts a large limit, binds the cursor to its sort and filters, and needs a Grant", async () => {
    const [opening] = await openings(1, () => ({ status: "open" }));
    await applications(opening, 130);
    const clamped = await callTool("list_applications", { limit: 5_000 });
    assert.equal(clamped.status, 200);
    assert.equal(clamped.body.rows!.length <= 100, true);
    assert.equal(clamped.body.total, 130);
    const page = await callTool("list_applications", { sort: "newest", limit: 5 });
    for (const changed of [{ sort: "oldest" }, { sort: "score" }, { stage: "applied" }]) {
      const refused = await callTool("list_applications", { limit: 5, ...changed, cursor: page.body.nextCursor });
      assert.equal(refused.status, 400, JSON.stringify(changed));
      assert.equal(refused.body.error, CURSOR_OTHER_FILTERS);
    }
    await AppDataSource.getRepository(EmployeeRecruitingGrant).delete({ employeeId: employee.id });
    assert.equal((await callTool("list_applications")).status, 403);
  });
});
