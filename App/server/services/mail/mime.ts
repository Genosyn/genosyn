import crypto from "node:crypto";

import { parseAddressList } from "../../lib/emailAddress.js";

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
 *
 * Address headers are the one place a header carries structure, and the
 * grammar is easy to get subtly wrong: a display name with a comma in it must
 * be quoted or it becomes two recipients, a quote inside one must be escaped,
 * and a name outside ASCII must be RFC 2047-encoded rather than quoted.
 * {@link formatMailbox} is the one writer of that grammar — for the wire, and
 * in the decoded form the mirror stores — and {@link displayNameText},
 * {@link decodeMimeWords} and {@link decodeAddressList} read it back, so a
 * name survives the trip through a mail server and into the mirror unchanged.
 */

/** One address with the name shown beside it — the shape of `From`. */
export type MimeMailbox = {
  address: string;
  /** Display name. Empty or absent writes the bare address. */
  name?: string;
};

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
  /** Author. Omitted on the Gmail path, where the server fills it in from the
   * account's own Send mail as settings — name included. */
  from?: MimeMailbox;
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
  if (m.from) headers.push(`From: ${formatMailbox(m.from)}`);
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
 * The same message with `From` restamped as `from` — when, and only when, the
 * `From` it carries is `from`'s own address.
 *
 * This is how a stored draft picks up the mailbox's sender name as it is at
 * the moment of sending. A draft is composed with whatever name the mailbox
 * had then, and an AI-written one can wait days for review; a name set or
 * changed in the meantime must apply to it exactly as it would to a fresh
 * message, or the person who just named the mailbox watches the next fifty
 * approved drafts go out without it. Only the name moves: the address is the
 * one already on the message.
 *
 * Anything else is returned untouched — a draft another mail client wrote from
 * an alias, a message with no `From` at all — because that is somebody's
 * deliberate choice of identity, not a stale copy of ours.
 *
 * The header block is handled as bytes (`latin1` maps each byte to one
 * character and back), so a header another client wrote in a legacy 8-bit
 * charset is carried through exactly instead of being mangled into U+FFFD.
 */
export function refreshFromHeader(raw: Buffer, from: MimeMailbox): Buffer {
  const separator = raw.indexOf("\r\n\r\n");
  if (separator < 0) return raw;
  // One entry per header: its first line plus any folded continuations.
  const headers: string[][] = [];
  for (const line of raw.subarray(0, separator).toString("latin1").split("\r\n")) {
    const current = headers[headers.length - 1];
    if (current && /^[ \t]/.test(line)) current.push(line);
    else headers.push([line]);
  }
  const own = from.address.trim().toLowerCase();
  const stamped = Buffer.from(`From: ${formatMailbox(from)}`, "utf8").toString("latin1");
  let changed = false;
  const rewritten = headers.map((lines) => {
    // Unfolding is removing the CRLF before each continuation line.
    const value = /^from\s*:(.*)$/i.exec(lines.join(""));
    if (!value) return lines.join("\r\n");
    const { addresses } = parseAddressList(value[1]);
    if (addresses.length !== 1 || addresses[0] !== own) return lines.join("\r\n");
    changed = true;
    return stamped;
  });
  if (!changed) return raw;
  return Buffer.concat([Buffer.from(rewritten.join("\r\n"), "latin1"), raw.subarray(separator)]);
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
 * One RFC 5322 `mailbox`: `Avery Monroe <avery@example.com>`, or the bare
 * address when there is no name.
 *
 * The name is written in the plainest form that reads back as exactly the
 * same text:
 *
 * - words of letters, digits and the punctuation RFC 5322 allows in an atom
 *   go out as they are, which is how every mail client writes an ordinary
 *   name;
 * - anything holding a special — a comma, a dot, a quote, an `@` — becomes a
 *   quoted string with `"` and `\` escaped, because an unquoted comma starts a
 *   second recipient and strict parsers refuse an unquoted dot;
 * - anything outside ASCII is RFC 2047-encoded, since a quoted string may
 *   only hold ASCII and an encoded word inside quotes is not decoded.
 *
 * Control characters collapse to a space first. That is the header-injection
 * guard: no name, however it was typed, can end this line and begin another.
 *
 * `decoded` writes the form a header takes once it has been read — the form
 * Gmail's API hands over and the mirror stores. A name outside ASCII is then
 * written as itself rather than encoded, and quoted by the same rule as an
 * ASCII one, so `Doe, Zoë` still reads as one recipient. That form is for
 * reading, never for the wire: replying through {@link buildMimeString}
 * encodes it again.
 */
export function formatMailbox(mailbox: MimeMailbox, options: { decoded?: boolean } = {}): string {
  const address = stripCrlf(mailbox.address);
  const name = stripCrlf(mailbox.name ?? "");
  if (!name) return address;
  return `${encodeDisplayName(name, options.decoded === true)} <${address}>`;
}

/** An atom's characters (RFC 5322 §3.2.3) and the spaces between atoms. */
const PLAIN_DISPLAY_NAME = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/;
/** The same, plus the characters outside ASCII that RFC 6532 lets an atom hold. */
const PLAIN_DECODED_DISPLAY_NAME = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ \u0080-\uffff]+$/;

function encodeDisplayName(name: string, decoded: boolean): string {
  if (!decoded && /[^\x20-\x7e]/.test(name)) return encodeHeader(name);
  if ((decoded ? PLAIN_DECODED_DISPLAY_NAME : PLAIN_DISPLAY_NAME).test(name)) return name;
  return `"${name.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * A display name as written in a header, read back as the text it shows.
 *
 * Quoted segments lose their quotes and backslash escapes; everything else is
 * kept as it is. So `"Doe, John"` reads `Doe, John`, `"Avery \"AJ\" Monroe"`
 * reads `Avery "AJ" Monroe`, and `"Ada" Lovelace` — two words, one of them
 * quoted — reads `Ada Lovelace`.
 */
export function displayNameText(raw: string): string {
  let text = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted && ch === "\\" && i + 1 < raw.length) text += raw[++i];
    else if (ch === '"') quoted = !quoted;
    else text += ch;
  }
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Sanitize an address-list header (`To`/`Cc`/`Bcc`) as a person typed it.
 *
 * Entries split on the commas *between* recipients — not one inside a quoted
 * name, so `"Doe, John" <john@x.com>` stays one recipient, the same reading
 * `parseAddressList` gives the SMTP envelope. Each `Name <address>` entry is
 * rewritten by {@link formatMailbox}, which also keeps a newline in either
 * half from injecting a header; a bare address passes through as typed.
 */
