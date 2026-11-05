import assert from "node:assert/strict";
import { after, before, beforeEach, describe, mock, test } from "node:test";

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
    // A result's line names no target, so it does not lead into one either.
    assert.equal(results[0].summary, "Sent an email · failed: Recipient refused");
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
    rec.reasoning("t".repeat(20_000), "r1");
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
    assert.equal(thought.text.length, 12_000);
    assert.equal(thought.truncated, true);
  });
});

describe("watching a thought form", () => {
  /** A recorder on a clock these tests move, with its timers under their control. */
  function thinking(context: { mock: Pick<typeof mock, "timers"> }) {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const now = { ms: Date.parse("2026-10-30T10:00:00.000Z") };
    const { rec, emitted } = recorder(1, now);
    const pass = (ms: number) => {
      now.ms += ms;
      context.mock.timers.tick(ms);
    };
    const said = () =>
      emitted
        .filter((event) => event.kind === "reasoning")
        .map((event) => (event.detail as { text: string }).text)
        .join("");
    return { rec, emitted, pass, said };
  }

  test("a model that never pauses is written as it goes, not when it stops", async (context) => {
    const { rec, pass, said } = thinking(context);
    for (let i = 0; i < 60; i += 1) {
      rec.reasoning(`part ${i} of a long thought goes on `, "r1");
      pass(300);
    }
    // 18 seconds of unbroken thinking: this is what used to write nothing at
    // all, and read as a turn with no activity for as long as it went on.
    assert.ok(said().startsWith("part 0 of a long thought"), said());
    assert.ok(said().length > 1_500, `only ${said().length} characters so far`);
    rec.reasoningEnd("r1");
    assert.equal((said().match(/part \d+ of a long/g) ?? []).length, 60, "and none is lost");
    await rec.flush();
    context.mock.timers.reset();
  });

  test("a Secret arriving in pieces across two writes is still scrubbed whole", async (context) => {
    const { rec, pass, said } = thinking(context);
    const secret = "correct-horse-battery-staple-very-long-secret-value";
    rec.setSensitiveValues([secret]);
    rec.reasoning("word ".repeat(120), "r1");
    pass(1_000);
    rec.reasoning(secret.slice(0, 20), "r1");
    pass(500);
    rec.reasoning(`${secret.slice(20)} and then some more words `, "r1");
    pass(1_500);
    rec.reasoningEnd("r1");
    assert.ok(!said().includes("correct-horse"), said());
    assert.ok(!said().includes("very-long-secret"), said());
    assert.match(said(), /\[redacted secret\]/);
    await rec.flush();
    context.mock.timers.reset();
  });

  // A write landing in the middle of any of these must not leave its other half
  // to be written as ordinary words. Scrubbing a piece and keeping the result did:
  // what arrived next landed after the marker, where no pattern could match it.
  for (const [what, head, tail, leaks] of [
    ["a labelled token", "the token=abc", "def123456789XYZ is what it used, ", /def123456789/],
    ["an API key", "the key sk-proj-abcdef", "GHIJKLMNOPQRSTUVWXYZ0123456789 is it, ", /GHIJKL/],
    ["a GitHub token", "the pat ghp_abcdef", "GHIJKLMNOPQRSTUVWXYZ0123456789 is it, ", /GHIJKL/],
    ["a JSON password", '{"password": "hunter', '2hunter2hunter2", "x": 1} and on, ', /2hunter2/],
    ["a bearer token", "Authorization: Bearer abc", "def123456789XYZ and on, ", /def123456789/],
    ["a cookie", "Cookie: session=abc", "def123456789XYZ and on\n", /def123456789/],
    ["a URL's token", "https://x.test/cb?token=abc", "def123456789XYZ and on, ", /def123456789/],
  ] as const) {
    test(`${what} arriving across a write is scrubbed whole`, async (context) => {
      const { rec, pass, said } = thinking(context);
      rec.reasoning("word ".repeat(120), "r1");
      pass(700);
      rec.reasoning(head, "r1");
      pass(800); // The write comes due here, mid-credential.
      rec.reasoning(tail, "r1");
      rec.reasoning("word ".repeat(120), "r1");
      pass(1_500);
      rec.reasoningEnd("r1");
      assert.ok(!leaks.test(said()), said().replace(/(word )+/g, "… "));
      assert.match(said(), /word word/, "and the thought around it is all there");
      await rec.flush();
      context.mock.timers.reset();
    });
  }

  test("a model that stalls in the middle of a Secret writes neither half", async (context) => {
    const { rec, pass, said } = thinking(context);
    rec.setSensitiveValues(["correct-horse-battery-staple-very-long"]);
    rec.reasoning(`${"word ".repeat(120)}correct-horse-`, "r1");
    pass(1_500);
    pass(1_500);
    assert.ok(!said().includes("correct-horse"), said());
    rec.reasoning("battery-staple-very-long and on, ", "r1");
    rec.reasoningEnd("r1");
    assert.ok(!said().includes("correct-horse"), said());
    assert.ok(!said().includes("battery-staple"), said());
    assert.match(said(), /\[redacted secret\] and on/);
    await rec.flush();
    context.mock.timers.reset();
  });

  test("a Secret with spaces in it is held from its first word", async (context) => {
    const { rec, pass, said } = thinking(context);
    rec.setSensitiveValues(["correct horse battery staple"]);
    rec.reasoning(`${"word ".repeat(120)}correct horse `, "r1");
    pass(1_500);
    pass(1_500);
    assert.ok(!said().includes("correct"), said());
    assert.match(said(), /word word/, "the words before it are not held up");
    rec.reasoning("battery staple then more ", "r1");
    rec.reasoningEnd("r1");
    assert.ok(!said().includes("horse"), said());
    await rec.flush();
    context.mock.timers.reset();
  });

  test("a notice in the middle of a thought does not split what is still arriving", async (context) => {
    const { rec, said } = thinking(context);
    rec.setSensitiveValues(["correct-horse-battery-staple"]);
    rec.reasoning("thinking about correct-horse-", "r1");
    rec.notice("compact", "Compacted");
    rec.reasoning("battery-staple and on", "r1");
    rec.reasoningEnd("r1");
    assert.ok(!said().includes("correct-horse"), said());
    assert.equal(said(), "thinking about [redacted secret] and on");
    await rec.flush();
    context.mock.timers.reset();
  });

  test("a private key stays in one piece however many lines it runs to", async (context) => {
    const { rec, pass, said } = thinking(context);
    const line = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5\n";
    rec.reasoning("-----BEGIN PRIVATE KEY-----\n", "r1");
    for (let i = 0; i < 12; i += 1) {
      rec.reasoning(line, "r1");
      pass(500);
    }
    rec.reasoning("-----END PRIVATE KEY-----\n", "r1");
    pass(1_500);
    rec.reasoningEnd("r1");
    assert.ok(!said().includes("QUJDREVG"), said());
    await rec.flush();
    context.mock.timers.reset();
  });

  test("a thought that pauses is written up to its last word, and the end of it at the end", async (context) => {
    const { rec, pass, said, emitted } = thinking(context);
    rec.reasoning("A short thought.", "r1");
    pass(1_500);
    assert.equal(said(), "A short ", "the last word may be a credential still arriving");
    pass(30_000);
    assert.equal(
      emitted.filter((event) => event.kind === "reasoning").length,
      1,
      "and it writes nothing more while nothing more arrives",
    );
    rec.reasoningEnd("r1");
    assert.equal(said(), "A short thought.");
    await rec.flush();
    context.mock.timers.reset();
  });

  test("the words reach the feed exactly as they came, however the writes fall", async (context) => {
    const { rec, pass, said } = thinking(context);
    const words = Array.from({ length: 300 }, (_, i) => `word${i}${i % 9 ? " " : "\n\n"}`);
    for (const [index, word] of words.entries()) {
      rec.reasoning(word, "r1");
      pass(index % 40 === 0 ? 1_600 : 200);
    }
    rec.reasoningEnd("r1");
    assert.equal(said(), words.join(""));
    await rec.flush();
    context.mock.timers.reset();
  });

  test("watching a thought form leaves the turn as many steps to record", async (context) => {
    const { rec, pass, emitted } = thinking(context);
    for (let i = 0; i < 40; i += 1) {
      rec.reasoning(`more words in this thought ${i} `.repeat(4), "r1");
      pass(i % 2 ? 1_500 : 400);
    }
    const written = emitted.filter((event) => event.kind === "reasoning").length;
    assert.ok(written > 10, `${written} writes`);
    rec.reasoningEnd("r1");
    for (let i = 0; i < 1_000; i += 1) rec.notice("x", `notice ${i}`);
    const notices = emitted.filter((event) => event.kind === "notice").length;
    assert.ok(notices >= 998, `${notices} notices: the writes of a thought counted against them`);
    await rec.flush();
    context.mock.timers.reset();
  });
});

