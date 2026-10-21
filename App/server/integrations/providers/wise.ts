import { roundHalfAway } from "../../lib/money.js";
import { maskSecret } from "../../lib/secret.js";
import { ConnectionAuthError, type IntegrationProvider } from "../types.js";

/**
 * Wise — a read-only, API-key integration for a Wise business account's
 * balances and balance statements. A Member creates a personal API token in
 * Wise (Your Account → Connect and manage apps → API tokens) and pastes it
 * into a Connection; Genosyn talks to Wise directly, with no aggregator in
 * between, and never sends, converts or funds anything.
 *
 * Requests are pinned to one of Wise's calendar API versions. Wise ships
 * breaking changes only in a new version, so moving to one is a deliberate
 * edit of `WISE_API_VERSION`, never a surprise.
 *
 * Wise releases balance statements to a personal API token only for business
 * accounts based in the US, Canada, Australia, New Zealand, Singapore and
 * Malaysia. Anywhere else the statement call answers 403 with a Strong
 * Customer Authentication challenge (`x-2fa-approval`) that a personal token
 * cannot complete, and `WiseScaRequiredError` turns that into a sentence a
 * person can act on instead of a bare 403.
 */

const WISE_API = "https://api.wise.com";
export const WISE_API_VERSION = "2026Q4";
/** Wise refuses a statement whose interval is longer than this. */
export const WISE_STATEMENT_MAX_DAYS = 469;
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

export type WiseConfig = {
  apiToken: string;
};

export type WiseMoney = {
  value: number;
  currency: string;
};

export type WiseProfile = {
  id: number;
  type: string;
  fullName?: string | null;
  businessName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  currentState?: string | null;
  address?: { countryIso2Code?: string | null } | null;
};

export type WiseBalance = {
  id: number;
  currency: string;
  type: string;
  name?: string | null;
  amount: WiseMoney;
  reservedAmount?: WiseMoney | null;
  cashAmount?: WiseMoney | null;
  totalWorth?: WiseMoney | null;
  investmentState?: string | null;
  creationTime?: string | null;
  modificationTime?: string | null;
  visible?: boolean | null;
};

export type WiseStatementTransaction = {
  type: string;
  date: string;
  amount: WiseMoney;
  totalFees?: WiseMoney | null;
  details?: {
    type?: string | null;
    description?: string | null;
    senderName?: string | null;
    senderAccount?: string | null;
    paymentReference?: string | null;
    category?: string | null;
    merchant?: { name?: string | null } | null;
  } | null;
  exchangeDetails?: unknown;
  runningBalance?: WiseMoney | null;
  referenceNumber?: string | null;
};

export type WiseStatement = {
  transactions: WiseStatementTransaction[];
  endOfStatementBalance?: WiseMoney | null;
};

export class WiseApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WiseApiError";
  }
}

export const WISE_SCA_MESSAGE =
  "Wise asked for Strong Customer Authentication before releasing this statement, which a personal API token can't complete. Wise releases balance statements to a personal API token only for business accounts based in the US, Canada, Australia, New Zealand, Singapore and Malaysia.";

/** A statement Wise holds back until someone completes Strong Customer Authentication. */
export class WiseScaRequiredError extends WiseApiError {
  constructor() {
    super(WISE_SCA_MESSAGE, 403);
    this.name = "WiseScaRequiredError";
  }
}

