import express, { Router } from "express";
import { getStripeSecrets } from "../services/billing/billingSettings.js";
import { handleWebhookEvent } from "../services/billing/companyBilling.js";
import { verifyStripeSignature } from "../services/billing/stripe.js";

/**
 * Stripe webhook receiver (M56), mounted at `POST /api/billing/stripe/webhook`
 * BEFORE the global JSON body parser and the trusted-origin/session middleware
 * (see `index.ts`) — signature verification needs the exact raw bytes, and
 * Stripe's servers send no Origin or cookie.
 *
 * The `Stripe-Signature` header (HMAC over `${t}.${rawBody}` with the
 * endpoint secret) is the sole credential. Unhandled-but-valid event types
 * are 200 `{ received: true }` so Stripe doesn't retry them forever.
 */
export const billingWebhookRouter = Router();

billingWebhookRouter.post(
  "/",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const { webhookSecret } = await getStripeSecrets();
    if (!webhookSecret) {
      return res.status(400).json({ error: "Stripe webhook secret is not configured" });
    }
    const rawBody = req.body as Buffer;
    const header = req.get("stripe-signature") ?? "";
    if (
      !Buffer.isBuffer(rawBody) ||
      !verifyStripeSignature(rawBody, header, webhookSecret)
    ) {
      return res.status(400).json({ error: "Invalid Stripe signature" });
    }
    let event: { type?: unknown; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }
    if (typeof event.type !== "string") {
      return res.status(400).json({ error: "Invalid webhook payload" });
    }
    try {
      await handleWebhookEvent({ type: event.type, data: event.data });
    } catch (err) {
      // A processing failure must surface as a non-2xx so Stripe retries.
      // eslint-disable-next-line no-console
      console.warn(
        `[billing] webhook ${event.type} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return res.status(500).json({ error: "Webhook processing failed" });
    }
    res.json({ received: true });
  },
);
