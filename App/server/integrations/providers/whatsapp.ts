import { ConnectionAuthError } from "../types.js";
import type { IntegrationConfig, IntegrationProvider, IntegrationTool } from "../types.js";
import { maskSecret } from "../../lib/secret.js";

/**
 * WhatsApp, through the Meta WhatsApp Cloud API.
 *
 * Like Telegram, this connector faces both ways: the tools below let an AI
 * Employee send outbound messages, but the reason it exists is the reverse —
 * a person messages the company's WhatsApp number and an AI Employee answers.
 * The inbound half lives in `services/chatSurfaces/whatsapp.ts`; everything
 * here is credentials and outbound calls.
 *
 * Four fields instead of one token, because Meta splits the credential across
 * four places: the phone number id names the sender, the access token
 * authorizes the call, the verify token answers Meta's one-time subscription
 * handshake, and the app secret signs every inbound delivery. Only the first
 * two are needed to send. The other two are what make an inbound webhook
 * trustworthy, and asking for them at connect time beats discovering they are
 * missing when the first message arrives.
 *
 * **The 24-hour rule is the thing that trips everyone up.** WhatsApp permits
 * free-form text only within 24 hours of the person's last inbound message.
 * Outside that window Meta accepts nothing but a template it has already
 * approved. It is spelled out in the catalog copy and in *both* tool
 * descriptions on purpose: an AI Employee that does not know this will
 * cheerfully promise a proactive update it cannot send.
 */

/**
 * Meta ships a Graph version every few months and each is supported for
 * roughly two years; the version string rides every URL, so keeping it in one
 * constant makes the periodic bump a one-line change.
 */
