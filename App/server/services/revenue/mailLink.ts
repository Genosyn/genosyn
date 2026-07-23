import { MoreThanOrEqual } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { normalizeEmail, parseAddressList } from "../../lib/emailAddress.js";
import { columnHasLabel } from "../mail/store.js";
import { addSuppression } from "../mail/suppression.js";
import { recordMailActivities, type ActivityInput } from "./activities.js";
import { findContactsByEmails, markContactBounced } from "./contacts.js";
import { stopEnrollmentsForThread } from "./sequences.js";

/**
 * Mail → Contact auto-linking: the reason the timeline fills itself.
 *
 * Mail sync hands this module the messages it just mirrored; this module turns
 * the ones involving a known Contact into `email_in` / `email_out` activities,
 * stops a Sequence the moment somebody replies, and reads bounce reports. All
 * of it is a *side effect of sync*, which drives three rules that are easy to
 * state and expensive to get wrong:
 *
 * 1. **We link to contacts that already exist. We never create one.** The
 *    tempting version of this feature upserts a Contact for every address that
 *    appears in the mailbox, and it is a trap: a real inbox is mostly
 *    newsletters, vendors, receipts, calendar noise and one-off strangers.
 *    Auto-creation turns a curated list of the people you sell to into
 *    thousands of junk rows, and the list stops being worth opening — at which
 *    point every downstream number (contact counts, stale-contact nudges,
 *    sequence targeting) is noise too. Deleting junk afterwards is manual work
 *    nobody does. So creating a Contact stays an explicit act: a human adding
 *    one, an import, or a signal firing. Never a sync side effect.
 *
 * 2. **Idempotency is keyed on the message, not on the pair.** Re-syncing must
 *    not double every conversation, and {@link recordMailActivities} skips any
 *    `mailMessageId` already on the timeline. The consequence, accepted
 *    deliberately: a Contact created *after* a message was linked does not
 *    retroactively pick that message up on a later sync, because the message is
 *    no longer new. Backfilling history onto a freshly-created Contact is a
 *    separate explicit action, not something sync should re-scan the whole
 *    mailbox for on every pass.
 *
 * 3. **Never break the mailbox.** Everything here is best-effort enrichment.
 *    The wiring in `services/mail/sync.ts` swallows failures for exactly that
 *    reason: a CRM bug must not stop mail arriving.
 *
 * Direction is decided from the From address rather than the Gmail `SENT`
 * label, because the label is per-account state we would then have to keep in
 * step, while the header is a fact about the message. The known cost is
 * send-as aliases: a message the user sent from an alias reads as inbound, so
 * its counterparty resolves to the alias rather than to the recipients and it
 * usually links to nothing. That fails quiet and empty rather than writing a
 * wrong row onto somebody's timeline, which is the direction we want to fail.
 */

/**
 * Messages handled per round-trip. Keeps the `IN (...)` lists that
 * {@link findContactsByEmails} and {@link recordMailActivities} build well
 * under any driver's bound-parameter ceiling — an initial import hands us a
 * whole backfill page at once, and a mailbox import that dies on a SQLite
 * parameter limit is the least explicable failure mode there is.
 */
const LINK_CHUNK_SIZE = 200;

/**
 * Local parts that mean "this is a delivery report, not a person".
 *
 * Deliberately short. Every entry here is a name reserved by RFC 5321/2142 for
 * exactly this purpose, so a false positive is close to impossible. Vendor
 * envelope senders (`bounces@`, `bounce-3f2a@`) are omitted on purpose: they
 * are also used for ordinary bulk mail, and treating one as a bounce report
 * would let a newsletter suppress addresses.
 */
const DAEMON_LOCAL_PARTS = new Set([
  "mail-daemon",
  "mailer-daemon",
  "mailerdaemon",
  "postmaster",
]);

/** `Final-Recipient: rfc822; someone@example.com` — the RFC 3464 field. */
const FINAL_RECIPIENT_RE = /^[ \t]*final-recipient[ \t]*:[^;\n]*;[ \t]*(.+)$/gim;

