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
  const brief = runBatchBrief({ continuationCount: 0, deadlineAtMs: 60_000, now: 0 });
  assert.match(
    brief,
    /There is no total model-token limit or fixed model\/tool step limit for this work\./,
  );
  assert.doesNotMatch(brief, /tokens remaining|token allowance/);
});

const briefWindow = {
  deadlineAtMs: Date.parse("2026-09-28T12:35:53.038Z"),
  now: Date.parse("2026-09-28T11:55:53.038Z"),
};

test("the final continuation is briefed to use its remaining shared time without requiring another Run", () => {
  const brief = runBatchBrief({ ...briefWindow, continuationCount: MAX_RUN_CONTINUATIONS });
  assert.match(brief, /This is continuation 3 of 3 in the current time window\./);
  assert.match(brief, /Shared absolute deadline: 2026-09-28T12:35:53\.038Z \(UTC\)/);
  assert.match(brief, /Approximately 2400 seconds remained when this brief was prepared/);
  assert.match(brief, /No automatic continuations remain after this Run\./);
  assert.match(brief, /it does not require ending this active Run/);
  assert.match(
    brief,
    /Continue safe useful work within the remaining shared time, checkpointing each batch/,
  );
  assert.match(brief, /If the call returns control, keep working on the next useful step/);
  assert.match(brief, /Do not stop merely because this is the final continuation/);
  assert.doesNotMatch(
    brief,
    /until .*continuation limit is reached|hand the work to a fresh Run automatically/,
  );
});

for (const count of [0, 1, 2]) {
  test(`Run at continuation count ${count} retains its precise count and conditional handoff guidance`, () => {
    const brief = runBatchBrief({ ...briefWindow, continuationCount: count });
    assert.match(
      brief,
      count === 0
        ? /This is the initial Run in the current time window\./
        : new RegExp(`This is continuation ${count} of 3 in the current time window\\.`),
    );
    assert.match(
      brief,
      new RegExp(
        `Up to ${MAX_RUN_CONTINUATIONS - count} automatic continuations may follow this Run`,
      ),
    );
    assert.match(brief, /subject to the existing progress, review and time rules/);
    assert.match(
      brief,
      /Once this Run uses 2,000,000 tokens, a successful continue checkpoint can hand the work to a fresh Run automatically/,
    );
    assert.match(brief, /If the call returns control, keep working on the next useful step/);
    assert.match(brief, /2026-09-28T12:35:53\.038Z \(UTC\)/);
    assert.doesNotMatch(brief, /No automatic continuations remain/);
  });
}

test("every brief preserves early completion, real blockers, scope and time to close safely", () => {
  for (const count of [0, MAX_RUN_CONTINUATIONS]) {
    const brief = runBatchBrief({ ...briefWindow, continuationCount: count });
    assert.match(brief, /Finish promptly when the required work is complete/);
    assert.match(brief, /actual blocker prevents further useful work/);
    assert.match(brief, /Work on independent unblocked items before stopping for a blocker/);
    assert.match(
      brief,
      /respect current Grants, delivery limits, approval requirements and Standdowns/,
    );
    assert.match(
      brief,
      /Reserve enough time to save truthful progress and your final report before it/,
    );
    assert.match(brief, /Avoid starting an action that cannot safely finish in the time remaining/);
    assert.match(brief, /do not .*expand this occurrence's scope/);
    assert.match(brief, /Never call unfinished required work complete just because a batch ended/);
  }
});

test("batch ordering follows Routine priorities without replacing required current work with inherited backlog", () => {
  for (const continuationCount of [0, 1, MAX_RUN_CONTINUATIONS]) {
    const brief = runBatchBrief({ ...briefWindow, continuationCount });
    assert.match(brief, /Follow the Routine's stated priority and discovery requirements/);
    assert.match(brief, /Preserve this occurrence's captured scope and retain inherited backlog/);
    assert.match(
      brief,
      /without letting it replace explicitly required current priority work or urgent commitments/,
    );
    assert.match(brief, /Resume older unfinished items at the priority the Routine requires/);
    assert.match(brief, /remaining IDs and original review window/);
    assert.match(brief, /do not .*expand this occurrence's scope/);
    assert.doesNotMatch(brief, /Resume older unfinished work before collecting newer work/);
  }
});

test("deadline guidance reports the existing boundary without extending or rounding away its expiry", () => {
  const oneMillisecond = runBatchBrief({
    ...briefWindow,
    continuationCount: 3,
    now: briefWindow.deadlineAtMs - 1,
  });
  assert.match(oneMillisecond, /Approximately 1 second remained/);
  for (const now of [briefWindow.deadlineAtMs, briefWindow.deadlineAtMs + 1000]) {
    const expired = runBatchBrief({ ...briefWindow, continuationCount: 3, now });
    assert.match(expired, /2026-09-28T12:35:53\.038Z \(UTC\)/);
    assert.match(expired, /That deadline has been reached/);
    assert.match(
      expired,
      /finish without starting further work or assuming a fresh time allowance/,
    );
    assert.doesNotMatch(expired, /Approximately .* seconds remained/);
  }
});

test("prompt clarification preserves the final-Run and five-second handoff boundaries", () => {
  const advanced = resultFor({
    ...checkpoint,
    progressKey: "deal-6",
    completed: "Reviewed Deal 6.",
  });
  for (const remainingMs of [5001, 5000, 1, 0]) {
    for (const count of [2, MAX_RUN_CONTINUATIONS]) {
      assert.equal(
        shouldYieldRunBatch({
          ...boundary,
          continuationCount: count,
          previousCheckpoint: checkpoint,
          result: advanced,
          tokensThisRun: 15_000_000,
          deadlineAtMs: remainingMs,
        }),
        count < MAX_RUN_CONTINUATIONS && remainingMs > 5000,
      );
    }
  }
});
