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

describe("compact employee work bubble", () => {
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

  test("retains full names, roles and status in the accessible name and tooltip", () => {
    const html = renderBubble({
      name: "Alexandria Rivera-Montgomery",
      role: "Customer operations and strategic partnerships",
      status: "Active 19m ago",
    });
    assert.match(
      html,
      /aria-label="Alexandria Rivera-Montgomery, Customer operations and strategic partnerships, Active 19m ago\. Open their day\."/,
    );
    assert.match(
      html,
      /title="Alexandria Rivera-Montgomery · Customer operations and strategic partnerships · Active 19m ago"/,
    );
  });

  test("uses the small avatar while keeping a comfortable button target", () => {
    const html = renderBubble();
    assert.match(html, /h-6 w-6 text-\[10px\]/);
    assert.match(html, /min-h-11/);
    assert.doesNotMatch(html, /h-10 w-10|flex-col/);
  });

  test("renders uploaded avatars without duplicating their accessible name", () => {
    const html = renderBubble({ avatarSrc: "/api/employee/avatar?v=2" });
    assert.match(html, /<span aria-hidden="true"[^>]*><span[^>]*><img/);
    assert.match(html, /src="\/api\/employee\/avatar\?v=2"/);
    assert.equal((html.match(/aria-label="Rey, /g) ?? []).length, 1);
  });

  test("escapes employee text in names and tooltips", () => {
    const html = renderBubble({ name: 'Rey <Support> "Team"', role: "Sales & Support" });
    assert.match(html, /Rey &lt;Support&gt; &quot;Team&quot;/);
    assert.match(html, /Sales &amp; Support/);
    assert.doesNotMatch(html, /<Support>/);
  });

  test("animates only live status and states a quiet one in words", () => {
    assert.match(renderBubble(), /motion-safe:animate-pulse/);
    const quiet = renderBubble({ state: "quiet", status: "Quiet today" });
    assert.doesNotMatch(quiet, /motion-safe:animate-pulse/);
    assert.match(quiet, /Quiet today/);
  });

  for (const [state, status] of [
    ["working", "Working now"],
    ["waiting", "Waiting on a human"],
    ["recent", "Active 19m ago"],
    ["quiet", "Quiet today"],
  ] as const) {
    test(`announces ${state} in words independently of its status dot`, () => {
      const html = renderBubble({ state, status });
      assert.ok(html.includes(`, ${status}. Open their day.`));
      assert.ok(html.includes(`>${status}</span>`));
      assert.equal(html.includes("motion-safe:animate-pulse"), state === "working");
      assert.doesNotMatch(html, /disabled=/);
    });
  }
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
    assert.match(html, /aria-label="AI employee work"/);
    assert.match(html, /role="group" aria-label="Open an AI employee&#x27;s day"/);
    assert.doesNotMatch(html, /Quiet today|Status unavailable/);
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
    assert.match(html, /role="alert"/);
    assert.doesNotMatch(html, /<button|Open their day|Quiet today/);
  });

  test("leaves no empty header column when the company has no employees", () => {
    const html = renderToStaticMarkup(
      React.createElement(WorkTimelinePanel, {
        company,
        employees: [],
        onOpenRun: () => undefined,
      }),
    );
    assert.equal(html, "");
  });

  test("keeps every employee reachable and in roster order", () => {
    const employees = Array.from({ length: 25 }, (_, index) => ({
      id: `employee-${index}`,
      name: `Employee ${index + 1}`,
      role: `Department ${index + 1}`,
      avatarKey: index === 2 ? "avatar 3" : null,
    })) as Employee[];
    const html = renderToStaticMarkup(
      React.createElement(WorkTimelinePanel, { company, employees, onOpenRun: () => undefined }),
    );
    assert.equal((html.match(/<button /g) ?? []).length, employees.length);
    assert.equal((html.match(/Loading work\. Open their day/g) ?? []).length, employees.length);
    assert.ok(html.indexOf("Employee 1,") < html.indexOf("Employee 25,"));
    assert.match(html, /\/api\/companies\/company-1\/employees\/employee-2\/avatar\?v=avatar%203/);
    assert.match(html, /overflow-x-auto/);
    assert.doesNotMatch(html, /md:flex-col|md:sticky|overflow-y-auto/);
  });
});
