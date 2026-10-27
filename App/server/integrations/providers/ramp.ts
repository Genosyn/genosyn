import { createHash } from "node:crypto";

import { roundHalfAway } from "../../lib/money.js";
import { maskSecret } from "../../lib/secret.js";
import { ProviderRequestError, parseRetryAfter } from "../providerErrors.js";
import { ConnectionAuthError, type IntegrationProvider } from "../types.js";

/**
 * Ramp — a read-only integration for a Ramp business's card activity: card
 * transactions, the payments that settle the Ramp bill, cashback, and the
 * card balance. An admin creates a developer app in Ramp (Company →
 * Developer), adds the Client Credentials grant type, allows the read scopes
 * below, and pastes the app's client ID and secret into a Connection. Genosyn
 * exchanges them for an access token with Ramp's client-credentials grant,
 * talks to Ramp directly, and never issues cards, changes limits, or moves
 * money.
 *
 * Access tokens are kept in memory only, per client, until shortly before they
 * expire — never written to the Connection — and a token Ramp stops accepting
 * is replaced once before a request fails.
 */

const RAMP_API = "https://api.ramp.com";
const API_ROOT = "/developer/v1";
const REQUEST_TIMEOUT_MS = 30_000;
/** Ramp answers at most this many items a page, and at least two. */
export const RAMP_PAGE_SIZE = 100;
/**
 * What Genosyn asks Ramp for: the business and its card balance, card
 * transactions, the payments that settle the bill, and cashback. A token asks
 * for all of them, and Ramp refuses one when the app doesn't allow every scope.
 */
export const RAMP_SCOPES = [
  "business:read",
  "transactions:read",
  "transfers:read",
  "cashbacks:read",
] as const;
/** A token is replaced this long before Ramp says it expires. */
const TOKEN_MARGIN_MS = 5 * 60_000;
/** What Ramp says about an access token it doesn't know — with HTTP 404, not 401. */
const UNKNOWN_TOKEN = "DEVELOPER_7002";

export type RampConfig = {
  clientId: string;
  clientSecret: string;
};

/** A signed amount in the currency's smallest unit — cents for USD. */
export type RampSignedAmount = {
  value: number;
  currency?: string | null;
};

/** An amount in the currency's smallest unit, as Ramp's older fields send one. */
export type RampCurrencyAmount = {
  amount: number;
  currency_code?: string | null;
  /** What to divide `amount` by for whole units: 100 for USD. */
  minor_unit_conversion_rate?: number | null;
};

export type RampCardHolder = {
  first_name?: string | null;
  last_name?: string | null;
  department_name?: string | null;
  location_name?: string | null;
  user_id?: string | null;
};

export type RampTransaction = {
  id: string;
  /** What settled to the business, signed: a refund or credit is negative. */
  entity_amount?: RampSignedAmount | null;
  /** What the merchant charged, in the merchant's currency. */
  merchant_amount?: RampSignedAmount | null;
  /** What to divide the amounts by for whole units: 100 for USD. */
  minor_unit_conversion_rate?: number | null;
  /** Deprecated by Ramp for `entity_amount`: whole units, as a decimal number. */
  amount?: number | null;
  /** Deprecated by Ramp for `entity_amount.currency`. */
  currency_code?: string | null;
  /** `CLEARED` once it has settled. */
  state?: string | null;
  /** When the card was used. Ramp's date filters read this. */
  user_transaction_time?: string | null;
  /** When the money moved. */
  settlement_date?: string | null;
  merchant_name?: string | null;
  merchant_descriptor?: string | null;
  sk_category_name?: string | null;
  card_id?: string | null;
  card_holder?: RampCardHolder | null;
  memo?: string | null;
  /** On a refund, the purchase it refunds. */
  original_transaction_id?: string | null;
};

/** A payment of the Ramp bill from one of the business's bank accounts. */
export type RampTransfer = {
  id: string;
  amount: RampCurrencyAmount | null;
  /** `COMPLETED` once it reached Ramp. */
  status?: string | null;
  created_at?: string | null;
  bank_account_id?: string | null;
};

/** Cashback Ramp credited to the business's card balance. */
export type RampCashback = {
  id: string;
  amount: RampCurrencyAmount | null;
  created_at?: string | null;
};

