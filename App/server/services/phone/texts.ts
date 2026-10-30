import { IsNull, MoreThanOrEqual, type SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { PhoneMessage, type PhoneMessageStatus } from "../../db/entities/PhoneMessage.js";
import { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import {
  listInboundMessages,
  sendMessage,
  TwilioApiError,
} from "../../integrations/providers/twilio.js";
import {
  extractVerificationCodes,
  formatPhoneNumber,
  MAX_TEXT_MESSAGE_LENGTH,
  normalizePhoneNumber,
} from "../../../shared/phone.js";
import { recordAudit } from "../audit.js";
import { andWhereTokens, type Token } from "../likeSearch.js";
import {
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  type PageRequest,
} from "../listPaging.js";
import { workBlocked } from "../standdowns.js";
import { twilioAccountForNumber, withTwilioAccount } from "./credentials.js";
import { PhoneError } from "./errors.js";
import { messageStatusUrl, reachableBaseUrl } from "./webhookUrls.js";

/**
 * Texts on a Phone number: sending one, keeping each one that arrives exactly
 * once, and finding the one an AI Employee is waiting for.
 *
 * Inbound texts reach Genosyn two ways. With a public URL Twilio pushes each
 * one to the number's webhook. Without one — a laptop, a private network —
 * {@link syncInboundTexts} asks Twilio for what arrived, so a verification
 * code still turns up. Both land through {@link recordInboundText}, and the
 * unique message sid decides which of them handles a text first.
 */

export type PhoneMessageDTO = {
  id: string;
  phoneNumberId: string;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  fromDisplay: string;
  toDisplay: string;
  body: string;
  status: PhoneMessageStatus;
  occurredAt: string;
  errorMessage: string;
  /** Who wrote an outbound text: the AI Employee, its automatic reply, or a Member. */
  sentBy: "employee" | "auto_reply" | "member" | null;
  mediaCount: number;
};

export function serializePhoneMessage(m: PhoneMessage): PhoneMessageDTO {
  return {
    id: m.id,
    phoneNumberId: m.phoneNumberId,
    direction: m.direction,
    from: m.fromNumber,
    to: m.toNumber,
    fromDisplay: formatPhoneNumber(m.fromNumber),
    toDisplay: formatPhoneNumber(m.toNumber),
    body: m.body,
    status: m.status,
    occurredAt: m.occurredAt.toISOString(),
    errorMessage: m.errorMessage,
    sentBy:
      m.direction === "inbound"
        ? null
        : m.sentByUserId
          ? "member"
          : m.autoReply
            ? "auto_reply"
            : "employee",
    mediaCount: mediaCount(m.mediaJson),
  };
}

function mediaCount(json: string): number {
  if (!json) return 0;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Which texts a read covers. Every field narrows; they combine. */
export type TextFilter = {
  phoneNumberIds: string[];
  /**
   * Only texts this AI Employee may read: those sent or received while the
   * number was its own, or while the number had nobody. A number that moved
   * between employees does not carry one's verification codes to the other.
   */
  visibleToEmployeeId?: string;
  direction?: "inbound" | "outbound";
  /** Text the other party's number or sender name contains, any case. */
  counterpart?: string;
  /** Text the body must contain, any case. */
  contains?: string;
  /** At or after this instant. */
  since?: Date;
};

export type TextQuery = TextFilter & { limit: number };

/** The whole string as one LIKE term: `contains` is a substring, not a set of words. */
function wholeTerm(value: string | undefined): Token[] {
  const raw = value?.trim() ?? "";
  return raw ? [{ raw, lo: raw.toLowerCase() }] : [];
}

/**
 * The texts a filter covers, unordered. Every filter — visibility included —
 * runs in SQL, so a page or a `limit` is cut from exactly the matching texts,
 * never from a window of the newest ones. Text matches fold case the same way
 * on both databases (`likeSearch.ts`).
 */
function textsQuery(filter: TextFilter): SelectQueryBuilder<PhoneMessage> {
  const qb = AppDataSource.getRepository(PhoneMessage).createQueryBuilder("m");
  if (filter.phoneNumberIds.length === 0) qb.where("1 = 0");
  else {
    qb.where("m.phoneNumberId IN (:...phoneNumberIds)", { phoneNumberIds: filter.phoneNumberIds });
  }
  if (filter.visibleToEmployeeId) {
    qb.andWhere("(m.employeeId = :viewerId OR m.employeeId IS NULL)", {
      viewerId: filter.visibleToEmployeeId,
    });
  }
  if (filter.direction) qb.andWhere("m.direction = :direction", { direction: filter.direction });
  if (filter.since) qb.andWhere("m.occurredAt >= :since", { since: filter.since });
  andWhereTokens(qb, ["m.body"], wholeTerm(filter.contains), "textBody");
  // The other party is the sender of a text that came in and the recipient of
  // one that went out.
  andWhereTokens(
    qb,
    ["CASE WHEN m.direction = 'inbound' THEN m.fromNumber ELSE m.toNumber END"],
    wholeTerm(filter.counterpart),
    "textParty",
  );
  return qb;
}

/**
 * Newest first, at most `limit`, through the `(phoneNumberId, occurredAt, id)`
 * index — the read Settings → Phone numbers and an employee's waits use.
 */
export async function listTexts(query: TextQuery): Promise<PhoneMessage[]> {
  if (query.phoneNumberIds.length === 0) return [];
  return textsQuery(query)
    .orderBy("m.occurredAt", "DESC")
    .addOrderBy("m.id", "DESC")
    .limit(query.limit)
    .getMany();
}

/** 20 texts by default, at most 50 a page. */
export const TEXT_PAGE: PageLimits = { defaultLimit: 20, maxLimit: 50 };

/**
 * Texts newest first, one page at a time (`services/listPaging.ts`): every
 * text the filter covers is reachable by following `nextCursor`, and texts
 * arriving between pages never make a page skip one. `fingerprint` carries
 * what the caller asked for, so a cursor is refused with other filters.
 */
export async function pageTexts<Out>(args: {
  companyId: string;
  filter: TextFilter;
  fingerprint: Record<string, unknown>;
  page: PageRequest & { budgetChars?: number };
  present: (rows: PhoneMessage[]) => Out[];
}): Promise<Page<Out>> {
  return keysetPage({
    query: () => textsQuery(args.filter),
    keys: [
      { column: "m.occurredAt", direction: "DESC", type: "timestamp" },
      { column: "m.id", direction: "DESC", type: "string" },
    ],
    scope: "phone.texts",
    fingerprint: filterFingerprint(args.companyId, args.fingerprint),
    noun: "texts",
    limits: TEXT_PAGE,
    page: args.page,
    present: args.present,
  });
}

/** The conversation between a number and one other party, oldest first. */
export async function textThread(
  phoneNumberId: string,
  counterpart: string,
  limit = 30,
): Promise<PhoneMessage[]> {
  const rows = await listTexts({ phoneNumberIds: [phoneNumberId], counterpart, limit });
  return rows
    .filter((row) => (row.direction === "inbound" ? row.fromNumber : row.toNumber) === counterpart)
    .reverse();
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export type InboundTextPayload = {
  sid: string;
  from: string;
  to: string;
  body: string;
  media: Array<{ contentType: string; url: string }>;
  occurredAt: Date;
};

type FreshInboundTextHandler = (message: PhoneMessage, number: PhoneNumber) => void;

let freshInboundHandler: FreshInboundTextHandler | null = null;

/**
 * Who acts on a text the moment it is first kept — the automatic reply, today.
 * Registered at boot rather than imported, because the reply path sends texts
 * through this module and a static import back would be a cycle. Every way a
 * text arrives (webhook, poller, a waiting tool) ends in
 * {@link recordInboundText}, so this is the one place to hook.
 */
export function setFreshInboundTextHandler(handler: FreshInboundTextHandler | null): void {
  freshInboundHandler = handler;
}

function isUniqueViolation(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNIQUE constraint failed|duplicate key value violates unique constraint/i.test(message);
}

/**
 * Keep one inbound text, once. `created` is false when the webhook and the
 * poller (or a webhook retry) both saw it — only the first caller acts on it.
 */
export async function recordInboundText(
  number: PhoneNumber,
  payload: InboundTextPayload,
): Promise<{ message: PhoneMessage; created: boolean }> {
  const repo = AppDataSource.getRepository(PhoneMessage);
  const existing = await repo.findOneBy({ providerSid: payload.sid });
  if (existing) return { message: existing, created: false };
  const row = repo.create({
    companyId: number.companyId,
    phoneNumberId: number.id,
    employeeId: number.employeeId,
    direction: "inbound",
    fromNumber: payload.from.slice(0, 64),
    toNumber: payload.to.slice(0, 64),
    providerSid: payload.sid,
    status: "received",
    occurredAt: payload.occurredAt,
    errorCode: null,
    errorMessage: "",
    sentByUserId: null,
    runId: null,
    autoReply: false,
    mediaJson: payload.media.length ? JSON.stringify(payload.media.slice(0, 10)) : "",
    body: payload.body.slice(0, 5_000),
  });
  try {
    const message = await repo.save(row);
    try {
      freshInboundHandler?.(message, number);
    } catch {
      // A handler failure must never lose the text that was just kept.
    }
    return { message, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await repo.findOneBy({ providerSid: payload.sid });
    if (!raced) throw err;
    return { message: raced, created: false };
  }
}

const syncing = new Map<string, Promise<PhoneMessage[]>>();

/**
 * Fetch texts Twilio holds for this number that Genosyn has not seen, and
 * keep them. Returns only the ones this call kept first. Overlapping calls for
 * one number share a single fetch.
 */
export function syncInboundTexts(number: PhoneNumber): Promise<PhoneMessage[]> {
  const inFlight = syncing.get(number.id);
  if (inFlight) return inFlight;
  const run = (async () => {
    const startedAt = new Date();
    const floor = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const joined = new Date(number.createdAt.getTime() - 10 * 60 * 1000);
    const cursor = number.lastTextSyncAt ?? (joined > floor ? joined : floor);
    const account = await twilioAccountForNumber(number);
    const fetched = await withTwilioAccount(account, (creds) =>
      listInboundMessages(creds, { to: number.e164, sentAfter: cursor }),
    );
    const fresh: PhoneMessage[] = [];
    // Oldest first, so the texts are kept — and any replies go out — in the
    // order they were sent.
    for (const text of fetched.reverse()) {
      if (text.dateSent && text.dateSent < new Date(cursor.getTime() - 60 * 60 * 1000)) continue;
      const { message, created } = await recordInboundText(number, {
        sid: text.sid,
        from: text.from,
        to: text.to,
        body: text.body,
        media: [],
        occurredAt: text.dateSent ?? new Date(),
      });
      if (created) fresh.push(message);
    }
    // A minute of overlap, because Twilio stamps a text slightly before it
    // becomes listable; the sid keeps the overlap from doubling anything.
    await AppDataSource.getRepository(PhoneNumber).update(
      { id: number.id },
      { lastTextSyncAt: new Date(startedAt.getTime() - 60_000) },
    );
    number.lastTextSyncAt = new Date(startedAt.getTime() - 60_000);
    return fresh;
  })().finally(() => syncing.delete(number.id));
  syncing.set(number.id, run);
  return run;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type TextSender =
  | { kind: "employee"; employeeId: string; runId: string | null }
  | { kind: "auto_reply"; employeeId: string }
  | { kind: "member"; userId: string };

/** AI-written texts on this number in the last 24 hours — what the daily limit counts. */
export async function aiTextsInLastDay(phoneNumberId: string): Promise<number> {
  return AppDataSource.getRepository(PhoneMessage).count({
    where: {
      phoneNumberId,
      direction: "outbound",
      sentByUserId: IsNull(),
      occurredAt: MoreThanOrEqual(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    },
  });
}

export async function sendText(args: {
  number: PhoneNumber;
  to: string;
  body: string;
  sender: TextSender;
}): Promise<PhoneMessage> {
  const { number, sender } = args;
  if (!number.smsEnabled) {
    throw new PhoneError(
      `${formatPhoneNumber(number.e164)} cannot send texts — it has no SMS capability.`,
    );
  }
  const to = normalizePhoneNumber(args.to);
  if (!to) {
    throw new PhoneError(
      `"${args.to.slice(0, 40)}" is not a phone number. Use E.164 with the country code, e.g. +15550101234.`,
    );
  }
  if (to === number.e164) throw new PhoneError("A number cannot text itself.");
  const body = args.body.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new PhoneError("The text is empty.");
  if (body.length > MAX_TEXT_MESSAGE_LENGTH) {
    throw new PhoneError(
      `Texts are at most ${MAX_TEXT_MESSAGE_LENGTH} characters; this one is ${body.length}. Shorten it or split it.`,
    );
  }
  if (sender.kind !== "member") {
    if (number.employeeId !== sender.employeeId) {
      throw new PhoneError("That phone number is not yours to text from.", 403);
    }
    const stopped = workBlocked(number.companyId, { employeeId: sender.employeeId });
    if (stopped.blocked) {
      throw new PhoneError(
        `AI work is stood down, so no texts can be sent: ${stopped.reason}`,
        403,
      );
    }
    const sent = await aiTextsInLastDay(number.id);
    if (sent >= number.dailyTextLimit) {
      throw new PhoneError(
        `${formatPhoneNumber(number.e164)} has sent its ${number.dailyTextLimit} AI texts for the last 24 hours. An owner or admin can raise the daily limit at Settings → Phone numbers.`,
        429,
      );
    }
  }

  const repo = AppDataSource.getRepository(PhoneMessage);
  // Saved before Twilio is called so the status callback URL can name it.
  const row = await repo.save(
    repo.create({
      companyId: number.companyId,
      phoneNumberId: number.id,
      employeeId: number.employeeId,
      direction: "outbound",
      fromNumber: number.e164,
      toNumber: to,
      providerSid: null,
      status: "queued",
      occurredAt: new Date(),
      errorCode: null,
      errorMessage: "",
      sentByUserId: sender.kind === "member" ? sender.userId : null,
      runId: sender.kind === "employee" ? sender.runId : null,
      autoReply: sender.kind === "auto_reply",
      mediaJson: "",
      body,
    }),
  );
  const base = reachableBaseUrl();
  try {
    const account = await twilioAccountForNumber(number);
    const sent = await withTwilioAccount(account, (creds) =>
      sendMessage(creds, {
        from: number.e164,
        to,
        body,
        statusCallbackUrl: base ? messageStatusUrl(base, row.id) : null,
      }),
    );
    // The status callback can beat this write, so the status is only set
    // while the row still says queued — a delivery receipt is never undone.
    await repo.update({ id: row.id }, { providerSid: sent.sid });
    const initial = twilioMessageStatus(sent.status);
    if (initial && initial !== "queued") {
      await repo.update({ id: row.id, status: "queued" }, { status: initial });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await repo.update(
      { id: row.id },
      {
        status: "failed",
        errorMessage: message.slice(0, 500),
        errorCode: err instanceof TwilioApiError ? (err.code ?? null) : null,
      },
    );
    throw err;
  }
  const saved = (await repo.findOneBy({ id: row.id })) ?? row;
  await recordAudit({
    companyId: number.companyId,
    actorKind: sender.kind === "member" ? "user" : "ai",
    actorUserId: sender.kind === "member" ? sender.userId : null,
    actorEmployeeId: sender.kind === "member" ? null : sender.employeeId,
    action: sender.kind === "auto_reply" ? "phone.text.auto_reply" : "phone.text.send",
    targetType: "phone_message",
    targetId: saved.id,
    targetLabel: `Text to ${formatPhoneNumber(to)}`,
    metadata: { phoneNumberId: number.id, to, length: body.length },
  });
  return saved;
}

const MESSAGE_STATUSES: readonly PhoneMessageStatus[] = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "undelivered",
  "failed",
];

/** Twilio's status vocabulary mapped onto ours; `accepted` and `scheduled` are still queued. */
export function twilioMessageStatus(status: string): PhoneMessageStatus | null {
  if (status === "accepted" || status === "scheduled") return "queued";
  return (MESSAGE_STATUSES as readonly string[]).includes(status)
    ? (status as PhoneMessageStatus)
    : null;
}

const STATUS_RANK: Record<PhoneMessageStatus, number> = {
  received: 0,
  queued: 1,
  sending: 2,
  sent: 3,
  delivered: 4,
  undelivered: 4,
  failed: 4,
};

/**
 * Apply one status callback. Callbacks can arrive out of order — `sent` after
 * `delivered` is common — so a status only ever moves forward.
 */
export async function applyTextStatus(args: {
  message: PhoneMessage;
  status: string;
  errorCode: number | null;
}): Promise<void> {
  const next = twilioMessageStatus(args.status);
  if (!next || STATUS_RANK[next] < STATUS_RANK[args.message.status]) return;
  if (next === args.message.status && !args.errorCode) return;
  await AppDataSource.getRepository(PhoneMessage).update(
    { id: args.message.id },
    {
      status: next,
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.errorCode && !args.message.errorMessage
        ? { errorMessage: deliveryErrorText(args.errorCode) }
        : {}),
    },
  );
}

/** Delivery failures Twilio reports by code alone, put into words. */
export function deliveryErrorText(code: number): string {
  const known: Record<number, string> = {
    30003: "The recipient's phone is unreachable or switched off.",
    30004: "The recipient has blocked texts from this number.",
    30005: "The recipient's number does not exist.",
    30006: "The recipient's number is a landline or cannot receive texts.",
    30007: "The carrier filtered this text as spam.",
    30008: "The carrier reported an unknown delivery error.",
    30034:
      "US carriers blocked it: texts from US 10-digit numbers need an approved A2P 10DLC registration in Twilio.",
    30032: "The toll-free number has not been verified for texting in Twilio.",
  };
  return known[code] ?? `Twilio could not deliver this text (error ${code}).`;
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

export type WaitForTextResult = {
  message: PhoneMessage;
  codes: string[];
} | null;

const WAIT_POLL_MS = 1_000;
/** How often a waiting call also asks Twilio directly when Twilio cannot push to this install. */
const WAIT_SYNC_MS = 4_000;
/** The same backstop where webhooks do work — a pushed text is normally here in a second. */
const WAIT_SYNC_PUSHED_MS = 20_000;

/**
 * The newest inbound text on these numbers that matches, waiting up to
 * `timeoutMs` for one to arrive. Checks the database every second and, every
 * few seconds, asks Twilio as well — so this works on an install with no
 * public URL, which is where verification codes are most often wanted.
 */
export async function waitForText(args: {
  numbers: PhoneNumber[];
  visibleToEmployeeId?: string;
  from?: string;
  contains?: string;
  since: Date;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<WaitForTextResult> {
  const deadline = Date.now() + args.timeoutMs;
  const ids = args.numbers.map((n) => n.id);
  const textNumbers = args.numbers.filter((n) => n.smsEnabled);
  const base = reachableBaseUrl();
  const pushed = textNumbers.every((n) => !!base && n.webhookBaseUrl === base && !n.webhookError);
  let nextSync = 0;
  for (;;) {
    if (Date.now() >= nextSync) {
      nextSync = Date.now() + (pushed ? WAIT_SYNC_PUSHED_MS : WAIT_SYNC_MS);
      await Promise.all(textNumbers.map((number) => syncInboundTexts(number).catch(() => [])));
    }
    const [match] = await listTexts({
      phoneNumberIds: ids,
      visibleToEmployeeId: args.visibleToEmployeeId,
      direction: "inbound",
      counterpart: args.from,
      contains: args.contains,
      since: args.since,
      limit: 1,
    });
    if (match) return { message: match, codes: extractVerificationCodes(match.body) };
    if (Date.now() + WAIT_POLL_MS > deadline || args.signal?.aborted) return null;
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
}
