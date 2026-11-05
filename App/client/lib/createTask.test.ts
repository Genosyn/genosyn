import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { personFromValue, projectSlugFromPath, startingProjectSlug } from "./createTask.js";

describe("projectSlugFromPath", () => {
  test("reads the Project off its page, whatever follows", () => {
    assert.equal(projectSlugFromPath("/c/acme/tasks/p/engineering"), "engineering");
    assert.equal(projectSlugFromPath("/c/acme/tasks/p/engineering/"), "engineering");
    assert.equal(projectSlugFromPath("/c/acme/tasks/p/engineering/t/12"), "engineering");
  });

  test("finds none anywhere else, including Tasks' other pages", () => {
    assert.equal(projectSlugFromPath("/c/acme"), null);
    assert.equal(projectSlugFromPath("/c/acme/tasks"), null);
    assert.equal(projectSlugFromPath("/c/acme/tasks/new"), null);
    assert.equal(projectSlugFromPath("/c/acme/tasks/review"), null);
    assert.equal(projectSlugFromPath("/c/acme/finance/p/engineering"), null);
  });
});

describe("startingProjectSlug", () => {
  const projects = [{ slug: "engineering" }, { slug: "operations" }, { slug: "design" }];

  test("takes the first preference this person can file in", () => {
    assert.equal(startingProjectSlug(projects, ["operations", "design"]), "operations");
    assert.equal(startingProjectSlug(projects, [null, "design"]), "design");
  });

  test("skips a Project that is gone or view-only for the next preference", () => {
    assert.equal(startingProjectSlug(projects, ["archived", "design"]), "design");
  });

  test("falls back to the first Project with no usable preference", () => {
    assert.equal(startingProjectSlug(projects, []), "engineering");
    assert.equal(startingProjectSlug(projects, [undefined, null, "archived"]), "engineering");
  });

  test("is empty when there is nowhere to file it", () => {
    assert.equal(startingProjectSlug([], ["engineering"]), "");
  });
});

describe("personFromValue", () => {
  test("splits a picker's value into a Todo's two columns", () => {
    assert.deepEqual(personFromValue("ai:ada"), { employeeId: "ada", userId: null });
    assert.deepEqual(personFromValue("user:morgan"), { employeeId: null, userId: "morgan" });
  });

  test("nobody is an explicit null on both, not a missing field", () => {
    assert.deepEqual(personFromValue(""), { employeeId: null, userId: null });
  });
});
