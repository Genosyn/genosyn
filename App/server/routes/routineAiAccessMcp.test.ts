import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { CompanyPolicy } from "../db/entities/CompanyPolicy.js";
import {
  EmployeeRoutineGrant,
  type RoutineAccessLevel,
} from "../db/entities/EmployeeRoutineGrant.js";
import { Initiative } from "../db/entities/Initiative.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { RevisionProposal } from "../db/entities/RevisionProposal.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineChatMessage } from "../db/entities/RoutineChatMessage.js";
import { RoutineFolder } from "../db/entities/RoutineFolder.js";
import { Run } from "../db/entities/Run.js";
import { Tag } from "../db/entities/Tag.js";
import { TagAssignment } from "../db/entities/TagAssignment.js";
import { User } from "../db/entities/User.js";
import { Workstream } from "../db/entities/Workstream.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { gatherEmployeeTools, RESIDENT_GENOSYN_TOOLS } from "../services/agent/tools/index.js";
import { issueMcpToken, markTokenTainted, revokeMcpToken } from "../services/mcpTokens.js";
import {
  ROUTINE_READ_TOOLS,
  ROUTINE_RUN_ONLY_ERROR,
  ROUTINE_SCHEDULE_TRIGGER_REFUSAL,
  ROUTINE_WRITE_TOOLS,
  routineOwnerRunOnlyError,
  setRoutineAccess,
} from "../services/routineAccess.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Routines → AI access at the seam that enforces it.
 *
 * Read + run (`run`) refuses every Routine write — `create_routine`,
 * `update_routine`, `delete_routine`, for the employee's own Routines and its
 * teammates' — and no AI Employee may write a read + run employee's Routines.
 * Read + write (`write`, the default) keeps today's behaviour exactly. This file
 * proves both halves for every Routine tool, that a refusal happens before any
 * side effect (no row, folder, tag, audit, journal, or held Approval), that
 * reading and running are untouched at every level, and that the human gates
 * — Revision proposals and Initiatives — stay open.
 */

/** A level as a test sets it. `null` = no row (never touched); anything else unknown is stored raw. */
type LevelState = RoutineAccessLevel | null | "superuser";

let server: Server;
let baseUrl = "";
const originalPort = config.port;
const tokens = new Set<string>();

let owner: User;
let company: Company;
/** The employee whose turn it is in most tests. */
let ada: AIEmployee;
/** A teammate whose Routines Ada can otherwise act on. */
let bob: AIEmployee;
let adaRoutine: Routine;
let bobRoutine: Routine;
let adaRun: Run;
let adaToken = "";

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  // The tool registry reaches the internal API over loopback on `config.port`.
  Object.assign(config, { port: (server.address() as AddressInfo).port });
  baseUrl = `http://127.0.0.1:${config.port}/api/internal/mcp`;
});

