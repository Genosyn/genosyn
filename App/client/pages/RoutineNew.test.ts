import assert from "node:assert/strict";
import { describe, mock, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, Route, Routes, StaticRouter } from "react-router-dom";

import type { Company, Employee, RoutineFolder } from "../lib/api.js";
import { ChatSessionsProvider } from "../lib/chatSessions.js";
import { ROUTINE_EXAMPLES } from "../lib/routineExamples.js";
import RoutineNew from "./RoutineNew.js";
import type { RoutinesContext } from "./RoutinesLayout.js";

/**
 * What New routine shows before anyone has clicked anything: the form, with
 * every field on it and Describe it instead beneath it. The box to describe
 * the work in waits behind that link, unless the address asks for it with
 * `?describe=1` and someone can answer a Chat; there, only the employees who
 * can are offered. (Clicks, switching back and forth, and the presets the form
 * picks up once the roster lands are covered in real Chrome by
 * `scripts/test-new-routine.ts` and `scripts/test-clicks-routines.ts`.)
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
const admin = { ...owner, role: "admin" } satisfies Company;
const member = { ...owner, role: "member" } satisfies Company;

function hire(id: string, name: string, role: string, chatReady: boolean): Employee {
  return { id, companyId: "company", name, slug: id, role, chatReady };
}
const ALEX = hire("alex", "Alex Rivera", "Account manager", true);
const SAM = hire("sam", "Sam Okafor", "Engineer", true);
const NOVA = hire("nova", "Nova Chen", "Designer", false);

const OPERATIONS = {
  id: "ops",
  companyId: "company",
  name: "Operations",
  slug: "ops",
  parentId: null,
  sortOrder: 0,
  path: "Operations",
  depth: 1,
  routineCount: 1,
  totalRoutineCount: 1,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
} satisfies RoutineFolder;

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
function render(
  company: Company,
  employees: Employee[],
  at = "/c/acme/routines/new",
  folders: RoutineFolder[] = [],
): string {
  const context: RoutinesContext = {
    routines: [],
    employees,
    folders,
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

/** The values a picker offers, read from the native select beneath its label. */
function optionsOf(html: string, label: string): string[] {
  const start = html.indexOf(`>${label}</label>`);
  assert.notEqual(start, -1, `${label} is on the page`);
  const end = html.indexOf("</select>", start);
  return [...html.slice(start, end).matchAll(/<option value="([^"]*)"/g)].map((match) => match[1]);
}

/** The opening tag of the button whose content ends with `text`. */
function buttonTag(html: string, text: string): string {
  const at = html.indexOf(text);
  assert.notEqual(at, -1, `${text} is on the page`);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf(">", start) + 1);
}

/** Everything that belongs to the form alone. */
const FORM = [
  "Name",
  "Assigned to",
  "Schedule",
  "What should happen on each run?",
  "Advanced",
  "Create routine",
];
/** Everything that belongs to the box alone. */
const BOX = [
  "What should happen, and how often?",
  "Examples",
  "Continue to Chat",
  "Nothing is sent yet",
  "Back to the form",
];

function assertForm(html: string, where: string) {
  for (const field of FORM) assert.ok(html.includes(field), `${where}: ${field} is on the form`);
  for (const part of BOX)
    assert.ok(!html.includes(part), `${where}: ${part} waits behind the link`);
}

function assertBox(html: string, where: string) {
  for (const part of BOX) assert.ok(html.includes(part), `${where}: ${part} is in the box`);
  for (const field of ["Assigned to", "What should happen on each run?", "Create routine"]) {
    assert.ok(!html.includes(field), `${where}: ${field} waits behind Back to the form`);
  }
  assert.ok(!html.includes("Describe it instead"), `${where}: already describing`);
}

