import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Company, Employee } from "../../lib/api.js";
import { EmployeeWorkBubble, WorkTimelinePanel } from "./WorkTimelinePanel.js";

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
    assert.match(html, /aria-haspopup="dialog"/);
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

const company = {
  id: "company-1",
  name: "Acme",
  slug: "acme",
} as Company;

describe("employee work shell", () => {
  test("shows employee bubbles without exposing work details or a team chart", () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkTimelinePanel, {
        company,
        employees: [{ id: "e1", name: "Rey", role: "Support", avatarKey: null }] as Employee[],
        onOpenRun: () => undefined,
      }),
    );
    assert.match(html, /<aside/);
    assert.match(html, /Open their day/);
    assert.match(html, /Loading work/);
    assert.doesNotMatch(html, /The last 24 hours|Every bar|Between them|Routine run|<dialog/);
  });
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
