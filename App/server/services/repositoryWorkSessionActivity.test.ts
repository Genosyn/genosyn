import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionEvent } from "../db/entities/RepositoryWorkSessionEvent.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import {
  SessionActivityRecorder,
  describeToolResult,
  describeToolUse,
  listSessionEvents,
  nextSessionEventOrdinal,
  registerRunningSessionTurn,
  runningSessionTurn,
  stopRunningSessionTurn,
  unregisterRunningSessionTurn,
} from "./repositoryWorkSessionActivity.js";

/**
 * The activity feed of a work session turn: what the recorder writes, in what
 * order, and how a running turn is stopped.
 *
 * The recorder is exercised directly rather than through `runRepositoryWorkSession`
 * because its invariants — one text event before a tool call, ordinals in
 * observation order, results paired by call id — are what the session page
 * relies on, and they are easiest to state against a bare recorder.
 */

before(initTestDb);
after(closeTestDb);

let company: Company;
let repository: Repository;
let session: RepositoryWorkSession;
let turn: RepositoryWorkSessionTurn;

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 1,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  repository = await insert(Repository, {
    companyId: company.id,
    name: "Strategy",
    slug: "strategy",
    description: "",
    origin: "local",
    kind: "documents",
    gitUrl: "",
    defaultBranch: "main",
    authMode: "none",
    committerName: "Genosyn",
    committerEmail: "repositories@genosyn.local",
    lastSyncStatus: "unknown",
    lastSyncError: "",
  });
  session = await insert(RepositoryWorkSession, {
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: testId("emp"),
    instruction: "Update the plan",
    status: "running",
  });
  turn = await insert(RepositoryWorkSessionTurn, {
    companyId: company.id,
    sessionId: session.id,
    ordinal: 1,
    instruction: "Update the plan",
    status: "running",
  });
});

function recorder(firstOrdinal = 1, sessionId = session.id): SessionActivityRecorder {
  return new SessionActivityRecorder(
    { companyId: company.id, repositoryId: repository.id, sessionId, turnId: turn.id },
    firstOrdinal,
  );
}

async function events(sessionId = session.id): Promise<RepositoryWorkSessionEvent[]> {
  return AppDataSource.getRepository(RepositoryWorkSessionEvent).find({
    where: { sessionId },
    order: { ordinal: "ASC" },
  });
}

function detail(event: RepositoryWorkSessionEvent): Record<string, unknown> {
  return JSON.parse(event.detailJson) as Record<string, unknown>;
}

// ───────────────────────────── recording ────────────────────────────────