after(async () => {
  for (const issued of tokens) revokeMcpToken(issued);
  Object.assign(config, { port: originalPort });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

function issue(employee: AIEmployee, origin: Parameters<typeof issueMcpToken>[2] = {}): string {
  const issued = issueMcpToken(employee.id, company.id, { authority: "employee", ...origin });
  tokens.add(issued);
  return issued;
}

beforeEach(async () => {
  for (const issued of tokens) revokeMcpToken(issued);
  tokens.clear();
  await resetTestDb();
  owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `routine-ai-access-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Operations",
    soulBody: "",
  });
  bob = await insert(AIEmployee, {
    companyId: company.id,
    name: "Bob",
    slug: "bob",
    role: "Finance",
    soulBody: "",
  });
  adaRoutine = await insert(Routine, {
    employeeId: ada.id,
    name: "Weekly report",
    slug: "weekly-report",
    cronExpr: "0 9 * * 1",
    enabled: true,
    body: "Write the weekly report.",
  });
  bobRoutine = await insert(Routine, {
    employeeId: bob.id,
    name: "Month-end close",
    slug: "month-end-close",
    cronExpr: "0 9 1 * *",
    enabled: true,
    body: "Close the books.",
  });
  adaRun = await insert(Run, {
    routineId: adaRoutine.id,
    status: "completed",
    startedAt: new Date(Date.now() - 120_000),
    finishedAt: new Date(Date.now() - 60_000),
  });
  adaToken = issue(ada);
});

async function tool<T = Record<string, unknown>>(
  name: string,
  args: unknown = {},
  bearer = adaToken,
): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T & { error?: string },
  };
}

async function setLevel(employee: AIEmployee, state: LevelState): Promise<void> {
  const repo = AppDataSource.getRepository(EmployeeRoutineGrant);
  await repo.delete({ employeeId: employee.id });
  if (state === null) return;
  if (state === "superuser") {
    await repo.save(
      repo.create({
        companyId: company.id,
        employeeId: employee.id,
        accessLevel: "superuser" as RoutineAccessLevel,
      }),
    );
    return;
  }
  await setRoutineAccess(company.id, employee.id, state);
}

/** Everything a Routine write could touch, to prove a refusal touched none of it. */
async function worldSnapshot() {
  return {
    routines: await AppDataSource.getRepository(Routine).find({ order: { id: "ASC" } }),
    runs: await AppDataSource.getRepository(Run).count(),
    folders: await AppDataSource.getRepository(RoutineFolder).count(),
    tags: await AppDataSource.getRepository(Tag).count(),
    tagAssignments: await AppDataSource.getRepository(TagAssignment).count(),
    routineAudits: await AppDataSource.getRepository(AuditEvent).count({
      where: [
        { action: "routine.create" },
        { action: "routine.update" },
        { action: "routine.delete" },
      ],
    }),
    journal: await AppDataSource.getRepository(JournalEntry).count(),
    approvals: await AppDataSource.getRepository(Approval).count(),
  };
}

function assertRunOnlyRefusal(result: { status: number; body: { error?: string } }, what: string) {
  assert.equal(result.status, 403, `${what}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.error, ROUTINE_RUN_ONLY_ERROR, what);
}

/** One call for every kind of change `update_routine` can make. */
const UPDATE_KINDS: Array<[string, Record<string, unknown>]> = [
  ["rename", { name: "Weekly summary" }],
  ["re-schedule", { cronExpr: "0 10 * * 2" }],
  ["rewrite the brief", { brief: "Write a shorter report." }],
  ["pause", { enabled: false }],
  ["resume", { enabled: true }],
  ["retag", { tags: "finance, weekly" }],
  ["clear tags", { tags: "" }],
  ["re-file into a new folder", { folder: "Finance/Month-end" }],
  ["unfile", { folder: "" }],
  ["no change at all", {}],
];

// ───────────────────────────── reading ─────────────────────────────

describe("reading Routines and Runs never answers to the setting", () => {
  for (const state of [null, "write", "run", "superuser"] as LevelState[]) {
    test(`every read tool works for an employee whose access is ${String(state)}`, async () => {
      await setLevel(ada, state);
      await setLevel(bob, state);

      const own = await tool<{ routines: Array<{ id: string }> }>("list_routines");
      assert.equal(own.status, 200, own.body.error);
      assert.deepEqual(
        own.body.routines.map((r) => r.id),
        [adaRoutine.id],
      );
      const teammate = await tool<{ routines: Array<{ id: string }> }>("list_routines", {
        employeeSlug: "bob",
      });
      assert.equal(teammate.status, 200, teammate.body.error);
      assert.deepEqual(
        teammate.body.routines.map((r) => r.id),
        [bobRoutine.id],
      );

      const byId = await tool<{ routine: { brief: string } }>("get_routine", {
        routineId: adaRoutine.id,
      });
      assert.equal(byId.status, 200, byId.body.error);
      assert.equal(byId.body.routine.brief, adaRoutine.body);
      const bySlug = await tool<{ routine: { brief: string } }>("get_routine", {
        routineId: "month-end-close",
        employeeSlug: "bob",
      });
      assert.equal(bySlug.status, 200, bySlug.body.error);
      assert.equal(bySlug.body.routine.brief, bobRoutine.body);

      const runs = await tool<{ runs: Array<{ id: string }> }>("list_runs");
      assert.equal(runs.status, 200, runs.body.error);
      assert.deepEqual(
        runs.body.runs.map((run) => run.id),
        [adaRun.id],
      );
      const history = await tool<{ runs: Array<{ id: string }> }>("list_runs", {
        routine: adaRoutine.slug,
      });
      assert.equal(history.status, 200, history.body.error);
      const report = await tool<{ run: { id: string } }>("get_run_report", { runId: adaRun.id });
      assert.equal(report.status, 200, report.body.error);
    });
  }

  test("a read + run employee still reads a Routine it helped with, even a read + run teammate's", async () => {
    await setLevel(ada, "run");
    await setLevel(bob, "run");
    await insert(RoutineChatMessage, {
      companyId: company.id,
      employeeId: ada.id,
      routineId: bobRoutine.id,
      role: "assistant",
      status: "ok",
      content: "I clarified the close checklist.",
    });
    const detail = await tool<{ body: string; ownerName: string }>("get_participating_routine", {
      routineId: bobRoutine.id,
    });
    assert.equal(detail.status, 200, detail.body.error);
    assert.equal(detail.body.ownerName, "Bob");
    assert.equal(detail.body.body, bobRoutine.body);
  });

  test("the read tools this file covers are exactly the ones the service declares", () => {
    assert.deepEqual([...ROUTINE_READ_TOOLS].sort(), [
      "get_participating_routine",
      "get_routine",
      "get_run_report",
      "list_routines",
      "list_runs",
    ]);
  });
});

// ───────────────────────────── read + run ─────────────────────────────

describe("a read + run employee is refused every Routine write, before any side effect", () => {
  beforeEach(() => setLevel(ada, "run"));

  test("create_routine — its own, with tags and a new folder — writes nothing", async () => {
    const before = await worldSnapshot();
    assertRunOnlyRefusal(
      await tool("create_routine", {
        name: "Daily digest",
        cronExpr: "0 8 * * *",
        brief: "Summarize yesterday.",
        tags: "digest, daily",
        folder: "Reports/Daily",
      }),
      "create own",
    );
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("create_routine for a teammate is refused the same way", async () => {
    const before = await worldSnapshot();
    assertRunOnlyRefusal(
      await tool("create_routine", { employeeSlug: "bob", name: "Audit", cronExpr: "0 8 * * *" }),
      "create for teammate",
    );
    assert.deepEqual(await worldSnapshot(), before);
  });

  for (const [kind, change] of UPDATE_KINDS) {
    test(`update_routine refuses to ${kind} its own Routine`, async () => {
      const before = await worldSnapshot();
      assertRunOnlyRefusal(
        await tool("update_routine", { routineId: adaRoutine.id, ...change }),
        kind,
      );
      assert.deepEqual(await worldSnapshot(), before);
    });
  }

  test("update_routine on a teammate's Routine is refused, by id and by slug", async () => {
    const before = await worldSnapshot();
    assertRunOnlyRefusal(
      await tool("update_routine", { routineId: bobRoutine.id, enabled: false }),
      "teammate by id",
    );
    assertRunOnlyRefusal(
      await tool("update_routine", {
        routineId: "month-end-close",
        employeeSlug: "bob",
        cronExpr: "0 12 * * *",
      }),
      "teammate by slug",
    );
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("delete_routine keeps the Routine and its Run history, its own or a teammate's", async () => {
    const before = await worldSnapshot();
    assertRunOnlyRefusal(await tool("delete_routine", { routineId: adaRoutine.id }), "own");
    assertRunOnlyRefusal(await tool("delete_routine", { routineId: "Weekly report" }), "by name");
    assertRunOnlyRefusal(await tool("delete_routine", { routineId: bobRoutine.id }), "teammate");
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("the refusal comes before the Routine is looked up", async () => {
    // An unknown handle answers with the access refusal, not a 404 that would
    // invite the model to go looking for the right one.
    assertRunOnlyRefusal(
      await tool("update_routine", { routineId: randomUUID(), name: "x" }),
      "unknown id",
    );
    assertRunOnlyRefusal(
      await tool("delete_routine", { routineId: "no-such-routine" }),
      "unknown slug",
    );
    assertRunOnlyRefusal(
      await tool("create_routine", { employeeSlug: "nobody", name: "x", cronExpr: "0 8 * * *" }),
      "unknown employee",
    );
  });

  test("the refusal comes before validation, so a malformed call is not worth fixing", async () => {
    assertRunOnlyRefusal(
      await tool("create_routine", { name: "Bad", cronExpr: "every tuesday" }),
      "bad cron",
    );
    assertRunOnlyRefusal(
      await tool("update_routine", { routineId: adaRoutine.id, junk: 1 }),
      "extra key",
    );
    assertRunOnlyRefusal(await tool("delete_routine", {}), "missing id");
  });

  test("an unrecognized stored level is refused exactly like read + run", async () => {
    await setLevel(ada, "superuser");
    const before = await worldSnapshot();
    assertRunOnlyRefusal(
      await tool("create_routine", { name: "Digest", cronExpr: "0 8 * * *" }),
      "create",
    );
    assertRunOnlyRefusal(
      await tool("update_routine", { routineId: adaRoutine.id, enabled: false }),
      "update",
    );
    assertRunOnlyRefusal(await tool("delete_routine", { routineId: adaRoutine.id }), "delete");
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("the setting is per employee: a read + write teammate is unaffected", async () => {
    const bobToken = issue(bob);
    const created = await tool<{ routine: { id: string } }>(
      "create_routine",
      { name: "Payables", cronExpr: "0 9 * * 5" },
      bobToken,
    );
    assert.equal(created.status, 200, created.body.error);
    const updated = await tool(
      "update_routine",
      { routineId: bobRoutine.id, name: "Close the month" },
      bobToken,
    );
    assert.equal(updated.status, 200, updated.body.error);
  });

  test("a path variant the middleware's exact-name match misses still meets the rule in the handler", async () => {
    // Express routes case-insensitively and forgives a trailing slash; the
    // early gate keys on the exact tool name. Each handler asks again.
    const before = await worldSnapshot();
    for (const [path, args] of [
      ["CREATE_ROUTINE", { name: "Digest", cronExpr: "0 8 * * *" }],
      ["update_routine/", { routineId: adaRoutine.id, enabled: false }],
      ["Delete_Routine", { routineId: adaRoutine.id }],
    ] as Array<[string, Record<string, unknown>]>) {
      const response = await fetch(`${baseUrl}/tools/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adaToken}` },
        body: JSON.stringify(args),
      });
      const body = (await response.json()) as { error?: string };
      assertRunOnlyRefusal({ status: response.status, body }, path);
    }
    await setLevel(ada, "write");
    await setLevel(bob, "run");
    const teammate = await fetch(`${baseUrl}/tools/UPDATE_ROUTINE`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adaToken}` },
      body: JSON.stringify({ routineId: bobRoutine.id, enabled: false }),
    });
    assert.equal(teammate.status, 403);
    assert.equal(
      ((await teammate.json()) as { error?: string }).error,
      routineOwnerRunOnlyError("Bob"),
    );
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("every Routine writer is covered — none slipped through unrefused", async () => {
    assert.deepEqual([...ROUTINE_WRITE_TOOLS].sort(), [
      "create_routine",
      "delete_routine",
      "update_routine",
    ]);
  });
});

// ───────────────────────────── read + write ─────────────────────────────

describe("read + write keeps today's behaviour", () => {
  for (const state of [null, "write"] as LevelState[]) {
    test(`with access ${String(state)}, the employee creates, edits, pauses, re-files, and deletes`, async () => {
      await setLevel(ada, state);
      const created = await tool<{
        routine: { id: string; folder: string | null; tags: string[] };
      }>("create_routine", {
        name: "Daily digest",
        cronExpr: "0 8 * * *",
        tags: "digest",
        folder: "Reports/Daily",
      });
      assert.equal(created.status, 200, created.body.error);
      assert.equal(created.body.routine.folder, "Reports/Daily");
      assert.deepEqual(created.body.routine.tags, ["digest"]);
      const id = created.body.routine.id;

      for (const [kind, change] of UPDATE_KINDS) {
        const updated = await tool("update_routine", { routineId: id, ...change });
        assert.equal(updated.status, 200, `${kind}: ${updated.body.error}`);
      }
      const stored = await AppDataSource.getRepository(Routine).findOneByOrFail({ id });
      assert.equal(stored.name, "Weekly summary");
      assert.equal(stored.cronExpr, "0 10 * * 2");
      assert.equal(stored.enabled, true);

      const removed = await tool("delete_routine", { routineId: id });
      assert.equal(removed.status, 200, removed.body.error);
      assert.equal(await AppDataSource.getRepository(Routine).countBy({ id }), 0);
      assert.ok(
        (await AppDataSource.getRepository(AuditEvent).countBy({ action: "routine.create" })) >= 1,
      );
    });
  }

  test("a read + write employee still manages a read + write teammate's Routines", async () => {
    const created = await tool<{ routine: { id: string } }>("create_routine", {
      employeeSlug: "bob",
      name: "Payables",
      cronExpr: "0 9 * * 5",
    });
    assert.equal(created.status, 200, created.body.error);
    const updated = await tool("update_routine", { routineId: bobRoutine.id, enabled: false });
    assert.equal(updated.status, 200, updated.body.error);
    const removed = await tool("delete_routine", { routineId: created.body.routine.id });
    assert.equal(removed.status, 200, removed.body.error);
  });
});

// ─────────────────────── a read + run employee's Routines ───────────────────────

describe("a read + run employee's Routines are closed to every AI Employee", () => {
  beforeEach(() => setLevel(bob, "run"));

  function assertOwnerRefusal(result: { status: number; body: { error?: string } }, what: string) {
    assert.equal(result.status, 403, `${what}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.error, routineOwnerRunOnlyError("Bob"), what);
  }

  test("a read + write teammate cannot create, edit, or delete them", async () => {
    const before = await worldSnapshot();
    assertOwnerRefusal(
      await tool("create_routine", { employeeSlug: "bob", name: "Audit", cronExpr: "0 8 * * *" }),
      "create for Bob",
    );
    assertOwnerRefusal(
      await tool("update_routine", { routineId: bobRoutine.id, enabled: false }),
      "pause by id",
    );
    assertOwnerRefusal(
      await tool("update_routine", {
        routineId: "month-end-close",
        employeeSlug: "bob",
        brief: "Rewritten.",
      }),
      "rewrite by slug",
    );
    assertOwnerRefusal(await tool("delete_routine", { routineId: bobRoutine.id }), "delete");
    assert.deepEqual(await worldSnapshot(), before);
  });

  test("the teammate's own Routines are untouched by it", async () => {
    const updated = await tool("update_routine", {
      routineId: adaRoutine.id,
      name: "Weekly summary",
    });
    assert.equal(updated.status, 200, updated.body.error);
    const created = await tool("create_routine", { name: "Daily digest", cronExpr: "0 8 * * *" });
    assert.equal(created.status, 200, created.body.error);
  });

  test("a handle the handler would reject is still answered the way it always was", async () => {
    // Same name on both employees: ambiguity is reported, not guessed at.
    await insert(Routine, {
      employeeId: ada.id,
      name: "Month-end close",
      slug: "month-end-close",
      cronExpr: "0 9 1 * *",
      enabled: true,
      body: "",
    });
    const ambiguous = await tool("update_routine", {
      routineId: "Month-end close",
      enabled: false,
    });
    assert.equal(ambiguous.status, 409, ambiguous.body.error);
    const unknown = await tool("delete_routine", { routineId: randomUUID() });
    assert.equal(unknown.status, 404, unknown.body.error);
    // Narrowed to Ada's own, the same handle is hers to change.
    const own = await tool("update_routine", {
      routineId: "month-end-close",
      employeeSlug: "ada",
      enabled: false,
    });
    assert.equal(own.status, 200, own.body.error);
  });

  test("restoring the owner to read + write opens its Routines again", async () => {
    await setLevel(bob, "write");
    const updated = await tool("update_routine", { routineId: bobRoutine.id, enabled: false });
    assert.equal(updated.status, 200, updated.body.error);
  });

  test("an unknown stored level protects the owner like read + run", async () => {
    await setLevel(bob, "superuser");
    assertOwnerRefusal(
      await tool("update_routine", { routineId: bobRoutine.id, enabled: false }),
      "unknown level",
    );
  });
});

// ─────────────────────── human gates stay open ───────────────────────

describe("suggesting a change stays open at read + run — a human applies it", () => {
  beforeEach(() => setLevel(ada, "run"));

  test("propose_revision stages a brief and criteria change without touching the Routine", async () => {
    const brief = await tool<{ proposal: { id: string } }>("propose_revision", {
      kind: "routine_body",
      target: adaRoutine.id,
      proposedBody: "Write a shorter weekly report.",
      rationale: "The last report ran long.",
      evidenceRunIds: [adaRun.id],
    });
    assert.equal(brief.status, 200, brief.body.error);
    const criteria = await tool("propose_revision", {
      kind: "routine_criteria",
      target: "weekly-report",
      proposedBody: "The report is posted by Monday noon.",
      rationale: "Make done checkable.",
    });
    assert.equal(criteria.status, 200, criteria.body.error);
    assert.deepEqual(
      (await AppDataSource.getRepository(RevisionProposal).find())
        .map((p) => [p.kind, p.status])
        .sort(),
      [
        ["routine_body", "pending"],
        ["routine_criteria", "pending"],
      ],
    );
    const stored = await AppDataSource.getRepository(Routine).findOneByOrFail({
      id: adaRoutine.id,
    });
    assert.equal(stored.body, adaRoutine.body);
    assert.equal(stored.acceptanceCriteria, "");
  });

  test("a brief suggestion for a read + run teammate's Routine it helped with is still a proposal", async () => {
    await setLevel(bob, "run");
    await insert(RoutineChatMessage, {
      companyId: company.id,
      employeeId: ada.id,
      routineId: bobRoutine.id,
      role: "assistant",
      status: "ok",
      content: "I clarified the close checklist.",
    });
    const staged = await tool("propose_revision", {
      kind: "routine_body",
      target: bobRoutine.id,
      proposedBody: "Close the books and reconcile every account.",
      rationale: "The checklist missed reconciliation.",
    });
    assert.equal(staged.status, 200, staged.body.error);
    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: bobRoutine.id })).body,
      bobRoutine.body,
    );
  });

  test("propose_initiative suggests new standing work without creating a Routine", async () => {
    const before = await AppDataSource.getRepository(Routine).count();
    const proposed = await tool("propose_initiative", {
      title: "Chase overdue invoices",
      evidence: "Twelve invoices went past due last month with no follow-up.",
      proposal: "A weekly sweep that drafts reminders.",
      routine: {
        name: "Overdue invoice sweep",
        cronExpr: "0 9 * * 1",
        body: "Find overdue invoices and draft reminders.",
      },
    });
    assert.equal(proposed.status, 200, proposed.body.error);
    assert.equal(await AppDataSource.getRepository(Initiative).countBy({ status: "pending" }), 1);
    assert.equal(await AppDataSource.getRepository(Routine).count(), before);
  });

  test("a Workstream can still be bound to its own Routine — that is running it, not editing it", async () => {
    const created = await tool<{ workstream: { routineId: string } }>("create_workstream", {
      title: "Report backlog",
      routineId: adaRoutine.id,
    });
    assert.equal(created.status, 200, created.body.error);
    assert.equal(created.body.workstream.routineId, adaRoutine.id);
    assert.equal(await AppDataSource.getRepository(Workstream).count(), 1);
  });
});

// ─────────────────────── running a Routine ───────────────────────

describe("running a Routine is untouched by read + run", () => {
  test("the Run reports progress and failure exactly as before", async () => {
    await setLevel(ada, "run");
    const running = await insert(Run, {
      routineId: adaRoutine.id,
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
    });
    const runToken = issue(ada, { runId: running.id, routineId: adaRoutine.id });
    const checkpoint = await tool(
      "save_run_checkpoint",
      {
        state: "continue",
        completed: "Drafted the summary.",
        remaining: "Charts.",
        resume: "Add the charts.",
        progressKey: "summary",
      },
      runToken,
    );
    assert.equal(checkpoint.status, 200, checkpoint.body.error);
    const failed = await tool("mark_run_failed", { reason: "The data source was down." }, runToken);
    assert.equal(failed.status, 200, failed.body.error);
    const stored = await AppDataSource.getRepository(Run).findOneByOrFail({ id: running.id });
    assert.equal(stored.failureReason, "The data source was down.");
    // …and the Run's own token is refused a Routine write like any other.
    assertRunOnlyRefusal(
      await tool("update_routine", { routineId: adaRoutine.id, enabled: false }, runToken),
      "from inside the Run",
    );
  });
});

// ─────────────────────── whoever drives the turn ───────────────────────

describe("a Member driving the turn cannot lend write access", () => {
  async function memberToken(role: "owner" | "member"): Promise<string> {
    const human =
      role === "owner"
        ? owner
        : await insert(User, {
            email: `member-${randomUUID()}@example.test`,
            name: "Member",
            passwordHash: "x",
            sessionVersion: 0,
          });
    if (role === "member") {
      await insert(Membership, { companyId: company.id, userId: human.id, role: "member" });
    }
    const issued = issueMcpToken(ada.id, company.id, {
      authority: "member",
      requesterUserId: human.id,
      requesterSessionVersion: 0,
    });
    tokens.add(issued);
    return issued;
  }

  test("an owner's chat with a read + run employee is still refused every write", async () => {
    await setLevel(ada, "run");
    const delegated = await memberToken("owner");
    const before = await worldSnapshot();
    assertRunOnlyRefusal(
      await tool("create_routine", { name: "Digest", cronExpr: "0 8 * * *" }, delegated),
      "create",
    );
    assertRunOnlyRefusal(
      await tool("update_routine", { routineId: adaRoutine.id, enabled: false }, delegated),
      "update",
    );
    assertRunOnlyRefusal(
      await tool("delete_routine", { routineId: adaRoutine.id }, delegated),
      "delete",
    );
    assert.deepEqual(await worldSnapshot(), before);
    const read = await tool("get_routine", { routineId: adaRoutine.id }, delegated);
    assert.equal(read.status, 200, read.body.error);
  });

  test("the same owner's chat may write when the employee holds read + write", async () => {
    const delegated = await memberToken("owner");
    const created = await tool(
      "create_routine",
      { name: "Digest", cronExpr: "0 8 * * *" },
      delegated,
    );
    assert.equal(created.status, 200, created.body.error);
  });

  test("a plain Member's chat is refused Routine writes at either level, as before", async () => {
    const delegated = await memberToken("member");
    for (const state of ["write", "run"] as LevelState[]) {
      await setLevel(ada, state);
      const refused = await tool(
        "create_routine",
        { name: "Digest", cronExpr: "0 8 * * *" },
        delegated,
      );
      assert.equal(refused.status, 403);
      assert.match(refused.body.error ?? "", /owner or admin must delegate/);
    }
  });
});

// ─────────────────────── ahead of the taint gate ───────────────────────

describe("a refusal is never held for a human", () => {
  test("a tainted read + run turn is refused outright, with no Approval queued", async () => {
    await setLevel(ada, "run");
    markTokenTainted(adaToken);
    const before = await worldSnapshot();
    assertRunOnlyRefusal(
      await tool("create_routine", { name: "Digest", cronExpr: "0 8 * * *" }),
      "tainted create",
    );
    assertRunOnlyRefusal(
      await tool("update_routine", { routineId: adaRoutine.id, enabled: false }),
      "tainted update",
    );
    assert.deepEqual(await worldSnapshot(), before);
    assert.equal(await AppDataSource.getRepository(Approval).count(), 0);
  });

  test("a tainted read + write turn is still held for approval, exactly as before", async () => {
    markTokenTainted(adaToken);
    const held = await tool<{ status: string; approvalId: string }>("create_routine", {
      name: "Digest",
      cronExpr: "0 8 * * *",
    });
    assert.equal(held.status, 200, held.body.error);
    assert.equal(held.body.status, "pending_approval");
    const approval = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: held.body.approvalId,
    });
    assert.equal(approval.kind, "tainted_tool");
    assert.equal(await AppDataSource.getRepository(Routine).countBy({ name: "Digest" }), 0);
  });

  test("a tainted write aimed at a read + run teammate's Routine is refused, not held", async () => {
    await setLevel(bob, "run");
    markTokenTainted(adaToken);
    const result = await tool("delete_routine", { routineId: bobRoutine.id });
    assert.equal(result.status, 403);
    assert.equal(result.body.error, routineOwnerRunOnlyError("Bob"));
    assert.equal(await AppDataSource.getRepository(Approval).count(), 0);
    assert.equal(await AppDataSource.getRepository(Routine).countBy({ id: bobRoutine.id }), 1);
  });
});

describe("a company Policy still speaks first", () => {
  test("a Policy forbidding the tool refuses and records the violation before the setting is read", async () => {
    await setLevel(ada, "run");
    const policy = await insert(CompanyPolicy, {
      companyId: company.id,
      title: "No new schedules",
      body: "",
      forbiddenTools: "create_routine",
    });
    const result = await tool("create_routine", { name: "Digest", cronExpr: "0 8 * * *" });
    assert.equal(result.status, 403);
    assert.match(
      result.body.error ?? "",
      /company policy "No new schedules" forbids create_routine/,
    );
    const violation = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "policy.violation",
    });
    assert.equal(violation.targetId, policy.id);
    assert.equal(violation.actorEmployeeId, ada.id);
  });
});

