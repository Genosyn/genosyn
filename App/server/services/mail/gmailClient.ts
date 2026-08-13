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
/** Sync reads are safe to replay. Keep the retry envelope short enough that a
 * backfill pass still yields regularly, while absorbing the transient Gmail
 * and network failures that otherwise poison a mailbox page forever. */
export const GMAIL_READ_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4_000;
const RETRY_AFTER_MAX_MS = 10_000;

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
  retryAfter: string | null;
  reasons: string[];
  constructor(
    status: number,
    message: string,
    retryAfter: string | null = null,
    reasons: string[] = [],
  ) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.reasons = reasons;
  }
}

export type GmailFetchOptions = {
  /** GETs used by mailbox sync are idempotent and may be retried. Gmail writes
   * deliberately stay single-attempt: retrying an ambiguous send can deliver
   * the same email twice. */
  retry?: "read" | "none";
  /** Test seam. Production callers use the defaults. */
  maxAttempts?: number;
  timeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  rng?: () => number;
};

export function isRetryableGmailReadError(error: unknown): boolean {
  if (error instanceof GmailApiError) {
    const transientQuotaReasons = new Set([
      "backendError",
      "rateLimitExceeded",
      "userRateLimitExceeded",
    ]);
    return (
      error.status === 408 ||
      error.status === 429 ||
      error.status >= 500 ||
      (error.status === 403 && error.reasons.some((reason) => transientQuotaReasons.has(reason)))
    );
  }
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const name = typeof record?.name === "string" ? record.name : "";
  const message = typeof record?.message === "string" ? record.message : String(error);
  const cause =
    record?.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : null;
  const code = typeof cause?.code === "string" ? cause.code : "";
  return /timeout|abort|fetch failed|network|socket hang up|econnreset|econnrefused|enotfound|eai_again|enetunreach|ehostunreach|etimedout|und_err|epipe/i.test(
    `${name} ${message} ${code}`,
  );
}

/** Only a response-size/latency timeout justifies splitting a thread into
 * per-message reads. A Gmail outage or quota response must not fan one failed
 * request out into dozens more. */
export function isGmailTimeoutError(error: unknown): boolean {
  if (error instanceof GmailApiError) return error.status === 408 || error.status === 504;
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const name = typeof record?.name === "string" ? record.name : "";
  const message = typeof record?.message === "string" ? record.message : String(error);
  const cause =
    record?.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : null;
  const code = typeof cause?.code === "string" ? cause.code : "";
  return /timeout|timed out|etimedout/i.test(`${name} ${message} ${code}`);
}

export function gmailReadRetryDelayMs(
  error: unknown,
  retryNumber: number,
  options: { nowMs?: number; rng?: () => number } = {},
): number {
  if (error instanceof GmailApiError && error.retryAfter) {
    const seconds = Number(error.retryAfter);
    const requested =
      Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1_000
        : Math.max(0, Date.parse(error.retryAfter) - (options.nowMs ?? Date.now()));
    if (Number.isFinite(requested)) return Math.min(Math.floor(requested), RETRY_AFTER_MAX_MS);
  }
  const exponent = Math.min(Math.max(0, Math.floor(retryNumber) - 1), 20);
  const ceiling = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** exponent);
  const rawRandom = (options.rng ?? Math.random)();
  const random = Number.isFinite(rawRandom) ? Math.min(1, Math.max(0, rawRandom)) : 0;
  return Math.floor(ceiling * (0.75 + random * 0.25));
}

export function gmailSyncErrorMessage(error: unknown): string {
  if (error instanceof GmailApiError) {
    if (isRetryableGmailReadError(error)) {
      return error.status === 429 || error.status === 403
        ? "Gmail is rate-limiting sync. Genosyn will retry automatically."
        : "Gmail is temporarily unavailable. Genosyn will retry automatically.";
    }
    return error.message;
  }
  if (isRetryableGmailReadError(error)) {
    return "Gmail did not respond in time. Genosyn will retry automatically.";
  }
  return error instanceof Error ? error.message : String(error);
}