export const WHATSAPP_GRAPH_VERSION = "v21.0";
const GRAPH_API = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}`;

export type WhatsAppConfig = {
  /** Meta's id for the sending number — not the number itself. */
  phoneNumberId: string;
  accessToken: string;
  /** Echoed back to Meta during the GET subscription handshake. */
  verifyToken: string;
  /** HMAC key behind `x-hub-signature-256` on every inbound delivery. */
  appSecret: string;
  /** Captured at connect time, for display only. */
  displayPhoneNumber?: string;
  verifiedName?: string;
};

/**
 * Graph error codes worth explaining rather than passing through raw. Meta's
 * own message for the first one is "Message failed to send because more than
 * 24 hours have passed…", which is accurate and still leaves the reader
 * guessing what to do instead.
 */
const WHATSAPP_ERROR_HINTS: Record<number, string> = {
  131047:
    "More than 24 hours have passed since this person last messaged the number, so free-form text is refused — send an approved template with send_template instead.",
  131026:
    "The number is not reachable on WhatsApp, or has not accepted messages from this business.",
  132000: "The template's placeholder count does not match the parameters supplied.",
  132001:
    "No approved template with that name and language — check Meta → WhatsApp Manager → Message templates.",
  190: "The access token is expired or revoked — reconnect with a fresh System User token.",
  130429: "Meta is throttling this number's throughput — send fewer messages per second.",
};

const tools: IntegrationTool[] = [
  {
    name: "send_message",
    description:
      "Send a plain-text WhatsApp message to one person. Only works inside the 24-hour window: WhatsApp permits free-form text only within 24 hours of that person's last inbound message. Once the window has closed Meta refuses the send (error 131047) and send_template is the only way through — so never promise a proactive update this tool can deliver.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient's phone number in E.164 form, e.g. +15550101234.",
        },
        text: {
          type: "string",
          description:
            "Message body. WhatsApp has no markdown — *bold*, _italic_ and ~strikethrough~ are the only formatting it understands. Up to 4096 characters.",
        },
      },
      required: ["to", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "send_template",
    description:
      "Send a message template Meta has already approved. This is the only thing WhatsApp accepts outside the 24-hour window: once 24 hours have passed since the person's last inbound message, free-form text is refused, so a proactive update — a reminder, an alert, an order change — must be a template. Templates cannot be authored here; a human creates one in Meta → WhatsApp Manager → Message templates and submits it for review, which takes minutes to a day. If no approved template fits, say so rather than promising the message.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient's phone number in E.164 form, e.g. +15550101234.",
        },
        templateName: {
          type: "string",
          description: "Template name exactly as it appears in WhatsApp Manager.",
        },
        languageCode: {
          type: "string",
          description:
            'Template language code exactly as registered, e.g. "en_US". A template approved as en_US cannot be sent as "en".',
        },
        bodyParameters: {
          type: "array",
          items: { type: "string" },
          description:
            "Values for the body placeholders {{1}}, {{2}} … in order. Omit entirely for a template with no placeholders.",
        },
      },
      required: ["to", "templateName", "languageCode"],
      additionalProperties: false,
    },
  },
];

export const whatsappProvider: IntegrationProvider = {
  catalog: {
    provider: "whatsapp",
    name: "WhatsApp",
    category: "Communication",
    tagline: "Reach an AI Employee on WhatsApp.",
    description:
      "Connect a WhatsApp Business number through the Meta Cloud API so customers and teammates can message an AI Employee from the app they already use, and grant the connection to an AI Employee to have it answer. Note WhatsApp's 24-hour rule before you plan any outbound work: free-form text is allowed only within 24 hours of the person's last inbound message, and outside that window Meta accepts nothing but a message template it has already approved. Inbound needs a publicly reachable HTTPS URL — Meta delivers messages by webhook and cannot dial home to a laptop.",
    icon: "MessageCircle",
    authMode: "apikey",
    fields: [
      {
        key: "phoneNumberId",
        label: "Phone number ID",
        type: "text",
        placeholder: "123456789012345",
        required: true,
        hint: "Phone number ID from Meta → WhatsApp → API Setup.",
      },
      {
        key: "accessToken",
        label: "Access token",
        type: "password",
        placeholder: "EAAG…",
        required: true,
        hint: "A permanent System User token, not the 24-hour test token.",
      },
      {
        key: "verifyToken",
        label: "Verify token",
        type: "password",
        placeholder: "a long random string you make up",
        required: true,
        hint: "Any string you invent; paste the same one into Meta's webhook configuration.",
      },
      {
        key: "appSecret",
        label: "App secret",
        type: "password",
        required: true,
        hint: "Meta App → Settings → Basic → App Secret. Used to verify every delivery.",
      },
    ],
    enabled: true,
  },

  tools,

  async validateApiKey(input) {
    const phoneNumberId = requireField(input.phoneNumberId, "Phone number ID");
    const accessToken = requireField(input.accessToken, "Access token");
    const verifyToken = requireField(input.verifyToken, "Verify token");
    const appSecret = requireField(input.appSecret, "App secret");

    const body = await whatsappGraphFetch(
      { accessToken },
      `/${encodeURIComponent(phoneNumberId)}`,
      { method: "GET", params: { fields: "display_phone_number,verified_name" } },
    );
    const verifiedName = optionalString(body.verified_name);
    const displayPhoneNumber = optionalString(body.display_phone_number);

    const config: WhatsAppConfig = {
      phoneNumberId,
      accessToken,
      verifyToken,
      appSecret,
      ...(displayPhoneNumber ? { displayPhoneNumber } : {}),
      ...(verifiedName ? { verifiedName } : {}),
    };
    const accountHint = [verifiedName, displayPhoneNumber, maskSecret(accessToken)]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    return { config: config as unknown as IntegrationConfig, accountHint };
  },

  async checkStatus(ctx) {
    const cfg = ctx.config as unknown as WhatsAppConfig;
    try {
      await whatsappGraphFetch(cfg, `/${encodeURIComponent(cfg.phoneNumberId ?? "")}`, {
        method: "GET",
        params: { fields: "display_phone_number,verified_name" },
      });
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        // A revoked token is a reconnect, not a bug to debug — say which.
        status: err instanceof ConnectionAuthError ? "expired" : "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async invokeTool(name, args, ctx) {
    const cfg = ctx.config as unknown as WhatsAppConfig;
    const a = (args as Record<string, unknown>) ?? {};

    switch (name) {
      case "send_message":
        return sendWhatsAppText(cfg, normalizeWhatsAppRecipient(a.to), requireText(a.text));

      case "send_template":
        return whatsappGraphFetch(cfg, messagesPath(cfg), {
          method: "POST",
          json: buildWhatsAppTemplateMessage({
            to: normalizeWhatsAppRecipient(a.to),
            templateName: requireArgString(a.templateName, "templateName"),
            languageCode: requireArgString(a.languageCode, "languageCode"),
            bodyParameters: a.bodyParameters,
          }),
        });

      default:
        throw new Error(`Unknown WhatsApp tool: ${name}`);
    }
  },
};

/**
 * One outbound text message.
 *
 * Exported because the chat surface adapter sends its replies through exactly
 * this call. A reply an AI Employee writes and a message the `send_message`
 * tool sends are the same POST, and keeping two of them would mean two places
 * to fix the next time Meta moves the goalposts.
 */
export function sendWhatsAppText(
  cfg: WhatsAppConfig,
  to: string,
  body: string,
): Promise<Record<string, unknown>> {
  return whatsappGraphFetch(cfg, messagesPath(cfg), {
    method: "POST",
    json: {
      messaging_product: "whatsapp",
      to: normalizeWhatsAppRecipient(to),
      type: "text",
      text: { body },
    },
  });
}

function messagesPath(cfg: WhatsAppConfig): string {
  const id = (cfg.phoneNumberId ?? "").trim();
  if (!id) {
    throw new Error("This connection has no WhatsApp phone number ID — reconnect and fill it in.");
  }
  return `/${encodeURIComponent(id)}/messages`;
}

/**
 * Normalize a recipient to the bare digits Meta wants.
 *
 * People write phone numbers the way they say them — "+1 (555) 010-1234" —
 * and the Cloud API answers a formatted one with a generic "invalid
 * parameter", which reads like a bug in Genosyn rather than a typo in an
 * argument. E.164 tops out at 15 digits; anything under 7 is not a number
 * anyone can be reached on. Strings only — a JSON number has already lost any
 * leading zero by the time it arrives here.
 */
export function normalizeWhatsAppRecipient(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("`to` is required — the recipient's phone number in E.164 form.");
  }
  const digits = value.replace(/[\s()\-.]/g, "").replace(/^\+/, "");
  if (!/^\d{7,15}$/.test(digits)) {
    throw new Error(
      `"${value.trim()}" is not a phone number WhatsApp can reach. Use E.164, e.g. +15550101234.`,
    );
  }
  return digits;
}

/**
 * Build the `type: "template"` message body.
 *
 * A template with no placeholders must be sent with no `components` at all —
 * an empty array is rejected — so an empty parameter list is an omission
 * here rather than something to serialize.
 */
export function buildWhatsAppTemplateMessage(args: {
  to: string;
  templateName: string;
  languageCode: string;
  bodyParameters?: unknown;
}): Record<string, unknown> {
  const parameters = templateParameters(args.bodyParameters);
  const template: Record<string, unknown> = {
    name: args.templateName,
    language: { code: args.languageCode },
  };
  if (parameters.length > 0) {
    template.components = [
      {
        type: "body",
        parameters: parameters.map((text) => ({ type: "text", text })),
      },
    ];
  }
  return {
    messaging_product: "whatsapp",
    to: args.to,
    type: "template",
    template,
  };
}

/** Positional `{{1}}`, `{{2}}` … substitutions, in the order given. */
function templateParameters(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("`bodyParameters` must be an array of strings, in placeholder order.");
  }
  return value.map((entry, index) => {
    if (typeof entry === "string") return entry;
    if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
    throw new Error(`\`bodyParameters[${index}]\` must be a string.`);
  });
}

