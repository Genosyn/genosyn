import { api, type AuditActorKind } from "./api";
import { describeCronExpr } from "./scheduleBuilder";

/**
 * Client side of a record's History (`server/services/recordHistory.ts`):
 * the wire types, the fetch, and the wording that turns a dotted audit action
 * into a sentence a Member reads without knowing the action namespace.
 */

export type RecordHistoryValue = string | number | boolean | null;

export type RecordHistoryEntry = {
  id: string;
  createdAt: string;
  action: string;
  actorKind: AuditActorKind;
  actor: { id: string; name: string; avatarKey: string | null } | null;
  actorEmployee: {
    id: string;
    slug: string;
    name: string;
    role: string;
    avatarKey: string | null;
  } | null;
  runId: string | null;
  changedFields: string[];
  details: Record<string, RecordHistoryValue>;
};

export type RecordHistoryPage = {
  items: RecordHistoryEntry[];
  nextCursor: string | null;
};

export function fetchRecordHistory(
  companyId: string,
  targetType: string,
  targetId: string,
  cursor?: string | null,
): Promise<RecordHistoryPage> {
  const qs = new URLSearchParams({ take: "50" });
  if (cursor) qs.set("cursor", cursor);
  return api.get<RecordHistoryPage>(
    `/api/companies/${companyId}/history/${encodeURIComponent(targetType)}/${encodeURIComponent(
      targetId,
    )}?${qs.toString()}`,
  );
}

/** What kind of principal acted, in product words. */
export const ACTOR_KIND_LABEL: Record<AuditActorKind, string> = {
  user: "Member",
  ai: "AI Employee",
  cron: "Scheduler",
  webhook: "Webhook",
  system: "System",
};

/** Namespace segments that say where an action lives, not what it did. */
const NAMESPACE_SEGMENTS = new Set(["finance", "revenue", "workspace", "mcp", "tasks"]);

/**
 * An older spelling of a record's type at the head of its actions. The AI
 * Employee signing tools logged `signature.envelope.*` until the signing
 * service took over every envelope's rows as `signature_envelope.*`; the old
 * rows stay in the ledger and read the same.
 */
const LEGACY_TYPE_PREFIXES: Record<string, string> = {
  signature_envelope: "signature.envelope",
};

/**
 * Whole-remainder phrases, after the namespace and the record's own type are
 * stripped. `{noun}` is the record ("this invoice"). Checked before the
 * generic verb table so a compound like `email.resend` reads naturally.
 */
const PHRASES: Record<string, string> = {
  create: "created {noun}",
  add: "added {noun}",
  update: "updated {noun}",
  edit: "edited {noun}",
  patch: "updated {noun}",
  rename: "renamed {noun}",
  delete: "deleted {noun}",
  remove: "removed {noun}",
  archive: "archived {noun}",
  unarchive: "restored {noun}",
  restore: "restored {noun}",
  duplicate: "duplicated {noun}",
  send: "sent {noun}",
  issue: "issued {noun}",
  revise: "edited {noun} after it was sent",
  void: "voided {noun}",
  approve: "approved {noun}",
  reject: "rejected {noun}",
  accept: "marked {noun} accepted",
  decline: "marked {noun} declined",
  publish: "published {noun}",
  unpublish: "unpublished {noun}",
  enable: "turned {noun} on",
  disable: "turned {noun} off",
  pause: "paused {noun}",
  resume: "resumed {noun}",
  run: "ran {noun}",
  "run.manual": "ran {noun} manually",
  "webhook.rotate": "rotated the webhook token",
  "soul.update": "edited the Soul",
  "avatar.upload": "changed the avatar",
  "avatar.remove": "removed the avatar",
  "revision.apply": "applied a revision proposal to {noun}",
  invoke: "ran {noun}",
  retry: "retried {noun}",
  move: "moved {noun}",
  reorder: "reordered {noun}",
  assign: "assigned {noun}",
  complete: "completed {noun}",
  reopen: "reopened {noun}",
  close: "closed {noun}",
  cancel: "cancelled {noun}",
  apply: "applied {noun}",
  unapply: "unapplied {noun}",
  refund: "refunded {noun}",
  refund_reversed: "reversed a refund",
  payment: "recorded a payment",
  "payment.create": "recorded a payment",
  "payment.record": "recorded a payment",
  "payment.delete": "removed a payment",
  mark_paid: "marked {noun} paid",
  write_off: "wrote off part of the balance",
  write_off_reversed: "reversed a write-off",
  "email.resend": "resent the email",
  "email.send": "emailed {noun}",
  "reminder.send": "sent a reminder",
  resend: "resent {noun}",
  convert: "converted {noun}",
  "convert.invoice": "converted {noun} to an invoice",
  merge: "merged {noun}",
  import: "imported {noun}",
  export: "exported {noun}",
  grant: "granted access to {noun}",
  revoke: "revoked access to {noun}",
  "access.update": "changed who can reach {noun}",
  stage: "moved {noun} to a new stage",
  propose: "proposed {noun}",
  commit: "committed to {noun}",
  submit: "submitted {noun}",
  sign: "signed {noun}",
  categorize: "categorized {noun}",
  // Data rooms (`server/services/dataRooms/`), past tense as written.
  created: "created {noun}",
  settings_changed: "changed the settings of {noun}",
  closed: "closed {noun}",
  reopened: "reopened {noun}",
  folder_created: "added a folder",
  folder_renamed: "renamed a folder",
  folders_reordered: "reordered the folders",
  folder_deleted: "removed a folder",
  document_added: "added a document",
  document_filed: "filed a document from its brief",
  document_moved: "moved a document",
  document_renamed: "renamed a document",
  document_deleted: "deleted a document",
  guest_invited: "invited a guest",
  guest_reinvited: "invited a guest back",
  guest_access_changed: "changed a guest's access",
  guest_revoked: "revoked a guest's access",
  guest_restored: "restored a guest's access",
  guest_link_reissued: "reissued a guest's link",
  guest_invitation_resent: "resent a guest's invitation",
  answer_drafted: "drafted an answer",
  question_answered: "answered a guest's question",
  answer_updated: "updated an answer",
  question_closed: "closed a question",
  question_reopened: "reopened a question",
};

