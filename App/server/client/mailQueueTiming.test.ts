import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  activeMailQueueBatch,
  approximateMailQueueDuration,
  mailQueueEtaLabel,
} from "../../client/lib/mailQueueTiming.js";

describe("mail queue ETA display", () => {
  test("uses a calm sub-minute label for finished and nearly finished queues", () => {
    assert.equal(approximateMailQueueDuration(0), "less than a minute");
    assert.equal(approximateMailQueueDuration(-1), "less than a minute");
    assert.equal(approximateMailQueueDuration(30_000), "about 1 minute");
  });

  test("rounds partial minutes up so the ETA is not understated", () => {
    assert.equal(approximateMailQueueDuration(60_001), "about 2 minutes");
    assert.equal(approximateMailQueueDuration(59 * 60_000), "about 59 minutes");
  });

  test("formats hour boundaries and mixed hour-minute durations", () => {
    assert.equal(approximateMailQueueDuration(60 * 60_000), "about 1 hour");
    assert.equal(approximateMailQueueDuration(120 * 60_000), "about 2 hours");
    assert.equal(approximateMailQueueDuration(151 * 60_000), "about 2h 31m");
  });

  test("pairs the local finish time with the relative estimate", () => {
    const now = Date.parse("2026-07-29T10:00:00.000Z");
    const label = mailQueueEtaLabel("2026-07-29T10:08:01.000Z", now, () => "11:08 AM");
    assert.equal(label, "Estimated finish 11:08 AM · about 9 minutes");
  });

  test("refuses invalid completion timestamps", () => {
    assert.equal(mailQueueEtaLabel("not-a-date"), null);
  });

  test("keeps active progress and dismisses both terminal outcomes", () => {
    const queued = { id: "queued", status: "queued" };
    const running = { id: "running", status: "running" };
    assert.equal(activeMailQueueBatch(queued), queued);
    assert.equal(activeMailQueueBatch(running), running);
    assert.equal(activeMailQueueBatch({ id: "done", status: "completed" }), null);
    assert.equal(activeMailQueueBatch({ id: "failed", status: "completed_with_errors" }), null);
    assert.equal(activeMailQueueBatch(null), null);
  });
});
