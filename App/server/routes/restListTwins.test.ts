import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { createApp } from "../app.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { CalendarAccount } from "../db/entities/CalendarAccount.js";
import type { Company } from "../db/entities/Company.js";
import { EmployeeCalendarGrant } from "../db/entities/EmployeeCalendarGrant.js";
import { Handoff, type HandoffStatus } from "../db/entities/Handoff.js";
import { Meeting, type MeetingStatus } from "../db/entities/Meeting.js";
import { MeetingParticipant } from "../db/entities/MeetingParticipant.js";
import { Membership } from "../db/entities/Membership.js";
import { Project } from "../db/entities/Project.js";
import { ProjectMember } from "../db/entities/ProjectMember.js";
import { Routine } from "../db/entities/Routine.js";
import { Run, type RunStatus } from "../db/entities/Run.js";
import { Todo, type TodoStatus } from "../db/entities/Todo.js";
import type { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { buildOpenApiDocument } from "../openapi/spec.js";
import {
  CURSOR_INVALID,
  CURSOR_OTHER_FILTERS,
  CURSOR_OTHER_LIST,
} from "../services/listPaging.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import {
  createMemberOfNewCompany,
  mintTestApiKey,
  withTestInstanceSecrets,
} from "../test/apiAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";

/**
 * The REST twins of the paged lists outside Finance, end to end through
 * `createApp()` with real API keys: a Routine's Runs, the handoffs, a
 * project's Todos and the meetings. Each keeps the answer it always gave when
 * neither `limit` nor `cursor` is sent, and otherwise answers one page from
 * the very function its AI tool reads — so the two reach the same rows in the
 * same order, and where they read the same list a cursor from one continues
 * the other.
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
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  restoreSecrets();
});

let company: Company;
let owner: User;
let ownerKey: string;
let employee: AIEmployee;
let colleague: AIEmployee;
let third: AIEmployee;

beforeEach(async () => {
  await resetTestDb();
  ({ user: owner, company } = await createMemberOfNewCompany("owner"));
  ownerKey = (await mintTestApiKey(owner.id, company.id)).token;
  const hire = (name: string) =>
    insert(AIEmployee, {
      companyId: company.id,
      name,
      slug: name.toLowerCase(),
      role: "Operator",
      soulBody: "",
    });
  employee = await hire("Jamie");
  colleague = await hire("Kim");
  third = await hire("Lee");
});

type Body = Record<string, unknown> & {
  error?: string;
  total?: number;
  hasMore?: boolean;
  nextCursor?: string | null;
  note?: string;
};

async function get(path: string, token = ownerKey, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: (await response.json()) as Body };
}

async function tool(name: string, args: Record<string, unknown>, who: AIEmployee = employee) {
  const token = issueMcpToken(who.id, company.id, { authority: "employee" });
  try {
    const response = await fetch(`${baseUrl}/api/internal/mcp/tools/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return { status: response.status, body: (await response.json()) as Body };
  } finally {
    revokeMcpToken(token);
  }
}

/** Every page of a REST list, following nextCursor; the ids in the order they came. */
async function readAll(path: string, rowsKey: string, token = ownerKey) {
  const ids: string[] = [];
  const pages: Body[] = [];
  let cursor = "";
  const joiner = path.includes("?") ? "&" : "?";
  for (let guard = 0; guard < 200; guard++) {
    const page = await get(`${path}${cursor ? `${joiner}cursor=${cursor}` : ""}`, token);
    assert.equal(page.status, 200, page.body.error);
    pages.push(page.body);
    ids.push(...(page.body[rowsKey] as Array<{ id: string }>).map((row) => row.id));
    if (!page.body.hasMore) {
      assert.equal(page.body.nextCursor, null, "the last page has no cursor");
      assert.equal(page.body.note, undefined, "the last page needs no note");
      return { ids, pages };
    }
    assert.match(page.body.note ?? "", /nextCursor/, "a page with more says how to read on");
    cursor = page.body.nextCursor!;
  }
  throw new Error("paging never ended");
}

function idsOf(body: Body, key: string): string[] {
  return (body[key] as Array<{ id: string }>).map((row) => row.id);
}