/** A permanent-failure SMTP reply (`550`) or enhanced status (`5.1.1`). */
const HARD_FAILURE_RE = /(?:^|[\s(])(?:5\d{2}(?![\d.])|5\.\d{1,3}\.\d{1,3})(?:$|[\s):,;-])/;

/** Loose address scanner for free-form report text; every hit is then validated. */
const LOOSE_ADDRESS_RE = /[^\s<>(),;:"'[\]]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

export type MailDirection = "inbound" | "outbound";

export type MailLinkResult = {
  /** Messages that matched at least one known Contact. */
  linked: number;
  /** Activity rows actually written (a re-sync writes none). */
  activities: number;
};

export type MailSyncLinkResult = MailLinkResult & {
  sequencesStopped: number;
  bouncesRecorded: number;
};

/** The slice of a MailAccount this module needs, so callers need not pass the row. */
export type LinkableAccount = {
  id: string;
  companyId: string;
  address: string;
};

// ───────────────────────────── message shape ─────────────────────────────

/**
 * Drafts are excluded everywhere.
 *
 * A draft has not happened, and putting one on a timeline as `email_out` tells
 * the reader we contacted somebody we did not. Gmail also mutates a draft on
 * every keystroke-sync, so it is not a stable fact to record.
 */
function isDraft(message: MailMessage): boolean {
  return columnHasLabel(message.labelIds, "DRAFT") || !!message.gmailDraftId;
}

/**
 * Outbound when the mailbox owner sent it, inbound otherwise.
 *
 * An unreadable mailbox address makes everything inbound: without knowing who
 * "we" are we cannot claim authorship, and mislabelling our own mail as theirs
 * is the cheaper mistake.
 */
export function messageDirection(
  message: Pick<MailMessage, "fromEmail">,
  mailboxAddress: string | null,
): MailDirection {
  const mailbox = normalizeEmail(mailboxAddress);
  if (!mailbox) return "inbound";
  const from = normalizeEmail(message.fromEmail);
  if (from === mailbox) return "outbound";
  return "inbound";
}

/**
 * Who the mailbox owner was talking to.
 *
 * Outbound: the To and Cc recipients. **Bcc is deliberately excluded** — the
 * header only survives on the sender's own copy, so including it would make a
 * contact's timeline depend on which mailbox synced the thread, and a blind
 * copy is by construction not part of the visible conversation.
 *
 * Inbound: the sender. The other recipients of a message *to* us are other
 * people's business, not evidence that we corresponded with them.
 *
 * The mailbox's own address is always removed. A note-to-self would otherwise
 * link to the owner's own Contact row, if one exists, and read as outreach.
 */
export function counterpartyAddresses(
  message: Pick<MailMessage, "fromEmail" | "toEmails" | "ccEmails">,
  mailboxAddress: string | null,
): string[] {
  const mailbox = normalizeEmail(mailboxAddress);
  const direction = messageDirection(message, mailbox);

  const raw =
    direction === "outbound"
      ? [
          ...parseAddressList(message.toEmails).addresses,
          ...parseAddressList(message.ccEmails).addresses,
        ]
      : [normalizeEmail(message.fromEmail)];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of raw) {
    if (!candidate || candidate === mailbox || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push(candidate);
  }
  return out;
}

/**
 * When the message happened.
 *
 * `sentAt` is Gmail's internalDate and is what the timeline should sort by.
 * It is nullable in the mirror, and a row with no timestamp must still land
 * somewhere sane rather than at the epoch, so we fall back to when we learned
 * about it.
 */
function occurredAt(message: MailMessage): Date {
  return message.sentAt ?? message.createdAt ?? new Date();
}

/**
 * The body we put on the activity.
 *
 * Snippet first: Gmail has already stripped quoted history and signatures from
 * it, so it is the one line that actually says what happened. Full body only
 * when there is no snippet, and {@link recordMailActivities} caps it.
 */
function activityBody(message: MailMessage): string {
  const snippet = (message.snippet ?? "").trim();
  if (snippet) return snippet;
  return message.bodyText ?? "";
}

function* chunked<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) {
    yield items.slice(i, i + size);
  }
}

// ───────────────────────────── linking ─────────────────────────────