export type RampPage<T> = {
  data: T[];
  page?: { next?: string | null } | null;
};

export type RampBusiness = {
  id?: string | null;
  business_name_legal?: string | null;
  business_name_on_card?: string | null;
};

export type RampBalance = {
  card_balance_including_pending_amount?: RampCurrencyAmount | null;
  card_balance_excluding_pending_amount?: RampCurrencyAmount | null;
  statement_balance_amount?: RampCurrencyAmount | null;
  available_card_limit_amount?: RampCurrencyAmount | null;
  card_limit_amount?: RampCurrencyAmount | null;
  next_billing_date?: string | null;
  prev_billing_date?: string | null;
};

/** Ramp refused a request, or never answered it (`status` 0). */
export class RampApiError extends ProviderRequestError {
  constructor(message: string, status: number, retryAfterMs: number | null = null, request = "") {
    super(message, "Ramp", status, retryAfterMs, request);
    this.name = "RampApiError";
  }
}

export const RAMP_CREDENTIALS_REJECTED =
  "Ramp rejected the client ID and secret. Copy them again from the developer app in Ramp under Company → Developer, or create a new app.";

export const RAMP_SCOPES_MISSING = `Ramp won't give this app every scope Genosyn reads with. Allow ${RAMP_SCOPES.join(", ")} on the developer app in Ramp under Company → Developer.`;

export const RAMP_GRANT_MISSING =
  "Ramp won't let this app use client credentials. Add the Client Credentials grant type to the developer app in Ramp under Company → Developer.";

/** Every code and message Ramp put in an error body, lowercased, to look for one in. */
function rampErrorWords(parsed: unknown): string {
  if (!parsed || typeof parsed !== "object") return "";
  const body = parsed as Record<string, unknown>;
  const words: unknown[] = [];
  for (const block of [body, body.error_v2, body.error]) {
    if (typeof block === "string") words.push(block);
    else if (block && typeof block === "object") {
      const inner = block as Record<string, unknown>;
      words.push(inner.error_code, inner.message, inner.error_description);
      if (block !== body) words.push(inner.error);
    }
  }
  return words
    .filter((word): word is string => typeof word === "string")
    .join(" ")
    .toLowerCase();
}