describe("SessionActivityRecorder", () => {
  test("buffers narration and writes it as one text event before the tool call", async () => {
    const rec = recorder();
    rec.text("Let me ");
    rec.text("look at ");
    rec.text("the router.");
    // Nothing is written while the model is still talking.
    assert.equal(rec.ordinal, 1);

    rec.toolUse("repository_read_file", { path: "server/app.ts" }, "call-1");
    await rec.finish();

    const rows = await events();
    assert.deepEqual(
      rows.map((row) => [row.ordinal, row.kind, row.callId]),
      [
        [1, "text", ""],
        [2, "tool_use", "call-1"],
      ],
    );
    assert.deepEqual(detail(rows[0]), { text: "Let me look at the router." });
    assert.equal(rows[0].turnId, turn.id);
    assert.equal(rows[0].companyId, company.id);
    assert.equal(rows[0].repositoryId, repository.id);
    assert.equal(rows[1].name, "repository_read_file");
    assert.equal(rows[1].summary, "Read server/app.ts");
    assert.deepEqual(detail(rows[1]), { input: { path: "server/app.ts" } });
  });

  test("ignores whitespace-only narration and empty deltas", async () => {
    const rec = recorder();
    rec.text("");
    rec.text("  \n ");
    rec.toolUse("repository_status", {}, "call-1");
    await rec.finish();

    assert.deepEqual(
      (await events()).map((row) => row.kind),
      ["tool_use"],
    );
  });

  test("flushes narration on its own once it outgrows a single text event", async () => {
    const rec = recorder();
    rec.text("x".repeat(8_000));
    // The event was recorded straight away, without a tool call to force it.
    assert.equal(rec.ordinal, 2);
    await rec.finish();

    const rows = await events();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "text");
    assert.equal((detail(rows[0]).text as string).length, 8_000);
  });

  test("assigns ordinals in observation order when results arrive out of order", async () => {
    const rec = recorder();
    rec.toolUse("repository_read_file", { path: "a.ts" }, "call-a");
    rec.toolUse("repository_read_file", { path: "b.ts" }, "call-b");
    rec.toolUse("repository_read_file", { path: "c.ts" }, "call-c");
    // Concurrent reads: c returns first, then a, then b.
    rec.toolResult("repository_read_file", { content: "c" }, "call-c");
    rec.toolResult("repository_read_file", { content: "a" }, "call-a");
    rec.toolResult("repository_read_file", { content: "b" }, "call-b");
    await rec.finish();

    const rows = await events();
    assert.deepEqual(
      rows.map((row) => [row.ordinal, row.kind, row.callId]),
      [
        [1, "tool_use", "call-a"],
        [2, "tool_use", "call-b"],
        [3, "tool_use", "call-c"],
        [4, "tool_result", "call-c"],
        [5, "tool_result", "call-a"],
        [6, "tool_result", "call-b"],
      ],
    );
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].ordinal > rows[i - 1].ordinal, "ordinals must strictly increase");
    }
  });

  test("records a tool result with its call id, error flag, summary and clipped output", async () => {
    const rec = recorder();
    const long = "y".repeat(6_250);
    rec.toolUse("repository_read_file", { path: "big.ts" }, "call-1");
    rec.toolResult("repository_read_file", { content: long }, "call-1");
    rec.toolUse("repository_edit_file", { path: "x.ts" }, "call-2");
    rec.toolResult(
      "repository_edit_file",
      { content: "old_string was not found in x.ts\nCheck the file again.", isError: true },
      "call-2",
    );
    await rec.finish();

    const rows = await events();
    const [, read, , edit] = rows;
    assert.equal(read.kind, "tool_result");
    assert.equal(read.callId, "call-1");
    assert.equal(read.name, "repository_read_file");
    assert.equal(read.isError, false);
    assert.equal(read.summary, "1 line");
    const output = detail(read).output as string;
    assert.equal(output, `${"y".repeat(6_000)}\n… [250 more characters]`);

    assert.equal(edit.kind, "tool_result");
    assert.equal(edit.callId, "call-2");
    assert.equal(edit.isError, true);
    assert.equal(edit.summary, "old_string was not found in x.ts");
    assert.deepEqual(detail(edit), {
      output: "old_string was not found in x.ts\nCheck the file again.",
    });
  });

  test("keeps more of a command's output than of a read", async () => {
    const rec = recorder();
    const output = "z".repeat(10_000);
    rec.toolResult(
      "repository_run_command",
      { content: JSON.stringify({ ran: true, exitCode: 0, output }) },
      "call-1",
    );
    rec.toolResult("repository_search", { content: output }, "call-2");
    await rec.finish();

    const [command, search] = await events();
    assert.equal(command.summary, "Exit 0");
    assert.equal((detail(command).output as string).includes("more characters"), false);
    assert.ok((detail(search).output as string).endsWith("\n… [4000 more characters]"));
  });

  test("clips oversized tool arguments before storing them", async () => {
    const rec = recorder();
    const content = "w".repeat(4_100);
    rec.toolUse("repository_write_file", { path: "notes.md", content, count: 3 }, "call-1");
    await rec.finish();

    const [row] = await events();
    const input = detail(row).input as Record<string, unknown>;
    assert.equal(input.path, "notes.md");
    assert.equal(input.count, 3);
    assert.equal(input.content, `${"w".repeat(4_000)}\n… [100 more characters]`);
  });

  test("records the step list with a done count", async () => {
    const rec = recorder();
    const steps = [
      { text: "Read the router", status: "completed" as const },
      { text: "Add the route", status: "in_progress" as const },
      { text: "Write a test", status: "pending" as const },
    ];
    rec.text("Here is my plan.");
    rec.steps(steps);
    await rec.finish();

    const rows = await events();
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["text", "steps"],
    );
    assert.equal(rows[1].summary, "1 of 3 steps done");
    assert.deepEqual(detail(rows[1]), { steps });
  });

  test("closingText is the narration after the last tool result", async () => {
    const rec = recorder();
    rec.text("Let me look first.");
    rec.toolUse("repository_read_file", { path: "a.ts" }, "call-1");
    assert.equal(rec.closingText, "");
    rec.toolResult("repository_read_file", { content: "…" }, "call-1");
    assert.equal(rec.closingText, "");
    rec.text("I changed ");
    rec.text("the route. ");
    assert.equal(rec.closingText, "I changed the route.");
    await rec.finish();
    // Flushing moves the buffer into the trailing text; the report survives.
    assert.equal(rec.closingText, "I changed the route.");
  });

  test("closingText is empty when a tool call follows the narration", async () => {
    const rec = recorder();
    rec.toolUse("repository_read_file", { path: "a.ts" }, "call-1");
    rec.toolResult("repository_read_file", { content: "…" }, "call-1");
    rec.text("Now let me edit it.");
    assert.equal(rec.closingText, "Now let me edit it.");
    rec.toolUse("repository_edit_file", { path: "a.ts" }, "call-2");
    assert.equal(rec.closingText, "");
    await rec.finish();
    assert.equal(rec.closingText, "");
  });

  test("closingText spans the step list update but not a tool call", async () => {
    const rec = recorder();
    rec.toolResult("repository_read_file", { content: "…" }, "call-1");
    rec.text("Done reading. ");
    rec.steps([{ text: "Read", status: "completed" }]);
    rec.text("All finished.");
    assert.equal(rec.closingText, "Done reading. All finished.");
    await rec.finish();
  });

  test("finish() waits for every row and ignores narration afterwards", async () => {
    const rec = recorder();
    for (let i = 0; i < 12; i++) {
      rec.toolUse("repository_read_file", { path: `${i}.ts` }, `call-${i}`);
      rec.toolResult("repository_read_file", { content: `${i}` }, `call-${i}`);
    }
    rec.text("Report.");
    await rec.finish();

    const count = await AppDataSource.getRepository(RepositoryWorkSessionEvent).countBy({
      sessionId: session.id,
    });
    assert.equal(count, 25);
    assert.equal(rec.ordinal, 26);

    rec.text("too late");
    assert.equal(rec.closingText, "Report.");
    assert.equal(rec.ordinal, 26);
  });

  test("records compaction, retries and progress with readable summaries", async () => {
    const rec = recorder();
    rec.compact({ evicted: 1, freedTokens: 800, reason: "budget" });
    rec.compact({ evicted: 3, freedTokens: 2_400, reason: "overflow" });
    rec.retry({ attempt: 2, maxAttempts: 11, delayMs: 500, reason: "HTTP 500" });
    rec.progress({ percent: 40, label: "Editing the router" });
    await rec.finish();

    const rows = await events();
    assert.deepEqual(
      rows.map((row) => [row.kind, row.summary]),
      [
        ["compact", "Dropped 1 older tool result to stay inside the context window"],
        ["compact", "Dropped 3 older tool results to stay inside the context window"],
        ["retry", "Model call retried (2 of 11): HTTP 500"],
        ["progress", "40% — Editing the router"],
      ],
    );
    assert.deepEqual(detail(rows[2]), { attempt: 2, maxAttempts: 11, delayMs: 500 });
  });
});

