/**
 * Reading what a Member types or pastes into a To or Cc field as recipients,
 * one chip each.
 *
 * People paste from everywhere, so this takes every list shape they bring:
 * commas, semicolons (Outlook) and new lines (a spreadsheet column) between
 * recipients; `Name <addr>` and `"Doe, Jane" <addr>` the way mail clients
 * copy them; a name typed before a bare address; a `mailto:` link; several
 * bare addresses separated only by spaces. Whatever it cannot read as an
 * address is kept as written and marked invalid, so the Member sees exactly
 * what will not be sent and can fix it, instead of the email quietly going to
 * fewer people than they typed.
 *
 * An address is valid when the send endpoint will take it: `isSendableAddress`
 * is the same check, zod's `.email()`, that the server applies to every To and
 * Cc. Nothing is lowercased or otherwise rewritten — the server compares
 * addresses case-insensitively and sends them as given.
 */

export type Recipient = {
  /** The address to send to, or — when `valid` is false — the entry as written. */
  email: string;
  /** The display name, when one was written or a suggestion supplied it. */
  name: string;
  valid: boolean;
};

/** The send endpoint's per-field ceiling, and its per-address one. */
export const MAX_RECIPIENTS_PER_FIELD = 25;
export const MAX_ADDRESS_LENGTH = 320;

/**
 * zod 3's `.email()` pattern, which `documentSendSchema` applies to every To
 * and Cc address. Keep the two the same: an address the chip calls valid must
 * never be the reason the send is refused.
 */
const SENDABLE_ADDRESS =
  /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9-]*\.)+[A-Z]{2,}$/i;

export function isSendableAddress(address: string): boolean {
  const value = address.trim();
  return value.length > 0 && value.length <= MAX_ADDRESS_LENGTH && SENDABLE_ADDRESS.test(value);
}

/** How two recipients are compared: addresses are case-insensitive. */
export function recipientKey(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Split on the separators between recipients: commas and semicolons outside a
 * quoted name or an `<address>`, and every line break. A quote that never
 * closes swallows the commas after it rather than guessing where the name
 * ended — but never a line break, so one bad line of a pasted column spoils
 * only itself.
 */
export function splitRecipientText(text: string): string[] {
  const { entries, rest } = splitKeepingRest(text);
  return [...entries, rest].map((entry) => entry.trim()).filter(Boolean);
}

function splitKeepingRest(text: string): { entries: string[]; rest: string } {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") {
      entries.push(current);
      current = "";
      quoted = false;
      angled = false;
      continue;
    }
    if (quoted && char === "\\" && index + 1 < text.length) {
      current += char + text[index + 1];
      index += 1;
      continue;
    }
    if ((char === "," || char === ";") && !quoted && !angled) {
      entries.push(current);
      current = "";
      continue;
    }
    if (char === '"' && !angled) quoted = !quoted;
    else if (char === "<" && !quoted) angled = true;
    else if (char === ">" && !quoted) angled = false;
    current += char;
  }
  return { entries, rest: current };
}

/** `"Doe, Jane"` → `Doe, Jane`; `\"` inside the quotes is a quote. */
function unquote(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1").trim();
  }
  return trimmed.replace(/^'(.*)'$/, "$1").trim();
}

