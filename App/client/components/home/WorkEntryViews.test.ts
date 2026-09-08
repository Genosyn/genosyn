import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Company, WorkEntry, WorkEntryRun } from "../../lib/api.js";
import { WorkEntryBlock } from "./WorkEntryViews.js";
import { WorkEntryPeekModal } from "./WorkEntryPeekModal.js";

const nowIso = "2026-09-08T10:00:00.000Z";
const at = "2026-09-08T08:00:00.000Z";
const summary = "Added 3 qualified Contacts from GitHub activity. Sent 2 outreach emails.";
const company = { id: "company-1", name: "Acme", slug: "acme" } as Company;

/** Mirrors the reported screenshot: eight Connection calls and nine more rows. */
function routineEntry(run: Partial<WorkEntryRun> = {}): WorkEntry {
  return {
    id: "run:run-1",
    kind: "run",
    at,
    endedAt: "2026-09-08T08:09:00.000Z",
    active: false,
    employee: { id: "employee-1", name: "Jamie Mallers", slug: "jamie", avatarKey: null },
    title: "Ran Daily GitHub Lead Capture & Outreach",
    subject: "Daily GitHub Lead Capture & Outreach",
    detail: "Used 8 connections and made 9 other changes",
    run: {
      id: "run-1",
      routineId: "routine-1",
      routineName: "Daily GitHub Lead Capture & Outreach",
      summary,
      status: "completed",
      exitCode: 0,
      triggerKind: "schedule",
      attempt: 1,
      outcomeVerdict: null,
      outcomeNote: null,
      checksVerdict: null,
      ...run,
    },
    effects: Array.from({ length: 8 }, (_, index) => ({
      action: "connection.invoke",
      targetType: "connection",
      targetId: `connection-${index}`,
      targetLabel: `GitHub · list_issues_${index}`,
      at,
    })),
    effectCount: 17,
  };
}

function renderEntry(entry = routineEntry(), showEffects?: boolean): string {
  return renderToStaticMarkup(React.createElement(WorkEntryBlock, { entry, nowIso, showEffects }));
}

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

const ledgerCopy =
  /What changed|Used 8 connections|9 other changes|more changes|list_issues_|Used connection|ran the routine/i;

