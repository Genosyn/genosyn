import { MoreThanOrEqual } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { PhoneMessage } from "../../db/entities/PhoneMessage.js";
import { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import { normalizePhoneNumber } from "../../../shared/phone.js";
import { getActiveModel } from "../models.js";
import { workBlocked } from "../standdowns.js";
import { runTextReplyTurn, type PhoneTurnRunner } from "./conversation.js";
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

/** One reply at a time per conversation, in the order texts arrived. */
const threadQueues = new Map<string, Promise<void>>();

export function handleFreshInboundText(message: PhoneMessage, number: PhoneNumber): void {
  if (number.textMode !== "reply") return;
  const key = `${number.id}:${message.fromNumber}`;
  const previous = threadQueues.get(key) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      await replyToText(message.id);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        `[phone] automatic reply for ${number.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    })
    .finally(() => {
      if (threadQueues.get(key) === next) threadQueues.delete(key);
    });
  threadQueues.set(key, next);
}

export async function replyToText(
  messageId: string,
  deps: { runRestricted?: PhoneTurnRunner } = {},
): Promise<PhoneMessage | null> {
  const message = await AppDataSource.getRepository(PhoneMessage).findOneBy({ id: messageId });
  if (!message || message.direction !== "inbound") return null;
  // Read the number afresh: the handling may have changed since the text came in.
  const number = await AppDataSource.getRepository(PhoneNumber).findOneBy({
    id: message.phoneNumberId,
  });
  if (!number || number.textMode !== "reply" || !number.employeeId || !number.smsEnabled) {
    return null;
  }
  const counterpart = normalizePhoneNumber(message.fromNumber);
  if (!counterpart || counterpart !== message.fromNumber) return null;
  if (isOptOutOrHelpKeyword(message.body)) return null;
  if (workBlocked(number.companyId, { employeeId: number.employeeId }).blocked) return null;

  const thread = await textThread(number.id, counterpart, 30);
  const newestInbound = [...thread].reverse().find((t) => t.direction === "inbound");
  if (newestInbound && newestInbound.id !== message.id) return null;
  const recentReplies = await AppDataSource.getRepository(PhoneMessage).count({
    where: {
      phoneNumberId: number.id,
      direction: "outbound",
      toNumber: counterpart,
      autoReply: true,
      occurredAt: MoreThanOrEqual(new Date(Date.now() - 60 * 60 * 1000)),
    },
  });
  if (recentReplies >= MAX_AUTO_REPLIES_PER_HOUR) return null;

  const [employee, company, model] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).findOneBy({
      id: number.employeeId,
      companyId: number.companyId,
    }),
    AppDataSource.getRepository(Company).findOneBy({ id: number.companyId }),
    getActiveModel(number.employeeId),
  ]);
  if (!employee || !company || !model) return null;

  const reply = await runTextReplyTurn({
    model,
    employee,
    company,
    number,
    counterpart,
    thread,
    signal: AbortSignal.timeout(120_000),
    runRestricted: deps.runRestricted,
  });
  if (!reply) return null;
  return sendText({
    number,
    to: counterpart,
    body: reply,
    sender: { kind: "auto_reply", employeeId: employee.id },
  });
}
