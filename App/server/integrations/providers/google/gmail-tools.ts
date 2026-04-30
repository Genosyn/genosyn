import type { IntegrationTool } from "../../types.js";
import { clampInt, safeJson } from "./util.js";

/**
 * Gmail tool definitions + handlers, hosted under the umbrella `google`
 * provider. The umbrella refreshes the access token before dispatching here,
 * so we get a known-fresh `accessToken` and never need to know about
 * `IntegrationRuntimeContext`.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

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
      "Send an email from the connected account. Body is plain text; provide `html` for richer formatting. Always requires `to` and `subject`. If a human should review before the message goes out, use `gmail_create_draft` instead.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body." },
        html: {
          type: "string",
          description: "Optional HTML body — sent as multipart/alternative.",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
  {
    name: "gmail_create_draft",
    description:
      "Save an email as a draft in the connected account instead of sending it. Use this whenever a human should review the message before it goes out, or when operating in a draft-only workflow. Same fields as `gmail_send_message`; the draft appears in the user's Gmail Drafts folder ready to edit and send.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        cc: { type: "string" },
        bcc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body." },
        html: {
          type: "string",
          description: "Optional HTML body — sent as multipart/alternative.",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
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
      const raw = encodeRfc822({
        to: str(a.to),
        cc: maybeStr(a.cc),
        bcc: maybeStr(a.bcc),
        subject: str(a.subject),
        body: str(a.body),
        html: maybeStr(a.html),
      });
      return gmailFetch(accessToken, "/users/me/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ raw }),
      });
    }
    case "gmail_create_draft": {
      const raw = encodeRfc822({
        to: str(a.to),
        cc: maybeStr(a.cc),
        bcc: maybeStr(a.bcc),
        subject: str(a.subject),
        body: str(a.body),
        html: maybeStr(a.html),
      });
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

function encodeRfc822(m: {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  body: string;
  html?: string;
}): string {
  const headers: string[] = [];
  headers.push(`To: ${m.to}`);
  if (m.cc) headers.push(`Cc: ${m.cc}`);
  if (m.bcc) headers.push(`Bcc: ${m.bcc}`);
  headers.push(`Subject: ${encodeHeader(m.subject)}`);
  headers.push("MIME-Version: 1.0");

  let message: string;
  if (m.html) {
    const boundary = `gsn_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    message = [
      headers.join("\r\n"),
      "",
      `--${boundary}`,
      `Content-Type: text/plain; charset="UTF-8"`,
      "Content-Transfer-Encoding: 7bit",
      "",
      m.body,
      `--${boundary}`,
      `Content-Type: text/html; charset="UTF-8"`,
      "Content-Transfer-Encoding: 7bit",
      "",
      m.html,
      `--${boundary}--`,
      "",
    ].join("\r\n");
  } else {
    headers.push(`Content-Type: text/plain; charset="UTF-8"`);
    headers.push("Content-Transfer-Encoding: 7bit");
    message = `${headers.join("\r\n")}\r\n\r\n${m.body}`;
  }
  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function encodeHeader(s: string): string {
  return /[^\x20-\x7e]/.test(s)
    ? `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`
    : s;
}

function str(v: unknown): string {
  if (typeof v !== "string" || !v) throw new Error("Missing required field");
  return v;
}

function maybeStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}