export async function gmailFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
  options: GmailFetchOptions = {},
): Promise<unknown> {
  const retryReads = options.retry === "read";
  const maxAttempts = retryReads ? (options.maxAttempts ?? GMAIL_READ_MAX_ATTEMPTS) : 1;
  const timeoutMs = Math.max(1, options.timeoutMs ?? REQUEST_TIMEOUT_MS);
  const sleep =
    options.sleep ??
    ((delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }));

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // A timeout signal cannot be reused after it fires; create a fresh one
      // for every attempt.
      const res = await fetch(`${GMAIL_API}${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (!res.ok) {
        const reasons =
          parsed && typeof parsed === "object" && "error" in parsed
            ? ((parsed as { error?: { errors?: Array<{ reason?: unknown }> } }).error?.errors ?? [])
                .map((entry) => entry.reason)
                .filter((reason): reason is string => typeof reason === "string")
            : [];
        const detail =
          parsed && typeof parsed === "object" && "error" in parsed
            ? String(
                (parsed as { error?: { message?: unknown } }).error?.message ??
                  (parsed as { error?: unknown }).error,
              )
            : `Gmail ${res.status} ${res.statusText}`;
        throw new GmailApiError(res.status, detail, res.headers.get("retry-after"), reasons);
      }
      return parsed;
    } catch (error) {
      if (!retryReads || attempt >= maxAttempts || !isRetryableGmailReadError(error)) throw error;
      await sleep(gmailReadRetryDelayMs(error, attempt, { rng: options.rng }));
    }
  }
  throw new Error("Gmail request exhausted its retry budget");
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
  return (await gmailFetch(token, "/users/me/profile", {}, { retry: "read" })) as GmailProfile;
}

export async function listLabels(token: string): Promise<GmailLabel[]> {
  const res = (await gmailFetch(token, "/users/me/labels", {}, { retry: "read" })) as {
    labels?: GmailLabel[];
  };
  return res.labels ?? [];
}

export async function createLabel(token: string, name: string): Promise<GmailLabel> {
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
  const res = (await gmailFetch(token, `/users/me/threads?${qs}`, {}, { retry: "read" })) as {
    threads?: Array<{ id: string }>;
    nextPageToken?: string;
  };
  return { threads: res.threads ?? [], nextPageToken: res.nextPageToken };
}

export async function getThread(
  token: string,
  id: string,
  format: "full" | "minimal" = "full",
  options: Omit<GmailFetchOptions, "retry"> = {},
): Promise<GmailThread> {
  return (await gmailFetch(
    token,
    `/users/me/threads/${encodeURIComponent(id)}?format=${format}`,
    {},
    { retry: "read", ...options },
  )) as GmailThread;
}

export async function getMessage(
  token: string,
  id: string,
  format: "full" | "minimal" | "metadata" = "full",
  options: Omit<GmailFetchOptions, "retry"> = {},
): Promise<GmailMessage> {
  return (await gmailFetch(
    token,
    `/users/me/messages/${encodeURIComponent(id)}?format=${format}`,
    {},
    { retry: "read", ...options },
  )) as GmailMessage;
}

export async function listHistory(
  token: string,
  opts: { startHistoryId: string; pageToken?: string },
): Promise<GmailHistoryPage> {
  const qs = new URLSearchParams({ startHistoryId: opts.startHistoryId });
  qs.set("maxResults", "500");
  if (opts.pageToken) qs.set("pageToken", opts.pageToken);
  return (await gmailFetch(
    token,
    `/users/me/history?${qs}`,
    {},
    { retry: "read" },
  )) as GmailHistoryPage;
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
  await gmailFetch(token, `/users/me/threads/${encodeURIComponent(id)}/trash`, postJson({}));
}

export async function untrashThread(token: string, id: string): Promise<void> {
  await gmailFetch(token, `/users/me/threads/${encodeURIComponent(id)}/untrash`, postJson({}));
}

export async function listDrafts(
  token: string,
): Promise<Array<{ id: string; message?: { id: string; threadId: string } }>> {
  const drafts: Array<{ id: string; message?: { id: string; threadId: string } }> = [];
  let pageToken: string | undefined;
  for (;;) {
    const qs = new URLSearchParams({ maxResults: "500" });
    if (pageToken) qs.set("pageToken", pageToken);
    const res = (await gmailFetch(token, `/users/me/drafts?${qs}`, {}, { retry: "read" })) as {
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
  return (await gmailFetch(token, `/users/me/drafts/${encodeURIComponent(draftId)}`, {
    ...postJson({ message: threadId ? { raw, threadId } : { raw } }),
    method: "PUT",
  })) as GmailDraft;
}

export async function deleteDraft(token: string, draftId: string): Promise<void> {
  await gmailFetch(token, `/users/me/drafts/${encodeURIComponent(draftId)}`, {
    method: "DELETE",
  });
}

export async function sendDraft(token: string, draftId: string): Promise<GmailMessage> {
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
    {},
    { retry: "read" },
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
    const parts = [
      `--${mixed}`,
      renderBodyPart(m),
      ...attachments.map((a) => `--${mixed}\r\n${renderAttachmentPart(a)}`),
    ];
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
  const text = html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+\n/g, "\n\n")
    .trim();
}

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

/**
 * Decode the character references Gmail uses in snippets while keeping the
 * result plain text. Unknown and invalid references stay visible verbatim.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(
    /&(?:#([0-9]+)|#x([0-9a-f]+)|([a-z][a-z0-9]+));/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined, named: string) => {
      if (named) return HTML_ENTITIES[named.toLowerCase()] ?? entity;
      const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", decimal ? 10 : 16);
      if (
        !Number.isFinite(codePoint) ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return entity;
      }
      return String.fromCodePoint(codePoint);
    },
  );
}

// ---------- Header helpers ----------

export function headerValue(headers: GmailHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name.toLowerCase() === lower)?.value ?? "";
}

/** `"Ada Lovelace" <ada@acme.com>` → { name: "Ada Lovelace", email: "ada@acme.com" } */
export function parseAddress(value: string): { name: string; email: string } {
  const m = value.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) return { name: (m[1] ?? "").trim(), email: m[2].trim() };
  return { name: "", email: value.trim() };
}
