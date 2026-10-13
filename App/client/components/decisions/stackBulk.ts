import type { DecisionStackItem } from "./useDecisionFollowUps";

/**
 * What a selection on the Decision stack can do, and the words for it.
 *
 * A selection only ever takes rows off the stack without acting on them:
 * Dismiss or Snooze for a Decision, Discard for an email, Don’t do this for a
 * work plan. Answering a Decision, Send now and Approve & start stay one row
 * at a time — each is a gate a person passes on its own.
 */

/** One waiting row a selection can act on, keyed like its stack item. */
export type BulkTarget =
  | { kind: "decision"; key: string; id: string }
  | { kind: "mail" | "work"; key: string; id: string; reviewRevision?: string };

/** The target behind a row, or null for a row a selection cannot take (an outcome, a load). */
export function bulkTarget(item: DecisionStackItem): BulkTarget | null {
  if (item.kind === "decision") {
    return item.decision.status === "pending"
      ? { kind: "decision", key: item.key, id: item.decision.id }
      : null;
  }
  if (item.kind !== "review" || (item.outcome && item.outcome.status !== "pending")) return null;
  const kind =
    item.approval.kind === "mail_send"
      ? "mail"
      : item.approval.kind === "proactive_work"
        ? "work"
        : null;
  if (!kind) return null;
  const reviewRevision = item.approval.review?.revision;
  return {
    kind,
    key: item.key,
    id: item.approval.id,
    ...(reviewRevision ? { reviewRevision } : {}),
  };
}

/**
 * Tick or untick `key`. With `extend` (a shift-click) the whole run from
 * `anchor`, the last row ticked, takes the clicked row's new state — in
 * `order`, the order the rows are on screen.
 */
export function toggleSelection(
  current: ReadonlySet<string>,
  order: readonly string[],
  key: string,
  anchor: string | null,
  extend: boolean,
): Set<string> {
  const next = new Set(current);
  const index = order.indexOf(key);
  const from = anchor ? order.indexOf(anchor) : -1;
  if (extend && index >= 0 && from >= 0) {
    const select = !current.has(key);
    const [start, end] = from < index ? [from, index] : [index, from];
    for (let i = start; i <= end; i += 1) {
      if (select) next.add(order[i]);
      else next.delete(order[i]);
    }
  } else if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

export type BulkCounts = { decisions: number; emails: number; work: number };

export function countTargets(targets: readonly BulkTarget[]): BulkCounts {
  return {
    decisions: targets.filter((target) => target.kind === "decision").length,
    emails: targets.filter((target) => target.kind === "mail").length,
    work: targets.filter((target) => target.kind === "work").length,
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** "a, b and c". */
function list(parts: string[]): string {
  return parts.length <= 1
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function total(counts: BulkCounts): number {
  return counts.decisions + counts.emails + counts.work;
}

/**
 * What Dismiss asks before it acts, or null when it need not ask: Decisions
 * alone come back with Undismiss, but a discarded email or a declined plan
 * cannot be restored.
 */
export function dismissConfirmation(counts: BulkCounts): {
  title: string;
  message: string;
  confirmLabel: string;
  variant: "danger";
} | null {
  if (counts.emails + counts.work === 0) return null;
  const only = counts.decisions === 0 && (counts.emails === 0 || counts.work === 0);
  const verb = !only ? "Dismiss" : counts.emails > 0 ? "Discard" : "Decline";
  const what = !only
    ? plural(total(counts), "item")
    : counts.emails > 0
      ? plural(counts.emails, "email")
      : plural(counts.work, "work plan");
  const sentences: string[] = [];
  if (counts.decisions > 0) {
    sentences.push(
      `${plural(counts.decisions, "decision")} ${counts.decisions === 1 ? "is" : "are"} dismissed without an answer. Undismiss in Decision history brings ${counts.decisions === 1 ? "it" : "them"} back.`,
    );
  }
  if (counts.emails > 0) {
    sentences.push(
      `${plural(counts.emails, "email")} ${counts.emails === 1 ? "is" : "are"} discarded and never sent.`,
    );
  }
  if (counts.work > 0) {
    sentences.push(
      `${plural(counts.work, "work plan")} ${counts.work === 1 ? "is" : "are"} declined, and nothing in ${counts.work === 1 ? "it" : "them"} is started.`,
    );
  }
  sentences.push(
    `Each AI Employee is told. ${counts.emails > 0 && counts.work > 0 ? "Discarded emails and declined plans" : counts.emails > 0 ? "Discarded emails" : "Declined plans"} can’t be restored.`,
  );
  return {
    title: `${verb} ${what}?`,
    message: sentences.join(" "),
    confirmLabel: `${verb} ${what}`,
    variant: "danger",
  };
}

/** What a screen reader hears once the rows have left. */
export function bulkAnnouncement(
  request: { action: "dismiss" } | { action: "snooze"; label: string },
  counts: BulkCounts,
): string {
  if (request.action === "snooze") {
    return `${plural(counts.decisions, "decision")} snoozed for ${request.label}.`;
  }
  const parts = [
    counts.decisions > 0 ? `${plural(counts.decisions, "decision")} dismissed` : null,
    counts.emails > 0 ? `${plural(counts.emails, "email")} discarded` : null,
    counts.work > 0 ? `${plural(counts.work, "work plan")} declined` : null,
  ].filter((part): part is string => part !== null);
  return `${list(parts)}. They are in Decision history.`;
}

/**
 * Why some of a selection was left on the stack: the title names how many,
 * the message each reason once, with how often it applied.
 */
export function skippedSummary(
  skipped: ReadonlyArray<{ reason: string }>,
  action: "dismiss" | "snooze",
  changed: number,
): { title: string; message: string } {
  const reasons = new Map<string, number>();
  for (const { reason } of skipped) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const done = action === "dismiss" ? "dismissed" : "snoozed";
  const why = [...reasons]
    .map(([reason, count]) => (skipped.length === 1 ? reason : `${reason} (${count})`))
    .join("; ");
  const rest =
    changed === 0
      ? ""
      : changed === 1
        ? ` The other one was ${done}.`
        : ` The other ${changed} were ${done}.`;
  return {
    title: `${plural(skipped.length, "item")} ${skipped.length === 1 ? "wasn’t" : "weren’t"} ${done}`,
    message: `${why}.${rest}`,
  };
}

/** Split a selection into requests the server takes at once. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));
  return parts;
}