/** Rows newest first by a timestamp, then by id descending: the keyset order. */
function newestFirst<T extends { id: string }>(rows: T[], at: (row: T) => Date): T[] {
  return [...rows].sort((a, b) => {
    const delta = at(b).getTime() - at(a).getTime();
    if (delta !== 0) return delta;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

async function insertMany<T extends object>(entity: new () => T, rows: Array<Partial<T>>) {
  const repo = AppDataSource.getRepository(entity);
  for (let i = 0; i < rows.length; i += 100) {
    await repo.insert(rows.slice(i, i + 100) as never);
  }
}

// ─────────────────────────────── Runs ───────────────────────────────

describe("GET /routines/:rid/runs", () => {
  let routine: Routine;
  type RunRow = { id: string; startedAt: Date; status: RunStatus };
  let runs: RunRow[];
  const BASE = Date.UTC(2024, 0, 1, 9);

  beforeEach(async () => {
    routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Chase overdue invoices",
      slug: "chase-overdue-invoices",
      cronExpr: "0 9 * * *",
      body: "Chase every invoice past due.",
    });
    runs = [];
    const rows: Partial<Run>[] = [];
    for (let i = 0; i < 130; i++) {
      // Five Runs to an instant: a page boundary falls inside a tie.
      const startedAt = new Date(BASE + Math.floor(i / 5) * 60_000);
      const status: RunStatus =
        i % 13 === 0 ? (i % 2 ? "queued" : "running") : i % 3 === 0 ? "failed" : "completed";
      const id = randomUUID();
      runs.push({ id, startedAt, status });
      rows.push({
        id,
        routineId: routine.id,
        employeeId: employee.id,
        startedAt,
        finishedAt: status === "queued" || status === "running" ? null : startedAt,
        status,
        logContent: `transcript ${i}`,
        exitCode: 0,
        createdAt: startedAt,
      });
    }
    await insertMany(Run, rows);
  });

  const finished = () =>
    newestFirst(
      runs.filter((run) => run.status !== "queued" && run.status !== "running"),
      (run) => run.startedAt,
    );

  test("keeps its plain array of the newest 50, queued and running included, without a page", async () => {
    const plain = await get(`/routines/${routine.id}/runs`);
    assert.equal(plain.status, 200, plain.body.error);
    assert.ok(Array.isArray(plain.body), "a plain array, as the Routine's timeline reads it");
    const rows = plain.body as unknown as Array<Record<string, unknown>>;
    assert.equal(rows.length, 50);
    assert.deepEqual(
      rows.map((row) => row.id),
      newestFirst(runs, (run) => run.startedAt)
        .slice(0, 50)
        .map((run) => run.id),
    );
    assert.ok(rows.some((row) => row.status === "running" || row.status === "queued"));
    assert.ok(rows.every((row) => "queuedAt" in row && !("logContent" in row)));
    assert.ok(rows.every((row) => !("checkpointJson" in row)), "the checkpoint never leaves");

    const failedOnly = await get(`/routines/${routine.id}/runs?status=failed`);
    const failed = failedOnly.body as unknown as Array<{ status: string }>;
    assert.ok(failed.length > 0 && failed.every((row) => row.status === "failed"));
  });

  test("pages every finished Run exactly once across ties, newest first", async () => {
    const all = await readAll(`/routines/${routine.id}/runs?limit=7`, "runs");
    assert.deepEqual(all.ids, finished().map((run) => run.id));
    assert.ok(all.pages.every((page) => page.total === finished().length));
    const first = all.pages[0].runs as Array<Record<string, unknown>>;
    assert.equal(first.length, 7);
    assert.ok(first.every((row) => "queuedAt" in row && !("logContent" in row)));
    assert.match(String(all.pages[0].note), /This page holds 7 of the \d+ matching Runs/);
  });

  test("filters by status and start date, alone and together, in both answers", async () => {
    const failed = runs.filter((run) => run.status === "failed");
    const byStatus = await get(`/routines/${routine.id}/runs?status=failed&limit=50`);
    assert.equal(byStatus.body.total, failed.length);
    // Minutes 0–9 of 2024-01-01 09:00 UTC: the first fifty inserted.
    const windowed = runs.filter(
      (run, i) => i < 50 && run.status !== "queued" && run.status !== "running",
    );
    const byDate = await get(
      `/routines/${routine.id}/runs?from=2024-01-01T09:00:00Z&to=2024-01-01T09:09:00Z&limit=50`,
    );
    assert.equal(byDate.status, 200, byDate.body.error);
    assert.equal(byDate.body.total, windowed.length);
    const both = await get(
      `/routines/${routine.id}/runs?status=failed&from=2024-01-01T09:00:00Z&to=2024-01-01T09:09:00Z&limit=50`,
    );
    assert.equal(both.body.total, windowed.filter((run) => run.status === "failed").length);
    const wholeDay = await get(`/routines/${routine.id}/runs?to=2024-01-01&limit=50`);
    assert.equal(wholeDay.body.total, finished().length, "a bare date is the whole UTC day");
    const nextDay = await get(`/routines/${routine.id}/runs?from=2024-01-02&limit=50`);
    assert.equal(nextDay.body.total, 0);
    const plainWindow = await get(
      `/routines/${routine.id}/runs?from=2024-01-01T09:00:00Z&to=2024-01-01T09:09:00Z`,
    );
    assert.equal((plainWindow.body as unknown as unknown[]).length, 50, "the plain list filters too");
  });

  test("never skips or repeats a Run when Runs finish, start or vanish between pages", async () => {
    const first = await get(`/routines/${routine.id}/runs?limit=10`);
    const seen = idsOf(first.body, "runs");
    const ordered = finished();
    const remaining = ordered.slice(10);
    // A Run deleted from the next page, a queued one far back that finishes,
    // and a brand-new Run at the very top.
    const vanished = remaining[0].id;
    await AppDataSource.getRepository(Run).delete({ id: vanished });
    const late = runs.find((run, i) => run.status === "queued" && i < 60)!;
    await AppDataSource.getRepository(Run).update({ id: late.id }, { status: "completed" });
    await insert(Run, {
      routineId: routine.id,
      employeeId: employee.id,
      startedAt: new Date(BASE + 3_600_000),
      finishedAt: new Date(BASE + 3_600_000),
      status: "completed",
      logContent: "",
    });
    let cursor = first.body.nextCursor!;
    for (let guard = 0; guard < 50; guard++) {
      const page = await get(`/routines/${routine.id}/runs?limit=10&cursor=${cursor}`);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...idsOf(page.body, "runs"));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assert.equal(new Set(seen).size, seen.length, "no Run twice");
    const expected = new Set([
      ...ordered.slice(0, 10).map((run) => run.id),
      ...remaining.map((run) => run.id).filter((id) => id !== vanished),
      late.id,
    ]);
    assert.deepEqual(new Set(seen), expected, "every Run behind the cursor, the late finisher too");
  });

  test("answers the list_runs AI tool's pages, and a cursor from one continues the other", async () => {
    const fromTool = await tool("list_runs", { routine: routine.id, limit: 7 });
    assert.equal(fromTool.status, 200, fromTool.body.error);
    const fromRest = await get(`/routines/${routine.id}/runs?limit=7`);
    assert.deepEqual(idsOf(fromRest.body, "runs"), idsOf(fromTool.body, "runs"));
    assert.equal(fromRest.body.total, fromTool.body.total);
    const restSecond = await get(
      `/routines/${routine.id}/runs?limit=7&cursor=${fromTool.body.nextCursor as string}`,
    );
    assert.equal(restSecond.status, 200, restSecond.body.error);
    const toolSecond = await tool("list_runs", {
      routine: routine.id,
      limit: 7,
      cursor: fromRest.body.nextCursor,
    });
    assert.equal(toolSecond.status, 200, toolSecond.body.error);
    assert.deepEqual(idsOf(restSecond.body, "runs"), idsOf(toolSecond.body, "runs"));
    assert.deepEqual(idsOf(restSecond.body, "runs"), finished().slice(7, 14).map((run) => run.id));

    // Filtered alike, too.
    const toolFailed = await tool("list_runs", { routine: routine.id, status: "failed", limit: 50 });
    const restFailed = await get(`/routines/${routine.id}/runs?status=failed&limit=50`);
    assert.deepEqual(idsOf(restFailed.body, "runs"), idsOf(toolFailed.body, "runs"));
  });

  test("refuses a cursor for another list, Routine, filter set or company, and clamps limit", async () => {
    const page = await get(`/routines/${routine.id}/runs?limit=5`);
    const cursor = page.body.nextCursor as string;
    const otherFilters = await get(`/routines/${routine.id}/runs?status=failed&cursor=${cursor}`);
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);

    const sibling = await insert(Routine, {
      employeeId: employee.id,
      name: "Weekly digest",
      slug: "weekly-digest",
      cronExpr: "0 8 * * 1",
      body: "",
    });
    const otherRoutine = await get(`/routines/${sibling.id}/runs?cursor=${cursor}`);
    assert.equal(otherRoutine.status, 400);
    assert.equal(otherRoutine.body.error, CURSOR_OTHER_FILTERS);

    await insertMany(
      Handoff,
      Array.from({ length: 3 }, (_, i) => ({
        id: randomUUID(),
        companyId: company.id,
        fromEmployeeId: colleague.id,
        toEmployeeId: employee.id,
        title: `Handoff ${i}`,
        body: "",
        status: "pending" as HandoffStatus,
      })),
    );
    const handoffCursor = (await get("/handoffs?limit=1")).body.nextCursor as string;
    const otherList = await get(`/routines/${routine.id}/runs?cursor=${handoffCursor}`);
    assert.equal(otherList.status, 400);
    assert.equal(otherList.body.error, CURSOR_OTHER_LIST);

    const garbled = await get(`/routines/${routine.id}/runs?cursor=not-a-cursor`);
    assert.equal(garbled.status, 400);
    assert.equal(garbled.body.error, CURSOR_INVALID);

    const clamped = await get(`/routines/${routine.id}/runs?limit=900`);
    assert.equal(clamped.status, 200, clamped.body.error);
    assert.equal((clamped.body.runs as unknown[]).length, 50, "a larger limit is cut to 50");
    assert.equal((await get(`/routines/${routine.id}/runs?status=queued&limit=5`)).status, 400);
    assert.equal((await get(`/routines/${routine.id}/runs?to=2024-02-30&limit=5`)).status, 400);
    assert.equal(
      (await get(`/routines/${routine.id}/runs?from=2024-02-02&to=2024-02-01`)).status,
      400,
      "a range that ends before it starts, in the plain answer too",
    );
  });

  test("reads as any Member may, and never across companies", async () => {
    const member = await createMemberOfNewCompany("owner");
    await AppDataSource.getRepository(Membership).insert({
      companyId: company.id,
      userId: member.user.id,
      role: "member",
    });
    const memberKey = (await mintTestApiKey(member.user.id, company.id)).token;
    const asMember = await get(`/routines/${routine.id}/runs?limit=5`, memberKey);
    assert.equal(asMember.status, 200, asMember.body.error);
    assert.equal(asMember.body.total, finished().length);

    const outsiderKey = (await mintTestApiKey(member.user.id, member.company.id)).token;
    const foreign = await get(`/routines/${routine.id}/runs?limit=5`, outsiderKey);
    assert.ok([401, 403, 404].includes(foreign.status), `another company's key (${foreign.status})`);
    const viaOwnCompany = await get(
      `/routines/${routine.id}/runs?limit=5`,
      outsiderKey,
      member.company.id,
    );
    assert.equal(viaOwnCompany.status, 404, "another company's Routine is not found");

    // A cursor is bound to its company as well as its filters.
    const theirRoutine = await insert(Routine, {
      employeeId: (
        await insert(AIEmployee, {
          companyId: member.company.id,
          name: "Theirs",
          slug: "theirs",
          role: "Operator",
          soulBody: "",
        })
      ).id,
      name: "Their digest",
      slug: "their-digest",
      cronExpr: "0 8 * * *",
      body: "",
    });
    for (let i = 0; i < 3; i++) {
      await insert(Run, {
        routineId: theirRoutine.id,
        startedAt: new Date(BASE + i * 1000),
        status: "completed",
        logContent: "",
      });
    }
    const theirCursor = (
      await get(`/routines/${theirRoutine.id}/runs?limit=1`, outsiderKey, member.company.id)
    ).body.nextCursor as string;
    const crossed = await get(`/routines/${routine.id}/runs?cursor=${theirCursor}`);
    assert.equal(crossed.status, 400);
    assert.equal(crossed.body.error, CURSOR_OTHER_FILTERS);
  });
});

