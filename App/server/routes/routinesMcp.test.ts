import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { STATIC_TOOLS } from "../mcp/toolManifest.js";
import { TOOL_RESULT_CAP_DEFAULT } from "../services/agent/contextBudget.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Getting hold of a Routine you can already see.
 *
 * The bug these cover: `list_routines` returned every routine's full brief, and
 * `services/agent/loop.ts` clips a whole tool result at `toolResultCap()` — as
 * little as 8k chars. A few long briefs pushed the JSON past the cap, it was cut
 * mid-array, and every routine after the cut lost its `id`. `update_routine`
 * accepted nothing but that `id`, so an employee could read a routine's schedule
 * off the screen and still have no way to edit it — and passing the slug it did
 * have was rejected as an invalid UUID before the lookup ran.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let colleague: AIEmployee;
let owner: User;

/** Comfortably longer than one clipped tool result, per routine. */
const LONG_BRIEF = "x".repeat(12_000);

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  owner = await insert(User, { email: "owner@example.test", name: "Owner", passwordHash: "x" });
  company = await insert(Company, {
    name: "Acme",
    slug: `routines-mcp-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Marketing",
    soulBody: "",
  });
  colleague = await insert(AIEmployee, {
    companyId: company.id,
    name: "Robin",
    slug: "robin",
    role: "Support",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function addRoutine(params: {
  employeeId?: string;
  name: string;
  slug: string;
  body?: string;
  cronExpr?: string;
}): Promise<Routine> {
  return insert(Routine, {
    employeeId: params.employeeId ?? employee.id,
    name: params.name,
    slug: params.slug,
    cronExpr: params.cronExpr ?? "15 15 * * *",
    enabled: true,
    body: params.body ?? "",
  });
}

type RoutineRow = {
  id: string;
  slug: string;
  name: string;
  cronExpr: string;
  briefPreview: string;
  briefChars: number;
  briefTruncated: boolean;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("list_routines stays readable however long the briefs are", () => {
  test("every routine keeps a whole id, and the payload fits one tool result", async () => {
    for (let i = 0; i < 8; i++) {
      await addRoutine({ name: `Routine ${i}`, slug: `routine-${i}`, body: LONG_BRIEF });
    }

    const { status, body } = await tool<{ routines: RoutineRow[] }>("list_routines");
    assert.equal(status, 200);
    assert.equal(body.routines.length, 8);

    // The regression: this JSON used to be ~96k, so the loop clipped it and the
    // tail of the array — ids included — never reached the model.
    assert.ok(
      JSON.stringify(body).length < TOOL_RESULT_CAP_DEFAULT,
      `listing is ${JSON.stringify(body).length} chars — a clipped result loses the ids at the end`,
    );
    for (const routine of body.routines) {
      assert.match(routine.id, UUID_RE, `${routine.slug} lost its id`);
      assert.equal(routine.briefChars, LONG_BRIEF.length);
      assert.equal(routine.briefTruncated, true);
    }
  });

  test("a short brief comes back whole and is not flagged truncated", async () => {
    await addRoutine({ name: "Standup", slug: "standup", body: "Post the standup digest." });
    const { body } = await tool<{ routines: RoutineRow[] }>("list_routines");
    assert.equal(body.routines[0].briefPreview, "Post the standup digest.");
    assert.equal(body.routines[0].briefTruncated, false);
  });
});

describe("get_routine serves the full brief the listing only previews", () => {
  test("by id, by slug, and by exact name", async () => {
    const routine = await addRoutine({
      name: "Daily Hacker News Comment Candidates",
      slug: "daily-hacker-news-comment-candidates",
      body: LONG_BRIEF,
    });

    for (const handle of [routine.id, routine.slug, routine.name]) {
      const { status, body } = await tool<{ routine: { id: string; brief: string } }>(
        "get_routine",
        { routineId: handle },
      );
      assert.equal(status, 200, `lookup by ${handle} failed`);
      assert.equal(body.routine.id, routine.id);
      assert.equal(body.routine.brief, LONG_BRIEF);
    }
  });

  test("a name that matches nothing says what is actually there", async () => {
    await addRoutine({ name: "Standup", slug: "standup" });
    const { status, body } = await tool<{ error: string }>("get_routine", {
      routineId: "no-such-routine",
    });
    assert.equal(status, 404);
    assert.match(body.error, /standup/);
  });
});

describe("update_routine takes the handle the employee actually has", () => {
  test("a slug from a tagged reference is enough to edit in place", async () => {
    const routine = await addRoutine({
      name: "Daily Hacker News Comment Candidates",
      slug: "daily-hacker-news-comment-candidates",
      body: "Post the top candidates.",
    });

    const { status, body } = await tool<{ routine: { id: string; brief: string } }>(
      "update_routine",
      {
        routineId: routine.slug,
        employeeSlug: "jamie",
        brief: "Raise a Decision for each candidate. Never post automatically.",
      },
    );

    assert.equal(status, 200);
    assert.equal(body.routine.id, routine.id);
    const saved = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.match(saved.body, /Never post automatically/);
  });

  test("the id still works, and pausing by name works too", async () => {
    const routine = await addRoutine({ name: "Weekly Report", slug: "weekly-report" });

    const byId = await tool("update_routine", { routineId: routine.id, cronExpr: "0 9 * * 1" });
    assert.equal(byId.status, 200);

    const byName = await tool("update_routine", { routineId: "Weekly Report", enabled: false });
    assert.equal(byName.status, 200);

    const saved = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id });
    assert.equal(saved.cronExpr, "0 9 * * 1");
    assert.equal(saved.enabled, false);
    assert.equal(saved.nextRunAt, null);
  });

  test("an ambiguous slug names the candidates instead of guessing", async () => {
    const mine = await addRoutine({ name: "Digest", slug: "digest" });
    const theirs = await addRoutine({
      employeeId: colleague.id,
      name: "Digest",
      slug: "digest",
    });

    const { status, body } = await tool<{ error: string }>("update_routine", {
      routineId: "digest",
      enabled: false,
    });
    assert.equal(status, 409);
    assert.match(body.error, new RegExp(mine.id));
    assert.match(body.error, new RegExp(theirs.id));
    assert.match(body.error, /employeeSlug/);

    // Nothing was touched while the ambiguity stood.
    for (const id of [mine.id, theirs.id]) {
      const saved = await AppDataSource.getRepository(Routine).findOneByOrFail({ id });
      assert.equal(saved.enabled, true);
    }

    const narrowed = await tool("update_routine", {
      routineId: "digest",
      employeeSlug: "robin",
      enabled: false,
    });
    assert.equal(narrowed.status, 200);
    const after = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: theirs.id });
    assert.equal(after.enabled, false);
  });
});

describe("a wider handle is not a wider authority", () => {
  test("another company's routine is unreachable by id and by slug alike", async () => {
    const otherOwner = await insert(User, {
      email: "other@example.test",
      name: "Other",
      passwordHash: "x",
    });
    const otherCo = await insert(Company, {
      name: "Rival",
      slug: `rival-${randomUUID()}`,
      ownerId: otherOwner.id,
    });
    const outsider = await insert(AIEmployee, {
      companyId: otherCo.id,
      name: "Sam",
      slug: "sam",
      role: "Ops",
      soulBody: "",
    });
    const foreign = await addRoutine({
      employeeId: outsider.id,
      name: "Their Digest",
      slug: "their-digest",
    });

    for (const handle of [foreign.id, foreign.slug, foreign.name]) {
      const read = await tool("get_routine", { routineId: handle });
      assert.equal(read.status, 404, `${handle} leaked through get_routine`);
      const write = await tool("update_routine", { routineId: handle, enabled: false });
      assert.equal(write.status, 404, `${handle} leaked through update_routine`);
      const removed = await tool("delete_routine", { routineId: handle });
      assert.equal(removed.status, 404, `${handle} leaked through delete_routine`);
    }

    const saved = await AppDataSource.getRepository(Routine).findOneByOrFail({ id: foreign.id });
    assert.equal(saved.enabled, true);
  });
});

describe("delete_routine", () => {
  test("accepts a slug and takes the routine with it", async () => {
    const routine = await addRoutine({ name: "Old Digest", slug: "old-digest" });
    const { status } = await tool("delete_routine", { routineId: "old-digest" });
    assert.equal(status, 200);
    assert.equal(await AppDataSource.getRepository(Routine).findOneBy({ id: routine.id }), null);
  });
});

describe("the routine tools are published", () => {
  test("get_routine reaches an MCP client, and the write tools advertise the wider handle", () => {
    const byName = new Map(STATIC_TOOLS.map((t) => [t.name, t]));
    assert.ok(byName.has("get_routine"), "get_routine is missing from the manifest");
    for (const name of ["update_routine", "delete_routine"]) {
      assert.match(
        byName.get(name)!.description,
        /`slug`/,
        `${name} still tells the model it needs a UUID`,
      );
    }
  });
});
