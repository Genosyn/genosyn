import { SelectQueryBuilder } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailThread } from "../../db/entities/MailThread.js";

/**
 * The one mail-search grammar, shared by the human thread list and the
 * `search_mail` tool so "search" means the same thing everywhere.
 *
 * A query is free-text terms (AND-ed; each term may match any indexed
 * field) plus Gmail-style operators:
 *
 *   from:ada            sender address or name contains "ada"
 *   to:billing          recipient (To/Cc) contains "billing"
 *   subject:invoice     subject contains "invoice"
 *   label:Support       has the label (user label name or Gmail id)
 *   in:archive          scope: inbox|starred|sent|drafts|all|archive|spam|trash
 *   has:attachment      at least one file
 *   is:unread / is:read / is:starred
 *   before:2026-01-31 / after:2026-01-01   (on the thread's last message)
 *   "quoted phrase"     exact-substring term, spaces preserved
 *
 * Operator values can be quoted too (label:"Team Updates"). Anything that
 * doesn't parse as an operator is just a term — a query can never error.
 */

export type MailSearchScope =
  | "inbox"
  | "starred"
  | "sent"
  | "drafts"
  | "all"
  | "archive"
  | "spam"
  | "trash";

export type ParsedMailQuery = {
  /** Lowercased free-text terms (including quoted phrases), AND semantics. */
  terms: string[];
  from?: string;
  to?: string;
  subject?: string;
  /** Raw label reference — resolve with {@link resolveSearchLabelId}. */
  label?: string;
  scope?: MailSearchScope;
  hasAttachment?: boolean;
  isUnread?: boolean;
  isStarred?: boolean;
  before?: Date;
  after?: Date;
};

const SCOPES: MailSearchScope[] = [
  "inbox",
  "starred",
  "sent",
  "drafts",
  "all",
  "archive",
  "spam",
  "trash",
];

/** `"quoted value"` or a bare token — the shared value shapes. */
const TOKEN_RE = /(?:([a-zA-Z]+):)?(?:"([^"]*)"|(\S+))/g;

