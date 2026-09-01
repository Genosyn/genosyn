import crypto from "node:crypto";

/**
 * Outbound MIME composition, with no transport in it.
 *
 * This used to live inside `gmailClient.ts` and returned a base64url string,
 * because that is the shape Gmail's `messages.send` wants in its `raw` field.
 * That was fine while Gmail was the only mailbox Genosyn could speak to; it
 * stopped being fine the moment an IMAP/SMTP mailbox needed the same bytes in
 * their ordinary form, to hand to an SMTP server and to `APPEND` into a
 * folder.
 *
 * So composition lives here and produces plain CRLF text. The Gmail adapter
 * base64url-encodes it at the edge ({@link toBase64Url}); the SMTP adapter
 * uses it as-is.
 *
 * Two headers are optional rather than always-on, and the reason matters.
 * Gmail synthesises `From`, `Date` and `Message-ID` when it ingests a message,
 * so the Gmail path deliberately omits all three and lets the server be the
 * authority. An SMTP submission has no such server-side author: a message
 * without `From` and `Date` is malformed, and one without `Message-ID` cannot
 * be threaded by anyone who receives it. The IMAP adapter therefore fills all
 * three in, which is also what makes the copy it appends to Sent look right.
 */

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
  /** Author. Omitted on the Gmail path, where the server fills it in. */
  from?: string;
  /** Origination date. Omitted on the Gmail path for the same reason. */
  date?: Date;
  /** Pre-generated Message-ID, angle brackets included. See
   * {@link generateMessageId} — SMTP submissions need one of their own. */
  messageId?: string;
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
 * Build an RFC 822 message as CRLF text. Bodies are transferred as base64 so
 * any unicode survives verbatim. With attachments the message is
 * `multipart/mixed`: a body part (itself `multipart/alternative` when HTML is
 * present) followed by one part per file.
 *
 * Header order follows the order a reader expects to see them in, with the
 * envelope headers first — some spam filters score on it, and every mail
 * client in the world writes them this way.
 */
export function buildMimeString(m: MimeFields): string {
  const headers: string[] = [];
  if (m.from) headers.push(`From: ${encodeAddressList(m.from)}`);
  headers.push(`To: ${encodeAddressList(m.to)}`);
  if (m.cc) headers.push(`Cc: ${encodeAddressList(m.cc)}`);
  if (m.bcc) headers.push(`Bcc: ${encodeAddressList(m.bcc)}`);
  headers.push(`Subject: ${encodeHeader(m.subject)}`);
  if (m.date) headers.push(`Date: ${formatRfc2822Date(m.date)}`);
  if (m.messageId) headers.push(`Message-ID: ${stripCrlf(m.messageId)}`);
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
  return message;
}

/** The same message as bytes, for SMTP submission and IMAP `APPEND`. */
export function buildMimeBuffer(m: MimeFields): Buffer {
  return Buffer.from(buildMimeString(m), "utf8");
}

/**
 * base64url, the encoding Gmail's `raw` field wants. Kept here rather than in
 * the Gmail adapter so the encoding and the bytes it encodes stay in one file.
 */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * The same message with its `Bcc` header removed.
 *
 * Gmail strips `Bcc` when it ingests a message, which is why the Gmail path
 * never had to think about it. An SMTP relay does not: the bytes handed to
 * `sendMail({ raw })` go out exactly as written, so a `Bcc:` header left in
 * place is delivered to every `To` and `Cc` recipient — which is the one thing
 * a blind copy must never do.
 *
 * So the wire copy is stripped and the copy filed in Sent is not. That is what
 * every mail client does, and it is why the sender can still see who they
 * blind-copied. The two differ by this header alone; the `Message-ID` is
 * identical, so both belong to the same conversation.
 */
export function stripBccHeader(raw: Buffer): Buffer {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) return raw;
  const headers = raw.subarray(0, separator).toString("utf8");
  const kept: string[] = [];
  let dropping = false;
  for (const line of headers.split("\r\n")) {
    // A folded continuation belongs to whichever header opened it, so it is
    // dropped or kept with that header rather than judged on its own.
    if (/^[ \t]/.test(line)) {
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^bcc\s*:/i.test(line);
    if (!dropping) kept.push(line);
  }
  return Buffer.concat([
    Buffer.from(kept.join("\r\n"), "utf8"),
    raw.subarray(separator),
  ]);
}

/**
 * A globally-unique Message-ID for a message we are about to submit.
 *
 * The right-hand side is the sender's domain, which is what receiving servers
 * and DMARC reporters expect to see; the left-hand side is random, because a
 * guessable Message-ID lets an outsider thread a forgery into a conversation.
 */
export function generateMessageId(fromAddress: string): string {
  const at = fromAddress.lastIndexOf("@");
  const domain = at >= 0 ? stripCrlf(fromAddress.slice(at + 1)) : "";
  const host = /^[A-Za-z0-9.-]+$/.test(domain) && domain ? domain : "genosyn.local";
  return `<${crypto.randomBytes(16).toString("hex")}.${Date.now().toString(36)}@${host}>`;
}

/**
 * RFC 2822 §3.3 date, always in UTC.
 *
 * `toUTCString()` is nearly right but ends in "GMT", which RFC 2822 dropped in
 * favour of a numeric offset — a few strict parsers reject the obsolete form,
 * so the last three characters are swapped for `+0000`.
 */
export function formatRfc2822Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000");
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