function encodeAddressList(value: string): string {
  return splitAddressList(stripCrlf(value))
    .map((entry) => {
      const named = /^(.*?)\s*<([^<>]*)>$/.exec(entry);
      if (!named) return entry;
      return formatMailbox({ name: displayNameText(named[1]), address: named[2] });
    })
    .filter(Boolean)
    .join(", ");
}

/** Split a recipient list on the commas outside quoted names and angle addresses. */
export function splitAddressList(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quoted && ch === "\\" && i + 1 < value.length) {
      current += ch + value[++i];
      continue;
    }
    if (ch === "," && !quoted && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    if (ch === '"' && !angled) quoted = !quoted;
    else if (ch === "<" && !quoted) angled = true;
    else if (ch === ">" && !quoted) angled = false;
    current += ch;
  }
  entries.push(current);
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

// ───────────────────────────── reading headers back ─────────────────────────────

/** `=?charset?B|Q?text?=` — one RFC 2047 encoded word. */
const ENCODED_WORD = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;

type EncodedRun = { charset: string; bytes: Buffer[]; source: string };

/**
 * Decode the RFC 2047 encoded words in a header's text — the inverse of
 * {@link encodeHeader}.
 *
 * Gmail's API hands headers over already decoded. An IMAP server hands over
 * the bytes exactly as they were sent, so without this a sender called Zoë
 * reads `=?UTF-8?B?Wm/Dqw==?=` in the mirror.
 *
 * Whitespace between two adjacent encoded words is folding, not text (RFC 2047
 * §6.2). Adjacent words in one charset are decoded as a single run of bytes,
 * because some senders split one multi-byte character across two words. A
 * word in a charset this runtime cannot decode is left exactly as written
 * rather than guessed at.
 */