// ───────────────────────────── reading back ─────────────────────────────

describe("reading the feed", () => {
  test("nextSessionEventOrdinal starts at 1 and continues after existing rows", async () => {
    assert.equal(await nextSessionEventOrdinal(session.id), 1);

    const rec = recorder(await nextSessionEventOrdinal(session.id));
    rec.toolUse("repository_status", {}, "call-1");
    rec.toolResult("repository_status", { content: "(clean)" }, "call-1");
    rec.text("Nothing to do.");
    await rec.finish();
    assert.equal(await nextSessionEventOrdinal(session.id), 4);

    // A second turn's recorder carries on where the first left off.
    const next = recorder(await nextSessionEventOrdinal(session.id));
    next.toolUse("repository_diff", {}, "call-2");
    await next.finish();
    assert.deepEqual(
      (await events()).map((row) => row.ordinal),
      [1, 2, 3, 4],
    );

    // Another session's rows do not count.
    assert.equal(await nextSessionEventOrdinal(testId("session")), 1);
  });

  test("listSessionEvents returns only rows after the cursor, oldest first, bounded", async () => {
    const rec = recorder();
    for (let i = 0; i < 5; i++) rec.toolUse("repository_status", {}, `call-${i}`);
    await rec.finish();
    // Rows of another session must never leak into this one's feed.
    const other = recorder(1, testId("session"));
    other.toolUse("repository_status", {}, "other");
    await other.finish();

    const ordinals = (rows: RepositoryWorkSessionEvent[]) => rows.map((row) => row.ordinal);
    assert.deepEqual(ordinals(await listSessionEvents(session.id, 0)), [1, 2, 3, 4, 5]);
    assert.deepEqual(ordinals(await listSessionEvents(session.id, 2)), [3, 4, 5]);
    assert.deepEqual(ordinals(await listSessionEvents(session.id, 5)), []);
    assert.deepEqual(ordinals(await listSessionEvents(session.id, 0, 2)), [1, 2]);
    assert.deepEqual(ordinals(await listSessionEvents(session.id, 3, 1)), [4]);
    // A limit below one still returns something rather than nothing.
    assert.deepEqual(ordinals(await listSessionEvents(session.id, 0, 0)), [1]);
    for (const row of await listSessionEvents(session.id, 0)) {
      assert.equal(row.sessionId, session.id);
    }
  });
});

