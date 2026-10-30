import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  approvalHeldIn,
  describeChatToolCall,
  describeTurnSummary,
  formatElapsed,
  formatStepDuration,
  isQuietChatTool,
  parseTurnActivitySummary,
  shortPath,
  shortUrl,
} from "../../shared/chatActivity";
import { shouldShowTurnSummary, turnSummaryLabel } from "../components/chat/TurnActivity";

/**
 * The words a step is shown with. Shared with the server, which writes each
 * event's one-line summary from the same function, so these are the labels a
 * Member reads live, after a reload and next week.
 */

describe("a step's label", () => {
  test("the tools people meet most are worded by hand, in both tenses", () => {
    const cases: Array<[string, Record<string, unknown>, string, string, string]> = [
      [
        "bash",
        { command: "npm test -- --watch=false" },
        "Running",
        "Ran",
        "npm test -- --watch=false",
      ],
      [
        "search_web",
        { query: "spot GPU pricing" },
        "Searching the web for",
        "Searched the web for",
        "“spot GPU pricing”",
      ],
      [
        "fetch_web_page",
        { url: "https://www.daytona.io/pricing?ref=x" },
        "Opening",
        "Opened",
        "daytona.io/pricing",
      ],
      [
        "list_banking_transactions",
        { status: "unreviewed" },
        "Searching Banking transactions",
        "Searched Banking transactions",
        "unreviewed",
      ],
      [
        "search_mail",
        { query: "invoice from Daytona" },
        "Searching email for",
        "Searched email for",
        "“invoice from Daytona”",
      ],
      [
        "send_mail",
        { to: ["ana@acme.com", "bo@acme.com"] },
        "Sending an email to",
        "Sent an email to",
        "ana@acme.com, bo@acme.com",
      ],
      ["read", { filePath: "src/app.ts" }, "Reading", "Read", "src/app.ts"],
      ["browser_snapshot", {}, "Reading the page", "Read the page", ""],
      [
        "find_tools",
        { query: "banking" },
        "Looking for the right tool",
        "Looked for the right tool",
        "“banking”",
      ],
    ];
    for (const [name, input, active, done, target] of cases) {
      const described = describeChatToolCall(name, input);
      assert.equal(described.active, active, name);
      assert.equal(described.done, done, name);
      assert.equal(described.target, target, name);
    }
    assert.equal(describeChatToolCall("bash", { command: "ls" }).code, true);
    assert.equal(describeChatToolCall("search_web", { query: "x" }).family, "web");
  });

  test("every other tool reads from its own name", () => {
    assert.equal(describeChatToolCall("list_invoices", {}).active, "Listing invoices");
    assert.equal(describeChatToolCall("get_customer", {}).done, "Read customer");
    assert.equal(
      describeChatToolCall("create_todo", { title: "Call Ana" }).active,
      "Creating task",
    );
    assert.equal(describeChatToolCall("create_todo", { title: "Call Ana" }).target, "Call Ana");
    assert.equal(
      describeChatToolCall("update_finance_transaction", {}).active,
      "Updating Finance transaction",
    );
    assert.equal(
      describeChatToolCall("list_contacts", { query: "acme" }).active,
      "Searching contacts",
    );
    assert.equal(describeChatToolCall("get_mail_thread", {}).family, "mail");
  });

  test("an Integration's or MCP server's tool is used, whatever its name", () => {
    const described = describeChatToolCall("stripe_refund_charge", { charge: "ch_1" });
    assert.equal(described.active, "Using stripe refund charge");
    assert.equal(described.done, "Used stripe refund charge");
    assert.equal(describeChatToolCall("", null).active, "Using a tool");
  });

  test("a worker's call and an OpenCode wire name both resolve to the tool", () => {
    const worker = describeChatToolCall("[worker:Pricing] search_web", { query: "spot" });
    assert.equal(worker.worker, "Pricing");
    assert.equal(worker.active, "Searching the web for");
    assert.equal(
      describeChatToolCall("genosyn_search_web", { query: "spot" }).active,
      "Searching the web for",
    );
  });

  test("a listing's period is its target when it names no query", () => {
    assert.equal(
      describeChatToolCall("list_finance_transactions", { from: "2026-10-01", to: "2026-10-31" })
        .target,
      "2026-10-01 – 2026-10-31",
    );
    assert.equal(
      describeChatToolCall("list_bills", { after: "2026-09-01T00:00:00Z" }).target,
      "since 2026-09-01",
    );
  });

  test("a value that is or may be a secret is never the target", () => {
    assert.equal(
      describeChatToolCall("browser_fill", { selector: "#pw", value: "hunter2" }).target,
      "",
    );
    assert.equal(describeChatToolCall("create_vault_login", { name: "[redacted]" }).target, "");
    assert.equal(describeChatToolCall("update_note", { body: "secret plans" }).target, "");
  });

  test("long arguments are shortened where it matters", () => {
    assert.equal(shortUrl("not a url"), "not a url");
    assert.equal(shortUrl("https://example.com/"), "example.com");
    const path = `/${"a/".repeat(40)}EmployeeChat.tsx`;
    assert.ok(shortPath(path).endsWith("EmployeeChat.tsx"));
    assert.ok(shortPath(path).length <= 60);
    const long = describeChatToolCall("search_web", { query: "x".repeat(200) }).target;
    assert.ok(long.length <= 62);
  });

  test("progress reports are left out of the list; held calls are recognized", () => {
    assert.equal(isQuietChatTool("report_progress"), true);
    assert.equal(isQuietChatTool("[worker:A] genosyn_report_progress"), true);
    assert.equal(isQuietChatTool("bash"), false);
    assert.deepEqual(
      approvalHeldIn(
        JSON.stringify({
          status: "pending_approval",
          approvalId: "0f8fad5b-d9cb-469f-a165-70867728950e",
        }),
      ),
      { id: "0f8fad5b-d9cb-469f-a165-70867728950e" },
    );
    assert.deepEqual(
      approvalHeldIn("Approval queued. status: pending_approval. approvalId: abc."),
      { id: null },
    );
    assert.equal(approvalHeldIn("All good"), null);
  });
});

