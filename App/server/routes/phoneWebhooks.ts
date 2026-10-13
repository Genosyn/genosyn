import express, { Router, type Request, type Response } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { PhoneCall } from "../db/entities/PhoneCall.js";
import { PhoneMessage } from "../db/entities/PhoneMessage.js";
import { PhoneNumber } from "../db/entities/PhoneNumber.js";
import { phoneVoice } from "../../shared/phone.js";
import { getPublicUrl, isPublicUrlConfigured } from "../services/publicUrl.js";
import { twilioAccountForNumber } from "../services/phone/credentials.js";
import { verifyTwilioSignature } from "../services/phone/signature.js";
import {
  answerIncomingCall,
  applyCallStatus,
  connectOutboundCall,
  handleSpeech,
  handleWait,
  type TwilioCallParams,
} from "../services/phone/calls.js";
import { applyTextStatus, recordInboundText } from "../services/phone/texts.js";
import * as twiml from "../services/phone/twiml.js";

/**
 * Twilio's webhooks for Phone numbers: incoming texts and calls, the turns of
 * a conversation, and delivery and call statuses.
 *
 * Mounted at `/api/phone/webhooks` before the session and trusted-origin
 * middleware, like the chat surface and Stripe receivers: Twilio sends no
 * cookie and no Origin. The `X-Twilio-Signature` header, an HMAC keyed by the
 * Auth Token of the Connection that owns the number, is the only credential —
 * so every handler resolves the number first, verifies the signature against
 * that Connection, and does nothing at all for a request that fails.
 *
 * Every way of failing to find the target answers the same bare 404, so the
 * route cannot be used to learn which ids exist. Nothing here logs a body or
 * a header: both carry phone numbers, and texts carry verification codes.
 */
export const phoneWebhooksRouter = Router();

// Twilio posts form-encoded parameters, and the signature is computed over the
// parsed parameters rather than raw bytes, so the ordinary parser is right.
phoneWebhooksRouter.use(
  express.urlencoded({ extended: false, limit: "64kb", parameterLimit: 200 }),
);

const numberParams = z.object({ numberId: z.string().uuid() }).strict();
const callParams = z.object({ callId: z.string().uuid() }).strict();
const messageParams = z.object({ messageId: z.string().uuid() }).strict();

function formParams(req: Request): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  const body = (req.body ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value))
      out[key] = value.filter((v): v is string => typeof v === "string");
  }
  return out;
}

function firstHeader(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() ?? "";
}

/**
 * Every URL Twilio may have signed for this request: this install's public
 * URL, the address the number's webhooks were set to, and the address the
 * request reached through the proxy. See `services/phone/signature.ts`.
 */
function candidateOrigins(req: Request, number: PhoneNumber): string[] {
  const origins = new Set<string>();
  if (isPublicUrlConfigured()) origins.add(getPublicUrl());
  if (number.webhookBaseUrl) origins.add(number.webhookBaseUrl);
  const proto = firstHeader(req.headers["x-forwarded-proto"]) || req.protocol;
  const host = firstHeader(req.headers["x-forwarded-host"]) || firstHeader(req.headers.host);
  if (host && /^https?$/.test(proto)) origins.add(`${proto}://${host}`);
  return [...origins].map((o) => o.replace(/\/+$/, ""));
}

/**
 * Verify the request for this number. Returns the origin Twilio used — later
 * URLs in the same call are built on it, so a call keeps working on the
 * address it started on — or null when the signature does not hold.
 */
async function authenticate(req: Request, number: PhoneNumber): Promise<string | null> {
  let authToken: string;
  let accountSid: string;
  try {
    const account = await twilioAccountForNumber(number);
    authToken = account.creds.authToken;
    accountSid = account.creds.accountSid;
  } catch {
    return null;
  }
  const params = formParams(req);
  const claimedAccount = typeof params.AccountSid === "string" ? params.AccountSid : "";
  if (claimedAccount && claimedAccount !== accountSid) return null;
  const signature = firstHeader(req.headers["x-twilio-signature"]);
  for (const origin of candidateOrigins(req, number)) {
    if (
      verifyTwilioSignature({ authToken, signature, urls: [`${origin}${req.originalUrl}`], params })
    ) {
      return origin;
    }
  }
  return null;
}

