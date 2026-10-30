import { MoreThanOrEqual } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { AIModelWait } from "../../db/entities/AIModelWait.js";
import { Company } from "../../db/entities/Company.js";
import { PhoneCall, type PhoneCallTranscriptTurn } from "../../db/entities/PhoneCall.js";
import { PhoneMessage } from "../../db/entities/PhoneMessage.js";
import { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import { normalizePhoneNumber } from "../../../shared/phone.js";
import { ModelUnavailableError } from "../agent/modelOutage.js";
import { isModelAvailable } from "../modelAvailability.js";
import { waitForModel, type ModelWaitHandler, type ModelWaitResult } from "../modelWaits.js";
import { getActiveModel } from "../models.js";
import { workBlocked } from "../standdowns.js";
import { runCallFollowUpTurn, runTextReplyTurn, type PhoneTurnRunner } from "./conversation.js";
import { PhoneError } from "./errors.js";
import { sendText, textThread } from "./texts.js";

/**
 * Automatic replies, for numbers whose text handling is "reply".
 *
 * Off by default, because the first thing most people want a number for is a
 * verification code, and a code wants no answer. When it is on, every rule
 * below exists to stop the one failure an auto-responder is famous for: two
 * of them texting each other forever, at a few cents a message.
 *
 *  - Never reply to a short code or a named sender. Those are services — the
 *    bank, the delivery company, the sign-up page — and either cannot receive
 *    a reply or will answer it with another automated one.
 *  - Never reply to an opt-out or help keyword. Twilio answers STOP and HELP
 *    itself, and once someone has said STOP, texting them is not ours to do.
 *  - At most {@link MAX_AUTO_REPLIES_PER_HOUR} replies to one person an hour,
 *    on top of the number's own daily limit, which counts these too.
 *  - Texts that arrive while a reply is being written are answered once,
 *    together: the newest one takes the turn and the rest are skipped.
 *  - A Standdown, an unassigned number, or an employee with no AI Model means
 *    no reply at all — the text is still kept.
 */

export const MAX_AUTO_REPLIES_PER_HOUR = 10;

const KEYWORDS = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "START",
  "UNSTOP",
  "YES",
  "HELP",
  "INFO",
  "REVOKE",
  "OPTOUT",
  "OPTIN",
]);

export function isOptOutOrHelpKeyword(body: string): boolean {
  return KEYWORDS.has(
    body
      .trim()
      .replace(/[.!]+$/, "")
      .toUpperCase(),
  );
}

/**
 * How long a reply waits for an unavailable AI Model. A text answered more
 * than a day later answers a conversation the sender has likely moved on
 * from, and the text is kept in the inbox either way.
 */
export const TEXT_REPLY_WAIT_MS = 24 * 60 * 60_000;

/** One reply at a time per conversation, in the order texts arrived. */
const threadQueues = new Map<string, Promise<unknown>>();

function inThreadQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = threadQueues.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  const tail = result.catch(() => undefined);
  threadQueues.set(key, tail);
  void tail.finally(() => {
    if (threadQueues.get(key) === tail) threadQueues.delete(key);
  });
  return result;
}

