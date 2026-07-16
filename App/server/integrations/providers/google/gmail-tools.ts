import crypto from "node:crypto";
import type {
  IntegrationRuntimeContext,
  IntegrationTool,
  ResolvedAttachment,
} from "../../types.js";
import { clampInt, safeJson } from "./util.js";

/**
 * Gmail tool definitions + handlers, hosted under the umbrella `google`
 * provider. The umbrella refreshes the access token before dispatching here,
 * so we get a known-fresh `accessToken`.
 *
 * Attachments are the one thing we can't resolve alone: turning a
 * `resourceSlug` into bytes needs the DB, the disk, and a grant check, none
 * of which belong in a provider. The umbrella forwards
 * `ctx.resolveAttachments` — a closure the dispatcher pre-bound to the
 * calling employee — and we hand it the specs verbatim. We never learn which
 * Resource the bytes came from, and we can't widen who is allowed to read it.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

/** Gmail's simple (non-resumable) send endpoint rejects messages past ~5 MB
 *  of assembled MIME. The resolver caps raw attachment bytes below this; we
 *  re-check the assembled message so an oversize send fails with our sentence
 *  rather than a Gmail 400. */
const GMAIL_RAW_MAX_BYTES = 5 * 1024 * 1024;

const ATTACHMENTS_PROPERTY = {
  type: "array",
  maxItems: 10,
  description:
    "Optional files to attach, taken from Resources you have been granted. The server reads the bytes itself — do NOT call `export_resource` first and do NOT paste base64 here; just name the resource by slug. Total attachment size is capped at 3 MB; past that, link the resource page instead.",
  items: {
    type: "object",
    properties: {
      resourceSlug: {
        type: "string",
        description: "Slug from `list_resources` / `search_resources`.",
      },
      format: {
        type: "string",
        enum: ["original", "pdf", "html", "md", "txt"],
        description:
          "Defaults to 'original' — the file the human uploaded, byte for byte, which is what you want for an existing PDF or EPUB. The other four render the resource's extracted text into a new document, and are the only options for url/text resources (which have no original file). Do not pass 'pdf' for a resource that is already a PDF: you would send a plain-text reflow of it, losing scans, signatures, and layout.",
      },
      filename: {
        type: "string",
        description:
          "Optional. Overrides the filename the recipient sees. Defaults to the original upload's name, or '<slug>.<format>'.",
      },
    },
    required: ["resourceSlug"],
    additionalProperties: false,
  },
};

/** Shared so the two compose tools cannot drift — `gmail_create_draft`'s
 *  description promises "same fields as `gmail_send_message`". */
const COMPOSE_PROPERTIES: Record<string, unknown> = {
  to: { type: "string" },
  cc: { type: "string" },
  bcc: { type: "string" },
  subject: { type: "string" },
  body: { type: "string", description: "Plain-text body." },
  html: {
    type: "string",
    description: "Optional HTML body — sent as multipart/alternative.",
  },
  attachments: ATTACHMENTS_PROPERTY,
};

const COMPOSE_SCHEMA = {
  type: "object" as const,
  properties: COMPOSE_PROPERTIES,
  required: ["to", "subject", "body"],
  additionalProperties: false,
};