// ─────────────────────── Pipelines ───────────────────────

describe("a schedule trigger is recurring work, so read + run cannot author one", () => {
  const scheduleGraph = {
    nodes: [
      { id: "t", type: "trigger.schedule", config: { cronExpr: "0 9 * * 1-5" } },
      {
        id: "ask",
        type: "action.askEmployee",
        config: { employeeSlug: "ada", message: "Report." },
      },
    ],
    edges: [{ id: "e0", fromNodeId: "t", toNodeId: "ask" }],
  };
  const manualGraph = {
    nodes: [
      { id: "t", type: "trigger.manual" },
      {
        id: "ask",
        type: "action.askEmployee",
        config: { employeeSlug: "ada", message: "Report." },
      },
    ],
    edges: [{ id: "e0", fromNodeId: "t", toNodeId: "ask" }],
  };

  test("create_pipeline with a schedule is refused at read + run and nothing is saved", async () => {
    await setLevel(ada, "run");
    const refused = await tool<{ refusedSteps: Array<{ nodeId: string; reason: string }> }>(
      "create_pipeline",
      { name: "Daily self-report", graph: scheduleGraph },
    );
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.deepEqual(refused.body.refusedSteps, [
      { nodeId: "t", nodeType: "trigger.schedule", reason: ROUTINE_SCHEDULE_TRIGGER_REFUSAL },
    ]);
    const starter = await tool("create_pipeline", { name: "Starter", startWith: "schedule" });
    assert.equal(starter.status, 403, JSON.stringify(starter.body));
    assert.equal(await AppDataSource.getRepository(Pipeline).count(), 0);
  });

  test("a manual pipeline is still the employee's to build at read + run", async () => {
    await setLevel(ada, "run");
    const built = await tool("create_pipeline", { name: "On demand report", graph: manualGraph });
    assert.equal(built.status, 200, JSON.stringify(built.body));
  });

  test("read + write builds the scheduled pipeline as before", async () => {
    const built = await tool<{ pipeline: { cronExpr: string } }>("create_pipeline", {
      name: "Daily self-report",
      graph: scheduleGraph,
    });
    assert.equal(built.status, 200, JSON.stringify(built.body));
    assert.equal(built.body.pipeline.cronExpr, "0 9 * * 1-5");
  });

  test("a read + run employee cannot resume or fire a scheduled pipeline a human built", async () => {
    const paused = await insert(Pipeline, {
      companyId: company.id,
      name: "Paused schedule",
      slug: "paused-schedule",
      enabled: false,
      graphJson: JSON.stringify(scheduleGraph),
      cronExpr: "0 9 * * 1-5",
    });
    const live = await insert(Pipeline, {
      companyId: company.id,
      name: "Live schedule",
      slug: "live-schedule",
      enabled: true,
      graphJson: JSON.stringify(scheduleGraph),
      cronExpr: "0 9 * * 1-5",
    });
    await setLevel(ada, "run");
    // Resuming lets the schedule fire again: re-scheduling recurring work.
    const resumed = await tool("update_pipeline", { pipelineId: paused.id, enabled: true });
    assert.equal(resumed.status, 403, JSON.stringify(resumed.body));
    assert.equal(
      (await AppDataSource.getRepository(Pipeline).findOneByOrFail({ id: paused.id })).enabled,
      false,
    );
    // Pipelines answer to one rule: an employee touches only what it could
    // have built outright, and that now excludes a schedule.
    const fired = await tool<{ refusedSteps: Array<{ nodeType: string }> }>("run_pipeline", {
      pipelineId: live.id,
    });
    assert.equal(fired.status, 403, JSON.stringify(fired.body));
    assert.deepEqual(
      fired.body.refusedSteps.map((step) => step.nodeType),
      ["trigger.schedule"],
    );
  });

  test("the step catalogue says so before the employee tries", async () => {
    const types = await tool<{ stepTypes: Array<{ type: string; authoringNote?: string }> }>(
      "list_pipeline_node_types",
    );
    assert.equal(types.status, 200, types.body.error);
    const schedule = types.body.stepTypes.find((entry) => entry.type === "trigger.schedule");
    assert.match(schedule?.authoringNote ?? "", /Routines → AI access/);
  });
});