describe("New routine, before anything is clicked", () => {
  const html = render(owner, [ALEX, SAM, NOVA]);

  test("opens on the form, not on the box to describe the work in", () => {
    assertForm(html, "a plain New routine");
    assert.match(html, /<h1[^>]*>New routine<\/h1>/);
    assert.match(html, />Cancel</);
  });

  test("puts the cursor in Name, the first field", () => {
    assert.match(html, /<input[^>]*placeholder="Morning inbox digest"[^>]*autofocus=""/);
    assert.equal(html.match(/autofocus=""/g)?.length, 1, "nothing else asks for focus");
  });

  test("offers Describe it instead beneath the form, as a button that stays on the page", () => {
    assert.match(html, /<button type="button"[^>]*>Describe it instead<\/button>/);
    assert.ok(
      html.indexOf("Describe it instead") > html.indexOf("Create routine"),
      "the link sits under the form, after its buttons",
    );
    assert.ok(!html.includes("routines/new?describe"), "nothing links away to describe");
  });

  test("lists every employee to assign it to, whether or not they can answer a Chat", () => {
    assert.deepEqual(optionsOf(html, "Assigned to"), ["alex", "sam", "nova"]);
  });

  test("starts on the weekday-morning schedule, with its brief still to write", () => {
    assert.match(html, /Every weekday at 9:00 AM/);
    assert.match(html, /<button type="submit" disabled=""[^>]*>Create routine</);
  });

  test("keeps Folder and Tags behind one closed Advanced disclosure that says none is set", () => {
    const toggle = buttonTag(html, ">Advanced<");
    assert.match(toggle, /aria-expanded="false"/);
    assert.match(html, />Advanced<\/span><span[^>]*>No folder or tags<\/span>/);
    assert.ok(!html.includes(">Folder</label>"));
    assert.ok(!html.includes(">Tags<"));
  });

  test("says nothing about connecting an AI Model while someone can answer", () => {
    assert.ok(!html.includes("Describing a Routine needs"));
    assert.ok(!html.includes("Connect an AI Model"));
  });

  test("opens the same way for an admin", () => {
    assertForm(render(admin, [ALEX, SAM, NOVA]), "an admin");
  });
});

describe("presets never open the box", () => {
  for (const at of [
    "/c/acme/routines/new?employee=sam",
    "/c/acme/routines/new?folder=ops",
    "/c/acme/routines/new?folder=ops&employee=sam",
    "/c/acme/routines/new?employee=nova",
    "/c/acme/routines/new?employee=nobody&folder=gone",
  ]) {
    test(at.slice("/c/acme/routines/new".length), () => {
      const html = render(owner, [ALEX, SAM, NOVA], at, [OPERATIONS]);
      assertForm(html, at);
      assert.match(html, />Describe it instead</);
    });
  }

  test("nor does a describe parameter that is not exactly 1", () => {
    for (const value of ["", "0", "true", "yes"]) {
      const at = `/c/acme/routines/new?describe=${value}`;
      assertForm(render(owner, [ALEX, SAM], at), at);
    }
  });
});

describe("an address that asks for the box with ?describe=1", () => {
  const html = render(owner, [ALEX, SAM, NOVA], "/c/acme/routines/new?describe=1");

  test("opens on the box, with Back to the form beneath it", () => {
    assertBox(html, "?describe=1");
    assert.match(html, /<button type="button"[^>]*>Back to the form<\/button>/);
    assert.ok(html.indexOf("Back to the form") > html.indexOf("Continue to Chat"));
  });

  test("puts the cursor in the box", () => {
    assert.match(html, /<textarea[^>]*autofocus=""/);
    assert.equal(html.match(/autofocus=""/g)?.length, 1);
  });

  test("offers each example, and says what happens next", () => {
    for (const example of ROUTINE_EXAMPLES) assert.ok(html.includes(example.label), example.label);
    assert.match(html, /Nothing is sent yet: you review the request in Chat first\./);
    assert.match(html, /proposes the Routine as an Initiative/);
    assert.match(
      html,
      /href="\/c\/[^"]+\/decisions\/initiatives"[^>]*>Decision stack → Initiatives</,
    );
    assert.match(html, /until an owner or admin accepts it/);
  });

  test("offers only the employees whose Chat is ready", () => {
    assert.deepEqual(optionsOf(html, "AI Employee"), ["", "alex", "sam"]);
  });

  test("leaves the choice to the person while two can answer", () => {
    assert.doesNotMatch(html, /value="(Alex Rivera|Sam Okafor)[^"]*"/);
  });

  test("keeps the presets beside it, and still opens the box", () => {
    assertBox(
      render(owner, [ALEX, SAM], "/c/acme/routines/new?folder=ops&describe=1&employee=sam", [
        OPERATIONS,
      ]),
      "presets and ?describe=1",
    );
  });
});

