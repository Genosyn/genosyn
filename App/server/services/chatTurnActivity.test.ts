import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import type { ChatActivityEvent } from "../../shared/chatActivity.js";
import { AppDataSource } from "../db/datasource.js";
import { ConversationActivityEvent } from "../db/entities/ConversationActivityEvent.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import {
  ChatTurnActivityRecorder,
  listChatActivity,
  nextChatActivityOrdinal,
  recordDetachedChatActivity,
  summarizeChatActivity,
  toChatActivityEvent,
  turnAcceptedAt,
} from "./chatTurnActivity.js";
import { openLiveTurn, releaseLiveTurn } from "./chatTurnLive.js";

/**
 * The activity recorder is what a Member watching a chat turn — or reading it
 * next week — sees of the work. These tests pin what it promises: events in
 * the order they happened with no ordinal reused, results paired with their
 * calls however they arrive, waits measured, the summary a transcript shows,
 * and nothing in the feed the transcript itself would not hold.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const SCOPE = {
  companyId: "co_activity",
  conversationId: "conv_activity",
  messageId: "msg_activity",
  attempt: 1,
};

/** A recorder on a hand-driven clock, collecting what it emits live. */
function recorder(firstOrdinal = 1, now = { ms: Date.parse("2026-10-30T10:00:00.000Z") }) {
  const emitted: ChatActivityEvent[] = [];
  const rec = new ChatTurnActivityRecorder(SCOPE, firstOrdinal, {
    onEvent: (event) => emitted.push(event),
    now: () => now.ms,
  });
  return { rec, emitted, now };
}

async function stored(messageId = SCOPE.messageId): Promise<ChatActivityEvent[]> {
  return listChatActivity(messageId, 0, 1_000);
}

describe("recording a turn", () => {
  test("writes every event once, in the order observed, with consecutive ordinals", async () => {
    const { rec, emitted, now } = recorder(5);
    rec.turnStarted("start");
    rec.toolUse("search_web", { query: "spot GPU pricing" }, "c1");
    now.ms += 1_200;
    rec.toolResult("search_web", { content: "3 results" }, "c1");
    await rec.flush();
    const rows = await stored();
    assert.deepEqual(
      rows.map((row) => [row.ordinal, row.kind]),
      [
        [5, "turn_started"],
        [6, "tool_use"],
        [7, "tool_result"],
      ],
    );
    assert.deepEqual(
      emitted.map((event) => event.ordinal),
      [5, 6, 7],
      "the live copy carries the same ordinals as the rows",
    );
    assert.equal(rows[1].summary, "Searching the web for · “spot GPU pricing”");
    assert.equal((rows[2].detail as { durationMs: number }).durationMs, 1_200);
    assert.equal(rec.lastOrdinal, 7);
  });

  test("pairs results with their calls by id when overlapping calls finish out of order", async () => {
    const { rec, now } = recorder();
    rec.toolUse("grep", { pattern: "invoice" }, "a");
    now.ms += 100;
    rec.toolUse("glob", { pattern: "**/*.ts" }, "b");
    now.ms += 400;
    rec.toolResult("glob", { content: "x.ts" }, "b");
    now.ms += 1_000;
    rec.toolResult("grep", { content: "match" }, "a");
    await rec.flush();
    const results = (await stored()).filter((row) => row.kind === "tool_result");
    assert.deepEqual(
      results.map((row) => [row.callId, (row.detail as { durationMs: number }).durationMs]),
      [
        ["b", 400],
        ["a", 1_500],
      ],
    );
  });

  test("a runtime that reports no call id is paired by tool name, oldest first", async () => {
    const { rec, now } = recorder();
    rec.toolUse("bash", { command: "ls" });
    now.ms += 50;
    rec.toolUse("bash", { command: "pwd" });
    now.ms += 50;
    rec.toolResult("bash", { content: "a" });
    rec.toolResult("bash", { content: "b" });
    await rec.flush();
    const rows = await stored();
    const uses = rows.filter((row) => row.kind === "tool_use").map((row) => row.callId);
    const results = rows.filter((row) => row.kind === "tool_result").map((row) => row.callId);
    assert.equal(uses.length, 2);
    assert.deepEqual(results, uses, "each result names the call it answered");
    assert.notEqual(uses[0], uses[1]);
  });

  test("a result with no call still counts as a step; progress reports are left out", async () => {
    const { rec } = recorder();
    rec.toolUse("report_progress", { percent: 40, label: "Drafting" }, "p");
    rec.toolResult("report_progress", { content: "ok" }, "p");
    rec.progress({ percent: 40, label: "Drafting" });
    rec.toolResult("get_self", { content: "{}" }, "orphan");
    await rec.flush();
    const rows = await stored();
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["progress", "tool_result"],
    );
    const summary = rec.summarize({
      status: "ok",
      startedAt: new Date(0),
      endedAt: new Date(1_000),
    });
    assert.equal(summary.steps, 1);
  });

  test("failures, held calls and what a result was about are kept for the step", async () => {
    const { rec } = recorder();
    rec.toolUse("send_mail", { to: ["ana@acme.com"] }, "m");
    rec.toolResult("send_mail", { content: "Recipient refused\ndetails", isError: true }, "m");
    rec.toolUse("pay_invoices_from_bank_transaction", {}, "p");
    rec.toolResult(
      "pay_invoices_from_bank_transaction",
      {
        content: JSON.stringify({
          status: "pending_approval",
          approvalId: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
        }),
      },
      "p",
    );
    rec.toolUse("get_mail_message", { messageId: "x" }, "g");
    rec.toolResult(
      "get_mail_message",
      {
        content: JSON.stringify({
          message: { subject: "Q3 renewal", from: { name: "Ana", address: "ana@acme.com" } },
        }),
      },
      "g",
    );
    await rec.flush();
    const results = (await stored()).filter((row) => row.kind === "tool_result");
    assert.equal(results[0].isError, true);
    assert.equal(results[0].summary, "Sent an email to · failed: Recipient refused");
    assert.deepEqual((results[1].detail as { approval: unknown }).approval, {
      id: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
    });
    assert.equal((results[2].detail as { hint: string }).hint, "“Q3 renewal” · from Ana");
    const summary = rec.summarize({ status: "ok", startedAt: new Date(0), endedAt: new Date(10) });
    assert.equal(summary.failed, 1);
    assert.equal(summary.held, 1);
    assert.equal(summary.steps, 3);
  });
});