// ───────────────────────────── Handoffs ─────────────────────────────

describe("GET /handoffs", () => {
  type HandoffRow = {
    id: string;
    fromEmployeeId: string;
    toEmployeeId: string;
    status: HandoffStatus;
    createdAt: Date;
  };
  let handoffs: HandoffRow[];
  const STATUSES: HandoffStatus[] = ["pending", "completed", "declined", "cancelled"];

  beforeEach(async () => {
    handoffs = [];
    const pairs = [
      [employee, colleague],
      [colleague, employee],
      [third, employee],
      [colleague, third],
      [third, colleague],
    ] as const;
    for (let i = 0; i < 240; i++) {
      const [from, to] = pairs[i % pairs.length];
      handoffs.push({
        id: randomUUID(),
        fromEmployeeId: from.id,
        toEmployeeId: to.id,
        status: STATUSES[Math.floor(i / 3) % STATUSES.length],
        // Four to an instant.
        createdAt: new Date(Date.UTC(2024, 2, 1) + Math.floor(i / 4) * 1000),
      });
    }
    await insertMany(
      Handoff,
      handoffs.map((row, i) => ({
        ...row,
        companyId: company.id,
        title: `Handoff ${i}`,
        body: "",
      })),
    );
  });

  const ordered = (rows: HandoffRow[]) => newestFirst(rows, (row) => row.createdAt);

  test("keeps its plain array of the newest 200 without a page", async () => {
    const plain = await get("/handoffs");
    assert.equal(plain.status, 200, plain.body.error);
    const rows = plain.body as unknown as Array<{
      id: string;
      from: { id: string } | null;
      to: { id: string } | null;
    }>;
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 200);
    assert.deepEqual(
      rows.map((row) => row.id),
      ordered(handoffs).slice(0, 200).map((row) => row.id),
    );
    assert.ok(rows.every((row) => row.from && row.to), "hydrated with both employees");
    const incoming = await get(`/handoffs?employeeId=${employee.id}&direction=incoming`);
    const incomingRows = incoming.body as unknown as Array<{ toEmployeeId: string }>;
    assert.equal(
      incomingRows.length,
      handoffs.filter((row) => row.toEmployeeId === employee.id).length,
    );
    assert.ok(incomingRows.every((row) => row.toEmployeeId === employee.id));
  });

  test("pages every handoff past the old cap of 200, ties included", async () => {
    const all = await readAll("/handoffs?limit=37", "handoffs");
    assert.deepEqual(all.ids, ordered(handoffs).map((row) => row.id));
    assert.ok(all.pages.every((page) => page.total === 240));
    const hydrated = all.pages[0].handoffs as Array<{ from: unknown; to: unknown }>;
    assert.ok(hydrated.every((row) => row.from && row.to), "the same rows as the plain list");
  });

  test("filters by employee, direction and status, alone and together", async () => {
    const mine = (row: HandoffRow) =>
      row.toEmployeeId === employee.id || row.fromEmployeeId === employee.id;
    const cases: Array<[string, HandoffRow[]]> = [
      [`employeeId=${employee.id}`, handoffs.filter(mine)],
      [
        `employeeId=${employee.id}&direction=incoming`,
        handoffs.filter((row) => row.toEmployeeId === employee.id),
      ],
      [
        `employeeId=${employee.id}&direction=outgoing`,
        handoffs.filter((row) => row.fromEmployeeId === employee.id),
      ],
      ["status=pending", handoffs.filter((row) => row.status === "pending")],
      ["status=all", handoffs],
      [
        `employeeId=${employee.id}&direction=incoming&status=declined`,
        handoffs.filter((row) => row.toEmployeeId === employee.id && row.status === "declined"),
      ],
      // Read as leniently as the route always read them.
      ["status=bogus", handoffs],
      [`employeeId=${employee.id}&direction=sideways`, handoffs.filter(mine)],
      ["direction=incoming", handoffs],
    ];
    for (const [query, expected] of cases) {
      const page = await readAll(`/handoffs?${query}&limit=50`, "handoffs");
      assert.deepEqual(page.ids, ordered(expected).map((row) => row.id), query);
      assert.equal(page.pages[0].total, expected.length, query);
    }
  });

  test("never skips a pending handoff when others are resolved between pages", async () => {
    const pending = ordered(handoffs.filter((row) => row.status === "pending"));
    const first = await get("/handoffs?status=pending&limit=10");
    const seen = idsOf(first.body, "handoffs");
    // Resolve one already shown and three not yet shown; delete another.
    const resolved = [pending[2].id, pending[15].id, pending[16].id, pending[30].id];
    await AppDataSource.getRepository(Handoff).update(resolved, { status: "completed" });
    await AppDataSource.getRepository(Handoff).delete({ id: pending[20].id });
    let cursor = first.body.nextCursor!;
    for (let guard = 0; guard < 20; guard++) {
      const page = await get(`/handoffs?status=pending&limit=10&cursor=${cursor}`);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...idsOf(page.body, "handoffs"));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    assert.equal(new Set(seen).size, seen.length, "none twice");
    const expected = pending
      .map((row) => row.id)
      .filter((id, index) => index < 10 || (!resolved.includes(id) && id !== pending[20].id));
    assert.deepEqual(seen, expected);
  });

  test("answers the list_handoffs AI tool's pages, and a cursor from one continues the other", async () => {
    const fromTool = await tool("list_handoffs", { limit: 5 });
    assert.equal(fromTool.status, 200, fromTool.body.error);
    const query = `employeeId=${employee.id}&direction=incoming&status=pending&limit=5`;
    const fromRest = await get(`/handoffs?${query}`);
    assert.deepEqual(idsOf(fromRest.body, "handoffs"), idsOf(fromTool.body, "handoffs"));
    assert.equal(fromRest.body.total, fromTool.body.total);
    const restSecond = await get(`/handoffs?${query}&cursor=${fromTool.body.nextCursor as string}`);
    assert.equal(restSecond.status, 200, restSecond.body.error);
    const toolSecond = await tool("list_handoffs", { limit: 5, cursor: fromRest.body.nextCursor });
    assert.equal(toolSecond.status, 200, toolSecond.body.error);
    assert.deepEqual(idsOf(restSecond.body, "handoffs"), idsOf(toolSecond.body, "handoffs"));

    const everything = await tool("list_handoffs", { direction: "any", status: "all", limit: 50 });
    const restEverything = await get(`/handoffs?employeeId=${employee.id}&limit=50`);
    assert.deepEqual(idsOf(restEverything.body, "handoffs"), idsOf(everything.body, "handoffs"));
    assert.equal(restEverything.body.total, everything.body.total);
  });

  test("refuses a cursor for other filters or another company, clamps limit, stays in its company", async () => {
    const page = await get("/handoffs?limit=5");
    const otherFilters = await get(`/handoffs?status=pending&cursor=${page.body.nextCursor as string}`);
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);
    const clamped = await get("/handoffs?limit=900");
    assert.equal((clamped.body.handoffs as unknown[]).length, 200, "a larger limit is cut to 200");
    assert.equal((await get("/handoffs?limit=0")).status, 400);

    const outsider = await createMemberOfNewCompany("owner");
    const outsiderKey = (await mintTestApiKey(outsider.user.id, outsider.company.id)).token;
    const [a, b] = await Promise.all(
      ["X", "Y"].map((name) =>
        insert(AIEmployee, {
          companyId: outsider.company.id,
          name,
          slug: name.toLowerCase(),
          role: "Operator",
          soulBody: "",
        }),
      ),
    );
    for (let i = 0; i < 3; i++) {
      await insert(Handoff, {
        companyId: outsider.company.id,
        fromEmployeeId: a.id,
        toEmployeeId: b.id,
        title: `Theirs ${i}`,
        body: "",
        status: "pending",
      });
    }
    const theirs = await get("/handoffs?limit=1", outsiderKey, outsider.company.id);
    assert.equal(theirs.body.total, 3);
    const crossed = await get(`/handoffs?limit=1&cursor=${theirs.body.nextCursor as string}`);
    assert.equal(crossed.status, 400);
    assert.equal(crossed.body.error, CURSOR_OTHER_FILTERS);
    const ours = await readAll("/handoffs?limit=100", "handoffs");
    assert.equal(ours.ids.length, 240, "their handoffs never appear in ours");
    const foreign = await get("/handoffs?limit=1", outsiderKey);
    assert.ok([401, 403, 404].includes(foreign.status), `another company's key (${foreign.status})`);
  });
});