export const gmailTools: IntegrationTool[] = [
  {
    name: "gmail_search_messages",
    description:
      "Search the connected inbox with a Gmail search query (same syntax as the Gmail search bar). Returns message metadata; call `gmail_get_message` for full bodies.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description:
            'Gmail search expression, e.g. "from:acme.com newer_than:7d".',
        },
        maxResults: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Max messages to return (default 20).",
        },
        labelIds: {
          type: "array",
          items: { type: "string" },
          description: "Optional label ids to restrict to (e.g. ['INBOX']).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gmail_get_message",
    description:
      "Fetch one message by id, including headers and body text. Use the `format` argument to control verbosity (default 'full').",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string" },
        format: { type: "string", enum: ["minimal", "metadata", "full"] },
      },
      required: ["messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_send_message",
    description:
      "Send an email from the connected account. Body is plain text; provide `html` for richer formatting. Always requires `to` and `subject`. Pass `attachments` to send files from Resources — name them by slug and the server attaches the bytes for you. If a human should review before the message goes out, use `gmail_create_draft` instead.",
    inputSchema: COMPOSE_SCHEMA,
  },
  {
    name: "gmail_create_draft",
    description:
      "Save an email as a draft in the connected account instead of sending it. Use this whenever a human should review the message before it goes out, or when operating in a draft-only workflow. Same fields as `gmail_send_message`, `attachments` included; the draft appears in the user's Gmail Drafts folder with the files already attached, ready to edit and send.",
    inputSchema: COMPOSE_SCHEMA,
  },
  {
    name: "gmail_list_labels",
    description:
      "List the labels configured on the inbox — useful before filtering or labelling.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export async function invokeGmailTool(
  name: string,
  args: unknown,
  accessToken: string,
  ctx?: Pick<IntegrationRuntimeContext, "resolveAttachments">,
): Promise<unknown> {
  const a = (args as Record<string, unknown>) ?? {};
  switch (name) {
    case "gmail_search_messages": {
      const qs = new URLSearchParams();
      if (typeof a.q === "string" && a.q.trim()) qs.set("q", a.q);
      qs.set("maxResults", String(clampInt(a.maxResults, 1, 100, 20)));
      if (Array.isArray(a.labelIds)) {
        for (const id of a.labelIds) {
          if (typeof id === "string") qs.append("labelIds", id);
        }
      }
      return gmailFetch(accessToken, `/users/me/messages?${qs.toString()}`);
    }
    case "gmail_get_message": {
      if (typeof a.messageId !== "string" || !a.messageId)
        throw new Error("messageId is required");
      const fmt = typeof a.format === "string" ? a.format : "full";
      return gmailFetch(
        accessToken,
        `/users/me/messages/${encodeURIComponent(a.messageId)}?format=${encodeURIComponent(fmt)}`,
      );
    }
    case "gmail_send_message": {
      const raw = await composeRaw(a, ctx);
      return gmailFetch(accessToken, "/users/me/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
    }
    case "gmail_create_draft": {
      const raw = await composeRaw(a, ctx);
      return gmailFetch(accessToken, "/users/me/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: { raw } }),
      });
    }
    case "gmail_list_labels":
      return gmailFetch(accessToken, "/users/me/labels");
    default:
      throw new Error(`Unknown Gmail tool: ${name}`);
  }
}

/** Shared by send + draft so the two paths cannot diverge. */
async function composeRaw(
  a: Record<string, unknown>,
  ctx?: Pick<IntegrationRuntimeContext, "resolveAttachments">,
): Promise<string> {
  const attachments = await resolveAttachments(a.attachments, ctx);
  const raw = encodeRfc822({
    to: str(a.to, "to"),
    cc: maybeStr(a.cc),
    bcc: maybeStr(a.bcc),
    subject: str(a.subject, "subject"),
    body: str(a.body, "body"),
    html: maybeStr(a.html),
    attachments,
  });
  if (raw.length > GMAIL_RAW_MAX_BYTES) {
    throw new Error(
      "The assembled message is too large for Gmail to accept. Attach fewer or smaller files, or link the resource page instead.",
    );
  }
  return raw;
}

async function resolveAttachments(
  specs: unknown,
  ctx?: Pick<IntegrationRuntimeContext, "resolveAttachments">,
): Promise<ResolvedAttachment[]> {
  if (specs === undefined || specs === null) return [];
  if (Array.isArray(specs) && specs.length === 0) return [];
  if (!ctx?.resolveAttachments) {
    throw new Error(
      "Attachments are not available on this call path — only an AI employee with a Resource grant can attach files.",
    );
  }
  return ctx.resolveAttachments(specs);
}

