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