function sendTwiml(res: Response, xml: string): void {
  res.status(200).type("text/xml").send(xml);
}

/** A spoken apology beats Twilio's "an application error has occurred". */
function apologize(number: PhoneNumber | null): string {
  return twiml.response(
    twiml.say(
      "Sorry, something went wrong on our end. Please try again later. Goodbye.",
      phoneVoice(number?.voice),
    ),
    twiml.hangup(),
  );
}

function logFailure(label: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[phone] ${label}:`, err instanceof Error ? err.message : err);
}

async function loadNumber(req: Request): Promise<PhoneNumber | null> {
  const parsed = numberParams.safeParse(req.params);
  if (!parsed.success) return null;
  return AppDataSource.getRepository(PhoneNumber).findOneBy({ id: parsed.data.numberId });
}

async function loadCall(req: Request): Promise<{ call: PhoneCall; number: PhoneNumber } | null> {
  const parsed = callParams.safeParse(req.params);
  if (!parsed.success) return null;
  const call = await AppDataSource.getRepository(PhoneCall).findOneBy({ id: parsed.data.callId });
  if (!call) return null;
  const number = await AppDataSource.getRepository(PhoneNumber).findOneBy({
    id: call.phoneNumberId,
  });
  return number ? { call, number } : null;
}

function callParamsOf(req: Request): TwilioCallParams {
  const p = formParams(req);
  const pick = (key: keyof TwilioCallParams) =>
    typeof p[key] === "string" ? (p[key] as string) : undefined;
  return {
    CallSid: pick("CallSid"),
    AccountSid: pick("AccountSid"),
    From: pick("From"),
    To: pick("To"),
    CallStatus: pick("CallStatus"),
    Direction: pick("Direction"),
    SpeechResult: pick("SpeechResult"),
    CallDuration: pick("CallDuration"),
  };
}

// ---------------------------------------------------------------------------
// A number's own webhooks
// ---------------------------------------------------------------------------

phoneWebhooksRouter.post("/numbers/:numberId/sms", async (req, res) => {
  const number = await loadNumber(req).catch(() => null);
  if (!number) return res.status(404).end();
  if (!(await authenticate(req, number))) return res.status(403).end();
  const p = formParams(req);
  const sid =
    typeof p.MessageSid === "string" ? p.MessageSid : typeof p.SmsSid === "string" ? p.SmsSid : "";
  if (!sid) return sendTwiml(res, twiml.emptyResponse());
  const media: Array<{ contentType: string; url: string }> = [];
  const count = Math.min(10, Number(p.NumMedia) || 0);
  for (let i = 0; i < count; i += 1) {
    const url = p[`MediaUrl${i}`];
    const contentType = p[`MediaContentType${i}`];
    if (typeof url === "string") {
      media.push({ url, contentType: typeof contentType === "string" ? contentType : "" });
    }
  }
  try {
    await recordInboundText(number, {
      sid,
      from: typeof p.From === "string" ? p.From : "",
      to: typeof p.To === "string" ? p.To : number.e164,
      body: typeof p.Body === "string" ? p.Body : "",
      media,
      occurredAt: new Date(),
    });
  } catch (err) {
    // Twilio retries a delivery it does not see acknowledged; let it.
    logFailure("could not keep an incoming text", err);
    return res.status(500).end();
  }
  // Replies, when the number makes them, go out through the API — never in
  // this response, which has to come back before a model could have written one.
  sendTwiml(res, twiml.emptyResponse());
});

phoneWebhooksRouter.post("/numbers/:numberId/voice", async (req, res) => {
  const number = await loadNumber(req).catch(() => null);
  if (!number) return res.status(404).end();
  const origin = await authenticate(req, number);
  if (!origin) return res.status(403).end();
  try {
    sendTwiml(res, await answerIncomingCall(number, callParamsOf(req), origin));
  } catch (err) {
    logFailure("could not answer a call", err);
    sendTwiml(res, apologize(number));
  }
});

phoneWebhooksRouter.post("/numbers/:numberId/call-status", async (req, res) => {
  const number = await loadNumber(req).catch(() => null);
  if (!number) return res.status(404).end();
  if (!(await authenticate(req, number))) return res.status(403).end();
  const params = callParamsOf(req);
  try {
    const call = params.CallSid
      ? await AppDataSource.getRepository(PhoneCall).findOneBy({
          providerSid: params.CallSid,
          phoneNumberId: number.id,
        })
      : null;
    if (call) await applyCallStatus(call, params);
  } catch (err) {
    logFailure("could not record a call status", err);
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// One call's webhooks
// ---------------------------------------------------------------------------

phoneWebhooksRouter.post("/calls/:callId/answer", async (req, res) => {
  const target = await loadCall(req).catch(() => null);
  if (!target) return res.status(404).end();
  const origin = await authenticate(req, target.number);
  if (!origin) return res.status(403).end();
  try {
    sendTwiml(res, await connectOutboundCall(target.call, target.number, origin));
  } catch (err) {
    logFailure("could not start a placed call", err);
    sendTwiml(res, twiml.response(twiml.hangup()));
  }
});

phoneWebhooksRouter.post("/calls/:callId/listen", async (req, res) => {
  const target = await loadCall(req).catch(() => null);
  if (!target) return res.status(404).end();
  const origin = await authenticate(req, target.number);
  if (!origin) return res.status(403).end();
  try {
    const phase = typeof req.query.phase === "string" ? req.query.phase : null;
    sendTwiml(
      res,
      await handleSpeech({
        call: target.call,
        number: target.number,
        params: callParamsOf(req),
        phase,
        base: origin,
      }),
    );
  } catch (err) {
    logFailure("could not continue a call", err);
    sendTwiml(res, apologize(target.number));
  }
});

phoneWebhooksRouter.post("/calls/:callId/wait", async (req, res) => {
  const target = await loadCall(req).catch(() => null);
  if (!target) return res.status(404).end();
  const origin = await authenticate(req, target.number);
  if (!origin) return res.status(403).end();
  const turnId = typeof req.query.turn === "string" ? req.query.turn : "";
  try {
    sendTwiml(
      res,
      await handleWait({ call: target.call, number: target.number, turnId, base: origin }),
    );
  } catch (err) {
    logFailure("could not continue a call", err);
    sendTwiml(res, apologize(target.number));
  }
});

phoneWebhooksRouter.post("/calls/:callId/status", async (req, res) => {
  const target = await loadCall(req).catch(() => null);
  if (!target) return res.status(404).end();
  if (!(await authenticate(req, target.number))) return res.status(403).end();
  try {
    const params = callParamsOf(req);
    if (!target.call.providerSid || params.CallSid === target.call.providerSid) {
      await applyCallStatus(target.call, params);
    }
  } catch (err) {
    logFailure("could not record a call status", err);
  }
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// One outbound text's delivery status
// ---------------------------------------------------------------------------

phoneWebhooksRouter.post("/messages/:messageId/status", async (req, res) => {
  const parsed = messageParams.safeParse(req.params);
  if (!parsed.success) return res.status(404).end();
  const message = await AppDataSource.getRepository(PhoneMessage)
    .findOneBy({ id: parsed.data.messageId })
    .catch(() => null);
  if (!message || message.direction !== "outbound") return res.status(404).end();
  const number = await AppDataSource.getRepository(PhoneNumber)
    .findOneBy({ id: message.phoneNumberId })
    .catch(() => null);
  if (!number) return res.status(404).end();
  if (!(await authenticate(req, number))) return res.status(403).end();
  const p = formParams(req);
  const sid = typeof p.MessageSid === "string" ? p.MessageSid : "";
  if (message.providerSid && sid && sid !== message.providerSid) return res.status(204).end();
  try {
    await applyTextStatus({
      message,
      status: typeof p.MessageStatus === "string" ? p.MessageStatus : "",
      errorCode: Number(p.ErrorCode) || null,
    });
  } catch (err) {
    logFailure("could not record a text status", err);
  }
  res.status(204).end();
});
