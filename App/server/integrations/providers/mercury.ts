import { roundHalfAway } from "../../lib/money.js";
import { maskSecret } from "../../lib/secret.js";
import { ProviderRequestError, parseRetryAfter } from "../providerErrors.js";
import { ConnectionAuthError, type IntegrationProvider } from "../types.js";

/**
 * Mercury — a read-only, API-key integration for a Mercury business bank
 * account's accounts and transactions. An admin creates a Read Only API token
 * in Mercury (Settings → Tokens) and pastes it into a Connection; Genosyn
 * talks to Mercury directly, with no aggregator in between, and never sends,
 * moves or requests money. A Read Only token needs no IP whitelist, and a
 * token Genosyn keeps syncing never goes 45 days unused, which is when Mercury
 * deletes one.
 */

const MERCURY_API = "https://api.mercury.com";
const API_ROOT = "/api/v1";
const REQUEST_TIMEOUT_MS = 30_000;
/** Mercury answers at most this many accounts or transactions a page. */
export const MERCURY_PAGE_LIMIT = 1000;
/** Every token Mercury issues starts with this, and Mercury wants it sent. */
const TOKEN_PREFIX = "secret-token:";
/** What a transaction's status can be. Only `sent` has settled. */
export const MERCURY_TRANSACTION_STATUSES = [
  "pending",
  "sent",
  "cancelled",
  "failed",
  "reversed",
  "blocked",
] as const;
/** A backstop against a page loop that never ends. */
const MAX_PAGES = 10_000;

export type MercuryConfig = {
  apiToken: string;
};

export type MercuryAccount = {
  id: string;
  name: string;
  nickname?: string | null;
  /** `active`, `deleted`, `pending`, `archived`. */
  status: string;
  /** `mercury` for an account at Mercury; `external` or `recipient` otherwise. */
  type?: string | null;
  /** `checking`, `savings`, … */
  kind?: string | null;
  accountNumber?: string | null;
  routingNumber?: string | null;
  /** Dollars, as a decimal number: what is settled, less pending debits. */
  availableBalance?: number | null;
  /** Dollars, as a decimal number: every settled transaction. */
  currentBalance?: number | null;
  createdAt?: string | null;
  legalBusinessName?: string | null;
  dashboardLink?: string | null;
};

export type MercuryTransaction = {
  id: string;
  accountId?: string | null;
  /** Dollars, as a decimal number: money in positive, money out negative. */
  amount: number;
  /** One of `MERCURY_TRANSACTION_STATUSES`. */
  status: string;
  createdAt: string;
  /** When it posted to the account; null until it does. */
  postedAt?: string | null;
  kind?: string | null;
  counterpartyId?: string | null;
  counterpartyName?: string | null;
  counterpartyNickname?: string | null;
  bankDescription?: string | null;
  note?: string | null;
  externalMemo?: string | null;
  dashboardLink?: string | null;
  failedAt?: string | null;
  reasonForFailure?: string | null;
  mercuryCategory?: string | null;
  cardId?: string | null;
  checkNumber?: string | null;
  details?: unknown;
};

type MercuryPage = { nextPage?: string | null; previousPage?: string | null } | null | undefined;

export type MercuryTransactionsPage = {
  transactions: MercuryTransaction[];
  /** The cursor for the page after this one, or null on the last. */
  nextCursor: string | null;
};

/** Mercury refused a request, or never answered it (`status` 0). */
export class MercuryApiError extends ProviderRequestError {
  constructor(message: string, status: number, retryAfterMs: number | null = null, request = "") {
    super(message, "Mercury", status, retryAfterMs, request);
    this.name = "MercuryApiError";
  }
}

export const MERCURY_TOKEN_REJECTED =
  "Mercury rejected the API token. Copy it again, or create a new Read Only token in Mercury under Settings → Tokens.";

/**
 * The token as Mercury wants it sent. Mercury shows a token with its
 * `secret-token:` prefix, and a copy that left the prefix behind still works.
 */
export function normalizeMercuryToken(value: string): string {
  const token = value.trim();
  return token && !token.startsWith(TOKEN_PREFIX) && token.startsWith("mercury_")
    ? `${TOKEN_PREFIX}${token}`
    : token;
}

