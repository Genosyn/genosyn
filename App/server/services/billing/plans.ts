/**
 * The Genosyn Cloud Plans (M56). Frozen constants — the client renders the
 * same numbers from the billing endpoint's `prices` block, and the Stripe
 * price ids an operator configures at Admin → Billing are expected to carry
 * these unit amounts.
 *
 * `null` limits mean unlimited. Feature keys are exhaustive for this
 * milestone: `sso`, `auditLog`.
 *
 * Each paid Plan sells on two billing intervals (M56): monthly, and annual at
 * ten percent off twelve months. Both amounts are written out rather than
 * derived, because these are the numbers that must match Stripe exactly —
 * `plans.test.ts` asserts the discount arithmetic still holds.
 */
export type PlanId = "free" | "growth" | "scale";

/** How a subscription is billed. Mirrors Stripe's `recurring.interval`. */
export type BillingInterval = "month" | "year";

/** Annual list price is twelve months less this fraction. */
export const ANNUAL_DISCOUNT = 0.1;

export const PLANS = {
  free: {
    name: "Free",
    monthlyUnitAmount: 0,
    annualUnitAmount: 0,
    maxAiEmployees: 1,
    maxRoutines: 2,
    maxBases: 1,
    maxBaseTables: 1,
    maxChannels: 3,
    maxProjects: 1,
    maxTodos: 20,
    features: { sso: false, auditLog: false },
  },
  growth: {
    name: "Growth",
    monthlyUnitAmount: 1900,
    annualUnitAmount: 20520,
    maxAiEmployees: null,
    maxRoutines: null,
    maxBases: null,
    maxBaseTables: null,
    maxChannels: null,
    maxProjects: null,
    maxTodos: null,
    features: { sso: false, auditLog: false },
  },
  scale: {
    name: "Scale",
    monthlyUnitAmount: 4900,
    annualUnitAmount: 52920,
    maxAiEmployees: null,
    maxRoutines: null,
    maxBases: null,
    maxBaseTables: null,
    maxChannels: null,
    maxProjects: null,
    maxTodos: null,
    features: { sso: true, auditLog: true },
  },
} as const;

export function isPlanId(value: string): value is PlanId {
  return value === "free" || value === "growth" || value === "scale";
}

export function isBillingInterval(value: string): value is BillingInterval {
  return value === "month" || value === "year";
}

/** What one seat costs per billing period on this Plan and interval. */
export function unitAmountFor(plan: PlanId, interval: BillingInterval): number {
  return interval === "year" ? PLANS[plan].annualUnitAmount : PLANS[plan].monthlyUnitAmount;
}

/**
 * The four Stripe price ids an operator configures at Admin → Billing — one
 * per paid Plan per interval. Free is never sold through Stripe (it is the
 * absence of a subscription), so it has no price id.
 */
export type BillingPriceIds = {
  growthMonthlyPriceId: string;
  growthAnnualPriceId: string;
  scaleMonthlyPriceId: string;
  scaleAnnualPriceId: string;
};

/** Which stored price id sells this Plan on this interval; "" when the
 * operator has not configured one (annual is optional). */
export function priceIdFor(
  ids: BillingPriceIds,
  plan: Exclude<PlanId, "free">,
  interval: BillingInterval,
): string {
  if (plan === "growth") {
    return interval === "year" ? ids.growthAnnualPriceId : ids.growthMonthlyPriceId;
  }
  return interval === "year" ? ids.scaleAnnualPriceId : ids.scaleMonthlyPriceId;
}

/**
 * What a Stripe price id sells, per the operator's Admin → Billing
 * configuration; null for a price this install doesn't know.
 *
 * Blank stored ids never match — an install with no annual prices configured
 * would otherwise resolve a subscription carrying an empty price id, which
 * cannot happen but would be a silent mis-classification if it did.
 */
export function planForPriceId(
  ids: BillingPriceIds,
  priceId: string,
): { plan: Exclude<PlanId, "free">; interval: BillingInterval } | null {
  if (!priceId) return null;
  if (priceId === ids.growthMonthlyPriceId) return { plan: "growth", interval: "month" };
  if (priceId === ids.growthAnnualPriceId) return { plan: "growth", interval: "year" };
  if (priceId === ids.scaleMonthlyPriceId) return { plan: "scale", interval: "month" };
  if (priceId === ids.scaleAnnualPriceId) return { plan: "scale", interval: "year" };
  return null;
}
