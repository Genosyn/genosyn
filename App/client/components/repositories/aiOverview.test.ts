import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  RepositoryAiActivity,
  RepositoryAiCounts,
  RepositoryAiEmployeeWork,
  RepositoryAiLanded,
  RepositoryWorkSession,
  RepositoryWorkSessionStatus,
} from "../../lib/api";
import { SESSION_STATUS_LABEL } from "./sessionState";
import {
  AI_OVERVIEW_GROUP_LABEL,
  AI_OVERVIEW_GROUP_ORDER,
  activityBySession,
  activityLine,
  aiOverviewGroupOf,
  cappedNote,
  diffstatLabel,
  employeeWorkById,
  employeeWorkLabel,
  groupAiOverviewSessions,
  landedSentence,
  overviewSessionHref,
  repositoryAiGlanceOf,
  repositoryAiHeadline,
  repositoryAiHeading,
  repositoryAiState,
  repositoryAiStats,
  repositoryAiSubline,
  sessionNextStep,
  stepsLabel,
  toolCallsLabel,
  workingEmployeeNames,
  workingSubject,
  type AiOverviewGroup,
  type RepositoryAiGlance,
  type RepositoryAiState,
} from "./aiOverview";

/**
 * What the Repository Overview says about AI work.
 *
 * This module is the page's whole subject — the headline a Member reads first,
 * the four tiles under it, and the one line per session saying what to do
 * next. Client tests here have no DOM, so these sentences are only reachable
 * as functions, and they are the part a reader actually depends on: a headline
 * that says "0 sessions" where it should say "no employee may work here" sends
 * somebody to the wrong screen.
 *
 * The tables keyed by `RepositoryWorkSessionStatus` are the point of the file:
 * adding a status without giving it a band and a next step fails to compile
 * here rather than shipping a session that lands in no list.
 */

/** Every status, and the band it belongs in. Exhaustive by type. */
const GROUP_BY_STATUS: Record<RepositoryWorkSessionStatus, AiOverviewGroup> = {
  running: "running",
  ready: "attention",
  empty: "attention",
  proposed: "attention",
  published: "recent",
  discarded: "recent",
  failed: "attention",
};

const ALL_STATUSES = Object.keys(GROUP_BY_STATUS) as RepositoryWorkSessionStatus[];

function session(overrides: Partial<RepositoryWorkSession> = {}): RepositoryWorkSession {
  return {
    id: "s1",
    companyId: "c1",
    repositoryId: "r1",
    employeeId: "e1",
    modelId: null,
    requestedByUserId: "u1",
    title: "Add a health check",
    instruction: "Add a health check endpoint and commit it",
    status: "ready",
    branch: "genosyn/ada/abcdef12",
    baseCommit: "aaa",
    headCommit: "bbb",
    reply: "Done.",
    error: "",
    turnCount: 1,
    filesChanged: 1,
    insertions: 3,
    deletions: 0,
    publishedBranch: null,
    pullRequestUrl: null,
    pullRequestNumber: null,
    finishedAt: "2026-08-19T10:00:00.000Z",
    archivedAt: null,
    createdAt: "2026-08-19T09:00:00.000Z",
    updatedAt: "2026-08-19T10:00:00.000Z",
    employee: { id: "e1", name: "Ada", slug: "ada", avatarKey: null },
    ...overrides,
  };
}

function counts(overrides: Partial<RepositoryAiCounts> = {}): RepositoryAiCounts {
  return { total: 0, running: 0, attention: 0, completed: 0, archived: 0, ...overrides };
}

function landed(overrides: Partial<RepositoryAiLanded> = {}): RepositoryAiLanded {
  return { sessions: 0, filesChanged: 0, insertions: 0, deletions: 0, ...overrides };
}

function glanceOf(overrides: Partial<RepositoryAiGlance> = {}): RepositoryAiGlance {
  return { counts: counts(), landed: landed(), granted: 0, workingNames: [], ...overrides };
}