export function parseMailQuery(raw: string): ParsedMailQuery {
  const parsed: ParsedMailQuery = { terms: [] };
  for (const match of raw.matchAll(TOKEN_RE)) {
    const op = match[1]?.toLowerCase();
    const value = (match[2] ?? match[3] ?? "").trim();
    if (!op) {
      if (value) parsed.terms.push(value.toLowerCase());
      continue;
    }
    switch (op) {
      case "from":
        if (value) parsed.from = value.toLowerCase();
        break;
      case "to":
        if (value) parsed.to = value.toLowerCase();
        break;
      case "subject":
        if (value) parsed.subject = value.toLowerCase();
        break;
      case "label":
        if (value) parsed.label = value;
        break;
      case "in":
        if (SCOPES.includes(value.toLowerCase() as MailSearchScope)) {
          parsed.scope = value.toLowerCase() as MailSearchScope;
        } else if (value) {
          // `in:something-else` reads like a label hunt; treat it as one.
          parsed.label = value;
        }
        break;
      case "has":
        if (value.toLowerCase() === "attachment") parsed.hasAttachment = true;
        else parsed.terms.push(`${op}:${value}`.toLowerCase());
        break;
      case "is":
        switch (value.toLowerCase()) {
          case "unread":
            parsed.isUnread = true;
            break;
          case "read":
            parsed.isUnread = false;
            break;
          case "starred":
            parsed.isStarred = true;
            break;
          default:
            parsed.terms.push(`${op}:${value}`.toLowerCase());
        }
        break;
      case "before":
      case "after": {
        const d = new Date(value.replace(/\//g, "-"));
        if (!Number.isNaN(d.getTime())) {
          if (op === "before") parsed.before = d;
          else parsed.after = d;
        } else {
          parsed.terms.push(`${op}:${value}`.toLowerCase());
        }
        break;
      }
      default:
        // Unknown operator — keep the whole token as a literal term so
        // "re: budget" or a URL still searches as typed.
        parsed.terms.push(`${op}:${value}`.toLowerCase());
    }
  }
  return parsed;
}

/** Does the parsed query actually constrain anything? */
export function isEmptyQuery(p: ParsedMailQuery): boolean {
  return (
    p.terms.length === 0 &&
    !p.from &&
    !p.to &&
    !p.subject &&
    !p.label &&
    !p.scope &&
    p.hasAttachment === undefined &&
    p.isUnread === undefined &&
    p.isStarred === undefined &&
    !p.before &&
    !p.after
  );
}

/**
 * Resolve a `label:` reference the way the rest of mail does: a Gmail label
 * id verbatim (INBOX, Label_23, …) or a label name, case-insensitively.
 * Returns null when nothing matches — callers decide whether that means
 * "no results" (human search) or "friendly note" (agent tool).
 */
export async function resolveSearchLabelId(
  accountId: string,
  ref: string,
): Promise<string | null> {
  // Gmail's built-in labels exist on every mailbox whether or not a label
  // sync has mirrored them yet — accept them in any case spelling.
  const SYSTEM = [
    "INBOX",
    "STARRED",
    "SENT",
    "DRAFT",
    "SPAM",
    "TRASH",
    "UNREAD",
    "IMPORTANT",
  ];
  if (SYSTEM.includes(ref.toUpperCase())) return ref.toUpperCase();
  const labels = await AppDataSource.getRepository(MailLabel).find({
    where: { accountId },
  });
  const hit =
    labels.find((l) => l.gmailLabelId === ref) ??
    labels.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  return hit ? hit.gmailLabelId : null;
}

/**
 * The scope a query actually runs under. Defaults to `all` (which excludes
 * spam and trash) — but `label:SPAM` / `label:TRASH` must imply the matching
 * scope, mirroring Gmail's `label:spam ≡ in:spam`, or the default scope's
 * NOT-LIKE would contradict the label filter and match nothing.
 */
export function effectiveScope(
  parsed: ParsedMailQuery,
  labelId: string | null | undefined,
): MailSearchScope {
  if (parsed.scope) return parsed.scope;
  if (labelId === "SPAM") return "spam";
  if (labelId === "TRASH") return "trash";
  return "all";
}

/**
 * Constrain a MailThread query builder (alias `t`) to one folder scope,
 * using the space-sentinel labelIds encoding. `archive` is everything that
 * left the inbox but isn't spam/trash/a draft.
 */
export function applyMailScope(
  qb: SelectQueryBuilder<MailThread>,
  scope: MailSearchScope,
): SelectQueryBuilder<MailThread> {
  const has = (id: string, alias: string) =>
    qb.andWhere(`t.labelIds LIKE :${alias}`, { [alias]: `% ${id} %` });
  const not = (id: string, alias: string) =>
    qb.andWhere(`t.labelIds NOT LIKE :${alias}`, { [alias]: `% ${id} %` });
  switch (scope) {
    case "inbox":
      qb = has("INBOX", "scopeInbox");
      qb = not("TRASH", "scopeTrash");
      break;
    case "starred":
      qb = has("STARRED", "scopeStar");
      qb = not("TRASH", "scopeTrash");
      break;
    case "sent":
      qb = has("SENT", "scopeSent");
      qb = not("TRASH", "scopeTrash");
      break;
    case "drafts":
      qb = has("DRAFT", "scopeDraft");
      qb = not("TRASH", "scopeTrash");
      break;
    case "spam":
      qb = has("SPAM", "scopeSpam");
      break;
    case "trash":
      qb = has("TRASH", "scopeTrash");
      break;
    case "archive":
      qb = not("INBOX", "scopeNoInbox");
      qb = not("TRASH", "scopeTrash");
      qb = not("SPAM", "scopeSpam");
      qb = not("DRAFT", "scopeNoDraft");
      break;
    case "all":
      qb = not("TRASH", "scopeTrash");
      qb = not("SPAM", "scopeSpam");
      break;
  }
  return qb;
}

/**
 * Apply the parsed query's field filters to a MailThread query builder
 * (alias `t`). Scope (`in:` / view) is left to the caller — the two
 * surfaces default it differently. `labelId` is the already-resolved
 * `label:` reference; pass `null` for "referenced label doesn't exist",
 * which matches nothing (better than silently ignoring the filter).
 */
export function applyMailSearchFilters(
  qb: SelectQueryBuilder<MailThread>,
  parsed: ParsedMailQuery,
  labelId: string | null | undefined,
): SelectQueryBuilder<MailThread> {
  // User-supplied values must not smuggle LIKE metacharacters — a bare `%`
  // term would otherwise match everything. Escaped with `\` and each clause
  // declares ESCAPE '\' (supported by sqlite and postgres alike). The label
  // sentinels below stay raw: those are trusted Gmail label ids.
  const escapeLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");
  parsed.terms.forEach((term, i) => {
    const p = `term${i}`;
    qb = qb.andWhere(
      `(LOWER(t.subject) LIKE :${p} ESCAPE '\\' OR LOWER(t.snippet) LIKE :${p} ESCAPE '\\' OR LOWER(t.participants) LIKE :${p} ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM mail_messages m WHERE m.threadId = t.id
                   AND (LOWER(m.bodyText) LIKE :${p} ESCAPE '\\' OR LOWER(m.fromEmail) LIKE :${p} ESCAPE '\\'
                        OR LOWER(m.fromName) LIKE :${p} ESCAPE '\\' OR LOWER(m.toEmails) LIKE :${p} ESCAPE '\\')))`,
      { [p]: `%${escapeLike(term)}%` },
    );
  });
  if (parsed.from) {
    qb = qb.andWhere(
      `EXISTS (SELECT 1 FROM mail_messages m WHERE m.threadId = t.id
               AND (LOWER(m.fromEmail) LIKE :sqFrom ESCAPE '\\' OR LOWER(m.fromName) LIKE :sqFrom ESCAPE '\\'))`,
      { sqFrom: `%${escapeLike(parsed.from)}%` },
    );
  }
  if (parsed.to) {
    qb = qb.andWhere(
      `EXISTS (SELECT 1 FROM mail_messages m WHERE m.threadId = t.id
               AND (LOWER(m.toEmails) LIKE :sqTo ESCAPE '\\' OR LOWER(m.ccEmails) LIKE :sqTo ESCAPE '\\'))`,
      { sqTo: `%${escapeLike(parsed.to)}%` },
    );
  }
  if (parsed.subject) {
    qb = qb.andWhere("LOWER(t.subject) LIKE :sqSubject ESCAPE '\\'", {
      sqSubject: `%${escapeLike(parsed.subject)}%`,
    });
  }
  if (parsed.label !== undefined) {
    if (labelId) {
      qb = qb.andWhere("t.labelIds LIKE :sqLabel", { sqLabel: `% ${labelId} %` });
    } else {
      // Unknown label — match nothing rather than everything.
      qb = qb.andWhere("1 = 0");
    }
  }
  if (parsed.hasAttachment) {
    qb = qb.andWhere("t.hasAttachments = :sqHasAtt", { sqHasAtt: true });
  }
  if (parsed.isUnread !== undefined) {
    qb = qb.andWhere("t.unread = :sqUnread", { sqUnread: parsed.isUnread });
  }
  if (parsed.isStarred) {
    qb = qb.andWhere("t.labelIds LIKE :sqStar", { sqStar: "% STARRED %" });
  }
  if (parsed.after) {
    qb = qb.andWhere("t.lastMessageAt >= :sqAfter", { sqAfter: parsed.after });
  }
  if (parsed.before) {
    qb = qb.andWhere("t.lastMessageAt < :sqBefore", { sqBefore: parsed.before });
  }
  return qb;
}
