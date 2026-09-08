import assert from "node:assert/strict";
import { describe, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom";

import type {
  RepositoryAiActivity,
  RepositoryAiEmployeeWork,
  RepositoryAiOverview,
  RepositoryGrant,
  RepositoryWorkSession,
} from "../../lib/api.js";
import type { RepositoryAiGlance } from "./aiOverview.js";
import { AiEmployeeRow, AiSessionRow, AiWorkOverview } from "./AiWorkOverview.js";

/**
 * The Repository Overview's AI section, rendered.
 *
 * The App has no browser-like DOM, so these render to a static markup string —
 * which is enough for the contracts that actually decide whether the page is
 * worth looking at. A running session has to say what the employee is doing
 * this second, not print "Working" beside a spinner; every listed session has
 * to be a link to the place it can be acted on; a band with nothing in it must
 * not be drawn; and a read that has not landed yet must never be reported as a
 * quiet repository. The wording itself is pinned next door in
 * `aiOverview.test.ts` — what is pinned here is which wording the components
 * choose, and what they leave out.
 */

const AT = "2024-05-01T12:00:00.000Z";
const COMPANY = "company-1";
const AI_BASE = "/companies/company-1/repositories/api/ai";
const ACCESS_HREF = "/companies/company-1/repositories/api/access";

function session(overrides: Partial<RepositoryWorkSession> = {}): RepositoryWorkSession {
  return {
    id: "sess-1",
    companyId: COMPANY,
    repositoryId: "repo-1",
    employeeId: "emp-1",
    modelId: null,
    effort: null,
    requestedByUserId: null,
    title: "Add a health check endpoint",
    instruction: "Add a health check endpoint",
    status: "ready",
    branch: "genosyn/sess-1",
    baseCommit: null,
    headCommit: null,
    reply: "",
    error: "",
    turnCount: 1,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    publishedBranch: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    finishedAt: null,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    employee: { id: "emp-1", name: "Rey", slug: "rey", avatarKey: null },
    ...overrides,
  };
}

function activity(overrides: Partial<RepositoryAiActivity> = {}): RepositoryAiActivity {
  return {
    sessionId: "sess-1",
    summary: "Ran npm test → Exit 1",
    at: AT,
    steps: { done: 2, total: 7, current: "Fix the failing test" },
    toolCalls: 24,
    ...overrides,
  };
}

function work(overrides: Partial<RepositoryAiEmployeeWork> = {}): RepositoryAiEmployeeWork {
  return {
    employeeId: "emp-1",
    sessions: 8,
    landed: 5,
    filesChanged: 12,
    insertions: 900,
    deletions: 120,
    lastActiveAt: AT,
    ...overrides,
  };
}

function overview(overrides: Partial<RepositoryAiOverview> = {}): RepositoryAiOverview {
  return {
    counts: { total: 1, running: 0, attention: 1, completed: 0, archived: 0 },
    landed: { sessions: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    totals: { turns: 1, discarded: 0 },
    lastActiveAt: AT,
    employees: [],
    capped: false,
    sessions: [session()],
    activity: [],
    ...overrides,
  };
}

function glance(overrides: Partial<RepositoryAiGlance> = {}): RepositoryAiGlance {
  return {
    counts: { total: 1, running: 0, attention: 1, completed: 0, archived: 0 },
    landed: { sessions: 0, filesChanged: 0, insertions: 0, deletions: 0 },
    granted: 1,
    workingNames: [],
    ...overrides,
  };
}

function grant(overrides: Partial<RepositoryGrant> = {}): RepositoryGrant {
  return {
    id: "grant-1",
    employeeId: "emp-1",
    repositoryId: "repo-1",
    accessLevel: "write",
    createdAt: AT,
    employee: {
      id: "emp-1",
      name: "Rey",
      slug: "rey",
      role: "Backend engineer",
      avatarKey: null,
      pullRequestReady: false,
    },
    ...overrides,
  };
}

/** Every component here renders a react-router `Link` somewhere below it. */
function render(element: React.ReactElement): string {
  return renderToStaticMarkup(React.createElement(StaticRouter, null, element));
}

function renderRow(props: Partial<React.ComponentProps<typeof AiSessionRow>> = {}): string {
  return render(
    React.createElement(AiSessionRow, {
      companyId: COMPANY,
      session: session(),
      activity: null,
      href: `${AI_BASE}/sess-1`,
      ...props,
    }),
  );
}

function renderOverview(props: Partial<React.ComponentProps<typeof AiWorkOverview>> = {}): string {
  return render(
    React.createElement(AiWorkOverview, {
      companyId: COMPANY,
      overview: overview(),
      error: null,
      glance: glance(),
      grants: null,
      aiBase: AI_BASE,
      accessHref: ACCESS_HREF,
      onRetry: async () => undefined,
      ...props,
    }),
  );
}

describe("a session row", () => {
  test("tells a reader what a running employee is doing right now", () => {
    const html = renderRow({
      session: session({ status: "running" }),
      activity: activity(),
    });
    assert.match(html, /Ran npm test → Exit 1/);
    assert.match(html, /Step 3 of 7/);
    assert.match(html, /24 tool calls/);
    // The row must not fall back to the status phrase — "Working now" is what
    // a spinner already said.
    assert.doesNotMatch(html, /Working now/);
  });

  test("says a turn is starting rather than nothing when no event has landed", () => {
    const html = renderRow({ session: session({ status: "running" }), activity: null });
    assert.match(html, /Starting…/);
    assert.doesNotMatch(html, /Step \d+ of \d+/);
    assert.doesNotMatch(html, /tool call/);
  });

  test("asks a finished session's reader for a decision, not for progress", () => {
    const html = renderRow({ session: session({ status: "ready" }), activity: activity() });
    assert.match(html, /Read the diff and decide/);
    // Step and tool-call counts belong to a turn in flight. A session that
    // ended an hour ago is not on step 3 of anything.
    assert.doesNotMatch(html, /Step 3 of 7/);
    assert.doesNotMatch(html, /tool call/);
  });

  test("is an anchor to the session's own page under the AI work base", () => {
    const html = renderRow({
      session: session({ id: "sess-9" }),
      href: `${AI_BASE}/sess-9`,
    });
    assert.match(html, /^<li><a /);
    assert.match(html, /href="\/companies\/company-1\/repositories\/api\/ai\/sess-9"/);
  });

  test("still renders a session whose employee was removed", () => {
    const html = renderRow({ session: session({ employee: null }) });
    assert.match(html, /<span class="truncate">Removed employee<\/span>/);
    assert.match(html, /Add a health check endpoint/);
  });

  test("prints a diffstat only when the session changed something", () => {
    assert.doesNotMatch(renderRow(), /files? · \+/);
    const changed = renderRow({
      session: session({ filesChanged: 4, insertions: 120, deletions: 8 }),
    });
    assert.match(changed, /4 files · \+120 · −8/);
  });
});

describe("the AI work bands", () => {
  test("does not draw a band with nothing in it", () => {
    const html = renderOverview({
      overview: overview({
        counts: { total: 2, running: 0, attention: 1, completed: 1, archived: 0 },
        sessions: [session(), session({ id: "sess-2", status: "published" })],
      }),
      glance: glance({ counts: { total: 2, running: 0, attention: 1, completed: 1, archived: 0 } }),
    });
    assert.match(html, /<h3[^>]*>Needs you<\/h3>/);
    assert.match(html, /<h3[^>]*>Recently decided<\/h3>/);
    assert.doesNotMatch(html, /<h3[^>]*>Working now<\/h3>/);
  });

  test("heads a band it does draw with its name and its count", () => {
    const html = renderOverview({
      overview: overview({
        counts: { total: 2, running: 0, attention: 2, completed: 0, archived: 0 },
        sessions: [session(), session({ id: "sess-2" })],
      }),
      glance: glance({ counts: { total: 2, running: 0, attention: 2, completed: 0, archived: 0 } }),
    });
    assert.match(html, /<h3[^>]*>Needs you<\/h3><span[^>]*>2<\/span>/);
  });
});

describe("the stat strip", () => {
  test("is absent on a repository that has never had a session", () => {
    const html = renderOverview({
      overview: overview({
        counts: { total: 0, running: 0, attention: 0, completed: 0, archived: 0 },
        sessions: [],
      }),
      glance: glance({ counts: { total: 0, running: 0, attention: 0, completed: 0, archived: 0 } }),
    });
    assert.doesNotMatch(html, /Lines accepted/);
    assert.doesNotMatch(html, /Waiting for you<\/div>/);
  });

  test("is present as soon as one session exists", () => {
    const html = renderOverview();
    assert.match(html, /Lines accepted/);
    assert.match(html, /None of 1 session has been accepted\./);
  });
});

describe("the AI work section as a whole", () => {
  test("says it is still reading rather than reporting a quiet repository", () => {
    const html = renderOverview({
      overview: null,
      error: null,
      glance: glance({
        counts: { total: 5, running: 0, attention: 0, completed: 5, archived: 0 },
        landed: { sessions: 2, filesChanged: 9, insertions: 400, deletions: 30 },
      }),
    });
    assert.match(html, /Reading back the AI work…/);
    assert.doesNotMatch(html, /Nothing is running/);
    // No bands, no strip, no "0 sessions" — nothing that would read as an answer.
    assert.doesNotMatch(html, /<h3[^>]*>Recently decided<\/h3>/);
    assert.doesNotMatch(html, /Lines accepted/);
  });

  test("puts a failed read on the page with a retry and leaves the page usable", () => {
    const html = renderOverview({
      overview: null,
      error: "Could not read the AI work.",
      glance: glance(),
    });
    assert.match(html, /role="alert"/);
    assert.match(html, /Could not read the AI work\./);
    assert.match(html, /Retry/);
    // A failure is not a loading state, and it does not take the way out with it.
    assert.doesNotMatch(html, /Reading back the AI work/);
    assert.match(html, /Start a work session/);
    assert.match(html, /href="\/companies\/company-1\/repositories\/api\/ai"/);
  });

  test("never states the repository's state from a read that failed", () => {
    // The old guard only covered loading, so a 500 printed "No AI employee can
    // work in this repository yet." immediately above the alert saying the work
    // could not be read.
    const closed = renderOverview({
      overview: null,
      error: "Could not read the AI work.",
      glance: glance(),
    });
    assert.match(closed, /The AI work here could not be read\./);
    assert.doesNotMatch(closed, /No AI employee can work in this repository yet/);

    const granted = renderOverview({
      overview: null,
      error: "Could not read the AI work.",
      glance: glance({ granted: 1 }),
      grants: [grant()],
    });
    assert.doesNotMatch(granted, /can work here\. None has yet/);
  });

  test("says nothing about an employee's tally before the digest has landed", () => {
    // The grants read and the work read are independent, and grants usually win
    // the race — so "No work here yet" under a busy employee would be a lie the
    // page tells for as long as the other request takes.
    const pending = renderOverview({ overview: null, error: null, grants: [grant()] });
    assert.match(pending, /Rey/);
    assert.doesNotMatch(pending, /No work here yet/);

    const failed = renderOverview({
      overview: null,
      error: "Could not read the AI work.",
      grants: [grant()],
    });
    assert.doesNotMatch(failed, /No work here yet/);
  });

  test("links onward only when the digest listed fewer sessions than it counted", () => {
    const listed = [session(), session({ id: "sess-2" }), session({ id: "sess-3" })];
    const counted = { total: 12, running: 0, attention: 3, completed: 7, archived: 2 };
    assert.match(
      renderOverview({
        overview: overview({ counts: counted, sessions: listed }),
        glance: glance({ counts: counted }),
      }),
      /7 more in AI work/,
    );
    const all = { total: 5, running: 0, attention: 3, completed: 0, archived: 2 };
    assert.doesNotMatch(
      renderOverview({
        overview: overview({ counts: all, sessions: listed }),
        glance: glance({ counts: all }),
      }),
      /more in AI work/,
    );
  });
});

describe("who works here", () => {
  test("says nothing at all until the grants read lands", () => {
    const html = renderOverview({ grants: null });
    assert.doesNotMatch(html, /Who works here/);
    assert.doesNotMatch(html, /No AI employee has access yet/);
  });

  test("asks for a grant once it knows there is none", () => {
    const html = renderOverview({ grants: [] });
    assert.match(html, /No AI employee has access yet/);
    assert.match(html, /href="\/companies\/company-1\/repositories\/api\/access"/);
    assert.doesNotMatch(html, /Who works here/);
  });

  test("lists one row per grant, each with what that employee has actually done", () => {
    const html = renderOverview({
      overview: overview({ employees: [work()] }),
      grants: [
        grant(),
        grant({
          id: "grant-2",
          employeeId: "emp-2",
          employee: {
            id: "emp-2",
            name: "Kaya",
            slug: "kaya",
            role: "Reviewer",
            avatarKey: null,
            pullRequestReady: false,
          },
        }),
      ],
    });
    assert.match(html, /Who works here/);
    assert.match(html, /8 sessions · 5 accepted · \+900 \/ −120/);
    // The grant says an employee may work here; the tally says whether it has.
    assert.match(html, /No work here yet/);
    assert.match(html, /Manage AI access/);
  });
});

describe("an employee row", () => {
  function renderEmployee(props: Partial<React.ComponentProps<typeof AiEmployeeRow>> = {}): string {
    return renderToStaticMarkup(
      React.createElement(AiEmployeeRow, {
        companyId: COMPANY,
        grant: grant(),
        work: null,
        workKnown: true,
        ...props,
      }),
    );
  }

  test("claims a pull request only for an employee that can open one", () => {
    assert.doesNotMatch(renderEmployee(), /Can open pull requests/);
    const ready = renderEmployee({
      grant: grant({
        employee: {
          id: "emp-1",
          name: "Rey",
          slug: "rey",
          role: "Backend engineer",
          avatarKey: null,
          pullRequestReady: true,
        },
      }),
    });
    assert.match(ready, /Can open pull requests/);
  });

  test("states the access level as what it lets the employee do", () => {
    assert.match(renderEmployee({ grant: grant({ accessLevel: "write" }) }), /Can prepare work/);
    const read = renderEmployee({ grant: grant({ accessLevel: "read" }) });
    assert.match(read, /Read only/);
    assert.doesNotMatch(read, /Can prepare work/);
  });

  test("names an employee that was removed instead of dropping the row", () => {
    const html = renderEmployee({ grant: grant({ employee: null }) });
    assert.match(html, /Removed employee/);
    assert.doesNotMatch(html, /Can open pull requests/);
  });
});
