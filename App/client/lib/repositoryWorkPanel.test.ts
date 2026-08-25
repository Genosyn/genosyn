import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RepositoryWorkTarget } from "./repositoryWorkLink";
import {
  initialRepositoryWorkPanelState,
  repositoryWorkPanelMemory,
  repositoryWorkPanelReducer as reduce,
  sameWorkTarget,
  type RepositoryWorkPanelEvent,
  type RepositoryWorkPanelState,
} from "./repositoryWorkPanel";

/**
 * When repository work shows up beside a conversation.
 *
 * Every rule here is about not being annoying: a panel that reopens itself
 * after you close it, or that greets you with a month-old diff every time you
 * reopen a thread, is worse than no panel at all.
 */

const A: RepositoryWorkTarget = { repositorySlug: "oneuptime", sessionId: "session-a" };
const B: RepositoryWorkTarget = { repositorySlug: "docs", sessionId: "session-b" };

function run(
  events: RepositoryWorkPanelEvent[],
  from: RepositoryWorkPanelState = initialRepositoryWorkPanelState,
): RepositoryWorkPanelState {
  return events.reduce(reduce, from);
}

const inThread = (id = "conv-1") => run([{ type: "thread", conversationId: id }]);

describe("sameWorkTarget", () => {
  test("compares by repository and session, not identity", () => {
    assert.equal(sameWorkTarget(A, { ...A }), true);
    assert.equal(sameWorkTarget(A, B), false);
    assert.equal(sameWorkTarget(A, { ...A, repositorySlug: "other" }), false);
    assert.equal(sameWorkTarget(null, null), true);
    assert.equal(sameWorkTarget(A, null), false);
    assert.equal(sameWorkTarget(null, A), false);
  });
});

describe("opening the panel", () => {
  test("starts closed", () => {
    assert.equal(initialRepositoryWorkPanelState.open, null);
    assert.equal(initialRepositoryWorkPanelState.collapsed, false);
    assert.deepEqual(initialRepositoryWorkPanelState.offered, []);
  });

  test("a clicked link opens that session", () => {
    const state = run([{ type: "open", target: A }], inThread());
    assert.deepEqual(state.open, A);
  });

  test("a clicked link is recorded, so it is not also treated as news later", () => {
    const state = run(
      [
        { type: "open", target: A },
        { type: "close" },
        { type: "transcript", targets: [A], live: true },
      ],
      inThread(),
    );
    assert.equal(state.open, null, "closing a session the reader opened themselves means closed");
  });

  test("clicking the session already open and visible changes nothing at all", () => {
    const before = run([{ type: "open", target: A }], inThread());
    assert.equal(reduce(before, { type: "open", target: { ...A } }), before);
  });

  test("clicking another session while one is open swaps to it", () => {
    const state = run(
      [
        { type: "open", target: A },
        { type: "open", target: B },
      ],
      inThread(),
    );
    assert.deepEqual(state.open, B);
    assert.deepEqual(state.offered, ["session-a", "session-b"]);
  });
});

