/**
 * Recipient-domain allowlist for AI-initiated invoice email.
 *
 * The human "Send" button is driven by a person who confirms the exact
 * recipients in a modal, so it may address anyone. The MCP `send_invoice`
 * tool is driven by an AI employee whose context is full of
 * attacker-controlled text — invoice memos, vendor names, bank
 * descriptors, inbound mail bodies. A prompt injection through any of
 * those must not be able to turn the tool into an exfiltration channel
 * that mails company documents (plus free-text) to an arbitrary address.
 *
 * So an AI-supplied recipient list is constrained to trusted domains: the
 * customer's own email domain, plus the domains an owner/admin already
 * curated as the company's always-Cc finance mailboxes. Neither is a
 * freely AI-invented external address.
 */

/** Lowercased domain part of an email address, or null if malformed. */
export function emailDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return null;
  const domain = address.slice(at + 1).trim().toLowerCase();
  // A bare "@" or an address whose local part contains an unquoted "@"
  // would slip through a naive split; require the domain to look like a
  // domain (at least one dot, no whitespace, no stray "@").
  if (!domain || domain.includes("@") || /\s/.test(domain) || !domain.includes(".")) {
    return null;
  }
  return domain;
}

/** Build the set of trusted recipient domains from curated sources. */
export function trustedRecipientDomains(sources: {
  customerEmail?: string | null;
  ccEmails?: string[];
}): Set<string> {
  const domains = new Set<string>();
  const add = (addr: string | null | undefined) => {
    const d = addr ? emailDomain(addr.trim()) : null;
    if (d) domains.add(d);
  };
  add(sources.customerEmail);
  for (const cc of sources.ccEmails ?? []) add(cc);
  return domains;
}

/**
 * Return the subset of `addresses` whose domain is NOT trusted. A
 * malformed address counts as disallowed (fail closed). An empty result
 * means every address is allowed.
 */
export function disallowedRecipients(addresses: string[], trusted: Set<string>): string[] {
  const out: string[] = [];
  for (const raw of addresses) {
    const address = raw.trim();
    const domain = emailDomain(address);
    if (!domain || !trusted.has(domain)) out.push(address);
  }
  return out;
}
