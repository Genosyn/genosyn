import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { DecisionPolicyRule } from "./api.js";
import {
  DELETED_EMPLOYEE_LABEL,
  hasRetiredRoutingRules,
  routingRuleLabel,
} from "./decisionRouting.js";

/**
 * How the Routing modal reads each decision rule. Every rule names its
 * decider; the one rule shape no one can create any more — "their manager",
 * from the removed reporting lines — must still read as what it now does.
 */

const employees = new Map([
  ["ada", { name: "Ada" }],
  ["meredith", { name: "Meredith" }],
]);

function rule(over: Partial<DecisionPolicyRule> = {}): DecisionPolicyRule {
  return {
    id: "rule",
    askingEmployeeId: null,
    deciderKind: "employee",
    deciderEmployeeId: "meredith",
    sortOrder: 0,
    enabled: true,
    createdAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

describe("routingRuleLabel", () => {
  test("a rule for any employee names its decider", () => {
    assert.deepEqual(routingRuleLabel(rule(), employees), {
      asking: "Any employee",
      decider: "Meredith",
      retired: false,
    });
  });

  test("a rule for one employee names both", () => {
    assert.deepEqual(routingRuleLabel(rule({ askingEmployeeId: "ada" }), employees), {
      asking: "Ada",
      decider: "Meredith",
      retired: false,
    });
  });

  test("an employee deleted since the rule was saved reads as deleted, on either side", () => {
    assert.deepEqual(
      routingRuleLabel(
        rule({ askingEmployeeId: "gone", deciderEmployeeId: "also-gone" }),
        employees,
      ),
      { asking: DELETED_EMPLOYEE_LABEL, decider: DELETED_EMPLOYEE_LABEL, retired: false },
    );
    assert.equal(
      routingRuleLabel(rule({ deciderEmployeeId: null }), employees).decider,
      DELETED_EMPLOYEE_LABEL,
    );
  });

  test("a retired manager rule reads as paging people, whoever it was for", () => {
    for (const askingEmployeeId of [null, "ada", "gone"]) {
      const label = routingRuleLabel(
        rule({ askingEmployeeId, deciderKind: "manager", deciderEmployeeId: null }),
        employees,
      );
      assert.equal(label.decider, "people");
      assert.equal(label.retired, true);
    }
    assert.equal(
      routingRuleLabel(rule({ deciderKind: "manager", askingEmployeeId: "ada" }), employees).asking,
      "Ada",
    );
  });

  test("a retired manager rule never borrows a decider left on its row", () => {
    const label = routingRuleLabel(
      rule({ deciderKind: "manager", deciderEmployeeId: "meredith" }),
      employees,
    );
    assert.deepEqual(label, { asking: "Any employee", decider: "people", retired: true });
  });
});

describe("hasRetiredRoutingRules", () => {
  test("is false with no rules, or only named-employee rules", () => {
    assert.equal(hasRetiredRoutingRules([]), false);
    assert.equal(hasRetiredRoutingRules([rule(), rule({ askingEmployeeId: "ada" })]), false);
  });

  test("is true as soon as one retired manager rule is listed, enabled or not", () => {
    assert.equal(hasRetiredRoutingRules([rule(), rule({ deciderKind: "manager" })]), true);
    assert.equal(hasRetiredRoutingRules([rule({ deciderKind: "manager", enabled: false })]), true);
  });
});
