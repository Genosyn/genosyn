import { ConnectionAuthError } from "../types.js";
import type { IntegrationConfig, IntegrationProvider } from "../types.js";

/**
 * Twilio — phone numbers for AI Employees.
 *
 * The Connection holds the Twilio account's credential and nothing else. What
 * an AI Employee actually uses is a **Phone number** reserved through it
 * (`PhoneNumber`, managed at Settings → Phone numbers), and the number's
 * assignment is the employee's only authority to text or call from it.
 *
 * ## Why it exposes no tools
 *
 * The same reason the IMAP connector exposes none. A Connection grant is
 * wholesale: every tool on it reaches every number on the account. Texting
 * and calling tools hanging off the Connection would let an employee granted
 * the *account* text from a number given to somebody else, under nobody's
 * daily limit. So this provider carries the credential and the REST calls the
 * phone service makes with it, and the employee's phone tools are built-in
 * tools scoped to the numbers it has been given.
 *
 * ## Why an Account SID and Auth Token, not an API key
 *
 * Twilio signs every webhook it sends — an incoming text, a call, a status
 * update — with the account's Auth Token. An API key can call the REST API
 * but cannot verify those signatures, and the signature is the only thing that
 * proves a request on the public webhook routes came from Twilio.
 */

export const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const TWILIO_PRICING_BASE = "https://pricing.twilio.com/v1";

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** Captured at connect time, for display only. */
  friendlyName?: string;
  /** "Trial" or "Full" — trial accounts can only reach verified numbers. */
  accountType?: string;
};

/**
 * Twilio error codes worth explaining rather than passing through raw. Twilio's
 * own messages are accurate and terse; these add what to do next.
 */
const TWILIO_ERROR_HINTS: Record<number, string> = {
  20003: "Twilio rejected the Account SID or Auth Token — reconnect with current credentials.",
  20404: "Twilio has no such resource on this account.",
  21211: "That is not a valid phone number. Use E.164, e.g. +15550101234.",
  21215:
    "This account's voice geographic permissions block calls to that country — allow it in Twilio Console → Voice → Settings → Geo permissions.",
  21219:
    "Trial accounts can only call verified numbers — verify it in Twilio Console, or upgrade the account.",
  21408:
    "This account's messaging geographic permissions block texts to that country — allow it in Twilio Console → Messaging → Settings → Geo permissions.",
  21422: "That number is no longer available — search again and pick another.",
  21452: "That number is no longer available — search again and pick another.",
  21606: "This number cannot send texts. Pick a number with SMS capability.",
  21608:
    "Trial accounts can only text verified numbers — verify it in Twilio Console, or upgrade the account.",
  21610:
    "The recipient replied STOP to this number, so Twilio will not deliver texts to them until they reply START.",
  21612: "Twilio cannot route a text between these two numbers.",
  21614: "The recipient's number cannot receive texts — it is probably a landline.",
  21631:
    "Numbers in this country need a registered address on the Twilio account before they can be bought.",
  21649:
    "Numbers in this country need an approved regulatory bundle on the Twilio account before they can be bought.",
  21660: "The sending number does not belong to this Twilio account.",
};

/** Codes that mean the credential itself is finished, not one call. */
export function isTwilioAuthFailure(status: number, code: number | undefined): boolean {
  return status === 401 || code === 20003;
}

export function twilioErrorMessage(status: number, parsed: unknown, raw: string): string {
  const { message, code } = readTwilioError(parsed);
  const base = message || raw.trim().slice(0, 300) || `HTTP ${status}`;
  let out = `Twilio: ${base}${code != null ? ` (error ${code})` : ""}`;
  const hint = code != null ? TWILIO_ERROR_HINTS[code] : undefined;
  if (hint && !base.includes(hint)) out += ` ${hint}`;
  else if (status === 429) out += " Twilio is rate limiting this account — slow down and retry.";
  return out;
}

/** Twilio REST errors: `{code, message, more_info, status}`. */
export function readTwilioError(parsed: unknown): { message: string; code?: number } {
  if (!parsed || typeof parsed !== "object") return { message: "" };
  const p = parsed as { message?: unknown; code?: unknown };
  const message = typeof p.message === "string" ? p.message : "";
  return typeof p.code === "number" ? { message, code: p.code } : { message };
}

