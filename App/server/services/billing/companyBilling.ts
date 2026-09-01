import { In } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { CompanyBilling } from "../../db/entities/CompanyBilling.js";
import { Routine } from "../../db/entities/Routine.js";
import { getCompanyEntitlements } from "../entitlements.js";
import {
  billingEnabled,
  getBillingSettings,
  getStripeSecrets,
} from "./billingSettings.js";
import {
  PLANS,
  isBillingInterval,
  planForPriceId,
  type BillingInterval,
  type BillingPriceIds,
} from "./plans.js";
import {
  StripeApiError,
  getSubscription,
  listSubscriptions,
  parseSubscription,
  updateSubscriptionQuantity,
  type StripeSubscription,
} from "./stripe.js";

/**
 * Company billing lifecycle (M56) — the row that mirrors one company's Stripe
 * subscription, updated from three directions that must agree: the webhook,
 * `POST /billing/sync`, and the best-effort seat sync on hire/fire. All three
 * funnel through {@link applySubscriptionState} so plan/status/seat state is
 * written in exactly one place.
 */

/** Subscription statuses under which the company is still paying (or Stripe
 * is still retrying the charge) — the mirror of the entitlements resolver's
 * active set. A subscription in one of these states must be switched or
 * canceled, never silently duplicated. */
export const ACTIVE_SUBSCRIPTION_STATUSES: readonly string[] = [
  "active",
  "trialing",
  "past_due",
];

export async function getOrCreateBillingRow(companyId: string): Promise<CompanyBilling> {
  const repo = AppDataSource.getRepository(CompanyBilling);
  const existing = await repo.findOneBy({ companyId });
  if (existing) return existing;
  return repo.save(repo.create({ companyId, plan: "free" }));
}

/** What one Plan costs on one interval, and whether this install can sell it. */
export type PlanPrice = { unitAmount: number; configured: boolean };

export type BillingSummary = {
  enabled: boolean;
  plan: "free" | "growth" | "scale";
  /** Which interval the live subscription bills on; null on Free. */
  interval: BillingInterval | null;
  status: string | null;
  seatCount: number | null;
  aiEmployeeCount: number;
  routineCount: number;
  currentPeriodEnd: string | null;
  limits: {
    maxAiEmployees: number | null;
    maxRoutines: number | null;
    maxBases: number | null;
    maxBaseTables: number | null;
    maxChannels: number | null;
    maxProjects: number | null;
    maxTodos: number | null;
  };
  features: { sso: boolean; auditLog: boolean };
  prices: {
    currency: "usd";
    growth: Record<BillingInterval, PlanPrice>;
    scale: Record<BillingInterval, PlanPrice>;
  };
  stripeConfigured: boolean;
  portalAvailable: boolean;
};

export async function countCompanyAiEmployees(companyId: string): Promise<number> {
  return AppDataSource.getRepository(AIEmployee).countBy({ companyId });
}

/**
 * Which interval a billing row pays on. Rows written before annual billing
 * existed carry no value and were necessarily monthly, so that is what
 * an absent one means — the summary and the checkout guard must agree on this
 * or a legacy monthly subscriber would be offered "switch to monthly".
 */
export function intervalOf(row: CompanyBilling | null | undefined): BillingInterval {
  return row?.billingInterval && isBillingInterval(row.billingInterval)
    ? row.billingInterval
    : "month";
}

async function countCompanyRoutines(companyId: string): Promise<number> {
  const employeeIds = (
    await AppDataSource.getRepository(AIEmployee).find({
      where: { companyId },
      select: { id: true },
    })
  ).map((e) => e.id);
  return employeeIds.length
    ? AppDataSource.getRepository(Routine).countBy({ employeeId: In(employeeIds) })
    : 0;
}