export function handleFreshInboundText(message: PhoneMessage, number: PhoneNumber): void {
  if (number.textMode !== "reply") return;
  void inThreadQueue(`${number.id}:${message.fromNumber}`, () => replyToText(message.id)).catch(
    (err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[phone] automatic reply for ${number.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    },
  );
}

/** Wait for every queued reply. For tests. */
export async function settleTextReplies(): Promise<void> {
  while (threadQueues.size > 0) await Promise.all([...threadQueues.values()]);
}

export async function replyToText(
  messageId: string,
  deps: { runRestricted?: PhoneTurnRunner } = {},
): Promise<PhoneMessage | null> {
  const outcome = await answerText(messageId, { ...deps, resumed: false });
  return outcome.kind === "sent" ? outcome.sent : null;
}

type TextReplyOutcome =
  | { kind: "sent"; sent: PhoneMessage }
  | { kind: "skipped" }
  /** Its AI Model is unavailable: the reply waits and is written when it is back. */
  | { kind: "waiting" };

async function answerText(
  messageId: string,
  deps: { runRestricted?: PhoneTurnRunner; resumed: boolean },
): Promise<TextReplyOutcome> {
  const skipped: TextReplyOutcome = { kind: "skipped" };
  const message = await AppDataSource.getRepository(PhoneMessage).findOneBy({ id: messageId });
  if (!message || message.direction !== "inbound") return skipped;
  // Read the number afresh: the handling may have changed since the text came
  // in — or while its reply waited for the AI Model.
  const number = await AppDataSource.getRepository(PhoneNumber).findOneBy({
    id: message.phoneNumberId,
  });
  if (!number || number.textMode !== "reply" || !number.employeeId || !number.smsEnabled) {
    return skipped;
  }
  const counterpart = normalizePhoneNumber(message.fromNumber);
  if (!counterpart || counterpart !== message.fromNumber) return skipped;
  if (isOptOutOrHelpKeyword(message.body)) return skipped;
  // A Standdown means no reply at all, however the reply began to wait.
  if (workBlocked(number.companyId, { employeeId: number.employeeId }).blocked) return skipped;

  const thread = await textThread(number.id, counterpart, 30);
  const newestInbound = [...thread].reverse().find((t) => t.direction === "inbound");
  if (newestInbound && newestInbound.id !== message.id) return skipped;
  // A reply that waited: anything sent to them since — by this reply before a
  // restart, by the employee, or by a Member — has already answered.
  if (
    deps.resumed &&
    thread.some(
      (t) => t.direction === "outbound" && t.occurredAt.getTime() >= message.occurredAt.getTime(),
    )
  ) {
    return skipped;
  }
  const recentReplies = await AppDataSource.getRepository(PhoneMessage).count({
    where: {
      phoneNumberId: number.id,
      direction: "outbound",
      toNumber: counterpart,
      autoReply: true,
      occurredAt: MoreThanOrEqual(new Date(Date.now() - 60 * 60 * 1000)),
    },
  });
  if (recentReplies >= MAX_AUTO_REPLIES_PER_HOUR) return skipped;

  const [employee, company, model] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: number.employeeId,
      companyId: number.companyId,
    }),
    AppDataSource.getRepository(Company).findOneBy({ id: number.companyId }),
    getActiveModel(number.employeeId),
  ]);
  if (!employee || !company || !model) return skipped;

  // The AI Model is unavailable: the text is kept, as always, and its reply
  // waits — to be written once the model is back, under every rule above
  // checked again then, and the number's daily limit when it is sent.
  const wait = async (): Promise<TextReplyOutcome> => {
    await waitForModel({
      kind: "phone_text_reply",
      targetId: message.id,
      companyId: number.companyId,
      employeeId: employee.id,
      model,
      groupKey: `${number.id}:${counterpart}`,
    });
    return { kind: "waiting" };
  };
  if (!modelAnswers(model)) return wait();

  let reply: string | null;
  try {
    reply = await runTextReplyTurn({
      model,
      employee,
      company,
      number,
      counterpart,
      thread,
      signal: AbortSignal.timeout(120_000),
      runRestricted: deps.runRestricted ?? runnerForTests ?? undefined,
    });
  } catch (error) {
    if (error instanceof ModelUnavailableError) return wait();
    throw error;
  }
  if (!reply) return skipped;
  const sent = await sendText({
    number,
    to: counterpart,
    body: reply,
    sender: { kind: "auto_reply", employeeId: employee.id },
  });
  return { kind: "sent", sent };
}

function modelAnswers(model: Parameters<typeof isModelAvailable>[0]): boolean {
  try {
    return isModelAvailable(model);
  } catch {
    return true;
  }
}

