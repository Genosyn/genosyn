import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ResourceAccessLevel, ResourceLibraryAccessRow } from "./api.js";
import {
  DEFAULT_RESOURCE_LIBRARY_LEVEL,
  RESOURCE_LIBRARY_LEVELS,
  effectiveResourceAccess,
  isShareGrantPaused,
  replaceResourceLibraryRow,
  resourceLibraryLevelLabel,
  resourceLibraryLevelsById,
  summarizeResourceLibraryAccess,
  withResourceLibraryAccess,
} from "./resourceAiAccess.js";

function row(
  id: string,
  accessLevel: "read" | "write" = "write",
  isDefault = accessLevel === "write",
): ResourceLibraryAccessRow {
  return {
    employee: { id, name: id.toUpperCase(), slug: id, role: "Role", avatarKey: null },
    accessLevel,
    isDefault,
  };
}

const SHARE_LEVELS: ResourceAccessLevel[] = ["read", "edit", "delete"];

describe("RESOURCE_LIBRARY_LEVELS", () => {
  test("lists read only before read + write, with read + write as the default", () => {
    assert.deepEqual(
      RESOURCE_LIBRARY_LEVELS.map((level) => [level.value, level.label]),
      [
        ["read", "Read only"],
        ["write", "Read + write"],
      ],
    );
    assert.equal(DEFAULT_RESOURCE_LIBRARY_LEVEL, "write");
  });

  test("every level explains itself", () => {
    for (const level of RESOURCE_LIBRARY_LEVELS) {
      assert.ok(level.tagline.length > 0);
      assert.ok(level.hint.length > 40, `${level.value} needs a real explanation`);
    }
    assert.match(RESOURCE_LIBRARY_LEVELS[0].hint, /whatever a Resource's Share settings say/);
    assert.match(RESOURCE_LIBRARY_LEVELS[1].hint, /Share settings allow/);
  });

  test("labels resolve by value", () => {
    assert.equal(resourceLibraryLevelLabel("read"), "Read only");
    assert.equal(resourceLibraryLevelLabel("write"), "Read + write");
  });
});

describe("effectiveResourceAccess", () => {
  test("read + write leaves every Share level as it is", () => {
    for (const level of SHARE_LEVELS) assert.equal(effectiveResourceAccess("write", level), level);
  });

  test("read only caps every Share level at view", () => {
    for (const level of SHARE_LEVELS) assert.equal(effectiveResourceAccess("read", level), "read");
  });
});

describe("isShareGrantPaused", () => {
  test("only an edit or delete grant under read only is paused", () => {
    assert.equal(isShareGrantPaused("read", "read"), false);
    assert.equal(isShareGrantPaused("read", "edit"), true);
    assert.equal(isShareGrantPaused("read", "delete"), true);
    for (const level of SHARE_LEVELS) assert.equal(isShareGrantPaused("write", level), false);
  });

  test("an employee whose level has not loaded is never reported as paused", () => {
    for (const level of SHARE_LEVELS) assert.equal(isShareGrantPaused(undefined, level), false);
  });
});

describe("resourceLibraryLevelsById", () => {
  test("maps each employee to its level", () => {
    const levels = resourceLibraryLevelsById([row("ada", "read"), row("bob")]);
    assert.equal(levels.get("ada"), "read");
    assert.equal(levels.get("bob"), "write");
    assert.equal(levels.get("someone-else"), undefined);
  });
});

describe("withResourceLibraryAccess", () => {
  test("moves one employee and leaves the rest, without mutating the input", () => {
    const rows = [row("ada"), row("bob")];
    const snapshot = structuredClone(rows);
    const next = withResourceLibraryAccess(rows, "ada", "read");
    assert.deepEqual(next, [row("ada", "read", false), row("bob")]);
    assert.notEqual(next, rows);
    assert.equal(next[1], rows[1], "untouched rows keep their identity");
    assert.deepEqual(rows, snapshot);
  });

  test("a level the employee already holds returns the same list", () => {
    const rows = [row("ada"), row("bob", "read")];
    assert.equal(withResourceLibraryAccess(rows, "ada", "write"), rows);
    assert.equal(withResourceLibraryAccess(rows, "bob", "read"), rows);
  });

  test("an unknown employee returns the same list", () => {
    const rows = [row("ada")];
    assert.equal(withResourceLibraryAccess(rows, "zed", "read"), rows);
  });

  test("a moved employee is no longer at the default, even when moved back", () => {
    const narrowed = withResourceLibraryAccess([row("ada")], "ada", "read");
    const restored = withResourceLibraryAccess(narrowed, "ada", "write");
    assert.equal(restored[0].accessLevel, "write");
    assert.equal(restored[0].isDefault, false);
  });
});

describe("replaceResourceLibraryRow", () => {
  test("puts the server's copy in place of the optimistic one", () => {
    const optimistic = withResourceLibraryAccess([row("ada"), row("bob")], "bob", "write");
    const saved = row("ada", "read", false);
    assert.deepEqual(replaceResourceLibraryRow(optimistic, saved), [saved, row("bob")]);
  });

  test("restores the original row on rollback", () => {
    const original = row("ada");
    const optimistic = withResourceLibraryAccess([original], "ada", "read");
    assert.deepEqual(replaceResourceLibraryRow(optimistic, original), [original]);
  });

  test("ignores a row for an employee no longer listed", () => {
    const rows = [row("ada")];
    assert.equal(replaceResourceLibraryRow(rows, row("gone", "read")), rows);
  });
});

describe("summarizeResourceLibraryAccess", () => {
  test("says nothing for an empty roster", () => {
    assert.equal(summarizeResourceLibraryAccess([]), "");
  });

  test("names the whole roster when nobody is narrowed", () => {
    assert.equal(summarizeResourceLibraryAccess([row("ada")]), "Read + write");
    assert.equal(summarizeResourceLibraryAccess([row("ada"), row("bob")]), "All 2 read + write");
  });

  test("counts the read-only employees otherwise", () => {
    assert.equal(
      summarizeResourceLibraryAccess([row("ada", "read"), row("bob"), row("cy", "read")]),
      "2 of 3 read only",
    );
    assert.equal(summarizeResourceLibraryAccess([row("ada", "read")]), "1 of 1 read only");
  });
});
