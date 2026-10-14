import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { goalBarFill, goalStandingLine, primaryGoal } from "./goalSummary";

const goal = (overrides: Record<string, unknown> = {}) => ({
  id: "g",
  status: "active" as const,
  parentGoalId: null as string | null,
  ...overrides,
});

describe("the Goal a company steers by", () => {
  test("is the oldest active Goal at the top of the tree", () => {
    const first = goal({ id: "first" });
    const second = goal({ id: "second" });

    assert.equal(primaryGoal([first, second]), first);
  });

  test("skips sub-goals and Goals that are no longer active", () => {
    const wanted = goal({ id: "wanted" });

    assert.equal(
      primaryGoal([
        goal({ id: "sub", parentGoalId: "wanted" }),
        goal({ id: "archived", status: "archived" }),
        goal({ id: "achieved", status: "achieved" }),
        goal({ id: "missed", status: "missed" }),
        wanted,
      ]),
      wanted,
    );
  });

  test("is nothing when the company has not written one", () => {
    assert.equal(primaryGoal([]), null);
    assert.equal(primaryGoal([goal({ status: "archived" })]), null);
  });
});

describe("where a Goal stands, in words", () => {
  test("reads progress against the target with its unit", () => {
    assert.equal(
      goalStandingLine({
        currentValue: 12,
        targetValue: 50,
        unit: "customers",
        direction: "increase_to",
      }),
      "12 of 50 customers",
    );
  });

  test("rounds long values and groups thousands", () => {
    assert.equal(
      goalStandingLine({
        currentValue: 1234.5678,
        targetValue: 2_000_000,
        unit: "$",
        direction: "increase_to",
      }),
      `${(1234.57).toLocaleString()} of ${(2_000_000).toLocaleString()} $`,
    );
  });

  test("names the target before anything has been reported", () => {
    assert.equal(
      goalStandingLine({
        currentValue: null,
        targetValue: 50,
        unit: "customers",
        direction: "increase_to",
      }),
      "Target 50 customers",
    );
    assert.equal(
      goalStandingLine({ currentValue: null, targetValue: 2, unit: "%", direction: "decrease_to" }),
      "Down to 2 %",
    );
    assert.equal(
      goalStandingLine({ currentValue: null, targetValue: 7, unit: "", direction: "increase_to" }),
      "Target 7",
    );
  });
});

describe("the progress bar", () => {
  test("fills by the Goal's progress, kept between empty and full", () => {
    assert.equal(goalBarFill({ progress: 0.25 }), 0.25);
    assert.equal(goalBarFill({ progress: 1.4 }), 1);
    assert.equal(goalBarFill({ progress: -0.2 }), 0);
  });

  test("is absent when there is no honest progress", () => {
    assert.equal(goalBarFill({ progress: null }), null);
    assert.equal(goalBarFill({ progress: Number.NaN }), null);
  });
});
