import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_BATCH_TOKEN_TARGET, runBatchBrief, shouldYieldRunBatch } from "./runBatchBudget.js";
import { MAX_RUN_CONTINUATIONS } from "./runContinuation.js";

const boundary = {
  toolName: "save_run_checkpoint",
  result: { content: JSON.stringify({ ok: true, state: "continue" }) },
  tokensThisRun: RUN_BATCH_TOKEN_TARGET,
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
    { deadlineAtMs: 5_000 },
  ])
    assert.equal(shouldYieldRunBatch({ ...boundary, ...patch }), false);
});

test("batch handoff remains available above ten million tokens without a total allowance", () => {
  assert.equal(shouldYieldRunBatch({ ...boundary, tokensThisRun: 15_000_000 }), true);
  const brief = runBatchBrief();
  assert.match(
    brief,
    /There is no total model-token limit or fixed model\/tool step limit for this work\./,
  );
  assert.doesNotMatch(brief, /tokens remaining|token allowance/);
});
