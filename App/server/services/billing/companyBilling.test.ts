import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AppSetting } from "../../db/entities/AppSetting.js";
import { CompanyBilling } from "../../db/entities/CompanyBilling.js";
import { encryptSecret } from "../../lib/secret.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
} from "../../test/dbHarness.js";
import {
  BILLING_SETTING_KEY,
  invalidateBillingSettingsCache,
} from "./billingSettings.js";
import {
  applySubscriptionState,
  intervalOf,
  syncFromStripe,
  syncSeatCount,
} from "./companyBilling.js";
import { parseSubscription } from "./stripe.js";

/**
 * The billing lifecycle against a real database and a captured `fetch`:
 * unknown price ids never downgrade a paying row, the seat sync writes only
 * the seat count (so a concurrent webhook write survives), and the manual
 * sync can adopt a first subscription the webhook has not delivered yet.
 */

const SETTINGS = {
  growthMonthlyPriceId: "price_growth",
  growthAnnualPriceId: "price_growth_year",
  scaleMonthlyPriceId: "price_scale",
  scaleAnnualPriceId: "price_scale_year",
};

// Selective mock: api.stripe.com is answered by `stripeHandler`; anything
// else passes through to the real fetch.
const originalFetch = globalThis.fetch;
type StripeCall = { method: string; url: string; body: string };
let stripeCalls: StripeCall[] = [];
let stripeHandler: (call: StripeCall) => Promise<Response> | Response = () =>
  new Response(JSON.stringify({}), { status: 200 });

function installStripeFetchMock(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.stripe.com/")) {
      const call: StripeCall = {
        method: init?.method ?? "GET",
        url,
        body: init?.body ? String(init.body) : "",
      };
      stripeCalls.push(call);
      return stripeHandler(call);
    }
    return originalFetch(input as RequestInfo, init);
  }) as typeof fetch;
}

function rawSubscription(
  companyId: string,
  overrides: Partial<{
    id: string;
    status: string;
    quantity: number;
    priceId: string;
  }> = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? "sub_1",
    object: "subscription",
    status: overrides.status ?? "active",
    current_period_end: 1_900_000_000,
    items: {
      data: [
        {
          id: "si_1",
          price: { id: overrides.priceId ?? "price_growth" },
          quantity: overrides.quantity ?? 2,
        },
      ],
    },
    metadata: { companyId },
  };
}

async function configureBilling(): Promise<void> {
  await insert(AppSetting, {
    key: BILLING_SETTING_KEY,
    value: JSON.stringify({
      enabled: true,
      ...SETTINGS,
      encryptedSecretKey: encryptSecret("sk_test_service"),
      encryptedWebhookSecret: "",
    }),
  });
  invalidateBillingSettingsCache();
}