describe("Routine outcome blocks shared by the popup and employee day", () => {
  test("shows the work outcome before the quiet Routine name and duration", () => {
    const html = renderEntry();
    assert.ok(html.includes(summary));
    assert.match(html, /Jamie Mallers · Daily GitHub Lead Capture &amp; Outreach · 9 minutes/);
    assert.ok(html.indexOf(summary) < html.indexOf("Jamie Mallers"));
    assert.match(html, />completed</);
    assert.doesNotMatch(html, ledgerCopy);
  });

  for (const showEffects of [undefined, true, false]) {
    test(`never renders the Routine ledger when showEffects is ${String(showEffects)}`, () => {
      assert.doesNotMatch(renderEntry(routineEntry(), showEffects), ledgerCopy);
    });
  }

  for (const summary of [null, "", " \n "]) {
    test(`legacy Run summary ${JSON.stringify(summary)} explains what is missing without implying no work`, () => {
      const html = renderEntry(routineEntry({ summary }));
      assert.match(html, /No outcome summary is available for this run\./);
      assert.doesNotMatch(html, /No changes|without errors|nothing happened|unverified/);
      assert.doesNotMatch(html, ledgerCopy);
    });
  }

  test("does not repeat long grader narration in the one-line outcome", () => {
    const html = renderEntry(
      routineEntry({
        outcomeVerdict: "off_goal",
        outcomeNote: "INTERNAL_TOOL_DETAIL connection.invoke list_issues checks 1 2 3 4 5",
      }),
    );
    assert.match(
      visibleText(html),
      /The result did not meet the routine&#x27;s acceptance criteria/,
    );
    assert.doesNotMatch(visibleText(html), /INTERNAL_TOOL_DETAIL|connection.invoke|list_issues/);
  });

  const verdicts = [
    ["achieved", "achieved"],
    ["off_goal", "off goal"],
    ["unclear", "unclear"],
    ["unverified", "unverified"],
    [null, null],
  ] as const;
  for (const [outcomeVerdict, label] of verdicts) {
    for (const checksVerdict of ["passed", "failed", "not_run", null] as const) {
      test(`preserves ${outcomeVerdict} and ${checksVerdict} status axes beside the outcome`, () => {
        const html = renderEntry(routineEntry({ outcomeVerdict, checksVerdict }));
        const text = visibleText(html);
        assert.ok(text.includes(summary));
        assert.match(html, />completed</);
        if (label) assert.ok(html.includes(`>${label}</`));
        else assert.doesNotMatch(html, />achieved<|>unverified<|>unclear<|>off goal</);
        if (checksVerdict === "passed" || checksVerdict === "failed") {
          assert.match(text, new RegExp(`checks ${checksVerdict}`));
        } else {
          assert.doesNotMatch(text, /checks passed|checks failed|checks not_run/);
        }
        if (checksVerdict === "failed") assert.match(text, /required Check failed/);
        if (outcomeVerdict === "off_goal") assert.match(text, /did not meet/);
        if (outcomeVerdict === "unclear") assert.match(text, /could not confirm/);
        if (outcomeVerdict === "unverified") assert.match(text, /has not been verified/);
        assert.doesNotMatch(html, ledgerCopy);
      });
    }
  }

  test("an active Run does not show a stale report", () => {
    const entry = routineEntry({ status: "running" });
    entry.active = true;
    entry.endedAt = null;
    const html = renderEntry(entry);
    assert.match(html, /This routine is still running/);
    assert.match(html, />running</);
    assert.match(html, /happening now/);
    assert.doesNotMatch(html, />completed<|>achieved<|checks passed/);
    assert.ok(!html.includes(summary));
    assert.doesNotMatch(html, ledgerCopy);
  });

  const stopped = [
    ["failed", /This run failed/],
    ["timeout", /ran out of time/],
    ["skipped", /did not run because no AI Model was assigned/],
    ["interrupted", /was interrupted/],
  ] as const;
  for (const [status, expected] of stopped) {
    test(`a ${status} Run shows its factual state rather than a stale successful report`, () => {
      const html = renderEntry(routineEntry({ status, summary, outcomeVerdict: "achieved" }));
      assert.match(html, expected);
      assert.ok(html.includes(`>${status}</`));
      assert.ok(!html.includes(summary));
      assert.doesNotMatch(html, />completed<|happening now/);
      assert.match(html, />achieved</);
      assert.doesNotMatch(html, ledgerCopy);
    });
  }

  test("preserves the recorded verdict and Checks even when a Run has failed", () => {
    const html = renderEntry(
      routineEntry({ status: "failed", outcomeVerdict: "off_goal", checksVerdict: "failed" }),
    );
    assert.match(html, />failed</);
    assert.match(html, />off goal</);
    assert.match(visibleText(html), /checks failed/);
    assert.match(visibleText(html), /required Check failed/);
  });

  test("escapes the outcome as text, including tags and special characters", () => {
    const html = renderEntry(
      routineEntry({ summary: '<script>alert("report")</script> & reviewed Contacts.' }),
    );
    assert.match(
      html,
      /&lt;script&gt;alert\(&quot;report&quot;\)&lt;\/script&gt; &amp; reviewed Contacts\./,
    );
    assert.doesNotMatch(html, /<script>|<iframe|onerror=/);
  });

  test("keeps an empty or malformed Run payload readable without showing its ledger", () => {
    const entry = routineEntry();
    entry.run = null;
    const html = renderEntry(entry);
    assert.match(html, /No outcome summary is available/);
    assert.doesNotMatch(html, ledgerCopy);
  });

  test("keeps recorded changes available for non-Routine work", () => {
    const entry = routineEntry();
    entry.kind = "chat";
    entry.run = null;
    entry.detail = "2 replies";
    const html = renderEntry(entry);
    assert.match(html, /What changed/);
    assert.match(html, /list_issues_0/);
    assert.match(html, /9 more changes/);
    assert.doesNotMatch(renderEntry(entry, false), /What changed|list_issues_/);
  });
});

describe("Routine popup", () => {
  const modalFor = (entry: WorkEntry, onOpenRun: (entry: WorkEntry) => void = () => undefined) =>
    WorkEntryPeekModal({
      company,
      entry,
      nowIso,
      onClose: () => undefined,
      onOpenRun,
      onOpenEmployeeDay: () => undefined,
    });

  test("renders the same outcome block in the actual popup body", () => {
    const modal = modalFor(routineEntry());
    const html = renderToStaticMarkup(modal.props.children);
    assert.ok(html.includes(summary));
    assert.doesNotMatch(html, ledgerCopy);
  });

  test("preserves both the whole-day action and the full Run log action", () => {
    const entry = routineEntry();
    const modal = modalFor(entry);
    const html = renderToStaticMarkup(modal.props.footer);
    assert.match(html, /See the whole day/);
    assert.match(html, /Open the run log/);
  });

  test("opening the Run log passes the exact selected Run back to Home", () => {
    const entry = routineEntry();
    let selected: WorkEntry | null = null;
    const modal = modalFor(entry, (value) => {
      selected = value;
    });
    const actions = React.Children.toArray(modal.props.footer.props.children);
    const action = actions[1] as React.ReactElement<{ onClick: () => void }>;
    action.props.onClick();
    assert.equal(selected, entry);
  });

  test("a Run without payload cannot offer a fabricated Run log destination", () => {
    const entry = routineEntry();
    entry.run = null;
    const html = renderToStaticMarkup(modalFor(entry).props.footer);
    assert.match(html, /See the whole day/);
    assert.doesNotMatch(html, /Open the run log/);
  });
});