describe("what the feed never holds", () => {
  test("secret-named arguments, credentials in output and the turn's Secret values are removed", async () => {
    const { rec } = recorder();
    rec.setSensitiveValues(["sk-live-1234567890abcdef", "short"]);
    rec.toolUse(
      "bash",
      {
        command: "curl -H 'Authorization: Bearer abc.def.ghi' https://api.example.com?token=zzz",
        apiKey: "plain-key-value",
        nested: { password: "hunter2", note: "uses sk-live-1234567890abcdef" },
      },
      "c",
    );
    rec.toolResult(
      "bash",
      {
        content:
          "STRIPE_KEY=sk-live-1234567890abcdef\nghp_abcdefghijklmnopqrstuvwxyz0123 done in short order",
      },
      "c",
    );
    rec.reasoning("The key sk-live-1234567890abcdef works", "r1");
    rec.reasoningEnd("r1");
    await rec.flush();
    const rows = await AppDataSource.getRepository(ConversationActivityEvent).find({
      where: { messageId: SCOPE.messageId },
    });
    const everything = rows.map((row) => `${row.summary}\n${row.detailJson}`).join("\n");
    for (const secret of [
      "sk-live-1234567890abcdef",
      "hunter2",
      "plain-key-value",
      "abc.def.ghi",
      "ghp_abcdefghij",
    ]) {
      assert.ok(!everything.includes(secret), `${secret} leaked into the feed`);
    }
    assert.match(everything, /\[redacted secret\]|\[redacted credential\]|\[redacted\]/);
    assert.ok(everything.includes("short"), "values too short to be secrets are not hunted");
  });

  test("a value typed into a page is never kept", async () => {
    const { rec } = recorder();
    rec.toolUse("browser_fill", { selector: "#password", value: "correct horse battery" }, "f");
    rec.toolUse("[worker:Login] browser_fill", { selector: "#otp", value: "123456" }, "g");
    await rec.flush();
    const raw = (await AppDataSource.getRepository(ConversationActivityEvent).find())
      .map((r) => r.detailJson)
      .join("");
    assert.ok(!raw.includes("correct horse battery"));
    assert.ok(!raw.includes("123456"));
    assert.match(raw, /typed text hidden/);
  });

  test("long arguments, outputs and thoughts are clipped, saying how much was left out", async () => {
    const { rec } = recorder();
    rec.toolUse("write_file", { path: "a.txt", content: "y".repeat(10_000) }, "w");
    rec.toolResult("read", { content: "x".repeat(50_000) }, "r");
    rec.toolResult("bash", { content: "z".repeat(50_000) }, "b");
    rec.reasoning("t".repeat(9_000), "r1");
    rec.reasoningEnd("r1");
    await rec.flush();
    const rows = await stored();
    const input = (rows[0].detail as { input: { content: string } }).input.content;
    assert.ok(input.length < 2_200);
    assert.match(input, /more characters/);
    const read = (rows[1].detail as { output: string }).output;
    const command = (rows[2].detail as { output: string }).output;
    assert.ok(read.length < 4_200, "an ordinary result keeps 4,000 characters");
    assert.ok(command.length > 7_900 && command.length < 8_200, "a command keeps 8,000");
    assert.match(command, /more characters/);
    const thought = rows[3].detail as { text: string; truncated?: boolean };
    assert.equal(thought.text.length, 4_000);
    assert.equal(thought.truncated, true);
  });
});

