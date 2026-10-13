import React from "react";
import {
  decisionStackApi,
  type Company,
  type DecisionSnoozeDuration,
  type StackBulkResult,
} from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { useDialog } from "@/components/ui/Dialog";
import { focusAfterRowsLeave } from "@/components/decisions/StackRow";
import {
  bulkAnnouncement,
  chunk,
  countTargets,
  dismissConfirmation,
  skippedSummary,
  toggleSelection,
  type BulkTarget,
} from "@/components/decisions/stackBulk";
import type { DecisionFollowUps } from "@/components/decisions/useDecisionFollowUps";

/** Half what the server takes, so one request never holds the database for long. */
const BULK_CHUNK = 100;

type BulkRequest =
  | { action: "dismiss" }
  | { action: "snooze"; duration: DecisionSnoozeDuration; label: string };

/**
 * The Decision stack's selection and what its bulk bar does with it.
 *
 * `targets` are the rows on screen that a selection may act on, in the order
 * they are shown. The selection is only ever read through them, so a row that
 * has left — answered elsewhere, snoozed, filtered out by search — is never
 * acted on, and a shift-click ticks a run in on-screen order.
 *
 * A bulk action goes row by row on the server under each row's own rules.
 * Rows that changed leave the stack at once, the way a row's own Dismiss
 * takes it; a row that was skipped stays, still ticked, and the error modal
 * says why. Decisions alone need no confirmation — Undismiss brings them
 * back — but discarding an email or declining a plan asks first.
 */
export function useStackBulk({
  company,
  targets,
  followUps,
  onDecisionsChanged,
  onReviewsChanged,
  announce,
}: {
  company: Company;
  targets: BulkTarget[];
  followUps: DecisionFollowUps;
  onDecisionsChanged: () => Promise<void> | void;
  onReviewsChanged: () => Promise<void> | void;
  /** Tell a screen reader what happened once the rows have left. */
  announce: (message: string) => void;
}) {
  const dialog = useDialog();
  const [keys, setKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState<BulkRequest["action"] | null>(null);
  const running = React.useRef(false);
  /** The row a shift-click extends from: the last one ticked by hand. */
  const anchor = React.useRef<string | null>(null);
  const order = targets.map((target) => target.key);
  const orderRef = React.useRef(order);
  orderRef.current = order;
  const selected = targets.filter((target) => keys.has(target.key));
  const selectedRef = React.useRef(selected);
  selectedRef.current = selected;
  /** Where focus goes once the rows a bulk action took are off the page. */
  const pendingFocus = React.useRef<(() => void) | null>(null);

  // After the render that removed them, not before: the bar may have gone
  // with them, taking focus along.
  React.useEffect(() => {
    const move = pendingFocus.current;
    pendingFocus.current = null;
    move?.();
  });

  // A ticked row that left the screen is forgotten, so it cannot come back
  // ticked if it returns (Undismiss, a snooze running out).
  const orderKey = order.join(" ");
  React.useEffect(() => {
    const shown = new Set(orderKey ? orderKey.split(" ") : []);
    setKeys((current) => {
      const kept = [...current].filter((key) => shown.has(key));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [orderKey]);

  const toggle = React.useCallback((key: string, extend: boolean) => {
    // Read and move the anchor outside the updater, which StrictMode runs twice.
    const from = anchor.current;
    anchor.current = key;
    setKeys((current) => toggleSelection(current, orderRef.current, key, from, extend));
  }, []);

  const setMany = React.useCallback((many: string[], value: boolean) => {
    setKeys((current) => {
      const next = new Set(current);
      for (const key of many) {
        if (value) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }, []);

  const clear = React.useCallback(() => {
    anchor.current = null;
    setKeys(new Set());
  }, []);

  async function run(request: BulkRequest) {
    if (running.current) return;
    const chosen = selectedRef.current;
    const decisions = chosen.filter((target) => target.kind === "decision");
    const reviews = chosen.filter((target) => target.kind !== "decision");
    // Only Decisions snooze; the bar never offers it for a review.
    if (chosen.length === 0 || (request.action === "snooze" && reviews.length > 0)) return;
    if (request.action === "dismiss") {
      const confirmation = dismissConfirmation(countTargets(chosen));
      if (confirmation && !(await dialog.confirm(confirmation))) return;
    }
    running.current = true;
    setBusy(request.action);
    const done = new Set<string>();
    const skipped: StackBulkResult["skipped"] = [];
    let failure: unknown = null;
    try {
      for (const part of chunk(decisions, BULK_CHUNK)) {
        const ids = part.map((target) => target.id);
        const result = await decisionStackApi.bulkDecisions(
          company.id,
          request.action === "dismiss"
            ? { action: "dismiss", ids }
            : { action: "snooze", ids, duration: request.duration },
        );
        for (const id of result.succeeded) done.add(`decision-${id}`);
        skipped.push(...result.skipped);
      }
      for (const part of chunk(reviews, BULK_CHUNK)) {
        const result = await decisionStackApi.rejectReviews(
          company.id,
          part.map((target) =>
            target.reviewRevision
              ? { id: target.id, reviewRevision: target.reviewRevision }
              : { id: target.id },
          ),
        );
        for (const id of result.succeeded) done.add(`review-${id}`);
        skipped.push(...result.skipped);
      }
    } catch (err) {
      failure = err;
    } finally {
      // Whatever went through stays done, even when a later part failed:
      // those rows leave now, exactly as their own buttons would take them.
      pendingFocus.current = focusAfterRowsLeave(done);
      for (const key of done) followUps.close(key);
      setMany([...done], false);
      running.current = false;
      setBusy(null);
    }
    const gone = chosen.filter((target) => done.has(target.key));
    if (gone.length > 0) {
      announce(bulkAnnouncement(request, countTargets(gone)));
      await Promise.all([
        gone.some((target) => target.kind === "decision") ? onDecisionsChanged() : null,
        gone.some((target) => target.kind !== "decision") ? onReviewsChanged() : null,
      ]);
    }
    if (failure) {
      const reason = errorMessage(failure);
      void dialog.error(
        gone.length > 0
          ? `${/[.!?]$/.test(reason) ? reason : `${reason}.`} ${gone.length} of ${chosen.length} went through.`
          : failure,
        { title: `Couldn’t ${request.action} the selected items` },
      );
    } else if (skipped.length > 0) {
      const summary = skippedSummary(skipped, request.action, gone.length);
      void dialog.error(summary.message, { title: summary.title });
    }
  }

  return {
    /** The ticked keys, for drawing the tick boxes. */
    keys,
    /** The ticked rows still on screen — what the bar counts and acts on. */
    selected,
    busy,
    toggle,
    setMany,
    clear,
    dismiss: () => void run({ action: "dismiss" }),
    snooze: (duration: DecisionSnoozeDuration, label: string) =>
      void run({ action: "snooze", duration, label }),
  };
}
