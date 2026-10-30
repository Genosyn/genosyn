import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  isModelWaitLabel,
  MODEL_UNAVAILABLE_REPLY,
  MODEL_WAIT_PROGRESS_LABEL,
  nextCheckText,
  unavailableReasonText,
  waitingWorkText,
  type PublicModelAvailability,
} from "../../shared/modelAvailability";
import { modelOutageNotice } from "./modelOutage";
import { runPauseWhy, runStatusHint } from "./runStatus";

const NOW = Date.parse("2026-10-30T15:00:00Z");

const unavailable = (
  overrides: Partial<Extract<PublicModelAvailability, { state: "unavailable" }>> = {},
): PublicModelAvailability => ({
  state: "unavailable",
  since: "2026-10-30T14:42:00Z",
  reason: "overloaded",
  detail: "The AI Model is overloaded (HTTP 529, overloaded_error).",
  checks: 0,
  lastCheckedAt: null,
  nextCheckAt: "2026-10-30T15:04:00Z",
  checking: false,
  waiting: { runs: 3, chats: 1 },
  ...overrides,
});

describe("the notice on an unavailable AI Model's card", () => {
  test("says since when, why, what waits and when it is checked next", () => {
    const notice = modelOutageNotice(unavailable(), NOW);
    assert.ok(notice);
    assert.match(notice.headline, /^Unavailable since .+\. Its service is overloaded\.$/);
    assert.equal(notice.detail, "The AI Model is overloaded (HTTP 529, overloaded_error).");
    assert.equal(
      notice.work,
      "3 Runs and 1 chat message are waiting. AI work on it waits instead of failing and carries on by itself once it answers again.",
    );
    assert.equal(notice.nextCheck, "Next check in 4 min");
    assert.equal(notice.checks, null, "no check has run yet");
  });

  test("counts the checks that found it still down, and says when one is running", () => {
    const notice = modelOutageNotice(
      unavailable({ checks: 2, lastCheckedAt: "2026-10-30T14:55:00Z", checking: true }),
      NOW,
    );
    assert.equal(notice?.checks, "2 checks found it still unavailable, the last 5 min ago.");
    assert.equal(notice?.nextCheck, "Checking now…");
  });

  test("with nothing waiting it still says the work would wait", () => {
    const notice = modelOutageNotice(unavailable({ waiting: { runs: 0, chats: 0 } }), NOW);
    assert.equal(
      notice?.work,
      "AI work on it waits instead of failing and carries on by itself once it answers again.",
    );
  });

  test("an available model, or an older server that says nothing, shows no notice", () => {
    assert.equal(modelOutageNotice({ state: "available" }, NOW), null);
    assert.equal(modelOutageNotice(undefined, NOW), null);
  });
});

describe("the shared words", () => {
  test("every reason reads as a sentence", () => {
    for (const reason of ["unreachable", "timeout", "server_error", "overloaded", "rate_limited"] as const) {
      assert.match(unavailableReasonText(reason), /^[A-Z].+[^.]$/);
    }
  });

  test("waiting work, singular and plural", () => {
    assert.equal(waitingWorkText({ runs: 1, chats: 0 }), "1 Run is waiting");
    assert.equal(waitingWorkText({ runs: 0, chats: 2 }), "2 chat messages are waiting");
    assert.equal(waitingWorkText({ runs: 2, chats: 1 }), "2 Runs and 1 chat message are waiting");
    assert.equal(waitingWorkText({ runs: 0, chats: 0 }), null);
  });

  test("other work that waits — an email's read, a paused Pipeline run, an answer owed — is counted too", () => {
    assert.equal(waitingWorkText({ runs: 0, chats: 0, other: 1 }), "1 piece of work is waiting");
    assert.equal(waitingWorkText({ runs: 0, chats: 0, other: 3 }), "3 pieces of work are waiting");
    assert.equal(
      waitingWorkText({ runs: 1, chats: 0, other: 2 }),
      "1 Run and 2 other pieces of work are waiting",
    );
    assert.equal(
      waitingWorkText({ runs: 2, chats: 1, other: 1 }),
      "2 Runs, 1 chat message and 1 other piece of work are waiting",
    );
    assert.equal(waitingWorkText({ runs: 0, chats: 0, other: 0 }), null);
  });

  test("when the next check is", () => {
    assert.equal(nextCheckText("2026-10-30T15:00:03Z", NOW), "now");
    assert.equal(nextCheckText("2026-10-30T15:00:40Z", NOW), "in 40 s");
    assert.equal(nextCheckText("2026-10-30T15:10:00Z", NOW), "in 10 min");
    assert.equal(nextCheckText("2026-10-30T17:00:00Z", NOW), "in 2 h");
    assert.equal(nextCheckText("garbage", NOW), "soon");
  });

  test("a chat reply's progress line is recognised as waiting for its model", () => {
    assert.equal(isModelWaitLabel(MODEL_WAIT_PROGRESS_LABEL), true);
    assert.equal(isModelWaitLabel("Waiting for another reply"), false);
    assert.equal(isModelWaitLabel(null), false);
  });

  test("the reply an outside conversation gets names no model or endpoint", () => {
    assert.doesNotMatch(MODEL_UNAVAILABLE_REPLY, /http|api\.|HTTP|\d{3}/);
    assert.match(MODEL_UNAVAILABLE_REPLY, /AI Model is unavailable/);
  });
});

describe("a paused Run's status", () => {
  test("says why it waits: a restart, or its AI Model", () => {
    assert.match(runStatusHint("queued", null, true, "outage") ?? "", /while its AI Model was unavailable/);
    assert.match(runStatusHint("queued", null, true, "restart") ?? "", /while Genosyn restarted/);
    assert.match(runStatusHint("queued", null, true, null) ?? "", /while Genosyn restarted/, "older pauses were restarts");
    assert.equal(runPauseWhy("outage"), "while its AI Model was unavailable");
    assert.equal(runPauseWhy(undefined), "while Genosyn restarted");
  });
});
