import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { type AutosaveStatus, Autosaver, normalizeSnapshot, type SaveOutcome } from "./noteAutosave.js";
import {
  clearDraft,
  DRAFT_MAX_AGE_MS,
  draftKey,
  type NoteDraft,
  planDraftRecovery,
  readDraft,
  writeDraft,
} from "./noteDrafts.js";
import { EditHistory } from "./noteHistory.js";
import { matchLines, mergeSnapshots, mergeText, type NoteSnapshot } from "./noteMerge.js";

describe("EditHistory", () => {
  test("undo returns the state before a change, redo returns forward", () => {
    const history = new EditHistory<string, number>();
    history.record("a", 1, "structure", "x", 0);
    const undone = history.undo("b", 2);
    assert.deepEqual(undone, { state: "a", selection: 1 });
    const redone = history.redo("a", 1);
    assert.deepEqual(redone, { state: "b", selection: 2 });
    assert.equal(history.redo("b", 2), null);
  });

  test("typing in one block within the window is one step", () => {
    const history = new EditHistory<string, null>(100, 1000);
    history.record("", null, "typing", "block1", 0);
    history.record("h", null, "typing", "block1", 300);
    history.record("he", null, "typing", "block1", 600);
    assert.deepEqual(history.undo("hel", null)?.state, "");
    assert.equal(history.canUndo, false);
  });

  test("a pause, another block, a structural change or a seal starts a new step", () => {
    const history = new EditHistory<string, null>(100, 1000);
    history.record("0", null, "typing", "a", 0);
    history.record("1", null, "typing", "a", 2000);
    history.record("2", null, "typing", "b", 2100);
    history.record("3", null, "structure", "b", 2200);
    history.record("4", null, "typing", "b", 2300);
    history.seal();
    history.record("5", null, "typing", "b", 2400);
    const states: string[] = [];
    let current = "6";
    for (let step = history.undo(current, null); step; step = history.undo(current, null)) {
      states.push(step.state);
      current = step.state;
    }
    assert.deepEqual(states, ["5", "4", "3", "2", "1", "0"]);
  });

  test("a new change clears redo", () => {
    const history = new EditHistory<string, null>();
    history.record("a", null, "structure", undefined, 0);
    history.undo("b", null);
    assert.equal(history.canRedo, true);
    history.record("a", null, "structure", undefined, 10);
    assert.equal(history.canRedo, false);
  });

  test("keeps at most `limit` steps", () => {
    const history = new EditHistory<number, null>(3);
    for (let i = 0; i < 10; i++) history.record(i, null, "structure", undefined, i * 5000);
    const states: number[] = [];
    let current = 10;
    for (let step = history.undo(current, null); step; step = history.undo(current, null)) {
      states.push(step.state);
      current = step.state;
    }
    assert.deepEqual(states, [9, 8, 7]);
  });
});