// ─────────────────────── what the model is shown ───────────────────────

describe("find_tools and the working set see the level", () => {
  const ALL_ROUTINE_TOOLS = [...ROUTINE_READ_TOOLS, ...ROUTINE_WRITE_TOOLS];

  for (const [state, expectedDead] of [
    [null, []],
    ["write", []],
    ["run", [...ROUTINE_WRITE_TOOLS]],
    // An unknown level stays live as a ranking hint; the seam refuses it anyway.
    ["superuser", []],
  ] as Array<[LevelState, string[]]>) {
    test(`access ${String(state)} marks exactly ${JSON.stringify(expectedDead)} dead`, async () => {
      await setLevel(ada, state);
      for (const strict of [false, true]) {
        const dead = await deadToolNames(ada.id, strict);
        assert.deepEqual(
          ALL_ROUTINE_TOOLS.filter((name) => dead.has(name)),
          expectedDead,
          `strict=${strict}`,
        );
      }
      const bobDead = await deadToolNames(bob.id);
      assert.deepEqual(
        ALL_ROUTINE_TOOLS.filter((name) => bobDead.has(name)),
        [],
        "a teammate is never affected",
      );
    });
  }

  async function gathered(employee: AIEmployee) {
    return gatherEmployeeTools({
      employeeId: employee.id,
      genosynToken: issue(employee),
      cwd: "/unused-routine-access-test",
      toolEnv: {},
      bashTimeoutMs: 1000,
      allowPrivilegedToolSources: false,
    });
  }

  test("read + write keeps the Routine writers resident, as today", async () => {
    for (const name of ROUTINE_WRITE_TOOLS) assert.ok(RESIDENT_GENOSYN_TOOLS.includes(name));
    const tools = await gathered(ada);
    try {
      for (const name of ROUTINE_WRITE_TOOLS) {
        assert.equal(tools.registry.visibility(name), "resident", name);
      }
    } finally {
      await tools.close();
    }
  });

  test("read + run moves the writers out of every step's working set, still one lookup away", async () => {
    await setLevel(ada, "run");
    const tools = await gathered(ada);
    try {
      for (const name of ROUTINE_WRITE_TOOLS) {
        assert.equal(tools.registry.visibility(name), "deferred", name);
        assert.ok(tools.registry.resolve(name), `${name} still resolves through call_tool`);
        assert.ok(
          tools.registry.searchable.some((entry) => entry.name === name),
          name,
        );
      }
      assert.equal(
        tools.registry.visibility("list_routines"),
        "resident",
        "reading stays resident",
      );

      // find_tools tells the model before it spends a call.
      const findTools = tools.registry.resolve("find_tools");
      assert.ok(findTools, "find_tools is available");
      const found = await findTools.run({ domain: "routines" });
      for (const name of ROUTINE_WRITE_TOOLS) {
        const section = found.content.split("### ").find((entry) => entry.startsWith(`${name}\n`));
        assert.ok(section, `${name} is listed`);
        assert.match(section, /you hold no grant for this today/);
      }
      // A refused writer reached through call_tool still meets the seam.
      const writer = tools.registry.resolve("create_routine")!;
      const result = await writer.run({ name: "Digest", cronExpr: "0 8 * * *" });
      assert.equal(result.isError, true);
      assert.match(result.content, /yours is "run" \(read \+ run\)/);
    } finally {
      await tools.close();
    }
    // A read + write teammate's working set is untouched.
    const teammate = await gathered(bob);
    try {
      assert.equal(teammate.registry.visibility("create_routine"), "resident");
    } finally {
      await teammate.close();
    }
  });
});
