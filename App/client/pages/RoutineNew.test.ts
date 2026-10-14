import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, Route, Routes, StaticRouter } from "react-router-dom";

import type { Company, Employee } from "../lib/api.js";
import { ChatSessionsProvider } from "../lib/chatSessions.js";
import { ROUTINE_EXAMPLES } from "../lib/routineExamples.js";
import RoutineNew from "./RoutineNew.js";
import type { RoutinesContext } from "./RoutinesLayout.js";

/**
 * What New routine shows before anyone has clicked anything: the box to
 * describe the work in, the examples, and only the employees who can answer a
 * Chat. The form's own fields wait behind Set it up yourself, so none of them
 * may be on the page yet. (Clicks and the hand-off to Chat are covered in real
 * Chrome by `scripts/test-clicks-routines.ts`.)
 */

const h = React.createElement;

// `Select` measures its menu in a layout effect, which React warns does
// nothing on the server. True, and repeated for every render.
const consoleError = console.error.bind(console);
mock.method(console, "error", (...args: unknown[]) => {
  if (String(args[0]).includes("useLayoutEffect does nothing on the server")) return;
  consoleError(...args);
});

const owner = {
  id: "company",
  slug: "acme",
  name: "Acme",
  mission: "",
  vision: "",
  role: "owner",
  financeAccess: "full",
  requireTwoFactor: false,
} satisfies Company;
const member = { ...owner, role: "member" } satisfies Company;

function hire(id: string, name: string, role: string, chatReady: boolean): Employee {
  return { id, companyId: "company", name, slug: id, role, chatReady };
}
const ALEX = hire("alex", "Alex Rivera", "Account manager", true);
const SAM = hire("sam", "Sam Okafor", "Engineer", true);
const NOVA = hire("nova", "Nova Chen", "Designer", false);

/** The few entities React escapes in text: "don&#x27;t" reads "don't". */
function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

/** New routine as `App.tsx` mounts it, beneath the Routines layout's context. */
function render(company: Company, employees: Employee[], at = "/c/acme/routines/new"): string {
  const context: RoutinesContext = {
    routines: [],
    employees,
    folders: [],
    unfiledCount: 0,
    maxFolderDepth: 5,
    loading: false,
    loadError: null,
    refresh: async () => {},
  };
  return decode(
    renderToStaticMarkup(
      h(
        ChatSessionsProvider,
        null,
        h(
          StaticRouter,
          { location: at },
          h(
            Routes,
            null,
            h(
              Route,
              { path: "/c/:companySlug/routines", element: h(Outlet, { context }) },
              h(Route, { path: "new", element: h(RoutineNew, { company }) }),
            ),
          ),
        ),
      ),
    ),
  );
}

const optionValues = (html: string) =>
  [...html.matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);

describe("New routine, before anything is clicked", () => {
  const html = render(owner, [ALEX, SAM, NOVA]);

  test("opens on the box to describe the work in, not on the form", () => {
    assert.match(html, /What should happen, and how often\?/);
    assert.match(html, /Continue to Chat/);
    assert.match(html, /Set it up yourself/);
    for (const field of [
      "Assigned to",
      "What should happen on each run?",
      "Create routine",
      "More options",
      "Describe it instead",
    ]) {
      assert.ok(!html.includes(field), `${field} waits behind Set it up yourself`);
    }
  });

  test("offers each example, and says what happens next", () => {
    for (const example of ROUTINE_EXAMPLES) assert.ok(html.includes(example.label), example.label);
    assert.match(html, /Nothing is sent yet: you review the request in Chat first\./);
    assert.match(html, /proposes the Routine as an Initiative/);
    assert.match(html, /href="\/c\/[^"]+\/decisions\/initiatives"[^>]*>Decision stack → Initiatives</);
    assert.match(html, /until an owner or admin accepts it/);
  });

  test("offers only the employees whose Chat is ready", () => {
    assert.deepEqual(optionValues(html), ["", "alex", "sam"]);
  });

  test("leaves the choice to the person while two can answer", () => {
    assert.doesNotMatch(html, /value="(Alex Rivera|Sam Okafor)[^"]*"/);
  });
});

describe("the employee chosen to begin with", () => {
  test("is the one the list was narrowed to, when they can answer", () => {
    const html = render(owner, [ALEX, SAM, NOVA], "/c/acme/routines/new?employee=sam");
    assert.match(html, /value="Sam Okafor — Engineer"/);
    assert.match(html, /Sam Okafor then proposes the Routine/);
  });

  test("is the only employee who can answer, whoever the list was narrowed to", () => {
    const html = render(owner, [ALEX, NOVA], "/c/acme/routines/new?employee=nova");
    assert.match(html, /value="Alex Rivera — Account manager"/);
    assert.deepEqual(optionValues(html), ["", "alex"]);
  });
});

describe("when New routine cannot be used as it opens", () => {
  test("nobody able to answer opens the form, and says why", () => {
    const html = render(owner, [NOVA, { ...ALEX, chatReady: false }]);
    assert.match(html, /Describing a Routine needs an AI Employee with a connected AI Model/);
    assert.match(html, /href="\/c\/acme\/employees\/nova\/settings\/model"/);
    assert.match(html, /What should happen on each run\?/);
    assert.match(html, /Create routine/);
    assert.ok(!html.includes("What should happen, and how often?"));
    assert.ok(!html.includes("Describe it instead"));
  });

  test("no AI Employees at all points to hiring one", () => {
    const html = render(owner, []);
    assert.match(html, /No AI employees yet/);
    assert.ok(!html.includes("Continue to Chat"));
  });

  test("a Member gets a note in place of the page", () => {
    const html = render(member, [ALEX, SAM]);
    assert.match(html, /Only owners and admins create Routines/);
    assert.ok(!html.includes("<textarea"), "no box for a request that could only be refused");
    assert.ok(!html.includes("Set it up yourself"));
  });
});