/**
 * Put every message involving a known Contact onto that Contact's timeline.
 *
 * One `findContactsByEmails` and one `recordMailActivities` per chunk, not per
 * message: a first import hands us hundreds of messages at a time and per-row
 * round-trips would make connecting a mailbox take minutes.
 *
 * A message addressed to two known contacts writes two activities — one per
 * timeline — which is why `activities` can exceed `linked`.
 */
export async function linkMessagesToContacts(
  companyId: string,
  messages: MailMessage[],
  accountAddress: string,
): Promise<MailLinkResult> {
  const mailbox = normalizeEmail(accountAddress);
  let linked = 0;
  let activities = 0;
  for (const chunk of chunked(messages, LINK_CHUNK_SIZE)) {
    const result = await linkChunk(companyId, chunk, mailbox);
    linked += result.linked;
    activities += result.activities;
  }
  return { linked, activities };
}

async function linkChunk(
  companyId: string,
  messages: MailMessage[],
  mailbox: string | null,
): Promise<MailLinkResult> {
  type Plan = {
    message: MailMessage;
    direction: MailDirection;
    addresses: string[];
  };

  const plans: Plan[] = [];
  const everyAddress = new Set<string>();
  for (const message of messages) {
    if (isDraft(message)) continue;
    const addresses = counterpartyAddresses(message, mailbox);
    if (addresses.length === 0) continue;
    plans.push({
      message,
      direction: messageDirection(message, mailbox),
      addresses,
    });
    for (const address of addresses) everyAddress.add(address);
  }
  if (plans.length === 0) return { linked: 0, activities: 0 };

  // The one query that decides everything. Anything not in here is a stranger,
  // and a stranger stays a stranger — see rule 1 in the module doc.
  const byEmail = await findContactsByEmails(companyId, [...everyAddress]);
  if (byEmail.size === 0) return { linked: 0, activities: 0 };

  const inputs: Array<ActivityInput & { mailMessageId: string }> = [];
  let linked = 0;
  for (const plan of plans) {
    const contacts = resolveContacts(plan.addresses, byEmail);
    if (contacts.length === 0) continue;
    linked += 1;
    for (const contact of contacts) {
      inputs.push({
        kind: plan.direction === "outbound" ? "email_out" : "email_in",
        subject: plan.message.subject,
        bodyText: activityBody(plan.message),
        occurredAt: occurredAt(plan.message),
        contactId: contact.id,
        customerId: contact.customerId,
        mailThreadId: plan.message.threadId,
        mailMessageId: plan.message.id,
      });
    }
  }

  const activities = await recordMailActivities(companyId, inputs);
  return { linked, activities };
}

/**
 * Distinct contacts behind a message's counterparties.
 *
 * De-duplicated by contact id, not by address: one person can hold two
 * addresses on the same thread (To and Cc), and writing their timeline entry
 * twice would show the same email twice.
 */
function resolveContacts(
  addresses: string[],
  byEmail: Map<string, Contact>,
): Contact[] {
  const out: Contact[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const contact = byEmail.get(address);
    if (!contact || seen.has(contact.id)) continue;
    seen.add(contact.id);
    out.push(contact);
  }
  return out;
}

// ───────────────────────────── reply detection ─────────────────────────────

/**
 * Stop any sequence the counterparty just replied to.
 *
 * This is the single most important guard an outbound tool has: a follow-up
 * that arrives after somebody already answered makes the sender look like they
 * were not reading, and it is the failure people remember. Sync is the right
 * place for it because the reply is *already* being mirrored — no extra fetch,
 * and the enrolment stops within one heartbeat of the answer landing.
 *
 * Matching is by thread, not by sender address: replies legitimately arrive
 * from a colleague, an alias, or an assistant, and a human answering on behalf
 * of the contact is still an answer. Thread identity is what the enrolment
 * recorded when it sent, so it is also the cheapest thing to match on.
 */