/** An error from Twilio that names one of its codes, for callers that branch on them. */
export class TwilioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: number | undefined,
  ) {
    super(message);
    this.name = "TwilioApiError";
  }
}

type TwilioCredentials = Pick<TwilioConfig, "accountSid" | "authToken">;

export function readTwilioConfig(config: IntegrationConfig): TwilioConfig {
  const accountSid = typeof config.accountSid === "string" ? config.accountSid.trim() : "";
  const authToken = typeof config.authToken === "string" ? config.authToken.trim() : "";
  if (!accountSid || !authToken) {
    throw new ConnectionAuthError(
      "This Twilio connection is missing its Account SID or Auth Token — reconnect it at Settings → Integrations.",
      "expired",
    );
  }
  return {
    accountSid,
    authToken,
    ...(typeof config.friendlyName === "string" ? { friendlyName: config.friendlyName } : {}),
    ...(typeof config.accountType === "string" ? { accountType: config.accountType } : {}),
  };
}

/**
 * One call to Twilio's REST API. Bodies go out form-encoded, which is what the
 * 2010-04-01 API takes; repeated keys (`StatusCallbackEvent`) come from array
 * values. Never logs the request or the response — both can carry a text's
 * body or a phone number.
 */
export async function twilioFetch(
  creds: TwilioCredentials,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean | string[] | undefined> = {},
  base = TWILIO_API_BASE,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) form.append(key, entry);
    else form.append(key, String(value));
  }
  const query = method === "GET" && [...form.keys()].length > 0 ? `?${form.toString()}` : "";
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64")}`,
    accept: "application/json",
  };
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(20_000) };
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = form.toString();
  }
  const res = await fetch(`${base}${path}${query}`, init);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — the status check below owns the failure.
  }
  if (!res.ok) {
    const message = twilioErrorMessage(res.status, parsed, text);
    if (isTwilioAuthFailure(res.status, readTwilioError(parsed).code)) {
      throw new ConnectionAuthError(message, "expired");
    }
    throw new TwilioApiError(message, res.status, readTwilioError(parsed).code);
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function accountPath(creds: TwilioCredentials, rest: string): string {
  return `/Accounts/${encodeURIComponent(creds.accountSid)}${rest}`;
}

// ---------------------------------------------------------------------------
// Phone numbers
// ---------------------------------------------------------------------------

export type TwilioNumberType = "local" | "toll-free" | "mobile";

export type TwilioAvailableNumber = {
  phoneNumber: string;
  friendlyName: string;
  locality: string;
  region: string;
  country: string;
  voice: boolean;
  sms: boolean;
  mms: boolean;
  /** "none", "any", "local" or "foreign" — anything but "none" needs an address on file. */
  addressRequirements: string;
};

const NUMBER_TYPE_PATH: Record<TwilioNumberType, string> = {
  local: "Local",
  "toll-free": "TollFree",
  mobile: "Mobile",
};

export async function searchAvailableNumbers(
  creds: TwilioCredentials,
  args: {
    country: string;
    type: TwilioNumberType;
    areaCode?: string;
    contains?: string;
    smsEnabled?: boolean;
    voiceEnabled?: boolean;
    limit?: number;
  },
): Promise<TwilioAvailableNumber[]> {
  const body = await twilioFetch(
    creds,
    "GET",
    accountPath(
      creds,
      `/AvailablePhoneNumbers/${encodeURIComponent(args.country.toUpperCase())}/${NUMBER_TYPE_PATH[args.type]}.json`,
    ),
    {
      AreaCode: args.areaCode || undefined,
      Contains: args.contains || undefined,
      SmsEnabled: args.smsEnabled ? true : undefined,
      VoiceEnabled: args.voiceEnabled ? true : undefined,
      PageSize: args.limit ?? 20,
    },
  );
  const rows = Array.isArray(body.available_phone_numbers) ? body.available_phone_numbers : [];
  return rows.flatMap((row): TwilioAvailableNumber[] => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const phoneNumber = str(r.phone_number);
    if (!phoneNumber) return [];
    const caps = (r.capabilities ?? {}) as Record<string, unknown>;
    return [
      {
        phoneNumber,
        friendlyName: str(r.friendly_name) || phoneNumber,
        locality: str(r.locality),
        region: str(r.region),
        country: str(r.iso_country) || args.country.toUpperCase(),
        // The search resource capitalizes SMS and MMS; the owned-number
        // resource does not. Read both spellings rather than trust either.
        voice: caps.voice === true,
        sms: caps.SMS === true || caps.sms === true,
        mms: caps.MMS === true || caps.mms === true,
        addressRequirements: str(r.address_requirements) || "none",
      },
    ];
  });
}