/** One glance per state, so every wording test can name the state it means. */
const GLANCE = {
  working: glanceOf({
    counts: counts({ total: 6, running: 1, completed: 5 }),
    granted: 2,
    workingNames: ["Ada"],
  }),
  waiting: glanceOf({ counts: counts({ total: 4, attention: 2, completed: 2 }), granted: 2 }),
  quiet: glanceOf({
    counts: counts({ total: 3, completed: 3 }),
    landed: landed({ sessions: 2 }),
    granted: 2,
  }),
  idle: glanceOf({ granted: 2 }),
  closed: glanceOf(),
} satisfies Record<RepositoryAiState, RepositoryAiGlance>;

const STATES = Object.keys(GLANCE) as Array<keyof typeof GLANCE>;

function employeeWork(overrides: Partial<RepositoryAiEmployeeWork> = {}): RepositoryAiEmployeeWork {
  return {
    employeeId: "e1",
    sessions: 8,
    landed: 5,
    filesChanged: 12,
    insertions: 900,
    deletions: 120,
    lastActiveAt: "2026-08-19T10:00:00.000Z",
    ...overrides,
  };
}

function activityOf(overrides: Partial<RepositoryAiActivity> = {}): RepositoryAiActivity {
  return {
    sessionId: "s1",
    summary: "Ran npm test",
    at: "2026-08-19T10:00:00.000Z",
    steps: null,
    toolCalls: 0,
    ...overrides,
  };
}

describe("the three bands", () => {
  test("every status has exactly one band", () => {
    // A new status with no case here would fall into "Needs you" silently;
    // the table makes that a decision somebody had to write down.
    for (const status of ALL_STATUSES) {
      assert.equal(aiOverviewGroupOf(status), GROUP_BY_STATUS[status], status);
    }
  });

  test("only a turn in flight is live work, and only the two decided outcomes are history", () => {
    assert.deepEqual(
      ALL_STATUSES.filter((status) => aiOverviewGroupOf(status) === "running"),
      ["running"],
    );
    assert.deepEqual(
      ALL_STATUSES.filter((status) => aiOverviewGroupOf(status) === "recent"),
      ["published", "discarded"],
    );
    assert.deepEqual(
      ALL_STATUSES.filter((status) => aiOverviewGroupOf(status) === "attention"),
      ["ready", "empty", "proposed", "failed"],
    );
  });

  test("the bands are listed live work first, and each one is named", () => {
    assert.deepEqual(AI_OVERVIEW_GROUP_ORDER, ["running", "attention", "recent"]);
    assert.deepEqual(AI_OVERVIEW_GROUP_LABEL, {
      running: "Working now",
      attention: "Needs you",
      recent: "Recently decided",
    });
  });

  test("splits the server's list without reordering or mutating it", () => {
    const rows = [
      session({ id: "published", status: "published" }),
      session({ id: "ready", status: "ready" }),
      session({ id: "running-a", status: "running" }),
      session({ id: "failed", status: "failed" }),
      session({ id: "running-b", status: "running" }),
      session({ id: "discarded", status: "discarded" }),
    ];

    const bands = groupAiOverviewSessions(rows);

    assert.deepEqual(
      bands.running.map((row) => row.id),
      ["running-a", "running-b"],
    );
    assert.deepEqual(
      bands.attention.map((row) => row.id),
      ["ready", "failed"],
    );
    assert.deepEqual(
      bands.recent.map((row) => row.id),
      ["published", "discarded"],
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      ["published", "ready", "running-a", "failed", "running-b", "discarded"],
    );
  });

  test("every band exists for an empty list, so a caller need not check", () => {
    assert.deepEqual(groupAiOverviewSessions([]), { running: [], attention: [], recent: [] });
    for (const band of AI_OVERVIEW_GROUP_ORDER) {
      assert.deepEqual(groupAiOverviewSessions([])[band], []);
    }
  });
});

