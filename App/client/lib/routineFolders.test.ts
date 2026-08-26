import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { RoutineFolder } from "./api";
import { childrenByParent, folderAndDescendants } from "./routineFolders";

function folder(id: string, parentId: string | null, name = id): RoutineFolder {
  return {
    id,
    companyId: "co",
    name,
    slug: name.toLowerCase(),
    parentId,
    sortOrder: 0,
    path: name,
    depth: 1,
    routineCount: 0,
    totalRoutineCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("folderAndDescendants", () => {
  test("collects the whole subtree, not just direct children", () => {
    const folders = [
      folder("finance", null),
      folder("month-end", "finance"),
      folder("close", "month-end"),
      folder("support", null),
    ];
    assert.deepEqual(
      [...folderAndDescendants(folders, "finance")].sort(),
      ["close", "finance", "month-end"],
    );
  });

  test("a leaf resolves to just itself", () => {
    const folders = [folder("finance", null), folder("support", null)];
    assert.deepEqual([...folderAndDescendants(folders, "support")], ["support"]);
  });

  test("an id that is not in the list still returns itself rather than nothing", () => {
    // The list can lag a delete by one refetch; returning an empty set would
    // make the filter show every routine in the company instead of none.
    assert.deepEqual([...folderAndDescendants([], "gone")], ["gone"]);
  });

  test("terminates on a cycle instead of hanging the tab", () => {
    // The server refuses to create one; the client must not depend on that.
    const folders = [folder("a", "b"), folder("b", "a")];
    assert.deepEqual([...folderAndDescendants(folders, "a")].sort(), ["a", "b"]);
  });
});

describe("childrenByParent", () => {
  test("groups by parent and puts top-level folders under null", () => {
    const folders = [
      folder("finance", null),
      folder("month-end", "finance"),
      folder("support", null),
    ];
    const map = childrenByParent(folders);
    assert.deepEqual(
      (map.get(null) ?? []).map((f) => f.id),
      ["finance", "support"],
    );
    assert.deepEqual(
      (map.get("finance") ?? []).map((f) => f.id),
      ["month-end"],
    );
  });

  test("preserves the order the server returned", () => {
    const folders = [folder("b", null), folder("a", null), folder("c", null)];
    assert.deepEqual(
      (childrenByParent(folders).get(null) ?? []).map((f) => f.id),
      ["b", "a", "c"],
    );
  });

  test("an orphan surfaces at the top level rather than disappearing", () => {
    const folders = [folder("orphan", "vanished"), folder("root", null)];
    assert.deepEqual(
      (childrenByParent(folders).get(null) ?? []).map((f) => f.id).sort(),
      ["orphan", "root"],
    );
  });
});
