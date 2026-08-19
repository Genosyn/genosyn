import { AppDataSource } from "../../db/datasource.js";
import { CalendarAccount } from "../../db/entities/CalendarAccount.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { Membership } from "../../db/entities/Membership.js";
import { User } from "../../db/entities/User.js";
import { emailDomain } from "../../lib/emailAddress.js";

/**
 * "Is this attendee one of us?"
 *
 * There is no `company.domain` column, and inventing one would mean asking
 * every existing install to fill in a field before meetings worked. So the
 * answer is derived from addresses the company has already proven it owns:
 * the calendars it connected, the mailboxes it connected, and the addresses
 * its Members sign in with.
 *
 * Free-mail hosts are excluded, and that exclusion is the entire reason this
 * module is careful. A company whose founder signs in with a `@gmail.com`
 * address would otherwise mark **every** Gmail user on Earth as internal —
 * which would make `autoRecord: "external"` silently record nothing, the
 * failure being an absence rather than an error. The list below is only the
 * hosts big enough that this is a real risk; an unknown small host being
 * treated as internal costs one un-recorded meeting, while the reverse costs
 * a recording nobody expected.
 */
const FREE_MAIL_DOMAINS = new Set([
  "aol.com",
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mac.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "pm.me",
  "proton.me",
  "protonmail.com",
  "yahoo.com",
  "yandex.com",
  "zoho.com",
]);

export function isFreeMailDomain(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return FREE_MAIL_DOMAINS.has(domain.toLowerCase());
}

/**
 * The domains this company demonstrably owns, lowercased.
 *
 * Returns an empty set when everything it found was free mail, and callers
 * must treat that as "we cannot tell" rather than "nobody is internal" — see
 * {@link isInternalAddress}.
 */
export async function companyDomains(companyId: string): Promise<Set<string>> {
  const [calendars, mailboxes, memberships] = await Promise.all([
    AppDataSource.getRepository(CalendarAccount).find({
      where: { companyId },
      select: { address: true },
    }),
    AppDataSource.getRepository(MailAccount).find({
      where: { companyId },
      select: { address: true },
    }),
    AppDataSource.getRepository(Membership).find({
      where: { companyId },
      select: { userId: true },
    }),
  ]);

  const addresses: string[] = [
    ...calendars.map((row) => row.address),
    ...mailboxes.map((row) => row.address),
  ];

  const userIds = memberships.map((row) => row.userId).filter(Boolean);
  if (userIds.length > 0) {
    const users = await AppDataSource.getRepository(User).find({
      where: userIds.map((id) => ({ id })),
      select: { email: true },
    });
    addresses.push(...users.map((row) => row.email));
  }

  const domains = new Set<string>();
  for (const address of addresses) {
    const domain = emailDomain(address);
    if (!domain || isFreeMailDomain(domain)) continue;
    domains.add(domain.toLowerCase());
  }
  return domains;
}

/**
 * Whether an address belongs to the company.
 *
 * With no known domains this returns **false for everyone**, which reads
 * oddly until you follow it through: `autoRecord: "external"` then treats
 * every meeting as external and records it. That is the wrong default for a
 * recorder, so `shouldAutoRecord` refuses to arm at all when the domain set is
 * empty rather than relying on this function to be clever.
 */
export function isInternalAddress(email: string, domains: Set<string>): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return domains.has(domain.toLowerCase());
}