// ─────────────────────────── A project's Todos ───────────────────────────

describe("GET /projects/:pSlug/todos", () => {
  let project: Project;
  type TodoRow = {
    id: string;
    sortOrder: number;
    createdAt: Date;
    status: TodoStatus;
    assigneeEmployeeId: string | null;
    assigneeUserId: string | null;
  };
  let todos: TodoRow[];
  const STATUSES: TodoStatus[] = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];

  beforeEach(async () => {
    project = await insert(Project, {
      companyId: company.id,
      name: "Launch",
      slug: "launch",
      description: "",
      key: "LA",
      createdById: null,
      todoCounter: 230,
      accessMode: "restricted",
    });
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "ai",
      userId: null,
      employeeId: employee.id,
      accessLevel: "read",
    });
    todos = [];
    for (let i = 0; i < 230; i++) {
      todos.push({
        id: randomUUID(),
        // Many share a sort key and an instant: the board's order still pages exactly.
        sortOrder: i % 4,
        createdAt: new Date(Date.UTC(2024, 3, 1) + Math.floor(i / 3) * 1000),
        status: STATUSES[i % STATUSES.length],
        assigneeEmployeeId: i % 5 === 0 ? employee.id : null,
        assigneeUserId: i % 5 !== 0 && i % 7 === 0 ? owner.id : null,
      });
    }
    await insertMany(
      Todo,
      todos.map((row, i) => ({
        ...row,
        projectId: project.id,
        number: i + 1,
        title: `Todo ${i}`,
        description: "x".repeat(400),
        priority: "none" as const,
      })),
    );
  });

  function boardOrder(rows: TodoRow[]): TodoRow[] {
    return [...rows].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }
  const open = (row: TodoRow) => row.status !== "done" && row.status !== "cancelled";

  test("keeps its plain answer — the project and every Todo in board order — without a page", async () => {
    const plain = await get("/projects/launch/todos");
    assert.equal(plain.status, 200, plain.body.error);
    assert.equal(
      (plain.body.project as { myAccessLevel: string }).myAccessLevel,
      "write",
      "an owner reaches every project",
    );
    assert.deepEqual(idsOf(plain.body, "todos"), boardOrder(todos).map((row) => row.id));
    assert.equal("total" in plain.body, false, "no page without limit or cursor");
    const doneOnly = await get("/projects/launch/todos?status=done");
    assert.deepEqual(
      idsOf(doneOnly.body, "todos"),
      boardOrder(todos.filter((row) => row.status === "done")).map((row) => row.id),
      "the plain answer filters too",
    );
  });

  test("pages every Todo exactly once in the board's order, with full rows", async () => {
    const all = await readAll("/projects/launch/todos?limit=45", "todos");
    assert.deepEqual(all.ids, boardOrder(todos).map((row) => row.id));
    for (const page of all.pages) {
      assert.equal(page.total, 230);
      assert.equal((page.project as { slug: string }).slug, "launch");
    }
    const first = all.pages[0].todos as Array<{ description: string; assignee: unknown }>;
    assert.ok(
      first.every((row) => row.description.length === 400),
      "a Member reads descriptions in full; only the AI tool previews them",
    );
  });

  test("filters by status and assignee, alone and together", async () => {
    const cases: Array<[string, TodoRow[]]> = [
      ["status=open", todos.filter(open)],
      ["status=done", todos.filter((row) => row.status === "done")],
      [`assigneeEmployeeId=${employee.id}`, todos.filter((row) => row.assigneeEmployeeId === employee.id)],
      [`assigneeUserId=${owner.id}`, todos.filter((row) => row.assigneeUserId === owner.id)],
      ["assignedToMe=true", todos.filter((row) => row.assigneeUserId === owner.id)],
      ["assignedToMe=false", todos],
      [
        `status=open&assigneeEmployeeId=${employee.id}`,
        todos.filter((row) => open(row) && row.assigneeEmployeeId === employee.id),
      ],
    ];
    for (const [query, expected] of cases) {
      const paged = await readAll(`/projects/launch/todos?${query}&limit=60`, "todos");
      assert.deepEqual(paged.ids, boardOrder(expected).map((row) => row.id), query);
      const plain = await get(`/projects/launch/todos?${query}`);
      assert.deepEqual(idsOf(plain.body, "todos"), paged.ids, `${query}, plain`);
    }
    assert.equal((await get("/projects/launch/todos?status=someday")).status, 400);
  });

  test("never skips open work when Todos are finished or deleted between pages", async () => {
    const openRows = boardOrder(todos.filter(open));
    const first = await get("/projects/launch/todos?status=open&limit=20");
    const seen = idsOf(first.body, "todos");
    const finished = [openRows[5].id, openRows[25].id, openRows[26].id];
    await AppDataSource.getRepository(Todo).update(finished, { status: "done" });
    await AppDataSource.getRepository(Todo).delete({ id: openRows[40].id });
    let cursor = first.body.nextCursor!;
    for (let guard = 0; guard < 20; guard++) {
      const page = await get(`/projects/launch/todos?status=open&limit=20&cursor=${cursor}`);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...idsOf(page.body, "todos"));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    const expected = openRows
      .map((row) => row.id)
      .filter((id, index) => index < 20 || (!finished.includes(id) && id !== openRows[40].id));
    assert.deepEqual(seen, expected);
  });

  test("answers the list_todos AI tool's pages, and a cursor from one continues the other", async () => {
    const fromTool = await tool("list_todos", {
      projectSlug: "launch",
      status: "open",
      assignedToMe: true,
      limit: 4,
    });
    assert.equal(fromTool.status, 200, fromTool.body.error);
    const query = `status=open&assigneeEmployeeId=${employee.id}&limit=4`;
    const fromRest = await get(`/projects/launch/todos?${query}`);
    assert.deepEqual(idsOf(fromRest.body, "todos"), idsOf(fromTool.body, "todos"));
    assert.equal(fromRest.body.total, fromTool.body.total);
    const restSecond = await get(
      `/projects/launch/todos?${query}&cursor=${fromTool.body.nextCursor as string}`,
    );
    assert.equal(restSecond.status, 200, restSecond.body.error);
    const toolSecond = await tool("list_todos", {
      projectSlug: "launch",
      status: "open",
      assignedToMe: true,
      limit: 4,
      cursor: fromRest.body.nextCursor,
    });
    assert.deepEqual(idsOf(restSecond.body, "todos"), idsOf(toolSecond.body, "todos"));
    const toolRows = toolSecond.body.todos as Array<{ descriptionTruncated?: boolean }>;
    assert.ok(toolRows.every((row) => row.descriptionTruncated), "the tool keeps its previews");
  });

  test("answers only those with access to the project, refuses another project's cursor, clamps limit", async () => {
    const member = await createMemberOfNewCompany("owner");
    await AppDataSource.getRepository(Membership).insert({
      companyId: company.id,
      userId: member.user.id,
      role: "member",
    });
    const memberKey = (await mintTestApiKey(member.user.id, company.id)).token;
    assert.equal((await get("/projects/launch/todos", memberKey)).status, 403);
    assert.equal((await get("/projects/launch/todos?limit=5", memberKey)).status, 403);
    await insert(ProjectMember, {
      projectId: project.id,
      memberKind: "user",
      userId: member.user.id,
      employeeId: null,
      accessLevel: "read",
    });
    const allowed = await get("/projects/launch/todos?limit=5", memberKey);
    assert.equal(allowed.status, 200, allowed.body.error);
    assert.equal((allowed.body.project as { myAccessLevel: string }).myAccessLevel, "read");

    const sibling = await insert(Project, {
      companyId: company.id,
      name: "Ops",
      slug: "ops",
      description: "",
      key: "OP",
      createdById: null,
      todoCounter: 0,
      accessMode: "open",
    });
    const cursor = (await get("/projects/launch/todos?limit=5")).body.nextCursor as string;
    const otherProject = await get(`/projects/${sibling.slug}/todos?cursor=${cursor}`);
    assert.equal(otherProject.status, 400);
    assert.equal(otherProject.body.error, CURSOR_OTHER_FILTERS);
    const otherFilters = await get(`/projects/launch/todos?status=done&cursor=${cursor}`);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);

    const clamped = await get("/projects/launch/todos?limit=900");
    assert.equal((clamped.body.todos as unknown[]).length, 200, "a larger limit is cut to 200");
    assert.equal(clamped.body.hasMore, true);

    const outsiderKey = (await mintTestApiKey(member.user.id, member.company.id)).token;
    const foreign = await get("/projects/launch/todos?limit=5", outsiderKey);
    assert.ok([401, 403, 404].includes(foreign.status), `another company's key (${foreign.status})`);
    assert.equal(
      (await get("/projects/launch/todos?limit=5", outsiderKey, member.company.id)).status,
      404,
      "another company's project is not found",
    );
  });
});

