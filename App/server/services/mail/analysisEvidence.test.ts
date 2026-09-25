import assert from "node:assert/strict";
import { test } from "node:test";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import {
  analysisAttemptSnapshot,
  analysisDetailsFromSnapshot,
  analysisMetadata,
  analysisPreview,
  mailAnalysisPhase,
} from "./analysisEvidence.js";

const startedAt = new Date("2026-09-25T10:00:00.000Z");
function row(overrides: Partial<MailInboundAnalysis> = {}): MailInboundAnalysis {
  return Object.assign(new MailInboundAnalysis(), {
    category: "quote_request",
    summary: "The customer asks for a quote for three seats.",
    actionsJson: JSON.stringify([
      {
        id: "0",
        kind: "draft_reply",
        label: "Prepare a reply",
        bodyText: "private reply body",
        targetTo: "private@example.test",
      },
      {
        id: "1",
        kind: "hand_over",
        label: "Ask Sales to review",
        instruction: "private handover instructions",
        employeeId: "private-employee",
      },
      {
        id: "2",
        kind: "create_estimate",
        label: "Prepare a quote",
        lines: [{ description: "private line item", unitPriceCents: 29000 }],
      },
    ]),
    errorMessage: "",
    finishedAt: new Date(startedAt.getTime() + 12_000),
    ...overrides,
  });
}

test("snapshots retain only the completed attempt's bounded presentation fields", () => {
  const snapshot = analysisAttemptSnapshot(row(), "completed", startedAt);
  assert.deepEqual(snapshot, {
    version: 1,
    status: "completed",
    durationMs: 12_000,
    category: "quote_request",
    summary: "The customer asks for a quote for three seats.",
    suggestedActions: ["Prepare a reply", "Ask Sales to review", "Prepare a quote"],
  });
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private|bodyText|instruction|unitPriceCents|targetTo/,
  );
});

test("started and failed snapshots never retain stale successful results", () => {
  assert.deepEqual(analysisAttemptSnapshot(row(), "started", startedAt), {
    version: 1,
    status: "started",
    durationMs: null,
  });
  assert.deepEqual(
    analysisAttemptSnapshot(row({ errorMessage: "Model quota exhausted." }), "failed", startedAt),
    {
      version: 1,
      status: "failed",
      durationMs: 12_000,
      error: "Model quota exhausted.",
    },
  );
});

test("redacts credentials in every persisted preview and again on reading", () => {
  const snapshot = analysisAttemptSnapshot(
    row({
      category: "token=category-secret",
      summary: "Read https://example.test/quote?token=summary-secret#fragment-secret",
      actionsJson: JSON.stringify([{ label: "Reply with password=label-secret" }]),
    }),
    "completed",
    startedAt,
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /category-secret|summary-secret|fragment-secret|label-secret/,
  );
  const legacyWriter = {
    version: 1,
    status: "failed",
    durationMs: 100,
    error: "Model rejected Bearer error-secret with api_key=key-secret",
  };
  const read = analysisDetailsFromSnapshot("failed", legacyWriter);
  assert.doesNotMatch(JSON.stringify(read), /error-secret|key-secret/);
  assert.match(read.error!, /redacted/);
});

test("bounds untrusted headers, summaries, categories, actions, and error text", () => {
  assert.equal(analysisPreview("x".repeat(1000), 300).length, 300);
  assert.equal(analysisPreview("  two\n words\t", 30), "two words");
  assert.equal(analysisPreview(null, 30), "");
  const saved = analysisAttemptSnapshot(
    row({
      category: "c".repeat(1000),
      summary: "s".repeat(1000),
      actionsJson: JSON.stringify(
        Array.from({ length: 20 }, () => ({ label: "l".repeat(1000), bodyText: "never copy" })),
      ),
    }),
    "completed",
    startedAt,
  );
  const details = analysisDetailsFromSnapshot("completed", saved);
  assert.equal(details.category?.length, 60);
  assert.equal(details.summary?.length, 240);
  assert.equal(details.suggestedActions.length, 4);
  assert.ok(details.suggestedActions.every((label) => label.length === 60));
  const failed = analysisDetailsFromSnapshot(
    "failed",
    analysisAttemptSnapshot(row({ errorMessage: "e".repeat(1000) }), "failed", startedAt),
  );
  assert.equal(failed.error?.length, 500);
});

