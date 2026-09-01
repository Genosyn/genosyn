import crypto from "node:crypto";

import type { GmailHeader, ParsedAttachment } from "./gmailClient.js";
import { CANONICAL_LABELS, type MailboxLabel, type MailboxMessage } from "./mailbox/types.js";

/**
 * The pure half of the IMAP mailbox backend: identifiers, folder/flag
 * mapping, and turning RFC 822 bytes into the row shape the mirror stores.
 *
 * Everything here is a function of its arguments, with no socket in sight, so
 * the decisions that actually matter — what counts as one conversation, what a
 * `\Junk` folder means, what happens when a message has no `Message-ID` — are
 * unit-testable against fixtures instead of against somebody's mail server.
 * The connection handling lives next door in `imapClient.ts`.
 *
 * ## Why identifiers are the hard part
 *
 * Gmail hands out a message id that never changes. IMAP does not: a message is
 * addressed by `(folder, UIDVALIDITY, UID)`, and **moving it to another folder
 * gives it a new UID**. Since archiving, trashing and filing all move messages,
 * a mirror keyed on UID would lose track of a message the first time anyone
 * touched it.
 *
 * So the mirror keys on the message's own `Message-ID` header, hashed
 * ({@link messageRefFor}), and separately records where the message currently
 * lives ({@link encodeLocation}, stored in `MailMessage.providerLocation`) so
 * the next fetch knows which folder and UID to ask for. A message with no
 * `Message-ID` at all — rare, but real, mostly from broken senders and some
 * drafts — falls back to a location-derived ref and simply re-imports if it
 * moves, which is the same thing every other IMAP client does.
 *
 * ## Conversations without a server that has them
 *
 * IMAP has no thread ids. The `References` header does: its first entry is the
 * root of the conversation, and every well-behaved mail client maintains it.
 * {@link threadRefFor} hashes that root, falling back to `In-Reply-To` and then
 * to the message's own id. It is stateless — the same message always lands in
 * the same conversation, no matter what order the mailbox is imported in —
 * which is what makes a resumable, restartable backfill possible at all.
 */

// ───────────────────────────── identifiers ─────────────────────────────

/** Short, stable, collision-resistant digest for a header value. */
function digest(value: string): string {
  return crypto.createHash("sha256").update(value).digest("base64url").slice(0, 22);
}

/**
 * base64url, used wherever a folder path has to survive inside an identifier.
 *
 * Folder names legitimately contain spaces ("Sent Items"), and label ids are
 * stored space-delimited in `MailMessage.labelIds` so `LIKE '% X %'` can answer
 * membership. A raw path would break that query for every mailbox on the
 * planet that ships a two-word folder.
 */
