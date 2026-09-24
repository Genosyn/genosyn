import assert from "node:assert/strict";
import { test } from "node:test";
import { Run } from "../db/entities/Run.js";
import { publicRun } from "./runContinuationView.js";

test("newly enqueued Run responses omit private dispatch authority", () => {
  const run = Object.assign(new Run(), {
    id: "queued-run",
    status: "queued",
    createdAt: new Date("2026-09-24T12:00:00Z"),
    queueActiveEmployeeId: "private-slot",
    queueOptionsJson: JSON.stringify({ proactiveApprovalId: "private-approval" }),
    checkpointJson: null,
  });
  const visible = publicRun(run);
  assert.equal(visible.status, "queued");
  assert.equal(visible.queuedAt, run.createdAt);
  assert.equal("queueOptionsJson" in visible, false);
  assert.equal("queueActiveEmployeeId" in visible, false);
  assert.doesNotMatch(JSON.stringify(visible), /private-slot|private-approval/);
});
