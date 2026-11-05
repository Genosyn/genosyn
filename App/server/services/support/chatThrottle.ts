import crypto from "node:crypto";

import type { Request } from "express";

import type { SupportChatVisitor } from "../../db/entities/SupportChatVisitor.js";
import type { SupportSettings } from "../../db/entities/SupportSettings.js";
import {
  AuthRateLimitError,
  type AuthRateLimitPolicy,
  consumeAuthAttempt,
  peekAuthAttempts,
  throttleKeyFor,
} from "../authThrottle.js";

/**
 * What stops an open endpoint running up a bill or filling a database.
 *
 * Anyone can post to the Chat widget, and an origin list says nothing to `curl`, so
 * these limits are the real cost control. They are checked narrowest first, so one
 * noisy visitor runs out of their own allowance before they spend a company's:
 * visitor, then address, then company. Writes use the persistent buckets every
 * replica shares; a poll is held in this process's memory, because a poll must not
 * be a database write.
 *
 * Every key is a hash. A visitor's key comes only from a token that already proved
 * itself, never from one that was merely presented, so nobody can fill the table by
 * making up tokens (the reason `publicForms.ts` keys guesses by address alone).
 *
 * The model budget (`spendChatAiTurn`) is separate from all of this and is spent
 * inside the job, at the moment a turn would start.
 */

const HOUR = 60;
const DAY = 24 * 60;

/** A window that long, and a bucket that stays shut for what is left of it. */
function perWindow(maxAttempts: number, windowMinutes: number): AuthRateLimitPolicy {
  return { maxAttempts, windowMinutes, blockMinutes: windowMinutes };
}

/**
 * A company's own limit is part of its bucket's name, so changing it takes effect at
 * once: an owner who raises it because visitors were being turned away should not then
 * wait out the rest of a window the old limit had already shut.
 */
function companyBucket(scope: string, companyId: string, limit: number): string {
  return throttleKeyFor(`support-chat:${scope}:company:${limit}`, companyId);
}

export const SUPPORT_CHAT_THROTTLES = {
  newVisitorsPerAddress: perWindow(10, HOUR),
  messagesPerVisitor: perWindow(30, 10),
  messagesPerAddress: perWindow(120, 10),
  aiTurnsPerVisitor: perWindow(12, DAY),
  emailRequestsPerVisitor: perWindow(3, DAY),
  emailRequestsPerAddress: perWindow(10, HOUR),
  /** Mail one address can be sent, however many visitors name it. */
  confirmationsPerRecipient: perWindow(2, DAY),
  confirmationsPerCompany: perWindow(200, DAY),
} as const;

export const SUPPORT_CHAT_READS_PER_MINUTE = { visitor: 90, address: 300 } as const;

/** Refused by a limit. `message` is written for whoever is typing in the widget. */
export class SupportChatThrottledError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
    this.name = "SupportChatThrottledError";
  }
}

async function consume(
  key: string,
  policy: AuthRateLimitPolicy,
  refusal: string,
): Promise<void> {
  try {
    await consumeAuthAttempt([key], policy);
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    throw new SupportChatThrottledError(refusal, error.retryAfterSeconds);
  }
}

function addressKey(req: Request, scope: string): string {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  return throttleKeyFor(`support-chat:${scope}:address`, ip);
}

const SLOW_DOWN = "You are sending messages very quickly. Give it a moment and try again.";
const BUSY = "We are getting a lot of messages right now. Please try again a little later.";

/** One new visitor from this address on this company's widgets. */
export async function throttleNewVisitor(
  req: Request,
  settings: Pick<SupportSettings, "companyId" | "chatMessagesPerHour">,
): Promise<void> {
  await consume(
    addressKey(req, "visitors"),
    SUPPORT_CHAT_THROTTLES.newVisitorsPerAddress,
    SLOW_DOWN,
  );
  await consume(
    companyBucket("visitors", settings.companyId, settings.chatMessagesPerHour),
    perWindow(settings.chatMessagesPerHour, HOUR),
    BUSY,
  );
}

/** One message: the visitor's allowance, then their address's, then the company's. */
export async function throttleMessage(
  req: Request,
  visitor: Pick<SupportChatVisitor, "id">,
  settings: Pick<SupportSettings, "companyId" | "chatMessagesPerHour">,
): Promise<void> {
  await consume(
    throttleKeyFor("support-chat:messages:visitor", visitor.id),
    SUPPORT_CHAT_THROTTLES.messagesPerVisitor,
    SLOW_DOWN,
  );
  await consume(
    addressKey(req, "messages"),
    SUPPORT_CHAT_THROTTLES.messagesPerAddress,
    SLOW_DOWN,
  );
  await consume(
    companyBucket("messages", settings.companyId, settings.chatMessagesPerHour),
    perWindow(settings.chatMessagesPerHour, HOUR),
    BUSY,
  );
}

const TOO_MANY_EMAILS = "That is enough confirmation emails for now. Try again later.";

