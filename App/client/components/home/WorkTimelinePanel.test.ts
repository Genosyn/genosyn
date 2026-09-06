import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Company, Employee, WorkEntry } from "../../lib/api.js";
import { EmployeeWorkBubble, teamSentence, WorkTimelinePanel } from "./WorkTimelinePanel.js";

/**
 * The App deliberately has no browser-like unit-test DOM. Server rendering is
 * enough to pin the roster's accessibility contract — the circle stays a real
 * button that announces the employee and their state in words — and the
 * headline's contract, which is that a pending or failed request must never
 * read as a quiet team.
 */
function renderBubble(
  overrides: Partial<React.ComponentProps<typeof EmployeeWorkBubble>> = {},
): string {
  return renderToStaticMarkup(
    React.createElement(EmployeeWorkBubble, {
      name: "Rey",
      role: "Customer support",
      avatarSrc: null,
      state: "working",
      status: "Working now",
      onSelect: () => undefined,
      ...overrides,
    }),
  );
}

describe("employee work circle", () => {
  test("is a labelled button that says what clicking it does", () => {
    const html = renderBubble();
    assert.match(html, /^<button/);
    assert.match(html, /type="button"/);
    assert.match(html, /aria-label="Rey, Customer support, Working now\. Open their day\."/);
    assert.match(html, />Rey</);
    assert.match(html, />Working now</);
  });

  test("keeps the avatar subtree out of the accessibility name", () => {
    const html = renderBubble();
    assert.match(html, /<span aria-hidden="true"[^>]*><span[^>]*aria-label="Rey"/);
  });

  test("animates only live status and states a quiet one in words", () => {
    assert.match(renderBubble(), /motion-safe:animate-pulse/);
    const quiet = renderBubble({ state: "quiet", status: "Quiet today" });
    assert.doesNotMatch(quiet, /motion-safe:animate-pulse/);
    assert.match(quiet, /Quiet today/);
  });
});

describe("the headline over the roster", () => {
  const counts = { employees: 3, workingCount: 0, waitingCount: 0, activeCount: 0, entries: [] };

  test("never mistakes a pending request for a quiet team", () => {
    const sentence = teamSentence({ ...counts, status: "loading" });
    assert.match(sentence, /Reading back/);
    assert.doesNotMatch(sentence, /Nobody is working/);
  });

  test("never mistakes a failed request for a quiet team", () => {
    const sentence = teamSentence({ ...counts, status: "unavailable" });
    assert.match(sentence, /could not be loaded/);
    assert.doesNotMatch(sentence, /Nobody is working/);
  });

  test("leads with live work, then a human gate, then the day's total", () => {
    assert.match(
      teamSentence({ ...counts, status: "ready", workingCount: 1, activeCount: 2 }),
      /^1 of 3 employees is working right now\./,
    );
    assert.match(
      teamSentence({ ...counts, status: "ready", waitingCount: 2, activeCount: 2 }),
      /^2 employees are waiting for a person\./,
    );
    assert.match(
      teamSentence({ ...counts, status: "ready", activeCount: 2 }),
      /^2 of 3 employees have worked in the last 24 hours\./,
    );
    assert.match(teamSentence({ ...counts, status: "ready" }), /^Nobody is working right now\./);
  });

  test("counts the window's work in the same breath", () => {
    const entry = {
      id: "run:1",
      kind: "run",
      at: new Date().toISOString(),
      endedAt: null,
      active: false,
      employee: { id: "e1", name: "Rey", slug: "rey", avatarKey: null },
      title: "Ran Nightly digest",
      subject: "Nightly digest",
      detail: "",
      run: null,
      effects: [],
      effectCount: 2,
    } as WorkEntry;
    assert.match(
      teamSentence({ ...counts, status: "ready", activeCount: 1, entries: [entry] }),
      /Between them they logged 1 routine run and 2 recorded changes\./,
    );
    assert.match(
      teamSentence({ ...counts, status: "ready" }),
      /Nothing has been recorded in the last 24 hours\./,
    );
  });
});

const company = {
  id: "company-1",
  name: "Acme",
  slug: "acme",
} as Company;

describe("employee work shell", () => {
  test("puts a roster failure inline instead of silently hiding the panel", () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkTimelinePanel, {
        company,
        employees: [] as Employee[],
        employeeLoadError: "Could not load your AI employees.",
        onOpenRun: () => undefined,
      }),
    );
    assert.match(html, /AI employee work/);
    assert.match(html, /Could not load your AI employees/);
  });
});
