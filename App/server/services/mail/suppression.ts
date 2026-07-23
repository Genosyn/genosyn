import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { Contact } from "../../db/entities/Contact.js";
import {
  Suppression,
  type SuppressionReason,
} from "../../db/entities/Suppression.js";
import { normalizeEmail, parseAddressList } from "../../lib/emailAddress.js";

/**
 * The do-not-mail gate.
 *
 * Lives under `services/mail/` rather than `services/revenue/` on purpose: this
 * is a property of *sending*, not of the revenue product. Sequences import it;
 * it imports nothing from revenue. Keeping the dependency pointing this way is
 * what lets the guard sit in the send path without dragging the CRM into the
 * mail subsystem.
 *
 * Two independent sources block an address, and either one is enough:
 *
 * 1. A {@link Suppression} row — the address itself is off limits (they
 *    unsubscribed, it bounced, somebody complained).
 * 2. A {@link Contact} with `doNotContact` — the *person* is off limits, which
 *    covers every address we hold for them.
 *
 * Both are company-scoped. Somebody who opts out of one of your mailboxes has
 * not consented to hear from another, and the reputational damage of getting
 * that wrong lands on the whole sending domain.
 */

/** Raised when a send is refused. Carries the offending addresses so the caller */
/** can tell the user precisely who was skipped and why. */
export class SuppressedRecipientError extends Error {
  readonly suppressed: string[];

  constructor(suppressed: string[]) {
    super(
      suppressed.length === 1
        ? `${suppressed[0]} is on this company's do-not-email list`
        : `${suppressed.length} recipients are on this company's do-not-email list: ${suppressed.join(", ")}`,
    );
    this.name = "SuppressedRecipientError";
    this.suppressed = suppressed;
  }
}

/** Pull every deliverable address out of a compose payload. */
export function collectRecipients(fields: {
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
}): string[] {
  const all = [
    ...parseAddressList(fields.to).addresses,
    ...parseAddressList(fields.cc).addresses,
    ...parseAddressList(fields.bcc).addresses,
  ];
  return [...new Set(all)];
}

/**
 * Which of these addresses must not be mailed.
 *
 * One query per source rather than per address — a bulk send resolves 500
 * recipients in two round-trips. Returns normalized addresses, so callers
 * should normalize before comparing.
 */
export async function suppressedAmong(
  companyId: string,
  emails: string[],
): Promise<Set<string>> {
  const normalized = [
    ...new Set(emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e)),
  ];
  const blocked = new Set<string>();
  if (normalized.length === 0) return blocked;

  const rows = await AppDataSource.getRepository(Suppression).find({
    where: { companyId, email: In(normalized) },
    select: { email: true },
  });
  for (const row of rows) blocked.add(row.email);

  // A person marked do-not-contact blocks every address we hold for them, even
  // one that was never explicitly suppressed.
  const contacts = await AppDataSource.getRepository(Contact).find({
    where: { companyId, email: In(normalized), doNotContact: true },
    select: { email: true },
  });
  for (const contact of contacts) {
    const email = normalizeEmail(contact.email);
    if (email) blocked.add(email);
  }

  return blocked;
}

export async function isSuppressed(companyId: string, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  return (await suppressedAmong(companyId, [normalized])).has(normalized);
}

/**
 * Split a recipient list into who may be mailed and who may not.
 *
 * Used by the sequence tick, which skips rather than fails: one suppressed
 * contact in a hundred should not stop the other ninety-nine.
 */
export async function partitionRecipients(
  companyId: string,
  emails: string[],
): Promise<{ allowed: string[]; suppressed: string[] }> {
  const blocked = await suppressedAmong(companyId, emails);
  const allowed: string[] = [];
  const suppressed: string[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const email = normalizeEmail(raw);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    if (blocked.has(email)) suppressed.push(email);
    else allowed.push(email);
  }
  return { allowed, suppressed };
}

/**
 * The hard gate. Throws {@link SuppressedRecipientError} if **any** recipient is
 * blocked — deliberately all-or-nothing rather than silently dropping the bad
 * ones, because a message quietly delivered to three of its four recipients is
 * a bug the sender discovers weeks later, if ever.
 *
 * Callers that want the tolerant behaviour use {@link partitionRecipients} and
 * decide for themselves.
 */
export async function assertRecipientsAllowed(
  companyId: string,
  fields: { to?: string | null; cc?: string | null; bcc?: string | null },
): Promise<void> {
  const recipients = collectRecipients(fields);
  if (recipients.length === 0) return;
  const blocked = await suppressedAmong(companyId, recipients);
  if (blocked.size > 0) throw new SuppressedRecipientError([...blocked].sort());
}

/**
 * Add an address to the list. Idempotent: re-suppressing an address updates
 * nothing and returns the existing row, so a bounce arriving twice is harmless.
 *
 * Returns null when the address is unusable — callers should not treat that as
 * success, but nor should a malformed bounce header throw inside mail sync.
 */
export async function addSuppression(input: {
  companyId: string;
  email: string;
  reason: SuppressionReason;
  source?: string;
  contactId?: string | null;
  notes?: string;
  createdById?: string | null;
}): Promise<Suppression | null> {
  const email = normalizeEmail(input.email);
  if (!email) return null;

  const repo = AppDataSource.getRepository(Suppression);
  const existing = await repo.findOneBy({ companyId: input.companyId, email });
  if (existing) return existing;

  const row = repo.create({
    companyId: input.companyId,
    email,
    reason: input.reason,
    source: input.source ?? "",
    contactId: input.contactId ?? null,
    notes: input.notes ?? "",
    createdById: input.createdById ?? null,
  });
  try {
    return await repo.save(row);
  } catch {
    // Lost a race against another replica inserting the same address. The
    // unique index did its job; read back the winner rather than failing a
    // send-path caller for a row that now exists.
    return repo.findOneBy({ companyId: input.companyId, email });
  }
}

/**
 * Remove an address. A deliberate human act with a confirmation in the UI —
 * the cheapest way to get a sending domain blocklisted is to mail somebody who
 * already said no.
 */
export async function removeSuppression(
  companyId: string,
  email: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const result = await AppDataSource.getRepository(Suppression).delete({
    companyId,
    email: normalized,
  });
  return (result.affected ?? 0) > 0;
}
