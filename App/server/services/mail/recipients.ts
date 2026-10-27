import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import type { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailMessageAddress } from "../../db/entities/MailMessageAddress.js";
import { Suppression, type SuppressionReason } from "../../db/entities/Suppression.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import { policyBlockedRecipients } from "../companyPolicies.js";
import { decodeDisplayName, splitAddressList } from "./mime.js";
import { collectRecipients } from "./suppression.js";

/**
 * Who a Member is writing to, while they are still writing.
 *
 * Two reads back the To / Cc / Bcc chips in every composer:
 *
 * - {@link suggestRecipients} is the mailbox's own address book — the people
 *   this mailbox has exchanged mail with, most frequent first. It reads the
 *   address index (`mail_message_addresses`) through its `(companyId,
 *   address)` and `(companyId, baseDomain)` indexes, and the newest few
 *   hundred messages through `(accountId, createdAt)`, so a keystroke never
 *   scans a mailbox (AGENTS.md §7). It stays inside the mailbox: the people a
 *   Member is offered are people this mailbox already wrote to or heard from.
 * - {@link checkRecipients} says which of the chosen recipients a send would
 *   refuse, and why, so the chip turns red before the Member presses Send
 *   instead of after. It neither refuses nor audits; the send path's own gate
 *   (`assertRecipientsAllowed`) still decides.
 */

export type RecipientSuggestion = {
  email: string;
  name: string;
  /** Messages this mailbox holds with this person on From, To or Cc. */
  count: number;
  /** When the newest of them reached the mailbox, when it is known. */
  lastAt: string | null;
};

export const RECIPIENT_SUGGESTIONS_DEFAULT = 8;
export const RECIPIENT_SUGGESTIONS_MAX = 20;
/** The newest messages read for "people you write to" and for display names. */
const RECENT_WINDOW = 400;
/** Index rows one prefix lookup may read, however short the prefix. */
const PREFIX_SCAN_ROWS = 10_000;
/** Messages sampled per suggested address to find the name it goes by. */
const NAME_SAMPLES = 3;
const MAX_NAME_LENGTH = 200;

/**
 * Machine senders nobody means to write to. Offering `noreply@` as the first
 * suggestion for "n" is a suggestion list working against the person using it.
 */
const AUTOMATED_LOCAL_PART =
  /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?)([+.-]|$)/;

export function isAutomatedAddress(address: string): boolean {
  return AUTOMATED_LOCAL_PART.test(address.slice(0, address.indexOf("@")));
}

/**
 * `Name <a@b>` entries in an address-list header, read back as an address
 * and the name it was written with. Entries that are not an address are
 * skipped; a "name" that is only the address again, or carries an `@`, is
 * dropped rather than shown as somebody's name.
 */
export function namedAddresses(
  header: string | null | undefined,
): Array<{ email: string; name: string }> {
  if (!header) return [];
  const out: Array<{ email: string; name: string }> = [];
  for (const entry of splitAddressList(header)) {
    const named = /^(.*?)\s*<([^<>]*)>$/.exec(entry);
    const email = normalizeEmail(named ? named[2] : entry);
    if (!email) continue;
    out.push({ email, name: named ? cleanDisplayName(named[1]) : "" });
  }
  return out;
}

/** A display name as a chip should show it, or "" when it is not really a name. */
export function cleanDisplayName(raw: string): string {
  const name = decodeDisplayName(raw)
    .replace(/^'+|'+$/g, "")
    .trim();
  if (!name || name.includes("@")) return "";
  return name.slice(0, MAX_NAME_LENGTH);
}

/** The smallest string greater than every string starting with `prefix`. */
export function prefixUpperBound(prefix: string): string {
  const last = prefix.charCodeAt(prefix.length - 1);
  return `${prefix.slice(0, -1)}${String.fromCharCode(last + 1)}`;
}

type Correspondent = {
  email: string;
  name: string;
  /** True once the name came from the person's own From line. */
  ownName: boolean;
  count: number;
  lastAt: Date | null;
};

type HeaderRow = Pick<
  MailMessage,
  "id" | "createdAt" | "fromName" | "fromEmail" | "toEmails" | "ccEmails"
>;

const HEADER_COLUMNS = {
  id: true,
  createdAt: true,
  fromName: true,
  fromEmail: true,
  toEmails: true,
  ccEmails: true,
} as const;

/** Each person on a message's From, To and Cc lines, once, with the name they carry there. */
function peopleOn(row: HeaderRow): Array<{ email: string; name: string; fromLine: boolean }> {
  const people = new Map<string, { email: string; name: string; fromLine: boolean }>();
  const from = normalizeEmail(row.fromEmail);
  if (from) people.set(from, { email: from, name: cleanDisplayName(row.fromName), fromLine: true });
  for (const entry of [...namedAddresses(row.toEmails), ...namedAddresses(row.ccEmails)]) {
    const seen = people.get(entry.email);
    if (!seen) people.set(entry.email, { ...entry, fromLine: false });
    else if (!seen.name && entry.name) seen.name = entry.name;
  }
  return [...people.values()];
}

