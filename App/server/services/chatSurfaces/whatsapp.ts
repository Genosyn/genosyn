import crypto from "node:crypto";

import { constantTimeEqual } from "../../lib/constantTime.js";
import { sendWhatsAppText, type WhatsAppConfig } from "../../integrations/providers/whatsapp.js";
import { truncateForSurface } from "./types.js";
import type {
  ChatSurfaceAdapter,
  ChatSurfaceWebhookResponse,
  InboundChatTurn,
} from "./types.js";

/**
 * WhatsApp as an external chat surface — the Meta Cloud API half of M59.
 *
 * **A phone number is a weaker identity claim than a Slack or Microsoft Teams
 * id, and that gap is why this adapter never guesses who it is talking to.**
 * A Slack member id or a Microsoft Teams directory id exists because somebody
 * with authority over that workspace created it; it is unique for the life of
 * the tenant and it stops working the day the person is offboarded. A phone
 * number is issued by a carrier to whoever is paying this month. Carriers
 * recycle disconnected numbers to strangers, a SIM swap moves one to a
 * different handset without anything upstream noticing, and the only name
 * that arrives with a message — `contacts[].profile.name` — is a string the
 * sender typed into their own WhatsApp profile and can change between one
 * message and the next.
 *
 * So a number here is a routing key and a display label, never an
 * authorization. Binding an external sender to a Genosyn Member runs through
 * the one-time link in `identity.ts`, where the proof is a live signed-in
 * Genosyn session rather than something WhatsApp asserted, and it is never
 * inferred — not from the number, not from the profile name, and above all
 * not by matching the number against one stored on a Member's record. That
 * last shortcut is the tempting one, and a recycled number is what quietly
 * breaks it.
 *
 * Everything else here is translation: verify Meta's signature, walk the
 * envelope, hand normalized turns to `inbound.ts`, and turn the reply into
 * something a plain-text client can read.
 */

/**
 * WhatsApp caps a text body at 4096 characters. The slack leaves room for the
 * truncation notice `truncateForSurface` appends, same reasoning as Telegram.
 */
export const WHATSAPP_TEXT_LIMIT = 4000;

/** Fenced code survives as indented text; this is the indent. */
const CODE_INDENT = "    ";

/**
 * Render a markdown reply for a client that has never heard of markdown.
 *
 * WhatsApp understands exactly four inline marks — `*bold*`, `_italic_`,
 * `~strikethrough~`, and ``` for monospace — and renders everything else
 * literally, so an untranslated answer arrives wearing its own syntax:
 * asterisk pairs around headings, and link targets hidden inside brackets
 * where nobody can tap them.
 */
export function toWhatsAppText(markdown: string): string {
  const lines = (markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      // Indented rather than wrapped in WhatsApp's own ``` monospace: the
      // fence markers are what a client that does not support them shows
      // verbatim, and an indent degrades to plain text harmlessly.
      out.push(line.trim() ? `${CODE_INDENT}${line.trimEnd()}` : "");
      continue;
    }
    out.push(inlineToWhatsAppText(line.replace(/^ {0,3}#{1,6}\s+/, "")));
  }
  return (
    out
      .join("\n")
      // A run of blank lines becomes one. Vertical space is cheap in a
      // document and expensive in a chat window.
      .replace(/\n{3,}/g, "\n\n")
      // Blank lines are trimmed off both ends, but not the indentation of the
      // first line: a reply that opens with a code block would otherwise lose
      // exactly the indent this function just gave it.
      .replace(/^(?:[^\S\n]*\n)+/, "")
      .replace(/\s+$/, "")
  );
}

function inlineToWhatsAppText(line: string): string {
  return (
    line
      // `[label](url)` → `label (url)`. A bare URL is what WhatsApp makes
      // tappable; the markdown form is what it shows as brackets.
      .replace(/!?\[([^\]\n]*)\]\(([^)\s]*)\)/g, (_match, label: string, url: string) => {
        if (label && url) return `${label} (${url})`;
        return label || url;
      })
      // `***both***` is `*_both_*` here, and has to run before the bold rule
      // or the odd star out lands in the middle of the word.
      .replace(/\*\*\*([^\s*][^*]*?)\*\*\*/g, "*_$1_*")
      .replace(/\*\*([^\s*][^*]*?)\*\*/g, "*$1*")
      .replace(/~~([^\s~][^~]*?)~~/g, "~$1~")
    // Single underscores are left exactly as they are: markdown italics and
    // WhatsApp italics already agree.
  );
}

/**
 * Verify `x-hub-signature-256` over the raw bytes.
 *
 * The raw body, not a re-serialized parse: key order and whitespace are part
 * of what Meta signed, and `JSON.stringify(JSON.parse(x))` is not `x`. These
 * routes mount before the session middleware, so this signature is the only
 * credential in the request — no secret configured means no verification is
 * possible, which is a refusal and never a pass.
 */
export function verifyWhatsAppSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || !header) return false;
  const digest = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  return constantTimeEqual(header.trim(), `sha256=${digest}`);
}

/**
 * Walk Meta's envelope into normalized turns.
 *
 * The shape is `entry[].changes[].value.{contacts,messages,statuses}`, and one
 * delivery can carry several of each — Meta batches, so a burst of messages
 * from two different people can share a single POST. Nothing here decides
 * anything: duplicate deliveries are Meta's retry policy working as intended,
 * and `inbound.ts` suppresses them by `externalMessageId`.
 */
