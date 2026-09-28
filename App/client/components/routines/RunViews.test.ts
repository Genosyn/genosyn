import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RunContinuationNotice,
  RunFailureNotice,
  RunStatusChip,
  runLogNeedsPolling,
  mergeRunContinuationState,
} from "@/components/routines/RunViews";
import { RunResumeButton } from "@/components/routines/RunResumeButton";
import { DialogProvider } from "@/components/ui/Dialog";
import { runNeedsAttention } from "@/lib/runStatus";
import type { RunStatus } from "@/lib/api";
import type { Company, Run, RunFollowUp, RunLog } from "@/lib/api";

const followUp = {
  id: "child",
  routineId: "routine",
  status: "running",
  triggerKind: "continuation",
  errorKind: null,
  createdAt: "2026-09-28T08:00:00Z",
  startedAt: "2026-09-28T08:00:00Z",
  finishedAt: null,
  exitCode: null,
  continuationCount: 1,
  retryPending: false,
  awaitingOutcome: false,
  isLatest: true,
} satisfies RunFollowUp;

test("parent links to its running continuation after its own pending stamp clears", () => {
  const html = renderToStaticMarkup(
    React.createElement(RunContinuationNotice, {
      continuationPending: false,
      followUpRun: followUp,
      onOpenRun: () => {},
    }),
  );
  assert.match(html, /Continuation running/);
  assert.match(html, /Open continuation/);
  assert.doesNotMatch(html, /Automatic continuation stopped/);
});

for (const status of [
  "queued",
  "running",
  "completed",
  "failed",
  "error",
  "reviewed",
  "skipped",
] as const) {
  test(`linked ${status} Runs retain their actual status without promising successful delivery`, () => {
    const html = renderToStaticMarkup(
      React.createElement(RunContinuationNotice, {
        continuationStopReason: "Old stop reason",
        followUpRun: { ...followUp, status },
        onOpenRun: () => {},
      }),
    );
    assert.match(html, new RegExp(`Continuation ${status}`));
    assert.match(html, /historical Run keeps its own result/);
    assert.doesNotMatch(html, /Old stop reason|success|verified/);
  });
}

test("ordinary retries and unresolved branches use truthful neutral names", () => {
  const retry = renderToStaticMarkup(
    React.createElement(RunContinuationNotice, {
      followUpRun: { ...followUp, triggerKind: "retry" },
      onOpenRun: () => {},
    }),
  );
  assert.match(retry, /Follow-up running/);
  assert.match(retry, /Open follow-up Run/);
  assert.doesNotMatch(retry, /Continuation/);
  const ambiguous = renderToStaticMarkup(
    React.createElement(RunContinuationNotice, {
      followUpRun: { ...followUp, status: "completed", isLatest: false },
    }),
  );
  assert.match(ambiguous, /Later work exists/);
  assert.doesNotMatch(ambiguous, /completed|success|latest/);
});

test("parent polling covers all later work until its terminal result settles", () => {
  const log: RunLog = { content: "", status: "failed", browserRecordings: [] };
  for (const status of ["queued", "running"] as const)
    assert.equal(runLogNeedsPolling({ ...log, followUpRun: { ...followUp, status } }), true);
  for (const status of ["completed", "failed", "error", "skipped", "reviewed"] as const) {
    assert.equal(runLogNeedsPolling({ ...log, followUpRun: { ...followUp, status } }), false);
    assert.equal(
      runLogNeedsPolling({ ...log, followUpRun: { ...followUp, status, retryPending: true } }),
      true,
    );
  }
  assert.equal(
    runLogNeedsPolling({
      ...log,
      followUpRun: { ...followUp, status: "completed", awaitingOutcome: true },
    }),
    true,
  );
  assert.equal(
    runLogNeedsPolling({
      ...log,
      followUpRun: { ...followUp, status: "completed", isLatest: false },
    }),
    true,
  );
  assert.equal(runLogNeedsPolling({ ...log, followUpRun: null }), false);
});

test("Resume is offered only for a known childless unfinished Run and an administrator", () => {
  const source = {
    id: "parent",
    status: "failed",
    errorKind: null,
    hasUnfinishedWork: true,
    continuationPending: false,
    retryAt: null,
    followUpRun: null,
  } as const;
  const render = (patch: Partial<Run> = {}, role: Company["role"] = "owner") =>
    renderToStaticMarkup(
      React.createElement(
        DialogProvider,
        null,
        React.createElement(RunResumeButton, {
          company: { role } as Company,
          routineName: "Review",
          run: { ...source, ...patch },
          onResumed: () => {},
        }),
      ),
    );
  assert.match(render(), /Resume unfinished work/);
  assert.match(render({}, "admin"), /Resume unfinished work/);
  assert.doesNotMatch(render({}, "member"), /Resume unfinished work/);
  for (const status of ["queued", "running", "completed", "failed", "reviewed", "skipped"] as const)
    assert.doesNotMatch(render({ followUpRun: { ...followUp, status } }), /Resume unfinished work/);
  for (const patch of [
    { followUpRun: undefined },
    { hasUnfinishedWork: false },
    { status: "error" },
    { status: "reviewed" },
    { errorKind: "interrupted" },
    { retryAt: "2026-09-28T10:00:00Z" },
    { continuationPending: true },
  ] satisfies Partial<Run>[])
    assert.doesNotMatch(render(patch), /Resume unfinished work/);
});

