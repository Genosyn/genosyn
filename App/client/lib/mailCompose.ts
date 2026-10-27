import {
  emptyMailRecipients,
  headerEntry,
  mailRecipientsFrom,
  type MailRecipients,
} from "./mailRecipients";
import { recipientKey } from "./recipientTokens";

/**
 * What a reply or a forward starts from, worked out in the browser from the
 * message being answered — so the composer opens instantly, with the names
 * people go by rather than bare addresses.
 *
 * Reply goes to whoever sent the message; Reply all adds everyone else it was
 * addressed or copied to; the mailbox itself is never on its own reply. When
 * the message being answered is one the mailbox sent, a reply goes back to
 * the people it was sent to. That is the rule the server's own
 * `replyAllRecipients` follows, so the two never disagree about a thread.
 */

export type ComposeSource = {
  id: string;
  fromName: string;
  fromEmail: string;
  toEmails: string;
  ccEmails: string;
  subject: string;
  sentAt: string | null;
  bodyText: string;
  snippet: string;
};

/** The longest quote a reply carries; the compose endpoint takes 200,000 characters in all. */
export const MAX_QUOTE_CHARS = 60_000;

export function replyRecipientsFor(
  message: ComposeSource,
  selfAddress: string,
  all: boolean,
): MailRecipients {
  const self = recipientKey(selfAddress);
  const sender = headerEntry({ email: message.fromEmail, name: message.fromName, valid: true });
  const fromSelf = recipientKey(message.fromEmail) === self;
  if (fromSelf) {
    // Answering our own message: it goes back to whoever we sent it to.
    const fields = mailRecipientsFrom({ to: message.toEmails, cc: all ? message.ccEmails : "" }, [
      selfAddress,
    ]);
    return promoteOne(fields);
  }
  const fields = mailRecipientsFrom(
    {
      to: sender,
      cc: all ? [message.toEmails, message.ccEmails].filter(Boolean).join(", ") : "",
    },
    [selfAddress],
  );
  return promoteOne(fields);
}

/** Never a reply with nobody on To while people sit on Cc. */
function promoteOne(fields: MailRecipients): MailRecipients {
  if (fields.to.length > 0 || fields.cc.length === 0) return fields;
  const [first, ...rest] = fields.cc;
  return { ...emptyMailRecipients(), to: [first], cc: rest, bcc: fields.bcc };
}

/** `Re: Pricing` — once, however many replies deep. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Re: (no subject)";
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** `Fwd: Pricing` — once. */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return "Fwd: (no subject)";
  return /^(fwd?|fw)\s*:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}

function sentLine(message: ComposeSource, locale?: string): string {
  if (!message.sentAt) return "";
  const at = new Date(message.sentAt);
  if (Number.isNaN(at.getTime())) return "";
  return at.toLocaleString(locale, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The earlier message under a reply, the way mail clients quote it:
 * "On Tue, Oct 27, 2026, 3:04 PM Felix Menzel <felix@acme.test> wrote:" and
 * every line behind `> `. The people who read the reply outside Genosyn see
 * what it answers.
 */
export function quotedReply(message: ComposeSource, locale?: string): string {
  const who = headerEntry({ email: message.fromEmail, name: message.fromName, valid: true });
  const when = sentLine(message, locale);
  const text = (message.bodyText || message.snippet).replace(/\r\n?/g, "\n").trimEnd();
  const bounded = text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}\n[…]` : text;
  const quoted = bounded
    .split("\n")
    .map((line) => (line.startsWith(">") ? `>${line}` : `> ${line}`).trimEnd())
    .join("\n");
  return `${when ? `On ${when} ${who}` : who} wrote:\n${quoted}`;
}

/** The block a forward carries below the Member's own words. */
export function forwardBlock(message: ComposeSource, locale?: string): string {
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${headerEntry({ email: message.fromEmail, name: message.fromName, valid: true })}`,
  ];
  const when = sentLine(message, locale);
  if (when) lines.push(`Date: ${when}`);
  lines.push(`Subject: ${message.subject}`);
  if (message.toEmails) lines.push(`To: ${message.toEmails}`);
  if (message.ccEmails) lines.push(`Cc: ${message.ccEmails}`);
  const text = (message.bodyText || message.snippet).replace(/\r\n?/g, "\n").trimEnd();
  lines.push("", text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)}\n[…]` : text);
  return lines.join("\n");
}

/** A reply's full text: the Member's words, then the quote when it is kept. */
export function replyBody(body: string, quote: string | null): string {
  const own = body.replace(/\s+$/, "");
  if (!quote) return own;
  return own ? `${own}\n\n${quote}` : quote;
}

const ATTRIBUTION =
  /^(on\b.{0,300}\bwrote:|am\b.{0,300}\bschrieb\b.{0,200}:|le\b.{0,300}\ba écrit\s?:|el\b.{0,300}\bescribió:)\s*$/i;

/**
 * Where the quoted history at the bottom of a plain-text email starts, so the
 * thread can fold it away the way mail clients do — or -1 when there is none.
 *
 * Only a trailing quote counts: an attribution line ("On … wrote:") followed
 * by quoted lines to the end, a run of `>` lines that ends the message, or an
 * Outlook "-----Original Message-----" block. A forwarded message is never
 * folded; it is the point of the email it is in.
 */
export function quotedTailStart(text: string): number {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  if (end === 0) return -1;

  // Outlook's separator: everything after it is the earlier message.
  for (let index = 0; index < end; index += 1) {
    if (/^\s*-{2,}\s*original message\s*-{2,}\s*$/i.test(lines[index]) && index > 0) {
      return offsetOf(lines, index);
    }
  }

  // A trailing run of quoted lines (blank lines inside it allowed).
  let start = end;
  while (start > 0 && (lines[start - 1].startsWith(">") || lines[start - 1].trim() === "")) {
    start -= 1;
  }
  const quotedLines = lines.slice(start, end).filter((line) => line.startsWith(">")).length;
  if (quotedLines === 0) return -1;
  // Fold the attribution above it in with the quote — it may wrap onto two lines.
  let head = start;
  for (let back = 1; back <= 2 && start - back >= 0; back += 1) {
    const candidate = lines
      .slice(start - back, start)
      .join(" ")
      .trim();
    if (ATTRIBUTION.test(candidate)) {
      head = start - back;
      break;
    }
  }
  // A message that is nothing but a quote is shown whole.
  const own = lines.slice(0, head).some((line) => line.trim() !== "");
  if (!own) return -1;
  return offsetOf(lines, head);
}

function offsetOf(lines: string[], index: number): number {
  let offset = 0;
  for (let line = 0; line < index; line += 1) offset += lines[line].length + 1;
  return offset;
}

/** Where an unsent reply is kept between visits, per company and thread. */
export function replyDraftKey(companyId: string, threadId: string): string {
  return `genosyn.mail.reply.${companyId}.${threadId}`;
}

/** How long an unsent reply is offered back before it is forgotten. */
export const REPLY_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
