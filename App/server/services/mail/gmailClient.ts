/**
 * Thin, typed Gmail REST client for the Email section (M25).
 *
 * Deliberately dumb: every function takes a known-fresh access token and
 * returns parsed JSON — token refresh, persistence, and grant checks live in
 * `accounts.ts` / the callers. Kept separate from the agent-facing tools in
 * `integrations/providers/google/gmail-tools.ts`, which are one-shot LLM
 * tools; this module is the sync/write-through engine's transport.
 */

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
/** Per-request wall clock — Gmail is fast; anything slower is a hang. */
const REQUEST_TIMEOUT_MS = 30_000;

// ---------- Response shapes (the subset we consume) ----------

export type GmailProfile = {
  emailAddress: string;
  historyId: string;
};

export type GmailLabel = {
  id: string;
  name: string;
  type?: string;
  color?: { textColor?: string; backgroundColor?: string };
};

export type GmailHeader = { name: string; value: string };

export type GmailBody = {
  attachmentId?: string;
  size?: number;
  data?: string;
};

export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** ms epoch as a string. */
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailPart;
};

export type GmailThread = {
  id: string;
  historyId?: string;
  messages?: GmailMessage[];
};

export type GmailDraft = { id: string; message?: GmailMessage };

export type GmailHistoryRecord = {
  id: string;
  messagesAdded?: Array<{ message: GmailMessage }>;
  messagesDeleted?: Array<{ message: GmailMessage }>;
  labelsAdded?: Array<{ message: GmailMessage; labelIds?: string[] }>;
  labelsRemoved?: Array<{ message: GmailMessage; labelIds?: string[] }>;
};

export type GmailHistoryPage = {
  history?: GmailHistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
};

/** Carries the HTTP status so the sync can tell "history expired" (404) apart
 * from transient failures. */
export class GmailApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String(
            (parsed as { error?: { message?: unknown } }).error?.message ??
              (parsed as { error?: unknown }).error,
          )
        : `Gmail ${res.status} ${res.statusText}`;
    throw new GmailApiError(res.status, detail);
  }
  return parsed;
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---------- Endpoints ----------

export async function getProfile(token: string): Promise<GmailProfile> {
  return (await gmailFetch(token, "/users/me/profile")) as GmailProfile;
}

export async function listLabels(token: string): Promise<GmailLabel[]> {
  const res = (await gmailFetch(token, "/users/me/labels")) as {
    labels?: GmailLabel[];
  };
  return res.labels ?? [];
}

export async function createLabel(
  token: string,
  name: string,
): Promise<GmailLabel> {
  return (await gmailFetch(
    token,
    "/users/me/labels",
    postJson({
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    }),
  )) as GmailLabel;
}

export async function listThreads(
  token: string,
  opts: { q?: string; labelIds?: string[]; maxResults?: number; pageToken?: string },
): Promise<{ threads: Array<{ id: string }>; nextPageToken?: string }> {
  const qs = new URLSearchParams();
  if (opts.q) qs.set("q", opts.q);
  for (const id of opts.labelIds ?? []) qs.append("labelIds", id);
  qs.set("maxResults", String(opts.maxResults ?? 100));
  if (opts.pageToken) qs.set("pageToken", opts.pageToken);
  const res = (await gmailFetch(token, `/users/me/threads?${qs}`)) as {
    threads?: Array<{ id: string }>;
    nextPageToken?: string;
  };
  return { threads: res.threads ?? [], nextPageToken: res.nextPageToken };
}

export async function getThread(
  token: string,
  id: string,
  format: "full" | "minimal" = "full",
): Promise<GmailThread> {
  return (await gmailFetch(
    token,
    `/users/me/threads/${encodeURIComponent(id)}?format=${format}`,
  )) as GmailThread;
}

export async function getMessage(
  token: string,
  id: string,
  format: "full" | "minimal" | "metadata" = "full",
): Promise<GmailMessage> {
  return (await gmailFetch(
    token,
    `/users/me/messages/${encodeURIComponent(id)}?format=${format}`,
  )) as GmailMessage;
}

