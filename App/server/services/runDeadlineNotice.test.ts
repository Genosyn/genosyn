import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRunDeadlineNotice,
  DEADLINE_NOTICE_INTERVAL_MS,
  DEADLINE_NOTICE_MAX_WINDOW_MS,
  DEADLINE_NOTICE_MIN_WINDOW_MS,
  DEADLINE_NOTICE_URGENT_MS,
  deadlineNoticeWindowMs,
  formatRunDeadlineNotice,
} from "./runDeadlineNotice.js";

const MINUTE = 60_000;
const deadlineAtMs = Date.parse("2026-10-01T13:00:00.000Z");

function clock(start: number) {
  let now = start;
  return {
    now: () => now,
    set(value: number) {
      now = value;
    },
  };
}

test("the warning window is a fifth of the budget, within two and fifteen minutes", () => {
  assert.equal(deadlineNoticeWindowMs(60 * MINUTE), 12 * MINUTE);
  assert.equal(deadlineNoticeWindowMs(100 * MINUTE), DEADLINE_NOTICE_MAX_WINDOW_MS);
  assert.equal(deadlineNoticeWindowMs(5 * MINUTE), DEADLINE_NOTICE_MIN_WINDOW_MS);
  assert.equal(deadlineNoticeWindowMs(1), DEADLINE_NOTICE_MIN_WINDOW_MS);
});

test("no note before the window opens or once the deadline has passed", () => {
  const time = clock(deadlineAtMs - 60 * MINUTE);
  const notice = createRunDeadlineNotice({ deadlineAtMs, budgetMs: 60 * MINUTE, now: time.now });
  assert.equal(notice({ canCheckpoint: true }), null, "the Run has just started");
  time.set(deadlineAtMs - 12 * MINUTE - 1);
  assert.equal(notice({ canCheckpoint: true }), null, "one millisecond before the window");
  time.set(deadlineAtMs);
  assert.equal(notice({ canCheckpoint: true }), null, "the runner stops the Run at the deadline");
  time.set(deadlineAtMs + MINUTE);
  assert.equal(notice({ canCheckpoint: true }), null);
});

test("inside the window the note states the time left, the deadline, and how to save", () => {
  const time = clock(deadlineAtMs - 9 * MINUTE - 10_000);
  const notice = createRunDeadlineNotice({ deadlineAtMs, budgetMs: 60 * MINUTE, now: time.now });
  const text = notice({ canCheckpoint: true });
  assert.ok(text);
  assert.match(text, /^\[Time check\] About 9 minutes remain before this Run's hard deadline \(13:00 UTC\)\./);
  assert.match(text, /save_run_checkpoint \(through call_tool if it is not in your tool list\)/);
  assert.match(text, /final report/);
  assert.match(text, /Do not start anything that cannot finish before the deadline\./);
});

test("early notes are spaced out, and the last minutes speak on every result", () => {
  const time = clock(deadlineAtMs - 12 * MINUTE);
  const notice = createRunDeadlineNotice({ deadlineAtMs, budgetMs: 60 * MINUTE, now: time.now });
  assert.ok(notice({ canCheckpoint: true }), "entering the window");
  time.set(deadlineAtMs - 12 * MINUTE + DEADLINE_NOTICE_INTERVAL_MS - 1);
  assert.equal(notice({ canCheckpoint: true }), null, "too soon after the last note");
  time.set(deadlineAtMs - 12 * MINUTE + DEADLINE_NOTICE_INTERVAL_MS);
  assert.ok(notice({ canCheckpoint: true }), "the interval has passed");

  time.set(deadlineAtMs - DEADLINE_NOTICE_URGENT_MS);
  const first = notice({ canCheckpoint: true });
  const second = notice({ canCheckpoint: true });
  assert.ok(first && second, "every result in the urgent window carries the note");
  assert.match(first, /^\[Time check\] Under 3 minutes remain before this Run's hard deadline/);
  assert.match(first, /Start no new work: save truthful progress with save_run_checkpoint/);

  time.set(deadlineAtMs - 30_000);
  assert.match(notice({ canCheckpoint: true }) ?? "", /^\[Time check\] Less than a minute remains/);
});

test("a turn that cannot checkpoint is told to record its progress instead", () => {
  const text = formatRunDeadlineNotice({
    remainingMs: 2 * MINUTE,
    deadlineAtMs,
    urgent: true,
    canCheckpoint: false,
  });
  assert.doesNotMatch(text, /save_run_checkpoint/);
  assert.match(text, /record what is done and what remains now, then write your final report\./);
});

test("short budgets still leave a warning window ahead of the deadline", () => {
  const budgetMs = 3 * MINUTE;
  const time = clock(deadlineAtMs - budgetMs);
  const notice = createRunDeadlineNotice({ deadlineAtMs, budgetMs, now: time.now });
  assert.equal(notice({ canCheckpoint: true }), null, "the window is the last two minutes");
  time.set(deadlineAtMs - 2 * MINUTE);
  assert.match(notice({ canCheckpoint: true }) ?? "", /Under 2 minutes remain/);
});
