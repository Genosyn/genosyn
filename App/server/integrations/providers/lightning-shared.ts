import {
  ApprovalRequiredError,
  type IntegrationCatalogField,
  type IntegrationConfig,
  type IntegrationRuntimeContext,
  type IntegrationTool,
} from "../types.js";

/**
 * Pieces shared between the NWC-backed Lightning provider (`lightning`)
 * and the direct-LND-REST provider (`lightning-lnd`):
 *
 *  - Tool catalog (one identical set of tools, expressed in sats)
 *  - Safety knobs + spend ledger
 *  - Argument coercion helpers
 *  - Result shaping (sats normalization, BOLT11 metadata fields)
 *
 * Auth-specific concerns (URI parsing, NWC RPC, LND REST translation)
 * live in their respective provider modules.
 */

// --------------------------------------------------------------------------
// Safety config
// --------------------------------------------------------------------------

export type LightningSafetyConfig = {
  /** Hard cap on a single payment. Unset = no cap. */
  maxPaymentSats?: number;
  /** Rolling 24h cap across all payments on this Connection. Unset = no cap. */
  dailyLimitSats?: number;
  /** Payments above this threshold (and at-or-below `maxPaymentSats`) go
   *  through the Approvals inbox instead of being sent directly. Unset =
   *  no approval gate. */
  requireApprovalAboveSats?: number;
  /** Compact spend ledger backing the daily-limit check. Trimmed to the
   *  last 24 h on every successful payment. */
  spendLog?: { ts: number; sats: number }[];
};

export const SPEND_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;
const SPEND_LOG_MAX_ENTRIES = 200;

/** Shared form rows for the connect/reconnect modal. Provider modules
 *  splice these in alongside their auth-specific fields. */
export const SAFETY_FIELDS: IntegrationCatalogField[] = [
  {
    key: "maxPaymentSats",
    label: "Max single payment (sats)",
    type: "text",
    placeholder: "10000",
    required: false,
    hint: "Optional cap. Any single payment above this is refused before the wallet is contacted. Leave blank for no cap.",
  },
  {
    key: "dailyLimitSats",
    label: "Daily spending limit (sats)",
    type: "text",
    placeholder: "50000",
    required: false,
    hint: "Optional rolling 24-hour cap across all payments on this Connection. Leave blank for no limit.",
  },
  {
    key: "requireApprovalAboveSats",
    label: "Require approval above (sats)",
    type: "text",
    placeholder: "1000",
    required: false,
    hint: "Optional. Payments above this go to the Approvals inbox instead of being sent directly. Leave blank to never require approval.",
  },
];

export function parseSafetyFields(input: Record<string, string>): {
  maxPaymentSats?: number;
  dailyLimitSats?: number;
  requireApprovalAboveSats?: number;
} {
  return {
    maxPaymentSats: parsePositiveInt(input.maxPaymentSats, "Max single payment"),
    dailyLimitSats: parsePositiveInt(input.dailyLimitSats, "Daily spending limit"),
    requireApprovalAboveSats: parsePositiveInt(
      input.requireApprovalAboveSats,
      "Require approval above",
    ),
  };
}

// --------------------------------------------------------------------------
// Tool catalog (shared by both providers)
// --------------------------------------------------------------------------

export const LIGHTNING_TOOLS: IntegrationTool[] = [
  {
    name: "get_info",
    description:
      "Return the wallet's alias, network, public key, supported methods, and any Lightning Address attached to this Connection. Also reports the current per-payment / daily caps and how much has been spent in the last 24 hours.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_balance",
    description:
      "Return the wallet's spendable balance in sats. For NWC sub-budget connections this may be smaller than the underlying wallet's full balance.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "make_invoice",
    description:
      "Create a BOLT11 invoice the user (or another agent) can pay to deposit sats into the wallet. Returns the encoded invoice string and its payment hash.",
    inputSchema: {
      type: "object",
      properties: {
        amountSats: { type: "integer", minimum: 1 },
        description: {
          type: "string",
          description:
            "Memo shown to the payer when scanning the invoice. Avoid sensitive content — invoices are public on the Lightning network.",
        },
        expirySeconds: {
          type: "integer",
          minimum: 60,
          description: "How long the invoice is valid for. Defaults to the wallet's setting.",
        },
      },
      required: ["amountSats"],
      additionalProperties: false,
    },
  },
  {
    name: "pay_invoice",
    description:
      "Pay a BOLT11 invoice. `amountSats` is required so the spending-cap check can run before the payment goes out — it must match the invoice amount, or fill in the amount for amount-less invoices. Payments above the Connection's approval threshold are queued in the Approvals inbox instead of sent.",
    inputSchema: {
      type: "object",
      properties: {
        invoice: {
          type: "string",
          description: "BOLT11 string (lnbc / lntb / lnbcrt prefix).",
        },
        amountSats: {
          type: "integer",
          minimum: 1,
          description: "Amount in sats. Must equal the invoice's embedded amount when present.",
        },
      },
      required: ["invoice", "amountSats"],
      additionalProperties: false,
    },
  },
  {
    name: "pay_keysend",
    description:
      "Send a spontaneous keysend payment to a node pubkey. No invoice required. Optional `message` is attached as a TLV record (record type 34349334).",
    inputSchema: {
      type: "object",
      properties: {
        pubkey: { type: "string", description: "Destination node pubkey, 66 hex chars." },
        amountSats: { type: "integer", minimum: 1 },
        message: { type: "string" },
      },
      required: ["pubkey", "amountSats"],
      additionalProperties: false,
    },
  },
  {
    name: "lookup_invoice",
    description:
      "Look up an invoice by payment hash or BOLT11 string. Returns its status, amount, fees, and timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        paymentHash: { type: "string", description: "32-byte payment hash, 64 hex chars." },
        invoice: { type: "string", description: "BOLT11 string." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_transactions",
    description:
      "List recent payments and invoices, most recent first. `type` filters incoming vs outgoing.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "integer", description: "Unix seconds — only entries after this." },
        until: { type: "integer", description: "Unix seconds — only entries before this." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        type: { type: "string", enum: ["incoming", "outgoing"] },
        unpaid: { type: "boolean" },
      },
      additionalProperties: false,
    },
  },
];