// ─────────────────────────────── stopping ───────────────────────────────

describe("the running-turn registry", () => {
  test("stopping aborts the controller, records who did it, and is idempotent", async () => {
    const rec = recorder();
    const controller = new AbortController();
    registerRunningSessionTurn(session.id, { controller, recorder: rec, stoppedByUserId: null });
    try {
      rec.text("Half way through.");
      assert.equal(runningSessionTurn(session.id)?.controller, controller);

      assert.equal(stopRunningSessionTurn(session.id, "user-1"), true);
      assert.equal(controller.signal.aborted, true);
      assert.equal(runningSessionTurn(session.id)?.stoppedByUserId, "user-1");

      // A second Member pressing stop changes nothing.
      assert.equal(stopRunningSessionTurn(session.id, "user-2"), true);
      assert.equal(runningSessionTurn(session.id)?.stoppedByUserId, "user-1");
    } finally {
      unregisterRunningSessionTurn(session.id);
    }
    await rec.finish();

    const rows = await events();
    assert.deepEqual(
      rows.map((row) => [row.ordinal, row.kind, row.summary]),
      [
        [1, "text", ""],
        [2, "stopped", "Stopped by a Member"],
      ],
    );
    assert.deepEqual(detail(rows[1]), { userId: "user-1" });
  });

  test("returns false for a session this process is not running", async () => {
    assert.equal(stopRunningSessionTurn(testId("session"), "user-1"), false);
    assert.equal(runningSessionTurn(testId("session")), null);

    const rec = recorder();
    const controller = new AbortController();
    registerRunningSessionTurn(session.id, { controller, recorder: rec, stoppedByUserId: null });
    unregisterRunningSessionTurn(session.id);
    assert.equal(stopRunningSessionTurn(session.id, "user-1"), false);
    assert.equal(controller.signal.aborted, false);
    await rec.finish();
    assert.deepEqual(await events(), []);
  });
});

