import React from "react";
import { PauseCircle } from "lucide-react";
import { Link, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { useAskAiPageContext } from "@/components/askAi/AskAiProvider";
import {
  api,
  Approval,
  Company,
  Decision,
  DecisionStackSettings,
  Me,
  decisionStackApi,
} from "../lib/api";
import { decisionStackOffBanner } from "../lib/decisionStack";
import { errorMessage } from "../lib/errors";
import { waitingLinks } from "../lib/waitingElsewhere";
import type { DecisionsOutletContext } from "./DecisionsLayout";
import { StackBulkBar } from "@/components/decisions/StackBulkBar";
import { StackList, type StackListSelection } from "@/components/decisions/StackList";
import { bulkTarget, type BulkTarget } from "@/components/decisions/stackBulk";
import {
  StackSearch,
  StackSection,
  decisionMatches,
  isStackReview,
  reviewMatches,
  stackLinkFromHash,
  useScrollToStackLink,
} from "@/components/decisions/stackPage";
import { groupStackItems } from "@/components/decisions/stackStatus";
import {
  compareStackItems,
  decisionItem,
  reviewItem,
  stackItemPending,
  useDecisionFollowUps,
} from "@/components/decisions/useDecisionFollowUps";
import { useStackBulk } from "@/components/decisions/useStackBulk";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { clsx } from "../components/ui/clsx";

/**
 * The Decision Stack — every question an AI Employee raised for a Member, and
 * every email or work review, that is still waiting on someone.
 *
 * It reads as a short list: one compact row per item — who asks, the question,
 * one plain line, the recommendation and the answers — with everything else
 * behind each row's Details. Email reviews gather under one heading.
 *
 * The split that matters is **assigned to you** versus
 * **anyone can answer**: an employee that named a Member did so because that
 * person holds the context, and burying those in one long list is how a
 * question addressed to somebody specific sits for three days.
 *
 * A row you answer collapses to a status line that follows the work; once it
 * finishes cleanly and has been seen, the next visit leaves it to History
 * (a problem waits for Close). Dismiss, Snooze, Discard and Don’t do this take
 * the row off in the same click. Everything already settled lives on its own page,
 * `DecisionHistory`, so this one only ever holds what still needs someone. A
 * link to a settled item (`#decision-<id>`, `#review-<id>`) is sent on there.
 *
 * Every waiting row the viewer may act on has a tick box, and a selection can
 * be dismissed or snoozed together from the bulk bar (`useStackBulk`). That
 * only ever takes rows off; answers, sends and approvals stay one row at a time.
 *
 * What waits in the queues beside the stack — Approvals, Revisions,
 * Initiatives, todos to review, Finance proposals — is named in one line at
 * the top, each linked, so this page answers "what needs me?" on its own.
 */

function isFutureSnooze(decision: Decision, now: number): boolean {
  if (decision.status !== "pending" || !decision.snoozedUntil) return false;
  const until = Date.parse(decision.snoozedUntil);
  return Number.isFinite(until) && until > now;
}

export default function Decisions({ company, me }: { company: Company; me: Me }) {
  const location = useLocation();
  const navigate = useNavigate();
  const outlet = useOutletContext<DecisionsOutletContext | undefined>();
  const alsoWaiting = waitingLinks(outlet?.waiting ?? null);
  const reloadVersion = React.useRef(0);
  const link = stackLinkFromHash(location.hash);
  const linkedDecisionId = link?.kind === "decision" ? link.id : null;
  const linkedReviewId = link?.kind === "review" ? link.id : null;
  // A decision linked from elsewhere (`#decision-<id>`) is the one Ask AI
  // means by "this decision".
  useAskAiPageContext(linkedDecisionId ? [{ kind: "decision", id: linkedDecisionId }] : null);
  const [rows, setRows] = React.useState<Decision[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [linkedError, setLinkedError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [workReviews, setWorkReviews] = React.useState<Approval[] | null>(null);
  const [workError, setWorkError] = React.useState<string | null>(null);
  const [resolutionNotice, setResolutionNotice] = React.useState<{ message: string } | null>(null);
  const [retryingDecisions, setRetryingDecisions] = React.useState(false);
  const [retryingWork, setRetryingWork] = React.useState(false);
  const canReview = company.role === "owner" || company.role === "admin";
  // Owners and admins may answer any Decision, including another Member's.
  const canAnswerAssigned = canReview;
  const workRequest = React.useRef(0);
  const followUps = useDecisionFollowUps(company, me.id);
  const clearClosedFollowUps = followUps.clearClosed;
  // Whether new questions are paused (Decision stack → Settings). Only the
  // banner reads it; a failed read simply shows no banner, never an error in
  // front of the questions people came here to answer.
  const [stackSettings, setStackSettings] = React.useState<DecisionStackSettings | null>(null);
  const reloadStackSettings = React.useCallback(async () => {
    try {
      setStackSettings(await decisionStackApi.settings(company.id));
    } catch {
      setStackSettings(null);
    }
  }, [company.id]);
  React.useEffect(() => {
    void reloadStackSettings();
  }, [reloadStackSettings]);
  useLiveRefetch("decision", reloadStackSettings);

  // A link resolves once per navigation: the first load that finds its target
  // decides whether it is read here or in History. Closing the card, a live
  // refresh, or another Member's answer never pulls the reader off this page.
  const linkKey = React.useRef("");
  linkKey.current = `${location.key}:${location.hash}`;
  const resolvedLink = React.useRef<string | null>(null);
  const followed = React.useRef(followUps.items);
  followed.current = followUps.items;
  const sendsToHistory = React.useCallback((key: string, itemKey: string, settled: boolean) => {
    if (resolvedLink.current === key) return false;
    resolvedLink.current = key;
    // A card this Member still follows stays on their stack until Close.
    return settled && !followed.current.some((item) => item.key === itemKey);
  }, []);

  const reloadWork = React.useCallback(async () => {
    const version = ++workRequest.current;
    if (!canReview) {
      setWorkReviews([]);
      setWorkError(null);
      return;
    }
    const key = linkKey.current;
    try {
      const approvals = await api.get<Approval[]>(
        `/api/companies/${company.id}/approvals?kind=decision_stack`,
      );
      let targetError: string | null = null;
      if (linkedReviewId && !approvals.some((approval) => approval.id === linkedReviewId)) {
        try {
          const linked = await api.get<Approval>(
            `/api/companies/${company.id}/approvals/${linkedReviewId}`,
          );
          if (isStackReview(linked)) {
            approvals.push(linked);
          } else {
            targetError = "The linked Approval does not belong in the Decision stack.";
          }
        } catch (err) {
          targetError = `Could not open the linked review: ${errorMessage(err)}`;
        }
      }
      if (version !== workRequest.current) return;
      if (linkedReviewId) {
        const linked = approvals.find(
          (approval) => approval.id === linkedReviewId && isStackReview(approval),
        );
        if (
          sendsToHistory(key, `review-${linkedReviewId}`, !!linked && linked.status !== "pending")
        ) {
          navigate(`/c/${company.slug}/decisions/history#review-${linkedReviewId}`, {
            replace: true,
          });
          return;
        }
      }
      // The list also carries recently settled reviews; those are History's.
      setWorkReviews(
        approvals.filter((approval) => isStackReview(approval) && approval.status === "pending"),
      );
      clearClosedFollowUps("review");
      setWorkError(null);
      if (linkedReviewId) setLinkedError(targetError);
    } catch (err) {
      if (version !== workRequest.current) return;
      setWorkError(errorMessage(err, "Could not load email and work reviews"));
      setWorkReviews((current) => current ?? []);
    }
  }, [
    company.id,
    company.slug,
    canReview,
    linkedReviewId,
    clearClosedFollowUps,
    navigate,
    sendsToHistory,
  ]);

  React.useEffect(() => {
    setWorkReviews(null);
    setWorkError(null);
    void reloadWork();
    return () => {
      // Invalidate outstanding reads; this counter is not a rendered-node ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      workRequest.current++;
    };
  }, [reloadWork]);
  useLiveRefetch("approval", reloadWork);

  const reload = React.useCallback(async () => {
    const version = ++reloadVersion.current;
    const key = linkKey.current;
    try {
      const listed = await api.get<Decision[]>(
        `/api/companies/${company.id}/decisions?status=pending`,
      );
      let targetError: string | null = null;
      // A linked Decision can sit beyond the newest 200 waiting ones, or be
      // settled already: still followed here, or else History's to show.
      if (linkedDecisionId && !listed.some((row) => row.id === linkedDecisionId)) {
        try {
          listed.push(
            await api.get<Decision>(`/api/companies/${company.id}/decisions/${linkedDecisionId}`),
          );
        } catch (err) {
          targetError = `Could not open the linked decision: ${errorMessage(err)}`;
        }
      }
      if (version !== reloadVersion.current) return;
      if (linkedDecisionId) {
        const linked = listed.find((row) => row.id === linkedDecisionId);
        if (
          sendsToHistory(
            key,
            `decision-${linkedDecisionId}`,
            !!linked && linked.status !== "pending",
          )
        ) {
          navigate(`/c/${company.slug}/decisions/history#decision-${linkedDecisionId}`, {
            replace: true,
          });
          return;
        }
      }
      setRows(listed);
      clearClosedFollowUps("decision");
      if (linkedDecisionId) setLinkedError(targetError);
      setLoadError(null);
    } catch (err) {
      if (version !== reloadVersion.current) return;
      setLoadError(errorMessage(err, "Could not load the decisions"));
      // Retain the last good list while its inline refresh error is visible.
    }
  }, [company.id, company.slug, linkedDecisionId, clearClosedFollowUps, navigate, sendsToHistory]);

  const reloadDecisionsAfterAction = React.useCallback(
    async (announcement?: string) => {
      await reload();
      if (announcement) setResolutionNotice({ message: announcement });
    },
    [reload],
  );
  const reloadReviewsAfterAction = React.useCallback(
    async (announcement?: string) => {
      await reloadWork();
      if (announcement) setResolutionNotice({ message: announcement });
    },
    [reloadWork],
  );
  // The mixed list holds both kinds; each row refreshes the feed it came from.
  const reloadAfterAction = React.useCallback(
    (announcement: string | undefined, kind: "decision" | "review") =>
      kind === "decision"
        ? reloadDecisionsAfterAction(announcement)
        : reloadReviewsAfterAction(announcement),
    [reloadDecisionsAfterAction, reloadReviewsAfterAction],
  );

  async function retryDecisions() {
    setRetryingDecisions(true);
    try {
      await reload();
    } finally {
      setRetryingDecisions(false);
    }
  }

  async function retryWork() {
    setRetryingWork(true);
    try {
      await reloadWork();
    } finally {
      setRetryingWork(false);
    }
  }

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    setLinkedError(null);
    reload();
    return () => {
      // Advance the latest request counter so every outstanding read is discarded.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      reloadVersion.current++;
    };
  }, [reload]);

  // Live: the pickup session writes its progress to the same rows, so a
  // decision answered on this page fills in its own outcome without a refresh.
  useLiveRefetch("decision", reload);

  // A linked card must not hide behind an earlier search.
  React.useEffect(() => {
    if (linkedDecisionId || linkedReviewId) setSearch("");
  }, [location.key, linkedDecisionId, linkedReviewId]);
  useScrollToStackLink();

  const query = search.trim().toLocaleLowerCase();
  const now = Date.now();
  const followingKeys = new Set(followUps.items.map((item) => item.key));
  const decisionRows = new Map((rows ?? []).map((row) => [row.id, row]));
  const reviewRows = new Map((canReview ? (workReviews ?? []) : []).map((row) => [row.id, row]));
  for (const item of followUps.items) {
    if (item.kind === "loading") {
      if (item.reference.kind === "decision") decisionRows.delete(item.reference.id);
      else reviewRows.delete(item.reference.id);
    } else if (
      item.kind === "decision" &&
      (!stackItemPending(item) || !decisionRows.has(item.decision.id))
    ) {
      decisionRows.set(item.decision.id, item.decision);
    } else if (
      item.kind === "review" &&
      item.outcome &&
      (!stackItemPending(item) || !reviewRows.has(item.approval.id))
    ) {
      reviewRows.set(item.approval.id, item.outcome);
    }
  }
  // Waiting, or followed after an answer until Close; anything else is History's.
  const visibleRows = [...decisionRows.values()].filter((row) =>
    row.status === "pending"
      ? !isFutureSnooze(row, now) && !followUps.hiddenKeys.has(`decision-${row.id}`)
      : followingKeys.has(`decision-${row.id}`),
  );
  const visibleWork = [...reviewRows.values()].filter((row) =>
    row.status === "pending"
      ? !followUps.hiddenKeys.has(`review-${row.id}`)
      : followingKeys.has(`review-${row.id}`),
  );
  const filteredRows = visibleRows.filter((row) => decisionMatches(row, query));
  const shownWork = visibleWork.filter((row) => reviewMatches(row, query));
  const allPending = visibleRows.filter((r) => r.status === "pending").length;
  const pendingWorkCount = visibleWork.filter((approval) => approval.status === "pending").length;
  const mine = filteredRows.filter((r) => r.assignee?.id === me.id);
  const anyone = filteredRows.filter((r) => !r.assignee);
  const assignedElsewhere = filteredRows.filter((r) => r.assignee && r.assignee.id !== me.id);
  const needsYou = [
    ...shownWork.map((approval) => reviewItem(approval, approval)),
    ...[...mine, ...anyone].map(decisionItem),
    ...followUps.items.filter((item) => item.kind === "loading"),
  ]
    .sort(compareStackItems)
    .map((item) => ({
      ...item,
      refreshError: followUps.items.find((followed) => followed.key === item.key)?.refreshError,
    }));
  const followingCount = needsYou.filter((item) => !stackItemPending(item)).length;
  const assignedItems = assignedElsewhere.map(decisionItem);
  // What a selection may act on, in the order the rows are drawn: reviews
  // gather under their group heading, and other Members' questions come last.
  const targets = [
    ...groupStackItems(needsYou).flatMap((entry) =>
      entry.kind === "item" ? [entry.item] : entry.items,
    ),
    ...(canAnswerAssigned ? assignedItems : []),
  ]
    .map(bulkTarget)
    .filter((target): target is BulkTarget => target !== null);
  const targetKeys = new Set(targets.map((target) => target.key));
  const bulk = useStackBulk({
    company,
    targets,
    followUps,
    onDecisionsChanged: reload,
    onReviewsChanged: reloadWork,
    announce: (message) => setResolutionNotice({ message }),
  });
  const listSelection = (label: string): StackListSelection => ({
    label,
    selectable: (item) => targetKeys.has(item.key),
    selected: bulk.keys,
    toggle: bulk.toggle,
    setMany: bulk.setMany,
    disabled: bulk.busy !== null,
  });
  const selectedCount = bulk.selected.length;

  return (
    <div className={clsx("page-shell p-4 sm:p-8", selectedCount > 0 && "pb-28 sm:pb-28")}>
      {/* No settings button here: routing and the stack's other settings live
          together on Decision stack → Settings, one rail link away. */}
      <TopBar title="Decision stack" />
      <p className="mb-5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        What your AI Employees need from you. Answered and dismissed items move to{" "}
        <Link
          to={`/c/${company.slug}/decisions/history`}
          className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Decision history
        </Link>
        .
      </p>
      {resolutionNotice && (
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {resolutionNotice.message}
        </div>
      )}
      {stackSettings && !stackSettings.enabled && (
        <StackOffBanner
          companySlug={company.slug}
          canManage={stackSettings.canManage}
        />
      )}
      {visibleRows.length || visibleWork.length ? (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <StackSearch
            label="Search decision stack"
            placeholder="Search by customer, AI Employee, or context…"
            value={search}
            onChange={setSearch}
          />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {allPending + pendingWorkCount} open{" "}
            {allPending + pendingWorkCount === 1 ? "item" : "items"}
          </span>
        </div>
      ) : null}
      <FormError message={linkedError} className="mb-4" />
      {loadError && (
        <div className="mb-5 space-y-2">
          <FormError message={loadError} />
          <Button
            size="sm"
            variant="secondary"
            loading={retryingDecisions}
            onClick={() => void retryDecisions()}
          >
            Retry Decisions
          </Button>
        </div>
      )}
      {workError && (
        <div className="mb-5 space-y-2">
          <FormError message={workError} />
          <Button
            size="sm"
            variant="secondary"
            loading={retryingWork}
            onClick={() => void retryWork()}
          >
            Retry email and work reviews
          </Button>
        </div>
      )}
      {canReview && workReviews === null && (
        <div className="mb-5 flex items-center gap-2 text-sm text-slate-500">
          <Spinner size={14} /> Loading email and work reviews…
        </div>
      )}
      {alsoWaiting.length > 0 && (
        <p className="mb-5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span>Also waiting:</span>
          {alsoWaiting.map((link, index) => (
            <React.Fragment key={link.key}>
              {index > 0 && <span aria-hidden="true">·</span>}
              <Link
                to={`/c/${company.slug}${link.path}`}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                {link.label}
              </Link>
            </React.Fragment>
          ))}
        </p>
      )}
      {rows === null && workReviews === null ? (
        <Spinner />
      ) : rows !== null &&
        visibleRows.length === 0 &&
        visibleWork.length === 0 &&
        followUps.items.length === 0 &&
        !loadError &&
        !workError &&
        workReviews !== null ? (
        <EmptyState
          title="Decision stack is clear"
          description="Consequential choices and required email reviews appear here with context and a clear next step. Routine preparation stays with your AI Employees."
        />
      ) : query && !filteredRows.length && !shownWork.length ? (
        <EmptyState
          title="No matching items"
          description="Try a customer name, AI Employee, or a word from the context."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {needsYou.length > 0 && (
            <StackSection
              title={
                followingCount > 0
                  ? `Your stack · ${needsYou.filter(stackItemPending).length} waiting · ${followingCount} following`
                  : `Needs you (${needsYou.length})`
              }
            >
              <StackList
                company={company}
                items={needsYou}
                followUps={followUps}
                onResolved={reloadAfterAction}
                viewerId={me.id}
                selection={listSelection("Needs you")}
              />
            </StackSection>
          )}

          {assignedElsewhere.length > 0 && (
            <StackSection title={`Assigned to other Members (${assignedElsewhere.length})`}>
              <StackList
                company={company}
                items={assignedItems}
                followUps={followUps}
                onResolved={reloadDecisionsAfterAction}
                canAnswer={canAnswerAssigned}
                viewerId={me.id}
                selection={
                  canAnswerAssigned ? listSelection("Assigned to other Members") : undefined
                }
              />
            </StackSection>
          )}
        </div>
      )}
      {selectedCount > 0 && (
        <StackBulkBar
          count={selectedCount}
          canSnooze={bulk.selected.every((target) => target.kind === "decision")}
          busy={bulk.busy}
          onDismiss={bulk.dismiss}
          onSnooze={bulk.snooze}
          onClear={bulk.clear}
        />
      )}
    </div>
  );
}

/**
 * Says, above everything else, that new questions are paused — and what is
 * not: the questions already here stay answerable, and email and work
 * reviews keep arriving, because those are gates, not Decisions.
 */
function StackOffBanner({ companySlug, canManage }: { companySlug: string; canManage: boolean }) {
  const banner = decisionStackOffBanner({ canManage });
  return (
    <div
      role="status"
      className="mb-5 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <PauseCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-medium">{banner.title}</p>
        <p className="mt-0.5 leading-relaxed text-amber-800 dark:text-amber-200">{banner.text}</p>
        <Link
          to={`/c/${companySlug}/decisions/settings`}
          className="mt-1 inline-block font-medium text-amber-900 underline underline-offset-2 hover:text-amber-700 dark:text-amber-100 dark:hover:text-white"
        >
          {banner.link}
        </Link>
      </div>
    </div>
  );
}