/**
 * Build the base64url-encoded RFC 822 message Gmail's `raw` field wants.
 *
 * Structure depends on what is present, and the attachment-free shapes are
 * left exactly as they were:
 *
 *   body only            → text/plain
 *   body + html          → multipart/alternative
 *   body + attachments   → multipart/mixed [ text/plain, file… ]
 *   body + html + files  → multipart/mixed [ multipart/alternative, file… ]
 */
function encodeRfc822(m: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
  attachments: ResolvedAttachment[];
}): string {
  const headers: string[] = [];
  headers.push(`To: ${addressHeader(m.to, "to")}`);
  if (m.cc) headers.push(`Cc: ${addressHeader(m.cc, "cc")}`);
  if (m.bcc) headers.push(`Bcc: ${addressHeader(m.bcc, "bcc")}`);
  headers.push(`Subject: ${encodeHeader(m.subject)}`);
  headers.push("MIME-Version: 1.0");

  const message = m.attachments.length
    ? mixedMessage(headers, m.body, m.html, m.attachments)
    : bodyOnlyMessage(headers, m.body, m.html);

  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The pre-attachments shape, unchanged. */
function bodyOnlyMessage(
  headers: string[],
  body: string,
  html?: string,
): string {
  if (!html) {
    return [
      ...headers,
      `Content-Type: text/plain; charset="UTF-8"`,
      "Content-Transfer-Encoding: 7bit",
      "",
      body,
    ].join("\r\n");
  }
  const boundary = newBoundary();
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    ...alternativeParts(boundary, body, html),
  ].join("\r\n");
}

function mixedMessage(
  headers: string[],
  body: string,
  html: string | undefined,
  attachments: ResolvedAttachment[],
): string {
  const outer = newBoundary();
  const lines = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    "",
    `--${outer}`,
  ];

  if (html) {
    const inner = newBoundary();
    lines.push(
      `Content-Type: multipart/alternative; boundary="${inner}"`,
      "",
      ...alternativeParts(inner, body, html),
    );
  } else {
    lines.push(
      `Content-Type: text/plain; charset="UTF-8"`,
      "Content-Transfer-Encoding: 7bit",
      "",
      body,
    );
  }

  for (const att of attachments) {
    lines.push(
      `--${outer}`,
      `Content-Type: ${att.contentType}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      "Content-Transfer-Encoding: base64",
      "",
      foldBase64(att.content),
    );
  }
  lines.push(`--${outer}--`, "");
  return lines.join("\r\n");
}

function alternativeParts(
  boundary: string,
  body: string,
  html: string,
): string[] {
  return [
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "Content-Transfer-Encoding: 7bit",
    "",
    body,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    "Content-Transfer-Encoding: 7bit",
    "",
    html,
    `--${boundary}--`,
    "",
  ];
}

function newBoundary(): string {
  return `gsn_${crypto.randomBytes(12).toString("hex")}`;
}

/** RFC 2045 caps encoded lines at 76 characters. */
function foldBase64(buf: Buffer): string {
  const b64 = buf.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join("\r\n");
}

/**
 * Address headers are interpolated raw, so a CR or LF in one would let the
 * caller append headers of its own — a `Bcc:` to somewhere else, say. These
 * values come from a model that routinely reads attacker-authored text via
 * `gmail_get_message`, and now they can carry documents, so reject rather
 * than sanitize: a mangled address should fail loudly, not send somewhere
 * almost-right.
 *
 * Deliberately not routed through `encodeHeader` — that B-encodes the whole
 * string, which corrupts an address list.
 */
function addressHeader(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new Error(`Invalid ${field}: address headers cannot contain line breaks.`);
  }
  return value;
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(`${GMAIL_API}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  const text = await res.text();
  const parsed = safeJson(text);
  if (!res.ok) {
    const msg =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String(
            (parsed as { error?: { message?: unknown } }).error?.message ??
              (parsed as { error?: unknown }).error,
          )
        : null) ?? `Gmail ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return parsed;
}

function encodeHeader(s: string): string {
  return /[^\x20-\x7e]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`
    : s;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new Error(`${field} is required`);
  return v;
}

function maybeStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
