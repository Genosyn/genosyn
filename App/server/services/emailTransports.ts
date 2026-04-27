import nodemailer from "nodemailer";
import type { EmailProviderKind } from "../db/entities/EmailProvider.js";

/**
 * Transport adapters for every supported email provider kind. Each adapter
 * accepts a decrypted, validated config blob and a normalized message; it
 * returns a `messageId` on success or throws with a user-friendly string
 * (the message is shown in the Email Logs UI and on the Test button).
 *
 * Adding a new provider:
 *   1. Extend `EmailProviderKind` in the entity.
 *   2. Define its config shape + `validateConfig<Kind>` here.
 *   3. Implement `send<Kind>` and register it in `TRANSPORTS` below.
 *   4. Add the kind to `PROVIDER_CATALOG` so the UI knows how to render
 *      the connect form.
 */

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  fromAddress: string;
  replyTo?: string;
};

export type EmailSendResult = {
  messageId: string;
};

export type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
};

export type SendGridConfig = {
  apiKey: string;
};

export type MailgunRegion = "us" | "eu";
export type MailgunConfig = {
  apiKey: string;
  domain: string;
  region: MailgunRegion;
};

export type ResendConfig = {
  apiKey: string;
};

export type PostmarkConfig = {
  serverToken: string;
};

export type EmailProviderConfig =
  | { kind: "smtp"; config: SmtpConfig }
  | { kind: "sendgrid"; config: SendGridConfig }
  | { kind: "mailgun"; config: MailgunConfig }
  | { kind: "resend"; config: ResendConfig }
  | { kind: "postmark"; config: PostmarkConfig };

/**
 * Catalog metadata for the UI — describes the form fields each provider
 * needs and a short pitch for the picker. Pure data so the React client
 * can render forms generically without per-provider components.
 */
export type EmailProviderField = {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "checkbox" | "select";
  required: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string | number | boolean;
};

export type EmailProviderCatalogEntry = {
  kind: EmailProviderKind;
  name: string;
  tagline: string;
  description: string;
  /** Lucide icon name. */
  icon: string;
  fields: EmailProviderField[];
};

export const PROVIDER_CATALOG: EmailProviderCatalogEntry[] = [
  {
    kind: "smtp",
    name: "SMTP",
    tagline: "Any SMTP server — Gmail, Office 365, Postfix, or your provider.",
    description:
      "Generic SMTP transport. Works with Gmail (use an App Password), Office 365, Amazon SES SMTP, or any RFC-compliant server.",
    icon: "Server",
    fields: [
      {
        key: "host",
        label: "Host",
        type: "text",
        required: true,
        placeholder: "smtp.example.com",
      },
      {
        key: "port",
        label: "Port",
        type: "number",
        required: true,
        defaultValue: 587,
        hint: "Common: 587 (STARTTLS), 465 (TLS), 25 (unencrypted, rare).",
      },
      {
        key: "secure",
        label: "Use TLS (port 465)",
        type: "checkbox",
        required: false,
        defaultValue: false,
        hint: "Tick for implicit TLS on port 465. Leave unchecked for STARTTLS on 587.",
      },
      {
        key: "user",
        label: "Username",
        type: "text",
        required: false,
        placeholder: "no-reply@example.com",
      },
      {
        key: "pass",
        label: "Password",
        type: "password",
        required: false,
        hint: "App password for Gmail / Workspace; leave blank for unauthenticated relays.",
      },
    ],
  },
  {
    kind: "sendgrid",
    name: "SendGrid",
    tagline: "Twilio SendGrid — high-volume transactional email API.",
    description:
      "Send via SendGrid's v3 Mail Send API. Create a restricted API key with Mail Send permission at app.sendgrid.com/settings/api_keys.",
    icon: "Send",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        required: true,
        placeholder: "SG.xxxxxxxx",
      },
    ],
  },
  {
    kind: "mailgun",
    name: "Mailgun",
    tagline: "Mailgun by Sinch — domain-based transactional API.",
    description:
      "Send via Mailgun's HTTP API. You need a verified sending domain and a Mailgun API key (Settings → API security).",
    icon: "Mail",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        required: true,
        placeholder: "key-xxxxxxxx",
      },
      {
        key: "domain",
        label: "Sending domain",
        type: "text",
        required: true,
        placeholder: "mg.example.com",
      },
      {
        key: "region",
        label: "Region",
        type: "select",
        required: true,
        defaultValue: "us",
        options: [
          { value: "us", label: "US (api.mailgun.net)" },
          { value: "eu", label: "EU (api.eu.mailgun.net)" },
        ],
      },
    ],
  },
  {
    kind: "resend",
    name: "Resend",
    tagline: "Resend.com — modern transactional email API.",
    description:
      "Send via the Resend HTTP API. Create an API key at resend.com/api-keys; the From address must use a verified domain.",
    icon: "AtSign",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        required: true,
        placeholder: "re_xxxxxxxx",
      },
    ],
  },
  {
    kind: "postmark",
    name: "Postmark",
    tagline: "Postmark by ActiveCampaign — fast transactional delivery.",
    description:
      "Send via Postmark's Email API. Create a Server token at account.postmarkapp.com — the token is per server, not per account.",
    icon: "Mailbox",
    fields: [
      {
        key: "serverToken",
        label: "Server token",
        type: "password",
        required: true,
        placeholder: "POSTMARK_SERVER_TOKEN",
      },
    ],
  },
];

