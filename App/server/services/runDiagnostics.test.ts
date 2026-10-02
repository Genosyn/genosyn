import assert from "node:assert/strict";
import { test } from "node:test";
import { Run } from "../db/entities/Run.js";
import { RunDiagnosticRecorder, readRunDiagnostics } from "./runDiagnostics.js";
import { publicRun } from "./runContinuationView.js";

function run(overrides: Partial<Run> = {}): Run {
  return Object.assign(
    new Run(),
    {
      status: "error",
      errorKind: "runtime",
      diagnosticsJson: null,
      failureReason: null,
      checksVerdict: "not_run",
      continuationStopReason: null,
      startedAt: new Date(),
      finishedAt: null,
    },
    overrides,
  );
}

test("general Run responses omit raw diagnostics and private recovery requirements", () => {
  const visible = publicRun(
    run({
      diagnosticsJson: "internal observations",
      requiredToolsJson: "private access fingerprints",
    }),
  );
  assert.equal("diagnosticsJson" in visible, false);
  assert.equal("requiredToolsJson" in visible, false);
});

test("concurrent tool failures retain the correct step and redact credentials", () => {
  const recorder = new RunDiagnosticRecorder();
  recorder.phase("work");
  recorder.toolStarted("browser_open", "browser-1");
  recorder.toolStarted("list_contacts", "contacts-1");
  recorder.toolFinished(
    "browser_open",
    {
      isError: true,
      content: "Browser RPC 401: Invalid token; Authorization: Bearer secret-credential-123",
    },
    "browser-1",
  );
  recorder.toolFinished("list_contacts", { content: "done" }, "contacts-1");
  const report = readRunDiagnostics(run({ status: "completed", diagnosticsJson: recorder.json() }));
  assert.equal(report.toolErrors[0].category, "authorization");
  assert.equal(report.toolErrors[0].step?.tool, "browser_open");
  assert.doesNotMatch(JSON.stringify(report), /secret-credential-123/);
  assert.equal(report.failure, null, "a recovered tool error cannot become a terminal failure");
  assert.equal(report.activeSteps.length, 0);
});

test("timeout retains active step even when transcript is no longer available", () => {
  const recorder = new RunDiagnosticRecorder();
  recorder.phase("work");
  recorder.toolStarted("stripe_list_customers", "read-2");
  recorder.fail("The Run exceeded its 60s time budget (deadline 2026-09-21T12:00:00Z).", "timeout");
  const report = readRunDiagnostics(
    run({ errorKind: "timeout", diagnosticsJson: recorder.json(), logContent: "" }),
  );
  assert.equal(report.failure?.category, "timeout");
  assert.equal(report.failure?.phase, "work");
  assert.equal(report.failure?.step?.tool, "stripe_list_customers");
  assert.match(report.failure?.message ?? "", /60s.*deadline/);
});

test("preflight, application and model errors keep their distinct causes", () => {
  const recorder = new RunDiagnosticRecorder();
  const preflight = new Error("Retry requires browser_open, which is unavailable.");
  preflight.name = "RetryPreflightError";
  recorder.fail(preflight, "application");
  assert.equal(
    readRunDiagnostics(run({ diagnosticsJson: recorder.json() })).failure?.phase,
    "preflight",
  );
  assert.equal(
    readRunDiagnostics(run({ diagnosticsJson: recorder.json() })).failure?.category,
    "authorization",
  );
  for (const category of ["application", "model"] as const) {
    recorder.fail(new TypeError("Unexpected response"), category);
    const failure = readRunDiagnostics(run({ diagnosticsJson: recorder.json() })).failure;
    assert.equal(failure?.category, category);
    assert.equal(failure?.exception, "TypeError");
  }
});

test("legacy, interrupted and malformed diagnostics report limitations honestly", () => {
  assert.equal(readRunDiagnostics(run()).failure?.category, "unknown");
  assert.match(
    readRunDiagnostics(run({ diagnosticsJson: "{" })).failure?.message ?? "",
    /not recorded/,
  );
  assert.equal(
    readRunDiagnostics(run({ errorKind: "interrupted" })).failure?.category,
    "interrupted",
  );
  assert.equal(
    readRunDiagnostics(run({ status: "failed", checksVerdict: "failed" })).failure?.category,
    "check",
  );
  assert.equal(
    readRunDiagnostics(run({ status: "failed", failureReason: "Required artifact is absent." }))
      .failure?.message,
    "Required artifact is absent.",
  );
});