// ─────────────────────────── feed sentences ─────────────────────────────

describe("describeToolUse", () => {
  test("reads, with and without a line range", () => {
    assert.equal(describeToolUse("repository_read_file", { path: "src/app.ts" }), "Read src/app.ts");
    assert.equal(
      describeToolUse("repository_read_file", { path: "src/app.ts", offset: 10, limit: 20 }),
      "Read src/app.ts (lines 10–29)",
    );
    assert.equal(
      describeToolUse("repository_read_file", { path: "src/app.ts", offset: 10 }),
      "Read src/app.ts (lines 10+)",
    );
    assert.equal(
      describeToolUse("repository_read_file", { path: "src/app.ts", limit: 20 }),
      "Read src/app.ts (lines 1–20)",
    );
  });

  test("writes, edits and deletes", () => {
    assert.equal(describeToolUse("repository_edit_file", { path: "a.ts" }), "Edited a.ts");
    assert.equal(describeToolUse("repository_write_file", { path: "a.ts" }), "Wrote a.ts");
    assert.equal(describeToolUse("repository_delete_file", { path: "a.ts" }), "Deleted a.ts");
  });

  test("searches, globs and listings", () => {
    assert.equal(describeToolUse("repository_search", { pattern: "TODO" }), "Searched for TODO");
    assert.equal(
      describeToolUse("repository_search", { pattern: "TODO", path: "server", glob: "*.ts" }),
      "Searched for TODO in server (*.ts)",
    );
    assert.equal(
      describeToolUse("repository_search", { pattern: `x${"y".repeat(100)}` }),
      `Searched for x${"y".repeat(78)}…`,
    );
    assert.equal(
      describeToolUse("repository_glob", { pattern: "**/*.ts" }),
      "Found files matching **/*.ts",
    );
    assert.equal(
      describeToolUse("repository_glob", { pattern: "*.md", path: "docs" }),
      "Found files matching *.md in docs",
    );
    assert.equal(describeToolUse("repository_list_files", {}), "Listed the repository root");
    assert.equal(describeToolUse("repository_list_files", { path: "server" }), "Listed server");
  });

  test("commands, commits and the rest", () => {
    assert.equal(describeToolUse("repository_run_command", { command: "npm test" }), "Ran npm test");
    assert.equal(
      describeToolUse("repository_run_command", { command: "npm   run\n  lint" }),
      "Ran npm run lint",
    );
    assert.equal(
      describeToolUse("repository_commit", { message: "Add a note\n\nWith a body." }),
      "Committed: Add a note",
    );
    assert.equal(describeToolUse("repository_status", {}), "Checked the working copy status");
    assert.equal(describeToolUse("repository_diff", {}), "Reviewed the diff");
    assert.equal(
      describeToolUse("repository_diff", { committed: true }),
      "Reviewed the committed diff",
    );
    assert.equal(describeToolUse("repository_update_steps", { steps: [] }), "Updated the step list");
    assert.equal(describeToolUse("contacts_create", { email: "a@b.c" }), "Called contacts_create");
    // A missing or non-string path never throws.
    assert.equal(describeToolUse("repository_read_file", { path: 42 }), "Read ");
  });
});