/** Wise's own words for a failure, from whichever error shape it answered with. */
function wiseDetail(parsed: unknown, text: string): string | null {
  if (parsed && typeof parsed === "object") {
    const body = parsed as Record<string, unknown>;
    if (Array.isArray(body.errors)) {
      for (const error of body.errors) {
        const message = (error as { message?: unknown } | null)?.message;
        if (typeof message === "string" && message.trim()) return message.trim();
      }
    }
    for (const key of ["message", "error_description", "error"]) {
      const value = body[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }
  const trimmed = text.trim();
  // An HTML error page from a proxy says nothing a person can use.
  return trimmed && !trimmed.startsWith("<") ? trimmed.slice(0, 300) : null;
}

function wiseError(res: Response, path: string, parsed: unknown, text: string): Error {
  const detail = wiseDetail(parsed, text);
  if (res.status === 401) {
    // A 401 can also mean this token may not read one profile. Only a token
    // Wise calls invalid, or one refused for the profile list itself, is
    // dead — the Connection must not go red over a mistyped profile id.
    const code = (parsed as { error?: unknown } | null)?.error;
    if (code === "invalid_token" || path === "/profiles") {
      return new ConnectionAuthError(
        "Wise rejected the API token. Copy it again, or create a new one in Wise under Your Account → Connect and manage apps → API tokens.",
        "expired",
      );
    }
    return new WiseApiError(
      `Wise won't let this token read that profile${detail ? ` (${detail})` : ""}. Check the profile id.`,
      401,
    );
  }
  if (
    res.status === 403 &&
    (res.headers.get("x-2fa-approval") ||
      res.headers.get("x-2fa-approval-result")?.toUpperCase() === "REJECTED")
  ) {
    return new WiseScaRequiredError();
  }
  if (res.status === 403) {
    return new WiseApiError(
      `Wise refused the request${detail ? `: ${detail}` : ""}. Check that the token belongs to this profile and can read its balances.`,
      403,
    );
  }
  if (res.status === 404) {
    return new WiseApiError(
      "Wise couldn't find that profile or balance. It may have been closed, or this token can't see it.",
      404,
    );
  }
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    return new WiseApiError(
      Number.isFinite(seconds) && seconds > 0
        ? `Wise is limiting how fast it answers. Try again in ${Math.ceil(seconds)} seconds.`
        : "Wise is limiting how fast it answers. Try again in a minute.",
      429,
    );
  }
  return new WiseApiError(
    detail ? `Wise ${res.status}: ${detail}` : `Wise ${res.status} ${res.statusText}`.trim(),
    res.status,
  );
}

async function wiseGet(
  apiToken: string,
  path: string,
  params: Record<string, string | undefined> = {},
): Promise<unknown> {
  const url = new URL(`/${WISE_API_VERSION}${path}`, WISE_API);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json", Authorization: `Bearer ${apiToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Wise didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again.`);
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
  if (!res.ok) throw wiseError(res, path, parsed, text);
  return parsed;
}

/** Wise ids are int64. Past 2^53 JSON numbers lose digits, so such an id is refused, not misread. */
function safeId(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Wise returned a ${what} id Genosyn can't read safely`);
  }
  return value;
}

/** A profile or balance id as the API path takes it: digits only. */
export function readWiseId(value: unknown, field: string): string {
  const id =
    typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  if (!/^\d+$/.test(id)) throw new Error(`${field} must be a Wise id (digits only)`);
  return id;
}

export async function listWiseProfiles(apiToken: string): Promise<WiseProfile[]> {
  const profiles = await wiseGet(apiToken, "/profiles");
  if (!Array.isArray(profiles)) throw new Error("Wise returned an unexpected profile list");
  return profiles.map((profile: WiseProfile) => ({ ...profile, id: safeId(profile?.id, "profile") }));
}

/** Profiles a company can still keep books for — a deactivated one has no balances to read. */
export function activeWiseProfiles(profiles: WiseProfile[]): WiseProfile[] {
  return profiles.filter((profile) => (profile.currentState ?? "").toUpperCase() !== "DEACTIVATED");
}

/** A profile's balances, one per currency. Jars (`SAVINGS`) are left out. */
export async function listWiseBalances(
  apiToken: string,
  profileId: string | number,
): Promise<WiseBalance[]> {
  const id = readWiseId(profileId, "profileId");
  const balances = await wiseGet(apiToken, `/profiles/${id}/balances`, { types: "STANDARD" });
  if (!Array.isArray(balances)) throw new Error("Wise returned an unexpected balance list");
  return balances.map((balance: WiseBalance) => {
    if (typeof balance?.currency !== "string" || !/^[A-Z]{3}$/.test(balance.currency)) {
      throw new Error("Wise returned a balance without a currency");
    }
    return { ...balance, id: safeId(balance.id, "balance") };
  });
}

