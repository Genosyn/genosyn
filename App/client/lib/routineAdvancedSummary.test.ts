import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  describeRoutineAdvanced,
  formatTimeout,
  summarizeRoutineAdvanced,
  type RoutineAdvancedValues,
} from "./routineAdvancedSummary";

/** A Routine as the server creates it: every Advanced setting at its default. */
const defaults: RoutineAdvancedValues = {
  folderPath: null,
  timeoutSec: 21600,
  requiresApproval: false,
  outcomeCheck: false,
  checks: 0,
  priority: "normal",
  modelPinned: false,
  browserEnabledOverride: null,
  memberBrowser: false,
  catchUpPolicy: "once",
  maxAttempts: 1,
  retryBackoffSec: 60,
  retryOnTimeout: false,
  triggers: 0,
  webhookEnabled: false,
};

describe("formatTimeout", () => {
  test("reads whole hours and minutes the short way", () => {
    assert.equal(formatTimeout(3600), "1h");
    assert.equal(formatTimeout(7200), "2h");
    assert.equal(formatTimeout(600), "10m");
    assert.equal(formatTimeout(90), "90s");
    assert.equal(formatTimeout(10), "10s");
  });
});

describe("describeRoutineAdvanced", () => {
  test("says so, briefly, when nothing differs from the defaults", () => {
    assert.equal(describeRoutineAdvanced(defaults), "All defaults");
    assert.equal(describeRoutineAdvanced({}), "All defaults");
  });

  test("names only what was changed, in the order the page shows it", () => {
    assert.equal(
      describeRoutineAdvanced({
        ...defaults,
        requiresApproval: true,
        checks: 2,
        triggers: 1,
        webhookEnabled: true,
      }),
      "Approval required · 2 Checks · 1 Trigger · Webhook on",
    );
  });

  test("counts in the singular and the plural", () => {
    assert.equal(describeRoutineAdvanced({ ...defaults, checks: 1 }), "1 Check");
    assert.equal(describeRoutineAdvanced({ ...defaults, checks: 3 }), "3 Checks");
    assert.equal(describeRoutineAdvanced({ ...defaults, triggers: 1 }), "1 Trigger");
    assert.equal(describeRoutineAdvanced({ ...defaults, triggers: 2 }), "2 Triggers");
  });

  test("shows the folder, the timeout and the outcome check when they are set", () => {
    assert.equal(
      describeRoutineAdvanced({
        ...defaults,
        folderPath: "Finance/Month-end",
        timeoutSec: 7200,
        outcomeCheck: true,
      }),
      "Filed in Finance/Month-end · Timeout 2h · Outcome check on",
    );
  });

  test("does not mention a timeout equal to the default", () => {
    assert.equal(describeRoutineAdvanced({ ...defaults, timeoutSec: 21600 }), "All defaults");
    assert.equal(describeRoutineAdvanced({ ...defaults, timeoutSec: 3600 }), "Timeout 1h");
    assert.equal(describeRoutineAdvanced({ ...defaults, timeoutSec: 600 }), "Timeout 10m");
  });

  test("names a High priority, and never the Normal default", () => {
    assert.equal(describeRoutineAdvanced({ ...defaults, priority: "normal" }), "All defaults");
    assert.equal(describeRoutineAdvanced({ ...defaults, priority: "high" }), "High priority");
    // Where the page shows it: after the Checks, first in Execution.
    assert.equal(
      describeRoutineAdvanced({ ...defaults, checks: 2, priority: "high", modelPinned: true }),
      "2 Checks · High priority · Pinned model",
    );
  });

  test("reads the execution settings", () => {
    assert.equal(
      describeRoutineAdvanced({
        ...defaults,
        modelPinned: true,
        browserEnabledOverride: true,
        memberBrowser: true,
      }),
      "Pinned model · Browser forced on · Connected browser",
    );
    assert.equal(
      describeRoutineAdvanced({ ...defaults, browserEnabledOverride: false }),
      "Browser forced off",
    );
  });

  test("reads the reliability settings", () => {
    assert.equal(
      describeRoutineAdvanced({ ...defaults, catchUpPolicy: "skip" }),
      "Skips late catch-up",
    );
    assert.equal(describeRoutineAdvanced({ ...defaults, maxAttempts: 3 }), "3 attempts");
    assert.equal(
      describeRoutineAdvanced({ ...defaults, maxAttempts: 3, retryBackoffSec: 300 }),
      "3 attempts, 5m backoff",
    );
    assert.equal(
      describeRoutineAdvanced({ ...defaults, maxAttempts: 2, retryOnTimeout: true }),
      "2 attempts · Retries timeouts",
    );
  });

  test("ignores backoff and timeout retries while there is a single attempt", () => {
    // The page disables both inputs at one attempt, so a stale value is inert.
    assert.equal(
      describeRoutineAdvanced({
        ...defaults,
        maxAttempts: 1,
        retryBackoffSec: 900,
        retryOnTimeout: true,
      }),
      "All defaults",
    );
  });

  test("leaves out what the caller does not know about", () => {
    assert.equal(
      describeRoutineAdvanced({ requiresApproval: true, webhookEnabled: true }),
      "Approval required · Webhook on",
    );
  });

  test("does not claim all defaults while a count is still loading", () => {
    assert.equal(describeRoutineAdvanced({ ...defaults, checks: null }), "Loading…");
    assert.equal(describeRoutineAdvanced({ ...defaults, triggers: null }), "Loading…");
    // Whatever is already known is shown meanwhile.
    assert.equal(
      describeRoutineAdvanced({ ...defaults, requiresApproval: true, checks: null }),
      "Approval required",
    );
  });
});

describe("summarizeRoutineAdvanced", () => {
  test("reports whether a count is still pending", () => {
    assert.deepEqual(summarizeRoutineAdvanced({ checks: null, triggers: 2 }), {
      items: ["2 Triggers"],
      pending: true,
    });
    assert.deepEqual(summarizeRoutineAdvanced({ checks: 0, triggers: 0 }), {
      items: [],
      pending: false,
    });
  });

  test("treats a blank folder path as unfiled", () => {
    assert.deepEqual(summarizeRoutineAdvanced({ folderPath: "  " }).items, []);
  });
});