/** Mercury's own words for a failure, from whichever error shape it answered with. */
function mercuryDetail(parsed: unknown, text: string): string | null {
  if (parsed && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    for (const block of [body.errors, body.error, body]) {
      if (typeof block === "string" && block.trim()) return block.trim();
      const message = (block as { message?: unknown } | null)?.message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    return null;
  }
  const trimmed = text.trim();
  // An HTML error page from a proxy says nothing a person can use.
  return trimmed && !trimmed.startsWith("<") ? trimmed.slice(0, 300) : null;
}

function mercuryError(res: Response, request: string, parsed: unknown, text: string): Error {
  const detail = mercuryDetail(parsed, text);
  if (res.status === 401) return new ConnectionAuthError(MERCURY_TOKEN_REJECTED, "expired");
  if (res.status === 403) {
    return new MercuryApiError(
      `Mercury refused the request${detail ? `: ${detail}` : ""}. Check that the token can read accounts and transactions — a Read Only token can.`,
      403,
      null,
      request,
    );
  }
  if (res.status === 404) {
    return new MercuryApiError(
      "Mercury couldn't find that account. It may have been closed, or this token can't see it.",
      404,
      null,
      request,
    );
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    return new MercuryApiError(
      Number.isFinite(seconds) && seconds > 0
        ? `Mercury is limiting how fast it answers. Try again in ${Math.ceil(seconds)} seconds.`
        : "Mercury is limiting how fast it answers. Try again in a minute.",
      429,
      parseRetryAfter(res.headers.get("retry-after")),
      request,
    );
  }
  return new MercuryApiError(
    detail ? `Mercury ${res.status}: ${detail}` : `Mercury ${res.status} ${res.statusText}`.trim(),
    res.status,
    parseRetryAfter(res.headers.get("retry-after")),
    request,
  );
}

type Params = Record<string, string | number | readonly string[] | undefined>;

async function mercuryGet(apiToken: string, path: string, params: Params = {}): Promise<unknown> {
  const url = new URL(`${API_ROOT}${path}`, MERCURY_API);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    // A list is the same parameter repeated, as Mercury reads one.
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, item);
    else url.searchParams.set(key, String(value));
  }
  const request = `GET ${API_ROOT}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new MercuryApiError(
        `Mercury didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again.`,
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
  if (!res.ok) throw mercuryError(res, request, parsed, text);
  return parsed;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Mercury account id as the API takes it: a uuid, never a path of its own. */
export function readMercuryId(value: unknown, field: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!UUID.test(id)) throw new Error(`${field} must be a Mercury account id`);
  return id;
}

function nextCursor(page: MercuryPage, what: string, seen: Set<string>): string | null {
  const next = page?.nextPage;
  if (!next) return null;
  if (seen.has(next)) throw new Error(`Mercury returned a repeated ${what} cursor`);
  seen.add(next);
  return next;
}

/** Every account the token can read — at Mercury or not, open or closed. */
export async function listMercuryAccounts(apiToken: string): Promise<MercuryAccount[]> {
  const accounts: MercuryAccount[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = (await mercuryGet(apiToken, "/accounts", {
      limit: MERCURY_PAGE_LIMIT,
      start_after: cursor,
    })) as { accounts?: unknown; page?: MercuryPage } | null;
    if (!body || !Array.isArray(body.accounts)) {
      throw new Error("Mercury returned an unexpected account list");
    }
    for (const account of body.accounts as MercuryAccount[]) {
      if (typeof account?.id !== "string" || !account.id) {
        throw new Error("Mercury returned an account without an id");
      }
      accounts.push(account);
    }
    const next = body.accounts.length > 0 ? nextCursor(body.page, "account", seen) : null;
    if (!next) return accounts;
    cursor = next;
  }
  throw new Error("Mercury kept returning account pages");
}

/** An account held at Mercury, rather than an external account or a payee Mercury lists. */
export function isMercuryOwnAccount(account: MercuryAccount): boolean {
  return !account.type || account.type.toLowerCase() === "mercury";
}

export function isOpenMercuryAccount(account: MercuryAccount): boolean {
  const status = (account.status ?? "").toLowerCase();
  return status !== "deleted" && status !== "archived";
}

/**
 * One page of transactions, oldest first unless `order` says otherwise.
 * `start`/`end` bound when a transaction was created; `postedStart` when it
 * posted, which is what a sync that comes back for late settlers needs.
 * Without `start`, Mercury reads from the account's first transaction.
 */
export async function getMercuryTransactionsPage(
  apiToken: string,
  options: {
    accountId?: string;
    statuses?: readonly string[];
    start?: string;
    end?: string;
    postedStart?: string;
    search?: string;
    order?: "asc" | "desc";
    limit?: number;
    /** The cursor from the previous page. */
    cursor?: string;
  } = {},
): Promise<MercuryTransactionsPage> {
  const body = (await mercuryGet(apiToken, "/transactions", {
    accountId: options.accountId ? [readMercuryId(options.accountId, "accountId")] : undefined,
    status: options.statuses,
    start: options.start,
    end: options.end,
    postedStart: options.postedStart,
    search: options.search,
    order: options.order ?? "asc",
    limit: options.limit ?? MERCURY_PAGE_LIMIT,
    start_after: options.cursor,
  })) as { transactions?: unknown; page?: MercuryPage } | null;
  if (!body || !Array.isArray(body.transactions)) {
    throw new Error("Mercury returned a transaction page without transactions");
  }
  const transactions = body.transactions as MercuryTransaction[];
  return {
    transactions,
    nextCursor: transactions.length > 0 ? (body.page?.nextPage ?? null) : null,
  };
}

/** The account's name as Mercury's dashboard shows it. */
export function mercuryAccountName(account: MercuryAccount): string {
  return account.nickname?.trim() || account.name?.trim() || `Mercury account ${account.id.slice(0, 8)}`;
}

/** The last four digits of an account number, never the rest. */
export function mercuryLast4(account: MercuryAccount): string | null {
  const digits = (account.accountNumber ?? "").replace(/\D/g, "");
  return digits ? digits.slice(-4) : null;
}

/**
 * A Mercury amount in the integer hundredths the books keep. Mercury sends
 * dollars as decimal numbers, and `7.76 * 100` is `775.9999…` in floating
 * point, so the product is rounded at six places before it is rounded to a
 * whole cent.
 */
export function mercuryAmountCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = roundHalfAway(Number((value * 100).toFixed(6)));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** A transaction's description: who it was with, else what the bank called it. */
export function describeMercuryTransaction(transaction: MercuryTransaction): string {
  return (
    transaction.counterpartyNickname?.trim() ||
    transaction.counterpartyName?.trim() ||
    transaction.bankDescription?.trim() ||
    "Mercury transaction"
  );
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** A date an AI Employee passed to a tool: a calendar day or an RFC 3339 time. */
function readDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value.trim() : "";
  const day = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const at = text ? new Date(day ? `${text}T00:00:00.000Z` : text) : null;
  if (!at || Number.isNaN(at.getTime())) {
    throw new Error(`${field} must be a date (YYYY-MM-DD) or an RFC 3339 date-time`);
  }
  return day ? text : at.toISOString();
}

/** An account for an AI Employee: the last four digits, never the routing number. */
function summarizeAccount(account: MercuryAccount) {
  return {
    accountId: account.id,
    name: mercuryAccountName(account),
    kind: account.kind ?? null,
    status: account.status ?? null,
    accountNumberLast4: mercuryLast4(account),
    availableBalance: account.availableBalance ?? null,
    currentBalance: account.currentBalance ?? null,
    currency: "USD",
  };
}

/** A transaction for an AI Employee: no counterparty account or routing numbers. */
function summarizeTransaction(transaction: MercuryTransaction) {
  return {
    id: transaction.id,
    accountId: transaction.accountId ?? null,
    status: transaction.status,
    kind: transaction.kind ?? null,
    amount: transaction.amount,
    currency: "USD",
    createdAt: transaction.createdAt,
    postedAt: transaction.postedAt ?? null,
    description: describeMercuryTransaction(transaction),
    counterparty: transaction.counterpartyName ?? null,
    bankDescription: transaction.bankDescription ?? null,
    note: transaction.note ?? null,
    externalMemo: transaction.externalMemo ?? null,
    category: transaction.mercuryCategory ?? null,
    failedAt: transaction.failedAt ?? null,
    reasonForFailure: transaction.reasonForFailure ?? null,
    dashboardLink: transaction.dashboardLink ?? null,
  };
}

/** The first open account at Mercury the token reads — the one a check asks about. */
function firstOpenAccount(accounts: MercuryAccount[]): MercuryAccount | undefined {
  return accounts.find((account) => isMercuryOwnAccount(account) && isOpenMercuryAccount(account));
}

/** Prove the token reads accounts and transactions, and return the account it read. */
async function checkToken(apiToken: string): Promise<MercuryAccount> {
  const first = firstOpenAccount(await listMercuryAccounts(apiToken));
  if (!first) throw new Error("Mercury returned no open accounts for this token.");
  await getMercuryTransactionsPage(apiToken, { accountId: first.id, limit: 1 });
  return first;
}

export const mercuryProvider: IntegrationProvider = {
  catalog: {
    provider: "mercury",
    name: "Mercury",
    category: "Payments",
    tagline: "Business checking and savings accounts, and their transactions.",
    description:
      "Connect your Mercury account with a Read Only API token from Settings → Tokens. Genosyn only reads accounts, balances and transactions — it never sends or moves money.",
    icon: "Landmark",
    authMode: "apikey",
    fields: [
      {
        key: "apiToken",
        label: "API token",
        type: "password",
        placeholder: "secret-token:mercury_production_…",
        required: true,
        hint: "Create a Read Only token in Mercury under Settings → Tokens, and paste all of it.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_accounts",
      description:
        "List the Mercury accounts this token can read — checking, savings and others — with their available and current balances in US dollars. Account numbers show only their last four digits; routing numbers are left out.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_transactions",
      description:
        "List one page of Mercury transactions, newest first — on one account, or on every account when accountId is left out. Amounts are US dollars: money in is positive, money out negative. Only `sent` transactions have settled; `pending` ones can still fail. Follow nextCursor as `cursor` for the next page, keeping the other inputs the same.",
      inputSchema: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "Mercury account id from list_accounts." },
          start: {
            type: "string",
            description: "Earliest creation date, YYYY-MM-DD or RFC 3339. Left out, from the first transaction.",
          },
          end: { type: "string", description: "Latest creation date, YYYY-MM-DD or RFC 3339." },
          status: {
            type: "string",
            enum: [...MERCURY_TRANSACTION_STATUSES],
            description: "Only transactions in this state.",
          },
          search: {
            type: "string",
            description: "Words to find in descriptions, notes, memos and counterparty names.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: MERCURY_PAGE_LIMIT,
            description: "Most transactions to return (default 100).",
          },
          cursor: { type: "string", description: "nextCursor from the previous page." },
        },
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const apiToken = normalizeMercuryToken(input.apiToken ?? "");
    if (!apiToken) throw new Error("API token is required");
    const first = await checkToken(apiToken);
    const business = first.legalBusinessName?.trim() || mercuryAccountName(first);
    return {
      config: { apiToken } satisfies MercuryConfig,
      accountHint: `${business} · ${maskSecret(apiToken)}`,
    };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as MercuryConfig;
    try {
      await checkToken(cfg.apiToken);
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
    const cfg = ctx.config as MercuryConfig;
    const input = (args as Record<string, unknown>) ?? {};
    if (name === "list_accounts") {
      const accounts = await listMercuryAccounts(cfg.apiToken);
      return { items: accounts.filter(isMercuryOwnAccount).map(summarizeAccount) };
    }
    if (name === "list_transactions") {
      const status = typeof input.status === "string" ? input.status : undefined;
      if (status && !(MERCURY_TRANSACTION_STATUSES as readonly string[]).includes(status)) {
        throw new Error(`status must be one of ${MERCURY_TRANSACTION_STATUSES.join(", ")}`);
      }
      const page = await getMercuryTransactionsPage(cfg.apiToken, {
        accountId:
          input.accountId === undefined ? undefined : readMercuryId(input.accountId, "accountId"),
        statuses: status ? [status] : undefined,
        start: readDate(input.start, "start"),
        end: readDate(input.end, "end"),
        search: typeof input.search === "string" && input.search.trim() ? input.search.trim() : undefined,
        order: "desc",
        limit: clampInt(input.limit, 1, MERCURY_PAGE_LIMIT, 100),
        cursor: typeof input.cursor === "string" && input.cursor.trim() ? input.cursor.trim() : undefined,
      });
      return {
        items: page.transactions.map(summarizeTransaction),
        nextCursor: page.nextCursor,
      };
    }
    throw new Error(`Unknown Mercury tool: ${name}`);
  },
};
