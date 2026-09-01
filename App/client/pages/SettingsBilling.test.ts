import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { BillingInterval, BillingSummary, PlanId } from "../lib/api.js";
import { annualOffered, planCardState } from "./SettingsBilling.js";

/**
 * The plan cards on Settings → Billing, tested as data.
 *
 * The subtlety worth pinning is what "current" means once a Plan sells on two
 * intervals. Before annual existed the card compared Plan alone, so a Growth
 * subscriber looking at the annual prices saw Growth marked "Current plan"
 * with no button — the upgrade path to annual simply did not exist in the UI.
 * Every case below is a variation on that question.
 */

type Prices = BillingSummary["prices"];
type Summary = Pick<BillingSummary, "plan" | "interval" | "prices" | "stripeConfigured">;

function prices(overrides: { growthYear?: boolean; scaleYear?: boolean } = {}): Prices {
  return {
    currency: "usd",
    growth: {
      month: { unitAmount: 1900, configured: true },
      year: { unitAmount: 20520, configured: overrides.growthYear ?? true },
    },
    scale: {
      month: { unitAmount: 4900, configured: true },
      year: { unitAmount: 52920, configured: overrides.scaleYear ?? true },
    },
  };
}

function summary(
  plan: PlanId,
  interval: BillingInterval | null,
  overrides: Partial<Summary> = {},
): Summary {
  return {
    plan,
    interval,
    prices: prices(),
    stripeConfigured: true,
    ...overrides,
  };
}

describe("annualOffered", () => {
  test("is true when either paid plan has an annual price configured", () => {
    assert.equal(annualOffered(prices()), true);
    assert.equal(annualOffered(prices({ scaleYear: false })), true);
    assert.equal(annualOffered(prices({ growthYear: false })), true);
  });

  test("is false when the operator configured no annual prices at all", () => {
    assert.equal(annualOffered(prices({ growthYear: false, scaleYear: false })), false);
  });
});

describe("planCardState — which card reads as current", () => {
  test("a monthly subscriber viewing monthly sees their own plan as current", () => {
    const state = planCardState(summary("growth", "month"), "growth", "month");
    assert.equal(state.current, true);
    assert.equal(state.samePlan, true);
  });

  // The regression this feature exists to fix.
  test("a monthly subscriber viewing annual is offered the switch, not told they have it", () => {
    const state = planCardState(summary("growth", "month"), "growth", "year");
    assert.equal(state.current, false, "annual is a different thing from what they pay for");
    assert.equal(state.samePlan, true);
    assert.equal(state.label, "Switch to annual billing");
    assert.equal(state.available, true);
  });

  test("an annual subscriber viewing monthly is offered the way back", () => {
    const state = planCardState(summary("scale", "year"), "scale", "month");
    assert.equal(state.current, false);
    assert.equal(state.label, "Switch to monthly billing");
  });

  test("an annual subscriber viewing annual sees their own plan as current", () => {
    assert.equal(planCardState(summary("scale", "year"), "scale", "year").current, true);
  });

  test("Free is current on either interval, having no billing period of its own", () => {
    for (const interval of ["month", "year"] as const) {
      const state = planCardState(summary("free", null), "free", interval);
      assert.equal(state.current, true, interval);
      assert.equal(state.price, "$0");
    }
  });
});

describe("planCardState — the button it offers", () => {
  test("a higher tier is an upgrade, a lower tier a switch", () => {
    const free = summary("free", null);
    assert.deepEqual(
      ["growth", "scale"].map((p) => planCardState(free, p as PlanId, "month").label),
      ["Upgrade to Growth", "Upgrade to Scale"],
    );

    const scale = summary("scale", "month");
    assert.equal(planCardState(scale, "growth", "month").label, "Switch to Growth");
    assert.equal(planCardState(scale, "growth", "month").upgrade, false);
  });

  test("changing tier keeps naming the tier even when the interval also changes", () => {
    // Growth monthly → Scale annual is one move; the card names the tier,
    // because that is the bigger of the two changes being made.
    const state = planCardState(summary("growth", "month"), "scale", "year");
    assert.equal(state.label, "Upgrade to Scale");
    assert.equal(state.samePlan, false);
  });
});

describe("planCardState — what it costs", () => {
  test("quotes the amount for the interval being viewed", () => {
    const free = summary("free", null);
    assert.equal(planCardState(free, "growth", "month").price, "$19");
    assert.equal(planCardState(free, "growth", "year").price, "$205.20");
    assert.equal(planCardState(free, "scale", "month").price, "$49");
    assert.equal(planCardState(free, "scale", "year").price, "$529.20");
  });

  test("annual also carries the per-month figure people actually compare", () => {
    const free = summary("free", null);
    assert.equal(planCardState(free, "growth", "year").perMonth, "$17.10");
    assert.equal(planCardState(free, "scale", "year").perMonth, "$44.10");
  });

  test("monthly has no per-month subline to add", () => {
    assert.equal(planCardState(summary("free", null), "growth", "month").perMonth, null);
  });

  test("the per-month figure is below the monthly price, or the discount is a lie", () => {
    const free = summary("free", null);
    for (const plan of ["growth", "scale"] as const) {
      const monthly = planCardState(free, plan, "month").price;
      const perMonth = planCardState(free, plan, "year").perMonth;
      assert.ok(perMonth);
      assert.ok(
        Number(perMonth.slice(1)) < Number(monthly.slice(1)),
        `${plan}: annual works out dearer than monthly`,
      );
    }
  });
});

describe("planCardState — what this install can actually sell", () => {
  test("an unconfigured annual price leaves that card unavailable", () => {
    const s = summary("free", null, { prices: prices({ scaleYear: false }) });
    assert.equal(planCardState(s, "scale", "year").available, false);
    assert.equal(planCardState(s, "scale", "month").available, true, "monthly still sells");
    assert.equal(planCardState(s, "growth", "year").available, true, "the other plan is fine");
  });

  test("nothing is available while Stripe is half-configured", () => {
    const s = summary("free", null, { stripeConfigured: false });
    for (const plan of ["growth", "scale"] as const) {
      for (const interval of ["month", "year"] as const) {
        assert.equal(planCardState(s, plan, interval).available, false, `${plan}/${interval}`);
      }
    }
  });

  test("the prices are still quoted even when they cannot be bought", () => {
    const s = summary("free", null, {
      stripeConfigured: false,
      prices: prices({ growthYear: false, scaleYear: false }),
    });
    assert.equal(planCardState(s, "growth", "year").price, "$205.20");
  });
});