test("redaction happens before clipping a credential at the display bound", () => {
  const prefix = "s".repeat(210) + " ";
  assert.doesNotMatch(analysisPreview(prefix + "password=" + "secret".repeat(100), 240), /secret/);
});

test("reads only the recorded phase and never interprets result payloads as actions", () => {
  const snapshot = analysisAttemptSnapshot(row(), "completed", startedAt);
  for (const phase of ["started", "failed"] as const) {
    const details = analysisDetailsFromSnapshot(phase, snapshot);
    assert.equal(details.resultAvailable, false);
    assert.equal(details.summary, null);
    assert.deepEqual(details.suggestedActions, []);
  }
  const details = analysisDetailsFromSnapshot("completed", {
    ...snapshot,
    suggestedActions: [null, { label: "execute this" }, "safe label", 123],
    actionsJson: "private payload",
    bodyText: "private body",
    instruction: "private instruction",
  });
  assert.equal(details.resultAvailable, false);
  assert.deepEqual(details.suggestedActions, []);
  assert.doesNotMatch(JSON.stringify(details), /private|execute this/);
});

test("formatted credential labels are normalized before snapshots and responses are redacted", () => {
  const value =
    "**Password:** bold-secret; `api_key`: code-secret; _token_: italic-secret; *secret*: star-secret";
  assert.doesNotMatch(
    analysisPreview(value, 500),
    /bold-secret|code-secret|italic-secret|star-secret/,
  );
  const snapshot = analysisAttemptSnapshot(row({ errorMessage: value }), "failed", startedAt);
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /bold-secret|code-secret|italic-secret|star-secret/,
  );
});

test("malformed suggestions never become a recorded absence of suggestions", () => {
  for (const actionsJson of ["{bad", "null", "{}", '[{"id":"0"}]', '[{"label":null}]']) {
    const snapshot = analysisAttemptSnapshot(row({ actionsJson }), "completed", startedAt);
    assert.equal(analysisDetailsFromSnapshot("completed", snapshot).resultAvailable, false);
  }
  for (const suggestedActions of [[null], [123], [{}], [""], ["valid", {}]]) {
    assert.equal(
      analysisDetailsFromSnapshot("completed", {
        version: 1,
        status: "completed",
        summary: "A summary",
        suggestedActions,
      }).resultAvailable,
      false,
    );
  }
});

test("distinguishes a recorded empty suggestions list from unavailable history", () => {
  const available = analysisDetailsFromSnapshot("completed", {
    version: 1,
    status: "completed",
    summary: "No response needed.",
    suggestedActions: [],
  });
  assert.equal(available.resultAvailable, true);
  for (const snapshot of [
    null,
    [],
    {},
    { version: 2 },
    { version: 1, status: "completed", summary: "Old summary" },
  ]) {
    assert.equal(analysisDetailsFromSnapshot("completed", snapshot).resultAvailable, false);
  }
});

test("invalid and absent durations stay unknown", () => {
  for (const durationMs of [-1, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.2, "1000", undefined]) {
    const details = analysisDetailsFromSnapshot("failed", {
      version: 1,
      status: "failed",
      error: "Failed",
      durationMs,
    });
    assert.equal(details.durationMs, null);
  }
});

test("malformed metadata and actions stay harmless and action matching is exact", () => {
  for (const input of ["", "{bad", "null", "[]", '"text"', "123"])
    assert.deepEqual(analysisMetadata(input), {});
  assert.equal(
    analysisAttemptSnapshot(row({ actionsJson: "{bad" }), "completed", startedAt).suggestedActions,
    undefined,
  );
  for (const action of [
    "mail.analysis",
    "mail.analysis.create_invoice",
    "mail.analysis.started.extra",
    "invoice.completed",
  ])
    assert.equal(mailAnalysisPhase(action), null);
  assert.equal(mailAnalysisPhase("mail.analysis.completed"), "completed");
});
