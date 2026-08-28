import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { diffLines } from "./revisionDiff";

describe("diffLines", () => {
  test("identical bodies are all context", () => {
    assert.deepEqual(diffLines("a\nb", "a\nb"), [
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  test("an inserted line is added without disturbing its neighbours", () => {
    assert.deepEqual(diffLines("a\nc", "a\nb\nc"), [
      { kind: "same", text: "a" },
      { kind: "added", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  test("a deleted line is removed", () => {
    assert.deepEqual(diffLines("a\nb\nc", "a\nc"), [
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "same", text: "c" },
    ]);
  });

  test("an edited line reads as the old line removed, the new one added", () => {
    assert.deepEqual(diffLines("a\nold\nc", "a\nnew\nc"), [
      { kind: "same", text: "a" },
      { kind: "removed", text: "old" },
      { kind: "added", text: "new" },
      { kind: "same", text: "c" },
    ]);
  });

  test("an empty base marks every proposed line added", () => {
    assert.deepEqual(diffLines("", "a\nb"), [
      { kind: "added", text: "a" },
      { kind: "added", text: "b" },
    ]);
  });

  test("clearing the body marks every line removed", () => {
    // A routine_criteria proposal may legitimately propose an empty body —
    // that switches the outcome check off.
    assert.deepEqual(diffLines("a\nb", ""), [
      { kind: "removed", text: "a" },
      { kind: "removed", text: "b" },
    ]);
  });

  test("two empty bodies diff to nothing", () => {
    assert.deepEqual(diffLines("", ""), []);
  });

  test("a moved block keeps the surviving common lines as context", () => {
    const rows = diffLines("a\nb\nc\nd", "c\nd\na\nb");
    assert.deepEqual(
      rows.filter((r) => r.kind === "same").map((r) => r.text),
      ["c", "d"],
    );
    assert.equal(rows.filter((r) => r.kind === "removed").length, 2);
    assert.equal(rows.filter((r) => r.kind === "added").length, 2);
  });

  test("CRLF and LF bodies compare equal", () => {
    assert.deepEqual(diffLines("a\r\nb", "a\nb"), [
      { kind: "same", text: "a" },
      { kind: "same", text: "b" },
    ]);
  });

  test("blank lines survive as rows rather than vanishing", () => {
    assert.deepEqual(diffLines("a\n\nb", "a\nb"), [
      { kind: "same", text: "a" },
      { kind: "removed", text: "" },
      { kind: "same", text: "b" },
    ]);
  });
});