export type TwilioOwnedNumber = {
  sid: string;
  phoneNumber: string;
  friendlyName: string;
  voice: boolean;
  sms: boolean;
  mms: boolean;
  smsUrl: string;
  voiceUrl: string;
};

function readOwnedNumber(row: unknown): TwilioOwnedNumber | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const sid = str(r.sid);
  const phoneNumber = str(r.phone_number);
  if (!sid || !phoneNumber) return null;
  const caps = (r.capabilities ?? {}) as Record<string, unknown>;
  return {
    sid,
    phoneNumber,
    friendlyName: str(r.friendly_name) || phoneNumber,
    voice: caps.voice === true,
    sms: caps.sms === true || caps.SMS === true,
    mms: caps.mms === true || caps.MMS === true,
    smsUrl: str(r.sms_url),
    voiceUrl: str(r.voice_url),
  };
}

/** Every number on the account, for bringing an existing one into Genosyn. */
export async function listOwnedNumbers(creds: TwilioCredentials): Promise<TwilioOwnedNumber[]> {
  const body = await twilioFetch(creds, "GET", accountPath(creds, "/IncomingPhoneNumbers.json"), {
    PageSize: 200,
  });
  const rows = Array.isArray(body.incoming_phone_numbers) ? body.incoming_phone_numbers : [];
  return rows.map(readOwnedNumber).filter((n): n is TwilioOwnedNumber => n !== null);
}

export async function fetchOwnedNumber(
  creds: TwilioCredentials,
  sid: string,
): Promise<TwilioOwnedNumber> {
  const body = await twilioFetch(
    creds,
    "GET",
    accountPath(creds, `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`),
  );
  const owned = readOwnedNumber(body);
  if (!owned) throw new Error("Twilio returned a number Genosyn could not read.");
  return owned;
}

export type TwilioNumberWebhooks = {
  smsUrl: string;
  voiceUrl: string;
  statusCallbackUrl: string;
};

function webhookParams(webhooks: TwilioNumberWebhooks | null) {
  if (!webhooks) return {};
  return {
    SmsUrl: webhooks.smsUrl,
    SmsMethod: "POST",
    VoiceUrl: webhooks.voiceUrl,
    VoiceMethod: "POST",
    StatusCallback: webhooks.statusCallbackUrl,
    StatusCallbackMethod: "POST",
  };
}

/** Buy a number Twilio offered. Webhooks are set in the same call when there is a public URL. */
export async function purchaseNumber(
  creds: TwilioCredentials,
  args: { phoneNumber: string; friendlyName: string; webhooks: TwilioNumberWebhooks | null },
): Promise<TwilioOwnedNumber> {
  const body = await twilioFetch(creds, "POST", accountPath(creds, "/IncomingPhoneNumbers.json"), {
    PhoneNumber: args.phoneNumber,
    FriendlyName: args.friendlyName.slice(0, 64),
    ...webhookParams(args.webhooks),
  });
  const owned = readOwnedNumber(body);
  if (!owned)
    throw new Error("Twilio reserved the number but returned nothing Genosyn could read.");
  return owned;
}

/**
 * Point a number's webhooks at this Genosyn, or clear them. Clearing sets the
 * URLs to empty strings, which Twilio treats as "no webhook" — a number taken
 * out of Genosyn stops calling it.
 */
export async function setNumberWebhooks(
  creds: TwilioCredentials,
  sid: string,
  webhooks: TwilioNumberWebhooks | null,
): Promise<void> {
  await twilioFetch(
    creds,
    "POST",
    accountPath(creds, `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`),
    webhooks ? webhookParams(webhooks) : { SmsUrl: "", VoiceUrl: "", StatusCallback: "" },
  );
}

