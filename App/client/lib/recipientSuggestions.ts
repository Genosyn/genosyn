import type { RecipientSuggestion } from "./api.js";
import {
  type Recipient,
  type RecipientFields,
  recipientKey,
  takenAddresses,
} from "./recipientTokens.js";

/**
 * What the send dialog does with the customer's people the server suggests
 * (`GET /customers/:slug/recipient-suggestions`, already ranked best first):
 * which of them are still worth offering, which ones match what the Member is
 * typing, and the line each one shows.
 *
 * Someone already on the email — on the To or Cc line, or copied by Finance →
 * Settings → Always Cc — is not offered again, and comes back the moment they
 * are taken off.
 */

/** How many suggestions show before "Show more". */
export const SUGGESTIONS_SHOWN = 4;
/** How many matches the To and Cc fields offer while typing. */
export const MATCHES_SHOWN = 6;

/** The Always Cc line the server sends, as addresses. */
export function alwaysCcAddresses(alwaysCcAddress: string): string[] {
  return alwaysCcAddress
    .split(/[,;\n]/)
    .map((address) => address.trim())
    .filter(Boolean);
}

/** The suggestions nobody has put on the email yet, in the server's order. */
export function availableSuggestions(
  suggestions: RecipientSuggestion[],
  fields: RecipientFields,
  alwaysCc: string[] = [],
): RecipientSuggestion[] {
  const taken = takenAddresses(fields, alwaysCc);
  const seen = new Set<string>();
  return suggestions.filter((suggestion) => {
    const key = recipientKey(suggestion.email);
    if (taken.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The suggestions that match what is being typed: a name or address that
 * starts with it first, then one with a word that starts with it, then any
 * that merely contain it, then a role that does — each group in the server's
 * order. Empty until something is typed.
 */
export function matchSuggestions(
  available: RecipientSuggestion[],
  query: string,
  limit = MATCHES_SHOWN,
): RecipientSuggestion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const scored: Array<{ suggestion: RecipientSuggestion; score: number; index: number }> = [];
  available.forEach((suggestion, index) => {
    const name = suggestion.name.toLowerCase();
    const email = suggestion.email.toLowerCase();
    const role = suggestion.role.toLowerCase();
    let score: number | null = null;
    if (name.startsWith(needle) || email.startsWith(needle)) score = 0;
    else if (
      wordsOf(name).some((word) => word.startsWith(needle)) ||
      wordsOf(email).some((word) => word.startsWith(needle))
    ) {
      score = 1;
    } else if (name.includes(needle) || email.includes(needle)) score = 2;
    else if (role.includes(needle)) score = 3;
    if (score !== null) scored.push({ suggestion, score, index });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(({ suggestion }) => suggestion);
}

function wordsOf(value: string): string[] {
  return value.split(/[\s@._\-+]+/).filter(Boolean);
}

/** The chip a suggestion becomes. */
export function suggestionRecipient(suggestion: RecipientSuggestion): Recipient {
  return { email: suggestion.email, name: suggestion.name, valid: true };
}

/** The suggestion's headline: the person's name, else the address. */
export function suggestionLabel(suggestion: RecipientSuggestion): string {
  return suggestion.name || suggestion.email;
}

/**
 * The quiet line beside the name: the role or title when there is one,
 * otherwise how the person is tied to the account.
 */
export function suggestionDetail(suggestion: RecipientSuggestion, domain: string | null): string {
  if (suggestion.role) return suggestion.role;
  if (suggestion.sources.includes("billing_email")) return "Billing email";
  if (suggestion.dealTitle) return `On ${suggestion.dealTitle}`;
  if (suggestion.sources.includes("customer_contact")) return "Billing contact";
  if (suggestion.sources.includes("revenue_contact")) return "Revenue contact";
  if (suggestion.sources.includes("domain") && domain) return `At ${domain}`;
  return "";
}

/** "Emailed Oct 2", with the year when it is not this one; "" when never. */
export function emailedLabel(lastEmailedAt: string | null, now: Date = new Date()): string {
  if (!lastEmailedAt) return "";
  const at = new Date(lastEmailedAt);
  if (Number.isNaN(at.getTime())) return "";
  const sameYear = at.getUTCFullYear() === now.getUTCFullYear();
  const day = at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
  return `Emailed ${day}`;
}

/** Up to two initials for the avatar. */
export function suggestionInitials(suggestion: RecipientSuggestion): string {
  const words = suggestion.name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return suggestion.email.slice(0, 2).toUpperCase();
}

/**
 * Valid recipients the Member typed who are none of the customer's people
 * yet, nor an Always Cc mailbox — the ones the dialog offers to save as the
 * customer's contacts, so they are suggested next time.
 */
export function unsavedRecipients(
  fields: RecipientFields,
  suggestions: RecipientSuggestion[],
  alwaysCc: string[] = [],
): Recipient[] {
  const known = new Set([
    ...suggestions.map((suggestion) => recipientKey(suggestion.email)),
    ...alwaysCc.map(recipientKey),
  ]);
  const seen = new Set<string>();
  return [...fields.to, ...fields.cc].filter((item) => {
    const key = recipientKey(item.email);
    if (!item.valid || known.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The name a saved contact gets: the one written with the address, else the
 * address's own words — `jane.doe@` becomes "Jane Doe" — else the address.
 */
export function contactNameFor(item: Recipient): string {
  if (item.name.trim()) return item.name.trim().slice(0, 120);
  const local = item.email.slice(0, item.email.indexOf("@")).split("+")[0];
  const words = local.split(/[._-]+/).filter((word) => /^[a-z]+$/i.test(word));
  if (words.length >= 2) {
    return words.map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase()).join(" ");
  }
  return item.email.slice(0, 120);
}