export async function listHistory(
  token: string,
  opts: { startHistoryId: string; pageToken?: string },
): Promise<GmailHistoryPage> {
  const qs = new URLSearchParams({ startHistoryId: opts.startHistoryId });
  qs.set("maxResults", "500");
  if (opts.pageToken) qs.set("pageToken", opts.pageToken);
  return (await gmailFetch(token, `/users/me/history?${qs}`)) as GmailHistoryPage;
}

export async function sendMessage(
  token: string,
  raw: string,
  threadId?: string,
): Promise<GmailMessage> {
  return (await gmailFetch(
    token,
    "/users/me/messages/send",
    postJson(threadId ? { raw, threadId } : { raw }),
  )) as GmailMessage;
}

export async function modifyThread(
  token: string,
  id: string,
  addLabelIds: string[],
  removeLabelIds: string[],
): Promise<void> {
  await gmailFetch(
    token,
    `/users/me/threads/${encodeURIComponent(id)}/modify`,
    postJson({ addLabelIds, removeLabelIds }),
  );
}

export async function trashThread(token: string, id: string): Promise<void> {
  await gmailFetch(
    token,
    `/users/me/threads/${encodeURIComponent(id)}/trash`,
    postJson({}),
  );
}

export async function untrashThread(token: string, id: string): Promise<void> {
  await gmailFetch(
    token,
    `/users/me/threads/${encodeURIComponent(id)}/untrash`,
    postJson({}),
  );
}

export async function listDrafts(
  token: string,
): Promise<Array<{ id: string; message?: { id: string; threadId: string } }>> {
  const drafts: Array<{ id: string; message?: { id: string; threadId: string } }> = [];
  let pageToken: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ maxResults: "500" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = (await gmailFetch(token, `/users/me/drafts?${qs}`)) as {
      drafts?: Array<{ id: string; message?: { id: string; threadId: string } }>;
      nextPageToken?: string;
    };
    drafts.push(...(res.drafts ?? []));
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return drafts;
}

export async function createDraft(
  token: string,
  raw: string,
  threadId?: string,
): Promise<GmailDraft> {
  return (await gmailFetch(
    token,
    "/users/me/drafts",
    postJson({ message: threadId ? { raw, threadId } : { raw } }),
  )) as GmailDraft;
}

export async function updateDraft(
  token: string,
  draftId: string,
  raw: string,
  threadId?: string,
): Promise<GmailDraft> {
  return (await gmailFetch(
    token,
    `/users/me/drafts/${encodeURIComponent(draftId)}`,
    {
      ...postJson({ message: threadId ? { raw, threadId } : { raw } }),
      method: "PUT",
    },
  )) as GmailDraft;
}

export async function deleteDraft(token: string, draftId: string): Promise<void> {
  await gmailFetch(token, `/users/me/drafts/${encodeURIComponent(draftId)}`, {
    method: "DELETE",
  });
}

export async function sendDraft(
  token: string,
  draftId: string,
): Promise<GmailMessage> {
  return (await gmailFetch(
    token,
    "/users/me/drafts/send",
    postJson({ id: draftId }),
  )) as GmailMessage;
}

