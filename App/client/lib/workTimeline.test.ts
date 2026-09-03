import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkEmployeeSummary, WorkEntry, WorkEntryKind } from "./api.js";
import {
  employeeWorkFocus,
  employeeWorkStatusLabel,
  groupWorkByDay,
  humanizeWorkAction,
  isWorkEntryActive,
  isWorkInsideWindow,
  isWorkEntryWaiting,
  summarizeEmployeeWork,
  workClock,
  workDayKey,
  workDayLabel,
  workDetailLabel,
  workDisplayDetail,
  workDisplayEntryCount,
  workDisplayTitle,
  workEffectOverflowLabel,
  workEmptyTitle,
  workEntryHref,
  workEntrySummary,
  workOverflowLabel,
  workRelativeTime,
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
    active: false,
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

describe("employee work state", () => {
  test("uses the explicit live flag rather than treating every open-ended row as active", () => {
    for (const kind of ["chat", "wakeup", "lesson", "effect"] as WorkEntryKind[]) {
      assert.equal(isWorkEntryActive(entryOf({ kind, endedAt: null, active: false })), false, kind);
    }
    assert.equal(isWorkEntryActive(entryOf({ kind: "chat", active: true })), true);
    assert.equal(isWorkEntryActive(entryOf({ kind: "work_session", active: true })), true);
    assert.equal(isWorkEntryActive(entryOf({ active: true })), true);
  });

  test("recognises only an undecided pending Approval as waiting", () => {
    const pending = entryOf({ kind: "approval", run: null, detail: "pending", endedAt: null });
    assert.equal(isWorkEntryWaiting(pending), true);
    assert.equal(isWorkEntryWaiting(entryOf({ ...pending, detail: "approved" })), false);
    assert.equal(
      isWorkEntryWaiting(entryOf({ ...pending, endedAt: "2026-09-03T09:00:00.000Z" })),
      false,
    );
    assert.equal(isWorkEntryWaiting(entryOf({ ...pending, kind: "chat" })), false);
  });

  test("filters to one employee and preserves the server's newest-first row", () => {
    const reyNew = entryOf({ id: "new", title: "Newest" });
    const reyOld = entryOf({ id: "old", title: "Older" });
    const kaz = entryOf({
      id: "other",
      employee: { ...reyNew.employee, id: "kaz", name: "Kaz", slug: "kaz" },
    });
    const summary = summarizeEmployeeWork(reyNew.employee.id, [reyNew, kaz, reyOld]);
    assert.equal(summary.entryCount, 2);
    assert.equal(summary.latestEntry?.id, "new");
    assert.equal(summary.state, "recent");
  });

  test("working takes precedence over waiting and merely recent work", () => {
    const latest = entryOf({ id: "latest" });
    const waiting = entryOf({
      id: "waiting",
      kind: "approval",
      run: null,
      detail: "pending",
      endedAt: null,
    });
    const current = entryOf({ id: "current", active: true });
    const summary = summarizeEmployeeWork(latest.employee.id, [latest, waiting, current]);
    assert.equal(summary.state, "working");
    assert.equal(summary.currentEntry?.id, "current");
    assert.equal(summary.waitingEntry?.id, "waiting");
    assert.equal(summary.latestEntry?.id, "latest");
  });

  test("waiting takes precedence over recent work when nothing is running", () => {
    const latest = entryOf({ id: "latest" });
    const waiting = entryOf({
      id: "waiting",
      kind: "approval",
      run: null,
      detail: "pending",
      endedAt: null,
    });
    assert.equal(summarizeEmployeeWork(latest.employee.id, [latest, waiting]).state, "waiting");
  });

  test("an employee with no visible rows is quiet only when no server rollup says otherwise", () => {
    const quiet = summarizeEmployeeWork("quiet", []);
    assert.equal(quiet.state, "quiet");
    assert.equal(quiet.entryCount, 0);

    const digest = {
      id: "run:hidden",
      kind: "run" as const,
      at: "2026-09-03T08:00:00.000Z",
      title: "Ran the close",
      detail: "",
      active: true,
    };
    const rollup: WorkEmployeeSummary = {
      employeeId: "quiet",
      entryCount: 41,
      latest: digest,
      current: digest,
      waiting: null,
    };
    const rolledUp = summarizeEmployeeWork("quiet", [], rollup);
    assert.equal(rolledUp.state, "working");
    assert.equal(rolledUp.entryCount, 41);
    assert.equal(rolledUp.currentEntry?.id, "run:hidden");
  });

  test("resolves rollup digests back to the full visible row when possible", () => {
    const row = entryOf({ id: "run:visible", active: true });
    const rollup: WorkEmployeeSummary = {
      employeeId: row.employee.id,
      entryCount: 1,
      latest: row,
      current: row,
      waiting: null,
    };
    const summary = summarizeEmployeeWork(row.employee.id, [row], rollup);
    assert.equal(summary.currentEntry, row);
    assert.equal(summary.latestEntry, row);
  });

  test("does not replace a live Chat digest with a terminal row from the same conversation", () => {
    const visible = entryOf({
      id: "chat:conversation-1",
      kind: "chat",
      run: null,
      active: false,
      title: "Replied in Launch plan",
    });
    const live = {
      id: visible.id,
      kind: "chat" as const,
      at: "2026-09-03T11:00:00.000Z",
      title: "Working on Launch plan",
      detail: "Comparing risks · 60%",
      active: true,
    };
    const rollup: WorkEmployeeSummary = {
      employeeId: visible.employee.id,
      entryCount: 1,
      latest: visible,
      current: live,
      waiting: null,
    };
    const summary = summarizeEmployeeWork(visible.employee.id, [visible], rollup);
    assert.equal(summary.state, "working");
    assert.equal(summary.currentEntry, live);
    assert.equal(summary.currentEntry.title, "Working on Launch plan");
  });

  test("ages terminal work out of the rolling window without hiding old current work", () => {
    const nowIso = "2026-09-03T12:00:00.000Z";
    const old = entryOf({ at: "2026-09-02T11:59:59.000Z" });
    const recent = summarizeEmployeeWork(old.employee.id, [old], undefined, { nowIso });
    assert.equal(recent.state, "quiet");
    assert.equal(recent.latestEntry, null);

    const current = summarizeEmployeeWork(old.employee.id, [{ ...old, active: true }], undefined, {
      nowIso,
    });
    assert.equal(current.state, "working");
  });

  test("focus follows current work, then a waiting gate, then the latest row", () => {
    const latest = entryOf({ id: "latest" });
    const waiting = entryOf({ id: "waiting", kind: "approval", run: null });
    const current = entryOf({ id: "current", active: true });
    const base = summarizeEmployeeWork(latest.employee.id, [latest]);
    assert.equal(employeeWorkFocus(base)?.id, "latest");
    assert.equal(employeeWorkFocus({ ...base, waitingEntry: waiting })?.id, "waiting");
    assert.equal(
      employeeWorkFocus({ ...base, waitingEntry: waiting, currentEntry: current })?.id,
      "current",
    );
    assert.equal(employeeWorkFocus({ ...base, latestEntry: null }), null);
  });
});

describe("relative work copy", () => {
  const now = "2026-09-03T12:00:00.000Z";
  const before = (ms: number) => new Date(new Date(now).getTime() - ms).toISOString();

  test("uses human time at the minute and hour boundaries", () => {
    assert.equal(workRelativeTime(before(0), now), "Just now");
    assert.equal(workRelativeTime(before(59_999), now), "Just now");
    assert.equal(workRelativeTime(before(60_000), now), "1m ago");
    assert.equal(workRelativeTime(before(59 * 60_000), now), "59m ago");
    assert.equal(workRelativeTime(before(60 * 60_000), now), "1h ago");
    assert.equal(workRelativeTime(before(23 * 3_600_000), now), "23h ago");
  });

  test("uses days before falling back to a calendar date", () => {
    assert.equal(workRelativeTime(before(24 * 3_600_000), now), "1d ago");
    assert.equal(workRelativeTime(before(6 * DAY), now), "6d ago");
    const sevenDaysAgo = before(7 * DAY);
    assert.equal(workRelativeTime(sevenDaysAgo, now), new Date(sevenDaysAgo).toLocaleDateString());
  });

  test("handles future and malformed timestamps without awkward negative copy", () => {
    assert.equal(workRelativeTime("2026-09-03T12:05:00.000Z", now), "Just now");
    assert.equal(workRelativeTime("not-a-date", now), "");
    assert.equal(workRelativeTime(before(1000), "not-a-date"), "");
  });

  test("labels all four bubble states", () => {
    const row = entryOf({ at: before(2 * 3_600_000) });
    const recent = summarizeEmployeeWork(row.employee.id, [row]);
    assert.equal(employeeWorkStatusLabel(recent, now), "Active 2h ago");
    assert.equal(
      employeeWorkStatusLabel({ ...recent, state: "working", currentEntry: row }, now),
      "Working now",
    );
    assert.equal(
      employeeWorkStatusLabel({ ...recent, state: "waiting", waitingEntry: row }, now),
      "Waiting for input",
    );
    assert.equal(
      employeeWorkStatusLabel({ ...recent, state: "quiet", latestEntry: null }, now),
      "Quiet today",
    );
  });
});

describe("rolling work window", () => {
  const now = "2026-09-03T12:00:00.000Z";

  test("keeps the boundary and ages out the moment before it", () => {
    assert.equal(isWorkInsideWindow("2026-09-02T12:00:00.000Z", now), true);
    assert.equal(isWorkInsideWindow("2026-09-02T11:59:59.999Z", now), false);
  });

  test("fails open for malformed or future timestamps", () => {
    assert.equal(isWorkInsideWindow("not-a-date", now), true);
    assert.equal(isWorkInsideWindow("2026-09-03T12:01:00.000Z", now), true);
  });

  test("drops an unknowable hidden total after the server snapshot ages", () => {
    assert.equal(workDisplayEntryCount(100, 40, 40, now, now), 100);
    assert.equal(workDisplayEntryCount(100, 40, 30, now, "2026-09-03T12:01:00.000Z"), 30);
    assert.equal(workDisplayEntryCount(100, 40, 30, "not-a-date", now), 30);
  });
});

describe("human-readable effects", () => {
  test("turns known ledger verbs into plain language", () => {
    assert.equal(humanizeWorkAction("invoice.create", "invoice"), "Created invoice");
    assert.equal(humanizeWorkAction("mail/send", "mail_message"), "Sent mail message");
    assert.equal(humanizeWorkAction("todo:comment", "todo"), "Commented on todo");
  });

  test("humanises camelCase, snake_case, and kebab-case targets", () => {
    assert.equal(
      humanizeWorkAction("customer.update", "customerProfile"),
      "Updated customer profile",
    );
    assert.equal(
      humanizeWorkAction("customer.update", "customer_profile"),
      "Updated customer profile",
    );
    assert.equal(
      humanizeWorkAction("customer.update", "customer-profile"),
      "Updated customer profile",
    );
  });

  test("keeps unknown operations readable and derives a missing target", () => {
    assert.equal(humanizeWorkAction("billing.reconcile", "bank_account"), "Reconcile bank account");
    assert.equal(humanizeWorkAction("note.publish", ""), "Published note");
    assert.equal(humanizeWorkAction("archive", ""), "Archived record");
  });

  test("turns Approval status tokens into human copy without rewriting other detail", () => {
    assert.equal(
      workDetailLabel(entryOf({ kind: "approval", detail: "pending" })),
      "Waiting for input",
    );
    assert.equal(
      workDetailLabel(entryOf({ kind: "approval", detail: "execution_failed" })),
      "Approved action failed",
    );
    assert.equal(
      workDetailLabel(entryOf({ kind: "run", detail: "manual trigger" })),
      "manual trigger",
    );
  });

  test("turns a standalone Effect into a readable action with its subject underneath", () => {
    const effect = entryOf({
      kind: "effect",
      run: null,
      title: "INV-4001",
      detail: "invoice.create",
    });
    assert.equal(workDisplayTitle(effect), "Created invoice");
    assert.equal(workDisplayDetail(effect), "INV-4001");
    assert.equal(workDisplayTitle(entryOf()), "Ran Nightly digest");
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
    assert.equal(workEntrySummary(entryOf(), { withEmployee: true }), "Rey — Ran Nightly digest");
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
      "3 more changes",
    );
  });

  test("counts from what the UI displayed when it deliberately shows fewer effects", () => {
    assert.equal(
      workEffectOverflowLabel(
        entryOf({
          effectCount: 8,
          effects: Array.from({ length: 8 }, () => ({
            action: "invoice.create",
            targetType: "invoice",
            targetId: null,
            targetLabel: "INV-1",
            at: new Date().toISOString(),
          })),
        }),
        3,
      ),
      "5 more changes",
    );
  });

  test("uses singular copy for one withheld effect", () => {
    assert.equal(
      workEffectOverflowLabel(entryOf({ effectCount: 1, effects: [] })),
      "1 more change",
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
