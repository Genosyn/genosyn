import type { Approval, Decision } from "@/lib/api";
import { firstSentence, pickupReportOf } from "../../../shared/decisionSummary";
import type { DecisionStackItem } from "./useDecisionFollowUps";

/**
 * What a settled item says in one line, and how the stack lays items out.
 *
 * Once a Decision is answered — or an email or work review is acted on — its
 * row collapses to a single status line that follows the work: "You chose
 * “Bid” · Alex is on it", then "Done · Registered on BidNet". Everything the
 * old cards streamed (every narration line, every timeline step) stays behind
 * the row's Details. These functions are pure so the wording is pinned by
 * tests, and so Home, the stack and History all say the same thing.
 */

/**
 * How a status line reads at a glance. `saved` is a recorded answer with no
 * work started (quiet, but not a dismissal); `neutral` is a question or review
 * that was set aside.
 */
export type StatusTone = "progress" | "success" | "saved" | "warning" | "danger" | "neutral";

export type StatusLine = {
  /** The opening words, shown strong: "Done", "You chose “Bid”", "Dismissed". */
  label: string;
  /** What follows the label, or null. One line; the rest is in Details. */
  text: string | null;
  tone: StatusTone;
  /** Work is still under way, so the row shows a spinner. */
  working: boolean;
};

/** The longest line a status ever shows; the full text is behind Details. */
const STATUS_TEXT_MAX = 160;

function line(text: string | null | undefined): string | null {
  return firstSentence(text, STATUS_TEXT_MAX) || null;
}

/** Who answered, as the viewer reads it: "You", "Morgan Lee", "Riley (AI)". */
export function answeredBy(decision: Decision, viewerId?: string | null): string {
  if (decision.decidedByEmployee) return `${decision.decidedByEmployee.name} (AI)`;
  if (decision.decidedBy)
    return decision.decidedBy.id === viewerId ? "You" : decision.decidedBy.name;
  return "Someone";
}

/**
 * The one line a Decision collapses to once it has left the waiting stack:
 * who chose what and who is on it, then how it ended.
 */
export function decisionStatusLine(decision: Decision, viewerId?: string | null): StatusLine {
  const employee = decision.employee?.name ?? "The AI Employee";
  switch (decision.status) {
    case "pending":
      return { label: "Waiting for an answer", text: null, tone: "neutral", working: false };
    case "expired":
      return {
        label: "Expired",
        text: "This expired under an earlier version, before Decisions stopped expiring.",
        tone: "warning",
        working: false,
      };
    case "cancelled": {
      const note = line(decision.note);
      if (decision.decidedByUserId) {
        const who = decision.decidedBy
          ? decision.decidedBy.id === viewerId
            ? "you"
            : decision.decidedBy.name
          : null;
        return {
          label: "Dismissed",
          text: [who ? `By ${who}` : null, note].filter(Boolean).join(" · ") || null,
          tone: "neutral",
          working: false,
        };
      }
      return {
        label: "Withdrawn",
        text: [`${employee} no longer needs an answer`, note].filter(Boolean).join(" · "),
        tone: "neutral",
        working: false,
      };
    }
    case "decided": {
      const chose = `${answeredBy(decision, viewerId)} chose “${decision.chosenOptionLabel ?? "an answer"}”`;
      switch (decision.pickupStatus) {
        case "none":
          return {
            label: chose,
            text: `Waiting for ${employee} to start`,
            tone: "progress",
            working: false,
          };
        case "running":
          return { label: chose, text: `${employee} is on it`, tone: "progress", working: true };
        case "done": {
          const { report } = pickupReportOf(decision);
          return {
            label: "Done",
            text: line(report) ?? `${employee} finished the work`,
            tone: "success",
            working: false,
          };
        }
        case "failed":
          return {
            label: "Couldn’t finish",
            text: line(decision.pickupSummary) ?? "The work stopped before it finished.",
            tone: "warning",
            working: false,
          };
        case "skipped":
          return {
            label: "Answer saved",
            text: line(decision.pickupSummary) ?? `${employee} reads it on their next run.`,
            tone: "saved",
            working: false,
          };
      }
    }
  }
}