export async function throttleEmailRequest(
  req: Request,
  visitor: Pick<SupportChatVisitor, "id">,
): Promise<void> {
  await consume(
    throttleKeyFor("support-chat:email:visitor", visitor.id),
    SUPPORT_CHAT_THROTTLES.emailRequestsPerVisitor,
    TOO_MANY_EMAILS,
  );
  await consume(
    addressKey(req, "email"),
    SUPPORT_CHAT_THROTTLES.emailRequestsPerAddress,
    TOO_MANY_EMAILS,
  );
}

/**
 * Whether one more confirmation may go to this address from this company. False is
 * not an error anyone is told about: the answer to a visitor is the same either way,
 * so this endpoint can't say which addresses were recently asked about.
 */
export async function mayConfirmRecipient(companyId: string, address: string): Promise<boolean> {
  try {
    await consumeAuthAttempt(
      [throttleKeyFor(`support-chat:confirm:${companyId}`, address)],
      SUPPORT_CHAT_THROTTLES.confirmationsPerRecipient,
    );
    await consumeAuthAttempt(
      [throttleKeyFor("support-chat:confirm:company", companyId)],
      SUPPORT_CHAT_THROTTLES.confirmationsPerCompany,
    );
    return true;
  } catch (error) {
    if (error instanceof AuthRateLimitError) return false;
    throw error;
  }
}

// ── The model budget ────────────────────────────────────────────────────────

/** Why a turn did not start, or null when it may. Worded for the Member who reads it. */
export async function spendChatAiTurn(args: {
  visitorId: string;
  settings: Pick<SupportSettings, "companyId" | "chatAiTurnsPerDay">;
}): Promise<string | null> {
  const { settings, visitorId } = args;
  if (settings.chatAiTurnsPerDay <= 0) {
    return "AI Employees do not read chat messages: the company's limit is 0 AI turns a day.";
  }
  try {
    await consumeAuthAttempt(
      [throttleKeyFor("support-chat:ai:visitor", visitorId)],
      SUPPORT_CHAT_THROTTLES.aiTurnsPerVisitor,
    );
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    return "This visitor reached the limit of AI turns for today.";
  }
  try {
    await consumeAuthAttempt(
      [companyBucket("ai", settings.companyId, settings.chatAiTurnsPerDay)],
      perWindow(settings.chatAiTurnsPerDay, DAY),
    );
  } catch (error) {
    if (!(error instanceof AuthRateLimitError)) throw error;
    return `The company's Chat widgets used their ${settings.chatAiTurnsPerDay} AI turns for today.`;
  }
  return null;
}

/** AI turns the company's Chat widgets have spent in the current window. */
export async function chatAiTurnsUsed(
  settings: Pick<SupportSettings, "companyId" | "chatAiTurnsPerDay">,
): Promise<number> {
  return peekAuthAttempts(
    companyBucket("ai", settings.companyId, settings.chatAiTurnsPerDay),
    DAY,
  );
}

// ── Polls ───────────────────────────────────────────────────────────────────

type ReadBucket = { count: number; startedAt: number };
const readBuckets = new Map<string, ReadBucket>();
const readSalt = crypto.randomBytes(32);
const READ_WINDOW_MS = 60_000;
const READ_BUCKET_CAP = 20_000;

function hitRead(key: string, limit: number, now: number): number | null {
  const id = crypto.createHmac("sha256", readSalt).update(key).digest("hex");
  let bucket = readBuckets.get(id);
  if (!bucket || now - bucket.startedAt >= READ_WINDOW_MS) {
    if (!readBuckets.has(id) && readBuckets.size >= READ_BUCKET_CAP) {
      for (const [candidate, value] of readBuckets) {
        if (now - value.startedAt >= READ_WINDOW_MS) readBuckets.delete(candidate);
      }
      if (readBuckets.size >= READ_BUCKET_CAP) {
        const oldest = readBuckets.keys().next().value as string | undefined;
        if (oldest) readBuckets.delete(oldest);
      }
    }
    bucket = { count: 0, startedAt: now };
    readBuckets.set(id, bucket);
  }
  if (bucket.count >= limit) {
    return Math.max(1, Math.ceil((bucket.startedAt + READ_WINDOW_MS - now) / 1000));
  }
  bucket.count += 1;
  return null;
}

const READ_REFUSAL = "Hold on a moment. The chat will catch up.";

/** Before anything else on every request: what a scanner or a tight loop runs into first. */
export function throttleRead(req: Request, visitorId?: string): void {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const addressRetry = hitRead(`address:${ip}`, SUPPORT_CHAT_READS_PER_MINUTE.address, now);
  if (addressRetry !== null) throw new SupportChatThrottledError(READ_REFUSAL, addressRetry);
  if (!visitorId) return;
  const visitorRetry = hitRead(`visitor:${visitorId}`, SUPPORT_CHAT_READS_PER_MINUTE.visitor, now);
  if (visitorRetry !== null) throw new SupportChatThrottledError(READ_REFUSAL, visitorRetry);
}

export function resetSupportChatReadThrottleForTests(): void {
  readBuckets.clear();
}