export function encodePath(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

export function decodePath(encoded: string): string {
  return Buffer.from(encoded, "base64url").toString("utf8");
}

/** Strip the angle brackets and whitespace around a `Message-ID`. */
export function normalizeMessageId(raw: string): string {
  const trimmed = raw.trim();
  const angled = /<([^>]*)>/.exec(trimmed);
  return (angled ? angled[1] : trimmed).trim();
}

/** Every id in a `References` / `In-Reply-To` header, oldest first. */
export function parseReferences(raw: string): string[] {
  const out: string[] = [];
  for (const match of raw.matchAll(/<([^>]+)>/g)) {
    const id = match[1].trim();
    if (id) out.push(id);
  }
  if (out.length === 0) {
    const bare = raw.trim();
    if (bare && !/\s/.test(bare)) out.push(bare);
  }
  return out;
}

/** Where a message currently lives, for the next fetch. */
export type ImapLocation = {
  folder: string;
  uidValidity: string;
  uid: number;
};

export function encodeLocation(loc: ImapLocation): string {
  return `${encodePath(loc.folder)}:${loc.uidValidity}:${loc.uid}`;
}

/** Parse a stored location, or null when the column is empty or malformed. */
export function decodeLocation(raw: string): ImapLocation | null {
  if (!raw) return null;
  const parts = raw.split(":");
  if (parts.length !== 3) return null;
  const uid = Number(parts[2]);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  if (!/^\d+$/.test(parts[1])) return null;
  let folder: string;
  try {
    folder = decodePath(parts[0]);
  } catch {
    return null;
  }
  if (!folder) return null;
  return { folder, uidValidity: parts[1], uid };
}

/**
 * The mirror's id for a message.
 *
 * Derived from `Message-ID` so it survives the message being moved between
 * folders. Without a `Message-ID` we fall back to the location, which is
 * stable right up until somebody moves the message — an honest trade, since
 * there is nothing else about such a message that is stable either.
 *
 * **The trade-off, stated plainly.** `Message-ID` is written by the sender, so
 * two messages can carry the same one, and when they do the mirror stores them
 * as one row — the later import overwrites the earlier. That is the same
 * property every mail client that threads on `Message-ID` has, and it is the
 * price of the thing above it: keying on `(folder, UID)` instead would lose a
 * message the first time anybody archived it, which is a certainty rather than
 * a possibility. Nothing upstream is touched either way — the mailbox still
 * holds both messages, and a re-import restores whichever the walk sees last.
 * Distinguishing a genuine duplicate from a moved message (by comparing the
 * envelope of the row already stored) is worth doing and is not done here; see
 * ROADMAP M60 for why it was left out of the first cut.
 */
export function messageRefFor(args: { messageId: string; location: ImapLocation }): string {
  const id = normalizeMessageId(args.messageId);
  if (id) return `m:${digest(id)}`;
  return `u:${encodeLocation(args.location)}`;
}

/**
 * The mirror's id for the conversation a message belongs to.
 *
 * The root of the `References` chain, hashed. Two messages agree on it without
 * either one having to look the other up, which is what keeps the import
 * resumable.
 */
export function threadRefFor(args: {
  messageId: string;
  references: string;
  inReplyTo: string;
  /**
   * What to key on when the message carries no threading headers at all.
   *
   * Without it every such message hashes the same empty string and they all
   * collapse into one enormous conversation — which is exactly what a mailbox
   * full of machine-generated mail from senders that write no `Message-ID`
   * would produce. The caller passes the message's own ref, which is unique.
   */
  fallback?: string;
}): string {
  const chain = parseReferences(args.references);
  const root = chain[0] || parseReferences(args.inReplyTo)[0] || normalizeMessageId(args.messageId);
  if (root) return `t:${digest(root)}`;
  return `t:${digest(args.fallback || `${args.messageId}|${args.references}|${args.inReplyTo}`)}`;
}

// ───────────────────────────── folders and flags ─────────────────────────────

/** One folder as the LIST command described it. */
export type ImapFolder = {
  path: string;
  name: string;
  /** `\Sent`, `\Drafts`, `\Trash`, `\Junk`, `\Archive`, `\All`, `\Inbox`, … */
  specialUse?: string;
  subscribed?: boolean;
};

/** A folder we never mirror, whatever it is called. */
const SKIPPED_SPECIAL_USE = new Set(["\\Noselect", "\\NonExistent"]);

/**
 * The canonical label a folder maps to, or null when it maps to none.
 *
 * `\Archive` and `\All` deliberately map to nothing. On Gmail, archived mail
 * is exactly "mail with no INBOX label" — there is no ARCHIVE label to hold —
 * so an IMAP Archive folder giving its messages no folder label at all
 * reproduces that, and the Archive button on both providers ends up meaning
 * the same thing to everything downstream.
 */
export function canonicalLabelForFolder(folder: ImapFolder): string | null {
  const special = folder.specialUse ?? "";
  if (folder.path.toUpperCase() === "INBOX" || special === "\\Inbox") return CANONICAL_LABELS.inbox;
  switch (special) {
    case "\\Sent":
      return CANONICAL_LABELS.sent;
    case "\\Drafts":
      return CANONICAL_LABELS.draft;
    case "\\Trash":
      return CANONICAL_LABELS.trash;
    case "\\Junk":
      return CANONICAL_LABELS.spam;
    case "\\Archive":
    case "\\All":
      return null;
    default:
      return null;
  }
}

/** The label id a folder contributes to its messages. */
export function labelRefForFolder(folder: ImapFolder): string | null {
  if (SKIPPED_SPECIAL_USE.has(folder.specialUse ?? "")) return null;
  const canonical = canonicalLabelForFolder(folder);
  if (canonical) return canonical;
  if (folder.specialUse === "\\Archive" || folder.specialUse === "\\All") return null;
  return `f:${encodePath(folder.path)}`;
}

/**
 * The full label catalog for a mailbox: the canonical system labels every
 * mailbox has, plus one user label per ordinary folder.
 *
 * The flag-derived labels (`UNREAD`, `STARRED`) are listed even though no
 * folder produces them, because the sidebar counts and the `is:unread` search
 * term resolve against this catalog.
 */
export function labelCatalog(folders: ImapFolder[]): MailboxLabel[] {
  const out: MailboxLabel[] = [];
  const seen = new Set<string>();
  const push = (label: MailboxLabel) => {
    if (seen.has(label.ref)) return;
    seen.add(label.ref);
    out.push(label);
  };
  push({ ref: CANONICAL_LABELS.inbox, name: "Inbox", labelType: "system", color: "" });
  push({ ref: CANONICAL_LABELS.unread, name: "Unread", labelType: "system", color: "" });
  push({ ref: CANONICAL_LABELS.starred, name: "Starred", labelType: "system", color: "" });
  push({ ref: CANONICAL_LABELS.sent, name: "Sent", labelType: "system", color: "" });
  push({ ref: CANONICAL_LABELS.draft, name: "Drafts", labelType: "system", color: "" });
  push({ ref: CANONICAL_LABELS.trash, name: "Trash", labelType: "system", color: "" });
  push({ ref: CANONICAL_LABELS.spam, name: "Spam", labelType: "system", color: "" });
  for (const folder of folders) {
    const ref = labelRefForFolder(folder);
    if (!ref || !ref.startsWith("f:")) continue;
    push({ ref, name: folder.path, labelType: "user", color: "" });
  }
  return out;
}

/**
 * Every label a message carries, from where it lives and how it is flagged.
 *
 * The IMAP flags that matter are the absence of `\Seen` (unread), `\Flagged`
 * (starred) and `\Draft`. Everything else about a message's state is its
 * folder.
 */
export function labelsForMessage(args: {
  folder: ImapFolder;
  flags: Iterable<string>;
}): string[] {
  const labels = new Set<string>();
  const folderLabel = labelRefForFolder(args.folder);
  if (folderLabel) labels.add(folderLabel);
  const flags = new Set(Array.from(args.flags, (f) => f.toLowerCase()));
  if (!flags.has("\\seen")) labels.add(CANONICAL_LABELS.unread);
  if (flags.has("\\flagged")) labels.add(CANONICAL_LABELS.starred);
  if (flags.has("\\draft")) labels.add(CANONICAL_LABELS.draft);
  return Array.from(labels);
}

// ───────────────────────────── parsing ─────────────────────────────

/** The subset of mailparser's output this module consumes. */
export type ParsedSource = {
  headerLines: Array<{ key: string; line: string }>;
  text?: string;
  html?: string | false;
  date?: Date;
  attachments: Array<{
    filename?: string;
    contentType?: string;
    size?: number;
    partId?: string;
    related?: boolean;
  }>;
};

/**
 * Turn one raw header line back into a `{ name, value }` pair.
 *
 * mailparser hands back the raw lines rather than a parsed map, which is what
 * we want: `headerValue()` downstream expects Gmail's raw header shape, and
 * re-deriving values from mailparser's decoded objects would quietly rewrite
 * addresses the mirror is supposed to store verbatim. Continuation lines are
 * unfolded because a folded `References` chain that keeps its newlines would
 * break both threading and the reply builder.
 */
export function headersFromLines(
  lines: Array<{ key: string; line: string }>,
): GmailHeader[] {
  const out: GmailHeader[] = [];
  for (const entry of lines) {
    const line = entry.line.replace(/\r?\n[ \t]+/g, " ");
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    out.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  return out;
}

/** First 220 characters of the body, whitespace collapsed. */
export function snippetFrom(text: string, html: string): string {
  const source = text || stripTags(html);
  const flat = source.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

function stripTags(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/**
 * Attachment metadata in the shape the mirror already stores.
 *
 * `attachmentId` holds the MIME part id rather than a server-side handle,
 * because IMAP has no equivalent of Gmail's attachment ids — the bytes are
 * fetched by asking for that part of the message. Falling back to the index
 * keeps a parser that reports no `partId` from producing two attachments that
 * cannot be told apart.
 */
export function attachmentsFrom(parsed: ParsedSource): ParsedAttachment[] {
  return parsed.attachments
    .filter((a) => !a.related || a.filename)
    .map((a, index) => ({
      partId: a.partId ?? String(index + 1),
      attachmentId: a.partId ?? String(index + 1),
      filename: a.filename ?? `attachment-${index + 1}`,
      mimeType: a.contentType ?? "application/octet-stream",
      size: a.size ?? 0,
    }));
}

/** The value of one header, case-insensitively, or "". */
export function headerOf(headers: GmailHeader[], name: string): string {
  const lower = name.toLowerCase();
  for (const h of headers) if (h.name.toLowerCase() === lower) return h.value;
  return "";
}

/**
 * Build the mirror row for one fetched IMAP message.
 *
 * `hasBodies` is false when only the headers were fetched, so the caller can
 * mirror a message's flags and envelope during a slow backfill without
 * blanking a body it already imported.
 */
export function mailboxMessageFrom(args: {
  parsed: ParsedSource;
  folder: ImapFolder;
  flags: Iterable<string>;
  location: ImapLocation;
  internalDate?: Date | null;
  size?: number;
  hasBodies: boolean;
}): MailboxMessage {
  const headers = headersFromLines(args.parsed.headerLines);
  const messageId = headerOf(headers, "Message-ID");
  const bodyText = args.parsed.text ?? "";
  const bodyHtml = typeof args.parsed.html === "string" ? args.parsed.html : "";
  const ref = messageRefFor({ messageId, location: args.location });
  return {
    ref,
    threadRef: threadRefFor({
      messageId,
      references: headerOf(headers, "References"),
      inReplyTo: headerOf(headers, "In-Reply-To"),
      fallback: ref,
    }),
    labelIds: labelsForMessage({ folder: args.folder, flags: args.flags }),
    headers,
    snippet: snippetFrom(bodyText, bodyHtml),
    bodyText,
    bodyHtml,
    attachments: args.hasBodies ? attachmentsFrom(args.parsed) : [],
    sentAt: args.parsed.date ?? args.internalDate ?? null,
    sizeEstimate: args.size ?? 0,
    hasBodies: args.hasBodies,
    location: encodeLocation(args.location),
  };
}