describe("the employee asked to begin with, in the box", () => {
  test("is the one the list was narrowed to, when they can answer", () => {
    const html = render(owner, [ALEX, SAM, NOVA], "/c/acme/routines/new?describe=1&employee=sam");
    assert.match(html, /value="Sam Okafor — Engineer"/);
    assert.match(html, /Sam Okafor then proposes the Routine/);
  });

  test("is the only employee who can answer, whoever the list was narrowed to", () => {
    const html = render(owner, [ALEX, NOVA], "/c/acme/routines/new?employee=nova&describe=1");
    assert.match(html, /value="Alex Rivera — Account manager"/);
    assert.deepEqual(optionsOf(html, "AI Employee"), ["", "alex"]);
  });
});

describe("when nobody can answer a Chat", () => {
  const roster = [NOVA, { ...ALEX, chatReady: false }];
  const note =
    /Describing a Routine needs an AI Employee with a connected AI Model, and none has one yet\./;

  test("the form opens with a note where Describe it instead would be", () => {
    const html = render(owner, roster);
    assertForm(html, "nobody able to answer");
    assert.match(html, note);
    assert.ok(!html.includes("Describe it instead"));
    assert.ok(
      html.search(note) > html.indexOf("Create routine"),
      "the note sits under the form, not above it",
    );
    assert.match(
      html,
      /<p class="[^"]*">Describing a Routine needs/,
      "a quiet line of text, not a banner",
    );
  });

  test("the note links to the AI Model settings of the first employee", () => {
    const html = render(owner, roster);
    assert.match(
      html,
      /href="\/c\/acme\/employees\/nova\/settings\/model"[^>]*>Connect an AI Model</,
    );
  });

  test("the note links to the employee the list was narrowed to", () => {
    const html = render(owner, roster, "/c/acme/routines/new?employee=alex");
    assert.match(
      html,
      /href="\/c\/acme\/employees\/alex\/settings\/model"[^>]*>Connect an AI Model</,
    );
  });

  test("an address asking for the box still gets the form", () => {
    for (const at of [
      "/c/acme/routines/new?describe=1",
      "/c/acme/routines/new?employee=alex&describe=1",
    ]) {
      const html = render(owner, roster, at);
      assertForm(html, at);
      assert.match(html, note);
    }
  });

  test("the form still lists everyone to assign it to", () => {
    assert.deepEqual(optionsOf(render(owner, roster), "Assigned to"), ["nova", "alex"]);
  });
});

describe("when New routine cannot be used as it opens", () => {
  test("no AI Employees at all points to hiring one", () => {
    for (const at of ["/c/acme/routines/new", "/c/acme/routines/new?describe=1"]) {
      const html = render(owner, [], at);
      assert.match(html, /No AI employees yet/);
      assert.match(html, />New AI employee</);
      assert.ok(!html.includes("Continue to Chat"), at);
      assert.ok(!html.includes("Create routine"), at);
    }
  });

  test("a Member gets a note in place of the page", () => {
    for (const at of ["/c/acme/routines/new", "/c/acme/routines/new?describe=1"]) {
      const html = render(member, [ALEX, SAM], at);
      assert.match(html, /Only owners and admins create Routines/);
      assert.ok(!html.includes("<textarea"), "no box for a request that could only be refused");
      assert.ok(!html.includes("<form"), "no form whose create could only be refused");
      assert.ok(!html.includes("Describe it instead"));
      assert.ok(!html.includes("Back to the form"));
    }
  });
});
