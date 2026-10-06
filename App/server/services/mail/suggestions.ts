/**
 * One-click next steps an AI Employee staged with `suggest_mail_actions`.
 *
 * The tool validates each suggestion against the mailbox and stages it as a
 * sidecar on the turn's MCP token; Ask AI drains them onto the employee's
 * reply, where the Member runs each one with their own authority. This module
 * is only the stored shape and its tolerant parser.
 */
export type MailSuggestionRecord = {
  id: string;
  kind: string;
  label: string;
  executedAt?: string;
  [key: string]: unknown;
};

export function parseSuggestions(raw: string | null | undefined): MailSuggestionRecord[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (x): x is MailSuggestionRecord =>
        !!x &&
        typeof x === "object" &&
        typeof (x as MailSuggestionRecord).id === "string" &&
        typeof (x as MailSuggestionRecord).kind === "string" &&
        typeof (x as MailSuggestionRecord).label === "string",
    );
  } catch {
    return [];
  }
}