describe("thinking, waiting and the summary", () => {
  test("thinking streams in chunks: buffered, then written on a pause, a block change or a step", async () => {
    const { rec } = recorder();
    rec.reasoning("**Checking the ledger**\n", "r1");
    rec.reasoning("Looking at October.", "r1");
    rec.reasoning("Second block.", "r2");
    rec.toolUse("get_finance_report", { report: "profit_and_loss" }, "t");
    await rec.flush();
    const rows = await stored();
    assert.deepEqual(
      rows.map((row) => [row.kind, (row.detail as { block?: string }).block ?? null]),
      [
        ["reasoning", "r1"],
        ["reasoning", "r2"],
        ["tool_use", null],
      ],
    );
    assert.equal(
      (rows[0].detail as { text: string }).text,
      "**Checking the ledger**\nLooking at October.",
    );
    assert.equal(rows[0].summary, "**Checking the ledger**");
  });

  test("waits are recorded with their cause and counted in the summary", async () => {
    const { rec, now } = recorder();
    const start = new Date(now.ms);
    rec.waiting("thread_busy");
    now.ms += 30_000;
    rec.turnStarted("start");
    rec.runtimeWait({ cause: "model_lock", state: "waiting" });
    now.ms += 10_000;
    rec.runtimeWait({ cause: "model_lock", state: "done" });
    rec.modelRetry({ attempt: 2, maxAttempts: 5, delayMs: 4_000, reason: "HTTP 529" });
    rec.runtimeWait({
      cause: "model_unavailable",
      state: "waiting",
      label: "The AI Model is down",
    });
    now.ms += 6_000;
    const summary = rec.summarize({ status: "ok", startedAt: start });
    assert.equal(summary.waitedMs, 30_000 + 10_000 + 4_000 + 6_000);
    assert.equal(summary.durationMs, 46_000);
    await rec.flush();
    const waits = (await stored()).filter((row) => row.kind === "waiting");
    assert.deepEqual(
      waits.map((row) => [row.name, (row.detail as { state: string }).state]),
      [
        ["thread_busy", "waiting"],
        ["model_lock", "waiting"],
        ["model_lock", "done"],
        ["model_retry", "waiting"],
        ["model_unavailable", "waiting"],
      ],
    );
    assert.equal(
      (waits[3].detail as { until: string }).until,
      new Date(now.ms - 6_000 + 4_000).toISOString(),
    );
    assert.equal(waits[4].summary, "The AI Model is down", "a new cause carries its own words");
  });

  test("a stop is written once, and the finish closes the record", async () => {
    const { rec, now } = recorder();
    const startedAt = new Date(now.ms);
    rec.turnStarted("start");
    rec.toolUse("bash", { command: "sleep 60" }, "c");
    rec.stopped();
    rec.stopped();
    now.ms += 2_000;
    const summary = rec.summarize({ status: "interrupted", startedAt });
    await rec.finish(summary);
    rec.toolResult("bash", { content: "late" }, "c");
    await rec.flush();
    const rows = await stored();
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["turn_started", "tool_use", "stopped", "turn_finished"],
    );
    const finished = rows[3].detail as Record<string, unknown>;
    assert.equal(finished.status, "interrupted");
    assert.equal(finished.durationMs, 2_000);
    assert.equal(finished.steps, 1);
    assert.equal(finished.lastOrdinal, 4, "the summary points at the finish event itself");
    assert.equal(rows[3].summary, "Worked for 2s · 1 step");
  });

  test("a refused thinking level is one quiet line, however many requests or copies hear it", async () => {
    const { rec, emitted } = recorder();
    rec.thinkingFallback({ level: "xhigh" });
    // A delegated copy on the same model is refused too; the turn says it once.
    rec.thinkingFallback({ level: "xhigh" });
    await rec.flush();
    const rows = await stored();
    assert.deepEqual(
      rows.map((row) => [row.kind, row.name, row.summary]),
      [
        [
          "notice",
          "thinking_fallback",
          "The AI Model didn't accept the Extra high thinking level; it answers at its own default",
        ],
      ],
    );
    assert.equal(emitted.length, 1);
    const summaryOnly = recorder();
    summaryOnly.rec.thinkingFallback({ level: null });
    assert.equal(
      summaryOnly.emitted[0].summary,
      "The AI Model didn't accept a request for its thinking summary; it answers without one",
    );
  });

  test("the live record receives each event in the same tick it is recorded", () => {
    const live = openLiveTurn("msg_live_tick", "conv");
    const rec = new ChatTurnActivityRecorder({ ...SCOPE, messageId: "msg_live_tick" }, 1, { live });
    const seen: number[] = [];
    live.subscribe((frame) => {
      if (frame.type === "activity") seen.push(frame.event.ordinal);
    });
    rec.toolUse("bash", { command: "ls" }, "c");
    assert.deepEqual(seen, [1], "no await between recording and telling the watchers");
    assert.equal(live.eventsAfter(0).length, 1);
    live.finish();
    releaseLiveTurn(live);
  });
});

