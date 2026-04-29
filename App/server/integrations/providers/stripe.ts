import type { IntegrationProvider } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * Stripe — API-key integration. Users paste a restricted API key (read-only
 * is plenty for the MVP tools). We call https://api.stripe.com/v1/account on
 * create to validate the key and capture the account id/name for the hint.
 *
 * No SDK dependency — Stripe's REST API is form-encoded and trivial to hit
 * with `fetch`. If we later need more exotic endpoints (e.g. async-iterable
 * lists), dropping `stripe` in becomes a local change.
 */

const STRIPE_API = "https://api.stripe.com/v1";

type StripeConfig = {
  apiKey: string;
  accountId?: string;
  accountName?: string;
};

async function stripeGet(
  apiKey: string,
  path: string,
  params?: Record<string, string | number>,
): Promise<unknown> {
  const qs = params
    ? "?" +
      Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const res = await fetch(`${STRIPE_API}${path}${qs}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg =
      (parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error: { message?: string } }).error?.message === "string"
        ? (parsed as { error: { message: string } }).error.message
        : null) ?? `Stripe ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

export const stripeProvider: IntegrationProvider = {
  catalog: {
    provider: "stripe",
    name: "Stripe",
    category: "Payments",
    tagline: "Customers, subscriptions, charges, balance.",
    description:
      "Connect a Stripe account so AI employees can answer revenue questions and look up customers or subscriptions. Uses a restricted API key — create one at dashboard.stripe.com/apikeys and grant read access to Customers, Subscriptions, Charges, and Balance.",
    icon: "CreditCard",
    authMode: "apikey",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        placeholder: "sk_live_… or rk_live_…",
        required: true,
        hint: "Use a restricted key with read-only scopes where possible.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_customers",
      description:
        "List customers, most recent first. Returns up to `limit` rows (default 20).",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "Max rows to return (1-100).",
          },
          email: {
            type: "string",
            description: "Filter to customers with this exact email.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "retrieve_customer",
      description: "Fetch one customer by id, including their default payment method.",
      inputSchema: {
        type: "object",
        properties: {
          customerId: {
            type: "string",
            description: "Stripe customer id (cus_…).",
          },
        },
        required: ["customerId"],
        additionalProperties: false,
      },
    },
    {
      name: "list_subscriptions",
      description:
        "List active subscriptions, most recent first. Pass `customerId` to scope to one customer.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          customerId: { type: "string" },
          status: {
            type: "string",
            enum: ["all", "active", "past_due", "canceled", "trialing", "unpaid"],
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "list_charges",
      description: "List charges, most recent first. Useful for revenue spot-checks.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          customerId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_balance",
      description:
        "Return the current platform balance (available + pending) across currencies.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const apiKey = (input.apiKey ?? "").trim();
    if (!apiKey) throw new Error("API key is required");
    const account = (await stripeGet(apiKey, "/account")) as {
      id?: string;
      business_profile?: { name?: string };
      email?: string;
      settings?: { dashboard?: { display_name?: string } };
    };
    const name =
      account?.settings?.dashboard?.display_name ??
      account?.business_profile?.name ??
      account?.email ??
      account?.id ??
      "Stripe account";
    const config: StripeConfig = {
      apiKey,
      accountId: account?.id,
      accountName: name,
    };
    const hint = `${name} · ${maskSecret(apiKey)}`;
    return { config, accountHint: hint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as StripeConfig;
    try {
      await stripeGet(cfg.apiKey, "/account");
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as StripeConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "list_customers": {
        const params: Record<string, string | number> = {
          limit: clampInt(a.limit, 1, 100, 20),
        };
        if (typeof a.email === "string" && a.email.trim())
          params["email"] = a.email.trim();
        return stripeGet(cfg.apiKey, "/customers", params);
      }
      case "retrieve_customer": {
        if (typeof a.customerId !== "string" || !a.customerId.trim())
          throw new Error("customerId is required");
        return stripeGet(cfg.apiKey, `/customers/${encodeURIComponent(a.customerId)}`);
      }
      case "list_subscriptions": {
        const params: Record<string, string | number> = {
          limit: clampInt(a.limit, 1, 100, 20),
        };
        if (typeof a.customerId === "string" && a.customerId.trim())
          params["customer"] = a.customerId.trim();
        if (typeof a.status === "string" && a.status.trim())
          params["status"] = a.status.trim();
        return stripeGet(cfg.apiKey, "/subscriptions", params);
      }
      case "list_charges": {
        const params: Record<string, string | number> = {
          limit: clampInt(a.limit, 1, 100, 20),
        };
        if (typeof a.customerId === "string" && a.customerId.trim())
          params["customer"] = a.customerId.trim();
        return stripeGet(cfg.apiKey, "/charges", params);
      }
      case "get_balance":
        return stripeGet(cfg.apiKey, "/balance");
      default:
        throw new Error(`Unknown Stripe tool: ${name}`);
    }
  },
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}
