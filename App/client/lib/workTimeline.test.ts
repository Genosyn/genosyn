import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkEntry, WorkEntryKind } from "./api.js";
import {
  groupWorkByDay,
  workClock,
  workDayKey,
  workDayLabel,
  workEffectOverflowLabel,
  workEmptyTitle,
  workEntryHref,
  workEntrySummary,
  workOverflowLabel,
  WORK_ENTRY_KINDS,
  WORK_KIND_META,
} from "./workTimeline.js";

/**
 * What Home's work timeline *says* and where each row *goes*. Client tests in
 * this repo have no DOM, which is exactly why this logic lives in `lib/` — the
 * wording and the destinations are the parts a reader actually depends on, and
 * they would otherwise be untestable inside the JSX.
 *
 * The table-driven cases over `WORK_ENTRY_KINDS` are deliberate: adding a kind
 * without giving it a tone, a label, or a destination fails here rather than
 * shipping an invisible chip or a dead row.
 */

const DAY = 86_400_000;

function entryOf(over: Partial<WorkEntry> = {}): WorkEntry {
  return {
    id: "run:a5f6c1a2-0000-4000-8000-000000000001",
    kind: "run",
    at: new Date().toISOString(),
    endedAt: null,
    employee: {
      id: "e1f6c1a2-0000-4000-8000-000000000002",
      name: "Rey",
      slug: "rey",
      avatarKey: null,
    },
    title: "Ran Nightly digest",
    detail: "",
    run: {
      id: "r1f6c1a2-0000-4000-8000-000000000003",
      routineId: "t1f6c1a2-0000-4000-8000-000000000004",
      routineName: "Nightly digest",
      status: "completed",
      exitCode: 0,
      triggerKind: "schedule",
      attempt: 1,
      outcomeVerdict: null,
      outcomeNote: null,
      checksVerdict: null,
    },
    effects: [],
    effectCount: 0,
    ...over,
  };
}

/** Everything a row puts in front of a reader, as one blob. */
function rowText(entry: WorkEntry): string {
  return [
    workEntrySummary(entry, { withEmployee: true }),
    entry.detail,
    WORK_KIND_META[entry.kind].label,
  ].join(" ");
}

describe("day grouping", () => {
  test("names today, yesterday, and anything older by its date", () => {
    const now = new Date();
    assert.equal(workDayLabel(now), "Today");
    assert.equal(workDayLabel(new Date(now.getTime() - DAY)), "Yesterday");
    const older = new Date(now.getTime() - 5 * DAY);
    const label = workDayLabel(older);
    assert.notEqual(label, "Today");
    assert.notEqual(label, "Yesterday");
    assert.ok(label.length > 0);
  });

  test("includes the year only when it is not the current one", () => {
    const now = new Date();
    const lastYear = new Date(now.getTime());
    lastYear.setFullYear(now.getFullYear() - 1);
    assert.match(workDayLabel(lastYear), new RegExp(String(now.getFullYear() - 1)));
  });

  test("distinguishes the same clock time on two different days", () => {
    const a = new Date(2026, 0, 1, 9, 30);
    const b = new Date(2026, 0, 2, 9, 30);
    assert.notEqual(workDayKey(a), workDayKey(b));
  });

  test("groups consecutive same-day rows and preserves the server's order", () => {
    const now = new Date();
    const entries = [
      entryOf({ id: "a", at: new Date(now.getTime() - 1 * 3600_000).toISOString() }),
      entryOf({ id: "b", at: new Date(now.getTime() - 2 * 3600_000).toISOString() }),
      entryOf({ id: "c", at: new Date(now.getTime() - DAY - 3600_000).toISOString() }),
    ];
    const groups = groupWorkByDay(entries);
    assert.equal(groups.length, 2);
    assert.deepEqual(
      groups[0].items.map((e) => e.id),
      ["a", "b"],
    );
    assert.deepEqual(
      groups[1].items.map((e) => e.id),
      ["c"],
    );
  });

  test("opens a fresh group when a day repeats out of order", () => {
    // Grouping is consecutive on purpose: re-bucketing would let one
    // clock-skewed row silently reorder the list to keep its day together.
    const now = new Date();
    const entries = [
      entryOf({ id: "a", at: now.toISOString() }),
      entryOf({ id: "b", at: new Date(now.getTime() - DAY).toISOString() }),
      entryOf({ id: "c", at: now.toISOString() }),
    ];
    assert.equal(groupWorkByDay(entries).length, 3);
  });

  test("returns nothing for nothing", () => {
    assert.deepEqual(groupWorkByDay([]), []);
  });

  test("labels an unparseable timestamp rather than throwing", () => {
    const groups = groupWorkByDay([entryOf({ at: "not a date" })]);
    assert.equal(groups[0].label, "Undated");
  });
});

