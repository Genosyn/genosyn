import https from "node:https";
import http from "node:http";
import { URL } from "node:url";
import type {
  IntegrationConfig,
  IntegrationProvider,
} from "../types.js";
import { maskSecret } from "../../lib/secret.js";
import {
  LIGHTNING_TOOLS,
  SAFETY_FIELDS,
  type LightningSafetyConfig,
  clampInt,
  enforceLimits,
  parseSafetyFields,
  recordSpend,
  requireInt,
  requireString,
  shapePaymentResult,
  shortHex,
  spentLast24h,
  summarizeInvoice,
} from "./lightning-shared.js";

/**
 * Lightning (LND REST) — direct connection to a self-hosted LND node.
 *
 * For operators who run their own node and want sovereign control over
 * the wallet rather than going through Nostr Wallet Connect. Auth is
 * a node URL + hex-encoded macaroon (typically the read+invoice+send
 * subset of `admin.macaroon`, which users mint with `lncli bakemacaroon`).
 *
 * Self-signed certs (the LND default) are supported by pasting the
 * `tls.cert` PEM into the optional cert field; without it the system
 * trust store applies, which works for Voltage / publicly-served LNDs.
 *
 * Tool surface is identical to the NWC provider (see
 * `lightning-shared.ts`) and the same safety knobs apply
 * (`maxPaymentSats`, `dailyLimitSats`, `requireApprovalAboveSats`).
 *
 * Keysend is intentionally not implemented in this provider — LND's
 * REST keysend path requires synthesizing a preimage and managing the
 * `dest_custom_records` TLV envelope by hand, which adds enough surface
 * to warrant its own pass. Use the NWC provider for keysend, or send
 * via an invoice instead.
 */

const LND_TIMEOUT_MS = 25_000;