/** An address as it may arrive inside prose: wrapped, linked, or followed by a full stop. */
function bareAddress(word: string): string {
  return word
    .trim()
    .replace(/^mailto:/i, "")
    .replace(/^[<("'[]+/, "")
    .replace(/[>)"'\].,]+$/, "")
    .trim();
}

function recipient(email: string, name = ""): Recipient {
  return { email, name, valid: isSendableAddress(email) };
}

function invalid(entry: string): Recipient {
  return { email: entry.trim(), name: "", valid: false };
}

/**
 * One entry between separators, read as the recipient(s) it names. Usually
 * one; several when bare addresses were separated only by spaces.
 */
export function parseRecipientEntry(entry: string): Recipient[] {
  const value = entry.trim();
  if (!value) return [];

  // `Name <address>`: the last bracketed group, since a name may hold brackets.
  const open = value.lastIndexOf("<");
  const close = value.lastIndexOf(">");
  if (open !== -1 && close > open && value.slice(close + 1).trim() === "") {
    const address = bareAddress(value.slice(open + 1, close));
    const name = unquote(value.slice(0, open));
    if (!address) return [invalid(value)];
    const parsed = recipient(address, name);
    return [parsed.valid ? parsed : invalid(value)];
  }
  if (open !== -1 || close !== -1) return [invalid(value)];

  const words = value.split(/\s+/).filter(Boolean);
  const addresses = words.filter((word) => word.includes("@"));
  if (addresses.length === 0) return [invalid(value)];
  if (addresses.length === 1) {
    // `Jane Doe jane@x.com`, or the old `jane@x.com (Jane Doe)`.
    const name = unquote(
      words
        .filter((word) => word !== addresses[0])
        .join(" ")
        .replace(/^\(|\)$/g, ""),
    );
    const parsed = recipient(bareAddress(addresses[0]), name);
    return [parsed.valid ? parsed : invalid(value)];
  }
  // Several addresses with nothing but spaces between them, as pasted from prose.
  return addresses.map((word) => {
    const parsed = recipient(bareAddress(word));
    return parsed.valid ? parsed : invalid(word);
  });
}

/** Everything in `text`, in order, each address once. */
export function parseRecipients(text: string): Recipient[] {
  return dedupeRecipients(splitRecipientText(text).flatMap(parseRecipientEntry));
}

/**
 * What typing has finished. Everything before the last separator becomes
 * recipients and the rest stays in the box to keep typing — as does a
 * complete address followed by a space, so `a@x.com b@x.com` typed with
 * spaces becomes two chips as it is written.
 */
export function takeTypedRecipients(text: string): { recipients: Recipient[]; rest: string } {
  const { entries, rest } = splitKeepingRest(text);
  const recipients = entries.flatMap(parseRecipientEntry);
  const last = rest.trim();
  // A space after something finished: a bare address, or `Name <address>`.
  const finished =
    /\s$/.test(rest) &&
    ((!/\s/.test(last) && !/[<>]/.test(last) && isSendableAddress(bareAddress(last))) ||
      /^[^<>]*<[^<>]+>$/.test(last));
  if (finished) {
    const parsed = parseRecipientEntry(last);
    if (parsed.length === 1 && parsed[0].valid) {
      return { recipients: dedupeRecipients([...recipients, ...parsed]), rest: "" };
    }
  }
  return { recipients: dedupeRecipients(recipients), rest };
}

/** The first of each address, compared case-insensitively; a later name fills a missing one. */
export function dedupeRecipients(recipients: Recipient[]): Recipient[] {
  const byKey = new Map<string, Recipient>();
  for (const item of recipients) {
    const key = recipientKey(item.email);
    if (!key) continue;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { ...item });
    else if (!seen.name && item.name) seen.name = item.name;
  }
  return [...byKey.values()];
}

export type RecipientField = "to" | "cc";
export type RecipientFields = { to: Recipient[]; cc: Recipient[] };

/**
 * Add recipients to one field. Nobody is on an email twice: someone already
 * on the To line is not copied as well, and adding someone to To who was on
 * the Cc line moves them up.
 */
export function addRecipients(
  fields: RecipientFields,
  field: RecipientField,
  incoming: Recipient[],
): RecipientFields {
  const adding = dedupeRecipients(incoming);
  if (field === "to") {
    const onTo = new Set(fields.to.map((item) => recipientKey(item.email)));
    const fresh = adding.filter((item) => !onTo.has(recipientKey(item.email)));
    const moving = new Set(fresh.map((item) => recipientKey(item.email)));
    return {
      to: [...fields.to, ...fresh],
      cc: fields.cc.filter((item) => !moving.has(recipientKey(item.email))),
    };
  }
  const taken = new Set([...fields.to, ...fields.cc].map((item) => recipientKey(item.email)));
  return {
    to: fields.to,
    cc: [...fields.cc, ...adding.filter((item) => !taken.has(recipientKey(item.email)))],
  };
}

export function removeRecipient(
  fields: RecipientFields,
  field: RecipientField,
  email: string,
): RecipientFields {
  const key = recipientKey(email);
  return { ...fields, [field]: fields[field].filter((item) => recipientKey(item.email) !== key) };
}

/** Everyone already on the email, Always Cc included, by `recipientKey`. */
export function takenAddresses(fields: RecipientFields, alwaysCc: string[] = []): Set<string> {
  return new Set(
    [...fields.to, ...fields.cc]
      .map((item) => recipientKey(item.email))
      .concat(alwaysCc.map(recipientKey)),
  );
}

/** What a chip shows. */
export function recipientLabel(item: Recipient): string {
  return item.name || item.email;
}

/** What a chip says on hover, and what a screen reader hears. */
export function formatRecipient(item: Recipient): string {
  if (!item.valid) return `${item.email} (not a valid email address)`;
  return item.name ? `${item.name} <${item.email}>` : item.email;
}

/**
 * Why the email cannot go yet, in words that say what to fix — or null when
 * it can. Checked again by the server; this is only so the Member hears it
 * where they are looking.
 */
export function recipientProblem(fields: RecipientFields): string | null {
  const invalidOnes = [...fields.to, ...fields.cc].filter((item) => !item.valid);
  if (invalidOnes.length === 1) {
    return `“${invalidOnes[0].email}” isn’t a valid email address. Fix or remove it.`;
  }
  if (invalidOnes.length > 1) {
    return `${invalidOnes.length} entries aren’t valid email addresses. Fix or remove them.`;
  }
  if (fields.to.length === 0) return "Add at least one To recipient.";
  for (const field of ["to", "cc"] as const) {
    if (fields[field].length > MAX_RECIPIENTS_PER_FIELD) {
      return `${field === "to" ? "To" : "Cc"} can hold at most ${MAX_RECIPIENTS_PER_FIELD} addresses.`;
    }
  }
  return null;
}

/** The addresses the send endpoint receives for one field. */
export function recipientAddresses(items: Recipient[]): string[] {
  return items.filter((item) => item.valid).map((item) => item.email.trim());
}

/**
 * A chip put back into the box to fix: as it was written when it is not an
 * address, else `Name <address>` — quoting a name that holds a separator, so
 * reading it back gives the same chip.
 */
export function editableRecipient(item: Recipient): string {
  if (!item.valid || !item.name) return item.email;
  const name = /[",;<>]/.test(item.name) ? `"${item.name.replace(/(["\\])/g, "\\$1")}"` : item.name;
  return `${name} <${item.email}>`;
}