describe("what a running command prints", () => {
  function watched() {
    const heard: Array<[string, string]> = [];
    const now = { ms: Date.parse("2026-10-30T10:00:00.000Z") };
    const rec = new ChatTurnActivityRecorder(SCOPE, 1, {
      onToolOutput: (callId, output) => heard.push([callId, output]),
      now: () => now.ms,
    });
    return { rec, heard, now };
  }

  test("goes to whoever is watching, a whole line at a time, and never to a row", async () => {
    const { rec, heard } = watched();
    rec.toolUse("bash", { command: "npm test" }, "c1");
    rec.toolOutput("bash", "line 1\nhalf a li", "c1");
    assert.deepEqual(heard, [["c1", "line 1\n"]]);
    await rec.flush();
    const rows = await stored();
    assert.deepEqual(
      rows.map((row) => row.kind),
      ["tool_use"],
    );
  });

  test("no more than once a second, however fast it prints", () => {
    const { rec, heard, now } = watched();
    rec.toolUse("bash", {}, "c1");
    rec.toolOutput("bash", "one\n", "c1");
    now.ms += 100;
    rec.toolOutput("bash", "one\ntwo\n", "c1");
    assert.equal(heard.length, 1);
    now.ms += 1_000;
    rec.toolOutput("bash", "one\ntwo\nthree\n", "c1");
    assert.deepEqual(heard[1], ["c1", "one\ntwo\nthree\n"]);
  });

  test("is scrubbed like the result will be", () => {
    const { rec, heard } = watched();
    const secret = "correct-horse-battery-staple";
    rec.setSensitiveValues([secret]);
    rec.toolUse("bash", {}, "c1");
    rec.toolOutput("bash", `using ${secret} and token=abc123\nsk-live-1234567890abcdef\n`, "c1");
    const [, text] = heard[0];
    assert.ok(!text.includes(secret), text);
    assert.ok(!text.includes("abc123"), text);
    assert.match(text, /\[redacted secret\]/);
  });

  test("a line the window cut in two, or a key still arriving, is not shown in part", () => {
    const { rec, heard, now } = watched();
    rec.toolUse("bash", {}, "c1");
    const secret = "x".repeat(50);
    rec.setSensitiveValues([secret]);
    rec.toolOutput("bash", `${secret}\n${"line\n".repeat(2_000)}`, "c1");
    assert.ok(heard[0][1].length <= 2_000);
    assert.ok(heard[0][1].startsWith("line\n"));
    now.ms += 1_000;
    rec.toolOutput(
      "bash",
      "done\n-----BEGIN PRIVATE KEY-----\nQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo\n",
      "c1",
    );
    assert.ok(!heard[1][1].includes("QUJD"), heard[1][1]);
  });

  test("a key whose start is off the top of the window shows no part of itself", () => {
    const { rec, heard } = watched();
    const body = Array.from({ length: 51 }, (_, i) => `KEYBODY${i}${"A".repeat(55)}\n`).join("");
    const key = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----\n`;
    rec.toolUse("bash", {}, "c1");
    rec.toolOutput("bash", `$ cat id_rsa\n${key}${"next line of output\n".repeat(60)}`, "c1");
    assert.ok(!heard[0][1].includes("KEYBODY"), heard[0][1]);
    assert.ok(!heard[0][1].includes("-----END"), heard[0][1]);
    assert.match(heard[0][1], /next line of output/);

    const far = watched();
    far.rec.toolUse("bash", {}, "c1");
    far.rec.toolOutput(
      "bash",
      `${"x".repeat(14_000)}\n${key.slice(-2_500)}${"later\n".repeat(50)}`,
      "c1",
    );
    assert.ok(!far.heard[0][1].includes("KEYBODY"), far.heard[0][1]);
  });

  test("a many-line Secret longer than the view is still matched whole", () => {
    const { rec, heard } = watched();
    const secret = Array.from({ length: 40 }, (_, i) => `"field${i}": "value-${i}-${"s".repeat(50)}",`).join(
      "\n",
    );
    rec.setSensitiveValues([secret]);
    rec.toolUse("bash", {}, "c1");
    rec.toolOutput("bash", `${secret}\n${"next line of output\n".repeat(60)}`, "c1");
    assert.ok(!/value-\d+/.test(heard[0][1]), heard[0][1]);
  });

  test("a many-line Secret still arriving shows none of its lines", () => {
    const { rec, heard, now } = watched();
    const secret = "first line of it\nsecond line of it\nthird line of it";
    rec.setSensitiveValues([secret]);
    rec.toolUse("bash", {}, "c1");
    rec.toolOutput("bash", "before\nfirst line of it\nsecond line of it\n", "c1");
    assert.deepEqual(heard, [["c1", "before\n"]]);
    now.ms += 1_000;
    rec.toolOutput("bash", `before\n${secret}\nafter\n`, "c1");
    assert.equal(heard[1][1], "before\n[redacted secret]\nafter\n");
  });

  test("a line of nothing but output too long for the window shows nothing rather than a part", () => {
    const { rec, heard } = watched();
    rec.toolUse("bash", {}, "c1");
    rec.toolOutput("bash", "y".repeat(10_000), "c1");
    assert.deepEqual(heard, []);
  });

  test("a turn that keeps no payloads shows none of this, and a call that ended none either", () => {
    const { rec, heard, now } = watched();
    rec.toolUse("bash", {}, "c1");
    rec.toolResult("bash", { content: "done" }, "c1");
    rec.toolOutput("bash", "late\n", "c1");
    assert.deepEqual(heard, []);
    rec.toolUse("bash", {}, "c2");
    rec.withholdPayloads("discussion");
    now.ms += 2_000;
    rec.toolOutput("bash", "kept back\n", "c2");
    assert.deepEqual(heard, []);
  });

  test("the live record keeps the latest for a reader attaching now, until the call returns", () => {
    const live = openLiveTurn("msg_output", "conv_activity");
    const rec = new ChatTurnActivityRecorder({ ...SCOPE, messageId: "msg_output" }, 1, { live });
    rec.toolUse("bash", {}, "c1");
    rec.toolOutput("bash", "one\n", "c1");
    assert.equal(live.toolOutputs.get("c1"), "one\n");
    rec.toolResult("bash", { content: "one\n" }, "c1");
    assert.equal(live.toolOutputs.size, 0);
    live.finish();
    releaseLiveTurn(live);
  });
});

describe("the AI Model's own record", () => {
  const CALL = {
    request: 1,
    model: "claude-opus-5-5",
    sentAt: "2026-10-30T10:00:00.000Z",
    durationMs: 42_000,
    phases: [
      { kind: "waiting" as const, startedAt: "2026-10-30T10:00:00.000Z", ms: 2_000 },
      { kind: "thinking" as const, startedAt: "2026-10-30T10:00:02.000Z", ms: 30_000 },
      {
        kind: "tool_input" as const,
        startedAt: "2026-10-30T10:00:32.000Z",
        ms: 10_000,
        tool: "bash",
      },
    ],
    inputTokens: 1_000,
    outputTokens: 400,
    stopReason: "tool_use",
  };

  test("a pulse goes to the live record and whoever is watching, and never to a row", async () => {
    const live = openLiveTurn("msg_pulse", "conv_activity");
    const heard: unknown[] = [];
    const rec = new ChatTurnActivityRecorder({ ...SCOPE, messageId: "msg_pulse" }, 1, {
      live,
      onPulse: (pulse) => heard.push(pulse),
    });
    const pulse = {
      state: "thinking" as const,
      label: null,
      model: "m",
      request: 1,
      tool: null,
      since: "2026-10-30T10:00:00.000Z",
      sentAt: "2026-10-30T10:00:00.000Z",
      lastDataAt: "2026-10-30T10:00:00.000Z",
      chars: 0,
      outputTokens: 0,
      now: "2026-10-30T10:00:00.000Z",
    };
    rec.modelPulse(pulse);
    assert.deepEqual(heard, [pulse]);
    assert.deepEqual(live.latestPulse, pulse);
    await rec.flush();
    assert.deepEqual(await stored("msg_pulse"), [], "nothing was written");
    live.finish();
    releaseLiveTurn(live);
  });

  test("a finished request is one row, and the summary adds them up", async () => {
    const { rec } = recorder();
    rec.modelCall(CALL);
    rec.modelCall({
      ...CALL,
      request: 2,
      phases: [{ kind: "thinking", startedAt: "2026-10-30T10:01:00.000Z", ms: 5_000 }],
      inputTokens: null,
      outputTokens: 100,
    });
    await rec.flush();
    const rows = await stored();
    assert.deepEqual(
      rows.map((row) => [row.kind, row.name]),
      [
        ["model_call", "1"],
        ["model_call", "2"],
      ],
    );
    assert.equal((rows[0].detail as { durationMs: number }).durationMs, 42_000);
    const summary = rec.summarize({
      status: "ok",
      startedAt: new Date("2026-10-30T10:00:00.000Z"),
    });
    assert.equal(summary.modelCalls, 2);
    assert.equal(summary.thinkingMs, 35_000);
    assert.equal(summary.inputTokens, 1_000);
    assert.equal(summary.outputTokens, 500);
    assert.equal(summary.model, "claude-opus-5-5");
    assert.equal(summary.steps, 0, "a request to the AI Model is not a step");
  });

  test("a turn finalized on another replica counts its requests from the rows", async () => {
    const { rec } = recorder();
    rec.modelCall(CALL);
    await rec.flush();
    const summary = await summarizeChatActivity({
      messageId: SCOPE.messageId,
      status: "interrupted",
      startedAt: new Date("2026-10-30T10:00:00.000Z"),
      endedAt: new Date("2026-10-30T10:01:00.000Z"),
    });
    assert.equal(summary.modelCalls, 1);
    assert.equal(summary.thinkingMs, 30_000);
    assert.equal(summary.outputTokens, 400);
    assert.equal(summary.steps, 0);
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