before(initTestDb);
after(async () => {
  globalThis.fetch = originalFetch;
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  stripeCalls = [];
  stripeHandler = () => new Response(JSON.stringify({}), { status: 200 });
  installStripeFetchMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("applySubscriptionState", () => {
  test("an unrecognized price id keeps the row's existing plan instead of downgrading to free", async () => {
    const cid = testCompanyId();
    await applySubscriptionState(
      cid,
      parseSubscription(rawSubscription(cid)),
      SETTINGS,
      "cus_1",
    );
    let row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: cid,
    });
    assert.equal(row.plan, "growth");

    // The operator rotates the Growth price id at Admin → Billing; the next
    // event for the existing subscription carries the now-unknown old price.
    await applySubscriptionState(
      cid,
      parseSubscription(rawSubscription(cid, { quantity: 5 })),
      { ...SETTINGS, growthMonthlyPriceId: "price_growth_v2" },
    );
    row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: cid,
    });
    assert.equal(row.plan, "growth", "paying subscriber must not drop to free");
    assert.equal(row.status, "active");
    assert.equal(row.seatCount, 5, "the rest of the state still applies");
  });

  test("an annual price records the year interval, and switching back records month", async () => {
    const cid = testCompanyId();
    const repo = AppDataSource.getRepository(CompanyBilling);

    await applySubscriptionState(
      cid,
      parseSubscription(rawSubscription(cid, { priceId: SETTINGS.scaleAnnualPriceId })),
      SETTINGS,
      "cus_1",
    );
    let row = await repo.findOneByOrFail({ companyId: cid });
    assert.equal(row.plan, "scale");
    assert.equal(row.billingInterval, "year");

    // The company moves back to monthly: the interval must follow the price,
    // not linger from the subscription it used to be on.
    await applySubscriptionState(
      cid,
      parseSubscription(rawSubscription(cid, { priceId: SETTINGS.scaleMonthlyPriceId })),
      SETTINGS,
    );
    row = await repo.findOneByOrFail({ companyId: cid });
    assert.equal(row.plan, "scale");
    assert.equal(row.billingInterval, "month");
  });

  test("cancelling clears the interval along with the plan", async () => {
    const cid = testCompanyId();
    const repo = AppDataSource.getRepository(CompanyBilling);
    await applySubscriptionState(
      cid,
      parseSubscription(rawSubscription(cid, { priceId: SETTINGS.growthAnnualPriceId })),
      SETTINGS,
    );
    assert.equal((await repo.findOneByOrFail({ companyId: cid })).billingInterval, "year");

    await applySubscriptionState(
      cid,
      parseSubscription({ id: "sub_1", status: "canceled" }),
      SETTINGS,
    );
    const row = await repo.findOneByOrFail({ companyId: cid });
    assert.equal(row.plan, "free");
    assert.equal(row.billingInterval, null);
  });

  test("a subscription without items still lands on free", async () => {
    const cid = testCompanyId();
    await applySubscriptionState(
      cid,
      parseSubscription({ id: "sub_1", status: "canceled" }),
      SETTINGS,
    );
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: cid,
    });
    assert.equal(row.plan, "free");
    assert.equal(row.status, "canceled");
  });
});

describe("intervalOf", () => {
  // The whole point of this helper: a subscriber from before annual billing
  // existed has no stored interval, and reading that as anything but monthly
  // would offer them a "switch to monthly billing" they are already on.
  test("reads a row written before annual billing as monthly", () => {
    assert.equal(intervalOf({ billingInterval: null } as never), "month");
    assert.equal(intervalOf({ billingInterval: "" } as never), "month");
    assert.equal(intervalOf(null), "month");
    assert.equal(intervalOf({ billingInterval: "quarter" } as never), "month");
    assert.equal(intervalOf({ billingInterval: "year" } as never), "year");
  });
});

describe("syncSeatCount", () => {
  test("writes only the seat count, so a webhook landing mid-call is not clobbered", async () => {
    const cid = testCompanyId();
    await configureBilling();
    const repo = AppDataSource.getRepository(CompanyBilling);
    const row = await insert(CompanyBilling, {
      companyId: cid,
      plan: "growth",
      status: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionItemId: "si_1",
      seatCount: 5,
    });

    // While the Stripe quantity update is in flight, the cancellation webhook
    // commits status/plan changes to the same row.
    stripeHandler = async () => {
      await repo.update({ id: row.id }, { status: "canceled", plan: "free" });
      return new Response(JSON.stringify(rawSubscription(cid, { quantity: 1 })), {
        status: 200,
      });
    };

    await syncSeatCount(cid);

    const updated = await repo.findOneByOrFail({ id: row.id });
    assert.equal(updated.seatCount, 1, "the seat count was pushed");
    assert.equal(updated.status, "canceled", "the concurrent webhook write survives");
    assert.equal(updated.plan, "free", "the concurrent webhook write survives");
  });
});