describe("the rail", () => {
  test("collapsing and expanding is remembered", () => {
    const collapsed = run(
      [
        { type: "open", target: A },
        { type: "collapse", collapsed: true },
      ],
      inThread(),
    );
    assert.equal(collapsed.collapsed, true);
    assert.deepEqual(collapsed.open, A, "collapsing is not closing");
    assert.equal(reduce(collapsed, { type: "collapse", collapsed: false }).collapsed, false);
  });

  test("collapsing to the state it is already in changes nothing", () => {
    const before = run([{ type: "open", target: A }], inThread());
    assert.equal(reduce(before, { type: "collapse", collapsed: false }), before);
  });

  test("clicking the collapsed session's link opens it back up", () => {
    // Chat cancels the link's navigation before the panel sees the click, so
    // this must not be a no-op — it would be a dead link.
    const state = run(
      [
        { type: "open", target: A },
        { type: "collapse", collapsed: true },
        { type: "open", target: { ...A } },
      ],
      inThread(),
    );
    assert.equal(state.collapsed, false);
    assert.deepEqual(state.open, A);
  });

  test("clicking another session's link opens it back up too", () => {
    const state = run(
      [
        { type: "open", target: A },
        { type: "collapse", collapsed: true },
        { type: "open", target: B },
      ],
      inThread(),
    );
    assert.equal(state.collapsed, false);
    assert.deepEqual(state.open, B);
  });

  test("new work does not unwind a rail the reader wound down", () => {
    // Collapsing is a decision about the panel, and a session arriving is not
    // a reason to overrule it — the link is in the transcript either way.
    const state = run(
      [
        { type: "open", target: A },
        { type: "collapse", collapsed: true },
        { type: "transcript", targets: [B], live: true },
      ],
      inThread(),
    );
    assert.equal(state.collapsed, true);
    assert.deepEqual(state.open, A);
    assert.deepEqual(state.offered, ["session-a", "session-b"], "but it is still recorded");
  });

  test("work arriving after a collapsed panel was closed opens uncollapsed", () => {
    const state = run(
      [
        { type: "open", target: A },
        { type: "collapse", collapsed: true },
        { type: "close" },
        { type: "transcript", targets: [B], live: true },
      ],
      inThread(),
    );
    assert.equal(state.collapsed, false);
    assert.deepEqual(state.open, B);
  });

  test("closing puts the rail away, so the next session is not born collapsed", () => {
    const state = run(
      [{ type: "open", target: A }, { type: "collapse", collapsed: true }, { type: "close" }],
      inThread(),
    );
    assert.equal(state.open, null);
    assert.equal(state.collapsed, false);
  });

  test("switching threads puts the rail away", () => {
    const state = run(
      [
        { type: "open", target: A },
        { type: "collapse", collapsed: true },
        { type: "thread", conversationId: "conv-2" },
      ],
      inThread("conv-1"),
    );
    assert.equal(state.collapsed, false);
  });
});

describe("a thread as it loads", () => {
  test("records the sessions in its history without opening any of them", () => {
    const state = run([{ type: "transcript", targets: [A, B], live: false }], inThread());
    assert.equal(state.open, null, "reopening an old thread is not news");
    assert.deepEqual(state.offered, ["session-a", "session-b"]);
  });

  test("does not open history on the next render either", () => {
    const state = run(
      [
        { type: "transcript", targets: [A, B], live: false },
        { type: "transcript", targets: [A, B], live: true },
      ],
      inThread(),
    );
    assert.equal(state.open, null);
  });

  test("a link in history still opens when it is clicked", () => {
    const state = run(
      [
        { type: "transcript", targets: [A], live: false },
        { type: "open", target: A },
      ],
      inThread(),
    );
    assert.deepEqual(state.open, A);
  });
});

describe("work that starts while the reader is there", () => {
  test("opens the panel on the new session", () => {
    const state = run(
      [
        { type: "transcript", targets: [], live: false },
        { type: "transcript", targets: [A], live: true },
      ],
      inThread(),
    );
    assert.deepEqual(state.open, A);
  });

  test("opens the newest when a turn links more than one at once", () => {
    const state = run(
      [
        { type: "transcript", targets: [], live: false },
        { type: "transcript", targets: [A, B], live: true },
      ],
      inThread(),
    );
    assert.deepEqual(state.open, B);
    assert.deepEqual(state.offered, ["session-a", "session-b"]);
  });

  test("does not reopen a session the reader closed", () => {
    const state = run(
      [
        { type: "transcript", targets: [A], live: true },
        { type: "close" },
        { type: "transcript", targets: [A], live: true },
        { type: "transcript", targets: [A], live: true },
      ],
      inThread(),
    );
    assert.equal(state.open, null);
  });

  test("does not swap out the session being read for a newer one", () => {
    const state = run(
      [
        { type: "transcript", targets: [A], live: true },
        { type: "transcript", targets: [A, B], live: true },
      ],
      inThread(),
    );
    assert.deepEqual(state.open, A, "the reader keeps what they are looking at");
    assert.deepEqual(
      state.offered,
      ["session-a", "session-b"],
      "but the new one is not news twice",
    );
  });

  test("opens a genuinely new session after the last one was closed", () => {
    const state = run(
      [
        { type: "transcript", targets: [A], live: true },
        { type: "close" },
        { type: "transcript", targets: [A, B], live: true },
      ],
      inThread(),
    );
    assert.deepEqual(state.open, B);
  });

  test("a transcript with nothing new in it is not a state change", () => {
    const before = run([{ type: "transcript", targets: [A], live: true }], inThread());
    assert.equal(reduce(before, { type: "transcript", targets: [A], live: true }), before);
    assert.equal(reduce(before, { type: "transcript", targets: [], live: true }), before);
  });
});