describe("clock", () => {
  test("renders a local time for a real timestamp", () => {
    assert.ok(workClock(new Date().toISOString()).length > 0);
  });

  test("renders nothing for a timestamp that will not parse", () => {
    assert.equal(workClock("nonsense"), "");
  });
});

describe("destinations", () => {
  test("a run deep-links to its own row in the routine's history", () => {
    const href = workEntryHref(entryOf(), "acme");
    assert.ok(href);
    assert.match(href, /^\/c\/acme\/routines\?/);
    assert.match(href, /routine=t1f6c1a2-0000-4000-8000-000000000004/);
    assert.match(href, /run=r1f6c1a2-0000-4000-8000-000000000003/);
  });

  test("a bare ledger row has nowhere of its own to go", () => {
    assert.equal(workEntryHref(entryOf({ kind: "effect", run: null }), "acme"), null);
  });

  test("a run with no run payload does not fabricate a link", () => {
    assert.equal(workEntryHref(entryOf({ run: null }), "acme"), null);
  });

  test("every kind is accounted for", () => {
    // A new kind without a case here would render as a dead row.
    for (const kind of WORK_ENTRY_KINDS) {
      const href = workEntryHref(entryOf({ kind }), "acme");
      if (kind === "effect") {
        assert.equal(href, null, kind);
        continue;
      }
      assert.ok(href && href.startsWith("/c/acme/"), `${kind} → ${href}`);
    }
  });

  test("chat, wakeup and lesson land on the employee that did the work", () => {
    for (const kind of ["chat", "wakeup", "lesson"] as WorkEntryKind[]) {
      assert.match(workEntryHref(entryOf({ kind }), "acme")!, /\/employees\/rey/);
    }
  });
});

describe("kind metadata", () => {
  test("covers every kind", () => {
    for (const kind of WORK_ENTRY_KINDS) {
      assert.ok(WORK_KIND_META[kind], kind);
      assert.ok(WORK_KIND_META[kind].label.length > 0, kind);
    }
    assert.equal(Object.keys(WORK_KIND_META).length, WORK_ENTRY_KINDS.length);
  });

  test("gives every kind a distinct label", () => {
    const labels = WORK_ENTRY_KINDS.map((k) => WORK_KIND_META[k].label);
    assert.equal(new Set(labels).size, labels.length);
  });

  test("gives every tone a dark-mode partner", () => {
    // A light-only tone is an invisible chip on a dark page.
    for (const kind of WORK_ENTRY_KINDS) {
      const tone = WORK_KIND_META[kind].tone;
      assert.match(tone, /dark:bg-/, kind);
      assert.match(tone, /dark:text-/, kind);
      assert.match(tone, /dark:ring-/, kind);
    }
  });

  test("never calls an AI Employee a bot, an agent or an assistant", () => {
    for (const kind of WORK_ENTRY_KINDS) {
      assert.doesNotMatch(rowText(entryOf({ kind })), /\b(bot|agent|assistant)\b/i, kind);
    }
  });

  test("never calls scheduled AI work a task", () => {
    // "Task" is reserved for the task manager — see AGENTS.md §3.
    for (const kind of WORK_ENTRY_KINDS) {
      assert.doesNotMatch(rowText(entryOf({ kind })), /\btasks?\b/i, kind);
    }
  });
});

describe("summaries", () => {
  test("names the employee when the whole roster is on screen", () => {
    assert.equal(
      workEntrySummary(entryOf(), { withEmployee: true }),
      "Rey — Ran Nightly digest",
    );
  });

  test("drops the name once one employee is the subject", () => {
    assert.equal(workEntrySummary(entryOf()), "Ran Nightly digest");
  });
});

describe("overflow and empty copy", () => {
  test("says nothing when everything in the window is on screen", () => {
    assert.equal(workOverflowLabel(5, 5), null);
    assert.equal(workOverflowLabel(5, 4), null);
  });

  test("says how much was withheld when there is more", () => {
    assert.equal(workOverflowLabel(40, 112), "Showing the 40 most recent of 112");
  });

  test("counts the withheld effects on a capped entry", () => {
    assert.equal(workEffectOverflowLabel(entryOf({ effectCount: 0 })), null);
    assert.equal(
      workEffectOverflowLabel(
        entryOf({
          effectCount: 11,
          effects: Array.from({ length: 8 }, () => ({
            action: "invoice.create",
            targetType: "invoice",
            targetId: null,
            targetLabel: "INV-1",
            at: new Date().toISOString(),
          })),
        }),
      ),
      "3 more",
    );
  });

  test("names the employee in the empty state once one is chosen", () => {
    assert.equal(workEmptyTitle("Rey", 24), "Rey has not done anything in the last 24 hours.");
    assert.equal(workEmptyTitle(null, 24), "Nothing has been done in the last 24 hours.");
  });

  test("says the real window when it is not the usual one", () => {
    assert.match(workEmptyTitle("Rey", 48), /last 48 hours/);
  });
});
