import { dedupeRecipients, parseRecipients, type Recipient, recipientKey } from "./recipientTokens";

/**
 * Who an email goes to, as the composer edits it: To, Cc and Bcc as chips.
 *
 * `recipientTokens.ts` reads what a Member types into one field; this is the
 * three fields together. One rule holds them: nobody is on an email twice.
 * Adding someone to a field takes them off whichever other field they were on,
 * so "move Dana to Bcc" is done by adding Dana to Bcc — the latest place the
 * Member put a person is where they are.
 *
 * Header strings go out with names (`Felix Menzel <felix@acme.test>`): the
 * server's MIME builder encodes them, and the person reading the email sees
 * the names they recognise.
 */

export type MailRecipientField = "to" | "cc" | "bcc";
export type MailRecipients = Record<MailRecipientField, Recipient[]>;

export const MAIL_RECIPIENT_FIELDS: MailRecipientField[] = ["to", "cc", "bcc"];

/** The compose endpoint's per-field character ceiling. */
export const MAX_MAIL_HEADER_CHARS = 2000;

export const MAIL_FIELD_LABELS: Record<MailRecipientField, string> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
};

export function emptyMailRecipients(): MailRecipients {
  return { to: [], cc: [], bcc: [] };
}

/**
 * Read header strings into chips. A person on two lines keeps the first —
 * To before Cc before Bcc — and `exclude` (the mailbox's own address) is left
 * off, since a reply never needs to copy the sender to itself.
 */
export function mailRecipientsFrom(
  headers: { to?: string | null; cc?: string | null; bcc?: string | null },
  exclude: string[] = [],
): MailRecipients {
  const skip = new Set(exclude.map(recipientKey).filter(Boolean));
  const result = emptyMailRecipients();
  for (const field of MAIL_RECIPIENT_FIELDS) {
    for (const item of parseRecipients(headers[field] ?? "")) {
      const key = recipientKey(item.email);
      if (!key || skip.has(key)) continue;
      skip.add(key);
      result[field].push(item);
    }
  }
  return result;
}

/** Add people to one field, taking them off the other two. */
export function addMailRecipients(
  fields: MailRecipients,
  field: MailRecipientField,
  incoming: Recipient[],
): MailRecipients {
  const adding = dedupeRecipients(incoming);
  const keys = new Set(adding.map((item) => recipientKey(item.email)));
  const next = emptyMailRecipients();
  for (const other of MAIL_RECIPIENT_FIELDS) {
    next[other] =
      other === field
        ? fields[other].slice()
        : fields[other].filter((item) => !keys.has(recipientKey(item.email)));
  }
  const present = new Set(next[field].map((item) => recipientKey(item.email)));
  for (const item of adding) {
    const key = recipientKey(item.email);
    if (present.has(key)) {
      // Already here: a name written now fills one that was missing.
      const existing = next[field].find((chip) => recipientKey(chip.email) === key);
      if (existing && !existing.name && item.name) {
        next[field] = next[field].map((chip) =>
          chip === existing ? { ...chip, name: item.name } : chip,
        );
      }
      continue;
    }
    present.add(key);
    next[field].push(item);
  }
  return next;
}

export function removeMailRecipient(
  fields: MailRecipients,
  field: MailRecipientField,
  email: string,
): MailRecipients {
  const key = recipientKey(email);
  return { ...fields, [field]: fields[field].filter((item) => recipientKey(item.email) !== key) };
}

/** Take one person off every field — the "Remove" beside a do-not-email warning. */
export function removeEverywhere(fields: MailRecipients, email: string): MailRecipients {
  const key = recipientKey(email);
  const next = emptyMailRecipients();
  for (const field of MAIL_RECIPIENT_FIELDS) {
    next[field] = fields[field].filter((item) => recipientKey(item.email) !== key);
  }
  return next;
}

export function allMailRecipients(fields: MailRecipients): Recipient[] {
  return [...fields.to, ...fields.cc, ...fields.bcc];
}

