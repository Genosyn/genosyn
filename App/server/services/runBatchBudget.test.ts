import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_BATCH_TOKEN_TARGET, shouldYieldRunBatch } from "./runBatchBudget.js";
import { CONTINUATION_TOKEN_LIMIT, MAX_RUN_CONTINUATIONS } from "./runContinuation.js";

const boundary = {
  toolName: "save_run_checkpoint",
  result: { content: JSON.stringify({ ok: true, state: "continue" }) },
  tokensThisRun: RUN_BATCH_TOKEN_TARGET,
  previousTokens: 0,
  continuationCount: 0,
  deadlineAtMs: 60_000,
  now: 0,
  canContinue: true,
};

test("batch handoff needs a successful actionable checkpoint after the soft token threshold", () => {
  assert.equal(shouldYieldRunBatch(boundary), true);
  for (const patch of [
    { toolName: "send_email" },
    { tokensThisRun: RUN_BATCH_TOKEN_TARGET - 1 },
    { result: { ...boundary.result, isError: true } },
    { result: { content: "not a checkpoint" } },
    { result: { content: JSON.stringify({ ok: false, state: "continue" }) } },
    { result: { content: JSON.stringify({ ok: true, state: "complete" }) } },
    { result: { content: JSON.stringify({ ok: true, state: "blocked" }) } },
  ])
    assert.equal(shouldYieldRunBatch({ ...boundary, ...patch }), false);
});

test("batch handoff cannot strand the final chunk or bypass shared limits and review", () => {
  for (const patch of [
    { canContinue: false },
    { continuationCount: MAX_RUN_CONTINUATIONS },
    { previousTokens: CONTINUATION_TOKEN_LIMIT - RUN_BATCH_TOKEN_TARGET },
    { deadlineAtMs: 5_000 },
  ])
    assert.equal(shouldYieldRunBatch({ ...boundary, ...patch }), false);
});