/** Ramp's own words for a failure, from whichever error shape it answered with. */
function rampDetail(parsed: unknown, text: string): string | null {
  if (parsed && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    for (const block of [body.error_v2, body.error, body]) {
      if (typeof block === "string" && block.trim()) return block.trim();
      if (block && typeof block === "object") {
        const inner = block as Record<string, unknown>;
        for (const key of ["message", "error_description"]) {
          const value = inner[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
      }
    }
    return null;
  }
  const trimmed = text.trim();
  // An HTML error page from a proxy says nothing a person can use.
  return trimmed && !trimmed.startsWith("<") ? trimmed.slice(0, 300) : null;
}

/** Ramp doesn't know this access token: a 401, or the 404 Ramp answers one with. */
function isUnknownToken(res: Response, parsed: unknown): boolean {
  return res.status === 401 || (res.status === 404 && rampErrorWords(parsed).includes(UNKNOWN_TOKEN.toLowerCase()));
}

function rampError(res: Response, request: string, parsed: unknown, text: string): Error {
  const detail = rampDetail(parsed, text);
  if (isUnknownToken(res, parsed)) return new ConnectionAuthError(RAMP_CREDENTIALS_REJECTED, "expired");
  if (res.status === 403) {
    return new RampApiError(
      `Ramp refused the request${detail ? `: ${detail}` : ""}. Check that the developer app allows ${RAMP_SCOPES.join(", ")}.`,
      403,
      null,
      request,
    );
  }
  if (res.status === 404) {
    return new RampApiError("Ramp couldn't find what was asked for.", 404, null, request);
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    return new RampApiError(
      Number.isFinite(seconds) && seconds > 0
        ? `Ramp is limiting how fast it answers. Try again in ${Math.ceil(seconds)} seconds.`
        : "Ramp is limiting how fast it answers. Try again in a minute.",
      429,
      parseRetryAfter(res.headers.get("retry-after")),
      request,
    );
  }
  return new RampApiError(
    detail ? `Ramp ${res.status}: ${detail}` : `Ramp ${res.status} ${res.statusText}`.trim(),
    res.status,
    parseRetryAfter(res.headers.get("retry-after")),
    request,
  );
}

async function rampFetch(
  url: URL,
  init: RequestInit,
  request: string,
): Promise<{ res: Response; parsed: unknown; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new RampApiError(
        `Ramp didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again.`,
        0,
        null,
        request,
      );
    }
    throw err;
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { res, parsed, text };
}

// ─────────────────────────────── access tokens ───────────────────────────────

type CachedToken = { accessToken: string; expiresAt: number };

/** Access tokens by client, in this process only. */
const tokens = new Map<string, CachedToken>();

function tokenKey(cfg: RampConfig): string {
  return createHash("sha256").update(`${cfg.clientId}\n${cfg.clientSecret}`).digest("hex");
}

/** Forget every cached access token, so a test starts from none. */
export function forgetRampTokensForTests(): void {
  tokens.clear();
}

async function requestRampToken(cfg: RampConfig): Promise<CachedToken> {
  const request = `POST ${API_ROOT}/token`;
  const { res, parsed, text } = await rampFetch(
    new URL(`${API_ROOT}/token`, RAMP_API),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: RAMP_SCOPES.join(" "),
      }).toString(),
    },
    request,
  );
  if (!res.ok) {
    const words = rampErrorWords(parsed);
    // Both are the app's setup, not its secret: the credential is fine.
    if (words.includes("invalid_scope")) throw new RampApiError(RAMP_SCOPES_MISSING, 403, null, request);
    if (words.includes("unauthorized_client")) {
      throw new RampApiError(RAMP_GRANT_MISSING, 403, null, request);
    }
    if (res.status === 400 || res.status === 401) {
      throw new ConnectionAuthError(RAMP_CREDENTIALS_REJECTED, "expired");
    }
    throw rampError(res, request, parsed, text);
  }
  const body = (parsed ?? {}) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new RampApiError("Ramp answered without an access token", res.status, null, request);
  }
  const lifetimeMs =
    typeof body.expires_in === "number" && Number.isFinite(body.expires_in) && body.expires_in > 0
      ? body.expires_in * 1000
      : 60 * 60_000;
  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_MARGIN_MS, 60_000),
  };
}

/** An access token for this client: the cached one while it lasts, else a new one. */
export async function rampAccessToken(cfg: RampConfig, fresh = false): Promise<string> {
  const key = tokenKey(cfg);
  const cached = tokens.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.accessToken;
  const token = await requestRampToken(cfg);
  tokens.set(key, token);
  return token.accessToken;
}