export function normalizeWhatsAppPayload(
  payload: unknown,
  ctx: { connectionId: string; companyId: string },
): InboundChatTurn[] {
  const turns: InboundChatTurn[] = [];
  for (const entry of asArray(asRecord(payload).entry)) {
    for (const change of asArray(asRecord(entry).changes)) {
      const value = asRecord(asRecord(change).value);
      // `value.statuses[]` rides the same field: sent / delivered / read
      // receipts for messages we sent. They are accounting, not conversation,
      // and are never read here at all.
      const contacts = asArray(value.contacts).map(asRecord);
      for (const raw of asArray(value.messages)) {
        const turn = normalizeWhatsAppMessage(asRecord(raw), contacts, ctx);
        if (turn) turns.push(turn);
      }
    }
  }
  return turns;
}

function normalizeWhatsAppMessage(
  message: Record<string, unknown>,
  contacts: Record<string, unknown>[],
  ctx: { connectionId: string; companyId: string },
): InboundChatTurn | null {
  const from = nonEmptyString(message.from);
  if (!from) return null;
  // An unsupported type — a photo, a voice note, a location, a button tap —
  // is dropped in silence rather than answered with an error. A refusal per
  // attachment turns one shared screenshot into three messages from a
  // machine, and the sender's next message is usually the words anyway.
  if (message.type !== "text") return null;
  const body = nonEmptyString(asRecord(message.text).body);
  if (!body) return null;

  const contact = contacts.find((c) => nonEmptyString(c.wa_id) === from);
  const label = contact ? nonEmptyString(asRecord(contact.profile).name) : null;

  return {
    provider: "whatsapp",
    connectionId: ctx.connectionId,
    companyId: ctx.companyId,
    // The Cloud API delivers only 1:1 conversations with the business number
    // — there is no group inbox to subscribe to — so the sender and the
    // thread are the same key, and `group` is constant rather than derived.
    externalKey: from,
    externalUserId: from,
    externalUserLabel: label,
    threadTitle: label,
    text: body,
    group: false,
    externalMessageId: nonEmptyString(message.id),
    replyTo: { to: from },
  };
}

/**
 * Meta's GET subscription check, answered once when an operator saves the
 * webhook URL in the Meta app dashboard.
 */
function verifyWhatsAppHandshake(args: {
  config: Record<string, unknown>;
  query: Record<string, unknown>;
}): ChatSurfaceWebhookResponse | null {
  const cfg = args.config as unknown as WhatsAppConfig;
  if (queryString(args.query["hub.mode"]) !== "subscribe") return null;

  const token = queryString(args.query["hub.verify_token"]);
  const challenge = queryString(args.query["hub.challenge"]);
  if (!cfg.verifyToken || !token || !constantTimeEqual(token, cfg.verifyToken) || !challenge) {
    return {
      status: 403,
      body: "WhatsApp webhook verification failed.",
      contentType: "text/plain; charset=utf-8",
    };
  }
  // Meta wants the challenge echoed as a bare body — any wrapper, JSON or
  // otherwise, fails the subscription with no useful message.
  return { status: 200, body: challenge, contentType: "text/plain; charset=utf-8" };
}

export const whatsappChatSurface: ChatSurfaceAdapter = {
  provider: "whatsapp",
  // Webhook-only, and there is no fallback: Meta has no polling endpoint for
  // inbound messages, so an instance with no public URL cannot receive one.
  transport: "webhook",
  requiresPublicUrl: true,
  textLimit: WHATSAPP_TEXT_LIMIT,

  async send({ config, replyTo, text }) {
    const cfg = config as unknown as WhatsAppConfig;
    const to = typeof replyTo.to === "string" ? replyTo.to.trim() : "";
    if (!to) throw new Error("WhatsApp reply target carries no recipient");
    // Clamped again after conversion: indenting a fenced block adds four
    // characters per line, so a reply that measured under the cap as markdown
    // can cross WhatsApp's hard 4096 on the way out.
    await sendWhatsAppText(cfg, to, truncateForSurface(toWhatsAppText(text), WHATSAPP_TEXT_LIMIT));
  },

  webhook: {
    verifyHandshake: verifyWhatsAppHandshake,

    async verifyAndNormalize({ connectionId, companyId, config, rawBody, headers }) {
      const cfg = config as unknown as WhatsAppConfig;
      if (!verifyWhatsAppSignature(rawBody, headers["x-hub-signature-256"], cfg.appSecret)) {
        return { kind: "reject", status: 401 };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        // Signed, so it did come from Meta, but unreadable. Answer 200 with
        // nothing to do: rejecting only earns the same bytes back on Meta's
        // retry schedule.
        return { kind: "turns", turns: [] };
      }
      return {
        kind: "turns",
        turns: normalizeWhatsAppPayload(payload, { connectionId, companyId }),
      };
    },
  },
};

/**
 * A duplicated query parameter arrives as an array. Refuse it rather than
 * pick one — "which of the two `hub.verify_token` values did you compare"
 * is not a question a verification step should ever have.
 */
function queryString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