function remember(
  into: Map<string, Correspondent>,
  person: { email: string; name: string; fromLine: boolean },
  at: Date | null,
): void {
  const seen = into.get(person.email);
  if (!seen) {
    into.set(person.email, {
      email: person.email,
      name: person.name,
      ownName: person.fromLine && !!person.name,
      count: 1,
      lastAt: at,
    });
    return;
  }
  seen.count += 1;
  if (at && (!seen.lastAt || at > seen.lastAt)) seen.lastAt = at;
  // The name a person signs their own mail with beats what others call them.
  if (person.name && (!seen.name || (person.fromLine && !seen.ownName))) {
    seen.name = person.name;
    seen.ownName = person.fromLine;
  }
}

/** The people on this mailbox's newest messages: one indexed read of a bounded window. */
async function recentCorrespondents(account: MailAccount): Promise<Map<string, Correspondent>> {
  const rows = (await AppDataSource.getRepository(MailMessage).find({
    where: { accountId: account.id },
    select: HEADER_COLUMNS,
    order: { createdAt: "DESC" },
    take: RECENT_WINDOW,
  })) as HeaderRow[];
  const self = normalizeEmail(account.address);
  const people = new Map<string, Correspondent>();
  for (const row of rows) {
    for (const person of peopleOn(row)) {
      if (person.email === self || isAutomatedAddress(person.email)) continue;
      remember(people, person, row.createdAt ?? null);
    }
  }
  return people;
}

/**
 * Index rows in one bounded key range, counted per address. `column` is the
 * address itself or its registered domain; both lead an index after
 * `companyId`, so the range is a seek, not a scan.
 */
async function countInRange(
  account: MailAccount,
  column: "address" | "baseDomain",
  prefix: string,
): Promise<Map<string, number>> {
  const rows: Array<{ address: string; baseDomain: string }> = await AppDataSource.getRepository(
    MailMessageAddress,
  )
    .createQueryBuilder("a")
    .select("a.address", "address")
    .addSelect("a.baseDomain", "baseDomain")
    .where("a.companyId = :companyId", { companyId: account.companyId })
    .andWhere(`a.${column} >= :low`, { low: prefix })
    .andWhere(`a.${column} < :high`, { high: prefixUpperBound(prefix) })
    .andWhere("a.accountId = :accountId", { accountId: account.id })
    .limit(PREFIX_SCAN_ROWS)
    .getRawMany();
  const counts = new Map<string, number>();
  for (const row of rows) {
    // A collation that is not byte order can widen a range; the prefix is the rule.
    if (!String(row[column] ?? "").startsWith(prefix)) continue;
    counts.set(row.address, (counts.get(row.address) ?? 0) + 1);
  }
  return counts;
}

/** Fill in names for addresses the recent window never named, from a few of their messages. */
async function nameFromSamples(
  account: MailAccount,
  emails: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (emails.length === 0) return names;
  const addressRepo = AppDataSource.getRepository(MailMessageAddress);
  const samples = await Promise.all(
    emails.map((email) =>
      addressRepo.find({
        where: { companyId: account.companyId, address: email, accountId: account.id },
        select: { messageId: true, address: true },
        take: NAME_SAMPLES,
      }),
    ),
  );
  const ids = [...new Set(samples.flat().map((row) => row.messageId))];
  if (ids.length === 0) return names;
  const rows = (await AppDataSource.getRepository(MailMessage).find({
    where: { id: In(ids), accountId: account.id },
    select: HEADER_COLUMNS,
  })) as HeaderRow[];
  const wanted = new Set(emails);
  const found = new Map<string, Correspondent>();
  for (const row of rows) {
    for (const person of peopleOn(row)) {
      if (wanted.has(person.email)) remember(found, person, null);
    }
  }
  for (const [email, person] of found) if (person.name) names.set(email, person.name);
  return names;
}

function byRank(a: Correspondent, b: Correspondent): number {
  return (
    b.count - a.count ||
    (b.lastAt?.getTime() ?? 0) - (a.lastAt?.getTime() ?? 0) ||
    a.email.localeCompare(b.email)
  );
}