test("fresh log metadata updates the selected historical row and authoritative null clears stale relationships", () => {
  const source = { ...followUp, id: "parent", status: "failed", followUpRun: null } as Run;
  const first = mergeRunContinuationState(source, {
    content: "private transcript",
    browserRecordings: [],
    followUpRun: followUp,
  });
  assert.equal(first.id, "parent");
  assert.equal(first.followUpRun?.id, "child");
  assert.equal("content" in first, false);
  // A later list replaces this row, and a later log may then replace it again.
  const refreshedList = {
    ...first,
    followUpRun: { ...followUp, id: "grandchild", status: "queued" as const },
  };
  assert.equal(refreshedList.followUpRun.id, "grandchild");
  const cleared = mergeRunContinuationState(refreshedList, {
    content: "",
    browserRecordings: [],
    followUpRun: null,
  });
  assert.equal(cleared.followUpRun, null);
  assert.equal(cleared.id, source.id);
});

describe("Routine Run failure and error presentation", () => {
  test("distinguishes incomplete work from an operational error", () => {
    const failed = renderToStaticMarkup(React.createElement(RunStatusChip, { status: "failed" }));
    const error = renderToStaticMarkup(React.createElement(RunStatusChip, { status: "error" }));
    assert.match(failed, />failed</);
    assert.match(failed, /did not complete its intended work/);
    assert.match(failed, /bg-rose-50/);
    assert.match(error, />error</);
    assert.match(error, /model request or runtime problem/);
    assert.match(error, /bg-orange-50/);
  });

  for (const [errorKind, detail] of [
    ["timeout", /ran out of time/],
    ["interrupted", /was interrupted/],
  ] as const) {
    test(`new and legacy ${errorKind} Runs both show Error and retain their cause`, () => {
      for (const status of ["error", errorKind] as const) {
        const html = renderToStaticMarkup(
          React.createElement(RunStatusChip, { status, errorKind }),
        );
        assert.match(html, />error</);
        assert.match(html, detail);
        assert.doesNotMatch(html, />timeout<|>interrupted</);
      }
    });
  }

  test("both unsuccessful states and legacy errors remain eligible for attention and manual retry", () => {
    for (const status of ["failed", "error", "timeout", "interrupted"] as const)
      assert.equal(runNeedsAttention(status), true, status);
    for (const status of [
      "queued",
      "running",
      "completed",
      "reviewed",
      "skipped",
      undefined,
    ] as const)
      assert.equal(runNeedsAttention(status), false, status);
  });

  test("other status labels are preserved", () => {
    for (const status of [
      "queued",
      "running",
      "completed",
      "reviewed",
      "skipped",
    ] satisfies RunStatus[]) {
      const html = renderToStaticMarkup(React.createElement(RunStatusChip, { status }));
      assert.match(html, new RegExp(`>${status}</`));
    }
  });

  test("shows the concrete reason as escaped text independently of the transcript", () => {
    const html = renderToStaticMarkup(
      React.createElement(RunFailureNotice, {
        reason: '<script>alert("secret")</script> & missing input',
      }),
    );
    assert.match(html, /Why this Run failed/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&amp; missing input/);
    assert.doesNotMatch(html, /<script>/);
  });

  test("older Runs without a reason do not show an empty failure notice", () => {
    for (const reason of [null, undefined, "", " \n "])
      assert.equal(renderToStaticMarkup(React.createElement(RunFailureNotice, { reason })), "");
  });

  test("unfinished work explains automatic continuation without claiming completion", () => {
    const html = renderToStaticMarkup(
      React.createElement(RunContinuationNotice, { continuationPending: true }),
    );
    assert.match(html, /Continuation scheduled/);
    assert.match(html, /continue unfinished work from its saved progress/);
    assert.match(html, /No setup is needed/);
    assert.doesNotMatch(html, /completed|success/);
    assert.equal(renderToStaticMarkup(React.createElement(RunContinuationNotice, {})), "");
  });

  test("a stopped continuation shows its escaped reason without a scheduled promise", () => {
    const html = renderToStaticMarkup(
      React.createElement(RunContinuationNotice, {
        continuationPending: false,
        continuationStopReason: "No new progress after <previous> continuation.",
      }),
    );
    assert.match(html, /Automatic continuation stopped/);
    assert.match(html, /&lt;previous&gt;/);
    assert.doesNotMatch(html, /Continuation scheduled|No setup is needed/);
  });

  test("a queued continuation keeps polling until its cancel control is no longer current", () => {
    const log = { content: "", status: "failed", browserRecordings: [] } as const;
    assert.equal(
      runLogNeedsPolling({ ...log, browserRecordings: [], continuationPending: true }),
      true,
    );
    assert.equal(
      runLogNeedsPolling({ ...log, browserRecordings: [], continuationPending: false }),
      false,
    );
  });

  test("a queued Run keeps polling until the employee starts and finishes it", () => {
    const log = { content: "", browserRecordings: [] };
    assert.equal(runLogNeedsPolling({ ...log, status: "queued" }), true);
    assert.equal(runLogNeedsPolling({ ...log, status: "running" }), true);
    assert.equal(runLogNeedsPolling({ ...log, status: "completed" }), false);
    const html = renderToStaticMarkup(React.createElement(RunStatusChip, { status: "queued" }));
    assert.match(html, /Waiting in the AI Employee/);
    assert.doesNotMatch(html, /animate-spin/);
  });
});