describe("mergeText", () => {
  test("identical or one-sided changes take the change", () => {
    assert.deepEqual(mergeText("a", "a", "b"), { text: "b", conflicts: 0 });
    assert.deepEqual(mergeText("a", "b", "a"), { text: "b", conflicts: 0 });
    assert.deepEqual(mergeText("a", "b", "b"), { text: "b", conflicts: 0 });
  });

  test("changes to different lines both survive", () => {
    const base = "# Plan\n\nIntro\n\n## Notes\n\nold notes";
    const ours = "# Plan\n\nIntro, edited by a Member\n\n## Notes\n\nold notes";
    const theirs = "# Plan\n\nIntro\n\n## Notes\n\nold notes\n\nAppended by an AI Employee";
    assert.deepEqual(mergeText(base, ours, theirs), {
      text: "# Plan\n\nIntro, edited by a Member\n\n## Notes\n\nold notes\n\nAppended by an AI Employee",
      conflicts: 0,
    });
  });

  test("the same line changed differently keeps ours and counts a conflict", () => {
    assert.deepEqual(mergeText("a\nb\nc", "a\nOURS\nc", "a\nTHEIRS\nc"), { text: "a\nOURS\nc", conflicts: 1 });
  });

  test("insertions at the same spot keep ours", () => {
    const merged = mergeText("a\nc", "a\nb1\nc", "a\nb2\nc");
    assert.equal(merged.text, "a\nb1\nc");
    assert.equal(merged.conflicts, 1);
  });

  test("deletions on one side and edits elsewhere on the other", () => {
    assert.deepEqual(mergeText("1\n2\n3\n4", "1\n3\n4", "1\n2\n3\n4!"), { text: "1\n3\n4!", conflicts: 0 });
  });

  test("matchLines finds a longest common subsequence", () => {
    assert.deepEqual(matchLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]), [
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
    assert.deepEqual(matchLines([], ["a"]), []);
  });

  test("a large document with scattered edits merges quickly", () => {
    const base = Array.from({ length: 4000 }, (_, i) => `line ${i}`);
    const ours = base.slice();
    ours[10] = "ours 10";
    ours[3000] = "ours 3000";
    const theirs = base.slice();
    theirs[2000] = "theirs 2000";
    theirs.push("theirs tail");
    const start = Date.now();
    const merged = mergeText(base.join("\n"), ours.join("\n"), theirs.join("\n"));
    assert.ok(Date.now() - start < 2000);
    const lines = merged.text.split("\n");
    assert.equal(lines[10], "ours 10");
    assert.equal(lines[2000], "theirs 2000");
    assert.equal(lines[3000], "ours 3000");
    assert.equal(lines[lines.length - 1], "theirs tail");
    assert.equal(merged.conflicts, 0);
  });

  test("mergeSnapshots merges title and icon as values", () => {
    const base: NoteSnapshot = { title: "T", body: "b", icon: "" };
    assert.deepEqual(mergeSnapshots(base, { ...base, title: "Mine" }, { ...base, icon: "x" }), {
      snapshot: { title: "Mine", body: "b", icon: "x" },
      conflicts: 0,
    });
    assert.equal(mergeSnapshots(base, { ...base, title: "A" }, { ...base, title: "B" }).conflicts, 1);
  });
});

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("drafts", () => {
  const base: NoteSnapshot = { title: "Title", body: "one\ntwo", icon: "" };
  const draft = (snapshot: NoteSnapshot, extra: Partial<NoteDraft> = {}): NoteDraft => ({
    v: 1,
    noteId: "n1",
    snapshot,
    base,
    baseUpdatedAt: "2026-10-23T10:00:00.000Z",
    savedAt: 1000,
    ...extra,
  });

  test("written, read back, and cleared", () => {
    const storage = memoryStorage();
    const key = draftKey("co", "n1");
    assert.equal(writeDraft(storage, key, draft({ ...base, body: "edited" })), true);
    assert.equal(readDraft(storage, key)?.snapshot.body, "edited");
    clearDraft(storage, key);
    assert.equal(readDraft(storage, key), null);
  });

  test("unreadable or malformed drafts are ignored; blocked storage is survivable", () => {
    const storage = memoryStorage();
    storage.setItem("k", "{not json");
    assert.equal(readDraft(storage, "k"), null);
    storage.setItem("k", JSON.stringify({ v: 2 }));
    assert.equal(readDraft(storage, "k"), null);
    assert.equal(readDraft(null, "k"), null);
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    assert.equal(readDraft(throwing, "k"), null);
    assert.equal(writeDraft(throwing, "k", draft(base)), false);
    clearDraft(throwing, "k");
  });

  test("a draft the server already has is discarded", () => {
    const server = { ...base, body: "edited", updatedAt: "2026-10-23T10:05:00.000Z" };
    assert.deepEqual(planDraftRecovery(draft({ ...base, body: "edited" }), server, 2000), { kind: "discard" });
  });

  test("a draft over an unchanged server copy is restored as written", () => {
    const server = { ...base, updatedAt: "2026-10-23T10:00:00.000Z" };
    assert.deepEqual(planDraftRecovery(draft({ ...base, body: "one\ntwo\nthree" }), server, 2000), {
      kind: "restore",
      snapshot: { ...base, body: "one\ntwo\nthree" },
      conflicts: 0,
    });
  });

  test("a draft over a copy someone else saved since is merged onto it", () => {
    const server = { ...base, body: "zero\none\ntwo", updatedAt: "2026-10-23T11:00:00.000Z" };
    assert.deepEqual(planDraftRecovery(draft({ ...base, body: "one\ntwo\nthree" }), server, 2000), {
      kind: "restore",
      snapshot: { ...base, body: "zero\none\ntwo\nthree" },
      conflicts: 0,
    });
  });

  test("stale drafts are discarded", () => {
    const server = { ...base, updatedAt: "2026-10-23T10:00:00.000Z" };
    assert.deepEqual(planDraftRecovery(draft({ ...base, body: "x" }), server, 1000 + DRAFT_MAX_AGE_MS + 1), { kind: "discard" });
    assert.deepEqual(planDraftRecovery(null, server, 0), { kind: "none" });
  });
});

