import type { MailAccount } from "./mail";

/**
 * Which mailbox a person last worked in, per company.
 *
 * The Email section remembers the mailbox picked in its sidebar; a message
 * written from anywhere else in the product starts from the same one, so
 * "Email attendees" sends from the mailbox the person reads replies in.
 */

export const activeMailAccountKey = (companyId: string) => `genosyn.mail.account.${companyId}`;

/** The remembered mailbox id, or null when nothing is stored or storage is blocked. */
export function readActiveMailAccount(companyId: string): string | null {
  try {
    return localStorage.getItem(activeMailAccountKey(companyId));
  } catch {
    return null;
  }
}

export function rememberActiveMailAccount(companyId: string, accountId: string): void {
  try {
    localStorage.setItem(activeMailAccountKey(companyId), accountId);
  } catch {
    // A private window or blocked storage: the choice lasts for this visit only.
  }
}

/**
 * The mailbox a new message goes from: the remembered one, else the first
 * that is working, else the first at all. A paused or failing mailbox is a
 * last resort, since a send from it is the likeliest to fail.
 */
export function pickMailAccount(
  accounts: MailAccount[],
  preferredId: string | null,
): MailAccount | null {
  return (
    accounts.find((row) => row.id === preferredId) ??
    accounts.find((row) => row.status === "active") ??
    accounts[0] ??
    null
  );
}
