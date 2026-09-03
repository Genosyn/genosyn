import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Company, Employee } from "../../lib/api.js";
import { EmployeeWorkBubble, TeamSpotlight, WorkTimelinePanel } from "./WorkTimelinePanel.js";

/**
 * The App deliberately has no browser-like unit-test DOM. Server rendering is
 * enough to pin the bubble's accessibility contract: it remains a real button,
 * exposes selection and status without relying on colour, and keeps its large
 * visual target even when the avatar falls back to initials.
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
      selected: true,
      onSelect: () => undefined,
      ...overrides,
    }),
  );
}

describe("employee work bubble", () => {
  test("is a labelled selection button with human-readable status", () => {
    const html = renderBubble();
    assert.match(html, /^<button/);
    assert.match(html, /type="button"/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /aria-label="Rey, Customer support, Working now"/);
    assert.match(html, />Rey</);
    assert.match(html, />Working now</);
  });

  test("keeps the avatar subtree out of the accessibility name", () => {
    const html = renderBubble();
    assert.match(html, /<span aria-hidden="true"[^>]*><span[^>]*aria-label="Rey"/);
  });

  test("animates only live status and exposes quiet status in words", () => {
    assert.match(renderBubble(), /motion-safe:animate-pulse/);
    const quiet = renderBubble({ state: "quiet", status: "Quiet today", selected: false });
    assert.doesNotMatch(quiet, /motion-safe:animate-pulse/);
    assert.match(quiet, /aria-pressed="false"/);
    assert.match(quiet, /Quiet today/);
  });
});

describe("team work loading states", () => {
  const employee = {
    id: "employee-1",
    name: "Rey",
    slug: "rey",
    role: "Customer support",
  } as Employee;

  function renderStatus(status: "loading" | "unavailable"): string {
    return renderToStaticMarkup(
      React.createElement(TeamSpotlight, {
        employees: [employee],
        summaries: [],
        workingCount: 0,
        waitingCount: 0,
        activeCount: 0,
        status,
        onSelect: () => undefined,
      }),
    );
  }

  test("never mistakes a pending request for a quiet team", () => {
    const html = renderStatus("loading");
    assert.match(html, /Loading your team&#x27;s work/);
    assert.doesNotMatch(html, /No one is working/);
  });

  test("never mistakes a failed request for a quiet team", () => {
    const html = renderStatus("unavailable");
    assert.match(html, /Work status is unavailable/);
    assert.doesNotMatch(html, /No one is working/);
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
        employees: [],
        employeeLoadError: "Could not load your AI employees.",
        onOpenRun: () => undefined,
      }),
    );
    assert.match(html, /AI employee work/);
    assert.match(html, /Could not load your AI employees/);
  });
});