/** One recipient as a header entry: `Name <address>`, quoting a name that needs it. */
export function headerEntry(item: Recipient): string {
  const email = item.email.trim();
  const name = item.name.trim();
  if (!name || name.toLowerCase() === email.toLowerCase()) return email;
  const quoted = /[",;<>()@:\\[\]]/.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : name;
  return `${quoted} <${email}>`;
}

/**
 * A field as the compose endpoint takes it. Invalid chips are not sent — the
 * composer refuses to send while any are showing. A list too long for the
 * header with names falls back to bare addresses rather than being refused.
 */
export function mailHeader(items: Recipient[]): string {
  const valid = items.filter((item) => item.valid);
  const withNames = valid.map(headerEntry).join(", ");
  if (withNames.length <= MAX_MAIL_HEADER_CHARS) return withNames;
  return valid.map((item) => item.email.trim()).join(", ");
}

export function mailHeaders(fields: MailRecipients): { to: string; cc: string; bcc: string } {
  return { to: mailHeader(fields.to), cc: mailHeader(fields.cc), bcc: mailHeader(fields.bcc) };
}

/**
 * Why the email cannot go yet, in words that say what to fix — or null.
 * The server checks again; this is so the Member hears it where they look.
 */
export function mailRecipientProblem(
  fields: MailRecipients,
  { requireTo = true }: { requireTo?: boolean } = {},
): string | null {
  const invalid = allMailRecipients(fields).filter((item) => !item.valid);
  if (invalid.length === 1) {
    return `“${invalid[0].email}” isn’t a valid email address. Fix or remove it.`;
  }
  if (invalid.length > 1) {
    return `${invalid.length} entries aren’t valid email addresses. Fix or remove them.`;
  }
  if (requireTo && fields.to.length === 0) {
    return fields.cc.length + fields.bcc.length > 0
      ? "Put at least one person on the To line."
      : "Add at least one recipient.";
  }
  for (const field of MAIL_RECIPIENT_FIELDS) {
    if (mailHeader(fields[field]).length > MAX_MAIL_HEADER_CHARS) {
      return `The ${MAIL_FIELD_LABELS[field]} line is too long. Remove some recipients.`;
    }
  }
  return null;
}

/** A person's short name for a one-line summary: first name, else the address. */
function shortName(item: Recipient): string {
  const name = item.name.trim();
  if (name) return name.split(/\s+/)[0];
  return item.email;
}

/**
 * "Felix, Dana · cc support@oneuptime.com · bcc 2" — who a reply goes to, on
 * the one line a closed composer has room for.
 */
export function mailRecipientsSummary(fields: MailRecipients): string {
  const parts: string[] = [];
  if (fields.to.length > 0) parts.push(fields.to.map(shortName).join(", "));
  if (fields.cc.length > 0) parts.push(`cc ${fields.cc.map(shortName).join(", ")}`);
  if (fields.bcc.length > 0) {
    parts.push(
      fields.bcc.length === 1 ? `bcc ${shortName(fields.bcc[0])}` : `bcc ${fields.bcc.length}`,
    );
  }
  return parts.join(" · ");
}

/** Whether two recipient sets would send the same email. */
export function sameMailRecipients(a: MailRecipients, b: MailRecipients): boolean {
  return MAIL_RECIPIENT_FIELDS.every(
    (field) =>
      a[field].length === b[field].length &&
      a[field].every(
        (item, index) => recipientKey(item.email) === recipientKey(b[field][index].email),
      ),
  );
}

/**
 * Every person who has written on or been copied on a thread, newest first —
 * the first suggestions a reply offers, before the mailbox's address book.
 */
export function threadParticipants(
  messages: Array<{ fromName: string; fromEmail: string; toEmails: string; ccEmails: string }>,
  exclude: string[] = [],
): Recipient[] {
  const skip = new Set(exclude.map(recipientKey));
  const seen = new Map<string, Recipient>();
  for (const message of [...messages].reverse()) {
    const people = [
      { email: message.fromEmail, name: message.fromName, valid: true },
      ...parseRecipients(message.toEmails),
      ...parseRecipients(message.ccEmails),
    ];
    for (const person of people) {
      const key = recipientKey(person.email);
      if (!key || !person.valid || skip.has(key)) continue;
      const known = seen.get(key);
      if (!known) seen.set(key, { ...person, name: person.name.trim() });
      else if (!known.name && person.name.trim()) known.name = person.name.trim();
    }
  }
  return [...seen.values()];
}
