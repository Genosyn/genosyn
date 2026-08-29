/**
 * The Genosyn Cloud Plans (M56). Frozen constants — the client renders the
 * same numbers from the billing endpoint's `prices` block, and the Stripe
 * price ids an operator configures at Admin → Billing are expected to carry
 * these unit amounts.
 *
 * `null` limits mean unlimited. Feature keys are exhaustive for this
 * milestone: `sso`, `auditLog`.
 */
export type PlanId = "free" | "growth" | "scale";

export const PLANS = {
  free: {
    name: "Free",
    unitAmount: 0,
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
    unitAmount: 1900,
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
    unitAmount: 4900,
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

/** Which Plan a Stripe price id sells, per the operator's Admin → Billing
 * configuration; null for a price this install doesn't know. */
export function planForPriceId(
  settings: { growthPriceId: string; scalePriceId: string },
  priceId: string,
): PlanId | null {
  if (!priceId) return null;
  if (priceId === settings.growthPriceId) return "growth";
  if (priceId === settings.scalePriceId) return "scale";
  return null;
}
