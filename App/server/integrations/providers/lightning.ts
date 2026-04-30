import { WebSocket as NodeWebSocket } from "ws";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { type Filter } from "nostr-tools/filter";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import * as nip04 from "nostr-tools/nip04";
import { hexToBytes } from "@noble/hashes/utils";
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
  requireHex,
  requireInt,
  requireString,
  shapeInvoice,
  shapePaymentResult,
  shortHex,
  spentLast24h,
  summarizeInvoice,
} from "./lightning-shared.js";

/**
 * Lightning (NWC) — Bitcoin payments for companies + AI employees,
 * wallet-agnostic.
 *
 * Each Connection holds one **Nostr Wallet Connect (NIP-47)** URI. The URI
 * encodes the wallet service's pubkey, the relay(s) to talk over, and a
 * dedicated "client" private key the wallet has pre-authorized. We never
 * see the user's wallet seed — NWC is a delegated-signing protocol.
 *
 * Tools mirror the standard NIP-47 method set, with the boundary normalized
 * to **sats** (NWC speaks millisats internally — the provider converts on
 * the way in and out). Three safety knobs live on the Connection's
 * encrypted config:
 *
 *   * `maxPaymentSats` — single-payment hard cap; over this throws.
 *   * `dailyLimitSats` — rolling-24h cap; over this throws.
 *   * `requireApprovalAboveSats` — payments above this go to the Approvals
 *     inbox instead of sending directly. A human approves; the central
 *     dispatcher replays the original tool call with `bypassApprovalGate`.
 *
 * Crypto re-uses the same `nostr-tools` primitives as the `nostr` provider —
 * Schnorr signing, NIP-04 encryption, SimplePool over WebSockets — so no
 * additional dependencies were pulled in for Lightning.
 */

// Wire ws as the WebSocket implementation. Idempotent with the call in
// `nostr.ts`; either module loading first sets the same impl.
// eslint-disable-next-line react-hooks/rules-of-hooks
useWebSocketImplementation(NodeWebSocket as unknown as typeof WebSocket);

const NWC_REQUEST_KIND = 23194;
const NWC_RESPONSE_KIND = 23195;

const NWC_TIMEOUT_MS = 25_000;

type LightningConfig = LightningSafetyConfig & {
  /** Wallet service pubkey, 64-char hex. */
  walletPubkey: string;
  /** Per-connection client key the wallet pre-authorized; 64-char hex. */
  clientSecret: string;
  /** Derived from clientSecret at validate time so we don't recompute. */
  clientPubkey: string;
  /** Relays the wallet is reachable on. */
  relays: string[];
  /** Optional Lightning Address attached to the URI. */
  lud16?: string;
  /** Captured at connect time via get_info; used in the account hint. */
  alias?: string;
  /** Wallet network (mainnet/testnet/signet/regtest), per get_info. */
  network?: string;
  /** Methods the wallet advertised support for. We pre-flight tool calls
   *  against this so unsupported methods fail fast. */
  walletMethods?: string[];
};