describe("the state of a repository's AI work", () => {
  test("names each of the five states", () => {
    for (const state of STATES) {
      assert.equal(repositoryAiState(GLANCE[state]), state, state);
    }
  });

  test("working outranks waiting, so an unreviewed session cannot hide live work", () => {
    assert.equal(
      repositoryAiState(
        glanceOf({ counts: counts({ total: 9, running: 1, attention: 4 }), granted: 2 }),
      ),
      "working",
    );
  });

  test("waiting outranks quiet, so a queue is never reported as nothing happening", () => {
    assert.equal(
      repositoryAiState(
        glanceOf({ counts: counts({ total: 9, attention: 1, completed: 8 }), granted: 2 }),
      ),
      "waiting",
    );
  });

  test("archived work still counts as work having happened here", () => {
    assert.equal(
      repositoryAiState(glanceOf({ counts: counts({ total: 3, archived: 3 }), granted: 1 })),
      "quiet",
    );
  });

  test("a repository nobody may work in is closed, not idle", () => {
    assert.equal(repositoryAiState(glanceOf({ granted: 0 })), "closed");
    assert.equal(repositoryAiState(glanceOf({ granted: 1 })), "idle");
  });
});

describe("who is working, named", () => {
  test("names nobody when the list is empty or holds only blanks", () => {
    assert.equal(workingSubject([]), "");
    assert.equal(workingSubject([""]), "");
    assert.equal(workingSubject(["   ", "\t"]), "");
  });

  test("drops blank names before counting, so a blank never becomes an 'other'", () => {
    assert.equal(workingSubject(["Ada", "  "]), "Ada");
    assert.equal(workingSubject(["  ", "Ada", "Kaz"]), "Ada and Kaz");
  });

  test("names one, names two, and counts the rest", () => {
    assert.equal(workingSubject(["Ada"]), "Ada");
    assert.equal(workingSubject(["Ada", "Kaz"]), "Ada and Kaz");
    assert.equal(workingSubject(["Ada", "Kaz", "Rey"]), "Ada, Kaz and 1 other");
    assert.equal(workingSubject(["Ada", "Kaz", "Rey", "Bo", "Zoe"]), "Ada, Kaz and 3 others");
  });
});

