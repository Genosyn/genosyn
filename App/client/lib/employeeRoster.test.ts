import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Employee, Team } from "./api.js";
import { rosterCards } from "./employeeRoster.js";

/**
 * The Employees page's roster: a flat, alphabetical list of AI Employees with
 * their live team. It replaced an org chart, so the cases that matter are the
 * ones the chart used to decide — order, duplicates, and who is on it.
 */

function employee(id: string, name: string, over: Partial<Employee> = {}): Employee {
  return {
    id,
    companyId: "co",
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    role: "Analyst",
    ...over,
  };
}

function team(id: string, name: string, archivedAt: string | null = null): Team {
  return {
    id,
    name,
    slug: name.toLowerCase(),
    description: "",
    archivedAt,
    memberCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const names = (cards: ReturnType<typeof rosterCards>) => cards.map((card) => card.employee.name);

describe("rosterCards", () => {
  test("is empty for an empty company", () => {
    assert.deepEqual(rosterCards([], null), []);
    assert.deepEqual(rosterCards([], [team("t1", "Ops")]), []);
  });

  test("sorts by name, ignoring case and accents, whatever order the API used", () => {
    const cards = rosterCards(
      [
        employee("3", "zoë"),
        employee("1", "Bob"),
        employee("2", "Émile"),
        employee("4", "ada"),
        employee("5", "Zed"),
      ],
      null,
    );
    assert.deepEqual(names(cards), ["ada", "Bob", "Émile", "Zed", "zoë"]);
  });

  test("breaks a name tie by slug, so the order never flickers between reloads", () => {
    const forward = rosterCards(
      [employee("a", "Sam", { slug: "sam-2" }), employee("b", "Sam", { slug: "sam" })],
      null,
    );
    const backward = rosterCards(
      [employee("b", "Sam", { slug: "sam" }), employee("a", "Sam", { slug: "sam-2" })],
      null,
    );
    assert.deepEqual(
      forward.map((card) => card.employee.slug),
      ["sam", "sam-2"],
    );
    assert.deepEqual(forward, backward);
  });

  test("lists each employee once, even if the list repeats one", () => {
    const ada = employee("1", "Ada");
    assert.deepEqual(names(rosterCards([ada, employee("2", "Bo"), ada], null)), ["Ada", "Bo"]);
  });

  test("never mutates the list it was given", () => {
    const list = [employee("2", "Bo"), employee("1", "Ada")];
    const before = list.map((entry) => entry.id);
    rosterCards(list, null);
    assert.deepEqual(
      list.map((entry) => entry.id),
      before,
    );
  });

  test("badges a live team by name, and nothing for no team or an archived or unknown one", () => {
    const cards = rosterCards(
      [
        employee("1", "Ada", { teamId: "ops" }),
        employee("2", "Bo", { teamId: null }),
        employee("3", "Cy", { teamId: "old" }),
        employee("4", "Di", { teamId: "deleted" }),
        employee("5", "Ed"),
      ],
      [team("ops", "Operations"), team("old", "Legacy", "2026-09-01T00:00:00.000Z")],
    );
    assert.deepEqual(
      cards.map((card) => [card.employee.name, card.teamName]),
      [
        ["Ada", "Operations"],
        ["Bo", null],
        ["Cy", null],
        ["Di", null],
        ["Ed", null],
      ],
    );
  });

  test("shows no badges while the teams are still loading, then fills them in", () => {
    const list = [employee("1", "Ada", { teamId: "ops" })];
    assert.equal(rosterCards(list, null)[0].teamName, null);
    assert.equal(rosterCards(list, [team("ops", "Operations")])[0].teamName, "Operations");
  });

  test("carries the employee through untouched, so cards link to the right slug", () => {
    const ada = employee("1", "Ada", { slug: "ada-lovelace", avatarKey: "a.png" });
    assert.equal(rosterCards([ada], null)[0].employee, ada);
  });
});