/** Build the frozen `GET /billing` response shape. */
export async function billingSummary(companyId: string): Promise<BillingSummary> {
  const [enabled, settings, secrets, entitlements, row, aiEmployeeCount, routineCount] =
    await Promise.all([
      billingEnabled(),
      getBillingSettings(),
      getStripeSecrets(),
      getCompanyEntitlements(companyId),
      AppDataSource.getRepository(CompanyBilling).findOneBy({ companyId }),
      countCompanyAiEmployees(companyId),
      countCompanyRoutines(companyId),
    ]);
  const plan = entitlements.plan ?? "free";
  return {
    enabled,
    plan,
    // Free is not billed on any interval, so it reports none even when a
    // lapsed row still carries the value from the plan the company used to
    // pay for. A paid row with no stored interval predates annual billing and
    // was therefore monthly — the same reading the checkout guard takes.
    interval: plan === "free" ? null : intervalOf(row),
    status: row?.status ?? null,
    seatCount: row?.seatCount ?? null,
    aiEmployeeCount,
    routineCount,
    currentPeriodEnd: row?.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : null,
    limits: {
      maxAiEmployees: entitlements.maxAiEmployees,
      maxRoutines: entitlements.maxRoutines,
      maxBases: entitlements.maxBases,
      maxBaseTables: entitlements.maxBaseTables,
      maxChannels: entitlements.maxChannels,
      maxProjects: entitlements.maxProjects,
      maxTodos: entitlements.maxTodos,
    },
    features: { ...entitlements.features },
    prices: {
      currency: "usd",
      growth: {
        month: {
          unitAmount: PLANS.growth.monthlyUnitAmount,
          configured: Boolean(settings.growthMonthlyPriceId),
        },
        year: {
          unitAmount: PLANS.growth.annualUnitAmount,
          configured: Boolean(settings.growthAnnualPriceId),
        },
      },
      scale: {
        month: {
          unitAmount: PLANS.scale.monthlyUnitAmount,
          configured: Boolean(settings.scaleMonthlyPriceId),
        },
        year: {
          unitAmount: PLANS.scale.annualUnitAmount,
          configured: Boolean(settings.scaleAnnualPriceId),
        },
      },
    },
    // Monthly is the floor: an install that cannot sell monthly cannot sell
    // anything. Annual is reported per plan above and offered when present.
    stripeConfigured: Boolean(
      secrets.secretKey && settings.growthMonthlyPriceId && settings.scaleMonthlyPriceId,
    ),
    portalAvailable: Boolean(row?.stripeCustomerId),
  };
}

/**
 * Upsert the local row from a subscription's current state. The plan and the
 * billing interval both come from the price id (per the operator's configured
 * price ids), the seat count from the item quantity. `customerId`, when known,
 * rides along so a checkout completed by webhook also records the customer for
 * the portal.
 */
export async function applySubscriptionState(
  companyId: string,
  sub: StripeSubscription,
  settings: BillingPriceIds,
  customerId?: string | null,
): Promise<CompanyBilling> {
  const repo = AppDataSource.getRepository(CompanyBilling);
  const row = await getOrCreateBillingRow(companyId);
  const item = sub.items[0];
  const sold = item ? planForPriceId(settings, item.priceId) : null;
  if (item && sold === null) {
    // The subscription bills a price this install no longer knows — most
    // likely the operator rotated a price id at Admin → Billing. Keep the
    // row's current plan and interval instead of silently downgrading a
    // paying subscriber to Free entitlements.
    // eslint-disable-next-line no-console
    console.warn(
      `[billing] subscription ${sub.id} for company ${companyId} carries price ${item.priceId}, which matches none of the configured price ids — keeping plan "${row.plan}". Were the price ids rotated at Admin → Billing?`,
    );
  } else {
    row.plan = sold?.plan ?? "free";
    row.billingInterval = sold?.interval ?? null;
  }
  row.status = sub.status || null;
  row.stripeSubscriptionId = sub.id || null;
  row.stripeSubscriptionItemId = item?.id ?? null;
  row.seatCount = item ? item.quantity : null;
  row.currentPeriodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd * 1000) : null;
  if (customerId) row.stripeCustomerId = customerId;
  return repo.save(row);
}

/** Record the Stripe customer minted for a company at first checkout. */
export async function setStripeCustomerId(
  companyId: string,
  customerId: string,
): Promise<void> {
  const row = await getOrCreateBillingRow(companyId);
  row.stripeCustomerId = customerId;
  await AppDataSource.getRepository(CompanyBilling).save(row);
}

const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
]);

/**
 * Apply one verified webhook event. Every branch re-fetches the subscription
 * from the API before applying it: Stripe does not guarantee delivery order
 * and retries failed deliveries, so the snapshot embedded in a subscription
 * event may be stale — a retried "active" arriving after "deleted" must not
 * resurrect a canceled subscription. The embedded object is trusted only to
 * name the subscription id and the company (its `metadata.companyId`); a
 * fetch failure throws so the webhook route 500s and Stripe retries. Events
 * without a `companyId` in the subscription metadata are ignored — they are
 * not this install's subscriptions.
 */