type NwcResponse = {
  result_type: string;
  error?: { code?: string; message?: string } | null;
  result?: Record<string, unknown> | null;
};

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export const lightningProvider: IntegrationProvider = {
  catalog: {
    provider: "lightning",
    name: "Lightning",
    category: "Payments",
    tagline: "Bitcoin payments via Nostr Wallet Connect.",
    description:
      "Connect a Lightning wallet so AI employees can send and receive Bitcoin. Uses Nostr Wallet Connect (NIP-47), so it works with any compatible wallet — Alby Hub, Mutiny, Phoenixd, Coinos, LNbits, Zeus, and more. Generate a connection URI in the wallet's NWC settings and paste it here. Genosyn never sees your wallet seed; the URI carries only a delegated signing key the wallet authorized.",
    icon: "Zap",
    authMode: "apikey",
    fields: [
      {
        key: "uri",
        label: "Connection URI",
        type: "password",
        placeholder: "nostr+walletconnect://…",
        required: true,
        hint: "Encrypted at rest. The URI grants whatever scope the wallet attached to it — most wallets let you set a per-connection spending budget when you mint one.",
      },
      ...SAFETY_FIELDS,
    ],
    enabled: true,
  },

  tools: LIGHTNING_TOOLS,

  async validateApiKey(input) {
    const rawUri = (input.uri ?? "").trim();
    if (!rawUri) throw new Error("Connection URI is required");
    const parsed = parseNwcUri(rawUri);
    const sk = hexToBytes(parsed.clientSecret);
    const clientPubkey = getPublicKey(sk);
    const safety = parseSafetyFields(input);

    const baseCfg: LightningConfig = {
      walletPubkey: parsed.walletPubkey,
      clientSecret: parsed.clientSecret,
      clientPubkey,
      relays: parsed.relays,
      lud16: parsed.lud16,
      ...safety,
      spendLog: [],
    };

    // Round-trip get_info so the user sees auth/relay/method failures up
    // front instead of the first time an AI tries to pay.
    const info = await nwcCall(baseCfg, "get_info", {});
    const alias = typeof info.alias === "string" ? info.alias : undefined;
    const network = typeof info.network === "string" ? info.network : undefined;
    const methods = Array.isArray(info.methods)
      ? (info.methods as unknown[]).filter((m): m is string => typeof m === "string")
      : undefined;

    const cfg: LightningConfig = {
      ...baseCfg,
      alias,
      network,
      walletMethods: methods,
    };

    const display = alias
      ? `${alias}${network && network !== "mainnet" ? ` · ${network}` : ""}`
      : `${shortHex(parsed.walletPubkey)}${network ? ` · ${network}` : ""}`;
    const accountHint = `${display} · ${maskSecret(rawUri)}`;
    return { config: cfg as unknown as IntegrationConfig, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as unknown as LightningConfig;
    if (!cfg.walletPubkey || !cfg.clientSecret) {
      return { ok: false, message: "Connection is missing NWC URI material." };
    }
    if (!cfg.relays || cfg.relays.length === 0) {
      return { ok: false, message: "No relays configured." };
    }
    try {
      const info = await nwcCall(cfg, "get_info", {});
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
    const cfg = ctx.config as unknown as LightningConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "get_info": {
        const info = await nwcCall(cfg, "get_info", {});
        return {
          alias: cfg.alias ?? info.alias ?? null,
          network: cfg.network ?? info.network ?? null,
          pubkey: typeof info.pubkey === "string" ? info.pubkey : null,
          methods:
            Array.isArray(info.methods) && info.methods.length > 0
              ? info.methods
              : (cfg.walletMethods ?? []),
          lud16: cfg.lud16 ?? null,
          relays: cfg.relays,
          limits: {
            maxPaymentSats: cfg.maxPaymentSats ?? null,
            dailyLimitSats: cfg.dailyLimitSats ?? null,
            requireApprovalAboveSats: cfg.requireApprovalAboveSats ?? null,
            spentLast24hSats: spentLast24h(cfg),
          },
        };
      }

      case "get_balance": {
        const out = await nwcCall(cfg, "get_balance", {});
        const balanceMsats = typeof out.balance === "number" ? out.balance : 0;
        return {
          balanceSats: Math.floor(balanceMsats / 1000),
          balanceMsats,
        };
      }

      case "make_invoice": {
        const amountSats = requireInt(a.amountSats, "amountSats");
        const params: Record<string, unknown> = { amount: amountSats * 1000 };
        if (typeof a.description === "string" && a.description) {
          params.description = a.description;
        }
        if (typeof a.expirySeconds === "number" && a.expirySeconds > 0) {
          params.expiry = Math.floor(a.expirySeconds);
        }
        const out = await nwcCall(cfg, "make_invoice", params);
        return shapeInvoice(out);
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
        const out = await nwcCall(cfg, "pay_invoice", {
          invoice,
          amount: amountSats * 1000,
        });
        recordSpend(ctx, cfg, amountSats);
        return shapePaymentResult(out, amountSats);
      }

      case "pay_keysend": {
        const pubkey = requireHex(a.pubkey, "pubkey", 66);
        const amountSats = requireInt(a.amountSats, "amountSats");
        enforceLimits({
          cfg,
          amountSats,
          ctx,
          description: `Keysend to ${shortHex(pubkey)}`,
        });
        const params: Record<string, unknown> = {
          pubkey,
          amount: amountSats * 1000,
        };
        if (typeof a.message === "string" && a.message) {
          params.tlv_records = [
            {
              type: 34349334,
              value: Buffer.from(a.message, "utf8").toString("hex"),
            },
          ];
        }
        const out = await nwcCall(cfg, "pay_keysend", params);
        recordSpend(ctx, cfg, amountSats);
        return shapePaymentResult(out, amountSats);
      }

      case "lookup_invoice": {
        const params: Record<string, unknown> = {};
        if (typeof a.paymentHash === "string" && a.paymentHash) {
          params.payment_hash = a.paymentHash;
        }
        if (typeof a.invoice === "string" && a.invoice) {
          params.invoice = a.invoice;
        }
        if (Object.keys(params).length === 0) {
          throw new Error("Pass either paymentHash or invoice");
        }
        const out = await nwcCall(cfg, "lookup_invoice", params);
        return shapeInvoice(out);
      }

      case "list_transactions": {
        const params: Record<string, unknown> = {};
        if (typeof a.from === "number") params.from = Math.floor(a.from);
        if (typeof a.until === "number") params.until = Math.floor(a.until);
        params.limit = typeof a.limit === "number" ? clampInt(a.limit, 1, 100, 25) : 25;
        if (typeof a.type === "string") params.type = a.type;
        if (typeof a.unpaid === "boolean") params.unpaid = a.unpaid;
        const out = await nwcCall(cfg, "list_transactions", params);
        const txs = Array.isArray(out.transactions) ? out.transactions : [];
        return {
          transactions: (txs as Array<Record<string, unknown>>).map(shapeInvoice),
        };
      }

      default:
        throw new Error(`Unknown Lightning tool: ${name}`);
    }
  },
};

// --------------------------------------------------------------------------
// NWC URI parsing
// --------------------------------------------------------------------------

type NwcParsedUri = {
  walletPubkey: string;
  clientSecret: string;
  relays: string[];
  lud16?: string;
};

function parseNwcUri(uri: string): NwcParsedUri {
  const trimmed = uri.trim();
  const PREFIX_LONG = "nostr+walletconnect://";
  const PREFIX_SHORT = "nostr+walletconnect:";
  let body: string;
  if (trimmed.startsWith(PREFIX_LONG)) body = trimmed.slice(PREFIX_LONG.length);
  else if (trimmed.startsWith(PREFIX_SHORT)) body = trimmed.slice(PREFIX_SHORT.length);
  else throw new Error("URI must start with nostr+walletconnect://");

  const qIdx = body.indexOf("?");
  if (qIdx < 0) {
    throw new Error("URI is missing the ?relay=…&secret=… query string");
  }
  const walletPubkey = body.slice(0, qIdx).toLowerCase().trim();
  if (!/^[0-9a-f]{64}$/.test(walletPubkey)) {
    throw new Error("Wallet pubkey must be 64 hex characters");
  }

  const params = new URLSearchParams(body.slice(qIdx + 1));
  const relays = params
    .getAll("relay")
    .map((r) => r.trim())
    .filter(Boolean);
  if (relays.length === 0) {
    throw new Error("URI must include at least one relay= parameter");
  }
  for (const r of relays) {
    if (!/^wss?:\/\//.test(r)) {
      throw new Error(`Relay URL must start with wss:// or ws:// — got "${r}"`);
    }
  }

  const secret = (params.get("secret") ?? "").toLowerCase().trim();
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error("secret= must be 64 hex characters");
  }

  const lud16 = params.get("lud16")?.trim() || undefined;
  return { walletPubkey, clientSecret: secret, relays, lud16 };
}

