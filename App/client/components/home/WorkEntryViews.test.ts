import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Company, WorkEntry, WorkEntryAnalysis, WorkEntryRun } from "../../lib/api.js";
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
    source: null,
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
    ["error", /encountered a model or runtime error/],
    ["timeout", /ran out of time/],
    ["skipped", /did not run because no AI Model was assigned/],
    ["interrupted", /was interrupted/],
  ] as const;
  for (const [status, expected] of stopped) {
    test(`a ${status} Run shows its factual state rather than a stale successful report`, () => {
      const html = renderEntry(routineEntry({ status, summary, outcomeVerdict: "achieved" }));
      assert.match(html, expected);
      const label = status === "timeout" || status === "interrupted" ? "error" : status;
      assert.ok(html.includes(`>${label}</`));
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

  test("shows the employee's failure reason without replacing the Run status and verdict", () => {
    const html = renderEntry(routineEntry({
      status: "failed",
      failureReason: "The source report is missing.",
      outcomeVerdict: "unverified",
      checksVerdict: "failed",
    }));
    assert.match(html, /The source report is missing/);
    assert.match(html, />failed</);
    assert.match(html, />unverified</);
    assert.match(html, /checks failed/);
    assert.ok(!html.includes(summary));
  });

  test("a proactive review is neutral and never presents a draft report or delivery grade as completed work", () => {
    const html = renderEntry(
      routineEntry({
        status: "reviewed",
        summary,
        outcomeVerdict: "achieved",
        checksVerdict: "passed",
      }),
    );
    assert.match(
      visibleText(html),
      /The proactive review finished\. This Run did not carry out the proposed work\./,
    );
    assert.match(html, />reviewed</);
    assert.doesNotMatch(html, />completed<|>achieved<|checks passed|bg-emerald/);
    assert.ok(!html.includes(summary));
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

describe("standalone change context", () => {
  test("renders the Email thread and trigger beneath a handover change", () => {
    const entry: WorkEntry = {
      ...routineEntry(),
      id: "effect:handover",
      kind: "effect",
      title: "Your shortcut to savings",
      subject: "Your shortcut to savings",
      detail: "mail.handover.complete",
      source: {
        kind: "mail_thread",
        id: "thread-1",
        accountId: "account-1",
        label: "Email with Pure Electric",
        detail: "hello@acme.test · Started by an Email rule",
      },
      run: null,
      effects: [],
      effectCount: 0,
    };
    const text = visibleText(renderEntry(entry));
    assert.match(text, /Jamie Mallers completed an Email handover/);
    assert.match(text, /Email with Pure Electric · hello@acme\.test · Started by an Email rule/);
  });
});

describe("email analysis cards", () => {
  const purpose =
    "Classifies the email, summarizes what it asks for, and suggests next steps. This analysis does not send email or carry out the suggestions.";
  const emailSummary = "Sam asks for a quote for 20 seats before Friday.";
  function analysisEntry(
    status: WorkEntryAnalysis["status"] = "completed",
    analysis: Partial<WorkEntryAnalysis> = {},
  ): WorkEntry {
    return {
      ...routineEntry(),
      id: `effect:analysis-${status}`,
      kind: "effect",
      title: "Autumn launch quote",
      subject: "Autumn launch quote",
      detail: `mail.analysis.${status}`,
      active: false,
      endedAt: null,
      source: {
        kind: "mail_thread",
        id: "email/thread 1",
        accountId: "mailbox-1",
        label: "Email with Sam",
        detail: "sales@acme.test",
      },
      analysis: {
        kind: "email",
        status,
        purpose,
        category: "quote_request",
        summary: emailSummary,
        suggestedActions: ["Prepare a quote", "Prepare a reply"],
        error: null,
        resultAvailable: true,
        durationMs: 42_000,
        ...analysis,
      },
      run: null,
      effects: [],
      effectCount: 0,
    };
  }

  test("shows the email, purpose, recorded finding and suggested next steps together", () => {
    const html = renderEntry(analysisEntry());
    const text = visibleText(html);
    assert.match(html, />Email analysis</);
    assert.match(text, /Jamie Mallers completed email analysis for “Autumn launch quote”/);
    assert.match(text, /Email with Sam · sales@acme.test · 42 seconds/);
    assert.ok(text.includes(purpose));
    assert.match(text, /AI summary Sam asks for a quote for 20 seats before Friday\./);
    assert.match(text, /Category Quote request/);
    assert.match(text, /Suggested next steps Prepare a quote Prepare a reply/);
    assert.doesNotMatch(text, /Change |handover|What changed|Used 8 connections|Why it failed/);
    assert.doesNotMatch(html, /<button|role="button"|href=/);
  });

  test("shows a started event as a recorded start with its purpose and no premature result", () => {
    const html = renderEntry(analysisEntry("started"));
    const text = visibleText(html);
    assert.match(text, /Jamie Mallers started email analysis for “Autumn launch quote”/);
    assert.ok(text.includes(purpose));
    assert.doesNotMatch(text, /AI summary|Category|Suggested next steps|42 seconds|happening now/);
    assert.ok(!text.includes(emailSummary));
  });

  test("shows the recorded error without stale completed findings or recommendations", () => {
    const text = visibleText(
      renderEntry(
        analysisEntry("failed", { error: "The AI Model timed out before returning its analysis." }),
      ),
    );
    assert.match(text, /Jamie Mallers could not complete email analysis/);
    assert.match(text, /Why it failed The AI Model timed out before returning its analysis\./);
    assert.ok(text.includes(purpose));
    assert.doesNotMatch(
      text,
      /AI summary|Category|Suggested next steps|Prepare a quote|happening now/,
    );
    assert.ok(!text.includes(emailSummary));
  });

  for (const status of ["started", "completed", "failed"] as const) {
    for (const analysis of [undefined, null]) {
      test(`an old ${status} event with ${String(analysis)} details still explains what analysis means`, () => {
        const entry = { ...analysisEntry(status), analysis, subject: "", source: null };
        const text = visibleText(renderEntry(entry));
        assert.match(text, /Email analysis/);
        assert.match(text, /Classifies the email.*summarizes.*suggests next steps/);
        assert.match(text, /does not send email or carry out the suggestions/);
        if (status === "completed")
          assert.match(text, /Result details are unavailable for this analysis\./);
        if (status === "failed")
          assert.match(text, /The failure reason is unavailable for this analysis\./);
        assert.doesNotMatch(
          text,
          /Autumn launch quote|Email with Sam|AI summary|Suggested next steps|No next steps|handover/,
        );
      });
    }
  }

  test("an unavailable historical result is not replaced by the email's current analysis", () => {
    const text = visibleText(renderEntry(analysisEntry("completed", { resultAvailable: false })));
    assert.match(text, /Result details are unavailable for this analysis/);
    assert.doesNotMatch(
      text,
      /AI summary|Category|Suggested next steps|Prepare a quote|No next steps/,
    );
    assert.ok(!text.includes(emailSummary));
  });

  test("a recorded empty recommendation list says none were suggested", () => {
    const text = visibleText(renderEntry(analysisEntry("completed", { suggestedActions: [] })));
    assert.match(text, /Suggested next steps No next steps were suggested\./);
    assert.ok(text.includes(emailSummary));
    assert.doesNotMatch(text, /unavailable|No changes|nothing happened/);
  });

  test("a result with no summary still shows its category and saved next steps", () => {
    const text = visibleText(renderEntry(analysisEntry("completed", { summary: "  " })));
    assert.match(text, /No summary was recorded for this analysis\./);
    assert.match(text, /Category Quote request/);
    assert.match(text, /Suggested next steps Prepare a quote/);
    assert.doesNotMatch(text, /AI summary/);
  });

  test("mismatched retry data cannot make a failed event look completed", () => {
    const text = visibleText(
      renderEntry(
        analysisEntry("failed", { status: "completed", error: "A different retry failed." }),
      ),
    );
    assert.match(text, /could not complete email analysis/);
    assert.match(text, /The failure reason is unavailable for this analysis\./);
    assert.doesNotMatch(text, /A different retry|AI summary|Category|Suggested next steps/);
  });

  test("summary and suggestions remain visible when ordinary effect lists are hidden", () => {
    const text = visibleText(renderEntry(analysisEntry(), false));
    assert.match(text, /AI summary/);
    assert.match(text, /Suggested next steps/);
    assert.doesNotMatch(text, /What changed/);
  });

  test("escapes every email- or model-authored field instead of rendering HTML or Markdown links", () => {
    const entry = analysisEntry("completed", {
      summary: '<script>alert("summary")</script> & quote',
      suggestedActions: ['<img src=x onerror="alert(1)">', "[Send](javascript:alert(2))"],
    });
    entry.subject = '<iframe src="https://example.test"></iframe>';
    entry.source!.label = '<a href="javascript:alert(3)">Sam</a>';
    const html = renderEntry(entry);
    assert.match(html, /&lt;script&gt;alert\(&quot;summary&quot;\)&lt;\/script&gt; &amp; quote/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(html, /\[Send\]\(javascript:alert\(2\)\)/);
    assert.match(html, /&lt;iframe/);
    assert.match(html, /&lt;a href=/);
    assert.doesNotMatch(html, /<script|<img|<iframe|<a |<button/);
  });

  test("renders a saved failure reason as plain text", () => {
    const html = renderEntry(
      analysisEntry("failed", { error: '<svg onload="alert(1)"> unavailable & retry' }),
    );
    assert.match(html, /&lt;svg onload=&quot;alert\(1\)&quot;&gt; unavailable &amp; retry/);
    assert.doesNotMatch(html, /<svg onload=/);
  });

  test("the popup names email analysis and links to the exact source thread", () => {
    const entry = analysisEntry();
    const modal = WorkEntryPeekModal({
      company,
      entry,
      nowIso,
      onClose: () => undefined,
      onOpenRun: () => undefined,
      onOpenEmployeeDay: () => undefined,
    });
    assert.match(visibleText(renderToStaticMarkup(modal.props.description)), /Email analysis/);
    assert.ok(visibleText(renderToStaticMarkup(modal.props.children)).includes(emailSummary));
    const actions = React.Children.toArray(modal.props.footer.props.children);
    const link = actions[1] as React.ReactElement<{ to: string; children: React.ReactNode }>;
    assert.equal(link.props.to, "/c/acme/mail/t/email%2Fthread%201?account=mailbox-1");
    assert.match(
      visibleText(renderToStaticMarkup(React.createElement("span", null, link.props.children))),
      /Open the email thread/,
    );
  });

  test("a deleted source does not offer an invented email destination", () => {
    const entry = { ...analysisEntry(), source: null };
    const modal = WorkEntryPeekModal({
      company,
      entry,
      nowIso,
      onClose: () => undefined,
      onOpenRun: () => undefined,
      onOpenEmployeeDay: () => undefined,
    });
    const text = visibleText(renderToStaticMarkup(modal.props.footer));
    assert.doesNotMatch(text, /Open the email thread|Open the run log/);
    assert.match(text, /See the whole day/);
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