export async function handleWebhookEvent(event: {
  type: string;
  data?: { object?: Record<string, unknown> };
}): Promise<{ handled: boolean }> {
  if (!HANDLED_EVENTS.has(event.type)) return { handled: false };
  const object = event.data?.object ?? {};
  const settings = await getBillingSettings();

  let sub: StripeSubscription;
  let companyId: string;
  const customerId = typeof object.customer === "string" ? object.customer : null;
  if (event.type === "checkout.session.completed") {
    const subscriptionId =
      typeof object.subscription === "string" ? object.subscription : null;
    if (!subscriptionId) return { handled: false };
    const { secretKey } = await getStripeSecrets();
    if (!secretKey) return { handled: false };
    sub = await getSubscription(secretKey, subscriptionId);
    companyId = sub.metadata.companyId;
  } else {
    const embedded = parseSubscription(object);
    companyId = embedded.metadata.companyId;
    if (!embedded.id || !companyId) return { handled: false };
    const { secretKey } = await getStripeSecrets();
    if (!secretKey) return { handled: false };
    sub = await getSubscription(secretKey, embedded.id);
  }

  if (!companyId) return { handled: false };
  await applySubscriptionState(companyId, sub, settings, customerId);
  return { handled: true };
}

/**
 * Best-effort: push the company's AI Employee count into the subscription
 * item quantity after a hire or fire. Never throws and never blocks the
 * mutation that triggered it — Stripe being down must not stop a hire; the
 * webhook and `POST /billing/sync` will reconcile later.
 */
export async function syncSeatCount(companyId: string): Promise<void> {
  try {
    if (!(await billingEnabled())) return;
    const row = await AppDataSource.getRepository(CompanyBilling).findOneBy({ companyId });
    if (!row?.stripeSubscriptionId || !row.stripeSubscriptionItemId) return;
    if (!row.status || !ACTIVE_SUBSCRIPTION_STATUSES.includes(row.status)) return;
    const { secretKey } = await getStripeSecrets();
    if (!secretKey) return;
    const quantity = Math.max(1, await countCompanyAiEmployees(companyId));
    if (row.seatCount === quantity) return;
    await updateSubscriptionQuantity(secretKey, {
      subscriptionId: row.stripeSubscriptionId,
      itemId: row.stripeSubscriptionItemId,
      quantity,
    });
    // Targeted write of the seat count only. Saving the full entity here
    // would persist plan/status as read BEFORE the (up to 15s) Stripe call,
    // clobbering any webhook write that landed in between — e.g. reverting a
    // cancellation back to "active".
    await AppDataSource.getRepository(CompanyBilling).update(
      { id: row.id },
      { seatCount: quantity },
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[billing] seat sync failed for company ${companyId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Re-fetch the subscription from Stripe and reconcile the local row — the
 * escape hatch when a webhook was missed (or has not landed yet). When the
 * row knows its Stripe customer but not yet a subscription — a first checkout
 * whose webhook is still in flight — the customer's subscriptions are listed
 * and the newest live one is adopted, so `?checkout=success` reconciles and a
 * duplicate checkout cannot mint a second subscription. No-op (returns the
 * summary as-is) when the company has never touched Stripe.
 */
export async function syncFromStripe(companyId: string): Promise<BillingSummary> {
  const row = await AppDataSource.getRepository(CompanyBilling).findOneBy({ companyId });
  if (row?.stripeSubscriptionId || row?.stripeCustomerId) {
    const { secretKey } = await getStripeSecrets();
    if (secretKey) {
      const settings = await getBillingSettings();
      let sub: StripeSubscription | null = null;
      if (row.stripeSubscriptionId) {
        try {
          sub = await getSubscription(secretKey, row.stripeSubscriptionId);
        } catch (err) {
          // A 404 means the stored subscription no longer exists at Stripe —
          // fall through to adopting whatever the customer actually has.
          if (!(err instanceof StripeApiError) || err.status !== 404) throw err;
        }
      }
      if (!sub && row.stripeCustomerId) {
        const subscriptions = await listSubscriptions(secretKey, row.stripeCustomerId);
        // Stripe lists newest first — adopt the newest live subscription.
        sub =
          subscriptions.find((s) => ACTIVE_SUBSCRIPTION_STATUSES.includes(s.status)) ?? null;
      }
      if (sub) await applySubscriptionState(companyId, sub, settings);
    }
  }
  return billingSummary(companyId);
}