test("diagnostics stay bounded across many tool errors", () => {
  const recorder = new RunDiagnosticRecorder();
  for (let n = 0; n < 100; n++) {
    recorder.toolStarted("read", String(n));
    recorder.toolFinished("read", { isError: true, content: "x".repeat(50_000) }, String(n));
  }
  const report = readRunDiagnostics(run({ diagnosticsJson: recorder.json() }));
  assert.equal(report.toolErrors.length, 5);
  assert.ok(recorder.json().length < 15_000);
});

test("whitespace-only tool and fatal errors receive nonempty explanations", () => {
  const recorder = new RunDiagnosticRecorder();
  recorder.toolStarted("read", "blank-error");
  recorder.toolFinished("read", { isError: true, content: " \n\t " }, "blank-error");
  recorder.fail(new Error(" \n\t "), "application");
  const report = readRunDiagnostics(run({ diagnosticsJson: recorder.json() }));
  assert.match(report.failure?.message ?? "", /without an exception message/);
  assert.match(report.toolErrors[0].message, /without details/);
  const corrupted = JSON.parse(recorder.json()) as { failure: { message: string } };
  corrupted.failure.message = " \n ";
  assert.ok(
    readRunDiagnostics(run({ diagnosticsJson: JSON.stringify(corrupted) })).failure?.message.trim(),
  );
  assert.ok(
    readRunDiagnostics(run({ status: "failed", failureReason: " \n " })).failure?.message.trim(),
  );
});

test("the application's No grant error is categorized as authorization", () => {
  const recorder = new RunDiagnosticRecorder();
  recorder.phase("work");
  recorder.toolStarted("get_mail_message", "denied");
  recorder.toolFinished(
    "get_mail_message",
    {
      isError: true,
      content: "No grant: you do not have access to this mailbox.",
    },
    "denied",
  );
  const report = readRunDiagnostics(run({ status: "completed", diagnosticsJson: recorder.json() }));
  assert.equal(report.toolErrors[0].category, "authorization");
  assert.equal(report.toolErrors[0].step?.callId, "denied");
  assert.equal(report.failure, null);
});

// 2026-10-02: a Google Analytics audit Run handed its unfinished work to a
// continuation after 2.5M tokens, and its view said both "Continuation
// scheduled" and "Failure details · unknown · The Run did not finish
// successfully".
test("a Run that handed its work to a continuation reports no invented failure", () => {
  const handoff = {
    status: "failed" as const,
    errorKind: null,
    checkpointJson: JSON.stringify({
      state: "continue",
      completed: "Pulled GA4 totals for both windows.",
      remaining: "Compare landing pages.",
      resume: "Start with the landing-page report.",
      progressKey: "totals",
    }),
  };
  assert.equal(readRunDiagnostics(run(handoff)).failure, null);

  const stored = readRunDiagnostics(run({ status: "failed", errorKind: null }));
  assert.equal(stored.failure?.category, "unknown", "the record an earlier release saved");
  assert.equal(
    readRunDiagnostics(run({ ...handoff, diagnosticsJson: JSON.stringify(stored) })).failure,
    null,
    "a saved invented failure is dropped on read",
  );

  const recorder = new RunDiagnosticRecorder();
  recorder.fail("The AI Model request failed (HTTP 502).", "model");
  assert.equal(
    readRunDiagnostics(run({ ...handoff, diagnosticsJson: recorder.json() })).failure?.category,
    "model",
    "a recorded failure is kept",
  );
  assert.match(
    readRunDiagnostics(
      run({ ...handoff, continuationStopReason: "The original Routine time limit ended." }),
    ).failure?.message ?? "",
    /time limit ended/,
    "a continuation that was stopped still explains why",
  );
  assert.equal(
    readRunDiagnostics(run({ ...handoff, checkpointJson: null })).failure?.category,
    "unknown",
    "a failed Run without saved progress still reports its failure",
  );
});