describe("reading a turn back", () => {
  test("ordinals continue after whatever an earlier attempt wrote, and readers page by cursor", async () => {
    const first = recorder(await nextChatActivityOrdinal(SCOPE.messageId));
    first.rec.turnStarted("start");
    first.rec.toolUse("bash", { command: "a" }, "1");
    await first.rec.flush();
    assert.equal(await nextChatActivityOrdinal(SCOPE.messageId), 3);
    await recordDetachedChatActivity({ ...SCOPE, attempt: 2 }, (r) =>
      r.notice("retry_requested", "Retry requested"),
    );
    const all = await stored();
    assert.deepEqual(
      all.map((event) => [event.ordinal, event.attempt, event.kind]),
      [
        [1, 1, "turn_started"],
        [2, 1, "tool_use"],
        [3, 2, "notice"],
      ],
    );
    assert.deepEqual(
      (await listChatActivity(SCOPE.messageId, 1, 1)).map((event) => event.ordinal),
      [2],
    );
    assert.deepEqual(await listChatActivity("another-turn", 0, 10), []);
  });

  test("a turn finalized away from its worker is summarized from its rows", async () => {
    const { rec } = recorder();
    rec.toolUse("bash", {}, "a");
    rec.toolResult("bash", { content: "x", isError: true }, "a");
    rec.toolResult("get_self", { content: "{}" }, "orphan");
    rec.reasoning("hm", "r");
    rec.reasoningEnd("r");
    await rec.flush();
    const summary = await summarizeChatActivity({
      messageId: SCOPE.messageId,
      status: "interrupted",
      startedAt: new Date(0),
      endedAt: new Date(5_000),
    });
    assert.equal(summary.steps, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.reasoning, true);
    assert.equal(summary.durationMs, 5_000);
  });

  test("times are kept to the millisecond and a broken detail reads as none", async () => {
    const repo = AppDataSource.getRepository(ConversationActivityEvent);
    const occurredAt = new Date("2026-10-30T10:00:00.123Z");
    const row = await repo.save(
      repo.create({ ...SCOPE, ordinal: 1, kind: "notice", detailJson: "{oops", occurredAt }),
    );
    const read = toChatActivityEvent((await repo.findOneByOrFail({ id: row.id }))!);
    assert.equal(read.at, "2026-10-30T10:00:00.123Z");
    assert.equal(read.detail, null);
  });

  test("a retried turn's clock starts at the retry, a resumed one keeps the first", () => {
    const createdAt = new Date("2026-10-30T10:00:00.000Z");
    assert.equal(
      turnAcceptedAt({ createdAt, turnDeadlineAt: null }).getTime(),
      createdAt.getTime(),
    );
    const retriedAt = new Date("2026-10-30T12:00:00.000Z");
    const deadline = new Date(retriedAt.getTime() + 6 * 60 * 60_000);
    assert.equal(
      turnAcceptedAt({ createdAt, turnDeadlineAt: deadline }).getTime(),
      retriedAt.getTime(),
    );
  });
});
