import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { WorkEmployeeSummary, WorkEntry, WorkEntryAnalysis, WorkEntryKind } from "./api.js";
import {
  buildWorkChartLanes,
  employeeWorkStatusLabel,
  groupWorkByDay,
  humanizeWorkAction,
  isWorkEntryActive,
  isWorkInsideWindow,
  isWorkEntryWaiting,
  packWorkChartTracks,
  summarizeEmployeeWork,
  workChartTicks,
  workChartTile,
  workChartWindow,
  workClock,
  workCountsSentence,
  workDayKey,
  workDayLabel,
  workDetailLabel,
  workDisplayDetail,
  workDisplayEntryCount,
  workDurationLabel,
  workEmailAnalysisDetails,
  workEmailAnalysisPhase,
  workEffectOverflowLabel,
  workEffectPhrase,
  workEmptyTitle,
  workEntryHref,
  workEntryKindLabel,
  workEntryLinkLabel,
  workNarrative,
  workNarrativeText,
  workOverflowLabel,
  workRelativeTime,
  WORK_ACTION_VERBS,
  WORK_ACTION_WORDING,
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
    subject: "Nightly digest",
    detail: "",
    source: null,
    run: {
      summary: null,
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
  return [workNarrativeText(entry), entry.detail, WORK_KIND_META[entry.kind].label].join(" ");
}

/** One ledger row, as the server sends it under an entry. */
function ledgerRow(action: string, targetType = "") {
  return { action, targetType, targetId: null, targetLabel: "", at: "2026-09-03T12:00:00.000Z" };
}

/** An entry whose ledger holds `count` rows of the same action. */
function repeatedRows(
  count: number,
  action: string,
  targetType = "",
  over: Partial<WorkEntry> = {},
) {
  return entryOf({
    effects: Array.from({ length: count }, () => ledgerRow(action, targetType)),
    effectCount: count,
    ...over,
  });
}

/**
 * The article a reader expects before a word, written out here rather than
 * borrowed from `shared/indefiniteArticle.ts` so the two can disagree: the
 * vowel-letter rule, plus the words in these sentences that break it.
 */
const SAID_WITH_A_CONSONANT = new Set([
  "euro",
  "one",
  "union",
  "unique",
  "unit",
  "url",
  "usage",
  "user",
  "utility",
]);
const SAID_WITH_A_VOWEL = new Set(["heir", "honest", "hour"]);

function expectedArticle(word: string): "a" | "an" {
  const lower = word.toLowerCase();
  if (SAID_WITH_A_CONSONANT.has(lower)) return "a";
  if (SAID_WITH_A_VOWEL.has(lower)) return "an";
  return /^[aeiou]/.test(lower) ? "an" : "a";
}

/**
 * Fails on any article a reader would trip over: two in a row ("an an email
 * instruction", "the a"), one beside a count ("2 an email instructions", "a 2
 * invoices"), or one that does not suit how the next word sounds ("a email",
 * "an step").
 */
function assertArticlesRead(text: string): void {
  assert.doesNotMatch(text, /\b(?:a|an|the)\s+(?:a|an|the)\b/i, `doubled article: "${text}"`);
  assert.doesNotMatch(text, /\b(?:a|an|the)\s+\d/i, `article before a count: "${text}"`);
  assert.doesNotMatch(text, /\d\s+(?:a|an|the)\b/i, `article after a count: "${text}"`);
  for (const [, article, word] of text.matchAll(/\b(a|an)\s+([A-Za-z]+)/gi)) {
    assert.equal(article.toLowerCase(), expectedArticle(word), `"${article} ${word}" in "${text}"`);
  }
}

/** How many times "a" or "an" appears as a word. */
function indefiniteArticles(text: string): number {
  return text.match(/\b(?:a|an)\b/gi)?.length ?? 0;
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
    assert.equal(workDisplayDetail(effect), "INV-4001");
    assert.match(workNarrative(effect).headline, /^Rey created invoice/);
  });

  test("names and explains the Email thread behind a handover change", () => {
    const effect = entryOf({
      kind: "effect",
      run: null,
      title: "Your shortcut to savings",
      subject: "Your shortcut to savings",
      detail: "mail.handover.complete",
      source: {
        kind: "mail_thread",
        id: "thread-1",
        accountId: "account-1",
        label: "Email with Pure Electric",
        detail: "Started by an Email rule",
      },
    });
    const narrative = workNarrative(effect);
    assert.match(
      narrative.headline,
      /^Rey completed an Email handover for “Your shortcut to savings”/,
    );
    assert.equal(narrative.context, "Email with Pure Electric · Started by an Email rule");
  });

  test("describes a failed Email handover without blaming the employee for a completed action", () => {
    const effect = entryOf({
      kind: "effect",
      run: null,
      subject: "Renewal",
      detail: "mail.handover.fail",
      source: {
        kind: "mail_thread",
        id: "thread-2",
        accountId: "account-2",
        label: "Email with accounts@example.test",
        detail: "Handed over by a Member",
      },
    });
    assert.match(
      workNarrative(effect).headline,
      /^Rey could not complete an Email handover for “Renewal”/,
    );
  });
});

