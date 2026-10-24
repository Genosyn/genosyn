/**
 * The closed line of the Server settings disclosure when connecting a mailbox
 * with a password: the incoming and outgoing servers Genosyn worked out from
 * the address, and the login name when it is not the address itself. The
 * fields stay collapsed because they are usually right, and the line shows
 * them so a wrong guess is visible without opening anything (AGENTS.md §8).
 *
 *   → "imap.fastmail.com:993 · smtp.fastmail.com:465"
 */
export function describeMailServers(values: {
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  username: string;
  /** The address being connected; a login name equal to it is not repeated. */
  email: string;
}): string {
  const server = (host: string, port: string, missing: string) => {
    const name = host.trim();
    if (!name) return missing;
    return port.trim() ? `${name}:${port.trim()}` : name;
  };
  const parts = [
    server(values.imapHost, values.imapPort, "No IMAP server"),
    server(values.smtpHost, values.smtpPort, "No SMTP server"),
  ];
  const login = values.username.trim();
  if (login && login.toLowerCase() !== values.email.trim().toLowerCase()) {
    parts.push(`login ${login}`);
  }
  return parts.join(" · ");
}
