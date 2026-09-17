import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunFailureNotice, RunStatusChip } from "@/components/routines/RunViews";
import { runNeedsAttention } from "@/lib/runStatus";
import type { RunStatus } from "@/lib/api";

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
    for (const status of ["running", "completed", "reviewed", "skipped", undefined] as const)
      assert.equal(runNeedsAttention(status), false, status);
  });

  test("other status labels are preserved", () => {
    for (const status of ["running", "completed", "reviewed", "skipped"] satisfies RunStatus[]) {
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
});
