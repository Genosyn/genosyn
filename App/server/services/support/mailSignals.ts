import type { GmailHeader } from "../mail/gmailClient.js";
import { normalizeEmail, parseAddressList } from "../../lib/emailAddress.js";

/**
 * Reading an email the way a support desk has to: who it was really written to,
 * who should get the answer, whether a person wrote it at all, and which of its
 * words are new. No database and no network, so every rule here is a test away.
 *
 * Getting these wrong is expensive in one specific way. An auto-reply answered
 * by an AI Employee, answered by the other side's auto-reply, is a mail loop that
 * runs until a person notices, on the company's own sending domain — so a mail
 * that looks automated never earns a reply from here.
 */

function header(headers: readonly GmailHeader[], name: string): string {
  const lower = name.toLowerCase();
  return headers.find((entry) => entry.name.toLowerCase() === lower)?.value ?? "";
}

function allHeaders(headers: readonly GmailHeader[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((entry) => entry.name.toLowerCase() === lower).map((entry) => entry.value);
}

/** Lower case, `+tag` removed: the mailbox a plus-address delivers to. */
export function untaggedAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0) return lower;
  const local = lower.slice(0, at);
  const plus = local.indexOf("+");
  return plus > 0 ? `${local.slice(0, plus)}${lower.slice(at)}` : lower;
}

/** Headers that name where a message was delivered when `To` and `Cc` do not. */
const DELIVERY_HEADERS = [
  "Delivered-To",
  "X-Original-To",
  "X-Forwarded-To",
  "X-Forwarded-For",
  "Envelope-To",
  "X-Envelope-To",
  "X-Rcpt-To",
];

/**
 * Every address this message was written or delivered to, lower case. A Google
 * Group or a forwarding alias usually keeps the group in `To`; a Bcc or a rule
 * leaves it only in the delivery headers.
 */
export function deliveryAddresses(args: {
  to: string;
  cc: string;
  bcc: string;
  headers?: readonly GmailHeader[];
}): string[] {
  const found = new Set<string>();
  const add = (value: string) => {
    for (const address of parseAddressList(value).addresses) found.add(address.toLowerCase());
  };
  add(args.to);
  add(args.cc);
  add(args.bcc);
  for (const name of DELIVERY_HEADERS) {
    for (const value of allHeaders(args.headers ?? [], name)) add(value);
  }
  for (const value of allHeaders(args.headers ?? [], "List-Post")) {
    const mailto = /mailto:([^>\s,]+)/i.exec(value)?.[1];
    if (mailto) add(mailto);
  }
  return [...found];
}

/**
 * Which of the watched addresses this message reached, or null. Case and a
 * `+tag` on either side are ignored, so `support+acme@x.com` is `support@x.com`.
 */
export function matchWatchedAddress(
  watched: readonly string[],
  delivered: readonly string[],
): string | null {
  const reached = new Set(delivered.map(untaggedAddress));
  for (const address of watched) {
    if (reached.has(untaggedAddress(address))) return address;
  }
  return null;
}

/** Local parts of an address nobody reads. A reply there is a bounce waiting to happen. */
const NO_REPLY_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|mailer)([-_.+].*)?$/i;

export function isNoReplyAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  return at > 0 && NO_REPLY_LOCAL.test(address.slice(0, at));
}

const DAEMON_LOCAL =
  /^(mailer-daemon|mail-daemon|mailerdaemon|postmaster|mail\.delivery\.subsystem)$/i;

const AUTO_REPLY_SUBJECT =
  /^(out of (the )?office|automatic reply|auto(matic)?[- ]?(reply|response)|autoreply|auto:|away from|vacation|abwesenheit|automatische antwort|r[ée]ponse automatique|absence du bureau|respuesta autom[áa]tica|fuera de la oficina|resposta autom[áa]tica|risposta automatica|fuori ufficio|automatisch antwoord|afwezig)/i;

const BOUNCE_SUBJECT =
  /^(undeliverable|undelivered mail|mail delivery (failed|failure|subsystem)|delivery status notification|returned mail|failure notice|delivery failure)/i;

export type AutomatedKind = "bounce" | "auto_reply" | "bulk";

export type AutomatedVerdict = { kind: AutomatedKind; reason: string } | null;

/**
 * Whether software rather than a person wrote this, and which kind.
 *
 * `bounce` and `auto_reply` never open a ticket and never earn an answer. `bulk`
 * opens one in Spam, where a Member can rescue it, because the signals for it —
 * a list header, a no-reply sender — do occasionally sit on real mail.
 *
 * A Google Group is the case that makes this subtle. support@ is very often a
 * group that forwards to the mailbox, and a group stamps every customer's email
 * with `List-Id` and `Precedence: list`. So a list header naming the address the
 * mail was addressed to is that address doing its job, not a mailing list.
 */
