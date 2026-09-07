import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Repository } from "../db/entities/Repository.js";
import {
  RepositoryWorkSession,
  type RepositoryWorkSessionStatus,
} from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionEvent } from "../db/entities/RepositoryWorkSessionEvent.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import {
  AI_OVERVIEW_LIST_LIMIT,
  AI_OVERVIEW_RECENT_LIMIT,
  activitySummary,
  aiOverviewGroup,
  pickOverviewSessionIds,
  repositoryAiOverview,
  stepProgress,
  summarizeRepositoryAiWork,
  type RepositoryAiSessionStat,
} from "./repositoryAiOverview.js";

/**
 * The numbers and sentences the Repository Overview leads with.
 *
 * Everything here is a claim a reader will believe without checking: that the
 * four counts are the whole story ("11 sessions" had better be the same 11 the
 * four buckets describe), that "landed" means work a Member accepted rather
 * than work an employee typed, and that a session filed out of the inbox stops
 * appearing in a queue without its commits vanishing from the totals. Those are
 * arithmetic, so they are pinned as arithmetic — including the partition
 * itself, which is the invariant a fifth bucket or a fifth status would quietly
 * break.
 *
 * The rest pins the reading of rows the server did not write: an employee's own
 * step list, and narration that arrives as JSON. Both are read defensively on
 * purpose, and a defensive read is only defensive while something proves the
 * malformed cases still return "nothing" rather than `NaN`, `"0 of 0"`, or a
 * thrown error on a page that is meant to be a glance.
 *
 * The last block runs the digest against a real database, because the display
 * order, the hydration of employees, and "the newest steps event, however far
 * behind the tail it is" are claims about queries that no pure test can make.
 */

before(initTestDb);
after(closeTestDb);

function at(iso: string): Date {
  return new Date(iso);
}

// ─────────────────────────── the arithmetic ─────────────────────────────

let nextStatId = 0;

function stat(over: Partial<RepositoryAiSessionStat> = {}): RepositoryAiSessionStat {
  nextStatId += 1;
  return {
    id: `stat-${nextStatId}`,
    employeeId: "employee-1",
    status: "ready",
    archivedAt: null,
    turnCount: 1,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    updatedAt: at("2026-01-01T00:00:00.000Z"),
    ...over,
  };
}

describe("aiOverviewGroup", () => {
  test("splits the statuses the way the AI work inbox does", () => {
    assert.equal(aiOverviewGroup("running"), "running");
    assert.equal(aiOverviewGroup("published"), "completed");
    assert.equal(aiOverviewGroup("discarded"), "completed");
    // `empty` is a finished answer of "nothing to change" — it still wants a
    // human to say so, which is why it is attention rather than completed.
    for (const status of [
      "ready",
      "empty",
      "proposed",
      "failed",
    ] as RepositoryWorkSessionStatus[]) {
      assert.equal(aiOverviewGroup(status), "attention");
    }
  });
});