export async function getAttachment(
  token: string,
  messageId: string,
  attachmentId: string,
): Promise<{ data?: string; size?: number }> {
  return (await gmailFetch(
    token,
    `/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
  )) as { data?: string; size?: number };
}

// ---------- MIME building (outbound) ----------

export type MimeAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

export type MimeFields = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  /** RFC 822 Message-ID of the message being replied to. */
  inReplyTo?: string;
  /** Space-joined References chain, oldest first. */
  references?: string;
  attachments?: MimeAttachment[];
};

function randomBoundary(tag: string): string {
  // Boundaries must be unpredictable enough not to collide with body content;
  // Math.random is fine here (not a security boundary) but is banned in some
  // sandboxes, so mix in high-res time + a counter.
  boundaryCounter += 1;
  return `gsn_${tag}_${Date.now().toString(36)}_${boundaryCounter.toString(36)}`;
}
let boundaryCounter = 0;

/**
 * Build a base64url-encoded RFC 822 message. Bodies are transferred as
 * base64 so any unicode survives verbatim; Gmail normalizes on ingest.
 * With attachments the message is `multipart/mixed`: a body part (itself
 * `multipart/alternative` when HTML is present) followed by one part per file.
 */
export function buildMime(m: MimeFields): string {
  const headers: string[] = [];
  headers.push(`To: ${encodeAddressList(m.to)}`);
  if (m.cc) headers.push(`Cc: ${encodeAddressList(m.cc)}`);
  if (m.bcc) headers.push(`Bcc: ${encodeAddressList(m.bcc)}`);
  headers.push(`Subject: ${encodeHeader(m.subject)}`);
  if (m.inReplyTo) headers.push(`In-Reply-To: ${stripCrlf(m.inReplyTo)}`);
  if (m.references) headers.push(`References: ${stripCrlf(m.references)}`);
  headers.push("MIME-Version: 1.0");

  const attachments = m.attachments ?? [];
  let message: string;
  if (attachments.length > 0) {
    const mixed = randomBoundary("mix");
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    const parts = [`--${mixed}`, renderBodyPart(m), ...attachments.map((a) => `--${mixed}\r\n${renderAttachmentPart(a)}`)];
    message = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}\r\n--${mixed}--\r\n`;
  } else {
    message = `${headers.join("\r\n")}\r\n${renderBodyHeadersAndContent(m)}`;
  }
  return Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The body as a standalone MIME part (used inside multipart/mixed). */
function renderBodyPart(m: MimeFields): string {
  if (m.bodyHtml) {
    const alt = randomBoundary("alt");
    return [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      textPartHeaders("text/plain"),
      "",
      wrapBase64(m.bodyText),
      `--${alt}`,
      textPartHeaders("text/html"),
      "",
      wrapBase64(m.bodyHtml),
      `--${alt}--`,
    ].join("\r\n");
  }
  return `${textPartHeaders("text/plain")}\r\n\r\n${wrapBase64(m.bodyText)}`;
}

/** Body headers + content appended after the top-level headers (no attachments). */
function renderBodyHeadersAndContent(m: MimeFields): string {
  if (m.bodyHtml) {
    const alt = randomBoundary("alt");
    return [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      textPartHeaders("text/plain"),
      "",
      wrapBase64(m.bodyText),
      `--${alt}`,
      textPartHeaders("text/html"),
      "",
      wrapBase64(m.bodyHtml),
      `--${alt}--`,
      "",
    ].join("\r\n");
  }
  return `${textPartHeaders("text/plain")}\r\n\r\n${wrapBase64(m.bodyText)}`;
}

function renderAttachmentPart(a: MimeAttachment): string {
  const name = a.filename.replace(/["\r\n]/g, "");
  const b64 = a.content.toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `Content-Type: ${a.mimeType || "application/octet-stream"}; name="${name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${name}"`,
    "",
    b64,
  ].join("\r\n");
}

function textPartHeaders(mime: string): string {
  return `Content-Type: ${mime}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64`;
}

/** Base64 body content, folded at 76 chars per RFC 2045. */
function wrapBase64(s: string): string {
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return b64.replace(/(.{76})/g, "$1\r\n");
}

/** Strip CR/LF (and stray control chars) from a header value. This is the
 * header-injection guard: without it, a display name or subject carrying a
 * newline could smuggle extra headers (Bcc:, Content-Type:) into the
 * message. Every value that lands in a header goes through this. */
function stripCrlf(s: string): string {
  // Collapse any run of line breaks / control whitespace / spaces to a
  // single space. This is the header-injection guard and also keeps a
  // stray control char out of a header. Deliberately leaves ordinary
  // punctuation (e.g. "-") alone.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f ]+/g, " ").trim();
}

/**
 * RFC 2047-encode a header text value when it contains non-ASCII, folding the
 * base64 into multiple ≤75-char encoded-words so a long unicode subject stays
 * within the line-length limit. Plain-ASCII values pass through untouched
 * (after CRLF stripping).
 */
function encodeHeader(s: string): string {
  const clean = stripCrlf(s);
  if (!/[^\x20-\x7e]/.test(clean)) return clean;
  // Chunk the UTF-8 bytes so each `=?UTF-8?B?...?=` word (prefix+suffix = 12
  // chars) plus its base64 stays under the 75-char encoded-word cap. 45 raw
  // bytes → 60 base64 chars → 72-char word. Split on whole code points so a
  // multibyte char is never sliced across words.
  const words: string[] = [];
  let chunk = "";
  for (const ch of clean) {
    const next = chunk + ch;
    if (Buffer.byteLength(next, "utf8") > 45) {
      words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
      chunk = ch;
    } else {
      chunk = next;
    }
  }
  if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`);
  // Encoded-words are folded with CRLF + a space (folding whitespace between
  // adjacent words is ignored by decoders, per RFC 2047).
  return words.join("\r\n ");
}

/**
 * Sanitize an address-list header (`To`/`Cc`/`Bcc`). Splits on commas and,
 * for each `Display Name <addr>` entry, RFC 2047-encodes the display name
 * (unicode-safe) while passing the angle-addr through with CRLF stripped —
 * so a non-ASCII sender name in a reply produces a valid header, and a
 * newline in either half can't inject a new header line.
 */
function encodeAddressList(value: string): string {
  return stripCrlf(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^(.*?)\s*<([^>]+)>$/);
      if (!m) return stripCrlf(entry);
      const name = m[1].replace(/^"|"$/g, "").trim();
      const addr = stripCrlf(m[2]);
      return name ? `${encodeHeader(name)} <${addr}>` : `<${addr}>`;
    })
    .join(", ");
}

// ---------- Payload parsing (inbound) ----------

export type ParsedAttachment = {
  partId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
};

export type ParsedBodies = {
  text: string;
  html: string;
  attachments: ParsedAttachment[];
};

/** Walk a message payload and pull out the text body, the HTML body, and
 * attachment metadata. Inline images count as attachments too — they carry
 * an `attachmentId` and users expect to be able to download them. */
export function extractBodies(payload: GmailPart | undefined): ParsedBodies {
  const out: ParsedBodies = { text: "", html: "", attachments: [] };
  if (!payload) return out;
  walk(payload, out);
  if (!out.text && out.html) out.text = stripHtml(out.html);
  return out;
}

function walk(part: GmailPart, out: ParsedBodies): void {
  const mime = part.mimeType ?? "";
  const isAttachment = Boolean(part.body?.attachmentId);
  if (isAttachment) {
    out.attachments.push({
      partId: part.partId ?? "",
      attachmentId: part.body?.attachmentId ?? "",
      filename: part.filename || "attachment",
      mimeType: mime || "application/octet-stream",
      size: part.body?.size ?? 0,
    });
  } else if (mime === "text/plain" && !out.text) {
    out.text = decodeBody(part.body);
  } else if (mime === "text/html" && !out.html) {
    out.html = decodeBody(part.body);
  }
  for (const child of part.parts ?? []) walk(child, out);
}

function decodeBody(body: GmailBody | undefined): string {
  if (!body?.data) return "";
  try {
    return Buffer.from(body.data, "base64url").toString("utf8");
  } catch {
    return "";
  }
}

/** Minimal HTML→text for prompts and search — same spirit as the Resources
 * ingester: no DOM dependency, good enough for matching and reading. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+\n/g, "\n\n")
    .trim();
}

// ---------- Header helpers ----------

export function headerValue(
  headers: GmailHeader[] | undefined,
  name: string,
): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

/** `"Ada Lovelace" <ada@acme.com>` → { name: "Ada Lovelace", email: "ada@acme.com" } */
export function parseAddress(value: string): { name: string; email: string } {
  const m = value.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? "").trim(), email: m[2].trim() };
  return { name: "", email: value.trim() };
}