export function classifyAutomatedMail(args: {
  fromEmail: string;
  subject: string;
  headers: readonly GmailHeader[];
  /** The addresses the company watches, so its own group is not read as a list. */
  ownAddresses?: readonly string[];
}): AutomatedVerdict {
  const { headers } = args;
  const fromAt = args.fromEmail.lastIndexOf("@");
  const fromLocal = fromAt > 0 ? args.fromEmail.slice(0, fromAt) : args.fromEmail;
  const contentType = header(headers, "Content-Type").toLowerCase();
  if (
    DAEMON_LOCAL.test(fromLocal) ||
    /multipart\/report/.test(contentType) ||
    /report-type\s*=\s*"?delivery-status/.test(contentType) ||
    BOUNCE_SUBJECT.test(args.subject.trim())
  ) {
    return { kind: "bounce", reason: "A delivery report from a mail server." };
  }

  const autoSubmitted = header(headers, "Auto-Submitted").trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") {
    return { kind: "auto_reply", reason: "Marked as automatically sent (Auto-Submitted)." };
  }
  if (
    header(headers, "X-Autoreply") ||
    header(headers, "X-Autorespond") ||
    header(headers, "X-Auto-Reply") ||
    /(^|,\s*)(all|oof)(\s*,|$)/i.test(header(headers, "X-Auto-Response-Suppress"))
  ) {
    return { kind: "auto_reply", reason: "Marked as an automatic response." };
  }
  if (AUTO_REPLY_SUBJECT.test(args.subject.replace(/^(re|fwd?):\s*/i, "").trim())) {
    return { kind: "auto_reply", reason: "Its subject says it is an automatic reply." };
  }

  const precedence = header(headers, "Precedence").trim().toLowerCase();
  if (precedence === "auto_reply") {
    return { kind: "auto_reply", reason: "Marked as an automatic response (Precedence)." };
  }
  const listId = header(headers, "List-Id");
  const listPost = header(headers, "List-Post");
  const listed =
    Boolean(listId) ||
    Boolean(header(headers, "List-Unsubscribe")) ||
    precedence === "bulk" ||
    precedence === "list" ||
    precedence === "junk";
  if (listed && !listNamesOwnAddress(listId, listPost, args.ownAddresses ?? [])) {
    return { kind: "bulk", reason: "Looks like bulk mail: it carries mailing-list headers." };
  }
  if (isNoReplyAddress(args.fromEmail) && !header(headers, "Reply-To")) {
    return { kind: "bulk", reason: "Sent from a no-reply address." };
  }
  return null;
}

/**
 * `List-Id: <support.acme.com>` or `List-Post: <mailto:support@acme.com>` when
 * the company holds an address at acme.com: its own group forwarding a customer.
 * A newsletter's list lives on the sender's domain, never on the company's.
 */
function listNamesOwnAddress(
  listId: string,
  listPost: string,
  ownAddresses: readonly string[],
): boolean {
  const idHost = /<([^>]+)>/.exec(listId)?.[1]?.trim().toLowerCase() ?? listId.trim().toLowerCase();
  const postAddress = /mailto:([^>\s,?]+)/i.exec(listPost)?.[1]?.toLowerCase() ?? "";
  for (const address of ownAddresses) {
    const domain = domainOf(address);
    if (!domain) continue;
    if (idHost === domain || idHost.endsWith(`.${domain}`)) return true;
    if (postAddress && domainOf(postAddress) === domain) return true;
  }
  return false;
}

export type Requester = { email: string; name: string };

/**
 * Who should get the answer.
 *
 * Usually the sender. `Reply-To` wins when it holds one good address, which is
 * what a web form relaying a customer sends. A group that rewrote `From` to
 * itself to satisfy DMARC ("Ada via Support <support@acme.com>") keeps the
 * customer in `Reply-To`, `X-Original-From` or `X-Original-Sender`, so a sender
 * that is one of the company's own addresses is read past. Null means the
 * company wrote this to itself and nobody outside is waiting.
 */