// ───────────────────────────── Meetings ─────────────────────────────

describe("GET /meetings", () => {
  let sales: CalendarAccount;
  let board: CalendarAccount;
  const customerId = randomUUID();
  const contactId = randomUUID();
  type MeetingRow = {
    id: string;
    accountId: string | null;
    scheduledStartAt: Date | null;
    createdAt: Date;
    status: MeetingStatus;
    customerId: string | null;
  };
  let meetings: MeetingRow[];
  let attended: Set<string>;

  beforeEach(async () => {
    const calendar = (address: string) =>
      insert(CalendarAccount, {
        companyId: company.id,
        connectionId: randomUUID(),
        calendarId: "primary",
        address,
        displayName: address,
        status: "active",
      });
    sales = await calendar("sales@example.test");
    board = await calendar("board@example.test");
    meetings = [];
    attended = new Set();
    for (let i = 0; i < 215; i++) {
      const adHoc = i % 10 === 0;
      meetings.push({
        id: randomUUID(),
        accountId: adHoc ? null : i % 2 ? sales.id : board.id,
        // Three to a scheduled hour; an ad-hoc meeting has no schedule.
        scheduledStartAt: adHoc ? null : new Date(Date.UTC(2024, 4, 1) + Math.floor(i / 3) * 3_600_000),
        createdAt: new Date(Date.UTC(2024, 4, 1) + i * 1_800_000),
        status: i % 4 === 0 ? "ready" : "scheduled",
        customerId: i % 6 === 0 ? customerId : null,
      });
    }
    await insertMany(
      Meeting,
      meetings.map((row, i) => ({ ...row, companyId: company.id, title: `Meeting ${i}` })),
    );
    for (const [index, row] of meetings.entries()) {
      if (index % 9 !== 0) continue;
      attended.add(row.id);
      await insert(MeetingParticipant, {
        companyId: company.id,
        meetingId: row.id,
        email: `guest${index}@client.test`,
        contactId,
      });
    }
  });

  const at = (row: MeetingRow) => row.scheduledStartAt ?? row.createdAt;
  const ordered = (rows: MeetingRow[]) => newestFirst(rows, at);

  test("keeps its plain answer — the newest 50 as { meetings } — without a page", async () => {
    const plain = await get("/meetings");
    assert.equal(plain.status, 200, plain.body.error);
    assert.deepEqual(Object.keys(plain.body), ["meetings"], "no page fields without limit or cursor");
    assert.deepEqual(idsOf(plain.body, "meetings"), ordered(meetings).slice(0, 50).map((row) => row.id));
    const ready = await get("/meetings?status=ready");
    const readyRows = ready.body.meetings as Array<{ status: string }>;
    assert.equal(readyRows.length, 50);
    assert.ok(readyRows.every((row) => row.status === "ready"), "the plain answer filters too");
  });

  test("pages every meeting on every calendar exactly once — a Member sees them all", async () => {
    const all = await readAll("/meetings?limit=17", "meetings");
    assert.deepEqual(all.ids, ordered(meetings).map((row) => row.id));
    assert.ok(all.pages.every((page) => page.total === 215 && !("hidden" in page)));
    // An older caller that sent limit alone reads its rows where it always did.
    const legacy = await get("/meetings?limit=10");
    assert.equal((legacy.body.meetings as unknown[]).length, 10);
    assert.equal(legacy.body.total, 215);
  });

  test("filters by status, account, Contact and schedule, alone and together", async () => {
    const window = (row: MeetingRow) =>
      row.scheduledStartAt !== null &&
      row.scheduledStartAt >= new Date(Date.UTC(2024, 4, 3)) &&
      row.scheduledStartAt < new Date(Date.UTC(2024, 4, 5));
    const cases: Array<[string, MeetingRow[]]> = [
      ["status=ready", meetings.filter((row) => row.status === "ready")],
      [`customerId=${customerId}`, meetings.filter((row) => row.customerId === customerId)],
      [`contactId=${contactId}`, meetings.filter((row) => attended.has(row.id))],
      ["from=2024-05-03&to=2024-05-04", meetings.filter(window)],
      [
        `status=scheduled&contactId=${contactId}&from=2024-05-03&to=2024-05-04`,
        meetings.filter((row) => row.status === "scheduled" && attended.has(row.id) && window(row)),
      ],
    ];
    for (const [query, expected] of cases) {
      const paged = await readAll(`/meetings?${query}&limit=40`, "meetings");
      assert.deepEqual(paged.ids, ordered(expected).map((row) => row.id), query);
      const plain = await get(`/meetings?${query}`);
      assert.deepEqual(
        idsOf(plain.body, "meetings"),
        ordered(expected).slice(0, 50).map((row) => row.id),
        `${query}, plain`,
      );
    }
    assert.equal((await get("/meetings?status=postponed")).status, 400);
    assert.equal((await get("/meetings?to=2024-02-30")).status, 400);
    assert.equal((await get("/meetings?contactId=not-a-uuid")).status, 400);
  });

  test("never skips a meeting when others change or vanish between pages", async () => {
    const scheduled = ordered(meetings.filter((row) => row.status === "scheduled"));
    const first = await get("/meetings?status=scheduled&limit=25");
    const seen = idsOf(first.body, "meetings");
    const changed = [scheduled[3].id, scheduled[40].id, scheduled[41].id];
    await AppDataSource.getRepository(Meeting).update(changed, { status: "ready" });
    await AppDataSource.getRepository(Meeting).delete({ id: scheduled[60].id });
    let cursor = first.body.nextCursor!;
    for (let guard = 0; guard < 20; guard++) {
      const page = await get(`/meetings?status=scheduled&limit=25&cursor=${cursor}`);
      assert.equal(page.status, 200, page.body.error);
      seen.push(...idsOf(page.body, "meetings"));
      if (!page.body.hasMore) break;
      cursor = page.body.nextCursor!;
    }
    const expected = scheduled
      .map((row) => row.id)
      .filter((id, index) => index < 25 || (!changed.includes(id) && id !== scheduled[60].id));
    assert.deepEqual(seen, expected);
  });

  test("reads the list_meetings AI tool's function: the same order, but an employee's calendars only", async () => {
    await insert(EmployeeCalendarGrant, {
      employeeId: employee.id,
      accountId: sales.id,
      accessLevel: "read",
    });
    const visible = meetings.filter((row) => row.accountId === null || row.accountId === sales.id);
    const fromTool = await tool("list_meetings", { limit: 30 });
    assert.equal(fromTool.status, 200, fromTool.body.error);
    assert.equal(fromTool.body.total, visible.length);
    assert.deepEqual(idsOf(fromTool.body, "meetings"), ordered(visible).slice(0, 30).map((row) => row.id));
    assert.match(String(fromTool.body.note), /on calendars you have no Grant to/);
    const fromRest = await get("/meetings?limit=30");
    assert.equal(fromRest.body.total, 215, "a Member sees every calendar");
    // Two lists, so a cursor from one is refused by the other rather than misread.
    const crossed = await get(`/meetings?limit=30&cursor=${fromTool.body.nextCursor as string}`);
    assert.equal(crossed.status, 400);
    assert.equal(crossed.body.error, CURSOR_OTHER_FILTERS);

    // With a Grant to every calendar the rows are the same, in the same order.
    await insert(EmployeeCalendarGrant, {
      employeeId: employee.id,
      accountId: board.id,
      accessLevel: "read",
    });
    const everything = await tool("list_meetings", { limit: 30 });
    assert.deepEqual(idsOf(everything.body, "meetings"), idsOf(fromRest.body, "meetings"));
  });

  test("clamps limit, refuses a cursor for other filters, and never crosses companies", async () => {
    const clamped = await get("/meetings?limit=900");
    assert.equal(clamped.status, 200, clamped.body.error);
    assert.equal((clamped.body.meetings as unknown[]).length, 200, "a larger limit is cut to 200");
    const otherFilters = await get(
      `/meetings?status=ready&cursor=${clamped.body.nextCursor as string}`,
    );
    assert.equal(otherFilters.status, 400);
    assert.equal(otherFilters.body.error, CURSOR_OTHER_FILTERS);

    const outsider = await createMemberOfNewCompany("owner");
    const outsiderKey = (await mintTestApiKey(outsider.user.id, outsider.company.id)).token;
    for (let i = 0; i < 3; i++) {
      await insert(Meeting, {
        companyId: outsider.company.id,
        title: `Theirs ${i}`,
        scheduledStartAt: new Date(Date.UTC(2030, 0, 1 + i)),
        status: "scheduled",
      });
    }
    const theirs = await get("/meetings?limit=1", outsiderKey, outsider.company.id);
    assert.equal(theirs.body.total, 3);
    const crossed = await get(`/meetings?limit=1&cursor=${theirs.body.nextCursor as string}`);
    assert.equal(crossed.body.error, CURSOR_OTHER_FILTERS);
    const ours = await get("/meetings?limit=5");
    assert.equal(ours.body.total, 215, "their meetings never appear in ours");
    const foreign = await get("/meetings?limit=1", outsiderKey);
    assert.ok([401, 403, 404].includes(foreign.status), `another company's key (${foreign.status})`);
  });
});