describe("the headline", () => {
  test("names the one employee working", () => {
    assert.equal(repositoryAiHeadline(GLANCE.working), "Ada is working here now.");
  });

  test("names two, and counts three or more", () => {
    const two = glanceOf({
      counts: counts({ total: 2, running: 2 }),
      workingNames: ["Ada", "Kaz"],
    });
    assert.equal(repositoryAiHeadline(two), "Ada and Kaz are working here now.");
    const four = glanceOf({
      counts: counts({ total: 4, running: 4 }),
      workingNames: ["Ada", "Kaz", "Rey", "Bo"],
    });
    assert.equal(repositoryAiHeadline(four), "Ada, Kaz and 2 others are working here now.");
  });

  test("conjugates for the names it printed, not for the ones it dropped", () => {
    // A blank name is dropped from the subject, so it must be dropped from the
    // verb too — counting the raw list produced "Ada are working here now."
    assert.equal(
      repositoryAiHeadline(
        glanceOf({ counts: counts({ total: 2, running: 2 }), workingNames: ["Ada", "  "] }),
      ),
      "Ada is working here now.",
    );
    assert.equal(
      repositoryAiHeadline(
        glanceOf({ counts: counts({ total: 3, running: 3 }), workingNames: [" Ada ", "Kaz", ""] }),
      ),
      "Ada and Kaz are working here now.",
    );
  });

  test("a running session whose employee was fired still gets a sentence", () => {
    // Nobody to name is not nothing to say: the turn is still burning tokens.
    assert.equal(
      repositoryAiHeadline(glanceOf({ counts: counts({ total: 1, running: 1 }) })),
      "1 session is running here now.",
    );
    assert.equal(
      repositoryAiHeadline(glanceOf({ counts: counts({ total: 3, running: 3 }) })),
      "3 sessions are running here now.",
    );
  });

  test("adds what is waiting behind the live work, singular and plural", () => {
    const one = glanceOf({
      counts: counts({ total: 4, running: 1, attention: 1 }),
      workingNames: ["Ada"],
    });
    assert.equal(
      repositoryAiHeadline(one),
      "Ada is working here now. 1 other session is waiting for you.",
    );
    const many = glanceOf({
      counts: counts({ total: 9, running: 2, attention: 3 }),
      workingNames: ["Ada", "Kaz"],
    });
    assert.equal(
      repositoryAiHeadline(many),
      "Ada and Kaz are working here now. 3 other sessions are waiting for you.",
    );
  });

  test("says nothing about a queue that is empty", () => {
    assert.doesNotMatch(repositoryAiHeadline(GLANCE.working), /waiting/);
  });

  test("counts what is waiting when nothing is running", () => {
    assert.equal(
      repositoryAiHeadline(glanceOf({ counts: counts({ total: 1, attention: 1 }) })),
      "1 session is waiting for you to decide.",
    );
    assert.equal(repositoryAiHeadline(GLANCE.waiting), "2 sessions are waiting for you to decide.");
  });

  test("a quiet repository reports what landed, or admits nothing has", () => {
    assert.equal(
      repositoryAiHeadline(GLANCE.quiet),
      "Nothing is running. AI employees have landed 2 sessions here.",
    );
    assert.equal(
      repositoryAiHeadline(
        glanceOf({ counts: counts({ total: 3, completed: 3 }), landed: landed({ sessions: 1 }) }),
      ),
      "Nothing is running. AI employees have landed 1 session here.",
    );
    assert.equal(
      repositoryAiHeadline(glanceOf({ counts: counts({ total: 3, completed: 3 }), granted: 2 })),
      "Nothing is running, and no AI work has been accepted here yet.",
    );
  });

  test("an idle repository says how many employees could be working", () => {
    assert.equal(
      repositoryAiHeadline(glanceOf({ granted: 1 })),
      "1 AI employee can work here. None has yet.",
    );
    assert.equal(repositoryAiHeadline(GLANCE.idle), "2 AI employees can work here. None has yet.");
  });

  test("a repository nobody was granted says so rather than showing a zero", () => {
    // "0 sessions" and "no employee may work here" are different problems with
    // different fixes, and only one of them is fixed on the access screen.
    assert.equal(
      repositoryAiHeadline(GLANCE.closed),
      "No AI employee can work in this repository yet.",
    );
    assert.doesNotMatch(repositoryAiHeadline(GLANCE.closed), /\d/);
  });

  test("separates thousands in every number it prints", () => {
    assert.match(
      repositoryAiHeadline(
        glanceOf({
          counts: counts({ total: 4000, completed: 4000 }),
          landed: landed({ sessions: 1200 }),
        }),
      ),
      /landed 1,200 sessions/,
    );
  });

  test("every state produces one sentence", () => {
    for (const state of STATES) {
      const headline = repositoryAiHeadline(GLANCE[state]);
      assert.ok(headline.length > 0, state);
      assert.match(headline, /\.$/, state);
    }
  });
});

describe("the line under the headline", () => {
  test("every state is told what to do about it", () => {
    for (const state of STATES) {
      const subline = repositoryAiSubline(GLANCE[state]);
      assert.ok(subline.length > 0, state);
      assert.match(subline, /\.$/, state);
    }
  });

  test("no two states share an instruction", () => {
    // A page whose subline is the same whatever is happening has stopped
    // telling anybody anything.
    const lines = STATES.map((state) => repositoryAiSubline(GLANCE[state]));
    assert.equal(new Set(lines).size, lines.length);
  });

  test("the two empty states point at the two different fixes", () => {
    assert.match(repositoryAiSubline(GLANCE.idle), /Describe an outcome/);
    assert.match(repositoryAiSubline(GLANCE.closed), /Grant an AI employee access/);
  });
});