export function resolveRequester(args: {
  fromName: string;
  fromEmail: string;
  headers: readonly GmailHeader[];
  ownAddresses: readonly string[];
}): Requester | null {
  const own = new Set(args.ownAddresses.map(untaggedAddress));
  const isOwn = (address: string) => own.has(untaggedAddress(address));
  const single = (value: string): string | null => {
    const parsed = parseAddressList(value).addresses;
    return parsed.length === 1 ? parsed[0].toLowerCase() : null;
  };
  const nameIn = (value: string): string => {
    const open = value.lastIndexOf("<");
    if (open <= 0) return "";
    // Headers arrive unchecked, and Postgres refuses a NUL byte in text.
    return value
      .slice(0, open)
      .replaceAll("\u0000", "")
      .replace(/^["'\s]+|["'\s]+$/g, "");
  };
  const replyToRaw = header(args.headers, "Reply-To");
  const replyTo = single(replyToRaw);
  const fromEmail = normalizeEmail(args.fromEmail) ?? args.fromEmail.trim().toLowerCase();
  if (fromEmail && !isOwn(fromEmail)) {
    if (replyTo && !isOwn(replyTo)) {
      return { email: replyTo, name: args.fromName || nameIn(replyToRaw) };
    }
    return { email: fromEmail, name: args.fromName };
  }
  // Mail from our own address: only the company's group relaying a customer
  // leaves someone outside to answer.
  for (const name of ["Reply-To", "X-Original-From", "X-Original-Sender"]) {
    const raw = header(args.headers, name);
    const address = single(raw);
    if (address && !isOwn(address)) {
      const shown = nameIn(raw) || args.fromName.replace(/\s+via\s+.*$/i, "").trim();
      return { email: address, name: shown };
    }
  }
  return null;
}

/** The bare domain of an address, lower case. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0
    ? address
        .slice(at + 1)
        .trim()
        .toLowerCase()
    : "";
}

/**
 * The lines that begin the quoted history a mail client adds under a reply. One
 * pattern per client and language; a line must match as a whole, so an ordinary
 * sentence that happens to contain "wrote:" is left alone.
 */
const REPLY_HEADER_PATTERNS: RegExp[] = [
  /^on\b.{0,200}\bwrote:\s*$/i,
  /^le\b.{0,200}\ba [ée]crit\s*:\s*$/i,
  /^am\b.{0,200}\bschrieb\b.{0,200}:\s*$/i,
  /^el\b.{0,200}\bescribi[óo]\s*:\s*$/i,
  /^il\b.{0,200}\bha scritto\s*:\s*$/i,
  /^em\b.{0,200}\bescreveu\s*:\s*$/i,
  /^op\b.{0,200}\bschreef\b.{0,200}:\s*$/i,
  /^den\b.{0,200}\bskrev\b.{0,200}:\s*$/i,
  /^[-_]{2,}\s*original message\s*[-_]{2,}\s*$/i,
  /^[-_]{2,}\s*(urspr[üu]ngliche nachricht|message d'origine|mensaje original|messaggio originale|mensagem original)\s*[-_]{2,}\s*$/i,
  /^_{10,}\s*$/,
  /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}.{0,120}<[^>]+@[^>]+>.{0,20}:\s*$/,
  /^在.{0,120}写道[:：]\s*$/,
  /^.{0,120}さんは書きました[:：]\s*$/,
];

/** The start of a forward or Outlook's reply block: `From:` then `Sent:` or `Date:` just after. */
function isHeaderBlockStart(lines: readonly string[], index: number): boolean {
  if (!/^\*?(from|von|de|da)\s*:\s*\*?\s*\S/i.test(lines[index])) return false;
  for (let next = index + 1; next <= index + 3 && next < lines.length; next++) {
    if (/^\*?(sent|date|gesendet|datum|envoy[ée]|enviado|inviato|to|an)\s*:/i.test(lines[next])) {
      return true;
    }
  }
  return false;
}

const SIGNATURE_LINES = [
  /^--\s*$/,
  /^sent from (my )?\S.{0,60}$/i,
  /^get outlook for .{0,40}$/i,
  /^von meinem .{0,60} gesendet$/i,
  /^envoy[ée] de mon .{0,60}$/i,
  /^enviado desde mi .{0,60}$/i,
];

/**
 * The new words of an email: quoted history and the sign-off cut.
 *
 * Deliberately conservative. Only history at the end goes: a `>` line inside the
 * message is an answer written between the lines of what it quotes, and keeping
 * it is right. A forward's own header block stays when it is the whole message,
 * since then it is what the customer sent. Text that would come out empty is
 * returned untouched, because a blank ticket is worse than a long one.
 */
export function cleanEmailText(raw: string): string {
  const text = raw.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  let end = lines.length;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const joined = index + 1 < lines.length ? `${line} ${lines[index + 1].trim()}` : line;
    if (
      REPLY_HEADER_PATTERNS.some((pattern) => pattern.test(line) || pattern.test(joined)) ||
      isHeaderBlockStart(lines, index)
    ) {
      end = index;
      break;
    }
    if (SIGNATURE_LINES.some((pattern) => pattern.test(lines[index].trimEnd()))) {
      end = index;
      break;
    }
  }
  let kept = lines.slice(0, end);
  // Trailing quoted lines and the blank lines around them.
  while (kept.length > 0) {
    const last = kept[kept.length - 1].trim();
    if (last === "" || last.startsWith(">")) kept = kept.slice(0, -1);
    else break;
  }
  const cleaned = kept.join("\n").trim();
  return cleaned || text.trim();
}

/** A subject without its `Re:` and `Fwd:` prefixes. */
export function bareSubject(subject: string): string {
  let value = subject.trim();
  for (;;) {
    const next = value.replace(/^(re|fw|fwd|aw|wg|sv|vs|tr|rv)\s*:\s*/i, "");
    if (next === value) return value;
    value = next;
  }
}

/** Plain text as simple HTML: paragraphs, line breaks and links, everything escaped. */
export function plainTextToHtml(text: string): string {
  const escape = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .trim()
    .split(/\n{2,}/);
  const body = paragraphs
    .map((paragraph) => {
      const html = escape(paragraph)
        .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (url) => {
          // Already escaped, so it is safe to place in the attribute as it is.
          return `<a href="${url}">${url}</a>`;
        })
        .replace(/\n/g, "<br>");
      return `<p style="margin:0 0 12px 0">${html}</p>`;
    })
    .join("");
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1e293b">${body}</div>`;
}