describe("switching threads", () => {
  test("closes the panel and forgets what the old thread had offered", () => {
    const state = run(
      [
        { type: "transcript", targets: [A], live: true },
        { type: "thread", conversationId: "conv-2" },
      ],
      inThread("conv-1"),
    );
    assert.equal(state.open, null);
    assert.deepEqual(state.offered, []);
    assert.equal(state.conversationId, "conv-2");
  });

  test("re-announcing the same thread leaves everything alone", () => {
    const before = run([{ type: "transcript", targets: [A], live: true }], inThread("conv-1"));
    assert.equal(reduce(before, { type: "thread", conversationId: "conv-1" }), before);
  });

  test("a new thread's own work still opens", () => {
    const state = run(
      [
        { type: "transcript", targets: [A], live: true },
        { type: "close" },
        { type: "thread", conversationId: "conv-2" },
        { type: "transcript", targets: [A], live: true },
      ],
      inThread("conv-1"),
    );
    assert.deepEqual(state.open, A, "the same session linked from another thread is news again");
  });

  test("leaving chat entirely resets it", () => {
    const state = run(
      [
        { type: "transcript", targets: [A], live: true },
        { type: "thread", conversationId: null },
      ],
      inThread("conv-1"),
    );
    assert.equal(state.open, null);
    assert.equal(state.conversationId, null);
  });
});

describe("closing", () => {
  test("closing an already closed panel changes nothing", () => {
    const before = inThread();
    assert.equal(reduce(before, { type: "close" }), before);
  });

  test("closing keeps the thread and its record", () => {
    const state = run(
      [{ type: "transcript", targets: [A], live: true }, { type: "close" }],
      inThread("conv-1"),
    );
    assert.equal(state.conversationId, "conv-1");
    assert.deepEqual(state.offered, ["session-a"]);
  });
});