describe("the four tiles", () => {
  const keys = ["running", "attention", "accepted", "changed"];

  test("the same four tiles in the same order, whatever the repository is doing", () => {
    // A strip that reflows as work starts and stops is unreadable.
    for (const state of STATES) {
      assert.deepEqual(
        repositoryAiStats(GLANCE[state]).map((tile) => tile.key),
        keys,
        state,
      );
    }
  });

  test("every tile is labelled", () => {
    assert.deepEqual(
      repositoryAiStats(GLANCE.working).map((tile) => tile.label),
      ["Working now", "Waiting for you", "Accepted", "Lines accepted"],
    );
  });

  test("a zero says a word rather than a nought", () => {
    const stats = repositoryAiStats(GLANCE.closed);
    assert.equal(stats[0].value, "None");
    assert.equal(stats[1].value, "None");
    assert.equal(stats[3].value, "None yet");
    // The accepted tile is the deliberate exception: its hint counts the total
    // it is a share of, so the number has to stay a number.
    assert.equal(stats[2].value, "0 sessions");
  });

  test("counts sessions, singular and plural, once there are any", () => {
    const one = repositoryAiStats(
      glanceOf({
        counts: counts({ total: 2, running: 1, attention: 1 }),
        landed: landed({ sessions: 1 }),
      }),
    );
    assert.equal(one[0].value, "1 session");
    assert.equal(one[1].value, "1 session");
    assert.equal(one[2].value, "1 session");

    const many = repositoryAiStats(
      glanceOf({
        counts: counts({ total: 9, running: 2, attention: 3 }),
        landed: landed({ sessions: 4 }),
      }),
    );
    assert.equal(many[0].value, "2 sessions");
    assert.equal(many[1].value, "3 sessions");
    assert.equal(many[2].value, "4 sessions");
  });

  test("lines accepted are separated at the thousand and signed with a real minus", () => {
    const stats = repositoryAiStats(
      glanceOf({
        counts: counts({ total: 4 }),
        landed: landed({ sessions: 4, insertions: 12345, deletions: 6789 }),
      }),
    );
    assert.equal(stats[3].value, "+12,345 / −6,789");
    // U+2212, not a hyphen: a hyphen next to a "+" reads as a dash.
    assert.ok(stats[3].value.includes("−"));
    assert.doesNotMatch(stats[3].value, /-/);
  });

  test("a landed session that only deleted still shows both sides", () => {
    const stats = repositoryAiStats(
      glanceOf({ counts: counts({ total: 1 }), landed: landed({ sessions: 1, deletions: 4 }) }),
    );
    assert.equal(stats[3].value, "+0 / −4");
  });

  test("the hints appear only when they say something", () => {
    const busy = repositoryAiStats(
      glanceOf({
        counts: counts({ total: 12, running: 2, attention: 1 }),
        landed: landed({ sessions: 5, filesChanged: 9 }),
        workingNames: ["Ada", "Kaz"],
      }),
    );
    assert.equal(busy[0].hint, "Ada and Kaz");
    assert.equal(busy[1].hint, "Review, revise, or discard");
    assert.equal(busy[2].hint, "of 12 in total");
    assert.equal(busy[3].hint, "across 9 files");

    const empty = repositoryAiStats(GLANCE.closed);
    assert.deepEqual(
      empty.map((tile) => tile.hint),
      [null, null, null, null],
    );
  });

  test("a running session with nobody left to name carries no hint at all", () => {
    // "" would render as an empty second line and jog the tile out of line.
    const stats = repositoryAiStats(glanceOf({ counts: counts({ total: 1, running: 1 }) }));
    assert.equal(stats[0].hint, null);
  });

  test("the hints count in words a person reads, not raw numbers", () => {
    const stats = repositoryAiStats(
      glanceOf({
        counts: counts({ total: 2400 }),
        landed: landed({ sessions: 1, filesChanged: 1 }),
      }),
    );
    assert.equal(stats[2].hint, "of 2,400 in total");
    assert.equal(stats[3].hint, "across 1 file");
  });
});

describe("how much of it was accepted", () => {
  test("says nothing when there has never been a session", () => {
    assert.equal(landedSentence(counts(), landed()), "");
    assert.equal(landedSentence(counts(), landed({ sessions: 3 })), "");
  });

  test("says plainly when none of it was accepted", () => {
    assert.equal(
      landedSentence(counts({ total: 30 }), landed()),
      "None of 30 sessions has been accepted.",
    );
    assert.equal(
      landedSentence(counts({ total: 1 }), landed()),
      "None of 1 session has been accepted.",
    );
  });

  test("counts the share once some was", () => {
    assert.equal(
      landedSentence(counts({ total: 30 }), landed({ sessions: 12 })),
      "12 of 30 sessions accepted.",
    );
    assert.equal(
      landedSentence(counts({ total: 1 }), landed({ sessions: 1 })),
      "1 of 1 session accepted.",
    );
    assert.equal(
      landedSentence(counts({ total: 1200 }), landed({ sessions: 1000 })),
      "1,000 of 1,200 sessions accepted.",
    );
  });
});