/** Timers the test advances by hand. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (id: unknown) => void pending.delete(id as number),
      now: () => now,
    },
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await new Promise((r) => setImmediate(r));
      }
      now = target;
      await new Promise((r) => setImmediate(r));
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

type Call = { snapshot: NoteSnapshot; base: string; keepalive: boolean };

function harness(replies: Array<(call: Call) => SaveOutcome | Promise<SaveOutcome>> = []) {
  const clock = fakeTimers();
  const calls: Call[] = [];
  const statuses: AutosaveStatus[] = [];
  const merged: NoteSnapshot[] = [];
  let version = 0;
  const saver = new Autosaver(
    { snapshot: { title: "T", body: "", icon: "" }, updatedAt: "v0" },
    {
      timers: clock.timers,
      debounceMs: 500,
      maxWaitMs: 2000,
      retryDelaysMs: [1000, 3000],
      onStatus: (s) => statuses.push(s),
      onMerged: (s) => merged.push(s),
      save: async (snapshot, base, { keepalive }) => {
        const call = { snapshot, base, keepalive };
        calls.push(call);
        const reply = replies.shift();
        if (reply) return reply(call);
        version++;
        return { kind: "saved", server: { snapshot, updatedAt: `v${version}` } };
      },
    },
  );
  return { saver, clock, calls, statuses, merged };
}

const snap = (body: string, title = "T"): NoteSnapshot => ({ title, body, icon: "" });

describe("Autosaver", () => {
  test("saves once typing pauses, then reports Saved", async () => {
    const { saver, clock, calls, statuses } = harness();
    saver.update(snap("h"));
    saver.update(snap("he"));
    await clock.advance(400);
    saver.update(snap("hey"));
    assert.equal(calls.length, 0);
    await clock.advance(500);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { snapshot: snap("hey"), base: "v0", keepalive: false });
    assert.equal(saver.state, "saved");
    assert.equal(saver.dirty, false);
    assert.deepEqual(statuses.filter((s, i) => s !== statuses[i - 1]), ["pending", "saving", "saved"]);
  });

  test("saves at least every maxWait during a long burst", async () => {
    const { saver, clock, calls } = harness();
    for (let t = 0; t < 2500; t += 100) {
      saver.update(snap(`x${t}`));
      await clock.advance(100);
    }
    assert.ok(calls.length >= 1, "a save happened mid-burst");
  });

  test("the next save is based on the version the last one created", async () => {
    const { saver, clock, calls } = harness();
    saver.update(snap("one"));
    await clock.advance(500);
    saver.update(snap("two"));
    await clock.advance(500);
    assert.deepEqual(calls.map((c) => c.base), ["v0", "v1"]);
  });

  test("edits made while a save is in flight are saved after it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { saver, clock, calls } = harness([
      async (call) => {
        await gate;
        return { kind: "saved", server: { snapshot: call.snapshot, updatedAt: "v1" } };
      },
    ]);
    saver.update(snap("first"));
    await clock.advance(500);
    saver.update(snap("second"));
    assert.equal(calls.length, 1);
    release();
    await clock.advance(10);
    await clock.advance(500);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].snapshot, snap("second"));
    assert.equal(calls[1].base, "v1");
  });

  test("a failed save retries with backoff and reports the error", async () => {
    const { saver, clock, calls, statuses } = harness([
      () => ({ kind: "error", error: new Error("offline") }),
      () => ({ kind: "error", error: new Error("offline") }),
    ]);
    saver.update(snap("x"));
    await clock.advance(500);
    assert.equal(saver.state, "error");
    await clock.advance(1000);
    assert.equal(calls.length, 2);
    await clock.advance(3000);
    assert.equal(calls.length, 3);
    assert.equal(saver.state, "saved");
    assert.ok(statuses.includes("error"));
  });

  test("a thrown save counts as a failure", async () => {
    const { saver, clock } = harness([
      () => {
        throw new Error("boom");
      },
    ]);
    saver.update(snap("x"));
    await clock.advance(500);
    assert.equal(saver.state, "error");
  });

  test("a conflict merges our edits onto the newer version and saves again", async () => {
    const { saver, clock, calls, merged } = harness([
      () => ({ kind: "conflict", server: { snapshot: snap("ai line\nintro"), updatedAt: "v-ai" } }),
    ]);
    saver.serverChanged({ snapshot: snap("intro"), updatedAt: "v0b" });
    saver.update(snap("intro\nmy line"));
    await clock.advance(500);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].body, "ai line\nintro\nmy line");
    await clock.advance(500);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].base, "v-ai");
    assert.equal(calls[1].snapshot.body, "ai line\nintro\nmy line");
  });

  test("flush saves immediately; nothing unsaved means no request", async () => {
    const { saver, clock, calls } = harness();
    await saver.flush();
    assert.equal(calls.length, 0);
    saver.update(snap("now"));
    await saver.flush();
    assert.equal(calls.length, 1);
    await clock.advance(1000);
    assert.equal(calls.length, 1);
  });

  test("dispose sends pending edits with keepalive and stops reporting", async () => {
    const { saver, calls, statuses } = harness();
    saver.update(snap("leaving"));
    const seen = statuses.length;
    saver.dispose();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [{ snapshot: snap("leaving"), base: "v0", keepalive: true }]);
    assert.equal(statuses.length, seen);
    saver.update(snap("ignored"));
    assert.equal(calls.length, 1);
  });

  test("dispose waits for a save in flight, then sends what came after", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { saver, clock, calls } = harness([
      async (call) => {
        await gate;
        return { kind: "saved", server: { snapshot: call.snapshot, updatedAt: "v1" } };
      },
    ]);
    saver.update(snap("a"));
    await clock.advance(500);
    saver.update(snap("ab"));
    saver.dispose();
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { snapshot: snap("ab"), base: "v1", keepalive: true });
  });

  test("undoing back to the saved text cancels the pending save", async () => {
    const { saver, clock, calls } = harness();
    saver.update(snap("typo"));
    saver.update(snap(""));
    await clock.advance(1000);
    assert.equal(calls.length, 0);
  });

  test("a blank title is the same as Untitled", () => {
    assert.deepEqual(normalizeSnapshot({ title: "  ", body: "", icon: "" }).title, "Untitled");
    const { saver } = harness();
    saver.update({ title: "  T ", body: "", icon: "" });
    assert.equal(saver.dirty, false);
  });

  test("a live server change replaces clean content and merges into unsaved edits", async () => {
    const clean = harness();
    const applied = clean.saver.serverChanged({ snapshot: snap("from ai"), updatedAt: "v9" });
    assert.deepEqual(applied, { snapshot: snap("from ai"), conflicts: 0 });
    assert.equal(clean.saver.dirty, false);
    assert.equal(clean.saver.serverChanged({ snapshot: snap("from ai"), updatedAt: "v9" }), null);

    const dirty = harness();
    dirty.saver.serverChanged({ snapshot: snap("intro"), updatedAt: "v1" });
    dirty.saver.update(snap("intro\nmine"));
    const merged = dirty.saver.serverChanged({ snapshot: snap("theirs\nintro"), updatedAt: "v9" });
    assert.equal(merged?.snapshot.body, "theirs\nintro\nmine");
    await dirty.clock.advance(10);
    assert.equal(dirty.calls[0].base, "v9");
  });
});
