import crypto from "node:crypto";

/**
 * A minimal Stripe client (M56) — raw `fetch` against the REST API with
 * form-encoded bodies, no SDK. Only the calls the billing lifecycle needs,
 * each returning the narrow shape the caller reads, plus the pure
 * webhook-signature verifier.
 */

const STRIPE_API = "https://api.stripe.com";
const STRIPE_VERSION = "2024-06-20";
const REQUEST_TIMEOUT_MS = 15_000;

/** A non-2xx Stripe response, carrying Stripe's own error message. */
export class StripeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "StripeApiError";
  }
}

async function stripeRequest(
  secretKey: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: URLSearchParams,
): Promise<Record<string, unknown>> {
  const url =
    method === "GET" && params ? `${STRIPE_API}${path}?${params}` : `${STRIPE_API}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: method === "POST" ? params : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // A non-JSON body on an error status falls through to the generic message.
  }
  const body = (parsed ?? {}) as Record<string, unknown>;
  if (!response.ok) {
    const error = body.error as { message?: string } | undefined;
    throw new StripeApiError(
      error?.message || `Stripe request failed with status ${response.status}`,
      response.status,
    );
  }
  return body;
}

export async function createCustomer(
  secretKey: string,
  args: { name: string; email: string | null; companyId: string },
): Promise<string> {
  const params = new URLSearchParams();
  params.set("name", args.name);
  if (args.email) params.set("email", args.email);
  params.set("metadata[companyId]", args.companyId);
  const customer = await stripeRequest(secretKey, "POST", "/v1/customers", params);
  return String(customer.id);
}

export async function createCheckoutSession(
  secretKey: string,
  args: {
    customerId: string;
    priceId: string;
    quantity: number;
    companyId: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<{ url: string }> {
  const params = new URLSearchParams();
  params.set("mode", "subscription");
  // Stripe collects the code and validates coupon eligibility, expiry and
  // redemption limits against this company's existing customer record.
  params.set("allow_promotion_codes", "true");
  params.set("customer", args.customerId);
  params.set("line_items[0][price]", args.priceId);
  params.set("line_items[0][quantity]", String(args.quantity));
  params.set("subscription_data[metadata][companyId]", args.companyId);
  params.set("client_reference_id", args.companyId);
  params.set("success_url", args.successUrl);
  params.set("cancel_url", args.cancelUrl);
  const session = await stripeRequest(secretKey, "POST", "/v1/checkout/sessions", params);
  return { url: String(session.url) };
}

/**
 * The customer portal Genosyn opens, created through the API so an install
 * never depends on someone saving portal settings in the Stripe Dashboard.
 * Owners update cards and billing details, download invoices, and cancel at
 * period end. Plan and quantity changes stay off: Genosyn switches plans
 * itself and keeps the seat count equal to the AI Employee count. The
 * metadata marker finds the configuration again; bump its version when these
 * settings change and existing configurations are updated in place.
 */
const PORTAL_MARKER = "genosyn_portal";
const PORTAL_VERSION = "1";

function portalConfigurationParams(): URLSearchParams {
  const params = new URLSearchParams();
  params.set("features[invoice_history][enabled]", "true");
  params.set("features[payment_method_update][enabled]", "true");
  params.set("features[customer_update][enabled]", "true");
  ["email", "name", "address", "tax_id"].forEach((field, i) =>
    params.set(`features[customer_update][allowed_updates][${i}]`, field),
  );
  params.set("features[subscription_cancel][enabled]", "true");
  params.set("features[subscription_cancel][mode]", "at_period_end");
  params.set("features[subscription_update][enabled]", "false");
  params.set(`metadata[${PORTAL_MARKER}]`, PORTAL_VERSION);
  return params;
}

/** This account's active Genosyn portal configuration, preferring one at the
 * current version. */
async function findPortalConfiguration(
  secretKey: string,
): Promise<{ id: string; version: string } | null> {
  let stale: { id: string; version: string } | null = null;
  let startingAfter = "";
  for (;;) {
    const params = new URLSearchParams();
    params.set("active", "true");
    params.set("limit", "100");
    if (startingAfter) params.set("starting_after", startingAfter);
    const page = await stripeRequest(secretKey, "GET", "/v1/billing_portal/configurations", params);
    const data = Array.isArray(page.data) ? (page.data as Array<Record<string, unknown>>) : [];
    for (const configuration of data) {
      const version = (configuration.metadata as Record<string, unknown> | undefined)?.[
        PORTAL_MARKER
      ];
      if (typeof version !== "string") continue;
      const found = { id: String(configuration.id), version };
      if (version === PORTAL_VERSION) return found;
      stale ??= found;
    }
    if (page.has_more !== true || data.length === 0) return stale;
    startingAfter = String(data[data.length - 1].id);
  }
}

async function ensurePortalConfiguration(secretKey: string): Promise<string> {
  const existing = await findPortalConfiguration(secretKey);
  if (existing?.version === PORTAL_VERSION) return existing.id;
  const path = existing
    ? `/v1/billing_portal/configurations/${encodeURIComponent(existing.id)}`
    : "/v1/billing_portal/configurations";
  const configuration = await stripeRequest(secretKey, "POST", path, portalConfigurationParams());
  return String(configuration.id);
}

/** Configuration ids per Stripe account, keyed by a hash of its secret key. */
const portalConfigurations = new Map<string, Promise<string | null>>();

function portalCacheKey(secretKey: string): string {
  return crypto.createHash("sha256").update(secretKey).digest("hex");
}

/**
 * The configuration to open the portal with. Null — the account's Dashboard
 * default — when Stripe refuses to list or create one, e.g. for a restricted
 * key without portal configuration access; not cached, so the next open tries
 * again.
 */
function portalConfigurationFor(secretKey: string): Promise<string | null> {
  const key = portalCacheKey(secretKey);
  const cached = portalConfigurations.get(key);
  if (cached) return cached;
  const pending: Promise<string | null> = ensurePortalConfiguration(secretKey).catch((err) => {
    if (portalConfigurations.get(key) === pending) portalConfigurations.delete(key);
    if (!(err instanceof StripeApiError)) throw err;
    // eslint-disable-next-line no-console
    console.warn(
      `[billing] could not set up the Stripe customer portal configuration, using the account default: ${err.message}`,
    );
    return null;
  });
  portalConfigurations.set(key, pending);
  return pending;
}

export async function createPortalSession(
  secretKey: string,
  args: { customerId: string; returnUrl: string },
): Promise<{ url: string }> {
  const open = async (configuration: string | null): Promise<{ url: string }> => {
    const params = new URLSearchParams();
    params.set("customer", args.customerId);
    params.set("return_url", args.returnUrl);
    if (configuration) params.set("configuration", configuration);
    const session = await stripeRequest(secretKey, "POST", "/v1/billing_portal/sessions", params);
    return { url: String(session.url) };
  };
  const configuration = await portalConfigurationFor(secretKey);
  try {
    return await open(configuration);
  } catch (err) {
    if (!(err instanceof StripeApiError) || !configuration) throw err;
    // The remembered configuration may have been deactivated in the Stripe
    // Dashboard since: look it up again and retry once with its replacement.
    portalConfigurations.delete(portalCacheKey(secretKey));
    const replacement = await portalConfigurationFor(secretKey);
    if (!replacement || replacement === configuration) throw err;
    return open(replacement);
  }
}

export type StripeSubscription = {
  id: string;
  status: string;
  /** Unix seconds, or null when Stripe omitted it. */
  currentPeriodEnd: number | null;
  items: Array<{ id: string; priceId: string; quantity: number }>;
  metadata: Record<string, string>;
};

/** Narrow a raw subscription object (from the API or a webhook event) to the
 * fields the billing lifecycle reads. */
export function parseSubscription(raw: Record<string, unknown>): StripeSubscription {
  const items = raw.items as { data?: Array<Record<string, unknown>> } | undefined;
  return {
    id: String(raw.id ?? ""),
    status: String(raw.status ?? ""),
    currentPeriodEnd:
      typeof raw.current_period_end === "number" ? raw.current_period_end : null,
    items: (items?.data ?? []).map((item) => ({
      id: String(item.id ?? ""),
      priceId: String((item.price as { id?: string } | undefined)?.id ?? ""),
      quantity: typeof item.quantity === "number" ? item.quantity : 1,
    })),
    metadata:
      raw.metadata && typeof raw.metadata === "object"
        ? Object.fromEntries(
            Object.entries(raw.metadata as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v),
            ]),
          )
        : {},
  };
}

export async function getSubscription(
  secretKey: string,
  id: string,
): Promise<StripeSubscription> {
  const raw = await stripeRequest(secretKey, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
  return parseSubscription(raw);
}

/**
 * A customer's subscriptions, every status included, newest first (Stripe's
 * list ordering) — how `syncFromStripe` discovers a subscription the webhook
 * has not delivered yet.
 */
export async function listSubscriptions(
  secretKey: string,
  customerId: string,
): Promise<StripeSubscription[]> {
  const params = new URLSearchParams();
  params.set("customer", customerId);
  params.set("status", "all");
  params.set("limit", "10");
  const body = await stripeRequest(secretKey, "GET", "/v1/subscriptions", params);
  const data = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
  return data.map(parseSubscription);
}

export async function updateSubscriptionQuantity(
  secretKey: string,
  args: { subscriptionId: string; itemId: string; quantity: number },
): Promise<void> {
  const params = new URLSearchParams();
  params.set("items[0][id]", args.itemId);
  params.set("items[0][quantity]", String(args.quantity));
  params.set("proration_behavior", "create_prorations");
  await stripeRequest(
    secretKey,
    "POST",
    `/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
    params,
  );
}

