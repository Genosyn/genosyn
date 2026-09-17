import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  evaluateFormula,
  getFormulaReferences,
  validateFormula,
  type ExploreFormula,
} from "../../shared/exploreFormula.js";

describe("Explore formula arithmetic", () => {
  test("sums widget values and respects precedence, parentheses, and unary signs", () => {
    assert.equal(evaluateFormula("A + B + C", { A: 100, B: 40, C: 10 }), 150);
    assert.equal(evaluateFormula("(A - B) / A * 100", { A: 200, B: 150 }), 25);
    assert.equal(evaluateFormula("-A + B * +2 - -(4 / 2)", { A: 10, B: 3 }), -2);
    assert.equal(evaluateFormula("12 / 2 / 3", {}), 2);
    assert.equal(evaluateFormula("5 - 2 - 1", {}), 2);
    assert.equal(evaluateFormula(".5 + 1.25 + 2. + 1e-2", {}), 3.76);
  });

  test("supports nested aggregate functions and case-sensitive widget names", () => {
    assert.equal(
      evaluateFormula("sum(A, B, avg(10, 20), MIN(4, 2), Max(3, 8))", { A: 10, B: 5 }),
      40,
    );
    assert.equal(evaluateFormula("AVG(A, B)", { A: 1e308, B: 1e308 }), 1e308);
    assert.equal(evaluateFormula("Revenue - revenue", { Revenue: 10, revenue: 2 }), 8);
    assert.deepEqual(getFormulaReferences("SUM(A, B, A, -net_revenue / 100)"), [
      "A",
      "B",
      "net_revenue",
    ]);
    assert.deepEqual(getFormulaReferences("10 * (2 + 3)"), []);
  });

  test("shows unavailable, nonnumeric, zero-divisor, and overflow errors", () => {
    assert.throws(() => evaluateFormula("A + B", { A: 1 }), /Input "B" has no value/);
    for (const value of [NaN, Infinity, -Infinity, "4", null]) {
      assert.throws(() => evaluateFormula("A", { A: value as number }), /finite number/);
    }
    for (const divisor of [0, -0]) {
      assert.throws(() => evaluateFormula("A / B", { A: 1, B: divisor }), /divide by zero/);
    }
    assert.throws(() => evaluateFormula("A * B", { A: 1e308, B: 2 }), /finite number/);
    assert.throws(() => evaluateFormula("SUM(A, B)", { A: 1e308, B: 1e308 }), /finite number/);
  });

  test("does not evaluate code, properties, or inherited record values", () => {
    for (const expression of [
      "A.value",
      "A[0]",
      "A = 5",
      "(() => 1)()",
      "Math.max(A, 1)",
      "A;1",
      "__proto__",
      "constructor()",
    ]) {
      assert.throws(() => evaluateFormula(expression, { A: 1 }), Error, expression);
    }
    const inherited = Object.create({ A: 8 }) as Record<string, number>;
    assert.throws(() => evaluateFormula("A", inherited), /has no value/);
    assert.throws(() => evaluateFormula("constructor", {}), /has no value/);
    assert.throws(() => evaluateFormula("toString", {}), /has no value/);
    assert.equal(evaluateFormula("A", Object.assign(Object.create(null), { A: 8 })), 8);
  });
});

describe("Explore formula validation", () => {
  const formula: ExploreFormula = {
    expression: "A / B",
    inputs: [
      { name: "A", cardId: "revenue" },
      { name: "B", cardId: "cost" },
    ],
    prefix: "$",
    suffix: " per sale",
  };

  test("validates syntax without requiring values or evaluating divisions", () => {
    assert.doesNotThrow(() => validateFormula(formula));
    assert.deepEqual(getFormulaReferences("A / (B - B)"), ["A", "B"]);
    assert.doesNotThrow(() => validateFormula({ ...formula, expression: "A / (B - B)" }));
    assert.doesNotThrow(() => validateFormula({ expression: "1 / 0", inputs: [] }));
    assert.throws(() => evaluateFormula("A / (B - B)", { A: 1, B: 5 }), /divide by zero/);
  });

  test("rejects partial expressions, misplaced commas, and unsupported functions", () => {
    for (const expression of [
      "",
      " ",
      "A +",
      "(A + B",
      "A + B)",
      "SUM()",
      "SUM(A,)",
      "SUM(,A)",
      "SUM(A B)",
      "A,B",
      "2A",
      "1..2",
      "2 ** 3",
      "MEDIAN(A, B)",
    ]) {
      assert.throws(() => getFormulaReferences(expression), Error, expression);
    }
    assert.throws(() => getFormulaReferences("1e999"), /finite/);
  });

  test("requires unique, valid input names and an exact widget mapping", () => {
    assert.throws(
      () => validateFormula({ ...formula, inputs: [{ name: "A", cardId: "revenue" }] }),
      /input "B"/,
    );
    assert.throws(() => validateFormula({ ...formula, expression: "A" }), /"B" is not used/);
    assert.throws(
      () => validateFormula({ ...formula, inputs: [formula.inputs[0], formula.inputs[0]] }),
      /more than once/,
    );
    assert.throws(
      () => validateFormula({ ...formula, inputs: [{ name: "A", cardId: "" }] }),
      /Choose a widget/,
    );
    for (const name of ["1A", "A.B", "__proto__", "constructor", "prototype", "A".repeat(33)]) {
      assert.throws(
        () => validateFormula({ expression: "1", inputs: [{ name, cardId: "revenue" }] }),
        /Input names/,
      );
    }
    assert.throws(() => validateFormula({ ...formula, prefix: "$".repeat(33) }), /prefix/);
    assert.throws(() => validateFormula({ ...formula, suffix: "x".repeat(33) }), /suffix/);
  });

  test("bounds expression length, token count, nesting, and input count", () => {
    assert.throws(() => getFormulaReferences("A".repeat(2001)), /characters/);
    assert.throws(() => getFormulaReferences(Array(258).fill("1").join("+")), /too complex/);
    assert.throws(() => getFormulaReferences("(".repeat(33) + "1" + ")".repeat(33)), /nest/);
    assert.throws(() => getFormulaReferences("-".repeat(33) + "1"), /nest/);
    assert.throws(() => getFormulaReferences("SUM(".repeat(33) + "1" + ")".repeat(33)), /nest/);
    assert.throws(
      () => validateFormula({ expression: "1", inputs: Array(33).fill(formula.inputs[0]) }),
      /32 formula inputs/,
    );
  });
});