type LndConfig = LightningSafetyConfig & {
  /** Base URL like `https://lnd.example.com:8080`. Always coerced to a
   *  no-trailing-slash form at validate time. */
  baseUrl: string;
  /** Hex-encoded macaroon bytes — the format LND expects in the
   *  `Grpc-Metadata-macaroon` header. */
  macaroonHex: string;
  /** Optional PEM-encoded `tls.cert`. When set, used as the trusted CA
   *  for this Connection's HTTPS calls so self-signed LNDs work. */
  certPem?: string;
  /** Captured at connect time via /v1/getinfo for the account hint. */
  alias?: string;
  /** Mainnet / testnet / regtest / signet. */
  network?: string;
  /** LND node identity pubkey. */
  identityPubkey?: string;
};

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export const lightningLndProvider: IntegrationProvider = {
  catalog: {
    provider: "lightning-lnd",
    name: "Lightning (LND)",
    category: "Payments",
    tagline: "Direct connection to your own LND node.",
    description:
      "Connect a self-hosted LND node so AI employees can send and receive Bitcoin without a third-party wallet service in the middle. Auth is your node URL plus a hex-encoded macaroon — generate one with `lncli bakemacaroon` granting `info:read`, `invoices:read`, `invoices:write`, and `offchain:write` (skip `onchain` and `peers` for blast-radius reasons). For self-signed certs (LND's default), paste the `tls.cert` PEM into the cert field. Keysend is not yet supported in LND mode — use the standard Lightning (NWC) provider for keysend.",
    icon: "Zap",
    authMode: "apikey",
    fields: [
      {
        key: "baseUrl",
        label: "Node REST URL",
        type: "url",
        placeholder: "https://lnd.example.com:8080",
        required: true,
        hint: "REST port (default 8080) — not gRPC (10009). Voltage and other hosted nodes give you this URL directly.",
      },
      {
        key: "macaroonHex",
        label: "Macaroon (hex)",
        type: "password",
        placeholder: "0201036c6e64…",
        required: true,
        hint: "Hex-encoded admin or scoped macaroon. Run `xxd -plain -c 1000 <macaroon-file>` to convert binary to hex. Encrypted at rest.",
      },
      {
        key: "certPem",
        label: "TLS cert (PEM)",
        type: "textarea",
        placeholder: "-----BEGIN CERTIFICATE-----\nMIIC…\n-----END CERTIFICATE-----",
        required: false,
        hint: "Paste your LND `tls.cert` if the node uses a self-signed certificate. Leave blank for nodes with a publicly trusted cert (Voltage, etc.).",
      },
      ...SAFETY_FIELDS,
    ],
    enabled: true,
  },

  tools: LIGHTNING_TOOLS,

  async validateApiKey(input) {
    const baseUrl = normalizeBaseUrl(requireString(input.baseUrl, "Node REST URL"));
    const macaroonHex = requireHexish(
      input.macaroonHex,
      "Macaroon",
    );
    const certPem = (input.certPem ?? "").trim() || undefined;
    if (certPem && !/-----BEGIN CERTIFICATE-----/.test(certPem)) {
      throw new Error(
        "TLS cert must be a PEM-encoded certificate (starts with -----BEGIN CERTIFICATE-----).",
      );
    }
    const safety = parseSafetyFields(input);
    const baseCfg: LndConfig = {
      baseUrl,
      macaroonHex,
      certPem,
      ...safety,
      spendLog: [],
    };

    // Round-trip /v1/getinfo so credential / cert / network errors surface
    // up front rather than on the first payment.
    const info = (await lndRequest(baseCfg, "GET", "/v1/getinfo")) as Record<
      string,
      unknown
    >;
    const alias = typeof info.alias === "string" ? info.alias : undefined;
    const identityPubkey =
      typeof info.identity_pubkey === "string" ? info.identity_pubkey : undefined;
    const chains = Array.isArray(info.chains) ? info.chains : [];
    const network =
      chains.length > 0 && typeof (chains[0] as Record<string, unknown>).network === "string"
        ? ((chains[0] as Record<string, unknown>).network as string)
        : undefined;

    const cfg: LndConfig = {
      ...baseCfg,
      alias,
      network,
      identityPubkey,
    };

    const display = alias
      ? `${alias}${network && network !== "mainnet" ? ` · ${network}` : ""}`
      : `${shortHex(identityPubkey ?? "")}${network ? ` · ${network}` : ""}`;
    const accountHint = `${display} · ${maskSecret(macaroonHex)}`;
    return { config: cfg as unknown as IntegrationConfig, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as unknown as LndConfig;
    if (!cfg.baseUrl || !cfg.macaroonHex) {
      return { ok: false, message: "Connection is missing baseUrl or macaroon." };
    }
    try {
      const info = (await lndRequest(cfg, "GET", "/v1/getinfo")) as Record<
        string,
        unknown
      >;
      const alias = typeof info.alias === "string" ? info.alias : null;
      return {
        ok: true,
        message: alias ? `Connected to ${alias}` : "Connected.",
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as unknown as LndConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_info": {
        const info = (await lndRequest(cfg, "GET", "/v1/getinfo")) as Record<
          string,
          unknown
        >;
        const chains = Array.isArray(info.chains) ? info.chains : [];
        const network =
          chains.length > 0 &&
          typeof (chains[0] as Record<string, unknown>).network === "string"
            ? ((chains[0] as Record<string, unknown>).network as string)
            : null;
        return {
          alias: typeof info.alias === "string" ? info.alias : (cfg.alias ?? null),
          network: network ?? cfg.network ?? null,
          pubkey:
            typeof info.identity_pubkey === "string"
              ? info.identity_pubkey
              : (cfg.identityPubkey ?? null),
          methods: LIGHTNING_TOOLS.map((t) => t.name).filter(
            (m) => m !== "pay_keysend",
          ),
          lud16: null,
          baseUrl: cfg.baseUrl,
          version: typeof info.version === "string" ? info.version : null,
          syncedToChain: info.synced_to_chain ?? null,
          numActiveChannels: info.num_active_channels ?? null,
          limits: {
            maxPaymentSats: cfg.maxPaymentSats ?? null,
            dailyLimitSats: cfg.dailyLimitSats ?? null,
            requireApprovalAboveSats: cfg.requireApprovalAboveSats ?? null,
            spentLast24hSats: spentLast24h(cfg),
          },
        };
      }

      case "get_balance": {
        const out = (await lndRequest(cfg, "GET", "/v1/balance/channels")) as Record<
          string,
          unknown
        >;
        const balanceSats = parseLndSats(out.balance);
        const pendingOpenSats = parseLndSats(out.pending_open_balance);
        return {
          balanceSats,
          balanceMsats: balanceSats * 1000,
          pendingOpenSats,
        };
      }

      case "make_invoice": {
        const amountSats = requireInt(a.amountSats, "amountSats");
        const body: Record<string, unknown> = { value: String(amountSats) };
        if (typeof a.description === "string" && a.description) {
          body.memo = a.description;
        }
        if (typeof a.expirySeconds === "number" && a.expirySeconds > 0) {
          body.expiry = String(Math.floor(a.expirySeconds));
        }
        const out = (await lndRequest(cfg, "POST", "/v1/invoices", body)) as Record<
          string,
          unknown
        >;
        const paymentHash = b64ToHex(out.r_hash);
        const expiry =
          typeof body.expiry === "string" ? Number(body.expiry) : 3600;
        return {
          type: "incoming",
          invoice: typeof out.payment_request === "string" ? out.payment_request : null,
          description: typeof a.description === "string" ? a.description : null,
          descriptionHash: null,
          paymentHash,
          preimage: null,
          amountSats,
          feesPaidSats: null,
          createdAt: Math.floor(Date.now() / 1000),
          expiresAt: Math.floor(Date.now() / 1000) + expiry,
          settledAt: null,
          state: "OPEN",
          metadata: null,
        };
      }

      case "pay_invoice": {
        const invoice = requireString(a.invoice, "invoice");
        const amountSats = requireInt(a.amountSats, "amountSats");
        enforceLimits({
          cfg,
          amountSats,
          ctx,
          description: `Pay invoice ${summarizeInvoice(invoice)}`,
        });
        const out = (await lndRequest(cfg, "POST", "/v1/channels/transactions", {
          payment_request: invoice,
          amt: String(amountSats),
        })) as Record<string, unknown>;
        if (typeof out.payment_error === "string" && out.payment_error) {
          throw new Error(`LND payment error: ${out.payment_error}`);
        }
        const route = (out.payment_route ?? {}) as Record<string, unknown>;
        const feeSats =
          typeof route.total_fees === "string"
            ? parseLndSats(route.total_fees)
            : typeof route.total_fees === "number"
              ? route.total_fees
              : null;
        const preimage = b64ToHex(out.payment_preimage);
        recordSpend(ctx, cfg, amountSats);
        return shapePaymentResult(
          {
            preimage,
            fees_paid: feeSats != null ? feeSats * 1000 : null,
          },
          amountSats,
        );
      }

      case "pay_keysend":
        throw new Error(
          "Keysend is not yet implemented in the LND provider. Use the Lightning (NWC) provider for keysend, or send to an invoice instead.",
        );

      case "lookup_invoice": {
        let paymentHash =
          typeof a.paymentHash === "string" && a.paymentHash
            ? a.paymentHash.toLowerCase()
            : null;
        if (!paymentHash && typeof a.invoice === "string" && a.invoice) {
          // Decode payment request to extract the hash.
          const decoded = (await lndRequest(
            cfg,
            "GET",
            `/v1/payreq/${encodeURIComponent(a.invoice.trim())}`,
          )) as Record<string, unknown>;
          paymentHash =
            typeof decoded.payment_hash === "string" ? decoded.payment_hash : null;
        }
        if (!paymentHash) {
          throw new Error("Pass either paymentHash or invoice");
        }
        if (!/^[0-9a-f]{64}$/.test(paymentHash)) {
          throw new Error("paymentHash must be 64 hex characters");
        }
        const out = (await lndRequest(
          cfg,
          "GET",
          `/v1/invoice/${paymentHash}`,
        )) as Record<string, unknown>;
        return shapeLndInvoice(out);
      }

      case "list_transactions": {
        const limit = typeof a.limit === "number" ? clampInt(a.limit, 1, 100, 25) : 25;
        const wantsIncoming = a.type !== "outgoing";
        const wantsOutgoing = a.type !== "incoming";

        const all: Array<Record<string, unknown>> = [];

        if (wantsIncoming) {
          const params = new URLSearchParams({
            reversed: "true",
            num_max_invoices: String(limit),
          });
          if (a.unpaid === true) params.set("pending_only", "true");
          const inc = (await lndRequest(
            cfg,
            "GET",
            `/v1/invoices?${params.toString()}`,
          )) as Record<string, unknown>;
          if (Array.isArray(inc.invoices)) {
            for (const inv of inc.invoices as Array<Record<string, unknown>>) {
              const ts = parseLndSats(inv.creation_date);
              if (typeof a.from === "number" && ts < a.from) continue;
              if (typeof a.until === "number" && ts > a.until) continue;
              all.push(shapeLndInvoice(inv));
            }
          }
        }

        if (wantsOutgoing) {
          const params = new URLSearchParams({
            reversed: "true",
            max_payments: String(limit),
            include_incomplete: a.unpaid === true ? "true" : "false",
          });
          const pay = (await lndRequest(
            cfg,
            "GET",
            `/v1/payments?${params.toString()}`,
          )) as Record<string, unknown>;
          if (Array.isArray(pay.payments)) {
            for (const p of pay.payments as Array<Record<string, unknown>>) {
              const ts = parseLndSats(p.creation_date);
              if (typeof a.from === "number" && ts < a.from) continue;
              if (typeof a.until === "number" && ts > a.until) continue;
              all.push(shapeLndPayment(p));
            }
          }
        }

        all.sort((a1, a2) => {
          const t1 = typeof a1.createdAt === "number" ? a1.createdAt : 0;
          const t2 = typeof a2.createdAt === "number" ? a2.createdAt : 0;
          return t2 - t1;
        });
        return { transactions: all.slice(0, limit) };
      }

      default:
        throw new Error(`Unknown Lightning (LND) tool: ${name}`);
    }
  },
};

// --------------------------------------------------------------------------
// LND REST plumbing
// --------------------------------------------------------------------------

function normalizeBaseUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new Error(`Invalid LND URL: "${input}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error("LND URL must use https:// (or http:// for local-only setups)");
  }
  // Strip trailing slash + any path so we can append /v1/... cleanly.
  return `${u.protocol}//${u.host}`;
}

function requireHexish(v: unknown, label: string): string {
  const s = requireString(v, label).toLowerCase().replace(/\s+/g, "");
  if (!/^[0-9a-f]+$/.test(s) || s.length % 2 !== 0) {
    throw new Error(`${label} must be a hex-encoded byte string`);
  }
  return s;
}

async function lndRequest(
  cfg: LndConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = new URL(path, cfg.baseUrl + "/");
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const headers: Record<string, string> = {
    "Grpc-Metadata-macaroon": cfg.macaroonHex,
    Accept: "application/json",
  };
  let payload: string | null = null;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }

  return new Promise((resolve, reject) => {
    const opts: https.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port ? Number(url.port) : isHttps ? 443 : 80,
      path: url.pathname + url.search,
      headers,
      timeout: LND_TIMEOUT_MS,
    };
    if (isHttps && cfg.certPem) {
      (opts as https.RequestOptions).ca = cfg.certPem;
    }

    const req = lib.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          let msg = data;
          try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object") {
              const m = (parsed as Record<string, unknown>).message;
              const e = (parsed as Record<string, unknown>).error;
              if (typeof m === "string") msg = m;
              else if (typeof e === "string") msg = e;
            }
          } catch {
            // leave msg as raw body
          }
          reject(new Error(`LND ${status}: ${msg.slice(0, 500)}`));
          return;
        }
        if (!data) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(
            new Error(`LND returned non-JSON: ${data.slice(0, 200)}`),
          );
        }
      });
    });

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy(new Error(`LND request timed out after ${LND_TIMEOUT_MS}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// --------------------------------------------------------------------------
// LND-specific shaping
// --------------------------------------------------------------------------

function parseLndSats(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return 0;
}

function b64ToHex(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  try {
    return Buffer.from(v, "base64").toString("hex");
  } catch {
    return null;
  }
}

function shapeLndInvoice(inv: Record<string, unknown>): Record<string, unknown> {
  const valueSats = parseLndSats(inv.value);
  const settledSats = parseLndSats(inv.amt_paid_sat);
  const created = parseLndSats(inv.creation_date);
  const expiry = parseLndSats(inv.expiry);
  const state = typeof inv.state === "string" ? inv.state : null;
  const settled = inv.settled === true || state === "SETTLED";
  const settleDate = parseLndSats(inv.settle_date);
  return {
    type: "incoming",
    invoice: typeof inv.payment_request === "string" ? inv.payment_request : null,
    description: typeof inv.memo === "string" ? inv.memo : null,
    descriptionHash:
      typeof inv.description_hash === "string" ? inv.description_hash : null,
    paymentHash: b64ToHex(inv.r_hash),
    preimage: settled ? b64ToHex(inv.r_preimage) : null,
    amountSats: settled && settledSats > 0 ? settledSats : valueSats,
    feesPaidSats: null,
    createdAt: created || null,
    expiresAt: created && expiry ? created + expiry : null,
    settledAt: settleDate || null,
    state,
  };
}

function shapeLndPayment(p: Record<string, unknown>): Record<string, unknown> {
  const valueSats = parseLndSats(p.value_sat);
  const feeSats = parseLndSats(p.fee_sat);
  const created = parseLndSats(p.creation_date);
  const status = typeof p.status === "string" ? p.status : null;
  return {
    type: "outgoing",
    invoice: typeof p.payment_request === "string" ? p.payment_request : null,
    description: null,
    descriptionHash: null,
    paymentHash:
      typeof p.payment_hash === "string" ? p.payment_hash : null,
    preimage: typeof p.payment_preimage === "string" ? p.payment_preimage : null,
    amountSats: valueSats,
    feesPaidSats: feeSats,
    createdAt: created || null,
    expiresAt: null,
    settledAt: status === "SUCCEEDED" ? created || null : null,
    state: status,
  };
}
