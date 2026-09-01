import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ANNUAL_DISCOUNT,
  PLANS,
  isBillingInterval,
  planForPriceId,
  priceIdFor,
  unitAmountFor,
  type BillingPriceIds,
} from "./plans.js";

/**
 * The Plan constants are what an operator's Stripe prices must match, so the
 * arithmetic behind them is worth pinning: the annual amounts are written out
 * by hand, and nothing else in the codebase would notice if one drifted.
 */

const IDS: BillingPriceIds = {
  growthMonthlyPriceId: "price_gm",
  growthAnnualPriceId: "price_ga",
  scaleMonthlyPriceId: "price_sm",
  scaleAnnualPriceId: "price_sa",
};

describe("plan pricing", () => {
  test("every annual amount is twelve months less the advertised discount", () => {
    for (const plan of ["free", "growth", "scale"] as const) {
      const monthly = PLANS[plan].monthlyUnitAmount;
      const expected = Math.round(monthly * 12 * (1 - ANNUAL_DISCOUNT));
      assert.equal(
        PLANS[plan].annualUnitAmount,
        expected,
        `${plan}: annual amount drifted from ${(ANNUAL_DISCOUNT * 100).toFixed(0)}% off twelve months`,
      );
    }
  });

  test("the amounts are whole cents, so no price rounds off inside Stripe", () => {
    for (const plan of ["free", "growth", "scale"] as const) {
      assert.ok(Number.isInteger(PLANS[plan].monthlyUnitAmount));
      assert.ok(Number.isInteger(PLANS[plan].annualUnitAmount));
    }
  });

  test("the published numbers are what the marketing site quotes", () => {
    assert.equal(PLANS.growth.monthlyUnitAmount, 1900);
    assert.equal(PLANS.growth.annualUnitAmount, 20520);
    assert.equal(PLANS.scale.monthlyUnitAmount, 4900);
    assert.equal(PLANS.scale.annualUnitAmount, 52920);
  });

  test("unitAmountFor picks the amount for the interval", () => {
    assert.equal(unitAmountFor("growth", "month"), 1900);
    assert.equal(unitAmountFor("growth", "year"), 20520);
    assert.equal(unitAmountFor("free", "year"), 0);
  });
});

describe("priceIdFor", () => {
  test("maps each paid plan and interval to its configured id", () => {
    assert.equal(priceIdFor(IDS, "growth", "month"), "price_gm");
    assert.equal(priceIdFor(IDS, "growth", "year"), "price_ga");
    assert.equal(priceIdFor(IDS, "scale", "month"), "price_sm");
    assert.equal(priceIdFor(IDS, "scale", "year"), "price_sa");
  });

  test("returns blank for an interval the operator never configured", () => {
    assert.equal(priceIdFor({ ...IDS, scaleAnnualPriceId: "" }, "scale", "year"), "");
  });
});

describe("planForPriceId", () => {
  test("resolves both the plan and the interval", () => {
    assert.deepEqual(planForPriceId(IDS, "price_ga"), { plan: "growth", interval: "year" });
    assert.deepEqual(planForPriceId(IDS, "price_sm"), { plan: "scale", interval: "month" });
  });

  test("an unknown price is null, so the caller can keep the row's plan", () => {
    assert.equal(planForPriceId(IDS, "price_rotated"), null);
  });

  // Blank ids are the default on an install that only sells monthly. If a
  // blank matched a blank, an item carrying no price would resolve to a plan.
  test("a blank price never matches a blank configured id", () => {
    assert.equal(planForPriceId({ ...IDS, growthAnnualPriceId: "" }, ""), null);
  });
});

describe("isBillingInterval", () => {
  test("accepts only Stripe's two recurring intervals we sell on", () => {
    assert.equal(isBillingInterval("month"), true);
    assert.equal(isBillingInterval("year"), true);
    assert.equal(isBillingInterval("week"), false);
    assert.equal(isBillingInterval(""), false);
  });
});