describe("summarizeRepositoryAiWork", () => {
  test("the four counts partition the sessions and add up to the total exactly once", () => {
    const rows = [
      stat({ status: "running" }),
      stat({ status: "running" }),
      stat({ status: "ready" }),
      stat({ status: "empty" }),
      stat({ status: "proposed" }),
      stat({ status: "failed" }),
      stat({ status: "published" }),
      stat({ status: "discarded" }),
      stat({ status: "running", archivedAt: at("2026-02-01T00:00:00.000Z") }),
      stat({ status: "ready", archivedAt: "2026-02-01T00:00:00.000Z" }),
      stat({ status: "published", archivedAt: at("2026-02-01T00:00:00.000Z") }),
    ];

    const { counts } = summarizeRepositoryAiWork(rows);

    assert.deepEqual(counts, { total: 11, running: 2, attention: 4, completed: 2, archived: 3 });
    assert.equal(
      counts.running + counts.attention + counts.completed + counts.archived,
      counts.total,
      "every session is counted in exactly one bucket",
    );
    assert.equal(counts.total, rows.length);
  });

  test("a session waiting on a human stops waiting once it is filed away", () => {
    const { counts } = summarizeRepositoryAiWork([
      stat({ status: "ready" }),
      stat({ status: "ready", archivedAt: at("2026-02-02T00:00:00.000Z") }),
    ]);

    assert.equal(counts.attention, 1);
    assert.equal(counts.archived, 1);
    assert.equal(counts.total, 2);
  });

  test("landed counts published work only, and filing it away does not un-land it", () => {
    const { landed, counts } = summarizeRepositoryAiWork([
      stat({ status: "published", filesChanged: 3, insertions: 40, deletions: 5 }),
      stat({
        status: "published",
        filesChanged: 1,
        insertions: 2,
        deletions: 1,
        archivedAt: at("2026-02-03T00:00:00.000Z"),
      }),
      stat({ status: "discarded", filesChanged: 9, insertions: 900, deletions: 900 }),
      stat({ status: "ready", filesChanged: 7, insertions: 70, deletions: 7 }),
      stat({ status: "proposed", filesChanged: 5, insertions: 50, deletions: 5 }),
    ]);

    assert.deepEqual(landed, { sessions: 2, filesChanged: 4, insertions: 42, deletions: 6 });
    // A branch nobody accepted changed nothing here, however big its diff was.
    assert.equal(counts.completed, 2);
  });

  test("totals count every instruction given and every session thrown away", () => {
    const { totals } = summarizeRepositoryAiWork([
      stat({ status: "running", turnCount: 2 }),
      stat({ status: "discarded", turnCount: 5 }),
      stat({ status: "discarded", turnCount: 1, archivedAt: at("2026-02-04T00:00:00.000Z") }),
      stat({ status: "published", turnCount: 3 }),
      stat({ status: "ready", turnCount: 0 }),
    ]);

    assert.deepEqual(totals, { turns: 11, discarded: 2 });
  });

  test("an employee's tally counts every session but lands only published work", () => {
    const { employees } = summarizeRepositoryAiWork([
      stat({
        employeeId: "ada",
        status: "published",
        filesChanged: 2,
        insertions: 20,
        deletions: 2,
        updatedAt: at("2026-03-01T10:00:00.000Z"),
      }),
      stat({
        employeeId: "ada",
        status: "ready",
        filesChanged: 9,
        insertions: 90,
        deletions: 9,
        updatedAt: at("2026-03-03T10:00:00.000Z"),
      }),
      stat({
        employeeId: "ada",
        status: "discarded",
        filesChanged: 9,
        insertions: 90,
        deletions: 9,
        updatedAt: at("2026-03-02T10:00:00.000Z"),
      }),
      stat({ employeeId: "bo", status: "running", updatedAt: at("2026-03-04T10:00:00.000Z") }),
    ]);

    assert.deepEqual(
      employees.find((row) => row.employeeId === "ada"),
      {
        employeeId: "ada",
        sessions: 3,
        landed: 1,
        filesChanged: 2,
        insertions: 20,
        deletions: 2,
        lastActiveAt: "2026-03-03T10:00:00.000Z",
      },
    );
    assert.deepEqual(
      employees.find((row) => row.employeeId === "bo"),
      {
        employeeId: "bo",
        sessions: 1,
        landed: 0,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
        lastActiveAt: "2026-03-04T10:00:00.000Z",
      },
    );
  });

  test("employees are ordered by landed, then sessions, then recency, then id", () => {
    const rows = [
      // Two employees whose tallies are identical down to the millisecond: the
      // id breaks the tie, so the page does not reshuffle between two reads.
      stat({ employeeId: "fox", updatedAt: at("2026-05-03T00:00:00.000Z") }),
      stat({ employeeId: "eve", updatedAt: at("2026-05-03T00:00:00.000Z") }),
      stat({ employeeId: "dan", updatedAt: at("2026-05-04T00:00:00.000Z") }),
      stat({ employeeId: "cat", updatedAt: at("2026-05-05T00:00:00.000Z") }),
      stat({ employeeId: "bob", status: "published" }),
      stat({ employeeId: "bob", status: "ready" }),
      stat({ employeeId: "amy", status: "published" }),
      stat({ employeeId: "amy", status: "ready" }),
      stat({ employeeId: "amy", status: "failed" }),
      stat({ employeeId: "zed", status: "published" }),
      stat({ employeeId: "zed", status: "published" }),
    ];

    const { employees } = summarizeRepositoryAiWork(rows);

    assert.deepEqual(
      employees.map((row) => row.employeeId),
      ["zed", "amy", "bob", "cat", "dan", "eve", "fox"],
    );
  });

  test("lastActiveAt is the newest moment anything here moved", () => {
    const { lastActiveAt } = summarizeRepositoryAiWork([
      stat({ updatedAt: at("2026-04-01T00:00:00.000Z") }),
      stat({ updatedAt: at("2026-06-01T12:30:00.000Z") }),
      stat({
        updatedAt: at("2026-05-01T00:00:00.000Z"),
        archivedAt: at("2026-05-01T00:00:00.000Z"),
      }),
    ]);

    assert.equal(lastActiveAt, "2026-06-01T12:30:00.000Z");
  });

  test("no rows is zeroes and nulls, not a division by nothing", () => {
    const summary = summarizeRepositoryAiWork([]);

    assert.deepEqual(summary.counts, {
      total: 0,
      running: 0,
      attention: 0,
      completed: 0,
      archived: 0,
    });
    assert.deepEqual(summary.landed, { sessions: 0, filesChanged: 0, insertions: 0, deletions: 0 });
    assert.deepEqual(summary.totals, { turns: 0, discarded: 0 });
    assert.equal(summary.lastActiveAt, null);
    assert.deepEqual(summary.employees, []);
  });

  test("a driver that hands back date strings still dates the work", () => {
    const summary = summarizeRepositoryAiWork([
      stat({ employeeId: "ada", updatedAt: "2026-07-01T09:00:00.000Z" }),
      stat({ employeeId: "ada", updatedAt: "2026-07-02T09:00:00.000Z" }),
    ]);

    assert.equal(summary.lastActiveAt, "2026-07-02T09:00:00.000Z");
    assert.equal(summary.employees[0].lastActiveAt, "2026-07-02T09:00:00.000Z");
  });

  test("an unreadable timestamp is dropped rather than turned into NaN", () => {
    const summary = summarizeRepositoryAiWork([
      stat({ employeeId: "ada", updatedAt: "2026-07-01T09:00:00.000Z" }),
      stat({ employeeId: "bo", updatedAt: "not a date at all" }),
    ]);

    assert.equal(summary.lastActiveAt, "2026-07-01T09:00:00.000Z");
    assert.equal(summary.employees.find((row) => row.employeeId === "bo")?.lastActiveAt, null);
    // `new Date(NaN).toISOString()` throws, so serialising is the real check.
    assert.doesNotMatch(JSON.stringify(summary), /NaN|Invalid/);

    const rubbishOnly = summarizeRepositoryAiWork([stat({ updatedAt: "" })]);
    assert.equal(rubbishOnly.lastActiveAt, null);
    assert.equal(rubbishOnly.counts.total, 1);
  });
});