describe("email analysis timeline details", () => {
  const purpose = "Classifies the email and suggests next steps without carrying them out.";
  function analysisEntry(
    status: WorkEntryAnalysis["status"] = "completed",
    analysis: Partial<WorkEntryAnalysis> = {},
  ): WorkEntry {
    return entryOf({
      kind: "effect",
      run: null,
      active: false,
      subject: "Pricing for the autumn launch",
      detail: `mail.analysis.${status}`,
      source: {
        kind: "mail_thread",
        id: "thread-1",
        accountId: "account-1",
        label: "Email with Sam",
        detail: "hello@acme.test",
      },
      analysis: {
        kind: "email",
        status,
        purpose,
        category: "quote_request",
        summary: "The sender asks for a quote for 20 seats.",
        suggestedActions: ["Prepare a quote", "Prepare a reply"],
        error: null,
        resultAvailable: true,
        durationMs: 42_000,
        ...analysis,
      },
    });
  }

  for (const status of ["started", "completed", "failed"] as const) {
    test(`names ${status} email analysis without presenting it as an Email handover`, () => {
      const entry = analysisEntry(status);
      assert.equal(workEmailAnalysisPhase(entry), status);
      assert.equal(workEntryKindLabel(entry), "Email analysis");
      const narrative = workNarrative(entry);
      const action = status === "failed" ? "could not complete" : status;
      assert.match(
        narrative.headline,
        new RegExp(`^Rey ${action} email analysis for “Pricing for the autumn launch”`),
      );
      assert.doesNotMatch(narrative.headline, /handover|failed analysis/);
      assert.ok(narrative.context?.includes("Email with Sam · hello@acme.test"));
      assert.deepEqual(narrative.body, [purpose]);
      assert.equal(isWorkEntryActive(entry), false);
    });
  }

  test("only exact analysis attempt actions receive the specific label", () => {
    for (const detail of [
      "mail.analysis.create_estimate",
      "mail.analysis.thread_action",
      "mail.handover.complete",
      "analysis.completed",
      "mail.analysis.completed.extra",
      "constructor",
      "__proto__",
    ]) {
      const entry = { ...analysisEntry(), detail };
      assert.equal(workEmailAnalysisPhase(entry), null, detail);
      assert.equal(workEntryKindLabel(entry), "Change", detail);
      assert.equal(workEmailAnalysisDetails(entry), null, detail);
    }
    const run = { ...analysisEntry(), kind: "run" as const };
    assert.equal(workEmailAnalysisPhase(run), null);
    assert.equal(workEntryKindLabel(run), "Routine run");
  });

  test("says what the mailbox's instructions had an employee do, not 'automatic analysis'", () => {
    assert.equal(
      humanizeWorkAction("mail.analysis.automatic", "mail_inbound_analysis"),
      "Followed an email instruction",
    );
    assert.equal(
      humanizeWorkAction("mail.analysis.automatic_failed", "mail_inbound_analysis"),
      "Could not follow an email instruction",
    );
    assert.equal(
      humanizeWorkAction("mail.analysis.automatic_undo", ""),
      "Undid an automatic email step",
    );
    // An instruction step is a change the employee made, not an analysis attempt.
    for (const detail of ["mail.analysis.automatic", "mail.analysis.automatic_failed"]) {
      const entry = { ...analysisEntry(), detail };
      assert.equal(workEmailAnalysisPhase(entry), null, detail);
      assert.equal(workEntryKindLabel(entry), "Change", detail);
    }
  });

  test("says a question was kept off the Decision stack, not 'Screen out decision'", () => {
    assert.equal(humanizeWorkAction("decision.screen_out", "decision"), "Kept off the Decision stack");
    assert.equal(humanizeWorkAction("decision.screen_out", ""), "Kept off the Decision stack");
    // The ordinary Decision rows keep their generic wording.
    assert.equal(humanizeWorkAction("decision.create", "decision"), "Created decision");
  });

  test("humanizes analysis audit actions even inside an ordinary effect list", () => {
    assert.equal(
      humanizeWorkAction("mail.analysis.started", "mail_inbound_analysis"),
      "Started email analysis",
    );
    assert.equal(humanizeWorkAction("mail.analysis.completed", ""), "Completed email analysis");
    assert.equal(
      humanizeWorkAction("mail.analysis.failed", "mail_inbound_analysis"),
      "Could not complete email analysis",
    );
  });

  test("keeps recorded suggestions separate from actual work and translates the category", () => {
    assert.deepEqual(workEmailAnalysisDetails(analysisEntry()), {
      summary: "The sender asks for a quote for 20 seats.",
      category: "Quote request",
      suggestedActions: ["Prepare a quote", "Prepare a reply"],
      failureReason: null,
      unavailable: null,
    });
  });

  test("an empty recorded suggestion list differs from a missing historical result", () => {
    assert.deepEqual(
      workEmailAnalysisDetails(analysisEntry("completed", { suggestedActions: [] }))
        ?.suggestedActions,
      [],
    );
    const old = workEmailAnalysisDetails(analysisEntry("completed", { resultAvailable: false }));
    assert.equal(old?.suggestedActions, null);
    assert.equal(old?.summary, null);
    assert.equal(old?.category, null);
    assert.equal(old?.unavailable, "Result details are unavailable for this analysis.");
  });

  test("started events never inherit the result or duration from a completed attempt", () => {
    const entry = analysisEntry("started", { status: "completed" });
    assert.equal(workEmailAnalysisDetails(entry), null);
    assert.equal(workNarrative(entry).context, "Email with Sam · hello@acme.test");
  });

  test("failed events show only their own saved failure reason", () => {
    const details = workEmailAnalysisDetails(
      analysisEntry("failed", { error: "  The AI Model timed out.  " }),
    );
    assert.equal(details?.failureReason, "The AI Model timed out.");
    assert.equal(details?.summary, null);
    assert.equal(details?.category, null);
    assert.equal(details?.suggestedActions, null);
    assert.equal(details?.unavailable, null);
  });

  for (const error of [null, "", "  "]) {
    test(`a missing failure reason ${JSON.stringify(error)} stays explicit`, () => {
      const details = workEmailAnalysisDetails(analysisEntry("failed", { error }));
      assert.equal(details?.failureReason, null);
      assert.equal(details?.unavailable, "The failure reason is unavailable for this analysis.");
    });
  }

  test("does not borrow a result from another phase or from a later retry", () => {
    for (const [phase, payload] of [
      ["completed", "failed"],
      ["failed", "completed"],
    ] as const) {
      const details = workEmailAnalysisDetails(
        analysisEntry(phase, { status: payload, error: "A different attempt failed." }),
      );
      assert.equal(details?.summary, null);
      assert.equal(details?.failureReason, null);
      assert.equal(details?.suggestedActions, null);
      assert.ok(details?.unavailable);
    }
  });

  test("keeps legacy analysis rows useful when their source and result are absent", () => {
    const entry = { ...analysisEntry(), subject: "", source: null, analysis: undefined };
    const narrative = workNarrative(entry);
    assert.match(narrative.headline, /^Rey completed email analysis at /);
    assert.doesNotMatch(narrative.headline, /“”|undefined|null/);
    assert.match(narrative.body.join(" "), /Classifies the email.*summarizes.*suggests next steps/);
    assert.match(narrative.body.join(" "), /does not send email or carry out the suggestions/);
    assert.equal(workEntryHref(entry, "acme"), null);
    assert.equal(
      workEmailAnalysisDetails(entry)?.unavailable,
      "Result details are unavailable for this analysis.",
    );
  });

  test("trims empty result fields without inventing a category or next step", () => {
    const details = workEmailAnalysisDetails(
      analysisEntry("completed", {
        summary: " \n ",
        category: " ",
        suggestedActions: ["  ", " Prepare a reply "],
      }),
    );
    assert.equal(details?.summary, null);
    assert.equal(details?.category, null);
    assert.deepEqual(details?.suggestedActions, ["Prepare a reply"]);
    assert.equal(details?.unavailable, "No summary was recorded for this analysis.");
  });

  for (const [durationMs, duration] of [
    [500, "under a second"],
    [1000, "1 second"],
    [42_000, "42 seconds"],
    [60_000, "1 minute"],
    [120_000, "2 minutes"],
  ] as const) {
    test(`names a saved ${durationMs}ms duration without treating completion time as start time`, () => {
      assert.equal(
        workNarrative(analysisEntry("completed", { durationMs })).context,
        `Email with Sam · hello@acme.test · ${duration}`,
      );
    });
  }

  for (const durationMs of [null, 0, -1, Infinity, NaN, Number.MAX_VALUE]) {
    test(`omits unavailable or invalid duration ${String(durationMs)}`, () => {
      assert.equal(
        workNarrative(analysisEntry("completed", { durationMs })).context,
        "Email with Sam · hello@acme.test",
      );
    });
  }

  test("a source-linked action outside the handover namespace is not called a handover", () => {
    const entry = { ...analysisEntry(), detail: "mail.analysis.thread_action", analysis: null };
    const narrative = workNarrative(entry);
    assert.doesNotMatch(narrative.headline, /handover|completed email analysis/);
    assert.equal(narrative.context, "Email with Sam · hello@acme.test");
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

  test("an Email handover change returns to the thread it came from", () => {
    const effect = entryOf({
      kind: "effect",
      run: null,
      source: {
        kind: "mail_thread",
        id: "thread/with spaces",
        accountId: "mailbox/one",
        label: "Email thread",
        detail: "Handed over by a Member",
      },
    });
    assert.equal(
      workEntryHref(effect, "acme"),
      "/c/acme/mail/t/thread%2Fwith%20spaces?account=mailbox%2Fone",
    );
    assert.equal(workEntryLinkLabel(effect), "Open the email thread");
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

describe("leaving an entry", () => {
  test("every kind that has a destination also has a word for it", () => {
    for (const kind of WORK_ENTRY_KINDS) {
      const entry = entryOf({ kind, run: kind === "run" ? entryOf().run : null });
      const href = workEntryHref(entry, "acme");
      assert.equal(
        Boolean(workEntryLinkLabel(entry)),
        Boolean(href),
        `${kind} must label its destination`,
      );
    }
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

describe("durations in words", () => {
  const start = "2026-09-03T12:00:00.000Z";
  const after = (ms: number) => new Date(new Date(start).getTime() + ms).toISOString();

  test("says nothing when the source recorded no end", () => {
    assert.equal(workDurationLabel(start, null), "");
  });

  test("never invents a negative or unparseable length", () => {
    assert.equal(workDurationLabel(start, after(-60_000)), "");
    assert.equal(workDurationLabel(start, "not a date"), "");
  });

  test("a single stamped instant is no duration, not a very short one", () => {
    // A repository turn windows on the moment it finished, so its start and
    // end are the same instant; "under a minute" would be a claim the source
    // never made about work that ran for half an hour.
    assert.equal(workDurationLabel(start, start), "");
  });

  test("crosses the minute, hour and day boundaries in plain words", () => {
    assert.equal(workDurationLabel(start, after(45_000)), "under a minute");
    assert.equal(workDurationLabel(start, after(60_000)), "1 minute");
    assert.equal(workDurationLabel(start, after(23 * 60_000)), "23 minutes");
    assert.equal(workDurationLabel(start, after(60 * 60_000)), "1 hour");
    assert.equal(workDurationLabel(start, after(135 * 60_000)), "2 hours 15 minutes");
    assert.equal(workDurationLabel(start, after(50 * 60 * 60_000)), "2 days");
  });
});

describe("what an entry changed", () => {
  const effect = (action: string, targetType: string, targetLabel = "") => ({
    action,
    targetType,
    targetId: null,
    targetLabel,
    at: "2026-09-03T12:00:00.000Z",
  });

  test("counts repeated actions rather than listing them one by one", () => {
    const phrase = workEffectPhrase(
      entryOf({
        effects: [
          effect("invoice.create", "invoice"),
          effect("invoice.create", "invoice"),
          effect("mail.send", "email"),
        ],
        effectCount: 3,
      }),
    );
    assert.equal(phrase, "created 2 invoices and sent an email");
  });

  test("pluralises awkward nouns without inventing letters", () => {
    const phrase = workEffectPhrase(
      entryOf({
        effects: [
          effect("company.edit", "company"),
          effect("company.edit", "company"),
          effect("address.add", "address"),
          effect("address.add", "address"),
        ],
        effectCount: 4,
      }),
    );
    assert.match(phrase, /updated 2 companies/);
    assert.match(phrase, /added 2 addresses/);
  });

  test("stays honest about rows the server capped and groups it did not name", () => {
    const phrase = workEffectPhrase(
      entryOf({
        effects: [
          effect("invoice.create", "invoice"),
          effect("mail.send", "email"),
          effect("todo.complete", "todo"),
          effect("note.write", "note"),
        ],
        // Four groups drawn from three slots, plus six rows the cap withheld.
        effectCount: 10,
      }),
    );
    assert.match(phrase, /made 7 other changes$/);
  });

  test("says nothing at all when the ledger recorded nothing", () => {
    assert.equal(workEffectPhrase(entryOf()), "");
  });

  test("says a question was kept off the Decision stack, in one and in many", () => {
    assert.equal(
      workEffectPhrase(
        entryOf({ effects: [effect("decision.screen_out", "decision")], effectCount: 1 }),
      ),
      "kept a question off the Decision stack",
    );
    assert.equal(
      workEffectPhrase(
        entryOf({
          effects: [
            effect("decision.screen_out", "decision"),
            effect("decision.create", "decision"),
            effect("decision.screen_out", "decision"),
          ],
          effectCount: 3,
        }),
      ),
      "kept 2 questions off the Decision stack and created a decision",
    );
  });
});

describe("the steps a mailbox's instructions took, said once", () => {
  // The reported sentence: a label that carried its own article had another
  // one added in front of it, and a count added in front of both.
  test("one followed instruction reads 'followed an email instruction', not 'an an'", () => {
    const phrase = workEffectPhrase(
      repeatedRows(1, "mail.analysis.automatic", "mail_inbound_analysis"),
    );
    assert.equal(phrase, "followed an email instruction");
    assert.doesNotMatch(phrase, /an an/);
  });

  for (const count of [2, 3, 7, 12, 100]) {
    test(`${count} followed instructions read as a count with no article beside it`, () => {
      const phrase = workEffectPhrase(
        repeatedRows(count, "mail.analysis.automatic", "mail_inbound_analysis"),
      );
      assert.equal(phrase, `followed ${count} email instructions`);
      assert.doesNotMatch(phrase, /\ban?\b/);
    });
  }

  test("a step that could not be followed reads the same way in one and in many", () => {
    const action = "mail.analysis.automatic_failed";
    assert.equal(
      workEffectPhrase(repeatedRows(1, action, "mail_inbound_analysis")),
      "could not follow an email instruction",
    );
    assert.equal(
      workEffectPhrase(repeatedRows(4, action, "mail_inbound_analysis")),
      "could not follow 4 email instructions",
    );
  });

  test("an undone step reads the same way in one and in many", () => {
    const action = "mail.analysis.automatic_undo";
    assert.equal(
      workEffectPhrase(repeatedRows(1, action, "mail_inbound_analysis")),
      "undid an automatic email step",
    );
    assert.equal(
      workEffectPhrase(repeatedRows(2, action, "mail_inbound_analysis")),
      "undid 2 automatic email steps",
    );
  });

  test("followed, failed and undone steps stay separate groups in one sentence", () => {
    const phrase = workEffectPhrase(
      entryOf({
        effects: [
          ledgerRow("mail.analysis.automatic", "mail_inbound_analysis"),
          ledgerRow("mail.analysis.automatic_failed", "mail_inbound_analysis"),
          ledgerRow("mail.analysis.automatic", "mail_inbound_analysis"),
          ledgerRow("mail.analysis.automatic_undo", "mail_inbound_analysis"),
        ],
        effectCount: 4,
      }),
    );
    assert.equal(
      phrase,
      "followed 2 email instructions, could not follow an email instruction and undid an automatic email step",
    );
    assertArticlesRead(phrase);
  });

  test("a followed instruction sits beside other changes and the withheld tail", () => {
    const phrase = workEffectPhrase(
      entryOf({
        effects: [
          ledgerRow("invoice.create", "invoice"),
          ledgerRow("mail.analysis.automatic", "mail_inbound_analysis"),
          ledgerRow("mail.send", "email"),
          ledgerRow("todo.complete", "todo"),
        ],
        effectCount: 9,
      }),
    );
    assert.equal(
      phrase,
      "created an invoice, followed an email instruction, sent an email and made 6 other changes",
    );
    assertArticlesRead(phrase);
  });

  test("a conversation that followed instructions says so in its narrative", () => {
    const chat = (count: number) =>
      repeatedRows(count, "mail.analysis.automatic", "mail_inbound_analysis", {
        kind: "chat",
        run: null,
      });
    assert.ok(
      workNarrative(chat(1)).body.includes("In that thread it followed an email instruction."),
      workNarrativeText(chat(1)),
    );
    assert.ok(
      workNarrative(chat(3)).body.includes("In that thread it followed 3 email instructions."),
      workNarrativeText(chat(3)),
    );
  });

  test("a repository session that followed instructions says so in its narrative", () => {
    const session = repeatedRows(2, "mail.analysis.automatic", "mail_inbound_analysis", {
      kind: "work_session",
      run: null,
    });
    assert.ok(
      workNarrative(session).body.includes("It followed 2 email instructions."),
      workNarrativeText(session),
    );
  });

  test("a standalone step keeps its list wording in the headline", () => {
    const entry = entryOf({
      kind: "effect",
      run: null,
      title: "Pricing for the autumn launch",
      subject: "Pricing for the autumn launch",
      detail: "mail.analysis.automatic",
    });
    assert.match(
      workNarrative(entry).headline,
      /^Rey followed an email instruction “Pricing for the autumn launch” at .+\.$/,
    );
  });

  test("several email analyses take the irregular plural", () => {
    for (const [action, verb] of [
      ["mail.analysis.started", "started"],
      ["mail.analysis.completed", "completed"],
      ["mail.analysis.failed", "could not complete"],
    ] as const) {
      assert.equal(workEffectPhrase(repeatedRows(1, action)), `${verb} an email analysis`);
      assert.equal(workEffectPhrase(repeatedRows(2, action)), `${verb} 2 email analyses`);
      assert.doesNotMatch(workEffectPhrase(repeatedRows(5, action)), /analysises/);
    }
  });
});

describe("every worded action reads with one article", () => {
  // Iterates the real table, so an action worded later is held to the same
  // grammar without anyone remembering to add it here.
  const counts = [1, 2, 3, 7, 12, 100];

  test("the table still covers the actions the timeline is known to word", () => {
    for (const action of [
      "mail.analysis.started",
      "mail.analysis.completed",
      "mail.analysis.failed",
      "mail.analysis.automatic",
      "mail.analysis.automatic_failed",
      "mail.analysis.automatic_undo",
      "decision.screen_out",
    ]) {
      assert.ok(WORK_ACTION_WORDING.has(action), action);
    }
  });

  for (const [action, wording] of WORK_ACTION_WORDING) {
    test(`${action} has one article for one, and none beside a count`, () => {
      for (const count of counts) {
        const phrase = workEffectPhrase(repeatedRows(count, action, "mail_inbound_analysis"));
        assert.equal(phrase, wording.phrase(count), `${action} × ${count}`);
        assertArticlesRead(phrase);
        if (count === 1) {
          assert.equal(indefiniteArticles(phrase), 1, phrase);
        } else {
          assert.equal(indefiniteArticles(phrase), 0, phrase);
          assert.match(phrase, new RegExp(`\\b${count} \\w`), phrase);
        }
        // It sits mid-sentence: "In that thread it followed an email instruction."
        assert.match(phrase, /^[a-z]/, phrase);
      }
    });

    test(`${action} has one list line, whatever the target type`, () => {
      const label = humanizeWorkAction(action, "mail_inbound_analysis");
      assert.equal(label, wording.label);
      for (const targetType of ["", "decision", "an_email", "the_record"]) {
        assert.equal(humanizeWorkAction(action, targetType), label, targetType);
      }
      assertArticlesRead(label);
      assert.match(label, /^[A-Z]/);
      assert.ok(indefiniteArticles(label) <= 1, label);
    });

    test(`${action} counts every row once, whichever target type each row carries`, () => {
      const phrase = workEffectPhrase(
        entryOf({
          effects: [
            ledgerRow(action, "mail_inbound_analysis"),
            ledgerRow(action, ""),
            ledgerRow(action, "decision"),
          ],
          effectCount: 3,
        }),
      );
      assert.equal(phrase, wording.phrase(3));
    });
  }

  const nowIso = "2026-09-03T12:00:00.000Z";
  const at = "2026-09-03T11:00:00.000Z";
  for (const kind of WORK_ENTRY_KINDS) {
    test(`a ${kind} entry narrates every worded action with readable articles`, () => {
      for (const [action, wording] of WORK_ACTION_WORDING) {
        for (const count of [1, 2, 7]) {
          const entry = repeatedRows(count, action, "mail_inbound_analysis", {
            kind,
            at,
            run: kind === "run" ? entryOf().run : null,
            title: "Pricing for the autumn launch",
            subject: "Pricing for the autumn launch",
            detail: kind === "effect" ? action : "",
          });
          const text = workNarrativeText(entry, { nowIso }).replace(workClock(at), "");
          assertArticlesRead(text);
          if (kind === "chat") {
            assert.ok(text.includes(`In that thread it ${wording.phrase(count)}.`), text);
          }
          if (kind === "work_session")
            assert.ok(text.includes(`It ${wording.phrase(count)}.`), text);
        }
      }
    });
  }
});

describe("every generic verb, counted", () => {
  // Target types the server records, chosen to cover each article and each
  // plural rule: [target type, list line, one, many].
  const targets = [
    ["invoice", "invoice", "an invoice", "invoices"],
    ["estimate", "estimate", "an estimate", "estimates"],
    ["employee", "employee", "an employee", "employees"],
    ["approval", "approval", "an approval", "approvals"],
    ["activity", "activity", "an activity", "activities"],
    ["initiative", "initiative", "an initiative", "initiatives"],
    ["accounting_period", "accounting period", "an accounting period", "accounting periods"],
    [
      "external_chat_identity",
      "external chat identity",
      "an external chat identity",
      "external chat identities",
    ],
    ["api_key", "api key", "an api key", "api keys"],
    ["user", "user", "a user", "users"],
    [
      "mail_inbound_analysis",
      "mail inbound analysis",
      "a mail inbound analysis",
      "mail inbound analyses",
    ],
    ["company", "company", "a company", "companies"],
    ["journal_entry", "journal entry", "a journal entry", "journal entries"],
    [
      "mail_draft_send_batch",
      "mail draft send batch",
      "a mail draft send batch",
      "mail draft send batches",
    ],
    [
      "vault_member_access",
      "vault member access",
      "a vault member access",
      "vault member accesses",
    ],
    ["customerProfile", "customer profile", "a customer profile", "customer profiles"],
    ["deal-stage", "deal stage", "a deal stage", "deal stages"],
  ] as const;

  test("no verb carries an article of its own", () => {
    for (const [operation, verb] of Object.entries(WORK_ACTION_VERBS)) {
      assert.doesNotMatch(verb, /\b(?:a|an|the)\b/i, operation);
      assert.match(verb, /^[A-Z]/, operation);
    }
  });

  for (const [operation, verb] of Object.entries(WORK_ACTION_VERBS)) {
    test(`${operation} says "${verb.toLowerCase()}" with the right article and plural`, () => {
      const action = `ledger.${operation}`;
      for (const [targetType, line, one, many] of targets) {
        assert.equal(humanizeWorkAction(action, targetType), `${verb} ${line}`);
        const single = workEffectPhrase(repeatedRows(1, action, targetType));
        assert.equal(single, `${verb.toLowerCase()} ${one}`);
        assertArticlesRead(single);
        for (const count of [2, 7, 100]) {
          const several = workEffectPhrase(repeatedRows(count, action, targetType));
          assert.equal(several, `${verb.toLowerCase()} ${count} ${many}`);
          assertArticlesRead(several);
        }
      }
    });
  }
});

describe("a or an by how a target sounds", () => {
  for (const [targetType, one] of [
    // A vowel letter said with a consonant.
    ["user", "a user"],
    ["usage_record", "a usage record"],
    ["unit", "a unit"],
    ["union_contract", "a union contract"],
    ["unique_link", "a unique link"],
    ["utility_bill", "a utility bill"],
    ["one_time_link", "a one time link"],
    ["euro_payment", "a euro payment"],
    ["url", "a url"],
    // A consonant letter said with a vowel.
    ["hour_log", "an hour log"],
    ["honest_review", "an honest review"],
    // The ordinary rule, including the "un-" words that keep their vowel.
    ["email", "an email"],
    ["update", "an update"],
    ["unread_count", "an unread count"],
    ["uninstall", "an uninstall"],
    ["step", "a step"],
    ["question", "a question"],
  ] as const) {
    test(`says "${one}"`, () => {
      assert.equal(
        workEffectPhrase(repeatedRows(1, "ledger.create", targetType)),
        `created ${one}`,
      );
    });
  }
});

describe("sentences that already read correctly", () => {
  for (const [name, effects, expected] of [
    [
      "one of each",
      [ledgerRow("invoice.create", "invoice"), ledgerRow("mail.send", "email")],
      "created an invoice and sent an email",
    ],
    ["a consonant target", [ledgerRow("connection.invoke", "connection")], "used a connection"],
    ["a vowel target", [ledgerRow("integration.use", "integration")], "used an integration"],
    ["a two-word verb", [ledgerRow("todo:comment", "todo")], "commented on a todo"],
    ["a target derived from the action", [ledgerRow("note.publish")], "published a note"],
    ["no target at all", [ledgerRow("archive")], "archived a record"],
    [
      "an unknown operation",
      [ledgerRow("billing.reconcile", "bank_account")],
      "reconcile a bank account",
    ],
    [
      "two operations that read the same",
      [
        ledgerRow("note.edit", "note"),
        ledgerRow("note.update", "note"),
        ledgerRow("note.write", "note"),
      ],
      "updated 3 notes",
    ],
    [
      "an analysis attempt",
      [ledgerRow("mail.analysis.completed", "mail_inbound_analysis")],
      "completed an email analysis",
    ],
    [
      "a question kept off the stack",
      [ledgerRow("decision.screen_out", "decision")],
      "kept a question off the Decision stack",
    ],
    [
      "awkward plurals",
      [
        ledgerRow("company.edit", "company"),
        ledgerRow("company.edit", "company"),
        ledgerRow("address.add", "address"),
        ledgerRow("address.add", "address"),
      ],
      "updated 2 companies and added 2 addresses",
    ],
  ] as const) {
    test(`keeps ${name}: "${expected}"`, () => {
      assert.equal(
        workEffectPhrase(entryOf({ effects: [...effects], effectCount: effects.length })),
        expected,
      );
    });
  }

  for (const [action, label, one, two] of [
    [
      "mail.analysis.started",
      "Started email analysis",
      "started an email analysis",
      "started 2 email analyses",
    ],
    [
      "mail.analysis.completed",
      "Completed email analysis",
      "completed an email analysis",
      "completed 2 email analyses",
    ],
    [
      "mail.analysis.failed",
      "Could not complete email analysis",
      "could not complete an email analysis",
      "could not complete 2 email analyses",
    ],
    [
      "mail.analysis.automatic",
      "Followed an email instruction",
      "followed an email instruction",
      "followed 2 email instructions",
    ],
    [
      "mail.analysis.automatic_failed",
      "Could not follow an email instruction",
      "could not follow an email instruction",
      "could not follow 2 email instructions",
    ],
    [
      "mail.analysis.automatic_undo",
      "Undid an automatic email step",
      "undid an automatic email step",
      "undid 2 automatic email steps",
    ],
    [
      "decision.screen_out",
      "Kept off the Decision stack",
      "kept a question off the Decision stack",
      "kept 2 questions off the Decision stack",
    ],
  ] as const) {
    test(`${action} keeps its list line "${label}"`, () => {
      assert.equal(humanizeWorkAction(action, "mail_inbound_analysis"), label);
      assert.equal(workEffectPhrase(repeatedRows(1, action)), one);
      assert.equal(workEffectPhrase(repeatedRows(2, action)), two);
    });
  }

  test("ordinary list lines keep their terse wording without an article", () => {
    assert.equal(humanizeWorkAction("invoice.create", "invoice"), "Created invoice");
    assert.equal(humanizeWorkAction("mail.send", "email"), "Sent email");
    assert.equal(humanizeWorkAction("user.update", "user"), "Updated user");
  });

  test("a target type that reads as nothing falls back to the action's own noun", () => {
    assert.equal(humanizeWorkAction("invoice.create", "__"), "Created invoice");
    assert.equal(workEffectPhrase(repeatedRows(1, "invoice.create", "__")), "created an invoice");
    assert.equal(humanizeWorkAction("create", "--"), "Created record");
    assert.equal(workEffectPhrase(repeatedRows(1, "create", "--")), "created a record");
  });

  test("an operation named like an Object member is still just a word", () => {
    assert.equal(humanizeWorkAction("ledger.constructor", "record"), "Constructor record");
    assert.equal(
      workEffectPhrase(repeatedRows(2, "ledger.constructor", "record")),
      "constructor 2 records",
    );
  });
});

describe("a question kept off the Decision stack", () => {
  test("reads as what happened: nothing was asked", () => {
    const entry = entryOf({
      kind: "effect",
      run: null,
      at: "2026-09-03T09:21:00.000Z",
      title: "Rename the VIP label",
      subject: "Rename the VIP label",
      detail: "decision.screen_out",
    });
    const headline = workNarrative(entry).headline;
    assert.match(headline, /^Rey kept “Rename the VIP label” off the Decision stack at /);
    assert.match(headline, /\.$/);
  });

  test("still reads when the question had no title", () => {
    const entry = entryOf({
      kind: "effect",
      run: null,
      title: "",
      subject: "",
      detail: "decision.screen_out",
    });
    assert.match(workNarrative(entry).headline, /^Rey kept a question off the Decision stack/);
  });
});

describe("an entry in sentences", () => {
  const nowIso = "2026-09-03T12:00:00.000Z";
  const at = "2026-09-03T11:00:00.000Z";
  const ended = "2026-09-03T11:03:00.000Z";

  const noisyEffects = Array.from({ length: 8 }, (_, index) => ({
    action: "connection.invoke",
    targetType: "connection",
    targetId: `connection-${index}`,
    targetLabel: `GitHub · list_issues_${index}`,
    at,
  }));
  const summary =
    "Reviewed GitHub activity and added 3 qualified Contacts. Sent 2 outreach emails.";
  const finished = (run: Partial<NonNullable<WorkEntry["run"]>> = {}) =>
    entryOf({
      at,
      endedAt: ended,
      effects: noisyEffects,
      effectCount: 17,
      run: { ...entryOf().run!, summary, ...run },
    });

  test("leads with the actual reported outcome and moves Routine context out of the result", () => {
    const narrative = workNarrative(
      finished({ outcomeVerdict: "achieved", checksVerdict: "passed" }),
      {
        nowIso,
      },
    );
    assert.equal(narrative.headline, summary);
    assert.equal(narrative.context, "Rey · Nightly digest · 3 minutes");
    assert.deepEqual(narrative.body, []);
    assert.doesNotMatch(
      workNarrativeText(finished()),
      /connections|changes|list_issues|tools|ran the routine/i,
    );
  });

  test("an empty ledger does not replace a reported outcome with a no-work claim", () => {
    const entry = finished();
    const narrative = workNarrative({ ...entry, effects: [], effectCount: 0 }, { nowIso });
    assert.equal(narrative.headline, summary);
    assert.deepEqual(narrative.body, []);
    assert.doesNotMatch(workNarrativeText(entry), /No changes|nothing happened/i);
  });

  test("keeps a genuine no-action outcome when the employee recorded it", () => {
    const narrative = workNarrative(
      finished({ summary: "Reviewed all open issues. None required follow-up." }),
    );
    assert.equal(narrative.headline, "Reviewed all open issues. None required follow-up.");
  });

  for (const absent of [null, "", "  \n "] as const) {
    test(`a missing outcome (${JSON.stringify(absent)}) does not turn audit counts into a result`, () => {
      const narrative = workNarrative(finished({ summary: absent }), { nowIso });
      assert.equal(narrative.headline, "No outcome summary is available for this run.");
      assert.deepEqual(narrative.body, []);
      assert.doesNotMatch(
        workNarrativeText(finished({ summary: absent })),
        /connections|changes|without errors/i,
      );
    });
  }

  test("an older response without the summary property has the same honest fallback", () => {
    const entry = finished();
    delete (entry.run as Partial<NonNullable<WorkEntry["run"]>>).summary;
    assert.equal(workNarrative(entry).headline, "No outcome summary is available for this run.");
  });

  test("a missing Run payload remains readable without inventing a result", () => {
    const narrative = workNarrative({ ...finished(), run: null }, { nowIso });
    assert.equal(narrative.headline, "No outcome summary is available for this run.");
    assert.equal(narrative.context, "Rey · Nightly digest · 3 minutes");
  });

  test("a live run suppresses stale summaries, verdicts and grader narration", () => {
    const entry = finished({
      outcomeVerdict: "achieved",
      outcomeNote: "INTERNAL_TOOL_DETAIL",
      checksVerdict: "passed",
    });
    entry.active = true;
    entry.endedAt = null;
    const narrative = workNarrative(entry, { nowIso });
    assert.equal(
      narrative.headline,
      "This routine is still running. Its outcome will appear when it finishes.",
    );
    assert.equal(narrative.context, "Rey · Nightly digest · 1 hour so far");
    assert.deepEqual(narrative.body, []);
    assert.doesNotMatch(
      workNarrativeText(entry, { nowIso }),
      /qualified Contacts|INTERNAL_TOOL_DETAIL|criteria|Check/,
    );
  });

  test("a running status alone does not override the server's inactive flag", () => {
    const narrative = workNarrative(finished({ status: "running" }), { nowIso });
    assert.equal(narrative.headline, "No outcome summary is available for this run.");
    assert.doesNotMatch(narrative.headline, /still running|qualified Contacts/);
  });

  test("a proactive review never claims its proposed work or delivery Checks were completed", () => {
    const entry = finished({
      status: "reviewed",
      summary,
      outcomeVerdict: "achieved",
      checksVerdict: "failed",
    });
    const narrative = workNarrative(entry, { nowIso });
    assert.equal(
      narrative.headline,
      "The proactive review finished. This Run did not carry out the proposed work.",
    );
    assert.deepEqual(narrative.body, []);
  });

  const stopped = [
    ["failed", "This run failed to complete its intended work. Open the run log for details."],
    ["error", "This run encountered a model or runtime error. Open the run log for details."],
    ["timeout", "This run encountered an error: it ran out of time before it finished."],
    ["skipped", "This routine did not run because no AI Model was assigned."],
    ["interrupted", "This run encountered an error: it was interrupted before it finished."],
  ] as const;
  for (const [status, expected] of stopped) {
    for (const supplied of [null, summary]) {
      test(`${status} states what happened even when a stale summary is ${supplied ? "present" : "absent"}`, () => {
        const entry = finished({ status, summary: supplied, exitCode: 2 });
        const narrative = workNarrative(entry, { nowIso });
        assert.equal(narrative.headline, expected);
        assert.deepEqual(narrative.body, []);
        assert.doesNotMatch(
          workNarrativeText(entry),
          /qualified Contacts|connections|list_issues|exit code/,
        );
      });
    }
  }

  const qualifications = [
    ["achieved", ""],
    ["off_goal", "The result did not meet the routine's acceptance criteria."],
    ["unclear", "A grader could not confirm whether the goal was met."],
    ["unverified", "The outcome has not been verified."],
    [null, ""],
  ] as const;
  for (const [outcomeVerdict, expected] of qualifications) {
    for (const checksVerdict of ["passed", "failed", "not_run", null] as const) {
      test(`keeps outcome ${outcomeVerdict} and Checks ${checksVerdict} independent of a positive report`, () => {
        const entry = finished({
          outcomeVerdict,
          checksVerdict,
          outcomeNote: "INTERNAL_TOOL_DETAIL",
        });
        const narrative = workNarrative(entry, { nowIso });
        assert.equal(narrative.headline, summary);
        const qualification = expected
          ? checksVerdict === "failed"
            ? `${expected.slice(0, -1)}; a required Check failed.`
            : expected
          : checksVerdict === "failed"
            ? "A required Check failed."
            : "";
        assert.deepEqual(narrative.body, qualification ? [qualification] : []);
        assert.doesNotMatch(workNarrativeText(entry), /INTERNAL_TOOL_DETAIL|without errors/);
      });
    }
  }

  test("a failed Check remains visible when a Run also failed", () => {
    const narrative = workNarrative(finished({ status: "failed", checksVerdict: "failed" }));
    assert.equal(narrative.headline, "This run failed to complete its intended work. Open the run log for details.");
    assert.deepEqual(narrative.body, ["A required Check failed."]);
  });

  test("a reported failure stays visible alongside the independent off-goal verdict", () => {
    const narrative = workNarrative(finished({
      status: "failed",
      failureReason: "The source report was unavailable",
      outcomeVerdict: "off_goal",
    }));
    assert.deepEqual(narrative.body, [
      "The source report was unavailable.",
      "The result did not meet the routine's acceptance criteria.",
    ]);
    assert.doesNotMatch(narrative.headline, /qualified Contacts/);
  });

  test("a runtime error retains the earlier employee failure report and unverified outcome", () => {
    const narrative = workNarrative(finished({
      status: "error",
      errorKind: "timeout",
      failureReason: "Missing source report",
      outcomeVerdict: "unverified",
    }));
    assert.equal(narrative.headline, "This run encountered an error: it ran out of time before it finished.");
    assert.deepEqual(narrative.body, ["Missing source report.", "The outcome has not been verified."]);
  });

  test("new interrupted Errors explain the same stop as legacy interrupted Runs", () => {
    const current = workNarrative(finished({ status: "error", errorKind: "interrupted" }));
    const legacy = workNarrative(finished({ status: "interrupted" }));
    assert.equal(current.headline, legacy.headline);
  });

  test("normalises only sentence whitespace and punctuation in the server's summary", () => {
    const narrative = workNarrative(finished({ summary: "  Reviewed 3 Contacts  " }));
    assert.equal(narrative.headline, "Reviewed 3 Contacts.");
    assert.equal(
      workNarrative(finished({ summary: "Does this need follow-up?" })).headline,
      "Does this need follow-up?",
    );
    assert.equal(
      workNarrative(finished({ summary: "Updated the report…" })).headline,
      "Updated the report…",
    );
  });

  test("uses the Routine payload name when the subject is absent", () => {
    const entry = finished();
    entry.subject = " ";
    assert.equal(workNarrative(entry).context, "Rey · Nightly digest · 3 minutes");
  });

  test("missing names and invalid duration remain readable", () => {
    const entry = finished({ routineName: "" });
    entry.subject = "";
    entry.at = "invalid";
    assert.equal(workNarrative(entry).context, "Rey · Routine");
  });

  test("the chart's accessible narrative includes the outcome and its Routine context", () => {
    const text = workNarrativeText(finished({ outcomeVerdict: "off_goal" }), { nowIso });
    assert.match(text, /^Rey · Nightly digest · 3 minutes /);
    assert.ok(text.includes(summary));
    assert.match(text, /did not meet/);
    assert.doesNotMatch(text, /list_issues|connections|changes/);
  });

  test("a pending Approval says a person still has to answer", () => {
    const narrative = workNarrative(
      entryOf({
        at,
        kind: "approval",
        run: null,
        title: "Approval required: Send the invoice",
        subject: "Send the invoice",
        detail: "pending",
      }),
      { nowIso },
    );
    assert.match(narrative.headline, /^Rey stopped and asked for approval/);
    assert.match(narrative.headline, /“Send the invoice”/);
    assert.equal(
      narrative.body[0],
      "Nobody has answered yet, so that piece of work is still on hold.",
    );
  });

  test("every kind names the employee in its narrative and ends the headline in a full stop", () => {
    for (const kind of WORK_ENTRY_KINDS) {
      const narrative = workNarrative(
        entryOf({ kind, at, run: kind === "run" ? entryOf().run : null }),
        { nowIso },
      );
      assert.match(
        [narrative.context, narrative.headline].filter(Boolean).join(" "),
        /^Rey[ ·]/,
        kind,
      );
      assert.match(narrative.headline, /\.$/, kind);
    }
  });
});

describe("counting a window", () => {
  test("counts Routine work without counting its tool calls as changes", () => {
    const sentence = workCountsSentence([
      entryOf({ id: "a", effectCount: 3 }),
      entryOf({ id: "b", kind: "chat", run: null, effectCount: 1 }),
      entryOf({ id: "c", kind: "effect", run: null, effectCount: 0 }),
    ]);
    assert.equal(sentence, "1 routine run, 1 conversation and 2 recorded changes");
  });

  test("a Routine with a large audit ledger contributes only one Run", () => {
    assert.equal(workCountsSentence([entryOf({ effectCount: 100_000 })]), "1 routine run");
  });

  test("counts email analysis lifecycle rows as updates, not completed analyses or changes", () => {
    const entries = ["started", "completed", "failed"].map((phase) =>
      entryOf({ kind: "effect", run: null, detail: `mail.analysis.${phase}` }),
    );
    assert.equal(workCountsSentence(entries.slice(0, 1)), "1 email analysis update");
    assert.equal(workCountsSentence(entries.slice(0, 2)), "2 email analysis updates");
    assert.equal(workCountsSentence(entries), "3 email analysis updates");
  });

  test("counts analysis updates alongside other work without adding them to changed records", () => {
    const entries = [
      entryOf(),
      entryOf({ kind: "effect", run: null, detail: "mail.analysis.completed" }),
      entryOf({ kind: "effect", run: null, detail: "invoice.create" }),
    ];
    assert.equal(
      workCountsSentence(entries),
      "1 routine run, 1 email analysis update and 1 recorded change",
    );
  });

  test("an invoice created from an analysis remains a recorded change", () => {
    assert.equal(
      workCountsSentence([
        entryOf({ kind: "effect", run: null, detail: "mail.analysis.create_invoice" }),
      ]),
      "1 recorded change",
    );
  });

  test("is empty rather than zeroed when nothing happened", () => {
    assert.equal(workCountsSentence([]), "");
  });
});

describe("the day chart", () => {
  const nowIso = "2026-09-03T12:00:00.000Z";
  const window = workChartWindow(nowIso, 24);
  const hoursAgo = (n: number) => new Date(window.endMs - n * 3_600_000).toISOString();

  test("the window is exactly the hours asked for, ending now", () => {
    assert.equal(window.endMs - window.startMs, 24 * 3_600_000);
    assert.equal(window.endMs, new Date(nowIso).getTime());
  });

  test("ticks land on local hour boundaries and stay inside the axis", () => {
    const ticks = workChartTicks(window, 3);
    assert.ok(ticks.length >= 8 && ticks.length <= 9);
    for (const tick of ticks) {
      assert.ok(tick.leftPct >= 0 && tick.leftPct <= 100);
      assert.equal(new Date(Number(tick.key)).getMinutes(), 0);
      assert.equal(new Date(Number(tick.key)).getHours() % 3, 0);
    }
  });

  test("a span is placed and measured against the window", () => {
    const tile = workChartTile(entryOf({ at: hoursAgo(12), endedAt: hoursAgo(6) }), window);
    assert.ok(tile);
    assert.equal(Math.round(tile!.leftPct), 50);
    assert.equal(Math.round(tile!.widthPct), 25);
    assert.equal(tile!.instant, false);
  });

  test("a moment keeps a legible width without claiming a duration", () => {
    const tile = workChartTile(entryOf({ at: hoursAgo(6), endedAt: null }), window);
    assert.ok(tile);
    assert.equal(tile!.instant, true);
    assert.equal(tile!.widthPct, 1.2);
  });

  test("work still in flight runs to the right edge", () => {
    const tile = workChartTile(entryOf({ at: hoursAgo(2), endedAt: null, active: true }), window);
    assert.ok(tile);
    assert.equal(tile!.instant, false);
    assert.equal(Math.round(tile!.leftPct + tile!.widthPct), 100);
  });

  test("a tile is clipped to the window rather than overflowing its lane", () => {
    const tile = workChartTile(entryOf({ at: hoursAgo(40), endedAt: hoursAgo(20) }), window);
    assert.ok(tile);
    assert.equal(tile!.leftPct, 0);
    assert.ok(tile!.leftPct + tile!.widthPct <= 100);
  });

  test("work entirely outside the window is dropped, not squashed onto the edge", () => {
    assert.equal(workChartTile(entryOf({ at: hoursAgo(40), endedAt: hoursAgo(30) }), window), null);
  });

  test("overlapping work stacks instead of hiding under the longest bar", () => {
    const tiles = [
      workChartTile(entryOf({ id: "a", at: hoursAgo(12), endedAt: hoursAgo(4) }), window)!,
      workChartTile(entryOf({ id: "b", at: hoursAgo(11), endedAt: hoursAgo(10) }), window)!,
      workChartTile(entryOf({ id: "c", at: hoursAgo(3), endedAt: hoursAgo(2) }), window)!,
    ];
    const { tracks, hidden } = packWorkChartTracks(tiles);
    assert.equal(hidden, 0);
    assert.equal(tracks.length, 2);
    assert.deepEqual(
      tracks[0].map((tile) => tile.entry.id),
      ["a", "c"],
    );
    assert.deepEqual(
      tracks[1].map((tile) => tile.entry.id),
      ["b"],
    );
  });

  test("what will not fit is counted rather than silently dropped", () => {
    const tiles = ["a", "b", "c", "d"].map(
      (id) => workChartTile(entryOf({ id, at: hoursAgo(6), endedAt: hoursAgo(5) }), window)!,
    );
    const { tracks, hidden } = packWorkChartTracks(tiles, { maxTracks: 2 });
    assert.equal(tracks.length, 2);
    assert.equal(hidden, 2);
  });

  test("every employee keeps a lane, busiest first and the quiet ones last", () => {
    const employees = [
      { id: "quiet", name: "Zoe" },
      { id: "busy", name: "Ada" },
      { id: "live", name: "Bo" },
    ];
    const own = (employeeId: string, over: Partial<WorkEntry>) =>
      entryOf({ ...over, employee: { ...entryOf().employee, id: employeeId } });
    const lanes = buildWorkChartLanes(
      employees,
      [
        own("live", { id: "l", at: hoursAgo(1), endedAt: null, active: true }),
        own("busy", { id: "b", at: hoursAgo(3), endedAt: hoursAgo(2) }),
      ],
      window,
    );
    assert.deepEqual(
      lanes.map((lane) => lane.employee.id),
      ["live", "busy", "quiet"],
    );
    assert.equal(lanes[2].entries.length, 0);
    assert.deepEqual(lanes[2].tracks, []);
    assert.equal(lanes[0].active, true);
  });
});
