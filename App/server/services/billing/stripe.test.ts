import assert from "node:assert/strict";
import crypto from "node:crypto";
import { afterEach, describe, test } from "node:test";

import {
  StripeApiError,
  cancelSubscription,
  createPortalSession,
  listSubscriptions,
  parseSubscription,
  updateSubscriptionPlan,
  verifyStripeSignature,
} from "./stripe.js";

/** The pure webhook-signature verifier, exactly as Stripe computes it. */

const SECRET = "whsec_test_secret";

function sign(rawBody: Buffer, secret: string, timestamp: number): string {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

describe("verifyStripeSignature", () => {
  const body = Buffer.from(JSON.stringify({ type: "customer.subscription.updated" }));

  test("accepts a fresh, correctly signed payload", () => {
    const header = sign(body, SECRET, Math.floor(Date.now() / 1000));
    assert.equal(verifyStripeSignature(body, header, SECRET), true);
  });

  test("accepts extra scheme entries alongside a valid v1", () => {
    const t = Math.floor(Date.now() / 1000);
    const header = `${sign(body, SECRET, t)},v0=deadbeef`;
    assert.equal(verifyStripeSignature(body, header, SECRET), true);
  });

  test("rejects a tampered body", () => {
    const header = sign(body, SECRET, Math.floor(Date.now() / 1000));
    const tampered = Buffer.from(body.toString("utf8").replace("updated", "deleted"));
    assert.equal(verifyStripeSignature(tampered, header, SECRET), false);
  });

  test("rejects a signature made with the wrong secret", () => {
    const header = sign(body, "whsec_other", Math.floor(Date.now() / 1000));
    assert.equal(verifyStripeSignature(body, header, SECRET), false);
  });

  test("rejects a stale timestamp (replay) even when the HMAC matches it", () => {
    const stale = Math.floor(Date.now() / 1000) - 600;
    const header = sign(body, SECRET, stale);
    assert.equal(verifyStripeSignature(body, header, SECRET), false);
    // A generous tolerance may accept the same header.
    assert.equal(verifyStripeSignature(body, header, SECRET, 3600), true);
  });

  test("rejects malformed headers and missing inputs", () => {
    assert.equal(verifyStripeSignature(body, "", SECRET), false);
    assert.equal(verifyStripeSignature(body, "t=,v1=", SECRET), false);
    assert.equal(verifyStripeSignature(body, "v1=abcd", SECRET), false);
    assert.equal(verifyStripeSignature(body, "t=notanumber,v1=abcd", SECRET), false);
    assert.equal(
      verifyStripeSignature(body, sign(body, SECRET, Math.floor(Date.now() / 1000)), ""),
      false,
    );
  });
});

describe("parseSubscription", () => {
  test("narrows a raw subscription to the fields the lifecycle reads", () => {
    const sub = parseSubscription({
      id: "sub_123",
      status: "active",
      current_period_end: 1_900_000_000,
      items: {
        data: [{ id: "si_1", price: { id: "price_growth" }, quantity: 3 }],
      },
      metadata: { companyId: "co_1" },
    });
    assert.equal(sub.id, "sub_123");
    assert.equal(sub.status, "active");
    assert.equal(sub.currentPeriodEnd, 1_900_000_000);
    assert.deepEqual(sub.items, [{ id: "si_1", priceId: "price_growth", quantity: 3 }]);
    assert.equal(sub.metadata.companyId, "co_1");
  });

  test("tolerates missing items and metadata", () => {
    const sub = parseSubscription({ id: "sub_1", status: "canceled" });
    assert.deepEqual(sub.items, []);
    assert.deepEqual(sub.metadata, {});
    assert.equal(sub.currentPeriodEnd, null);
  });
});

/** The client calls that reach Stripe, against a captured `fetch`. */
describe("Stripe client calls", () => {
  const originalFetch = globalThis.fetch;
  type Captured = { method: string; url: string; body: string };
  const calls: Captured[] = [];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    calls.length = 0;
  });

  /** Answer successive requests with `responses` in order. */
  function mockStripeFetch(...responses: Array<[status: number, body: unknown]>): void {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? String(init.body) : "",
      });
      const [status, body] = responses.shift() ?? [500, { error: { message: "Unexpected" } }];
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  const rawScaleSub = {
    id: "sub_1",
    status: "active",
    current_period_end: 1_900_000_000,
    items: { data: [{ id: "si_1", price: { id: "price_scale" }, quantity: 3 }] },
    metadata: { companyId: "co_1" },
  };

  test("updateSubscriptionPlan posts the new price, quantity and proration, returning the subscription", async () => {
    mockStripeFetch([200, rawScaleSub]);
    const sub = await updateSubscriptionPlan("sk_test", {
      subscriptionId: "sub_1",
      itemId: "si_1",
      priceId: "price_scale",
      quantity: 3,
      prorationBehavior: "create_prorations",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://api.stripe.com/v1/subscriptions/sub_1");
    const params = new URLSearchParams(calls[0].body);
    assert.equal(params.get("items[0][id]"), "si_1");
    assert.equal(params.get("items[0][price]"), "price_scale");
    assert.equal(params.get("items[0][quantity]"), "3");
    assert.equal(params.get("proration_behavior"), "create_prorations");
    assert.ok(
      ![...params.keys()].some((key) => /^(discounts|coupon|promotion_code)(\[|$)/.test(key)),
      "plan and interval changes must leave existing Stripe discounts untouched",
    );
    assert.equal(sub.id, "sub_1");
    assert.deepEqual(sub.items, [{ id: "si_1", priceId: "price_scale", quantity: 3 }]);
  });

  test("cancelSubscription issues a DELETE for the subscription", async () => {
    mockStripeFetch([200, { id: "sub_1", status: "canceled" }]);
    await cancelSubscription("sk_test", "sub_1");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "DELETE");
    assert.equal(calls[0].url, "https://api.stripe.com/v1/subscriptions/sub_1");
  });

  test("listSubscriptions lists every status for the customer and parses the page", async () => {
    mockStripeFetch([200, { data: [rawScaleSub, { id: "sub_0", status: "canceled" }] }]);
    const subs = await listSubscriptions("sk_test", "cus_9");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(
      calls[0].url,
      "https://api.stripe.com/v1/subscriptions?customer=cus_9&status=all&limit=10",
    );
    assert.equal(subs.length, 2);
    assert.equal(subs[0].id, "sub_1");
    assert.equal(subs[1].status, "canceled");
  });

  test("a non-2xx response surfaces as a StripeApiError with Stripe's message", async () => {
    mockStripeFetch([404, { error: { message: "No such subscription" } }]);
    await assert.rejects(
      cancelSubscription("sk_test", "sub_gone"),
      (err: unknown) =>
        err instanceof StripeApiError &&
        err.status === 404 &&
        err.message === "No such subscription",
    );
  });

  // The portal configuration id is remembered per Stripe account (secret
  // key), so each portal test uses a key of its own.
  const portalArgs = {
    customerId: "cus_1",
    returnUrl: "https://genosyn.test/c/acme/settings/billing",
  };
  const portalSession: [number, unknown] = [200, { url: "https://billing.stripe.com/p/s_1" }];
  const listConfigurations = "https://api.stripe.com/v1/billing_portal/configurations";
  const openPortal = "https://api.stripe.com/v1/billing_portal/sessions";
  const sessionConfiguration = (index: number) =>
    new URLSearchParams(calls[index].body).get("configuration");

  test("createPortalSession finds the Genosyn configuration across pages, then remembers it", async () => {
    mockStripeFetch(
      [200, { data: [{ id: "bpc_dashboard", metadata: {} }], has_more: true }],
      [200, { data: [{ id: "bpc_genosyn", metadata: { genosyn_portal: "1" } }] }],
      portalSession,
      portalSession,
    );
    const session = await createPortalSession("sk_test_portal_reuse", portalArgs);
    assert.equal(session.url, "https://billing.stripe.com/p/s_1");
    await createPortalSession("sk_test_portal_reuse", portalArgs);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        `GET ${listConfigurations}?active=true&limit=100`,
        `GET ${listConfigurations}?active=true&limit=100&starting_after=bpc_dashboard`,
        `POST ${openPortal}`,
        `POST ${openPortal}`,
      ],
    );
    const params = new URLSearchParams(calls[2].body);
    assert.equal(params.get("customer"), "cus_1");
    assert.equal(params.get("return_url"), portalArgs.returnUrl);
    assert.equal(sessionConfiguration(2), "bpc_genosyn");
    assert.equal(sessionConfiguration(3), "bpc_genosyn");
  });

  test("createPortalSession creates the configuration when the account has none", async () => {
    mockStripeFetch([200, { data: [] }], [200, { id: "bpc_new" }], portalSession);
    await createPortalSession("sk_test_portal_create", portalArgs);
    assert.equal(calls.length, 3);
    assert.equal(`${calls[1].method} ${calls[1].url}`, `POST ${listConfigurations}`);
    const config = new URLSearchParams(calls[1].body);
    assert.equal(config.get("metadata[genosyn_portal]"), "1");
    assert.equal(config.get("features[invoice_history][enabled]"), "true");
    assert.equal(config.get("features[payment_method_update][enabled]"), "true");
    assert.equal(config.get("features[customer_update][enabled]"), "true");
    assert.equal(config.get("features[subscription_cancel][mode]"), "at_period_end");
    assert.equal(
      config.get("features[subscription_update][enabled]"),
      "false",
      "plans change in Genosyn and seats follow the AI Employee count",
    );
    assert.equal(sessionConfiguration(2), "bpc_new");
  });

  test("createPortalSession updates an older Genosyn configuration in place", async () => {
    mockStripeFetch(
      [200, { data: [{ id: "bpc_old", metadata: { genosyn_portal: "0" } }] }],
      [200, { id: "bpc_old" }],
      portalSession,
    );
    await createPortalSession("sk_test_portal_upgrade", portalArgs);
    assert.equal(`${calls[1].method} ${calls[1].url}`, `POST ${listConfigurations}/bpc_old`);
    assert.equal(new URLSearchParams(calls[1].body).get("metadata[genosyn_portal]"), "1");
    assert.equal(sessionConfiguration(2), "bpc_old");
  });

  test("createPortalSession falls back to the account default while Stripe refuses the configuration", async (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const refused: [number, unknown] = [403, { error: { message: "Key lacks permission" } }];
    mockStripeFetch(refused, portalSession, refused, portalSession);
    const session = await createPortalSession("rk_test_portal_restricted", portalArgs);
    assert.equal(session.url, "https://billing.stripe.com/p/s_1");
    await createPortalSession("rk_test_portal_restricted", portalArgs);
    assert.deepEqual(
      calls.map((call) => call.method),
      ["GET", "POST", "GET", "POST"],
      "a refusal is not remembered, so the next open tries again",
    );
    assert.equal(sessionConfiguration(1), null);
    assert.equal(sessionConfiguration(3), null);
    assert.equal(warn.mock.callCount(), 2);
  });

  test("createPortalSession replaces a remembered configuration that Stripe rejects", async () => {
    mockStripeFetch(
      [200, { data: [{ id: "bpc_gone", metadata: { genosyn_portal: "1" } }] }],
      portalSession,
      [400, { error: { message: "This configuration is inactive." } }],
      [200, { data: [] }],
      [200, { id: "bpc_fresh" }],
      portalSession,
    );
    await createPortalSession("sk_test_portal_replace", portalArgs);
    const session = await createPortalSession("sk_test_portal_replace", portalArgs);
    assert.equal(session.url, "https://billing.stripe.com/p/s_1");
    assert.equal(calls.length, 6);
    assert.equal(sessionConfiguration(2), "bpc_gone");
    assert.equal(sessionConfiguration(5), "bpc_fresh");
  });

  test("createPortalSession surfaces Stripe's error when the configuration is still current", async () => {
    const current: [number, unknown] = [
      200,
      { data: [{ id: "bpc_1", metadata: { genosyn_portal: "1" } }] },
    ];
    mockStripeFetch(current, [400, { error: { message: "No such customer" } }], current);
    await assert.rejects(
      createPortalSession("sk_test_portal_customer_gone", portalArgs),
      (err: unknown) => err instanceof StripeApiError && err.message === "No such customer",
    );
    assert.equal(calls.length, 3, "retries only with a different configuration");
  });
});