describe("coming back to a thread after a reload", () => {
  test("puts the reader back in front of what they were reading", () => {
    const state = run([
      {
        type: "thread",
        conversationId: "conv-1",
        remembered: { open: A, collapsed: false, offered: ["session-a"] },
      },
      // The transcript loads again from scratch, and must not disturb it.
      { type: "transcript", targets: [A], live: false },
    ]);
    assert.deepEqual(state.open, A);
  });

  test("a rail is still a rail", () => {
    const state = run([
      {
        type: "thread",
        conversationId: "conv-1",
        remembered: { open: A, collapsed: true, offered: ["session-a"] },
      },
    ]);
    assert.equal(state.collapsed, true);
    assert.deepEqual(state.open, A);
  });

  test("a panel sent away before the reload stays away", () => {
    // Dismissing is remembered as "closed, and this one has been offered" —
    // so the transcript arriving again, live or not, is not news.
    const state = run([
      {
        type: "thread",
        conversationId: "conv-1",
        remembered: { open: null, collapsed: false, offered: ["session-a"] },
      },
      { type: "transcript", targets: [A], live: false },
      { type: "transcript", targets: [A], live: true },
    ]);
    assert.equal(state.open, null);
  });

  test("does not restore a rail with nothing on it", () => {
    // A remembered `collapsed` outliving the panel it belonged to would open
    // the thread's next session wound down, which `close` already refuses.
    const state = run([
      {
        type: "thread",
        conversationId: "conv-1",
        remembered: { open: null, collapsed: true, offered: [] },
      },
      { type: "transcript", targets: [A], live: true },
    ]);
    assert.deepEqual(state.open, A);
    assert.equal(state.collapsed, false);
  });

  test("work that started while the page was gone is history by the time it loads", () => {
    const state = run([
      {
        type: "thread",
        conversationId: "conv-1",
        remembered: { open: null, collapsed: false, offered: ["session-a"] },
      },
      { type: "transcript", targets: [A, B], live: false },
      { type: "transcript", targets: [A, B], live: true },
    ]);
    assert.equal(state.open, null, "nothing springs a diff on someone mid-load");
    assert.deepEqual(state.offered, ["session-a", "session-b"], "but its link is recorded");
  });

  test("remembering nothing opens the thread the way it always did", () => {
    const state = run([{ type: "thread", conversationId: "conv-1", remembered: null }]);
    assert.deepEqual(state, {
      conversationId: "conv-1",
      open: null,
      collapsed: false,
      offered: [],
    });
  });

  test("a thread already open ignores what was written down for it", () => {
    // The reducer holds the live state; re-reading storage over the top of it
    // would undo whatever the reader has done since.
    const before = run(
      [
        { type: "open", target: B },
        { type: "collapse", collapsed: true },
      ],
      inThread("conv-1"),
    );
    assert.equal(
      reduce(before, {
        type: "thread",
        conversationId: "conv-1",
        remembered: { open: A, collapsed: false, offered: [] },
      }),
      before,
    );
  });

  test("does not hold on to the array it was handed", () => {
    const remembered = { open: null, collapsed: false, offered: ["session-a"] };
    const state = run([{ type: "thread", conversationId: "conv-1", remembered }]);
    reduce(state, { type: "transcript", targets: [B], live: true });
    assert.deepEqual(remembered.offered, ["session-a"], "storage's array is not the reducer's");
  });
});

describe("what gets written down", () => {
  test("is the state without the thread it belongs to", () => {
    const state = run(
      [
        { type: "open", target: A },
        { type: "collapse", collapsed: true },
      ],
      inThread("conv-1"),
    );
    assert.deepEqual(repositoryWorkPanelMemory(state), {
      open: A,
      collapsed: true,
      offered: ["session-a"],
    });
  });

  test("round-trips back into the thread it came from", () => {
    const before = run(
      [
        { type: "transcript", targets: [A], live: true },
        { type: "collapse", collapsed: true },
      ],
      inThread("conv-1"),
    );
    const after = run([
      { type: "thread", conversationId: "conv-1", remembered: repositoryWorkPanelMemory(before) },
    ]);
    assert.deepEqual(after, before);
  });
});

describe("a whole conversation", () => {
  test("plays out the way a Member would expect", () => {
    // Open a thread that already had work in it…
    let state = run(
      [
        { type: "thread", conversationId: "conv-9" },
        { type: "transcript", targets: [A], live: false },
      ],
      initialRepositoryWorkPanelState,
    );
    assert.equal(state.open, null, "history stays history");

    // …click the link in it…
    state = reduce(state, { type: "open", target: A });
    assert.deepEqual(state.open, A);

    // …close it, ask for something else, and let the employee start new work.
    state = reduce(state, { type: "close" });
    state = reduce(state, { type: "transcript", targets: [A, B], live: true });
    assert.deepEqual(state.open, B, "the new session is what the reader was just told about");

    // Reopening the thread later shows nothing until they ask for it.
    state = reduce(state, { type: "thread", conversationId: "conv-1" });
    state = reduce(state, { type: "thread", conversationId: "conv-9" });
    state = reduce(state, { type: "transcript", targets: [A, B], live: false });
    assert.equal(state.open, null);
  });
});