export function getProviderCatalogEntry(
  kind: EmailProviderKind,
): EmailProviderCatalogEntry | null {
  return PROVIDER_CATALOG.find((p) => p.kind === kind) ?? null;
}

// ───────────────────────── validation ──────────────────────────────────────

function asString(v: unknown, label: string, required: boolean): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new Error(`${label} is required`);
    return "";
  }
  if (typeof v !== "string") throw new Error(`${label} must be a string`);
  return v.trim();
}

function asInt(v: unknown, label: string, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) throw new Error(`${label} must be a number`);
  return n;
}

function asBool(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1";
  return Boolean(v);
}

/**
 * Parse + validate an arbitrary form payload into a discriminated config.
 * Throws with a user-friendly message on the first invalid field.
 */
export function validateProviderConfig(
  kind: EmailProviderKind,
  raw: Record<string, unknown>,
): EmailProviderConfig {
  switch (kind) {
    case "smtp": {
      const host = asString(raw["host"], "Host", true);
      const port = asInt(raw["port"], "Port", 587);
      const secure = asBool(raw["secure"]);
      const user = asString(raw["user"], "Username", false);
      const pass = asString(raw["pass"], "Password", false);
      return { kind, config: { host, port, secure, user, pass } };
    }
    case "sendgrid": {
      const apiKey = asString(raw["apiKey"], "API key", true);
      return { kind, config: { apiKey } };
    }
    case "mailgun": {
      const apiKey = asString(raw["apiKey"], "API key", true);
      const domain = asString(raw["domain"], "Sending domain", true);
      const regionRaw = asString(raw["region"], "Region", true).toLowerCase();
      if (regionRaw !== "us" && regionRaw !== "eu") {
        throw new Error("Region must be 'us' or 'eu'");
      }
      return {
        kind,
        config: { apiKey, domain, region: regionRaw as MailgunRegion },
      };
    }
    case "resend": {
      const apiKey = asString(raw["apiKey"], "API key", true);
      return { kind, config: { apiKey } };
    }
    case "postmark": {
      const serverToken = asString(raw["serverToken"], "Server token", true);
      return { kind, config: { serverToken } };
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown email provider kind: ${exhaustive as string}`);
    }
  }
}

/**
 * Mask sensitive fields so the UI can render existing config without leaking
 * passwords. Used by the GET endpoint when returning a provider summary.
 */
export function maskedProviderSummary(
  kind: EmailProviderKind,
  config: EmailProviderConfig["config"],
): Record<string, string> {
  switch (kind) {
    case "smtp": {
      const c = config as SmtpConfig;
      return {
        host: c.host,
        port: String(c.port),
        secure: c.secure ? "true" : "false",
        user: c.user,
      };
    }
    case "sendgrid":
    case "resend": {
      return { apiKey: maskKey((config as { apiKey: string }).apiKey) };
    }
    case "mailgun": {
      const c = config as MailgunConfig;
      return {
        apiKey: maskKey(c.apiKey),
        domain: c.domain,
        region: c.region,
      };
    }
    case "postmark": {
      const c = config as PostmarkConfig;
      return { serverToken: maskKey(c.serverToken) };
    }
  }
}

function maskKey(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// ───────────────────────── senders ─────────────────────────────────────────

async function sendSmtp(
  cfg: SmtpConfig,
  msg: EmailMessage,
): Promise<EmailSendResult> {
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  const info = await transport.sendMail({
    from: msg.fromAddress,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    replyTo: msg.replyTo || undefined,
  });
  return { messageId: info.messageId ?? "" };
}

async function sendSendGrid(
  cfg: SendGridConfig,
  msg: EmailMessage,
): Promise<EmailSendResult> {
  const { name, email } = parseAddress(msg.fromAddress);
  const body = {
    personalizations: [{ to: [{ email: msg.to }] }],
    from: name ? { email, name } : { email },
    reply_to: msg.replyTo ? { email: parseAddress(msg.replyTo).email } : undefined,
    subject: msg.subject,
    content: [
      { type: "text/plain", value: msg.text },
      ...(msg.html ? [{ type: "text/html", value: msg.html }] : []),
    ],
  };
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SendGrid ${res.status}: ${detail || res.statusText}`);
  }
  // SendGrid returns the message id in this header on success.
  const messageId = res.headers.get("x-message-id") ?? "";
  return { messageId };
}

