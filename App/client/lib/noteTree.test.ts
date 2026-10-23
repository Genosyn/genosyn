import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ancestorIds,
  applyMove,
  buildNoteTree,
  descendantIds,
  dropTarget,
  dropZoneAt,
  expandedKey,
  findNotesByTitle,
  noteHref,
  notebookDropTarget,
  readExpanded,
  recentNotes,
  type TreeNode,
  type TreeNote,
  writeExpanded,
} from "./noteTree.js";

function note(id: string, extra: Partial<TreeNote> = {}): TreeNote {
  return {
    id,
    slug: id,
    title: id.toUpperCase(),
    icon: "",
    notebookId: "nb1",
    parentId: null,
    sortOrder: 0,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

function names(nodes: Array<TreeNode> | undefined): unknown[] {
  return (nodes ?? []).map((n) => (n.children.length ? [n.note.id, names(n.children)] : n.note.id));
}

const notes: TreeNote[] = [
  note("a", { sortOrder: 2000 }),
  note("b", { sortOrder: 1000 }),
  note("a1", { parentId: "a", sortOrder: 1000 }),
  note("a2", { parentId: "a", sortOrder: 2000 }),
  note("a1x", { parentId: "a1", sortOrder: 1000 }),
  note("c", { notebookId: "nb2", sortOrder: 1000 }),
];

describe("buildNoteTree", () => {
  test("nests pages per notebook, ordered by position", () => {
    const tree = buildNoteTree(notes);
    assert.deepEqual(names(tree.get("nb1")), ["b", ["a", [["a1", ["a1x"]], "a2"]]]);
    assert.deepEqual(names(tree.get("nb2")), ["c"]);
  });

  test("ties fall back to the most recently edited", () => {
    const tree = buildNoteTree([
      note("old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      note("new", { updatedAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    assert.deepEqual(names(tree.get("nb1")), ["new", "old"]);
  });

  test("a page whose parent is missing, elsewhere, or circular sits at the top", () => {
    const tree = buildNoteTree([
      note("orphan", { parentId: "gone" }),
      note("x", { parentId: "y" }),
      note("y", { parentId: "x" }),
      note("p", { notebookId: "nb2" }),
      note("crossed", { parentId: "p" }),
    ]);
    const top = names(tree.get("nb1")).flat(3);
    assert.ok(top.includes("orphan"));
    assert.ok(top.includes("crossed"));
    assert.ok(top.includes("x") || top.includes("y"));
  });
});

describe("relations", () => {
  test("ancestorIds lists the chain from the top", () => {
    assert.deepEqual(ancestorIds(notes, "a1x"), ["a", "a1"]);
    assert.deepEqual(ancestorIds(notes, "b"), []);
  });

  test("descendantIds finds every page underneath", () => {
    assert.deepEqual([...descendantIds(notes, "a")].sort(), ["a1", "a1x", "a2"]);
    assert.deepEqual([...descendantIds(notes, "b")], []);
  });

  test("recentNotes skips trashed pages and orders by last edit", () => {
    const recent = recentNotes(
      [
        note("x", { updatedAt: "2026-10-01T00:00:00.000Z" }),
        note("y", { updatedAt: "2026-10-03T00:00:00.000Z" }),
        note("z", { updatedAt: "2026-10-05T00:00:00.000Z", archivedAt: "2026-10-06T00:00:00.000Z" }),
      ],
      2,
    );
    assert.deepEqual(recent.map((n) => n.id), ["y", "x"]);
  });

  test("findNotesByTitle ranks prefix matches first", () => {
    const pages = [note("p1", { title: "Weekly sync notes" }), note("p2", { title: "Sync runbook" }), note("p3", { title: "Unrelated" })];
    assert.deepEqual(findNotesByTitle(pages, "sync").map((n) => n.id), ["p2", "p1"]);
    assert.deepEqual(findNotesByTitle(pages, ""), []);
    assert.deepEqual(findNotesByTitle([note("u", { title: "" })], "untitled").map((n) => n.id), ["u"]);
  });
});

describe("drag and drop", () => {
  test("drop zones: top quarter before, bottom quarter after, middle inside", () => {
    assert.equal(dropZoneAt(2, 28), "before");
    assert.equal(dropZoneAt(14, 28), "inside");
    assert.equal(dropZoneAt(26, 28), "after");
    assert.equal(dropZoneAt(0, 0), "inside");
  });

  test("before/after a sibling lands at that position", () => {
    assert.deepEqual(dropTarget(notes, "b", "a2", "before"), { notebookId: "nb1", parentId: "a", index: 1 });
    assert.deepEqual(dropTarget(notes, "b", "a2", "after"), { notebookId: "nb1", parentId: "a", index: 2 });
    assert.deepEqual(dropTarget(notes, "a2", "a1", "before"), { notebookId: "nb1", parentId: "a", index: 0 });
  });

  test("inside a page appends as its last sub-page", () => {
    assert.deepEqual(dropTarget(notes, "b", "a", "inside"), { notebookId: "nb1", parentId: "a", index: 2 });
  });

  test("dropping a page into itself or its own sub-pages is refused", () => {
    assert.equal(dropTarget(notes, "a", "a", "inside"), null);
    assert.equal(dropTarget(notes, "a", "a1x", "after"), null);
    assert.equal(dropTarget(notes, "a", "missing", "after"), null);
  });

  test("across notebooks: onto a page or a notebook header", () => {
    assert.deepEqual(dropTarget(notes, "b", "c", "after"), { notebookId: "nb2", parentId: null, index: 1 });
    assert.deepEqual(notebookDropTarget(notes, "b", "nb2"), { notebookId: "nb2", parentId: null, index: 1 });
  });

  test("applyMove reorders siblings and carries sub-pages to a new notebook", () => {
    const moved = applyMove(notes, "a", { notebookId: "nb2", parentId: null, index: 0 });
    const byId = new Map(moved.map((n) => [n.id, n]));
    assert.equal(byId.get("a")?.notebookId, "nb2");
    assert.equal(byId.get("a1")?.notebookId, "nb2");
    assert.equal(byId.get("a1x")?.notebookId, "nb2");
    assert.ok(byId.get("a")!.sortOrder < byId.get("c")!.sortOrder);
    assert.deepEqual(names(buildNoteTree(moved).get("nb2")), [["a", [["a1", ["a1x"]], "a2"]], "c"]);
    assert.deepEqual(names(buildNoteTree(moved).get("nb1")), ["b"]);
  });

  test("applyMove within siblings", () => {
    const moved = applyMove(notes, "a2", { notebookId: "nb1", parentId: "a", index: 0 });
    assert.deepEqual(names(buildNoteTree(moved).get("nb1")), ["b", ["a", ["a2", ["a1", ["a1x"]]]]]);
  });
});

describe("helpers", () => {
  test("noteHref builds the page URL", () => {
    assert.equal(noteHref("acme", "general", "plan"), "/c/acme/notes/general/plan");
  });

  test("expanded rows are remembered, tolerating bad storage", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    const key = expandedKey("co");
    writeExpanded(storage, key, new Set(["a", "b"]));
    assert.deepEqual([...(readExpanded(storage, key) ?? [])], ["a", "b"]);
    data.set(key, "nope");
    assert.equal(readExpanded(storage, key), null);
    assert.equal(readExpanded(null, key), null);
  });
});