describe("annual subscriptions in the rest of the lifecycle", () => {
  test("seats still resync on an annual subscription — a year is not a lock", async () => {
    const cid = testCompanyId();
    await configureBilling();
    const repo = AppDataSource.getRepository(CompanyBilling);
    await insert(CompanyBilling, {
      companyId: cid,
      plan: "growth",
      billingInterval: "year",
      status: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      stripeSubscriptionItemId: "si_1",
      seatCount: 2,
    });
    // Two AI Employees on the row, none in the database — the sync should push
    // the floor of one seat rather than leaving the stale count.
    stripeHandler = () =>
      new Response(
        JSON.stringify(
          rawSubscription(cid, { priceId: SETTINGS.growthAnnualPriceId, quantity: 1 }),
        ),
        { status: 200 },
      );

    await syncSeatCount(cid);

    const updated = await repo.findOneByOrFail({ companyId: cid });
    assert.equal(updated.seatCount, 1);
    assert.equal(updated.billingInterval, "year", "the interval is untouched by a seat push");
    const post = stripeCalls.find((c) => c.method === "POST");
    assert.ok(post);
    assert.equal(new URLSearchParams(post.body).get("proration_behavior"), "create_prorations");
  });

  test("an adopted annual subscription brings its interval with it", async () => {
    const cid = testCompanyId();
    await configureBilling();
    await insert(CompanyBilling, { companyId: cid, plan: "free", stripeCustomerId: "cus_1" });
    stripeHandler = (call) => {
      if (call.url.includes("customer=cus_1")) {
        return new Response(
          JSON.stringify({
            data: [rawSubscription(cid, { priceId: SETTINGS.scaleAnnualPriceId })],
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected Stripe call: ${call.method} ${call.url}`);
    };

    const summary = await syncFromStripe(cid);

    assert.equal(summary.plan, "scale");
    assert.equal(summary.interval, "year");
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: cid,
    });
    assert.equal(row.billingInterval, "year");
  });
});

describe("syncFromStripe", () => {
  test("adopts the newest live subscription when the row only knows its customer", async () => {
    const cid = testCompanyId();
    await configureBilling();
    await insert(CompanyBilling, {
      companyId: cid,
      plan: "free",
      stripeCustomerId: "cus_1",
    });
    stripeHandler = (call) => {
      assert.match(call.url, /\/v1\/subscriptions\?customer=cus_1&status=all&limit=10$/);
      return new Response(
        JSON.stringify({
          data: [
            rawSubscription(cid, { id: "sub_new", status: "active", quantity: 3 }),
            rawSubscription(cid, { id: "sub_old", status: "canceled" }),
          ],
        }),
        { status: 200 },
      );
    };

    const summary = await syncFromStripe(cid);

    assert.equal(summary.plan, "growth");
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: cid,
    });
    assert.equal(row.stripeSubscriptionId, "sub_new");
    assert.equal(row.status, "active");
    assert.equal(row.seatCount, 3);
  });

  test("a 404 on the stored subscription falls back to adopting from the customer's list", async () => {
    const cid = testCompanyId();
    await configureBilling();
    await insert(CompanyBilling, {
      companyId: cid,
      plan: "growth",
      status: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_gone",
      stripeSubscriptionItemId: "si_0",
    });
    stripeHandler = (call) => {
      if (call.url.includes("/v1/subscriptions/sub_gone")) {
        return new Response(
          JSON.stringify({ error: { message: "No such subscription" } }),
          { status: 404 },
        );
      }
      return new Response(
        JSON.stringify({
          data: [rawSubscription(cid, { id: "sub_new", priceId: "price_scale" })],
        }),
        { status: 200 },
      );
    };

    const summary = await syncFromStripe(cid);

    assert.equal(summary.plan, "scale");
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: cid,
    });
    assert.equal(row.stripeSubscriptionId, "sub_new");
  });

  test("a customer with no live subscription stays on free", async () => {
    const cid = testCompanyId();
    await configureBilling();
    await insert(CompanyBilling, {
      companyId: cid,
      plan: "free",
      stripeCustomerId: "cus_1",
    });
    stripeHandler = () =>
      new Response(
        JSON.stringify({ data: [rawSubscription(cid, { status: "canceled" })] }),
        { status: 200 },
      );

    const summary = await syncFromStripe(cid);

    assert.equal(summary.plan, "free");
    const row = await AppDataSource.getRepository(CompanyBilling).findOneByOrFail({
      companyId: cid,
    });
    assert.equal(row.stripeSubscriptionId, null);
  });

  test("a company that never touched Stripe makes no Stripe call at all", async () => {
    const cid = testCompanyId();
    await configureBilling();
    const summary = await syncFromStripe(cid);
    assert.equal(summary.plan, "free");
    assert.equal(stripeCalls.length, 0);
  });
});