/** Whether a name has a word that starts with `query` ("menzel" finds "Felix Menzel"). */
function nameMatches(name: string, query: string): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  return (
    lower.startsWith(query) || lower.split(/[\s,.'"()-]+/).some((word) => word.startsWith(query))
  );
}

/**
 * People this mailbox corresponds with, best first, matching what is typed.
 *
 * An empty query lists the most frequent people on the newest few hundred
 * messages. Otherwise an address that starts with the query, anyone at a
 * domain that does, and anyone on the newest messages whose name has a word
 * that does are ranked together by how often the mailbox has written with
 * them, then by how recently.
 */
export async function suggestRecipients(
  account: MailAccount,
  rawQuery: string,
  limit = RECIPIENT_SUGGESTIONS_DEFAULT,
): Promise<RecipientSuggestion[]> {
  const take = Math.max(1, Math.min(RECIPIENT_SUGGESTIONS_MAX, Math.floor(limit)));
  const query = rawQuery
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "");
  const self = normalizeEmail(account.address);
  const recent = await recentCorrespondents(account);

  let ranked: Correspondent[];
  if (!query) {
    ranked = [...recent.values()].sort(byRank);
  } else {
    const candidates = new Map<string, Correspondent>();
    const consider = (email: string, count: number) => {
      if (email === self || isAutomatedAddress(email)) return;
      const known = recent.get(email);
      const seen = candidates.get(email);
      const merged: Correspondent = seen ?? {
        email,
        name: known?.name ?? "",
        ownName: known?.ownName ?? false,
        count: known?.count ?? 0,
        lastAt: known?.lastAt ?? null,
      };
      merged.count = Math.max(merged.count, count);
      candidates.set(email, merged);
    };

    const at = query.indexOf("@");
    const domainQuery = at === -1 ? query : query.slice(at + 1);
    const lookups: Array<Promise<Map<string, number>>> = [];
    if (at !== 0) lookups.push(countInRange(account, "address", query));
    if (domainQuery && (at === -1 || at === 0)) {
      lookups.push(countInRange(account, "baseDomain", domainQuery));
    }
    for (const counts of await Promise.all(lookups)) {
      for (const [email, count] of counts) consider(email, count);
    }
    for (const person of recent.values()) {
      if (nameMatches(person.name, query) || person.email.startsWith(query)) {
        consider(person.email, person.count);
      }
    }
    ranked = [...candidates.values()].sort(byRank);
  }

  const top = ranked.slice(0, take);
  const unnamed = top.filter((person) => !person.name).map((person) => person.email);
  const names = await nameFromSamples(account, unnamed);
  return top.map((person) => ({
    email: person.email,
    name: person.name || names.get(person.email) || "",
    count: person.count,
    lastAt: person.lastAt ? person.lastAt.toISOString() : null,
  }));
}

// ───────────────────────────── recipient check ─────────────────────────────

export type BlockedRecipientReason = "suppressed" | "do_not_contact" | "policy";

export type BlockedRecipient = {
  email: string;
  reason: BlockedRecipientReason;
  /** One line a Member reads beside the chip: why this address will not be mailed. */
  detail: string;
};

const SUPPRESSION_DETAIL: Record<SuppressionReason, string> = {
  unsubscribe: "Unsubscribed — on this company's do-not-email list",
  bounce: "Bounced — on this company's do-not-email list",
  complaint: "Marked as spam — on this company's do-not-email list",
  manual: "Added by hand to this company's do-not-email list",
  imported: "Imported onto this company's do-not-email list",
};

const DO_NOT_CONTACT_DETAIL = "Marked do not contact — on this company's do-not-email list";

/**
 * Which recipients a send would refuse, in the order they were written, each
 * once, with the first reason that applies: an address on the do-not-email
 * list, then a person marked do not contact, then a Policy's blocked domain.
 *
 * The same sources as the send gate (`suppression.ts`, `companyPolicies.ts`),
 * read without throwing and without auditing.
 */
export async function checkRecipients(
  companyId: string,
  fields: { to?: string | null; cc?: string | null; bcc?: string | null },
): Promise<BlockedRecipient[]> {
  const recipients = collectRecipients(fields);
  if (recipients.length === 0) return [];
  const [suppressions, contacts, policies] = await Promise.all([
    AppDataSource.getRepository(Suppression).find({
      where: { companyId, email: In(recipients) },
      select: { email: true, reason: true },
    }),
    AppDataSource.getRepository(Contact).find({
      where: { companyId, email: In(recipients), doNotContact: true },
      select: { email: true },
    }),
    policyBlockedRecipients(companyId, recipients),
  ]);
  const suppressed = new Map(suppressions.map((row) => [row.email, row.reason]));
  const doNotContact = new Set(
    contacts.map((row) => normalizeEmail(row.email)).filter((email): email is string => !!email),
  );
  const policy = new Map(policies.map((row) => [row.address, row.policyTitle]));

  const blocked: BlockedRecipient[] = [];
  for (const email of recipients) {
    const reason = suppressed.get(email);
    if (reason) {
      blocked.push({
        email,
        reason: "suppressed",
        detail: SUPPRESSION_DETAIL[reason] ?? "On this company's do-not-email list",
      });
    } else if (doNotContact.has(email)) {
      blocked.push({ email, reason: "do_not_contact", detail: DO_NOT_CONTACT_DETAIL });
    } else if (policy.has(email)) {
      blocked.push({
        email,
        reason: "policy",
        detail: `Blocked by the policy “${policy.get(email)}”`,
      });
    }
  }
  return blocked;
}