// ─────────────────────────── The API reference ───────────────────────────

test("the API reference documents each paged list's filters and how to read on", () => {
  const document = buildOpenApiDocument(app) as unknown as {
    paths: Record<
      string,
      Record<string, { parameters?: Array<{ name: string }>; description?: string }>
    >;
  };
  for (const [path, filters] of [
    ["/api/companies/{cid}/routines/{rid}/runs", ["status", "from", "to", "limit", "cursor"]],
    ["/api/companies/{cid}/handoffs", ["employeeId", "direction", "status", "limit", "cursor"]],
    [
      "/api/companies/{cid}/projects/{pSlug}/todos",
      ["status", "assignedToMe", "assigneeEmployeeId", "assigneeUserId", "limit", "cursor"],
    ],
    [
      "/api/companies/{cid}/meetings",
      ["status", "customerId", "contactId", "from", "to", "limit", "cursor"],
    ],
  ] as const) {
    const operation = document.paths[path]?.get;
    assert.ok(operation, `${path} is documented`);
    const names = (operation.parameters ?? []).map((parameter) => parameter.name);
    for (const filter of filters) assert.ok(names.includes(filter), `${path} documents ${filter}`);
    assert.match(operation.description ?? "", /nextCursor/, path);
    assert.match(operation.description ?? "", /AI tool reads/, path);
  }
});
