/**
 * The sender name of an IMAP mailbox: the name recipients see beside its
 * address, as in `From: Avery Monroe <avery@example.com>`.
 *
 * Shared between client and server so the limit the settings field counts
 * against and the limit the API enforces can never disagree, and so both sides
 * mean the same thing by "the same name" — the client decides whether Save has
 * anything to save by the very rule the server stores by.
 */

/** Far longer than any real name, short enough that `From` stays one readable line. */
export const MAX_SENDER_NAME_LENGTH = 100;

/** The name as it is stored: every run of whitespace one space, trimmed. */
export function normalizeSenderName(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