// ──────────────────────────── what is listed ────────────────────────────

describe("pickOverviewSessionIds", () => {
  test("live work first, then what waits on a human, then a tail of finished work", () => {
    const ids = pickOverviewSessionIds([
      stat({ id: "run-old", status: "running", updatedAt: at("2026-08-01T00:00:00.000Z") }),
      stat({ id: "run-new", status: "running", updatedAt: at("2026-08-09T00:00:00.000Z") }),
      stat({ id: "wait-old", status: "failed", updatedAt: at("2026-08-02T00:00:00.000Z") }),
      stat({ id: "wait-new", status: "ready", updatedAt: at("2026-08-08T00:00:00.000Z") }),
      stat({ id: "done-old", status: "discarded", updatedAt: at("2026-08-03T00:00:00.000Z") }),
      stat({ id: "done-new", status: "published", updatedAt: at("2026-08-07T00:00:00.000Z") }),
    ]);

    assert.deepEqual(ids, ["run-new", "run-old", "wait-new", "wait-old", "done-new", "done-old"]);
  });

  test("an archived session is never listed, however recently it moved", () => {
    const ids = pickOverviewSessionIds([
      stat({ id: "listed", status: "ready", updatedAt: at("2026-08-01T00:00:00.000Z") }),
      // Newest of the three, and running: it would lead the list if archiving
      // did not take a row out of every queue.
      stat({
        id: "filed-running",
        status: "running",
        updatedAt: at("2026-08-20T00:00:00.000Z"),
        archivedAt: at("2026-08-20T00:00:00.000Z"),
      }),
      stat({
        id: "filed-published",
        status: "published",
        updatedAt: at("2026-08-19T00:00:00.000Z"),
        archivedAt: "2026-08-19T00:00:00.000Z",
      }),
    ]);

    assert.deepEqual(ids, ["listed"]);
  });

  test("the finished tail stops at the recent limit", () => {
    const rows = Array.from({ length: AI_OVERVIEW_RECENT_LIMIT + 4 }, (_, i) =>
      stat({
        id: `done-${i}`,
        status: i % 2 === 0 ? "published" : "discarded",
        updatedAt: at(`2026-09-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
      }),
    );

    const ids = pickOverviewSessionIds(rows);

    assert.equal(ids.length, AI_OVERVIEW_RECENT_LIMIT);
    assert.deepEqual(ids, ["done-9", "done-8", "done-7", "done-6", "done-5", "done-4"]);
  });

  test("the whole list stops at the list limit, and the queues get the room", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        stat({
          id: `run-${i}`,
          status: "running",
          updatedAt: at(`2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
        }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        stat({
          id: `wait-${i}`,
          status: "ready",
          updatedAt: at(`2026-11-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        stat({
          id: `done-${i}`,
          status: "published",
          updatedAt: at(`2026-12-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
        }),
      ),
    ];

    const ids = pickOverviewSessionIds(rows);

    assert.equal(ids.length, AI_OVERVIEW_LIST_LIMIT);
    assert.equal(ids.filter((id) => id.startsWith("run-")).length, 5);
    assert.equal(ids.filter((id) => id.startsWith("wait-")).length, 19);
    // Finished work is the first thing dropped when the queues fill the page.
    assert.equal(
      ids.some((id) => id.startsWith("done-")),
      false,
    );
    assert.equal(ids[0], "run-4");
    assert.equal(ids[5], "wait-19");
    assert.equal(ids[AI_OVERVIEW_LIST_LIMIT - 1], "wait-1");
  });
});

// ──────────────────────────── the live line ─────────────────────────────

type FeedEvent = Pick<RepositoryWorkSessionEvent, "kind" | "summary" | "detailJson">;

function feedEvent(over: Partial<FeedEvent> = {}): FeedEvent {
  return { kind: "text", summary: "", detailJson: "", ...over };
}

describe("activitySummary", () => {
  test("the newest readable line wins", () => {
    assert.equal(
      activitySummary([
        feedEvent({ kind: "tool_use", summary: "Read server/app.ts" }),
        feedEvent({ kind: "tool_result", summary: "Exit 1" }),
      ]),
      "Exit 1",
    );
    assert.equal(
      activitySummary([feedEvent({ kind: "tool_use", summary: "  Ran npm test  " })]),
      "Ran npm test",
    );
  });

  test("a steps event is never the line", () => {
    assert.equal(
      activitySummary([
        feedEvent({ kind: "tool_result", summary: "Exit 1" }),
        feedEvent({ kind: "steps", summary: "1 of 3 steps done" }),
      ]),
      "Exit 1",
    );
  });

  test("narration stands in when there is no tool line, flattened and clipped", () => {
    assert.equal(
      activitySummary([
        feedEvent({
          kind: "text",
          detailJson: JSON.stringify({ text: "  Let me\n\tcheck   the tests.  " }),
        }),
      ]),
      "Let me check the tests.",
    );

    const line = activitySummary([
      feedEvent({ kind: "text", detailJson: JSON.stringify({ text: "w".repeat(200) }) }),
    ]);
    assert.equal(line, `${"w".repeat(159)}…`);
    assert.equal(line.length, 160);
  });

  test("unreadable narration falls through to an older line rather than showing nothing", () => {
    assert.equal(
      activitySummary([
        feedEvent({ kind: "tool_use", summary: "Read server/app.ts" }),
        feedEvent({ kind: "text", detailJson: "{not json" }),
      ]),
      "Read server/app.ts",
    );
  });

  test("nothing readable is an empty line, never a crash", () => {
    assert.equal(activitySummary([]), "");
    assert.equal(activitySummary([feedEvent({ kind: "text", detailJson: "{not json" })]), "");
    assert.equal(activitySummary([feedEvent({ kind: "text", detailJson: "" })]), "");
    assert.equal(
      activitySummary([feedEvent({ kind: "text", detailJson: JSON.stringify({ text: 42 }) })]),
      "",
    );
    assert.equal(
      activitySummary([feedEvent({ kind: "text", detailJson: JSON.stringify(["hello"]) })]),
      "",
    );
    // Only narration gets the fallback: a tool event with no summary says nothing.
    assert.equal(
      activitySummary([
        feedEvent({ kind: "tool_result", detailJson: JSON.stringify({ text: "hidden" }) }),
      ]),
      "",
    );
  });
});

describe("stepProgress", () => {
  test("counts what is done and names the first step in flight", () => {
    assert.deepEqual(
      stepProgress(
        JSON.stringify({
          steps: [
            { text: "Read the router", status: "completed" },
            { text: "Add the route", status: "in_progress" },
            { text: "Write a test", status: "pending" },
            { text: "Ship it", status: "in_progress" },
          ],
        }),
      ),
      { done: 1, total: 4, current: "Add the route" },
    );
  });

  test("a plan with nothing usable in it is no progress rather than 0 of 0", () => {
    assert.equal(stepProgress(""), null);
    assert.equal(stepProgress("{"), null);
    assert.equal(stepProgress(JSON.stringify({ steps: "soon" })), null);
    assert.equal(stepProgress(JSON.stringify([{ text: "x", status: "pending" }])), null);
    assert.equal(stepProgress(JSON.stringify({ steps: [] })), null);
    assert.equal(stepProgress(JSON.stringify({})), null);
    assert.equal(stepProgress("null"), null);
  });

  test("an entry the employee malformed is dropped, not counted as pending", () => {
    assert.deepEqual(
      stepProgress(
        JSON.stringify({
          steps: [
            { text: "Real", status: "completed" },
            { text: "Bad status", status: "cancelled" },
            { text: 7, status: "pending" },
            { status: "pending" },
            null,
            "Write a test",
            ["Write a test", "pending"],
          ],
        }),
      ),
      { done: 1, total: 1, current: null },
    );
  });

  test("a blank step in flight is no step rather than an empty line", () => {
    assert.deepEqual(
      stepProgress(JSON.stringify({ steps: [{ text: "   ", status: "in_progress" }] })),
      { done: 0, total: 1, current: null },
    );
  });
});

// ───────────────────────── against a database ───────────────────────────

type HydratedSession = RepositoryWorkSession & {
  employee: { id: string; name: string; slug: string; avatarKey: string | null } | null;
};

describe("repositoryAiOverview", () => {
  let company: Company;
  let repository: Repository;
  let elsewhere: Repository;
  let ada: AIEmployee;
  let bo: AIEmployee;

  async function makeRepository(name: string, slug: string): Promise<Repository> {
    return insert(Repository, {
      companyId: company.id,
      name,
      slug,
      description: "",
      origin: "local",
      kind: "code",
      gitUrl: "",
      defaultBranch: "main",
      authMode: "none",
      committerName: "Genosyn",
      committerEmail: "repositories@genosyn.local",
      lastSyncStatus: "unknown",
      lastSyncError: "",
    });
  }

  async function session(
    over: Partial<RepositoryWorkSession> = {},
  ): Promise<RepositoryWorkSession> {
    return insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: repository.id,
      employeeId: ada.id,
      instruction: "Update the deployment guide",
      status: "ready",
      ...over,
    });
  }

  /**
   * A turn on a session. Real sessions always have one, and the digest reads
   * the activity of the newest one rather than of the session as a whole, so a
   * fixture that skipped it would be testing a state that cannot occur.
   */
  async function turn(sessionId: string, ordinal: number): Promise<RepositoryWorkSessionTurn> {
    return insert(RepositoryWorkSessionTurn, {
      companyId: company.id,
      sessionId,
      ordinal,
      instruction: `Instruction ${ordinal}`,
      reply: "",
      status: "running",
      error: "",
    });
  }

  async function event(
    turnRow: RepositoryWorkSessionTurn,
    ordinal: number,
    over: Partial<RepositoryWorkSessionEvent> = {},
  ): Promise<RepositoryWorkSessionEvent> {
    return insert(RepositoryWorkSessionEvent, {
      companyId: company.id,
      repositoryId: repository.id,
      sessionId: turnRow.sessionId,
      turnId: turnRow.id,
      ordinal,
      kind: "tool_use",
      summary: "",
      detailJson: "",
      ...over,
    });
  }

  beforeEach(async () => {
    await resetTestDb();
    company = await insert(Company, { name: "Acme", slug: "acme", ownerId: testId("user") });
    repository = await makeRepository("Strategy", "strategy");
    elsewhere = await makeRepository("Runbooks", "runbooks");
    ada = await insert(AIEmployee, {
      companyId: company.id,
      name: "Ada",
      slug: "ada",
      role: "Engineer",
      soulBody: "",
    });
    bo = await insert(AIEmployee, {
      companyId: company.id,
      name: "Bo",
      slug: "bo",
      role: "Writer",
      soulBody: "",
      avatarKey: "bo.png",
    });
  });

  test("lists the sessions in display order, each carrying the employee it was given to", async () => {
    const done = await session({
      status: "published",
      employeeId: bo.id,
      updatedAt: at("2026-01-05T00:00:00.000Z"),
    });
    const waiting = await session({ status: "ready", updatedAt: at("2026-01-04T00:00:00.000Z") });
    const live = await session({
      status: "running",
      employeeId: bo.id,
      updatedAt: at("2026-01-03T00:00:00.000Z"),
    });
    const filed = await session({
      status: "ready",
      updatedAt: at("2026-01-06T00:00:00.000Z"),
      archivedAt: at("2026-01-06T00:00:00.000Z"),
    });

    const overview = await repositoryAiOverview(repository);
    const sessions = overview.sessions as HydratedSession[];

    assert.deepEqual(
      sessions.map((row) => row.id),
      [live.id, waiting.id, done.id],
    );
    assert.equal(
      sessions.some((row) => row.id === filed.id),
      false,
    );
    assert.deepEqual(sessions[0].employee, {
      id: bo.id,
      name: "Bo",
      slug: "bo",
      avatarKey: "bo.png",
    });
    assert.equal(sessions[1].employee?.name, "Ada");
    assert.equal(sessions[2].employee?.id, bo.id);
    // The listed rows carry the instruction only as a title fallback, clipped.
    assert.equal(sessions[0].instruction, "Update the deployment guide");
    assert.equal("reply" in sessions[0], false);
    assert.equal("error" in sessions[0], false);

    assert.deepEqual(overview.counts, {
      total: 4,
      running: 1,
      attention: 1,
      completed: 1,
      archived: 1,
    });
    assert.equal(overview.capped, false);
    // The archived session still counts as the last thing that moved here.
    assert.equal(overview.lastActiveAt, "2026-01-06T00:00:00.000Z");
  });

  test("a running session gets its newest line, its plan, and a tool-call count", async () => {
    const live = await session({ status: "running", updatedAt: at("2026-01-07T00:00:00.000Z") });
    const first = await turn(live.id, 1);

    // The plan lands early and is then buried by more events than the tail the
    // summary reads, which is the case a naive "look at the last N events"
    // implementation gets wrong.
    await event(first, 1, {
      kind: "steps",
      summary: "1 of 3 steps done",
      detailJson: JSON.stringify({
        steps: [
          { text: "Read the guide", status: "completed" },
          { text: "Rewrite the rollback section", status: "in_progress" },
          { text: "Commit", status: "pending" },
        ],
      }),
    });
    for (let i = 0; i < 44; i += 1) {
      await event(first, 2 + i, { kind: "tool_use", summary: `Read page-${i}.md` });
    }
    const newest = at("2026-01-07T11:22:33.000Z");
    await event(first, 46, {
      kind: "tool_result",
      summary: "Exit 0",
      createdAt: newest,
    });

    const overview = await repositoryAiOverview(repository);

    assert.equal(overview.activity.length, 1);
    const entry = overview.activity[0];
    assert.equal(entry.sessionId, live.id);
    assert.equal(entry.summary, "Exit 0");
    assert.deepEqual(entry.steps, {
      done: 1,
      total: 3,
      current: "Rewrite the rollback section",
    });
    assert.equal(entry.toolCalls, 44);
    assert.equal(entry.at, newest.toISOString());
  });

  test("the live line is the turn in flight, never the one before it", async () => {
    // Ordinals run on across turns and events are never deleted, so a
    // session-wide read answers the second instruction with the first one's
    // finished plan and counts tool calls the reader already watched happen.
    const live = await session({ status: "running", updatedAt: at("2026-01-08T00:00:00.000Z") });
    const first = await turn(live.id, 1);
    await event(first, 1, {
      kind: "steps",
      detailJson: JSON.stringify({
        steps: [
          { text: "Read the guide", status: "completed" },
          { text: "Commit", status: "completed" },
        ],
      }),
    });
    await event(first, 2, { kind: "tool_use", summary: "Read guide.md" });
    await event(first, 3, { kind: "tool_result", summary: "Exit 0" });

    const second = await turn(live.id, 2);

    const started = await repositoryAiOverview(repository);
    assert.equal(started.activity.length, 1);
    // Nothing has happened on this turn yet, and the page says so rather than
    // reporting the previous turn's finished plan as this turn's progress.
    assert.equal(started.activity[0].summary, "");
    assert.equal(started.activity[0].steps, null);
    assert.equal(started.activity[0].toolCalls, 0);

    await event(second, 4, { kind: "tool_use", summary: "Read rollback.md" });
    const going = await repositoryAiOverview(repository);
    assert.equal(going.activity[0].summary, "Read rollback.md");
    assert.equal(going.activity[0].toolCalls, 1);
  });

  test("a session nobody is working on gets no live line", async () => {
    const waiting = await session({ status: "ready" });
    await event(await turn(waiting.id, 1), 1, { kind: "tool_result", summary: "Exit 0" });
    await session({ status: "published" });

    const overview = await repositoryAiOverview(repository);

    assert.equal(overview.sessions.length, 2);
    assert.deepEqual(overview.activity, []);
  });

  test("a repository nobody has worked in answers with zeroes rather than throwing", async () => {
    const overview = await repositoryAiOverview(repository);

    assert.deepEqual(overview.counts, {
      total: 0,
      running: 0,
      attention: 0,
      completed: 0,
      archived: 0,
    });
    assert.deepEqual(overview.landed, {
      sessions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
    assert.deepEqual(overview.totals, { turns: 0, discarded: 0 });
    assert.equal(overview.lastActiveAt, null);
    assert.deepEqual(overview.employees, []);
    assert.deepEqual(overview.sessions, []);
    assert.deepEqual(overview.activity, []);
    assert.equal(overview.capped, false);
  });

  test("work done in another repository is not counted in this one", async () => {
    await session({
      status: "published",
      turnCount: 2,
      filesChanged: 3,
      insertions: 30,
      deletions: 3,
      updatedAt: at("2026-01-08T00:00:00.000Z"),
    });
    const stranger = await insert(RepositoryWorkSession, {
      companyId: company.id,
      repositoryId: elsewhere.id,
      employeeId: bo.id,
      instruction: "Rewrite the on-call runbook",
      status: "published",
      turnCount: 7,
      filesChanged: 99,
      insertions: 990,
      deletions: 99,
      updatedAt: at("2026-02-09T00:00:00.000Z"),
    });

    const overview = await repositoryAiOverview(repository);

    assert.equal(overview.counts.total, 1);
    assert.deepEqual(overview.landed, {
      sessions: 1,
      filesChanged: 3,
      insertions: 30,
      deletions: 3,
    });
    assert.deepEqual(overview.totals, { turns: 2, discarded: 0 });
    assert.equal(overview.lastActiveAt, "2026-01-08T00:00:00.000Z");
    assert.deepEqual(
      overview.employees.map((row) => row.employeeId),
      [ada.id],
    );
    assert.equal(
      overview.sessions.some((row) => row.id === stranger.id),
      false,
    );

    const other = await repositoryAiOverview(elsewhere);
    assert.equal(other.counts.total, 1);
    assert.deepEqual(
      other.sessions.map((row) => row.id),
      [stranger.id],
    );
  });
});