// --------------------------------------------------------------------------
// NWC RPC
// --------------------------------------------------------------------------

async function nwcCall(
  cfg: LightningConfig,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (
    cfg.walletMethods &&
    cfg.walletMethods.length > 0 &&
    !cfg.walletMethods.includes(method)
  ) {
    throw new Error(
      `Wallet does not advertise support for "${method}". Supported methods: ${cfg.walletMethods.join(", ")}`,
    );
  }

  const sk = hexToBytes(cfg.clientSecret);
  const payload = JSON.stringify({ method, params });
  const ciphertext = await nip04.encrypt(sk, cfg.walletPubkey, payload);

  const tmpl: EventTemplate = {
    kind: NWC_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", cfg.walletPubkey]],
    content: ciphertext,
  };
  const signed = finalizeEvent(tmpl, sk);

  const pool = new SimplePool();
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const responsePromise = new Promise<NwcResponse>((resolve, reject) => {
      const filter: Filter = {
        kinds: [NWC_RESPONSE_KIND],
        authors: [cfg.walletPubkey],
        "#e": [signed.id],
        "#p": [cfg.clientPubkey],
        since: Math.floor(Date.now() / 1000) - 5,
      };
      const sub = pool.subscribeMany(cfg.relays, filter, {
        onevent(ev) {
          // Decrypt + parse asynchronously inside a sync handler — errors
          // bubble out to the surrounding promise via reject().
          (async () => {
            try {
              const decrypted = await nip04.decrypt(sk, cfg.walletPubkey, ev.content);
              const parsed = JSON.parse(decrypted) as NwcResponse;
              sub.close();
              resolve(parsed);
            } catch (err) {
              sub.close();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          })();
        },
      });
      timer = setTimeout(() => {
        sub.close();
        reject(new Error(`NWC ${method} timed out after ${NWC_TIMEOUT_MS}ms`));
      }, NWC_TIMEOUT_MS);
    });

    // Fire publishes in the background. Per-relay errors surface via the
    // subscription timeout — we don't gate on `await` here because some
    // relays accept-but-don't-ack and would stall the call.
    Promise.allSettled(pool.publish(cfg.relays, signed)).catch(() => {
      /* swallow — timeout is the source of truth */
    });

    const response = await responsePromise;
    if (response.error) {
      const code = response.error.code ?? "UNKNOWN";
      const msg = response.error.message ?? code;
      throw new Error(`Wallet error: ${msg} (${code})`);
    }
    return response.result ?? {};
  } finally {
    if (timer) clearTimeout(timer);
    pool.close(cfg.relays);
  }
}