describe("describeToolResult", () => {
  test("commands: exit code, refusal, and the time limit", () => {
    const json = (value: unknown) => ({ content: JSON.stringify(value) });
    assert.equal(
      describeToolResult("repository_run_command", json({ ran: true, exitCode: 0, output: "" })),
      "Exit 0",
    );
    assert.equal(
      describeToolResult("repository_run_command", json({ ran: true, exitCode: 1, output: "" })),
      "Exit 1",
    );
    assert.equal(
      describeToolResult(
        "repository_run_command",
        json({ ran: false, reason: "Command execution is disabled on this install." }),
      ),
      "Not run: Command execution is disabled on this install.",
    );
    assert.equal(
      describeToolResult(
        "repository_run_command",
        json({ ran: true, exitCode: null, timedOut: true, output: "" }),
      ),
      "Stopped at the time limit",
    );
    assert.equal(describeToolResult("repository_run_command", { content: "plain" }), "Finished");
  });

  test("commits: sha and file count, or nothing to commit", () => {
    const json = (value: unknown) => ({ content: JSON.stringify(value) });
    assert.equal(
      describeToolResult(
        "repository_commit",
        json({ committed: true, commit: "0123456789abcdef", filesChanged: 3 }),
      ),
      "0123456 · 3 files",
    );
    assert.equal(
      describeToolResult(
        "repository_commit",
        json({ committed: true, commit: "0123456789abcdef", filesChanged: 1 }),
      ),
      "0123456 · 1 file",
    );
    assert.equal(
      describeToolResult("repository_commit", json({ committed: true, commit: "0123456789abcdef" })),
      "0123456",
    );
    assert.equal(
      describeToolResult("repository_commit", json({ committed: false, message: "Nothing" })),
      "Nothing to commit",
    );
    assert.equal(describeToolResult("repository_commit", { content: "ok" }), "Committed");
  });

  test("edits and writes count what they did", () => {
    const json = (value: unknown) => ({ content: JSON.stringify(value) });
    assert.equal(
      describeToolResult("repository_edit_file", json({ ok: true, replacements: 1 })),
      "1 replacement",
    );
    assert.equal(
      describeToolResult("repository_edit_file", json({ ok: true, replacements: 4 })),
      "4 replacements",
    );
    assert.equal(describeToolResult("repository_edit_file", { content: "ok" }), "Edited");
    assert.equal(
      describeToolResult("repository_write_file", json({ ok: true, lines: 12 })),
      "12 lines written",
    );
    assert.equal(describeToolResult("repository_write_file", { content: "ok" }), "Written");
  });

  test("text tools count lines, or repeat a parenthesised first line", () => {
    assert.equal(describeToolResult("repository_read_file", { content: "1\n2\n3\n" }), "3 lines");
    assert.equal(describeToolResult("repository_read_file", { content: "only" }), "1 line");
    assert.equal(describeToolResult("repository_list_files", { content: "" }), "0 lines");
    assert.equal(
      describeToolResult("repository_search", { content: "(no matches)\n" }),
      "(no matches)",
    );
    assert.equal(
      describeToolResult("repository_status", { content: "(clean — nothing to commit)" }),
      "(clean — nothing to commit)",
    );
    assert.equal(describeToolResult("repository_diff", { content: "a\nb" }), "2 lines");
    assert.equal(describeToolResult("repository_glob", { content: "a.ts\nb.ts\nc.ts" }), "3 lines");
  });

  test("errors show their first line, whatever the tool", () => {
    assert.equal(
      describeToolResult("repository_run_command", {
        content: "Session not found.\nDetails follow.",
        isError: true,
      }),
      "Session not found.",
    );
    assert.equal(
      describeToolResult("repository_read_file", { content: `${"e".repeat(200)}`, isError: true }),
      `${"e".repeat(159)}…`,
    );
    assert.equal(describeToolResult("anything", { content: "", isError: true }), "");
  });

  test("the remaining tools", () => {
    assert.equal(describeToolResult("repository_update_steps", { content: "{}" }), "Steps updated");
    assert.equal(describeToolResult("contacts_create", { content: "{}" }), "Done");
  });
});
