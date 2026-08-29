import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";

import { parseSubscription, verifyStripeSignature } from "./stripe.js";

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