describe("one session's diffstat", () => {
  test("a session that changed nothing gets no line rather than three zeroes", () => {
    assert.equal(diffstatLabel({ filesChanged: 0, insertions: 0, deletions: 0 }), "");
  });

  test("composes files, insertions and deletions with a real minus", () => {
    assert.equal(
      diffstatLabel({ filesChanged: 4, insertions: 120, deletions: 8 }),
      "4 files · +120 · −8",
    );
    assert.equal(
      diffstatLabel({ filesChanged: 1200, insertions: 4000, deletions: 30000 }),
      "1,200 files · +4,000 · −30,000",
    );
  });

  test("one file is one file", () => {
    assert.equal(
      diffstatLabel({ filesChanged: 1, insertions: 3, deletions: 0 }),
      "1 file · +3 · −0",
    );
  });

  test("a rename that moved lines but touched no file still gets a line", () => {
    // Only all three being zero means nothing happened.
    assert.equal(
      diffstatLabel({ filesChanged: 0, insertions: 0, deletions: 2 }),
      "0 files · +0 · −2",
    );
  });
});

describe("what a session wants from a person", () => {
  /** The next step for every status. Exhaustive by type. */
  const NEXT_STEP: Record<RepositoryWorkSessionStatus, string> = {
    running: "Working now",
    ready: "Read the diff and decide",
    empty: "Nothing changed — ask for another pass",
    proposed: "A pull request is open",
    published: "Merged into this repository",
    discarded: "Its branch was thrown away",
    failed: "The last turn failed — ask again",
  };

  function step(over: Partial<RepositoryWorkSession> & { status: RepositoryWorkSessionStatus }) {
    return sessionNextStep({ pullRequestNumber: null, publishedBranch: null, ...over });
  }

  test("every status is told what to do about it, and no two the same", () => {
    for (const status of ALL_STATUSES) {
      assert.equal(step({ status }), NEXT_STEP[status], status);
    }
    const steps = ALL_STATUSES.map((status) => NEXT_STEP[status]);
    assert.equal(new Set(steps).size, steps.length);
  });

  test("a proposed session names its pull request when the server knows the number", () => {
    assert.equal(step({ status: "proposed", pullRequestNumber: 42 }), "Pull request #42 is open");
    assert.equal(step({ status: "proposed" }), "A pull request is open");
  });

  test("a decided session says where the work went, never what its own chip says", () => {
    // The row already carries the status on a chip beside the title, so
    // "Accepted" under a chip reading "Accepted" was a second line that made
    // the row taller and told nobody anything.
    assert.equal(step({ status: "published", publishedBranch: "main" }), "Merged into main");
    for (const status of ["published", "discarded"] as const) {
      assert.notEqual(step({ status }), SESSION_STATUS_LABEL[status]);
    }
  });

  test("says what to do, not what the status is called", () => {
    assert.doesNotMatch(step({ status: "empty" }), /^Empty/);
    assert.doesNotMatch(step({ status: "failed" }), /^Failed/);
  });
});