// --------------------------------------------------------------------------
// Limit + approval enforcement
// --------------------------------------------------------------------------

export function enforceLimits(args: {
  cfg: LightningSafetyConfig;
  amountSats: number;
  ctx: IntegrationRuntimeContext;
  /** Short, human-readable description of the payment. Goes on the
   *  approval row's `summary` field when an approval is created. */
  description: string;
}): void {
  const { cfg, amountSats, ctx, description } = args;

  if (cfg.maxPaymentSats != null && amountSats > cfg.maxPaymentSats) {
    throw new Error(
      `Payment of ${amountSats} sats exceeds the per-payment cap of ${cfg.maxPaymentSats} sats on this Connection. Edit the Connection's safety limits to allow this, or ask a human teammate to send it.`,
    );
  }
  if (cfg.dailyLimitSats != null) {
    const spent = spentLast24h(cfg);
    if (spent + amountSats > cfg.dailyLimitSats) {
      throw new Error(
        `Daily limit of ${cfg.dailyLimitSats} sats would be exceeded — already spent ${spent} sats in the last 24h on this Connection.`,
      );
    }
  }

  if (
    !ctx.bypassApprovalGate &&
    cfg.requireApprovalAboveSats != null &&
    amountSats > cfg.requireApprovalAboveSats
  ) {
    throw new ApprovalRequiredError(
      `Lightning payment · ${amountSats.toLocaleString()} sats`,
      description,
      amountSats,
    );
  }
}

export function spentLast24h(cfg: LightningSafetyConfig): number {
  if (!cfg.spendLog) return 0;
  const cutoff = Date.now() - SPEND_LOG_WINDOW_MS;
  return cfg.spendLog
    .filter((e) => e.ts >= cutoff)
    .reduce((sum, e) => sum + e.sats, 0);
}

export function recordSpend<T extends LightningSafetyConfig>(
  ctx: IntegrationRuntimeContext,
  cfg: T,
  amountSats: number,
): void {
  const cutoff = Date.now() - SPEND_LOG_WINDOW_MS;
  const log = (cfg.spendLog ?? []).filter((e) => e.ts >= cutoff);
  log.push({ ts: Date.now(), sats: amountSats });
  if (log.length > SPEND_LOG_MAX_ENTRIES) {
    log.splice(0, log.length - SPEND_LOG_MAX_ENTRIES);
  }
  const next: T = { ...cfg, spendLog: log };
  ctx.setConfig?.(next as unknown as IntegrationConfig);
}

// --------------------------------------------------------------------------
// Result shaping (sats normalization)
// --------------------------------------------------------------------------

export function shapeInvoice(out: Record<string, unknown>): Record<string, unknown> {
  const amount = typeof out.amount === "number" ? out.amount : null;
  const fees = typeof out.fees_paid === "number" ? out.fees_paid : null;
  return {
    type: out.type ?? null,
    invoice: out.invoice ?? null,
    description: out.description ?? null,
    descriptionHash: out.description_hash ?? null,
    paymentHash: out.payment_hash ?? null,
    preimage: out.preimage ?? null,
    amountSats: amount != null ? Math.floor(amount / 1000) : null,
    feesPaidSats: fees != null ? Math.floor(fees / 1000) : null,
    createdAt: out.created_at ?? null,
    expiresAt: out.expires_at ?? null,
    settledAt: out.settled_at ?? null,
    state: out.state ?? null,
    metadata: out.metadata ?? null,
  };
}

export function shapePaymentResult(
  out: Record<string, unknown>,
  amountSats: number,
): Record<string, unknown> {
  const fees = typeof out.fees_paid === "number" ? out.fees_paid : null;
  return {
    preimage: typeof out.preimage === "string" ? out.preimage : null,
    feesPaidSats: fees != null ? Math.floor(fees / 1000) : null,
    amountSats,
  };
}

// --------------------------------------------------------------------------
// Argument coercion
// --------------------------------------------------------------------------

export function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`${name} is required`);
  }
  return v.trim();
}

export function requireInt(v: unknown, name: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Math.floor(v);
}

export function requireHex(v: unknown, name: string, expectedLen: number): string {
  const s = requireString(v, name).toLowerCase();
  const re = new RegExp(`^[0-9a-f]{${expectedLen}}$`);
  if (!re.test(s)) {
    throw new Error(`${name} must be ${expectedLen} hex characters`);
  }
  return s;
}

export function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const i = Math.floor(v);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function parsePositiveInt(v: unknown, label: string): number | undefined {
  if (v == null) return undefined;
  const trimmed = typeof v === "string" ? v.trim() : v;
  if (trimmed === "" || trimmed === undefined) return undefined;
  const n = typeof trimmed === "number" ? trimmed : Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${label} must be a positive integer (or blank for no limit)`);
  }
  if (n === 0) return undefined;
  return Math.floor(n);
}

export function shortHex(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/** Truncate a BOLT11 string for the approval-row summary. */
export function summarizeInvoice(invoice: string): string {
  if (invoice.length <= 36) return invoice;
  return `${invoice.slice(0, 18)}…${invoice.slice(-6)}`;
}