export async function handleInboundForSequences(
  companyId: string,
  messages: MailMessage[],
  accountAddress: string,
): Promise<number> {
  const mailbox = normalizeEmail(accountAddress);
  const threadIds = new Set<string>();
  for (const message of messages) {
    if (isDraft(message)) continue;
    if (messageDirection(message, mailbox) !== "inbound") continue;
    if (message.threadId) threadIds.add(message.threadId);
  }
  if (threadIds.size === 0) return 0;

  let stopped = 0;
  for (const threadId of threadIds) {
    stopped += await stopEnrollmentsForThread(
      companyId,
      threadId,
      "stopped_replied",
      "Reply received on the thread",
    );
  }
  return stopped;
}

// ───────────────────────────── bounces ─────────────────────────────

/** True for the reserved mailbox names that generate delivery reports. */
export function isBounceSender(fromEmail: string | null | undefined): boolean {
  const normalized = normalizeEmail(fromEmail);
  if (!normalized) return false;
  return DAEMON_LOCAL_PARTS.has(normalized.slice(0, normalized.indexOf("@")));
}

/**
 * Pull the failed recipient(s) out of a delivery report.
 *
 * Two tiers, and the second one only runs when the first finds nothing:
 *
 * 1. **`Final-Recipient: rfc822; addr`** — the RFC 3464 machine-readable
 *    field. Unambiguous by construction, so every match is taken.
 * 2. **A line carrying a permanent-failure code** (`550`, `5.1.1`) — human
 *    prose, so it is only trusted when the whole report yields exactly one
 *    address this way. Two candidates means we cannot tell which one failed,
 *    and a report we half-understand is a report we do not understand.
 *
 * The bias is deliberate and asymmetric. A missed bounce costs one wasted send
 * to a dead address, and the next report catches it. A wrong suppression
 * silently stops all future mail to a *live* address, with no error anywhere
 * and no way for the user to discover why that customer went quiet. So when in
 * doubt this returns nothing.
 */
export function extractFailedRecipients(
  message: Pick<MailMessage, "fromEmail" | "bodyText" | "snippet">,
): string[] {
  const text = `${message.bodyText ?? ""}\n${message.snippet ?? ""}`;
  if (!text.trim()) return [];
  const daemon = normalizeEmail(message.fromEmail);

  const structured = new Set<string>();
  // `matchAll` on a /g regex, so the lastIndex of the shared literal cannot
  // leak between calls.
  for (const match of text.matchAll(FINAL_RECIPIENT_RE)) {
    const address = normalizeEmail(stripTrailingPunctuation(match[1]));
    if (!address || address === daemon) continue;
    structured.add(address);
  }
  if (structured.size > 0) return [...structured];

  const loose = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!HARD_FAILURE_RE.test(line)) continue;
    const onLine = addressesIn(line, daemon);
    // More than one address on the failure line: which one bounced? Unknowable.
    if (onLine.length !== 1) continue;
    loose.add(onLine[0]);
  }
  if (loose.size !== 1) return [];
  return [...loose];
}

/** Validated, de-duplicated addresses on one line, minus the report's sender. */
function addressesIn(line: string, daemon: string | null): string[] {
  const out = new Set<string>();
  for (const match of line.matchAll(LOOSE_ADDRESS_RE)) {
    const address = normalizeEmail(stripTrailingPunctuation(match[0]));
    if (!address || address === daemon) continue;
    out.add(address);
  }
  return [...out];
}

/**
 * Trim the punctuation that surrounds an address quoted in prose
 * (`<a@b.com>:`, `a@b.com.`). `normalizeEmail` already unwraps angle brackets;
 * this handles what is left after them.
 */