/** Past tense for the last segment when no whole phrase matched. */
const PAST: Record<string, string> = {
  create: "created",
  add: "added",
  update: "updated",
  edit: "edited",
  delete: "deleted",
  remove: "removed",
  set: "set",
  send: "sent",
  issue: "issued",
  revise: "revised",
  void: "voided",
  apply: "applied",
  approve: "approved",
  reject: "rejected",
  start: "started",
  stop: "stopped",
  connect: "connected",
  disconnect: "disconnected",
  link: "linked",
  unlink: "unlinked",
  attach: "attached",
  detach: "detached",
  upload: "uploaded",
  record: "recorded",
  reverse: "reversed",
  sync: "synced",
  enroll: "enrolled",
  schedule: "scheduled",
  rotate: "rotated",
};

const words = (s: string) => s.replace(/[_-]+/g, " ").trim();

/**
 * "finance.invoice.email.resend" on an invoice → "resent the email".
 * Falls back to a readable rendering of the action itself, never to the raw
 * dotted name, so a new action reads acceptably before anyone words it.
 */
export function describeHistoryAction(action: string, targetType: string, noun: string): string {
  const legacy = LEGACY_TYPE_PREFIXES[targetType];
  const current =
    legacy && action.startsWith(`${legacy}.`)
      ? `${targetType}${action.slice(legacy.length)}`
      : action;
  const segments = current.split(".").filter(Boolean);
  while (segments.length > 1 && NAMESPACE_SEGMENTS.has(segments[0])) segments.shift();
  if (segments.length > 1 && segments[0] === targetType) segments.shift();
  const rest = segments.join(".");
  const fill = (template: string) => template.replace("{noun}", noun);
  if (PHRASES[rest]) return fill(PHRASES[rest]);
  const last = segments[segments.length - 1] ?? action;
  const lead = segments.slice(0, -1).map(words).join(" ");
  if (PAST[last]) return lead ? `${PAST[last]} ${lead}` : `${PAST[last]} ${noun}`;
  if (PHRASES[last] && !lead) return fill(PHRASES[last]);
  return words(segments.join(" "));
}

/**
 * Fields whose stored name is jargon to the person reading the feed. A
 * Routine's `cronExpr` is its schedule, and its value reads as one too
 * (`formatHistoryValue`).
 */
const KEY_LABELS: Record<string, string> = {
  cronExpr: "schedule",
};

/** "dueDate" → "due date", "amountCents" → "amount", "cronExpr" → "schedule". */
export function humanizeKey(key: string): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  return key
    .replace(/Cents$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
}

export function formatHistoryValue(
  key: string,
  value: RecordHistoryValue,
  currency?: string,
): string {
  if (value === null) return "none";
  // "0 9 * * 1-5" → "Every weekday at 9:00 AM", the way the schedule is shown elsewhere.
  if (key === "cronExpr" && typeof value === "string") return describeCronExpr(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number" && /Cents$/.test(key)) {
    const amount = value / 100;
    try {
      return currency
        ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(amount)
        : amount.toFixed(2);
    } catch {
      return amount.toFixed(2);
    }
  }
  return String(value);
}

/** "just now", "5m ago", "3h ago", "2d ago", then a date. */
export function historyTimeAgo(iso: string, now: number = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(iso).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

/** "Today", "Yesterday", or the date — the day headings the feed groups under. */
export function historyDayLabel(iso: string, now: number = Date.now()): string {
  const day = new Date(iso);
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(day)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: days < 7 ? "long" : undefined,
    month: "long",
    day: "numeric",
    year: day.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}