/** Graph errors: `{error:{message,type,code,error_subcode,fbtrace_id}}`. */
export function whatsappErrorMessage(status: number, parsed: unknown, raw: string): string {
  const { message, code } = readGraphError(parsed);
  const base = message || raw.trim().slice(0, 300) || `HTTP ${status}`;
  let out = `WhatsApp: ${base}${code != null ? ` (code ${code})` : ""}`;
  const hint = code != null ? WHATSAPP_ERROR_HINTS[code] : undefined;
  if (hint) out += ` ${hint}`;
  else if (status === 429) out += " Rate limited by Meta — slow down and retry.";
  return out;
}

/**
 * Whether a failure means the credential itself is finished, as opposed to
 * one call having bad arguments. Only these mark the Connection unusable, so
 * a rejected template does not turn the whole number red.
 */
export function isWhatsAppAuthFailure(status: number, code: number | undefined): boolean {
  return status === 401 || code === 190;
}

export function readGraphError(parsed: unknown): { message: string; code?: number } {
  if (!parsed || typeof parsed !== "object") return { message: "" };
  const err = (parsed as { error?: { message?: unknown; code?: unknown } }).error;
  if (!err || typeof err !== "object") return { message: "" };
  const message = typeof err.message === "string" ? err.message : "";
  return typeof err.code === "number" ? { message, code: err.code } : { message };
}

async function whatsappGraphFetch(
  cfg: Pick<WhatsAppConfig, "accessToken">,
  path: string,
  init: {
    method: "GET" | "POST";
    params?: Record<string, string>;
    json?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const token = (cfg.accessToken ?? "").trim();
  if (!token) {
    throw new Error("This connection has no WhatsApp access token — reconnect and fill it in.");
  }
  const qs = new URLSearchParams(init.params ?? {}).toString();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  const reqInit: RequestInit = { method: init.method, headers };
  if (init.json) {
    headers["content-type"] = "application/json";
    reqInit.body = JSON.stringify(init.json);
  }
  const res = await fetch(`${GRAPH_API}${path}${qs ? `?${qs}` : ""}`, reqInit);
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON body — the status check below owns the failure.
  }
  if (!res.ok) {
    const message = whatsappErrorMessage(res.status, parsed, text);
    if (isWhatsAppAuthFailure(res.status, readGraphError(parsed).code)) {
      throw new ConnectionAuthError(message, "expired");
    }
    throw new Error(message);
  }
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function requireField(value: string | undefined, label: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function requireArgString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`\`${name}\` is required`);
  return value.trim();
}

/** Message bodies keep their own whitespace; only emptiness is an error. */
function requireText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("`text` is required");
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