/**
 * A text reply that waited for its AI Model, written once the model is back.
 * In the conversation's queue, through every rule a fresh text meets — the
 * number's handling, opt-out words, Standdowns, the newest text taking the
 * turn (so several texts that waited are answered once, together), the
 * hourly cap and the number's daily limit — and never when anyone has texted
 * them since. Given up after a day; the text stays in the inbox.
 */
export const phoneTextReplyWait: ModelWaitHandler = {
  concurrency: 4,
  maxAgeMs: () => TEXT_REPLY_WAIT_MS,
  resume: async (wait: AIModelWait): Promise<ModelWaitResult> => {
    const message = await AppDataSource.getRepository(PhoneMessage).findOneBy({
      id: wait.targetId,
    });
    if (!message) return { status: "done" };
    try {
      const outcome = await inThreadQueue(`${message.phoneNumberId}:${message.fromNumber}`, () =>
        answerText(message.id, { resumed: true }),
      );
      return outcome.kind === "waiting" ? { status: "waiting" } : { status: "done" };
    } catch (error) {
      // Refused as a fresh reply would be — the day's limit reached, Twilio
      // saying no: nothing is sent, and nothing waits on for it.
      if (error instanceof PhoneError) {
        // eslint-disable-next-line no-console
        console.warn(`[phone] a reply that waited for its AI Model was not sent: ${error.message}`);
        return { status: "done" };
      }
      throw error;
    }
  },
  abandon: async () => {
    // A day late, nothing is sent; the text is kept in the inbox as always.
  },
};

// ---------------------------------------------------------------------------
// Following up a call the AI Model could not take
// ---------------------------------------------------------------------------

/** How long a call's follow-up text waits for the AI Model. */
export const CALL_FOLLOW_UP_WAIT_MS = 24 * 60 * 60_000;

/**
 * Whether this number may text a caller on its own: only when a Member set it
 * to reply to texts automatically — its owners' standing consent to the AI
 * Employee texting strangers — and the caller is a number that can be texted.
 * The number's written instructions are the second word: the follow-up turn
 * reads them, and skips the text when they say not to.
 */
function canFollowUpByText(number: PhoneNumber, caller: string): boolean {
  if (number.textMode !== "reply" || !number.smsEnabled) return false;
  const textable = normalizePhoneNumber(caller);
  return Boolean(textable) && textable === caller && textable !== number.e164;
}

/**
 * A call taken while the AI Model was unavailable ended with an apology (and,
 * if the caller wanted, a message). When the number may text, one follow-up
 * text waits for the model, to be written once it is back.
 */
export async function scheduleCallFollowUp(
  call: Pick<PhoneCall, "id" | "direction" | "fromNumber" | "companyId">,
  number: PhoneNumber,
  employee: AIEmployee,
): Promise<void> {
  if (call.direction !== "inbound" || !canFollowUpByText(number, call.fromNumber)) return;
  const model = await getActiveModel(employee.id).catch(() => null);
  await waitForModel({
    kind: "phone_call_follow_up",
    targetId: call.id,
    companyId: number.companyId,
    employeeId: employee.id,
    model,
    groupKey: `${number.id}:${call.fromNumber}`,
  });
}

type FollowUpOutcome = { kind: "sent" | "skipped" } | { kind: "waiting" };

