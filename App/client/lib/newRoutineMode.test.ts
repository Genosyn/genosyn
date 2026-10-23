import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { newRoutinePath } from "./newItemPath.js";
import { DESCRIBE_PARAM, newRoutineMode, withNewRoutineMode } from "./newRoutineMode.js";
import { PALETTE_SUBPAGES, subpageAt } from "./subpages.js";

/**
 * New routine opens on the form. Only an address that asks for the box with
 * `?describe=1` opens it, and only while an AI Employee can be asked; the
 * employee and folder a list was narrowed to never change the view and survive
 * switching between the two.
 */

const at = (search: string) => new URLSearchParams(search);
/** The query of a path such as `/c/acme/routines/new?folder=ops`. */
const queryOf = (path: string) => at(path.includes("?") ? path.slice(path.indexOf("?")) : "");

describe("newRoutineMode", () => {
  test("a plain New routine opens the form", () => {
    assert.equal(newRoutineMode(at(""), true), "form");
    assert.equal(newRoutineMode(at("?"), true), "form");
  });

  test("presets open the form too: the employee, the folder, or both", () => {
    for (const search of [
      "?employee=sam",
      "?folder=ops",
      "?folder=ops&employee=sam",
      "?employee=sam&folder=ops",
      "?folder=q4+%26+beyond&employee=a%2Fb",
    ]) {
      assert.equal(newRoutineMode(at(search), true), "form", search);
    }
  });

  test("an explicit ?describe=1 opens the box, with or without presets", () => {
    for (const search of [
      "?describe=1",
      "?employee=sam&describe=1",
      "?describe=1&folder=ops",
      "?folder=ops&describe=1&employee=sam",
    ]) {
      assert.equal(newRoutineMode(at(search), true), "describe", search);
    }
  });

  test("only the value 1 asks for the box", () => {
    for (const search of [
      "?describe",
      "?describe=",
      "?describe=0",
      "?describe=true",
      "?describe=yes",
      "?describe=describe",
      "?describe=%201",
      "?Describe=1",
      "?DESCRIBE=1",
      "?mode=describe",
      "?view=describe",
    ]) {
      assert.equal(newRoutineMode(at(search), true), "form", search);
    }
  });

  test("with nobody able to answer, the form opens whatever the address asks", () => {
    for (const search of [
      "",
      "?describe=1",
      "?employee=sam&describe=1",
      "?folder=ops&describe=1",
    ]) {
      assert.equal(newRoutineMode(at(search), false), "form", search);
    }
  });

  test("names the parameter the page writes", () => {
    assert.equal(DESCRIBE_PARAM, "describe");
  });
});

describe("withNewRoutineMode", () => {
  test("Describe it instead writes describe=1 and keeps the presets", () => {
    assert.equal(withNewRoutineMode(at(""), "describe").toString(), "describe=1");
    assert.equal(
      withNewRoutineMode(at("?folder=ops&employee=sam"), "describe").toString(),
      "folder=ops&employee=sam&describe=1",
    );
  });

  test("Back to the form drops describe and nothing else", () => {
    assert.equal(withNewRoutineMode(at("?describe=1"), "form").toString(), "");
    assert.equal(
      withNewRoutineMode(at("?folder=ops&describe=1&employee=sam"), "form").toString(),
      "folder=ops&employee=sam",
    );
  });

  test("Back to the form also clears a describe that never asked for the box", () => {
    assert.equal(
      withNewRoutineMode(at("?describe=0&employee=sam"), "form").toString(),
      "employee=sam",
    );
  });

  test("switching to where the page already is changes nothing", () => {
    assert.equal(
      withNewRoutineMode(at("?employee=sam&describe=1"), "describe").toString(),
      "employee=sam&describe=1",
    );
    assert.equal(withNewRoutineMode(at("?employee=sam"), "form").toString(), "employee=sam");
  });

  test("a stray describe value is replaced rather than repeated", () => {
    assert.equal(withNewRoutineMode(at("?describe=0"), "describe").toString(), "describe=1");
    assert.equal(
      withNewRoutineMode(at("?describe=0&describe=yes"), "describe").toString(),
      "describe=1",
    );
  });

  test("to the box and back returns the address the form opened on", () => {
    for (const search of [
      "",
      "?employee=sam",
      "?folder=ops",
      "?folder=ops&employee=sam",
      "?folder=q4+%26+beyond&employee=a%2Fb",
    ]) {
      const there = withNewRoutineMode(at(search), "describe");
      const back = withNewRoutineMode(there, "form");
      assert.equal(back.toString(), at(search).toString(), search);
    }
  });

  test("encoded presets come through the switch exactly", () => {
    const there = withNewRoutineMode(at("?folder=q4+%26+beyond&employee=a%2Fb"), "describe");
    assert.equal(there.get("folder"), "q4 & beyond");
    assert.equal(there.get("employee"), "a/b");
  });

  test("the address it switched to opens the view it switched to", () => {
    for (const mode of ["form", "describe"] as const) {
      for (const search of ["", "?employee=sam", "?folder=ops&describe=1"]) {
        assert.equal(newRoutineMode(withNewRoutineMode(at(search), mode), true), mode, search);
      }
    }
  });

  test("never changes the address it was handed", () => {
    const current = at("?folder=ops&employee=sam");
    withNewRoutineMode(current, "describe");
    assert.equal(current.toString(), "folder=ops&employee=sam");
    const describing = at("?describe=1&employee=sam");
    withNewRoutineMode(describing, "form");
    assert.equal(describing.toString(), "describe=1&employee=sam");
  });
});

describe("every New routine button opens the form", () => {
  test("from the Routines list, a folder, one employee's routines, or both", () => {
    for (const from of [
      {},
      { folder: "ops" },
      { employee: "sam" },
      { folder: "ops", employee: "sam" },
      { folder: null, employee: null },
    ]) {
      const path = newRoutinePath("acme", from);
      assert.equal(newRoutineMode(queryOf(path), true), "form", path);
      assert.ok(!path.includes(DESCRIBE_PARAM), `${path} never asks for the box`);
    }
  });

  test("from the ⌘K palette", () => {
    const entries = PALETTE_SUBPAGES.filter((page) => page.path.startsWith("/routines/new"));
    assert.deepEqual(
      entries.map((page) => page.path),
      ["/routines/new"],
      "one palette entry, and it is the form",
    );
    for (const page of entries) assert.equal(newRoutineMode(queryOf(page.path), true), "form");
    assert.equal(subpageAt("/routines/new").label, "New routine");
  });
});