function readTime(value: unknown, field: string): Date {
  const date = typeof value === "string" && value.trim() ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be an RFC 3339 date-time`);
  }
  return date;
}

/** Refuse, before asking, an interval Wise would refuse. */
function checkStatementInterval(intervalStart: Date, intervalEnd: Date): void {
  if (!(intervalEnd.getTime() > intervalStart.getTime())) {
    throw new Error("intervalEnd must be after intervalStart");
  }
  if (intervalEnd.getTime() - intervalStart.getTime() > WISE_STATEMENT_MAX_DAYS * DAY_MS) {
    throw new Error(`A Wise statement covers at most ${WISE_STATEMENT_MAX_DAYS} days`);
  }
}

/**
 * One balance's statement between two times, one line per transaction with
 * its fees folded in (`COMPACT`). Wise answers with the whole interval at
 * once — there is no paging — and refuses one longer than 469 days.
 */
export async function getWiseBalanceStatement(
  apiToken: string,
  profileId: string | number,
  balanceId: string | number,
  options: { currency: string; intervalStart: Date; intervalEnd: Date },
): Promise<WiseStatement> {
  const profile = readWiseId(profileId, "profileId");
  const balance = readWiseId(balanceId, "balanceId");
  const { intervalStart, intervalEnd } = options;
  checkStatementInterval(intervalStart, intervalEnd);
  const statement = (await wiseGet(
    apiToken,
    `/profiles/${profile}/balance-statements/${balance}/statement.json`,
    {
      currency: options.currency,
      intervalStart: intervalStart.toISOString(),
      intervalEnd: intervalEnd.toISOString(),
      type: "COMPACT",
    },
  )) as WiseStatement | null;
  if (!statement || !Array.isArray(statement.transactions)) {
    throw new Error("Wise returned a statement without transactions");
  }
  return statement;
}

export function wiseProfileName(profile: WiseProfile): string {
  const person = [profile.firstName, profile.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return (
    profile.businessName?.trim() || profile.fullName?.trim() || person || `Wise profile ${profile.id}`
  );
}

/**
 * A Wise amount in the integer hundredths the books keep. Wise sends decimal
 * values, and `7.76 * 100` is `775.9999…` in floating point, so the product is
 * rounded at six places before it is rounded to a whole cent.
 */
export function wiseAmountCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = roundHalfAway(Number((value * 100).toFixed(6)));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * What makes a statement line itself, for dedupe across syncs. Wise's
 * reference number alone is not enough — a refund carries the reference of
 * the transfer it reverses — so the direction and the moment it happened
 * come with it.
 */
export function wiseTransactionKey(
  transaction: WiseStatementTransaction,
  date: Date,
  cents: number,
): string {
  const direction = transaction.type?.trim().toUpperCase() || (cents < 0 ? "DEBIT" : "CREDIT");
  const reference =
    transaction.referenceNumber?.trim() || `${transaction.details?.type ?? "UNKNOWN"}#${cents}`;
  return `${reference}|${direction}|${date.toISOString()}`;
}