/** The one line a reviewed email collapses to. */
export function mailReviewStatusLine(approval: Approval): StatusLine {
  const review = approval.review?.kind === "mail" ? approval.review : null;
  const to = review?.draft.to.trim() ? `To ${review.draft.to.trim()}` : null;
  const notSent =
    approval.status === "execution_failed" && approval.mailDeliveryStatus === "not_sent";
  switch (approval.status) {
    case "pending":
      return { label: "Waiting for review", text: null, tone: "neutral", working: false };
    case "executing":
      return { label: "Sending", text: to, tone: "progress", working: true };
    case "approved":
      return approval.mailOutcome
        ? { label: "Sent", text: to, tone: "success", working: false }
        : {
            label: "Send not confirmed",
            text: "Check the source before sending again.",
            tone: "warning",
            working: false,
          };
    case "execution_failed":
      return notSent
        ? {
            label: "Not sent",
            text: line(approval.errorMessage) ?? "The email was not sent.",
            tone: "danger",
            working: false,
          }
        : {
            label: "Send not confirmed",
            text: line(approval.errorMessage) ?? "Check the source before sending again.",
            tone: "warning",
            working: false,
          };
    case "rejected":
      return { label: "Discarded", text: "Nothing was sent.", tone: "neutral", working: false };
    case "expired":
      return { label: "Expired", text: "Nothing was sent.", tone: "neutral", working: false };
  }
}

/** The one line a reviewed work plan collapses to. */
export function workReviewStatusLine(approval: Approval): StatusLine {
  const employee = approval.employee?.name ?? "The AI Employee";
  switch (approval.status) {
    case "pending":
      return { label: "Waiting for review", text: null, tone: "neutral", working: false };
    case "executing":
      return {
        label: "Approved",
        text: `${employee} is doing the work`,
        tone: "progress",
        working: true,
      };
    case "approved":
      if (approval.outcomeSummary) {
        return {
          label: "Done",
          text: line(approval.outcomeSummary),
          tone: "success",
          working: false,
        };
      }
      return approval.outcomeRunId
        ? { label: "Done", text: "Open the Run for its report.", tone: "success", working: false }
        : {
            label: "Outcome not confirmed",
            text: "No Run or report was recorded.",
            tone: "warning",
            working: false,
          };
    case "execution_failed":
      return {
        label: "Couldn’t finish",
        text: line(approval.errorMessage) ?? "The approved work could not finish.",
        tone: "danger",
        working: false,
      };
    case "rejected":
      return {
        label: "Declined",
        text: "The work did not start.",
        tone: "neutral",
        working: false,
      };
    case "expired":
      return { label: "Expired", text: "The work did not start.", tone: "neutral", working: false };
  }
}

/** A stack entry: one item, or a run of reviews of one kind shown under one heading. */
export type StackEntry =
  | { kind: "item"; key: string; item: DecisionStackItem }
  | { kind: "group"; key: string; group: "mail" | "work"; items: DecisionStackItem[] };

function reviewGroup(item: DecisionStackItem): "mail" | "work" | null {
  if (item.kind !== "review") return null;
  return item.approval.kind === "mail_send"
    ? "mail"
    : item.approval.kind === "proactive_work"
      ? "work"
      : null;
}

/**
 * Lay ordered items out for scanning: email reviews gather under one heading
 * where the first of them would stand, and work reviews likewise; Decisions
 * stay where their order puts them. Each review keeps its own controls — a
 * group is a heading, never one answer for several gates.
 *
 * A kind with a single review still gets its group, unlabelled, so the row
 * keeps its place in the tree as reviews arrive and leave — an email being
 * edited is never torn down because a second one turned up.
 */
export function groupStackItems(items: DecisionStackItem[]): StackEntry[] {
  const entries: StackEntry[] = [];
  const groups = new Map<"mail" | "work", Extract<StackEntry, { kind: "group" }>>();
  for (const item of items) {
    const group = reviewGroup(item);
    if (!group) {
      entries.push({ kind: "item", key: item.key, item });
      continue;
    }
    const existing = groups.get(group);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    const entry = { kind: "group" as const, key: `group-${group}`, group, items: [item] };
    groups.set(group, entry);
    entries.push(entry);
  }
  return entries;
}

/** The heading over a group of reviews, or null for a group of one. */
export function groupHeading(group: "mail" | "work", items: DecisionStackItem[]): string | null {
  if (items.length < 2) return null;
  const waiting = items.filter(
    (item) => item.kind === "review" && (!item.outcome || item.outcome.status === "pending"),
  ).length;
  const noun = group === "mail" ? "emails" : "work plans";
  return waiting === items.length
    ? `${items.length} ${noun} to review`
    : `${items.length} ${noun} · ${waiting} to review`;
}
