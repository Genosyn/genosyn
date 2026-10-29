import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  financeProductPath,
  matchesFinanceProduct,
} from "../../shared/financeProducts.js";

describe("Finance product search", () => {
  const product = {
    name: "Starter plan",
    description: "Monthly plan for small teams",
  };

  test("matches every word across the name and description, in any order", () => {
    assert.equal(matchesFinanceProduct(product, "starter"), true);
    assert.equal(matchesFinanceProduct(product, "small teams"), true);
    assert.equal(matchesFinanceProduct(product, "plan teams monthly"), true);
    assert.equal(matchesFinanceProduct(product, "starter annual"), false);
  });

  test("ignores case and surrounding or repeated whitespace", () => {
    assert.equal(matchesFinanceProduct(product, "  STARTER   PLAN  "), true);
    assert.equal(matchesFinanceProduct(product, ""), true, "a blank query lists everything");
    assert.equal(matchesFinanceProduct(product, "   "), true);
  });

  test("treats a missing description as empty, not as a reason to fail", () => {
    assert.equal(matchesFinanceProduct({ name: "Setup fee" }, "setup"), true);
    assert.equal(matchesFinanceProduct({ name: "Setup fee", description: null }, "fee"), true);
    assert.equal(matchesFinanceProduct({ name: "Setup fee", description: null }, "monthly"), false);
  });

  test("opens the catalogue filtered to the exact product name", () => {
    assert.equal(
      financeProductPath("Starter plan"),
      "/finance/products?q=Starter%20plan",
    );
    assert.equal(
      financeProductPath("Plan/Bundle & support"),
      "/finance/products?q=Plan%2FBundle%20%26%20support",
    );
  });
});