export async function releaseNumber(creds: TwilioCredentials, sid: string): Promise<void> {
  try {
    await twilioFetch(
      creds,
      "DELETE",
      accountPath(creds, `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`),
    );
  } catch (err) {
    // Already gone from Twilio — released in the Console, say. The outcome
    // the caller asked for is true either way.
    if (err instanceof TwilioApiError && err.status === 404) return;
    throw err;
  }
}

/**
 * What a number of this type costs per month in this country, best-effort. The
 * Pricing API is a separate host and some accounts cannot read it; a missing
 * price never blocks a search.
 */
export async function numberMonthlyPrice(
  creds: TwilioCredentials,
  country: string,
  type: TwilioNumberType,
): Promise<{ amount: string; currency: string } | null> {
  try {
    const body = await twilioFetch(
      creds,
      "GET",
      `/PhoneNumbers/Countries/${encodeURIComponent(country.toUpperCase())}`,
      {},
      TWILIO_PRICING_BASE,
    );
    const prices = Array.isArray(body.phone_number_prices) ? body.phone_number_prices : [];
    const wanted = type === "toll-free" ? "toll free" : type;
    for (const entry of prices) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (str(e.number_type).toLowerCase() !== wanted) continue;
      const amount = str(e.current_price) || str(e.base_price);
      if (amount) return { amount, currency: str(body.price_unit) || "USD" };
    }
  } catch {
    // Best-effort, see above.
  }
  return null;
}

// ---------------------------------------------------------------------------
// Texts
// ---------------------------------------------------------------------------

export type TwilioMessage = {
  sid: string;
  from: string;
  to: string;
  body: string;
  status: string;
  direction: string;
  dateSent: Date | null;
  errorCode: number | null;
  errorMessage: string;
  numMedia: number;
};

function readMessage(row: unknown): TwilioMessage | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const sid = str(r.sid);
  if (!sid) return null;
  const dateSent = str(r.date_sent) || str(r.date_created);
  const parsedDate = dateSent ? new Date(dateSent) : null;
  return {
    sid,
    from: str(r.from),
    to: str(r.to),
    body: typeof r.body === "string" ? r.body : "",
    status: str(r.status),
    direction: str(r.direction),
    dateSent: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    errorCode: typeof r.error_code === "number" ? r.error_code : null,
    errorMessage: str(r.error_message),
    numMedia: Number(r.num_media) || 0,
  };
}

export async function sendMessage(
  creds: TwilioCredentials,
  args: { from: string; to: string; body: string; statusCallbackUrl: string | null },
): Promise<TwilioMessage> {
  const body = await twilioFetch(creds, "POST", accountPath(creds, "/Messages.json"), {
    From: args.from,
    To: args.to,
    Body: args.body,
    StatusCallback: args.statusCallbackUrl ?? undefined,
  });
  const message = readMessage(body);
  if (!message)
    throw new Error("Twilio accepted the text but returned nothing Genosyn could read.");
  return message;
}

/**
 * Recent texts *to* one number, newest first. The poller's way in when Twilio
 * cannot reach this install — the reason a verification code still arrives on
 * a laptop with no public URL.
 */
