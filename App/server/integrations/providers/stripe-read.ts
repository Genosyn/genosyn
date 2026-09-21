import { z } from "zod";

/** The same continuation and time window work for every Stripe list we expose. */
export const STRIPE_LIST_PROPERTIES = {
  limit: { type: "integer", minimum: 1, maximum: 100, description: "Rows per page (default 20)." },
  startingAfter: {
    type: "string",
    description: "Pass nextStartingAfter from the previous page, keeping all filters unchanged.",
  },
  createdGte: { type: "integer", minimum: 0, description: "Inclusive creation time, Unix seconds." },
  createdLt: { type: "integer", minimum: 0, description: "Exclusive creation time, Unix seconds." },
  compact: {
    type: "boolean",
    description: "Default true: concise financial fields, without metadata or large nested objects. False returns full Stripe rows.",
  },
} as const;

const listOptions = z.object({
  startingAfter: z.string().trim().min(1).max(255).optional(),
  createdGte: z.number().int().nonnegative().safe().optional(),
  createdLt: z.number().int().nonnegative().safe().optional(),
  compact: z.boolean().optional(),
}).refine((v) => v.createdGte === undefined || v.createdLt === undefined || v.createdGte < v.createdLt, {
  message: "createdGte must be earlier than createdLt",
});

export function stripeListOptions(args: Record<string, unknown>): {
  params: Record<string, string | number>;
  compact: boolean;
} {
  const options = listOptions.parse(args);
  const params: Record<string, string | number> = {};
  if (options.startingAfter) params.starting_after = options.startingAfter;
  if (options.createdGte !== undefined) params["created[gte]"] = options.createdGte;
  if (options.createdLt !== undefined) params["created[lt]"] = options.createdLt;
  return { params, compact: options.compact !== false };
}

type StripeRow = Record<string, unknown>;
type StripeResource = "customers" | "subscriptions" | "invoices" | "charges";

function record(value: unknown): StripeRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as StripeRow : {};
}

/** Only scalar fields can cross a compact projection; expanded API objects stay out. */
function pick(row: StripeRow, keys: string[]): StripeRow {
  const result: StripeRow = {};
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string") result[key] = value.slice(0, 500);
    else if (value === null || typeof value === "number" || typeof value === "boolean") result[key] = value;
  }
  return result;
}

function id(value: unknown): string | null {
  return typeof value === "string" ? value : typeof record(value).id === "string" ? record(value).id as string : null;
}

function compactRow(resource: StripeResource, row: StripeRow): StripeRow {
  const base = pick(row, ["id", "object", "created", "livemode"]);
  switch (resource) {
    case "customers":
      return {
        ...base,
        ...pick(row, ["name", "email", "currency", "balance", "delinquent", "deleted"]),
        default_payment_method: id(record(row.invoice_settings).default_payment_method),
      };
    case "subscriptions": {
      const items = record(row.items);
      const data = Array.isArray(items.data) ? items.data : [];
      return {
        ...base,
        ...pick(row, ["status", "currency", "current_period_start", "current_period_end", "trial_end", "cancel_at_period_end", "cancel_at", "canceled_at", "ended_at"]),
        customer: id(row.customer),
        latest_invoice: id(row.latest_invoice),
        items: {
          data: data.slice(0, 5).map((value) => {
            const item = record(value);
            const price = record(item.price);
            return {
              ...pick(item, ["id", "quantity", "current_period_start", "current_period_end"]),
              price: {
                ...pick(price, ["id", "currency", "unit_amount", "unit_amount_decimal", "billing_scheme"]),
                product: id(price.product),
                recurring: pick(record(price.recurring), ["interval", "interval_count", "usage_type"]),
              },
            };
          }),
          has_more: items.has_more === true || data.length > 5,
        },
      };
    }
    case "invoices":
      return {
        ...base,
        ...pick(row, ["number", "status", "currency", "subtotal", "total", "amount_due", "amount_paid", "amount_remaining", "due_date", "period_start", "period_end", "paid", "billing_reason", "customer_email"]),
        customer: id(row.customer),
        subscription: id(row.subscription) ?? id(record(record(row.parent).subscription_details).subscription),
      };
    case "charges":
      return {
        ...base,
        ...pick(row, ["status", "currency", "amount", "amount_captured", "amount_refunded", "paid", "captured", "refunded", "disputed", "failure_code", "failure_message"]),
        customer: id(row.customer),
        invoice: id(row.invoice),
        payment_intent: id(row.payment_intent),
      };
  }
}

/** Preserve Stripe's list envelope while making pagination and scope explicit. */
export function stripeReadPage(
  response: unknown,
  resource: StripeResource,
  params: Record<string, string | number>,
  compact: boolean,
) {
  const list = record(response);
  if (!Array.isArray(list.data) || typeof list.has_more !== "boolean" ||
      list.data.some((row) => typeof record(row).id !== "string")) {
    throw new Error("Stripe returned an invalid list response; coverage could not be established.");
  }
  const rows = list.data as StripeRow[];
  const lastId = rows.length ? rows[rows.length - 1].id as string : null;
  if (list.has_more && (!lastId || lastId === params.starting_after)) {
    throw new Error("Stripe reported more rows without an advancing cursor; retry this page.");
  }
  const { limit, starting_after: startingAfter, ...filters } = params;
  const dates = rows.map((row) => row.created).filter((value): value is number => typeof value === "number");
  return {
    object: "list",
    has_more: list.has_more,
    nextStartingAfter: list.has_more ? lastId : null,
    coverage: {
      resource,
      returned: rows.length,
      limit,
      startingAfter: startingAfter ?? null,
      filters,
      reachedEnd: !list.has_more,
      completeFromStart: !startingAfter && !list.has_more,
      newestCreated: dates.length ? Math.max(...dates) : null,
      oldestCreated: dates.length ? Math.min(...dates) : null,
      format: compact ? "compact" : "full",
      ...(compact ? { stringLimit: 500, subscriptionItemLimit: 5 } : {}),
      ...(resource === "subscriptions" ? { statusScope: filters.status ?? "not_canceled" } : {}),
      note: "One page of a live list. Follow nextStartingAfter with unchanged filters until reachedEnd; prior pages are not included. Amounts retain Stripe currency units. Compact rows omit unlisted fields, cap strings at 500 characters and subscription items at five.",
    },
    data: compact ? rows.map((row) => compactRow(resource, row)) : rows,
  };
}