export function decodeMimeWords(value: string): string {
  if (!value.includes("=?")) return value;
  const pieces: Array<string | EncodedRun> = [];
  let cursor = 0;
  for (const match of value.matchAll(ENCODED_WORD)) {
    const [word, charsetSpec, encoding, text] = match;
    const start = match.index ?? 0;
    const between = value.slice(cursor, start);
    cursor = start + word.length;
    // RFC 2231 lets a charset carry a language: `UTF-8*en`.
    const charset = charsetSpec.split("*")[0].toLowerCase();
    const bytes = encoding.toUpperCase() === "B" ? Buffer.from(text, "base64") : decodeQ(text);
    const previous = pieces[pieces.length - 1];
    if (typeof previous === "object" && /^[ \t\r\n]*$/.test(between)) {
      if (previous.charset === charset) {
        previous.bytes.push(bytes);
        previous.source += between + word;
        continue;
      }
    } else if (between) {
      pieces.push(between);
    }
    pieces.push({ charset, bytes: [bytes], source: word });
  }
  pieces.push(value.slice(cursor));
  return pieces
    .map((piece) =>
      typeof piece === "string"
        ? piece
        : (decodeCharset(piece.charset, Buffer.concat(piece.bytes)) ?? piece.source),
    )
    .join("");
}

/**
 * An unstructured header's text — `Subject` — with its RFC 2047 words
 * decoded. A value with nothing encoded in it is returned exactly as written.
 */
export function decodeHeaderText(value: string): string {
  if (!value.includes("=?")) return value;
  return (
    decodeMimeWords(value)
      // A decoded word can carry anything, a line break included; a header is one line.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
  );
}

/**
 * A display name as written in a header, read back as the one line of text a
 * mail client shows: quotes and escapes removed, RFC 2047 words decoded —
 * including the ones broken senders put inside quotes.
 */
export function decodeDisplayName(raw: string): string {
  return (
    decodeMimeWords(displayNameText(raw))
      // A decoded word can carry anything, a line break included; a name is one line.
      // eslint-disable-next-line no-control-regex
      .replace(/[\s\u0000-\u001f\u007f]+/g, " ")
      .trim()
  );
}

/**
 * An address-list header — `From`, `To`, `Cc` — with the RFC 2047 words in
 * its display names decoded, and still an address list.
 *
 * Decoding the whole value in place would not be one. A name sent as
 * `=?UTF-8?Q?Doe=2C_Zo=C3=AB?=` reads `Doe, Zoë`, and the comma its encoding
 * kept safe would split one recipient into two for every parser downstream; a
 * decoded `"` would open a quote that never closes. So each recipient whose
 * name holds an encoded word is read back by {@link decodeDisplayName} and
 * written again by {@link formatMailbox} in its decoded form, which quotes
 * whatever needs quoting. Every other recipient is kept exactly as written,
 * and so is a value with nothing encoded in it.
 */
export function decodeAddressList(value: string): string {
  if (!value.includes("=?")) return value;
  return splitAddressList(value)
    .map((entry) => {
      const named = /^(.*?)\s*<([^<>]*)>$/.exec(entry);
      if (!named || !named[1].includes("=?")) return entry;
      return formatMailbox(
        { name: decodeDisplayName(named[1]), address: named[2] },
        { decoded: true },
      );
    })
    .join(", ");
}

/**
 * A `Subject` with every layer of RFC 2047 encoding taken off, for telling
 * whether two copies of one header say the same thing.
 *
 * Not what the mirror stores: that is one decode ({@link decodeHeaderText}),
 * the text Gmail's API hands over. This is for comparing a copy that may still
 * be raw — an IMAP row mirrored before its adapter decoded — with one that has
 * been decoded since. Decoding until nothing changes gives both the same text,
 * even for the rare sender that encoded its subject twice.
 */
export function fullyDecodedHeaderText(value: string): string {
  return decodeUntilSettled(value, decodeHeaderText);
}

/**
 * An address list with every layer of RFC 2047 encoding taken off, for the
 * same comparisons — see {@link fullyDecodedHeaderText}.
 */
export function fullyDecodedAddressList(value: string): string {
  return decodeUntilSettled(value, decodeAddressList);
}

function decodeUntilSettled(value: string, decode: (value: string) => string): string {
  let current = value;
  // A text settles after one or two decodes; the bound is only a guard.
  for (let pass = 0; pass < 8; pass++) {
    const next = decode(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** RFC 2047's `Q` encoding: `_` is a space, `=XX` is one byte, the rest is itself. */
function decodeQ(text: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const hex = ch === "=" ? text.slice(i + 1, i + 3) : "";
    if (ch === "_") {
      bytes.push(0x20);
    } else if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodeCharset(charset: string, bytes: Buffer): string | null {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // An unknown label throws; the caller keeps the word as it was written.
    return null;
  }
}