function stripTrailingPunctuation(value: string): string {
  return value.trim().replace(/^[<("']+|[>)"'.,;:]+$/g, "");
}

/**
 * Record every bounce we can read confidently.
 *
 * Suppression and the Contact flag are both written: the {@link addSuppression}
 * row stops future sends to the address (including from a different Contact, or
 * from no Contact at all), while `bouncedAt` on the Contact is what a human
 * sees when they wonder why that person stopped receiving mail. Neither
 * substitutes for the other.
 *
 * Returns how many addresses were recorded, counting each address once no
 * matter how many reports named it.
 */
export async function detectBounces(
  companyId: string,
  messages: MailMessage[],
  now = new Date(),
): Promise<number> {
  const failed = new Set<string>();
  for (const message of messages) {
    if (isDraft(message)) continue;
    if (!isBounceSender(message.fromEmail)) continue;
    for (const address of extractFailedRecipients(message)) failed.add(address);
  }
  if (failed.size === 0) return 0;

  let recorded = 0;
  for (const email of failed) {
    const row = await addSuppression({
      companyId,
      email,
      reason: "bounce",
      source: "mail-sync",
      notes: "Recovered from a delivery status notification",
    });
    // A null means the address did not survive normalization, which should not
    // happen here — but counting it would overstate what we actually blocked.
    if (!row) continue;
    await markContactBounced(companyId, email, now);
    recorded += 1;
  }
  return recorded;
}

// ───────────────────────────── the sync entry point ─────────────────────────────

/**
 * Round a window boundary down to the start of its second.
 *
 * `@CreateDateColumn()` stores `datetime('now')` on SQLite, which has **second**
 * precision — a row written at 12:00:05.900 is stored as 12:00:05.000. The
 * caller's boundary is a JS `Date` with milliseconds, so comparing them
 * directly makes `createdAt >= 12:00:05.700` reject a message that really did
 * arrive after that instant, and the activity is silently never recorded.
 *
 * Flooring makes the window slightly too wide instead, which costs nothing:
 * every write below is idempotent on `mailMessageId`, so re-examining a message
 * from the previous second produces no duplicate rows.
 */
function floorToSecond(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * Everything the revenue side wants from one mail sync pass, in one call.
 *
 * `services/mail/sync.ts` calls exactly this, so the mail subsystem knows about
 * one function rather than four and the ordering below stays a decision of this
 * module rather than of the sync loop. Bounces run first: a reply-stop and a
 * timeline row for a message we are about to mark undeliverable are still
 * correct, but suppressing early means the very next sequence tick already
 * knows the address is dead.
 *
 * Scoped by `createdAt >= since` rather than `updatedAt`, because a label
 * change re-saves a message without it being new to us, and because TypeORM
 * skips the UPDATE entirely when a re-save changes nothing — `updatedAt` is
 * simply not a reliable "we saw this in this pass" marker (the sync module's
 * own prune logic works around the same thing). Messages mirrored before this
 * feature existed are therefore never picked up here; backfilling them is a
 * deliberate one-off, not something every sync pass should re-scan a whole
 * mailbox for.
 *
 * The boundary is floored to the second before comparing — see
 * {@link floorToSecond}.
 */
export async function linkAccountMessagesSince(
  account: LinkableAccount,
  since: Date,
): Promise<MailSyncLinkResult> {
  const messages = await AppDataSource.getRepository(MailMessage).find({
    where: { accountId: account.id, createdAt: MoreThanOrEqual(floorToSecond(since)) },
    order: { createdAt: "ASC" },
  });
  if (messages.length === 0) {
    return { linked: 0, activities: 0, sequencesStopped: 0, bouncesRecorded: 0 };
  }

  const bouncesRecorded = await detectBounces(account.companyId, messages);
  const { linked, activities } = await linkMessagesToContacts(
    account.companyId,
    messages,
    account.address,
  );
  const sequencesStopped = await handleInboundForSequences(
    account.companyId,
    messages,
    account.address,
  );
  return { linked, activities, sequencesStopped, bouncesRecorded };
}

/**
 * {@link linkAccountMessagesSince} with the failure policy attached: log and
 * carry on, never throw.
 *
 * The guard lives here rather than as a `try`/`catch` in the sync loop for two
 * reasons. It keeps the mail subsystem's diff to a single unconditional call —
 * mail sync should not have to know that the CRM is allowed to fail — and it
 * makes "a broken revenue path cannot break mailbox sync" an assertion a test
 * can actually make, instead of a property of a code shape nobody exercises.
 *
 * Returns null when the pass failed, so a caller that wants to report progress
 * can tell "nothing to do" from "it broke".
 */
export async function linkAccountMessagesSafely(
  account: LinkableAccount,
  since: Date,
): Promise<MailSyncLinkResult | null> {
  try {
    return await linkAccountMessagesSince(account, since);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[revenue] mail linking failed for account ${account.id}:`, err);
    return null;
  }
}