async function followUpCall(
  callId: string,
  deps: { runRestricted?: PhoneTurnRunner } = {},
): Promise<FollowUpOutcome> {
  const skipped: FollowUpOutcome = { kind: "skipped" };
  const call = await AppDataSource.getRepository(PhoneCall).findOneBy({ id: callId });
  if (!call || call.direction !== "inbound") return skipped;
  // Read the number afresh: its handling, its employee, its limits as they are now.
  const number = await AppDataSource.getRepository(PhoneNumber).findOneBy({
    id: call.phoneNumberId,
  });
  if (!number || !number.employeeId || number.employeeId !== call.employeeId) return skipped;
  if (!canFollowUpByText(number, call.fromNumber)) return skipped;
  if (workBlocked(number.companyId, { employeeId: number.employeeId }).blocked) return skipped;
  const caller = call.fromNumber;
  // Once a text has passed between them since the call, the conversation has
  // moved on — a text they sent is answered as a text.
  const thread = await textThread(number.id, caller, 10);
  if (thread.some((text) => text.occurredAt.getTime() >= call.createdAt.getTime())) return skipped;
  const recentReplies = await AppDataSource.getRepository(PhoneMessage).count({
    where: {
      phoneNumberId: number.id,
      direction: "outbound",
      toNumber: caller,
      autoReply: true,
      occurredAt: MoreThanOrEqual(new Date(Date.now() - 60 * 60 * 1000)),
    },
  });
  if (recentReplies >= MAX_AUTO_REPLIES_PER_HOUR) return skipped;
  const [employee, company, model] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: number.employeeId,
      companyId: number.companyId,
    }),
    AppDataSource.getRepository(Company).findOneBy({ id: number.companyId }),
    getActiveModel(number.employeeId),
  ]);
  if (!employee || !company || !model) return skipped;
  if (!modelAnswers(model)) return { kind: "waiting" };
  let text: string | null;
  try {
    text = await runCallFollowUpTurn({
      model,
      employee,
      company,
      number,
      counterpart: caller,
      transcript: readCallTranscript(call),
      signal: AbortSignal.timeout(120_000),
      runRestricted: deps.runRestricted ?? runnerForTests ?? undefined,
    });
  } catch (error) {
    if (error instanceof ModelUnavailableError) return { kind: "waiting" };
    throw error;
  }
  if (!text) return skipped;
  await sendText({
    number,
    to: caller,
    body: text,
    sender: { kind: "auto_reply", employeeId: employee.id },
  });
  return { kind: "sent" };
}

function readCallTranscript(call: Pick<PhoneCall, "transcriptJson">): PhoneCallTranscriptTurn[] {
  try {
    const parsed: unknown = JSON.parse(call.transcriptJson || "[]");
    return Array.isArray(parsed) ? (parsed as PhoneCallTranscriptTurn[]) : [];
  } catch {
    return [];
  }
}

/**
 * The follow-up text for a call taken while the AI Model was unavailable,
 * written once the model is back: a restricted, tool-less turn on the number's
 * instructions and the call's transcript, in the caller's text conversation's
 * queue, under the hourly cap and the number's daily limit — and not at all if
 * the number stopped replying to texts, changed hands, a Standdown covers its
 * employee, or a text has passed between them since. Given up after a day.
 */
export const phoneCallFollowUpWait: ModelWaitHandler = {
  concurrency: 2,
  maxAgeMs: () => CALL_FOLLOW_UP_WAIT_MS,
  resume: async (wait: AIModelWait): Promise<ModelWaitResult> => {
    const call = await AppDataSource.getRepository(PhoneCall).findOneBy({ id: wait.targetId });
    if (!call) return { status: "done" };
    try {
      const outcome = await inThreadQueue(`${call.phoneNumberId}:${call.fromNumber}`, () =>
        followUpCall(call.id),
      );
      return outcome.kind === "waiting" ? { status: "waiting" } : { status: "done" };
    } catch (error) {
      if (error instanceof PhoneError) {
        // eslint-disable-next-line no-console
        console.warn(`[phone] a call's follow-up text was not sent: ${error.message}`);
        return { status: "done" };
      }
      throw error;
    }
  },
  abandon: async () => {
    // A day late, no follow-up is sent; the call and its message are kept.
  },
};

/** Test seam: replace the model call in waited replies and follow-ups. */
let runnerForTests: PhoneTurnRunner | null = null;
export function setTextReplyRunnerForTests(runner: PhoneTurnRunner | null): void {
  runnerForTests = runner;
}