/**
 * Move an existing subscription's single item to another price — a plan
 * change in place, prorated, so a paid→paid switch never creates a second
 * concurrently-billing subscription. Returns the updated subscription so the
 * caller can apply the new state locally without waiting for the webhook.
 */
export async function updateSubscriptionPlan(
  secretKey: string,
  args: {
    subscriptionId: string;
    itemId: string;
    priceId: string;
    quantity: number;
    prorationBehavior: "create_prorations";
  },
): Promise<StripeSubscription> {
  const params = new URLSearchParams();
  params.set("items[0][id]", args.itemId);
  params.set("items[0][price]", args.priceId);
  params.set("items[0][quantity]", String(args.quantity));
  params.set("proration_behavior", args.prorationBehavior);
  const raw = await stripeRequest(
    secretKey,
    "POST",
    `/v1/subscriptions/${encodeURIComponent(args.subscriptionId)}`,
    params,
  );
  return parseSubscription(raw);
}

/** Cancel a subscription immediately (DELETE /v1/subscriptions/:id). */
export async function cancelSubscription(secretKey: string, id: string): Promise<void> {
  await stripeRequest(secretKey, "DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`);
}

/**
 * Verify a `Stripe-Signature` header: `t=<unix>,v1=<hmac>,…` where the HMAC
 * is SHA-256 over `${t}.${rawBody}` keyed with the endpoint's webhook secret.
 * Pure — unit-tested directly. Rejects timestamps outside `toleranceSec` so a
 * captured request cannot be replayed later, and compares in constant time.
 */
export function verifyStripeSignature(
  rawBody: Buffer,
  header: string,
  secret: string,
  toleranceSec = 300,
): boolean {
  if (!header || !secret) return false;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest();
  for (const signature of signatures) {
    let candidate: Buffer;
    try {
      candidate = Buffer.from(signature, "hex");
    } catch {
      continue;
    }
    if (candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected)) {
      return true;
    }
  }
  return false;
}