/** A line's description: Wise's own, else who paid or where the card was used. */
export function describeWiseTransaction(transaction: WiseStatementTransaction): string {
  const details = transaction.details ?? {};
  const description = details.description?.trim();
  if (description) return description;
  const merchant = details.merchant?.name?.trim();
  if (merchant) return merchant;
  const sender = details.senderName?.trim();
  if (sender) {
    const reference = details.paymentReference?.trim();
    return reference
      ? `Received money from ${sender} with reference ${reference}`
      : `Received money from ${sender}`;
  }
  const reference = transaction.referenceNumber?.trim();
  return reference ? `Wise ${reference}` : "Wise transaction";
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function summarizeProfile(profile: WiseProfile) {
  return {
    profileId: String(profile.id),
    type: profile.type,
    name: wiseProfileName(profile),
    country: profile.address?.countryIso2Code ?? null,
    state: profile.currentState ?? null,
  };
}

function summarizeBalance(profile: WiseProfile, balance: WiseBalance) {
  return {
    profileId: String(profile.id),
    profileName: wiseProfileName(profile),
    balanceId: String(balance.id),
    currency: balance.currency,
    name: balance.name ?? null,
    available: balance.amount?.value ?? null,
    reserved: balance.reservedAmount?.value ?? null,
    totalWorth: balance.totalWorth?.value ?? null,
    investmentState: balance.investmentState ?? null,
  };
}

/** A statement line for an AI Employee: no payer bank account numbers. */
function summarizeTransaction(transaction: WiseStatementTransaction) {
  const details = transaction.details ?? {};
  return {
    referenceNumber: transaction.referenceNumber ?? null,
    type: transaction.type,
    date: transaction.date,
    amount: transaction.amount?.value ?? null,
    currency: transaction.amount?.currency ?? null,
    fees: transaction.totalFees?.value ?? 0,
    description: describeWiseTransaction(transaction),
    kind: details.type ?? null,
    counterparty: details.senderName ?? details.merchant?.name ?? null,
    paymentReference: details.paymentReference ?? null,
    runningBalance: transaction.runningBalance?.value ?? null,
  };
}

/** The first business profile the token reads, else the first profile at all. */
function primaryProfile(profiles: WiseProfile[]): WiseProfile | undefined {
  const active = activeWiseProfiles(profiles);
  return active.find((profile) => profile.type?.toUpperCase() === "BUSINESS") ?? active[0];
}

async function readStatement(cfg: WiseConfig, input: Record<string, unknown>) {
  const profileId = readWiseId(input.profileId, "profileId");
  const balanceId = readWiseId(input.balanceId, "balanceId");
  const intervalStart = readTime(input.intervalStart, "intervalStart");
  const intervalEnd =
    input.intervalEnd === undefined ? new Date() : readTime(input.intervalEnd, "intervalEnd");
  checkStatementInterval(intervalStart, intervalEnd);
  const limit = clampInt(input.limit, 1, 500, 100);
  const balance = (await listWiseBalances(cfg.apiToken, profileId)).find(
    (candidate) => String(candidate.id) === balanceId,
  );
  if (!balance) throw new Error(`Wise balance ${balanceId} isn't on profile ${profileId}`);
  const statement = await getWiseBalanceStatement(cfg.apiToken, profileId, balanceId, {
    currency: balance.currency,
    intervalStart,
    intervalEnd,
  });
  const newestFirst = [...statement.transactions].sort(
    (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
  );
  const shown = newestFirst.slice(0, limit);
  return {
    profileId,
    balanceId,
    currency: balance.currency,
    intervalStart: intervalStart.toISOString(),
    intervalEnd: intervalEnd.toISOString(),
    transactionCount: newestFirst.length,
    returned: shown.length,
    truncated: shown.length < newestFirst.length,
    endOfStatementBalance: statement.endOfStatementBalance?.value ?? null,
    transactions: shown.map(summarizeTransaction),
  };
}

export const wiseProvider: IntegrationProvider = {
  catalog: {
    provider: "wise",
    name: "Wise",
    category: "Payments",
    tagline: "Multi-currency balances and their statements.",
    description:
      "Connect a Wise business account with a personal API token from Your Account → Connect and manage apps → API tokens. Genosyn only reads profiles, balances and balance statements — it never sends or converts money. Wise releases statements to a personal token only for business accounts based in the US, Canada, Australia, New Zealand, Singapore and Malaysia.",
    icon: "Landmark",
    authMode: "apikey",
    fields: [
      {
        key: "apiToken",
        label: "API token",
        type: "password",
        placeholder: "The token Wise showed you once",
        required: true,
        hint: "Create it in Wise under Your Account → Connect and manage apps → API tokens. Genosyn only reads balances and statements.",
      },
    ],
    enabled: true,
  },

  tools: [
    {
      name: "list_profiles",
      description:
        "List the Wise profiles — business and personal — this token can read, with each profile's id, type, name and country.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "list_balances",
      description:
        "List the balances on a Wise profile, one per currency, with available, reserved and total amounts in the balance's currency. Omit profileId to list every profile's balances.",
      inputSchema: {
        type: "object",
        properties: {
          profileId: {
            type: "string",
            description: "Wise profile id from list_profiles. Omit for every profile.",
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_balance_statement",
      description:
        "Read the transactions on one Wise balance between two times at most 469 days apart, newest first. Amounts are in the balance's currency and include fees: money in is positive, money out negative.",
      inputSchema: {
        type: "object",
        properties: {
          profileId: { type: "string", description: "Wise profile id from list_profiles." },
          balanceId: { type: "string", description: "Balance id from list_balances." },
          intervalStart: { type: "string", description: "RFC 3339 start time." },
          intervalEnd: {
            type: "string",
            description: "RFC 3339 end time. Defaults to now.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Most transactions to return (default 100).",
          },
        },
        required: ["profileId", "balanceId", "intervalStart"],
        additionalProperties: false,
      },
    },
  ],

  async validateApiKey(input) {
    const apiToken = (input.apiToken ?? "").trim();
    if (!apiToken) throw new Error("API token is required");
    const primary = primaryProfile(await listWiseProfiles(apiToken));
    if (!primary) throw new Error("Wise returned no active profiles for this token.");
    await listWiseBalances(apiToken, primary.id);
    return {
      config: { apiToken } satisfies WiseConfig,
      accountHint: `${wiseProfileName(primary)} · ${maskSecret(apiToken)}`,
    };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as WiseConfig;
    try {
      const primary = primaryProfile(await listWiseProfiles(cfg.apiToken));
      if (!primary) throw new Error("Wise returned no active profiles for this token.");
      await listWiseBalances(cfg.apiToken, primary.id);
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
    const cfg = ctx.config as WiseConfig;
    const input = (args as Record<string, unknown>) ?? {};
    if (name === "list_profiles") {
      const profiles = await listWiseProfiles(cfg.apiToken);
      return { items: profiles.map(summarizeProfile) };
    }
    if (name === "list_balances") {
      const wanted =
        input.profileId === undefined ? null : readWiseId(input.profileId, "profileId");
      const profiles = activeWiseProfiles(await listWiseProfiles(cfg.apiToken));
      const scope = wanted ? profiles.filter((profile) => String(profile.id) === wanted) : profiles;
      if (wanted && scope.length === 0) {
        throw new Error(`Wise profile ${wanted} isn't one this token can read`);
      }
      const items = [];
      for (const profile of scope) {
        for (const balance of await listWiseBalances(cfg.apiToken, profile.id)) {
          items.push(summarizeBalance(profile, balance));
        }
      }
      return { items };
    }
    if (name === "get_balance_statement") return readStatement(cfg, input);
    throw new Error(`Unknown Wise tool: ${name}`);
  },
};