async function rampGet(
  cfg: RampConfig,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): Promise<unknown> {
  const url = new URL(`${API_ROOT}${path}`, RAMP_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const request = `GET ${API_ROOT}${path}`;
  // A cached token Ramp no longer knows — revoked, or expired early — is
  // replaced once; a new token refused again is a credential problem.
  for (let attempt = 0; ; attempt += 1) {
    const accessToken = await rampAccessToken(cfg, attempt > 0);
    const { res, parsed, text } = await rampFetch(
      url,
      { headers: { accept: "application/json", Authorization: `Bearer ${accessToken}` } },
      request,
    );
    if (attempt === 0 && isUnknownToken(res, parsed)) continue;
    if (!res.ok) throw rampError(res, request, parsed, text);
    return parsed;
  }
}

/**
 * The cursor in a page's `next` link, or null on the last page. Only the
 * cursor is read: the next request is built here, so a link never sends the
 * token anywhere but Ramp's API.
 */
export function rampNextCursor(page: { page?: { next?: string | null } | null }): string | null {
  const next = page.page?.next;
  if (!next) return null;
  try {
    return new URL(next, RAMP_API).searchParams.get("start") || null;
  } catch {
    return null;
  }
}

function readPage<T>(parsed: unknown, what: string): RampPage<T> {
  const page = parsed as RampPage<T> | null;
  if (!page || !Array.isArray(page.data)) throw new Error(`Ramp returned ${what} without a list`);
  return page;
}

export type RampPageOptions = {
  /** The cursor from the previous page. */
  start?: string;
  pageSize?: number;
  /** Only what happened after this moment. */
  fromDate?: Date;
  /** Only what happened before this moment. */
  toDate?: Date;
};

function pageParams(options: RampPageOptions) {
  return {
    start: options.start,
    page_size: options.pageSize ?? RAMP_PAGE_SIZE,
    from_date: options.fromDate?.toISOString(),
    to_date: options.toDate?.toISOString(),
  };
}

/** Card transactions. Ramp's date filters read when the card was used. */
export async function getRampTransactionsPage(
  cfg: RampConfig,
  options: RampPageOptions & { state?: string; cardId?: string } = {},
): Promise<RampPage<RampTransaction>> {
  return readPage<RampTransaction>(
    await rampGet(cfg, "/transactions", {
      ...pageParams(options),
      state: options.state,
      card_id: options.cardId,
    }),
    "transactions",
  );
}

/** Payments of the Ramp bill. */
export async function getRampTransfersPage(
  cfg: RampConfig,
  options: RampPageOptions & { status?: string } = {},
): Promise<RampPage<RampTransfer>> {
  return readPage<RampTransfer>(
    await rampGet(cfg, "/transfers", { ...pageParams(options), status: options.status }),
    "transfers",
  );
}

export async function getRampCashbacksPage(
  cfg: RampConfig,
  options: RampPageOptions = {},
): Promise<RampPage<RampCashback>> {
  return readPage<RampCashback>(await rampGet(cfg, "/cashbacks", pageParams(options)), "cashbacks");
}

export async function getRampBusiness(cfg: RampConfig): Promise<RampBusiness> {
  return ((await rampGet(cfg, "/business")) ?? {}) as RampBusiness;
}

export async function getRampBalance(cfg: RampConfig): Promise<RampBalance> {
  return ((await rampGet(cfg, "/business/balance")) ?? {}) as RampBalance;
}

export function rampBusinessName(business: RampBusiness): string {
  return (
    business.business_name_legal?.trim() || business.business_name_on_card?.trim() || "Ramp business"
  );
}

/**
 * An amount in a currency's smallest unit, as the hundredths the books keep:
 * `rate` is how many smallest units make one whole unit (100 for USD), so a
 * currency with another number of decimals still lands on hundredths.
 */
export function rampMinorToCents(value: unknown, rate: unknown = 100): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  const per = typeof rate === "number" && Number.isSafeInteger(rate) && rate > 0 ? rate : 100;
  const cents = roundHalfAway(Number(((value * 100) / per).toFixed(6)));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * A dollar amount Ramp sends as a decimal number, in hundredths. `7.76 * 100`
 * is `775.9999…` in floating point, so the product is rounded at six places
 * before it is rounded to a whole cent.
 */
export function rampDollarsToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = roundHalfAway(Number((value * 100).toFixed(6)));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A transaction's settled amount in hundredths, signed as Ramp signs it, and its currency. */
export function rampTransactionAmount(
  transaction: RampTransaction,
): { cents: number; currency: string } | null {
  const settled = transaction.entity_amount;
  if (settled && settled.currency) {
    const cents = rampMinorToCents(settled.value, transaction.minor_unit_conversion_rate);
    return cents === null ? null : { cents, currency: settled.currency.toUpperCase() };
  }
  // Older transactions may carry only Ramp's deprecated whole-unit amount,
  // whose sign isn't documented: a refund names the purchase it refunds.
  const cents = rampDollarsToCents(transaction.amount);
  if (cents === null || !transaction.currency_code) return null;
  const magnitude = Math.abs(cents);
  return {
    cents: transaction.original_transaction_id ? -magnitude : cents,
    currency: transaction.currency_code.toUpperCase(),
  };
}

/** Where a card was used, as the statement says it. */
export function describeRampTransaction(transaction: RampTransaction): string {
  return (
    transaction.merchant_name?.trim() || transaction.merchant_descriptor?.trim() || "Ramp card transaction"
  );
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function readTime(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = typeof value === "string" && value.trim() ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new Error(`${field} must be an RFC 3339 date-time`);
  return date;
}

/** Whole units for an AI Employee to read: 1234 cents is 12.34. */
function units(amount: RampCurrencyAmount | null | undefined): number | null {
  const cents = rampMinorToCents(amount?.amount, amount?.minor_unit_conversion_rate);
  return cents === null ? null : cents / 100;
}

function cardHolderName(holder: RampCardHolder | null | undefined): string | null {
  const name = [holder?.first_name, holder?.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

/** How many smallest units make one whole unit of a currency: 100 for USD, 1 for JPY. */
function minorUnitsPerWhole(currency: string): number {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits;
    return 10 ** (digits ?? 2);
  } catch {
    return 100;
  }
}

function summarizeTransaction(transaction: RampTransaction) {
  const settled = rampTransactionAmount(transaction);
  const merchant = transaction.merchant_amount;
  // The merchant's currency can have another number of decimals than the
  // business's, which is what `minor_unit_conversion_rate` describes.
  const merchantCents =
    merchant?.currency && merchant.currency !== settled?.currency
      ? rampMinorToCents(merchant.value, minorUnitsPerWhole(merchant.currency))
      : null;
  return {
    id: transaction.id,
    state: transaction.state ?? null,
    amount: settled ? settled.cents / 100 : null,
    currency: settled?.currency ?? null,
    merchantAmount:
      merchant?.currency && merchantCents !== null
        ? { amount: merchantCents / 100, currency: merchant.currency }
        : null,
    transactionTime: transaction.user_transaction_time ?? null,
    settlementDate: transaction.settlement_date ?? null,
    merchant: describeRampTransaction(transaction),
    merchantCategory: transaction.sk_category_name ?? null,
    cardId: transaction.card_id ?? null,
    cardholder: cardHolderName(transaction.card_holder),
    department: transaction.card_holder?.department_name ?? null,
    memo: transaction.memo ?? null,
    refundOf: transaction.original_transaction_id ?? null,
  };
}

function summarizeTransfer(transfer: RampTransfer) {
  return {
    id: transfer.id,
    status: transfer.status ?? null,
    amount: units(transfer.amount),
    currency: transfer.amount?.currency_code ?? null,
    createdAt: transfer.created_at ?? null,
  };
}

function summarizeCashback(cashback: RampCashback) {
  return {
    id: cashback.id,
    amount: units(cashback.amount),
    currency: cashback.amount?.currency_code ?? null,
    createdAt: cashback.created_at ?? null,
  };
}

function summarizeBalance(balance: RampBalance) {
  return {
    cardBalance: units(balance.card_balance_excluding_pending_amount),
    cardBalanceWithPending: units(balance.card_balance_including_pending_amount),
    statementBalance: units(balance.statement_balance_amount),
    availableCardLimit: units(balance.available_card_limit_amount),
    cardLimit: units(balance.card_limit_amount),
    currency: balance.card_limit_amount?.currency_code ?? "USD",
    nextBillingDate: balance.next_billing_date ?? null,
    previousBillingDate: balance.prev_billing_date ?? null,
  };
}

function readConfig(input: Record<string, string>): RampConfig {
  const clientId = (input.clientId ?? "").trim();
  const clientSecret = (input.clientSecret ?? "").trim();
  if (!clientId) throw new Error("Client ID is required");
  if (!clientSecret) throw new Error("Client secret is required");
  return { clientId, clientSecret };
}

/**
 * Prove the client can read with every scope Genosyn asks for, and name the
 * business. A fresh token, so a secret that changed is tried as it is now.
 */
async function checkClient(cfg: RampConfig): Promise<RampBusiness> {
  await rampAccessToken(cfg, true);
  const business = await getRampBusiness(cfg);
  await getRampTransactionsPage(cfg, { pageSize: 2 });
  await getRampTransfersPage(cfg, { pageSize: 2 });
  await getRampCashbacksPage(cfg, { pageSize: 2 });
  return business;
}

const PAGE_PROPERTIES = {
  pageSize: { type: "integer", minimum: 2, maximum: RAMP_PAGE_SIZE },
  start: { type: "string", description: "nextCursor from the previous page." },
};

export const rampProvider: IntegrationProvider = {
  catalog: {
    provider: "ramp",
    name: "Ramp",
    category: "Payments",
    tagline: "Corporate card transactions, bill payments, cashback, and the card balance.",
    description: `Connect Ramp with a developer app's client ID and secret, from Company → Developer in Ramp. Add the Client Credentials grant type to the app and allow the ${RAMP_SCOPES.join(", ")} scopes. Genosyn only reads — it never issues cards, changes limits, or moves money.`,
    icon: "CreditCard",
    authMode: "apikey",
    fields: [
      {
        key: "clientId",
        label: "Client ID",
        type: "text",
        placeholder: "ramp_id_…",
        required: true,
        hint: "From the developer app you created in Ramp under Company → Developer.",
      },
      {
        key: "clientSecret",
        label: "Client secret",
        type: "password",
        placeholder: "ramp_sec_…",
        required: true,
        hint: `The app needs the Client Credentials grant type and the ${RAMP_SCOPES.join(", ")} scopes.`,
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_transactions",
      description:
        "List one page of Ramp card transactions with the merchant, its category, the cardholder and the card. Amounts are what settled to the business, in its currency: a purchase is positive, a refund negative. Only CLEARED transactions have settled. Follow nextCursor as `start` for the next page, keeping the other inputs the same.",
      inputSchema: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "RFC 3339 lower bound for when the card was used." },
          toDate: { type: "string", description: "RFC 3339 upper bound for when the card was used." },
          state: {
            type: "string",
            enum: ["CLEARED", "COMPLETION", "PENDING", "PENDING_INITIATION", "DECLINED", "ERROR", "ALL"],
            description: "Only transactions in this state. Left out, every state but DECLINED.",
          },
          cardId: { type: "string", description: "Only transactions on this physical card." },
          ...PAGE_PROPERTIES,
        },
        additionalProperties: false,
      },
    },
    {
      name: "list_bill_payments",
      description:
        "List one page of the payments made from the business's bank account to settle its Ramp bill, with their status. COMPLETED payments reached Ramp. Follow nextCursor as `start` for the next page.",
      inputSchema: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "RFC 3339 lower bound for when the payment was made." },
          toDate: { type: "string", description: "RFC 3339 upper bound for when the payment was made." },
          ...PAGE_PROPERTIES,
        },
        additionalProperties: false,
      },
    },
    {
      name: "list_cashbacks",
      description:
        "List one page of the cashback Ramp credited to the business's card balance. Follow nextCursor as `start` for the next page.",
      inputSchema: {
        type: "object",
        properties: {
          fromDate: { type: "string", description: "RFC 3339 lower bound for when it was credited." },
          toDate: { type: "string", description: "RFC 3339 upper bound for when it was credited." },
          ...PAGE_PROPERTIES,
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_card_balance",
      description:
        "Read what the business owes on its Ramp cards now and on its last statement, its card limit and what is left of it, and its billing dates.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const cfg = readConfig(input);
    const business = await checkClient(cfg);
    return {
      config: cfg satisfies RampConfig,
      accountHint: `${rampBusinessName(business)} · ${maskSecret(cfg.clientId)}`,
    };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as RampConfig;
    try {
      await checkClient(cfg);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof ConnectionAuthError ? { status: err.connectionStatus } : {}),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as RampConfig;
    const input = (args as Record<string, unknown>) ?? {};
    if (name === "get_card_balance") return summarizeBalance(await getRampBalance(cfg));
    const page: RampPageOptions = {
      pageSize: clampInt(input.pageSize, 2, RAMP_PAGE_SIZE, 50),
      start: typeof input.start === "string" && input.start.trim() ? input.start.trim() : undefined,
      fromDate: readTime(input.fromDate, "fromDate"),
      toDate: readTime(input.toDate, "toDate"),
    };
    if (name === "list_transactions") {
      const result = await getRampTransactionsPage(cfg, {
        ...page,
        state: typeof input.state === "string" && input.state.trim() ? input.state.trim() : undefined,
        cardId: typeof input.cardId === "string" && input.cardId.trim() ? input.cardId.trim() : undefined,
      });
      return { items: result.data.map(summarizeTransaction), nextCursor: rampNextCursor(result) };
    }
    if (name === "list_bill_payments") {
      const result = await getRampTransfersPage(cfg, page);
      return { items: result.data.map(summarizeTransfer), nextCursor: rampNextCursor(result) };
    }
    if (name === "list_cashbacks") {
      const result = await getRampCashbacksPage(cfg, page);
      return { items: result.data.map(summarizeCashback), nextCursor: rampNextCursor(result) };
    }
    throw new Error(`Unknown Ramp tool: ${name}`);
  },
};
