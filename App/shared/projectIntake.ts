/**
 * A Project's intake: the words the server and the browser share for which email
 * becomes its Todos, who works them, and how far they may go
 * (`server/services/todoIntake.ts`).
 */

/** Whether an email-started session may send its replies, or a person sends them. */
export type IntakeReplyMode = "review" | "send";

export const INTAKE_WHAT_BELONGS_CHARS = 1_000;
export const INTAKE_INSTRUCTION_CHARS = 6_000;
export const INTAKE_MAX_TRUSTED_SENDERS = 50;

/**
 * One line of an intake's trusted senders: an exact address, or `@domain` for
 * everyone at exactly that domain. Nothing else, and no wildcards, because a
 * trusted sender's mail runs with the AI Employee's full tools.
 */
export function normalizeTrustedSender(line: string): string | null {
  const value = line.trim().toLowerCase();
  if (!value) return null;
  const domain = /^@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/;
  const address = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
  return domain.test(value) || address.test(value) ? value : null;
}

/** Split the text box into entries, naming any line that isn't one. */
export function parseTrustedSenders(text: string): { entries: string[]; invalid: string[] } {
  const entries = new Set<string>();
  const invalid: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const entry = normalizeTrustedSender(line);
    if (entry) entries.add(entry);
    else invalid.push(line.trim());
  }
  return { entries: [...entries], invalid };
}

/** Whether a verified sender address is on the list. */
export function isTrustedSender(entries: readonly string[], email: string): boolean {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at < 1) return false;
  const domain = address.slice(at);
  return entries.some((entry) => entry === address || entry === domain);
}

/** A Project's intake as a Member reads it. */
export type ProjectIntakeView = {
  enabled: boolean;
  whatBelongs: string;
  instruction: string;
  /** Which mailboxes it takes mail from; empty means all of them. */
  accountIds: string[];
  /** Null: the AI picks from who can work here. */
  assigneeEmployeeId: string | null;
  reviewerEmployeeId: string | null;
  reviewerUserId: string | null;
  replyMode: IntakeReplyMode;
  /** One per line. */
  trustedSenders: string;
  updatedAt: string | null;
};

/** What became of the email's chance to be filed, on its analysis row. */
export type MailIntakeOutcome = {
  status: "proposed" | "filed" | "skipped" | "failed";
  /** The reader's reason for filing it, in its own words. */
  reason: string;
  /** Why the server didn't file it, when it didn't. */
  detail?: string;
  todoId?: string;
  /** `{Project.key}-{Todo.number}`, once filed. */
  todoKey?: string;
  projectSlug?: string;
};