async function sendMailgun(
  cfg: MailgunConfig,
  msg: EmailMessage,
): Promise<EmailSendResult> {
  const base =
    cfg.region === "eu"
      ? "https://api.eu.mailgun.net/v3"
      : "https://api.mailgun.net/v3";
  const url = `${base}/${encodeURIComponent(cfg.domain)}/messages`;
  const form = new URLSearchParams();
  form.set("from", msg.fromAddress);
  form.set("to", msg.to);
  form.set("subject", msg.subject);
  form.set("text", msg.text);
  if (msg.html) form.set("html", msg.html);
  if (msg.replyTo) form.set("h:Reply-To", msg.replyTo);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization:
        "Basic " + Buffer.from(`api:${cfg.apiKey}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    let msgText = text || res.statusText;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.message === "string") msgText = parsed.message;
    } catch {
      // not JSON — keep raw text
    }
    throw new Error(`Mailgun ${res.status}: ${msgText}`);
  }
  let messageId = "";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.id === "string") messageId = parsed.id;
  } catch {
    // Mailgun normally returns JSON; if not, leave id empty
  }
  return { messageId };
}

async function sendResend(
  cfg: ResendConfig,
  msg: EmailMessage,
): Promise<EmailSendResult> {
  const body: Record<string, unknown> = {
    from: msg.fromAddress,
    to: [msg.to],
    subject: msg.subject,
    text: msg.text,
  };
  if (msg.html) body["html"] = msg.html;
  if (msg.replyTo) body["reply_to"] = msg.replyTo;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const errMsg =
      (parsed &&
        typeof parsed === "object" &&
        "message" in parsed &&
        typeof (parsed as { message?: unknown }).message === "string"
        ? (parsed as { message: string }).message
        : null) ?? text ?? res.statusText;
    throw new Error(`Resend ${res.status}: ${errMsg}`);
  }
  const messageId =
    parsed && typeof parsed === "object" && "id" in parsed && typeof (parsed as { id?: unknown }).id === "string"
      ? (parsed as { id: string }).id
      : "";
  return { messageId };
}

async function sendPostmark(
  cfg: PostmarkConfig,
  msg: EmailMessage,
): Promise<EmailSendResult> {
  const body: Record<string, unknown> = {
    From: msg.fromAddress,
    To: msg.to,
    Subject: msg.subject,
    TextBody: msg.text,
    MessageStream: "outbound",
  };
  if (msg.html) body["HtmlBody"] = msg.html;
  if (msg.replyTo) body["ReplyTo"] = msg.replyTo;
  const res = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": cfg.serverToken,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const errMsg =
      (parsed &&
        typeof parsed === "object" &&
        "Message" in parsed &&
        typeof (parsed as { Message?: unknown }).Message === "string"
        ? (parsed as { Message: string }).Message
        : null) ?? text ?? res.statusText;
    throw new Error(`Postmark ${res.status}: ${errMsg}`);
  }
  const messageId =
    parsed && typeof parsed === "object" && "MessageID" in parsed && typeof (parsed as { MessageID?: unknown }).MessageID === "string"
      ? (parsed as { MessageID: string }).MessageID
      : "";
  return { messageId };
}

/**
 * Single dispatch entry point. Routes to the right adapter based on the
 * discriminated `kind` so callers don't need to know about provider types.
 */
export async function sendViaProvider(
  provider: EmailProviderConfig,
  msg: EmailMessage,
): Promise<EmailSendResult> {
  switch (provider.kind) {
    case "smtp":
      return sendSmtp(provider.config, msg);
    case "sendgrid":
      return sendSendGrid(provider.config, msg);
    case "mailgun":
      return sendMailgun(provider.config, msg);
    case "resend":
      return sendResend(provider.config, msg);
    case "postmark":
      return sendPostmark(provider.config, msg);
    default: {
      const exhaustive: never = provider;
      throw new Error(`Unknown provider: ${(exhaustive as { kind: string }).kind}`);
    }
  }
}

/** `Acme <no-reply@acme.com>` → `{name: "Acme", email: "no-reply@acme.com"}`. */
export function parseAddress(addr: string): { name: string; email: string } {
  const trimmed = addr.trim();
  const match = /^(.*)<([^>]+)>\s*$/.exec(trimmed);
  if (match) {
    return { name: match[1].trim().replace(/^"|"$/g, ""), email: match[2].trim() };
  }
  return { name: "", email: trimmed };
}