describe("the live line on a running session", () => {
  test("a turn that has written no event yet is starting, not stuck", () => {
    assert.equal(activityLine(null), "Starting…");
    assert.equal(activityLine(undefined), "Starting…");
    assert.equal(activityLine(activityOf({ summary: "" })), "Starting…");
    assert.equal(activityLine(activityOf({ summary: "   \n\t " })), "Starting…");
  });

  test("a real summary passes through, trimmed", () => {
    assert.equal(
      activityLine(activityOf({ summary: "Ran npm test → Exit 1" })),
      "Ran npm test → Exit 1",
    );
    assert.equal(activityLine(activityOf({ summary: "  Read src/app.ts  " })), "Read src/app.ts");
  });

  test("counts the tool calls behind the line", () => {
    assert.equal(toolCallsLabel(null), "");
    assert.equal(toolCallsLabel(undefined), "");
    assert.equal(toolCallsLabel(activityOf({ toolCalls: 0 })), "");
    assert.equal(toolCallsLabel(activityOf({ toolCalls: 1 })), "1 tool call");
    assert.equal(toolCallsLabel(activityOf({ toolCalls: 24 })), "24 tool calls");
    assert.equal(toolCallsLabel(activityOf({ toolCalls: 2400 })), "2,400 tool calls");
  });
});

describe("how far a turn has got", () => {
  test("says nothing when the employee wrote no step list", () => {
    assert.equal(stepsLabel(null), "");
    assert.equal(stepsLabel(undefined), "");
    assert.equal(stepsLabel({ done: 0, total: 0, current: null }), "");
  });

  test("counts the step being worked on, not the ones behind it", () => {
    assert.equal(stepsLabel({ done: 0, total: 7, current: "Read the router" }), "Step 1 of 7");
    assert.equal(stepsLabel({ done: 2, total: 7, current: "Add the route" }), "Step 3 of 7");
  });

  test("never reads 'Step 8 of 7' once the list is finished", () => {
    assert.equal(stepsLabel({ done: 7, total: 7, current: null }), "Step 7 of 7");
    assert.equal(stepsLabel({ done: 9, total: 7, current: null }), "Step 7 of 7");
  });
});

describe("what one employee has done here", () => {
  test("an employee with no work says so rather than showing three zeroes", () => {
    assert.equal(employeeWorkLabel(null), "No work here yet");
    assert.equal(employeeWorkLabel(undefined), "No work here yet");
    assert.equal(employeeWorkLabel(employeeWork({ sessions: 0 })), "No work here yet");
  });

  test("names the sessions, the accepted share and the lines", () => {
    assert.equal(employeeWorkLabel(employeeWork()), "8 sessions · 5 accepted · +900 / −120");
    assert.equal(
      employeeWorkLabel(employeeWork({ sessions: 1, landed: 1, insertions: 4000, deletions: 0 })),
      "1 session · 1 accepted · +4,000 / −0",
    );
  });

  test("drops the diffstat when nothing of theirs was accepted", () => {
    assert.equal(
      employeeWorkLabel(employeeWork({ sessions: 3, landed: 0, insertions: 0, deletions: 0 })),
      "3 sessions · 0 accepted",
    );
  });

  test("a purely deleting employee still gets a diffstat", () => {
    assert.equal(
      employeeWorkLabel(employeeWork({ sessions: 2, landed: 1, insertions: 0, deletions: 40 })),
      "2 sessions · 1 accepted · +0 / −40",
    );
  });
});

