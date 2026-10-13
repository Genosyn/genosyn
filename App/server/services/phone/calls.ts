import crypto from "node:crypto";
import { In, IsNull, MoreThanOrEqual } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import {
  FINISHED_CALL_STATUSES,
  PhoneCall,
  type PhoneCallStatus,
  type PhoneCallTranscriptTurn,
} from "../../db/entities/PhoneCall.js";
import { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import { createCall, hangUpCall, TwilioApiError } from "../../integrations/providers/twilio.js";
import {
  formatPhoneNumber,
  MAX_CALL_BRIEF_LENGTH,
  MAX_CALL_OPENING_LENGTH,
  normalizePhoneNumber,
  phoneVoice,
} from "../../../shared/phone.js";
import { recordAudit } from "../audit.js";
import { getActiveModel } from "../models.js";
import { workBlocked } from "../standdowns.js";
import {
  defaultGreeting,
  defaultOpeningLine,
  runCallTurn,
  sanitizeDigits,
  type PhoneTurnRunner,
} from "./conversation.js";
import { twilioAccountForNumber, withTwilioAccount } from "./credentials.js";
import { PhoneError } from "./errors.js";
import * as twiml from "./twiml.js";
import { callWebhookUrl, reachableBaseUrl } from "./webhookUrls.js";

/**
 * Phone calls: an AI Employee answering its number, placing a call, and the
 * conversation in between.
 *
 * A call is a loop of HTTP requests from Twilio, each of which has to be
 * answered within about fifteen seconds with TwiML. Twilio does the hearing
 * (speech recognition on `<Gather>`) and the speaking (`<Say>`), which is why
 * any AI Model can take a call — the employee only ever reads and writes text.
 *
 *   caller speaks ─► /listen ─► start the employee's turn in the background
 *                       │        and wait briefly for it
 *                       ├─ ready ─► say it, listen again
 *                       └─ not yet ─► a short filler, then /wait ─► long-poll
 *                                                                  └─ say it
 *
 * The {@link PhoneCall} row is the rendezvous. The request that starts a turn
 * and the request that collects it may land on different replicas, so the
 * reply is written to the row and read back from it, keyed by a turn id that
 * stops a slow, abandoned turn from overwriting a newer one. Only the request
 * handlers append to the transcript, and Twilio sends one request at a time
 * per call, so the transcript has a single writer.
 */

/** How long the request that heard the caller waits for the reply before a filler. */
const INLINE_REPLY_WAIT_MS = 2_500;
/** How long one `/wait` request holds the line — well inside Twilio's fifteen seconds. */
const WAIT_REQUEST_MS = 9_000;
/** Give up on a turn after this long and end the call politely. */
const REPLY_GIVE_UP_MS = 45_000;
/** Seconds of silence before the listener calls back with nothing. */
const LISTEN_TIMEOUT_SEC = 6;
/** A placed call listens this long for "Hello?" before speaking first. */
const OPENING_LISTEN_SEC = 2;
const MAX_CALL_TURNS = 40;
const MAX_CALL_MS = 20 * 60 * 1000;
const OUTBOUND_RING_TIMEOUT_SEC = 30;
const OUTBOUND_TIME_LIMIT_SEC = 25 * 60;
/** Simultaneous calls one number may be placing. */
const MAX_ACTIVE_OUTBOUND_CALLS = 3;
const MAX_TRANSCRIPT_TURN_CHARS = 2_000;

const FILLERS = ["One moment.", "Let me think.", "Sure, one second.", "Okay, just a moment."];

/** The webhook parameters the engine reads. Everything else Twilio sends is ignored. */
export type TwilioCallParams = {
  CallSid?: string;
  AccountSid?: string;
  From?: string;
  To?: string;
  CallStatus?: string;
  Direction?: string;
  SpeechResult?: string;
  CallDuration?: string;
};

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export type PhoneCallDTO = {
  id: string;
  phoneNumberId: string;
  employeeId: string | null;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  fromDisplay: string;
  toDisplay: string;
  status: PhoneCallStatus;
  handling: PhoneCall["handling"];
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
  endReason: string;
  errorMessage: string;
  brief: string;
  placedBy: "employee" | "member" | null;
  turnCount: number;
  createdAt: string;
  transcript?: PhoneCallTranscriptTurn[];
};

export function readTranscript(call: Pick<PhoneCall, "transcriptJson">): PhoneCallTranscriptTurn[] {
  try {
    const parsed: unknown = JSON.parse(call.transcriptJson || "[]");
    return Array.isArray(parsed) ? (parsed as PhoneCallTranscriptTurn[]) : [];
  } catch {
    return [];
  }
}

export function serializeCall(call: PhoneCall, opts: { transcript?: boolean } = {}): PhoneCallDTO {
  return {
    id: call.id,
    phoneNumberId: call.phoneNumberId,
    employeeId: call.employeeId,
    direction: call.direction,
    from: call.fromNumber,
    to: call.toNumber,
    fromDisplay: formatPhoneNumber(call.fromNumber),
    toDisplay: formatPhoneNumber(call.toNumber),
    status: call.status,
    handling: call.handling,
    answeredAt: call.answeredAt ? call.answeredAt.toISOString() : null,
    endedAt: call.endedAt ? call.endedAt.toISOString() : null,
    durationSec: call.durationSec,
    endReason: call.endReason,
    errorMessage: call.errorMessage,
    brief: call.brief,
    placedBy: call.direction === "inbound" ? null : call.placedByUserId ? "member" : "employee",
    turnCount: call.turnCount,
    createdAt: call.createdAt.toISOString(),
    ...(opts.transcript ? { transcript: readTranscript(call) } : {}),
  };
}

export function isFinished(status: PhoneCallStatus): boolean {
  return FINISHED_CALL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listCalls(args: {
  phoneNumberIds: string[];
  direction?: "inbound" | "outbound";
  limit: number;
}): Promise<PhoneCall[]> {
  if (args.phoneNumberIds.length === 0) return [];
  return AppDataSource.getRepository(PhoneCall).find({
    where: {
      phoneNumberId: In(args.phoneNumberIds),
      ...(args.direction ? { direction: args.direction } : {}),
    },
    order: { createdAt: "DESC" },
    take: args.limit,
  });
}

/** Wait until a call has ended, or the timeout passes. Returns the latest row. */
export async function waitForCallEnd(callId: string, timeoutMs: number): Promise<PhoneCall | null> {
  const repo = AppDataSource.getRepository(PhoneCall);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const call = await repo.findOneBy({ id: callId });
    if (!call || isFinished(call.status) || Date.now() + 2_000 > deadline) return call;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

async function appendTranscript(
  call: PhoneCall,
  turns: Array<Omit<PhoneCallTranscriptTurn, "at">>,
): Promise<PhoneCallTranscriptTurn[]> {
  const repo = AppDataSource.getRepository(PhoneCall);
  const fresh = (await repo.findOneBy({ id: call.id })) ?? call;
  const transcript = readTranscript(fresh);
  const at = new Date().toISOString();
  for (const turn of turns) {
    transcript.push({ ...turn, text: turn.text.slice(0, MAX_TRANSCRIPT_TURN_CHARS), at });
  }
  const callerTurns = transcript.filter((t) => t.speaker === "caller").length;
  await repo.update(
    { id: call.id },
    { transcriptJson: JSON.stringify(transcript), turnCount: callerTurns },
  );
  call.transcriptJson = JSON.stringify(transcript);
  call.turnCount = callerTurns;
  return transcript;
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

type CallContext = {
  number: PhoneNumber;
  employee: AIEmployee | null;
  company: Company | null;
};

async function loadContext(number: PhoneNumber): Promise<CallContext> {
  const [employee, company] = await Promise.all([
    number.employeeId
      ? AppDataSource.getRepository(AIEmployee).findOneBy({
          id: number.employeeId,
          companyId: number.companyId,
        })
      : Promise.resolve(null),
    AppDataSource.getRepository(Company).findOneBy({ id: number.companyId }),
  ]);
  return { number, employee, company };
}

/** Why the AI Employee cannot take a call right now, or null when it can. */
async function unavailableReason(ctx: CallContext): Promise<string | null> {
  if (!ctx.employee || !ctx.company) return "No AI Employee has this number";
  const stopped = workBlocked(ctx.number.companyId, { employeeId: ctx.employee.id });
  if (stopped.blocked) return "AI work is stood down";
  if (!(await getActiveModel(ctx.employee.id))) return "The AI Employee has no AI Model";
  return null;
}

function unavailableTwiml(number: PhoneNumber): string {
  return twiml.response(
    twiml.say(
      "Sorry, no one can take your call right now. Please try again later. Goodbye.",
      phoneVoice(number.voice),
    ),
    twiml.hangup(),
  );
}

function listen(
  base: string,
  call: PhoneCall,
  number: PhoneNumber,
  spoken: string,
  opts: { phase?: string; timeoutSec?: number; digits?: string } = {},
): string {
  const voice = phoneVoice(number.voice);
  return twiml.response(
    opts.digits ? twiml.playDigits(opts.digits) : "",
    twiml.gather({
      action: callWebhookUrl(base, call.id, "listen", opts.phase ? { phase: opts.phase } : {}),
      language: voice.language,
      timeoutSec: opts.timeoutSec ?? LISTEN_TIMEOUT_SEC,
      prompt: twiml.say(spoken, voice),
    }),
  );
}

async function endWith(
  call: PhoneCall,
  number: PhoneNumber,
  spoken: string,
  reason: string,
): Promise<string> {
  if (spoken) await appendTranscript(call, [{ speaker: "employee", text: spoken }]);
  await AppDataSource.getRepository(PhoneCall).update(
    { id: call.id },
    { endReason: reason, replyState: "idle" },
  );
  return twiml.response(twiml.say(spoken, phoneVoice(number.voice)), twiml.hangup());
}

/** Twilio's voice webhook for the number: someone is calling it. */
export async function answerIncomingCall(
  number: PhoneNumber,
  params: TwilioCallParams,
  base: string,
): Promise<string> {
  const sid = (params.CallSid ?? "").trim();
  const repo = AppDataSource.getRepository(PhoneCall);
  let call = sid ? await repo.findOneBy({ providerSid: sid }) : null;
  const ctx = await loadContext(number);
  if (!call) {
    call = await repo.save(
      repo.create({
        companyId: number.companyId,
        phoneNumberId: number.id,
        employeeId: number.employeeId,
        direction: "inbound",
        fromNumber: (params.From ?? "").slice(0, 64) || "unknown",
        toNumber: (params.To ?? number.e164).slice(0, 64),
        providerSid: sid || null,
        status: "ringing",
        handling: "employee",
        transcriptJson: "[]",
      }),
    );
    await recordAudit({
      companyId: number.companyId,
      actorKind: "system",
      action: "phone.call.receive",
      targetType: "phone_call",
      targetId: call.id,
      targetLabel: `Call from ${formatPhoneNumber(call.fromNumber)}`,
      metadata: { phoneNumberId: number.id, callMode: number.callMode },
    });
  }

  if (number.callMode === "decline") {
    await repo.update(
      { id: call.id },
      { handling: "declined", endReason: "Declined by the number's call handling" },
    );
    return twiml.response(twiml.reject());
  }
  if (number.callMode === "forward" && number.forwardTo) {
    await repo.update(
      { id: call.id },
      {
        handling: "forwarded",
        answeredAt: new Date(),
        endReason: `Forwarded to ${formatPhoneNumber(number.forwardTo)}`,
      },
    );
    return twiml.response(
      twiml.dial(number.forwardTo),
      twiml.say("Sorry, no one is available to take your call. Goodbye.", phoneVoice(number.voice)),
      twiml.hangup(),
    );
  }

  const unavailable = await unavailableReason(ctx);
  if (unavailable || !ctx.employee || !ctx.company) {
    await repo.update(
      { id: call.id },
      { handling: "unavailable", answeredAt: new Date(), endReason: unavailable ?? "Unavailable" },
    );
    return unavailableTwiml(number);
  }

  await repo.update(
    { id: call.id },
    { handling: "employee", status: "in-progress", answeredAt: new Date() },
  );
  const greeting = number.greeting.trim() || defaultGreeting(ctx.employee, ctx.company);
  if (readTranscript(call).length === 0) {
    await appendTranscript(call, [{ speaker: "employee", text: greeting }]);
  }
  return listen(base, call, number, greeting);
}

/** Twilio's answer webhook for a call the employee placed: someone picked up. */
export async function connectOutboundCall(
  call: PhoneCall,
  number: PhoneNumber,
  base: string,
): Promise<string> {
  const ctx = await loadContext(number);
  if ((await unavailableReason(ctx)) || !ctx.employee) {
    await AppDataSource.getRepository(PhoneCall).update(
      { id: call.id },
      { answeredAt: new Date(), endReason: "The AI Employee could no longer take the call" },
    );
    return twiml.response(twiml.hangup());
  }
  await AppDataSource.getRepository(PhoneCall).update(
    { id: call.id },
    { status: "in-progress", answeredAt: new Date() },
  );
  // Listen first: people answer with "Hello?", and talking over them is the
  // fastest way to sound like a robocall.
  const voice = phoneVoice(number.voice);
  return twiml.response(
    twiml.gather({
      action: callWebhookUrl(base, call.id, "listen", { phase: "opening" }),
      language: voice.language,
      timeoutSec: OPENING_LISTEN_SEC,
    }),
  );
}

// ---------------------------------------------------------------------------
// The conversation loop
// ---------------------------------------------------------------------------

/** Twilio's `<Gather>` action: the other side said something, or nothing. */
export async function handleSpeech(args: {
  call: PhoneCall;
  number: PhoneNumber;
  params: TwilioCallParams;
  phase: string | null;
  base: string;
  runRestricted?: PhoneTurnRunner;
}): Promise<string> {
  const { call, number, base } = args;
  const speech = (args.params.SpeechResult ?? "").replace(/\s+/g, " ").trim();
  const repo = AppDataSource.getRepository(PhoneCall);
  if (isFinished(call.status)) return twiml.response(twiml.hangup());
  const ctx = await loadContext(number);
  if (!ctx.employee || !ctx.company) {
    return endWith(
      call,
      number,
      "Sorry, I have to go now. Goodbye.",
      "The number no longer has an AI Employee",
    );
  }

  if (args.phase === "opening") {
    const opening = call.openingLine.trim() || defaultOpeningLine(ctx.employee, ctx.company);
    await appendTranscript(call, [
      ...(speech ? [{ speaker: "caller" as const, text: speech }] : []),
      { speaker: "employee" as const, text: opening },
    ]);
    return listen(base, call, number, opening);
  }

  if (!speech) {
    const silences = call.silenceCount + 1;
    await repo.update({ id: call.id }, { silenceCount: silences });
    if (silences >= 2) {
      return endWith(call, number, "I'll let you go. Goodbye.", "No one spoke");
    }
    const prompt = "Are you still there?";
    await appendTranscript(call, [{ speaker: "employee", text: prompt }]);
    return listen(base, call, number, prompt);
  }

  await repo.update({ id: call.id }, { silenceCount: 0 });
  await appendTranscript(call, [{ speaker: "caller", text: speech }]);
  const startedAt = (call.answeredAt ?? call.createdAt).getTime();
  if (call.turnCount >= MAX_CALL_TURNS || Date.now() - startedAt > MAX_CALL_MS) {
    return endWith(
      call,
      number,
      "I'm sorry, I have to wrap up this call now. Thank you, and goodbye.",
      "The call reached its length limit",
    );
  }

  const turnId = crypto.randomUUID();
  await repo.update(
    { id: call.id },
    {
      replyState: "thinking",
      replyTurnId: turnId,
      replyStartedAt: new Date(),
      replyText: "",
      replyEndsCall: false,
      replyDigits: "",
    },
  );
  void produceReply(call.id, turnId, args.runRestricted);
  const settled = await waitForReply(call.id, turnId, INLINE_REPLY_WAIT_MS);
  if (settled && settled.replyState !== "thinking") return speakReply(settled, number, base);
  const filler = FILLERS[call.turnCount % FILLERS.length];
  return twiml.response(
    twiml.say(filler, phoneVoice(number.voice)),
    twiml.redirect(callWebhookUrl(base, call.id, "wait", { turn: turnId })),
  );
}

/** The `/wait` long-poll, for a reply that took longer than a breath. */
export async function handleWait(args: {
  call: PhoneCall;
  number: PhoneNumber;
  turnId: string;
  base: string;
}): Promise<string> {
  const { number, base, turnId } = args;
  if (isFinished(args.call.status)) return twiml.response(twiml.hangup());
  const settled = await waitForReply(args.call.id, turnId, WAIT_REQUEST_MS);
  const call = settled ?? args.call;
  if (call.replyTurnId !== turnId) {
    // A newer turn replaced this one; nothing to say for the old one.
    return listen(base, call, number, "");
  }
  if (call.replyState !== "thinking") return speakReply(call, number, base);
  const started = call.replyStartedAt?.getTime() ?? Date.now();
  if (Date.now() - started > REPLY_GIVE_UP_MS) {
    await AppDataSource.getRepository(PhoneCall).update(
      { id: call.id, replyTurnId: turnId },
      { replyState: "failed", replyTurnId: null },
    );
    return endWith(
      call,
      number,
      "I'm sorry, I'm having trouble answering right now. Someone will follow up. Goodbye.",
      "The AI Employee took too long to answer",
    );
  }
  return twiml.response(twiml.redirect(callWebhookUrl(base, call.id, "wait", { turn: turnId })));
}

async function waitForReply(callId: string, turnId: string, ms: number): Promise<PhoneCall | null> {
  const repo = AppDataSource.getRepository(PhoneCall);
  const deadline = Date.now() + ms;
  for (;;) {
    const call = await repo.findOneBy({ id: callId });
    if (!call || call.replyTurnId !== turnId || call.replyState !== "thinking") return call;
    if (Date.now() + 200 > deadline) return call;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function speakReply(call: PhoneCall, number: PhoneNumber, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(PhoneCall);
  if (call.replyState === "failed") {
    await repo.update({ id: call.id }, { replyState: "idle", replyTurnId: null });
    return endWith(
      call,
      number,
      "I'm sorry, I'm having trouble right now. Someone will follow up with you. Goodbye.",
      "The AI Employee could not answer",
    );
  }
  const text = call.replyText.trim();
  const digits = sanitizeDigits(call.replyDigits);
  await repo.update({ id: call.id }, { replyState: "idle", replyTurnId: null });
  if (call.replyEndsCall) {
    const goodbye = text || "Goodbye.";
    await appendTranscript(call, [
      { speaker: "employee", text: goodbye, ...(digits ? { digits } : {}) },
    ]);
    await repo.update({ id: call.id }, { endReason: "The AI Employee ended the call" });
    return twiml.response(
      twiml.playDigits(digits),
      twiml.say(goodbye, phoneVoice(number.voice)),
      twiml.hangup(),
    );
  }
  const spoken = text || (digits ? "" : "Sorry, could you say that again?");
  await appendTranscript(call, [
    { speaker: "employee", text: spoken, ...(digits ? { digits } : {}) },
  ]);
  return listen(base, call, number, spoken, { digits });
}

/**
 * Write the employee's next reply onto the row. Runs detached from the request
 * that started it; never throws.
 */
async function produceReply(
  callId: string,
  turnId: string,
  runRestricted?: PhoneTurnRunner,
): Promise<void> {
  const repo = AppDataSource.getRepository(PhoneCall);
  const settle = (values: Partial<PhoneCall>) =>
    repo.update({ id: callId, replyTurnId: turnId }, values).catch(() => undefined);
  try {
    const call = await repo.findOneBy({ id: callId });
    if (!call) return;
    const number = await AppDataSource.getRepository(PhoneNumber).findOneBy({
      id: call.phoneNumberId,
    });
    if (!number) {
      await settle({ replyState: "failed" });
      return;
    }
    const ctx = await loadContext(number);
    const model = ctx.employee ? await getActiveModel(ctx.employee.id) : null;
    if (!ctx.employee || !ctx.company || !model) {
      await settle({
        replyState: "failed",
        errorMessage: "No AI Employee or AI Model to answer with.",
      });
      return;
    }
    if (workBlocked(number.companyId, { employeeId: ctx.employee.id }).blocked) {
      await settle({
        replyState: "ready",
        replyText: "I'm sorry, I have to go now. Goodbye.",
        replyEndsCall: true,
      });
      return;
    }
    const result = await runCallTurn({
      model,
      employee: ctx.employee,
      company: ctx.company,
      number,
      call,
      transcript: readTranscript(call),
      signal: AbortSignal.timeout(REPLY_GIVE_UP_MS - 5_000),
      runRestricted,
    });
    await settle({
      replyState: "ready",
      replyText: result.text,
      replyEndsCall: result.endCall,
      replyDigits: result.digits,
    });
  } catch (err) {
    await settle({
      replyState: "failed",
      errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    });
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

const TWILIO_CALL_STATUSES: readonly PhoneCallStatus[] = [
  "queued",
  "ringing",
  "in-progress",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
];

const END_REASONS: Partial<Record<PhoneCallStatus, string>> = {
  busy: "The line was busy",
  "no-answer": "No one answered",
  failed: "The call could not be connected",
  canceled: "The call was canceled before it connected",
};

/** Apply a status callback. A call never moves back to an earlier state. */
const CALL_STATUS_RANK: Record<PhoneCallStatus, number> = {
  queued: 0,
  ringing: 1,
  "in-progress": 2,
  completed: 3,
  busy: 3,
  "no-answer": 3,
  failed: 3,
  canceled: 3,
};

export async function applyCallStatus(call: PhoneCall, params: TwilioCallParams): Promise<void> {
  const raw = (params.CallStatus ?? "").trim();
  const status = raw === "initiated" ? "queued" : raw === "answered" ? "in-progress" : raw;
  if (!(TWILIO_CALL_STATUSES as readonly string[]).includes(status)) return;
  const next = status as PhoneCallStatus;
  // Callbacks are separate requests and can land out of order; a call only
  // ever moves forward, and a finished one stays finished.
  if (isFinished(call.status) || CALL_STATUS_RANK[next] < CALL_STATUS_RANK[call.status]) return;
  const values: Partial<PhoneCall> = { status: next };
  if (next === "in-progress" && !call.answeredAt) values.answeredAt = new Date();
  if (isFinished(next)) {
    values.endedAt = new Date();
    const duration = Number(params.CallDuration);
    if (Number.isFinite(duration) && duration >= 0) values.durationSec = Math.round(duration);
    if (!call.endReason) values.endReason = END_REASONS[next] ?? "The call ended";
  }
  await AppDataSource.getRepository(PhoneCall).update({ id: call.id }, values);
}

// ---------------------------------------------------------------------------
// Placing calls
// ---------------------------------------------------------------------------

export type CallPlacer =
  | { kind: "employee"; employeeId: string; runId: string | null }
  | { kind: "member"; userId: string };

/** Calls the AI Employee placed from this number in the last 24 hours. */
export async function aiCallsInLastDay(phoneNumberId: string): Promise<number> {
  return AppDataSource.getRepository(PhoneCall).count({
    where: {
      phoneNumberId,
      direction: "outbound",
      placedByUserId: IsNull(),
      createdAt: MoreThanOrEqual(new Date(Date.now() - 24 * 60 * 60 * 1000)),
    },
  });
}

export async function placeCall(args: {
  number: PhoneNumber;
  to: string;
  brief: string;
  openingLine: string;
  placer: CallPlacer;
}): Promise<PhoneCall> {
  const { number, placer } = args;
  if (!number.voiceEnabled) {
    throw new PhoneError(
      `${formatPhoneNumber(number.e164)} cannot make calls — it has no voice capability.`,
    );
  }
  const base = reachableBaseUrl();
  if (!base) {
    throw new PhoneError(
      "Calls need a public URL Twilio can reach. An admin can set one at Admin → General → Public URL; texts work without it.",
      409,
    );
  }
  const to = normalizePhoneNumber(args.to);
  if (!to) {
    throw new PhoneError(
      `"${args.to.slice(0, 40)}" is not a phone number. Use E.164 with the country code, e.g. +15550101234.`,
    );
  }
  if (to === number.e164) throw new PhoneError("A number cannot call itself.");
  const brief = args.brief.trim();
  if (!brief)
    throw new PhoneError("Write a brief: who you are calling, why, and what you may agree to.");
  if (brief.length > MAX_CALL_BRIEF_LENGTH) {
    throw new PhoneError(`Keep the brief under ${MAX_CALL_BRIEF_LENGTH} characters.`);
  }
  const openingLine = args.openingLine.replace(/\s+/g, " ").trim();
  if (openingLine.length > MAX_CALL_OPENING_LENGTH) {
    throw new PhoneError(`Keep the opening line under ${MAX_CALL_OPENING_LENGTH} characters.`);
  }
  if (!number.employeeId) {
    throw new PhoneError(
      "Give this number to an AI Employee first — the employee is who talks on the call.",
    );
  }
  if (placer.kind === "employee" && placer.employeeId !== number.employeeId) {
    throw new PhoneError("That phone number is not yours to call from.", 403);
  }
  const stopped = workBlocked(number.companyId, { employeeId: number.employeeId });
  if (stopped.blocked) {
    throw new PhoneError(
      `AI work is stood down, so no calls can be placed: ${stopped.reason}`,
      403,
    );
  }
  if (!(await getActiveModel(number.employeeId))) {
    throw new PhoneError("The AI Employee on this number has no AI Model to talk with.", 409);
  }
  if (placer.kind === "employee") {
    const placed = await aiCallsInLastDay(number.id);
    if (placed >= number.dailyCallLimit) {
      throw new PhoneError(
        `${formatPhoneNumber(number.e164)} has placed its ${number.dailyCallLimit} AI calls for the last 24 hours. An owner or admin can raise the daily limit at Settings → Phone numbers.`,
        429,
      );
    }
  }
  const repo = AppDataSource.getRepository(PhoneCall);
  const active = await repo.count({
    where: {
      phoneNumberId: number.id,
      direction: "outbound",
      status: In(["queued", "ringing", "in-progress"]),
      createdAt: MoreThanOrEqual(new Date(Date.now() - 30 * 60 * 1000)),
    },
  });
  if (active >= MAX_ACTIVE_OUTBOUND_CALLS) {
    throw new PhoneError(
      "This number is already on as many calls as it can place at once. Try again when one ends.",
      429,
    );
  }

  const call = await repo.save(
    repo.create({
      companyId: number.companyId,
      phoneNumberId: number.id,
      employeeId: number.employeeId,
      direction: "outbound",
      fromNumber: number.e164,
      toNumber: to,
      providerSid: null,
      status: "queued",
      handling: "employee",
      brief,
      openingLine,
      runId: placer.kind === "employee" ? placer.runId : null,
      placedByUserId: placer.kind === "member" ? placer.userId : null,
      transcriptJson: "[]",
    }),
  );
  try {
    const account = await twilioAccountForNumber(number);
    const created = await withTwilioAccount(account, (creds) =>
      createCall(creds, {
        from: number.e164,
        to,
        url: callWebhookUrl(base, call.id, "answer"),
        statusCallbackUrl: callWebhookUrl(base, call.id, "status"),
        timeLimitSec: OUTBOUND_TIME_LIMIT_SEC,
        ringTimeoutSec: OUTBOUND_RING_TIMEOUT_SEC,
      }),
    );
    // As with texts, a status callback can arrive before this write; the
    // status itself is left to `applyCallStatus`, which only moves forward.
    await repo.update({ id: call.id }, { providerSid: created.sid });
  } catch (err) {
    await repo.update(
      { id: call.id },
      {
        status: "failed",
        endedAt: new Date(),
        errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 500),
        endReason:
          err instanceof TwilioApiError
            ? "Twilio refused the call"
            : "The call could not be placed",
      },
    );
    throw err;
  }
  const saved = (await repo.findOneBy({ id: call.id })) ?? call;
  await recordAudit({
    companyId: number.companyId,
    actorKind: placer.kind === "member" ? "user" : "ai",
    actorUserId: placer.kind === "member" ? placer.userId : null,
    actorEmployeeId: placer.kind === "employee" ? placer.employeeId : null,
    action: "phone.call.place",
    targetType: "phone_call",
    targetId: saved.id,
    targetLabel: `Call to ${formatPhoneNumber(to)}`,
    metadata: { phoneNumberId: number.id, to },
  });
  return saved;
}

/** End a live call from Genosyn — the Member's hang-up button. */
export async function endCall(
  call: PhoneCall,
  number: PhoneNumber,
  userId: string | null,
): Promise<void> {
  if (isFinished(call.status) || !call.providerSid) return;
  const account = await twilioAccountForNumber(number);
  await withTwilioAccount(account, (creds) => hangUpCall(creds, call.providerSid!));
  await AppDataSource.getRepository(PhoneCall).update(
    { id: call.id },
    { endReason: "Ended from Genosyn" },
  );
  await recordAudit({
    companyId: number.companyId,
    actorUserId: userId,
    action: "phone.call.hang_up",
    targetType: "phone_call",
    targetId: call.id,
    targetLabel: `Call with ${formatPhoneNumber(call.direction === "inbound" ? call.fromNumber : call.toNumber)}`,
  });
}