export async function listInboundMessages(
  creds: TwilioCredentials,
  args: { to: string; sentAfter: Date; limit?: number },
): Promise<TwilioMessage[]> {
  // `DateSent>` filters by calendar day in UTC, so ask for the day before the
  // cursor and let the caller drop what it already holds.
  const day = new Date(args.sentAfter.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const body = await twilioFetch(creds, "GET", accountPath(creds, "/Messages.json"), {
    To: args.to,
    "DateSent>": day,
    PageSize: args.limit ?? 50,
  });
  const rows = Array.isArray(body.messages) ? body.messages : [];
  return rows
    .map(readMessage)
    .filter((m): m is TwilioMessage => m !== null && m.direction === "inbound");
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export async function createCall(
  creds: TwilioCredentials,
  args: {
    from: string;
    to: string;
    url: string;
    statusCallbackUrl: string;
    /** Hard cap on the call's length, in seconds. */
    timeLimitSec: number;
    /** How long to let it ring before giving up, in seconds. */
    ringTimeoutSec: number;
  },
): Promise<{ sid: string; status: string }> {
  const body = await twilioFetch(creds, "POST", accountPath(creds, "/Calls.json"), {
    From: args.from,
    To: args.to,
    Url: args.url,
    Method: "POST",
    StatusCallback: args.statusCallbackUrl,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    TimeLimit: args.timeLimitSec,
    Timeout: args.ringTimeoutSec,
  });
  const sid = str(body.sid);
  if (!sid) throw new Error("Twilio accepted the call but returned no call id.");
  return { sid, status: str(body.status) || "queued" };
}

/** End a call that is still ringing or connected. */
export async function hangUpCall(creds: TwilioCredentials, sid: string): Promise<void> {
  try {
    await twilioFetch(creds, "POST", accountPath(creds, `/Calls/${encodeURIComponent(sid)}.json`), {
      Status: "completed",
    });
  } catch (err) {
    // A call that already ended cannot be ended again; that is success.
    if (err instanceof TwilioApiError && (err.status === 404 || err.code === 21220)) return;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The Integration
// ---------------------------------------------------------------------------

async function fetchAccount(
  creds: TwilioCredentials,
): Promise<{ friendlyName: string; status: string; type: string }> {
  const body = await twilioFetch(
    creds,
    "GET",
    `/Accounts/${encodeURIComponent(creds.accountSid)}.json`,
  );
  return {
    friendlyName: str(body.friendly_name),
    status: str(body.status),
    type: str(body.type),
  };
}

export const twilioProvider: IntegrationProvider = {
  catalog: {
    provider: "twilio",
    name: "Twilio",
    category: "Communication",
    tagline: "Give AI Employees their own phone numbers.",
    description:
      "Connect a Twilio account, then reserve phone numbers at Settings → Phone numbers and give each to an AI Employee. The employee can text, read the texts that arrive — verification codes included — answer calls and place them. Texts work from any install; answering and placing calls needs a public URL Twilio can reach (Admin → General → Public URL). Numbers and minutes are billed to your Twilio account.",
    icon: "Phone",
    authMode: "apikey",
    fields: [
      {
        key: "accountSid",
        label: "Account SID",
        type: "text",
        placeholder: "AC…",
        required: true,
        hint: "Twilio Console → Account info. Starts with AC.",
      },
      {
        key: "authToken",
        label: "Auth Token",
        type: "password",
        required: true,
        hint: "Twilio Console → Account info. Also verifies every webhook Twilio sends.",
      },
    ],
    enabled: true,
  },

  // Deliberately empty — see the note at the top of this file. Employees
  // reach a number through its assignment, not through this Connection.
  tools: [],

  async validateApiKey(input) {
    const accountSid = (input.accountSid ?? "").trim();
    const authToken = (input.authToken ?? "").trim();
    if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
      throw new Error("The Account SID starts with AC followed by 32 letters and digits.");
    }
    if (!/^[0-9a-fA-F]{32}$/.test(authToken)) {
      throw new Error(
        "The Auth Token is 32 letters and digits — copy it from Twilio Console → Account info.",
      );
    }
    const account = await fetchAccount({ accountSid, authToken });
    if (account.status && account.status !== "active") {
      throw new Error(
        `This Twilio account is ${account.status}, so it cannot reserve numbers or send anything.`,
      );
    }
    const config: TwilioConfig = {
      accountSid,
      authToken,
      ...(account.friendlyName ? { friendlyName: account.friendlyName } : {}),
      ...(account.type ? { accountType: account.type } : {}),
    };
    const accountHint = [
      account.friendlyName,
      account.type === "Trial" ? "Trial" : "",
      `${accountSid.slice(0, 6)}…${accountSid.slice(-4)}`,
    ]
      .filter(Boolean)
      .join(" · ");
    return { config: config as unknown as IntegrationConfig, accountHint };
  },

  async checkStatus(ctx) {
    try {
      const creds = readTwilioConfig(ctx.config);
      const account = await fetchAccount(creds);
      if (account.status && account.status !== "active") {
        return { ok: false, status: "error", message: `This Twilio account is ${account.status}.` };
      }
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        status: err instanceof ConnectionAuthError ? "expired" : "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name) {
    throw new Error(
      `Unknown tool: ${name}. A Twilio connection carries the account credential; AI Employees text and call through the phone numbers they have been given, with the built-in phone tools.`,
    );
  },
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