describe("a finished turn's line", () => {
  const summary = {
    startedAt: "2026-10-30T10:00:00.000Z",
    endedAt: "2026-10-30T10:02:14.000Z",
    durationMs: 134_000,
    steps: 9,
    failed: 1,
    held: 0,
    waitedMs: 0,
    reasoning: true,
    lastOrdinal: 20,
    status: "ok",
  };

  test("reads like a sentence", () => {
    assert.equal(describeTurnSummary(summary), "Worked for 2m 14s · 9 steps · 1 failed");
    assert.equal(turnSummaryLabel(summary), "Worked for 2m 14s · 9 steps");
    assert.equal(turnSummaryLabel({ ...summary, steps: 1 }), "Worked for 2m 14s · 1 step");
    assert.equal(turnSummaryLabel({ ...summary, steps: 0 }), "Thought for 2m 14s");
    assert.equal(turnSummaryLabel({ ...summary, steps: 0, reasoning: false }), "Worked for 2m 14s");
  });

  test("a quick answer with nothing to show has no line", () => {
    assert.equal(shouldShowTurnSummary(null), false);
    assert.equal(
      shouldShowTurnSummary({ ...summary, steps: 0, reasoning: false, durationMs: 3_000 }),
      false,
    );
    assert.equal(
      shouldShowTurnSummary({ ...summary, steps: 0, reasoning: false, durationMs: 20_000 }),
      true,
    );
    assert.equal(
      shouldShowTurnSummary({
        ...summary,
        steps: 0,
        reasoning: false,
        waitedMs: 5_000,
        durationMs: 6_000,
      }),
      true,
    );
  });

  test("a stored summary is read tolerantly", () => {
    assert.deepEqual(parseTurnActivitySummary(JSON.stringify(summary)), summary);
    assert.equal(parseTurnActivitySummary(""), null);
    assert.equal(parseTurnActivitySummary("{not json"), null);
    assert.equal(parseTurnActivitySummary(JSON.stringify({ steps: 2 })), null);
    const partial = parseTurnActivitySummary(
      JSON.stringify({ startedAt: summary.startedAt, endedAt: summary.endedAt, steps: -3 }),
    );
    assert.equal(partial?.steps, 0);
    assert.equal(partial?.status, "ok");
  });

  test("durations: tenths below ten seconds, a clock above", () => {
    assert.equal(formatStepDuration(40), "0.1s");
    assert.equal(formatStepDuration(4_240), "4.2s");
    assert.equal(formatStepDuration(42_000), "42s");
    assert.equal(formatStepDuration(-1), "");
    assert.equal(formatElapsed(Number.NaN), "0s");
  });
});
