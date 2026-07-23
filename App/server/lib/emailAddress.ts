/**
 * Email address normalization for the suppression list and the revenue
 * Contact index.
 *
 * Two rules drive every decision here, and both are about *not* being clever:
 *
 * 1. **Normalize presentation, never identity.** We lowercase and strip the
 *    display name, because `Foo <A@B.com>` and `a@b.com` are the same mailbox
 *    by any reading. We deliberately do **not** canonicalize Gmail dots
 *    (`f.o.o@gmail.com`) or plus-tags (`foo+sales@gmail.com`). Those are
 *    provider-specific routing conventions, not identity: applying them
 *    everywhere would make one unsubscribe silently suppress addresses the
 *    user never asked us to suppress, and there is no way for them to find
 *    out why their mail stopped going out. Over-matching a suppression list
 *    fails silent and unfixable; under-matching fails loud and correctable.
 *
 * 2. **Reject rather than repair.** A string we cannot confidently read as an
 *    address returns null and the caller decides. Guessing produces addresses
 *    that bounce, and bounces cost sending reputation.
 *
 * The validation is deliberately pragmatic rather than RFC 5322 complete —
 * that grammar admits quoted local parts and comments no mail provider we
 * send through would accept anyway.
 */

/**
 * Role addresses: shared mailboxes that belong to a function, not a person.
 * Mailing them is a common cause of spam complaints, and they are useless as
 * sales Contacts. We flag rather than block — plenty of small companies really
 * do sell to `sales@`, and silently dropping their mail would be worse than
 * letting them decide.
 */
const ROLE_LOCAL_PARTS = new Set([
  "abuse",
  "admin",
  "administrator",
  "all",
  "billing",
  "compliance",
  "contact",
  "devnull",
  "everyone",
  "help",
  "hostmaster",
  "info",
  "legal",
  "mail",
  "mailer-daemon",
  "marketing",
  "no-reply",
  "noc",
  "noreply",
  "postmaster",
  "privacy",
  "root",
  "sales",
  "security",
  "spam",
  "support",
  "sysadmin",
  "team",
  "webmaster",
]);

/**
 * Local part: no whitespace, no angle brackets, no commas or semicolons (which
 * would mean we split a recipient list wrong), at least one character.
 * Domain: labels separated by dots, at least one dot, no leading/trailing
 * hyphen on a label, TLD of two or more letters.
 */
const ADDRESS_RE =
  /^[^\s<>(),;:\\"[\]@]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Pull the address out of a header value and lowercase it.
 *
 * Accepts `a@b.com`, `<a@b.com>`, `Foo Bar <a@b.com>`, and `"Bar, Foo"
 * <a@b.com>`. Returns null for anything else — including a value carrying more
 * than one address, because picking one of them would be a guess.
 */
export function normalizeEmail(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value) return null;

  // `Display Name <addr>` — take the last bracketed group, since a display
  // name may itself contain brackets.
  const open = value.lastIndexOf("<");
  const close = value.lastIndexOf(">");
  if (open !== -1 && close > open) {
    value = value.slice(open + 1, close).trim();
  } else if (open !== -1 || close !== -1) {
    // An unbalanced bracket means we are reading something we do not
    // understand. Refuse rather than repair.
    return null;
  }

  value = value.toLowerCase();
  if (!ADDRESS_RE.test(value)) return null;

  // A local part may not start or end with a dot, nor contain two in a row.
  const [local] = value.split("@");
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return null;
  }
  return value;
}

/** The domain half of an address, or null if it does not parse. */
export function emailDomain(input: string | null | undefined): string | null {
  const normalized = normalizeEmail(input);
  if (!normalized) return null;
  return normalized.slice(normalized.indexOf("@") + 1);
}

/**
 * True for shared-function mailboxes. Callers warn; they must not silently
 * drop — see the note on ROLE_LOCAL_PARTS.
 */
export function isRoleAddress(input: string | null | undefined): boolean {
  const normalized = normalizeEmail(input);
  if (!normalized) return false;
  return ROLE_LOCAL_PARTS.has(normalized.slice(0, normalized.indexOf("@")));
}

/**
 * Split a header value that may carry several comma-separated recipients.
 *
 * Commas inside a quoted display name (`"Bar, Foo" <a@b.com>`) do not
 * separate recipients, which is why this is a small state machine rather
 * than `value.split(",")`. Unparseable entries are reported separately so a
 * caller can surface them instead of quietly mailing fewer people than the
 * user typed.
 */
export function parseAddressList(input: string | null | undefined): {
  addresses: string[];
  invalid: string[];
} {
  const addresses: string[] = [];
  const invalid: string[] = [];
  if (typeof input !== "string" || !input.trim()) return { addresses, invalid };

  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngles = false;
  for (const char of input) {
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "<") inAngles = true;
    if (char === ">") inAngles = false;
    if ((char === "," || char === ";") && !inQuotes && !inAngles) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);

  const seen = new Set<string>();
  for (const part of parts) {
    if (!part.trim()) continue;
    const normalized = normalizeEmail(part);
    if (!normalized) {
      invalid.push(part.trim());
      continue;
    }
    // De-duplicate: mailing the same person twice in one send is a bug the
    // recipient sees.
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    addresses.push(normalized);
  }
  return { addresses, invalid };
}
