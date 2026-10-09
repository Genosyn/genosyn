import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { newRoutinePath, newSkillPath } from "./newItemPath.js";

/**
 * "New routine" and "New skill" carry the folder and employee the list was
 * narrowed to, so the form opens with them picked rather than on the first
 * employee in the roster.
 */

describe("newRoutinePath", () => {
  test("a plain list creates with nothing picked", () => {
    assert.equal(newRoutinePath("acme"), "/c/acme/routines/new");
    assert.equal(newRoutinePath("acme", { folder: null, employee: null }), "/c/acme/routines/new");
  });

  test("an employee's routines keep that employee", () => {
    assert.equal(
      newRoutinePath("acme", { employee: "alex" }),
      "/c/acme/routines/new?employee=alex",
    );
  });

  test("a folder keeps the folder, and both travel together", () => {
    assert.equal(newRoutinePath("acme", { folder: "sales" }), "/c/acme/routines/new?folder=sales");
    assert.equal(
      newRoutinePath("acme", { folder: "sales", employee: "alex" }),
      "/c/acme/routines/new?folder=sales&employee=alex",
    );
  });

  test("values are encoded, never spliced into the path", () => {
    assert.equal(
      newRoutinePath("acme", { folder: "q4 & beyond", employee: "a/b" }),
      "/c/acme/routines/new?folder=q4+%26+beyond&employee=a%2Fb",
    );
  });
});

describe("newSkillPath", () => {
  test("keeps the employee the skills list was narrowed to", () => {
    assert.equal(newSkillPath("acme"), "/c/acme/skills/new");
    assert.equal(newSkillPath("acme", { employee: "alex" }), "/c/acme/skills/new?employee=alex");
    assert.equal(newSkillPath("acme", { employee: "" }), "/c/acme/skills/new");
  });
});