describe("the lookups the rows join through", () => {
  test("indexes each employee's tally by its employee", () => {
    const map = employeeWorkById([
      employeeWork({ employeeId: "ada", sessions: 3 }),
      employeeWork({ employeeId: "kaz", sessions: 5 }),
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.get("ada")?.sessions, 3);
    assert.equal(map.get("kaz")?.sessions, 5);
    assert.equal(map.get("nobody"), undefined);
    assert.deepEqual(employeeWorkById([]).size, 0);
  });

  test("indexes each live line by its session", () => {
    const map = activityBySession([
      activityOf({ sessionId: "a", summary: "Reading" }),
      activityOf({ sessionId: "b", summary: "Editing" }),
    ]);
    assert.equal(map.size, 2);
    assert.equal(map.get("a")?.summary, "Reading");
    assert.equal(map.get("b")?.summary, "Editing");
    assert.equal(map.get("c"), undefined);
    assert.deepEqual(activityBySession([]).size, 0);
  });

  test("a repeated key keeps the last row the server sent", () => {
    // The server sends one row per key, so this only matters as a rule: the
    // later row wins, and neither lookup grows a second entry for it.
    const employees = employeeWorkById([
      employeeWork({ employeeId: "ada", sessions: 3 }),
      employeeWork({ employeeId: "ada", sessions: 9 }),
    ]);
    assert.equal(employees.size, 1);
    assert.equal(employees.get("ada")?.sessions, 9);

    const activity = activityBySession([
      activityOf({ sessionId: "a", summary: "Reading" }),
      activityOf({ sessionId: "a", summary: "Committing" }),
    ]);
    assert.equal(activity.size, 1);
    assert.equal(activity.get("a")?.summary, "Committing");
  });

  test("a session row points at its own page in the AI work inbox", () => {
    assert.equal(
      overviewSessionHref("/c/acme/repositories/product/ai", "s1"),
      "/c/acme/repositories/product/ai/s1",
    );
  });
});

describe("when the tallies stopped counting", () => {
  test("says nothing when nothing was capped", () => {
    assert.equal(cappedNote(false, counts({ total: 2000 })), "");
  });

  test("says so, with the number it counted over, rather than letting it pass", () => {
    assert.equal(
      cappedNote(true, counts({ total: 2000 })),
      "Counted over the most recent 2,000 sessions.",
    );
  });
});

describe("who is working, counted once each", () => {
  function running(id: string, employeeId: string | null, name = "Ada") {
    return session({
      id,
      status: "running",
      employee: employeeId
        ? { id: employeeId, name, slug: name.toLowerCase(), avatarKey: null }
        : null,
    });
  }

  test("names an employee once however many sessions it is running", () => {
    // Two sessions, one colleague. Counting sessions gave the headline two
    // people and the plural verb to go with them.
    assert.deepEqual(
      workingEmployeeNames([running("a", "e1"), running("b", "e1"), running("c", "e2", "Kaz")]),
      ["Ada", "Kaz"],
    );
  });

  test("keeps the order the server listed them in", () => {
    assert.deepEqual(workingEmployeeNames([running("a", "e2", "Kaz"), running("b", "e1", "Ada")]), [
      "Kaz",
      "Ada",
    ]);
  });

  test("ignores sessions that are not running and employees that are gone", () => {
    assert.deepEqual(
      workingEmployeeNames([
        session({ id: "ready", status: "ready" }),
        running("fired", null),
        running("live", "e1"),
      ]),
      ["Ada"],
    );
  });
});

describe("the glance the page reasons over", () => {
  test("a digest that has not arrived is all zeroes, and still knows the roster", () => {
    const glance = repositoryAiGlanceOf(null, 3);
    assert.deepEqual(glance.counts, {
      total: 0,
      running: 0,
      attention: 0,
      completed: 0,
      archived: 0,
    });
    assert.deepEqual(glance.landed, {
      sessions: 0,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
    assert.equal(glance.granted, 3);
    assert.deepEqual(glance.workingNames, []);
    // Zeroes are not a claim: the heading is what decides that, from the read
    // state, and it must not report an absent answer as a quiet repository.
    assert.equal(repositoryAiHeading("loading", glance).headline, "Reading back the AI work…");
    assert.equal(
      repositoryAiHeading("failed", glance).headline,
      "The AI work here could not be read.",
    );
  });

  test("carries the digest through and names the employees working", () => {
    const glance = repositoryAiGlanceOf(
      {
        counts: counts({ total: 4, running: 2, attention: 1, completed: 1 }),
        landed: landed({ sessions: 1, filesChanged: 3, insertions: 40, deletions: 5 }),
        sessions: [
          session({
            id: "a",
            status: "running",
            employee: { id: "e1", name: "Ada", slug: "ada", avatarKey: null },
          }),
          session({
            id: "b",
            status: "running",
            employee: { id: "e1", name: "Ada", slug: "ada", avatarKey: null },
          }),
        ],
      },
      2,
    );
    assert.equal(glance.counts.running, 2);
    assert.equal(glance.granted, 2);
    assert.deepEqual(glance.workingNames, ["Ada"]);
    // Two sessions, one person — so the verb is singular.
    assert.equal(
      repositoryAiHeading("ready", glance).headline,
      "Ada is working here now. 1 other session is waiting for you.",
    );
  });
});
