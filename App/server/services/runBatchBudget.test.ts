import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_BATCH_TOKEN_TARGET, runBatchBrief, shouldYieldRunBatch } from "./runBatchBudget.js";
import { MAX_RUN_CONTINUATIONS, type RunCheckpoint } from "./runContinuation.js";

const checkpoint: RunCheckpoint = {
  state: "continue",
  completed: "Reviewed Deal 5 in the original window.",
  remaining: "Deal 6's remaining messages.",
  resume: "Continue reading Deal 6 at its saved source cursor.",
  progressKey: "deal-5",
};

function resultFor(value: RunCheckpoint = checkpoint) {
  return { content: JSON.stringify({ ok: true, state: value.state, checkpoint: value }) };
}

const boundary = {
  toolName: "save_run_checkpoint",
  result: resultFor(),
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
    { result: resultFor({ ...checkpoint, state: "complete", remaining: "", resume: "" }) },
    { result: resultFor({ ...checkpoint, state: "blocked" }) },
    {
      result: {
        content: JSON.stringify({ ok: true, state: "continue", checkpoint: { state: "continue" } }),
      },
    },
    { result: { content: JSON.stringify({ ok: true, state: "complete", checkpoint }) } },
    { result: { content: JSON.stringify({ ok: false, state: "continue", checkpoint }) } },
    {
      result: {
        content: JSON.stringify({
          ok: true,
          state: "continue",
          checkpoint: { ...checkpoint, extra: "ignored?" },
        }),
      },
    },
  ])
    assert.equal(shouldYieldRunBatch({ ...boundary, ...patch }), false);
});

test("a continuation can yield only when the durable checkpoint advances by the finalization rule", () => {
  for (const current of [
    checkpoint,
    { ...checkpoint, progressKey: "DEAL-5  " },
    { ...checkpoint, completed: "Reviewed Deal 6's first message." },
    { ...checkpoint, resume: "Continue Deal 6 from a later text offset." },
    { ...checkpoint, remaining: "Only Deal 6's final message remains." },
    { ...checkpoint, progressKey: "deal-6" },
    {
      ...checkpoint,
      progressKey: "deal-6",
      completed: "  Reviewed   Deal 5 in the ORIGINAL window.  ",
    },
  ]) {
    assert.equal(
      shouldYieldRunBatch({
        ...boundary,
        continuationCount: 1,
        previousCheckpoint: checkpoint,
        result: resultFor(current),
      }),
      false,
      JSON.stringify(current),
    );
  }
  for (const current of [
    { ...checkpoint, progressKey: "deal-6", completed: "Reviewed Deal 6." },
    { ...checkpoint, progressKey: "deal-6", resume: "Continue Deal 7 from its first message." },
  ]) {
    assert.equal(
      shouldYieldRunBatch({
        ...boundary,
        continuationCount: 1,
        previousCheckpoint: checkpoint,
        result: resultFor(current),
      }),
      true,
    );
  }
});

test("manual resumption still needs progress even though its continuation count resets to zero", () => {
  assert.equal(shouldYieldRunBatch({ ...boundary, previousCheckpoint: checkpoint }), false);
  assert.equal(shouldYieldRunBatch({ ...boundary, previousCheckpoint: null }), false);
});

test("clipped or malformed checkpoint evidence keeps the current Run alive", () => {
  const escaped = resultFor({
    ...checkpoint,
    progressKey: "deal-6",
    completed: "\u0001".repeat(2_000),
    remaining: "\u0001".repeat(2_000),
    resume: "\u0001".repeat(3_000),
  });
  assert.ok(escaped.content.length > 8_000);
  assert.equal(
    shouldYieldRunBatch({ ...boundary, previousCheckpoint: checkpoint, result: escaped }),
    true,
  );
  for (const content of [
    escaped.content.slice(0, 8_000),
    escaped.content.slice(0, 8_000) + "\n… [truncated 35000 chars]",
    JSON.stringify({ ok: true, state: "continue" }),
    "null",
    "[]",
  ]) {
    assert.equal(
      shouldYieldRunBatch({ ...boundary, previousCheckpoint: checkpoint, result: { content } }),
      false,
    );
  }
});

test("batch handoff cannot strand the final chunk or bypass shared limits and review", () => {
  const advanced = resultFor({
    ...checkpoint,
    progressKey: "deal-6",
    completed: "Reviewed Deal 6.",
  });
  for (const patch of [
    { canContinue: false },
    { continuationCount: MAX_RUN_CONTINUATIONS },
    { deadlineAtMs: 5_000 },
  ]) {
    assert.equal(shouldYieldRunBatch({ ...boundary, ...patch }), false);
    assert.equal(
      shouldYieldRunBatch({
        ...boundary,
        previousCheckpoint: checkpoint,
        result: advanced,
        ...patch,
      }),
      false,
    );
  }
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
