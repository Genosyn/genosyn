import React from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAskAiPageContext } from "@/components/askAi/AskAiProvider";
import { TopBar } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { DecisionOutcome } from "@/components/decisions/DecisionOutcome";
import { MailReviewOutcome } from "@/components/decisions/MailReviewCard";
import { WorkReviewOutcome } from "@/components/decisions/WorkReviewCard";
import {
  StackSearch,
  StackSection,
  decisionMatches,
  isStackReview,
  reviewMatches,
  stackLinkFromHash,
  useScrollToStackLink,
} from "@/components/decisions/stackPage";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import {
  api,
  type Approval,
  type Company,
  type Decision,
  type DecisionStatus,
  type Me,
} from "@/lib/api";
import { errorMessage } from "@/lib/errors";

/**
 * Decision history — what has left the Decision stack. Decisions that were
 * answered, dismissed, or expired under the retired deadlines, each with what
 * its AI Employee did next, and for owners and admins the email and work
 * reviews they settled.
 *
 * It sits on its own page so the stack holds only what still needs someone.
 * Each settled status is read on its own, so a burst of new answers never
 * pushes an older dismissal — and its Undismiss — out of reach. A link to
 * something still waiting opens it in the stack instead.
 */

type Settled = Exclude<DecisionStatus, "pending">;
type Filter = "all" | Settled;

const SETTLED: Settled[] = ["decided", "cancelled", "expired"];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "decided", label: "Answered" },
  { id: "cancelled", label: "Dismissed" },
  { id: "expired", label: "Expired (legacy)" },
];

/** When a row was settled — the time it shows, and the order the page reads in. */
function settledAt(decision: Decision): number {
  return Date.parse(decision.decidedAt ?? decision.createdAt) || 0;
}

export default function DecisionHistory({ company, me }: { company: Company; me: Me }) {
  const location = useLocation();
  const navigate = useNavigate();
  const link = stackLinkFromHash(location.hash);
  const linkedDecisionId = link?.kind === "decision" ? link.id : null;
  const linkedReviewId = link?.kind === "review" ? link.id : null;
  // A decision linked from elsewhere (`#decision-<id>`) is the one Ask AI
  // means by "this decision".
  useAskAiPageContext(linkedDecisionId ? [{ kind: "decision", id: linkedDecisionId }] : null);
  const [rows, setRows] = React.useState<Decision[] | null>(null);
  const [reviews, setReviews] = React.useState<Approval[] | null>(null);
  const [filter, setFilter] = React.useState<Filter>("all");
  const [search, setSearch] = React.useState("");
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reviewError, setReviewError] = React.useState<string | null>(null);
  const [linkedError, setLinkedError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [retryingDecisions, setRetryingDecisions] = React.useState(false);
  const [retryingReviews, setRetryingReviews] = React.useState(false);
  const canReview = company.role === "owner" || company.role === "admin";
  const decisionRequest = React.useRef(0);
  const reviewRequest = React.useRef(0);

  // A link resolves once per navigation: one naming something still waiting
  // opens it in the stack. After that — an Undismiss here, or another
  // Member's change — the reader stays on this page.
  const linkKey = React.useRef("");
  linkKey.current = `${location.key}:${location.hash}`;
  const resolvedLink = React.useRef<string | null>(null);
  const sendsToStack = React.useCallback((key: string, waiting: boolean) => {
    if (resolvedLink.current === key) return false;
    resolvedLink.current = key;
    return waiting;
  }, []);

  const reload = React.useCallback(async () => {
    const version = ++decisionRequest.current;
    const key = linkKey.current;
    try {
      const lists = await Promise.all(
        SETTLED.map((status) =>
          api.get<Decision[]>(`/api/companies/${company.id}/decisions?status=${status}&limit=200`),
        ),
      );
      // A row that changed status between the reads is listed once.
      const listed = [...new Map(lists.flat().map((row) => [row.id, row])).values()];
      let targetError: string | null = null;
      let waiting = false;
      // A saved discussion can link a Decision older than the newest 200 of its kind.
      if (linkedDecisionId && !listed.some((row) => row.id === linkedDecisionId)) {
        try {
          const linked = await api.get<Decision>(
            `/api/companies/${company.id}/decisions/${linkedDecisionId}`,
          );
          if (linked.status === "pending") waiting = true;
          else listed.push(linked);
        } catch (err) {
          targetError = `Could not open the linked decision: ${errorMessage(err)}`;
        }
      }
      if (version !== decisionRequest.current) return;
      if (linkedDecisionId && sendsToStack(key, waiting)) {
        navigate(`/c/${company.slug}/decisions#decision-${linkedDecisionId}`, { replace: true });
        return;
      }
      setRows(listed.sort((a, b) => settledAt(b) - settledAt(a)));
      if (linkedDecisionId) setLinkedError(targetError);
      setLoadError(null);
    } catch (err) {
      if (version !== decisionRequest.current) return;
      setLoadError(errorMessage(err, "Could not load the decision history"));
      // Retain the last good list while its inline refresh error is visible.
    }
  }, [company.id, company.slug, linkedDecisionId, navigate, sendsToStack]);

  const reloadReviews = React.useCallback(async () => {
    const version = ++reviewRequest.current;
    // Email and work reviews are admin-gated Approvals; Members never read them.
    if (!canReview) {
      setReviews([]);
      setReviewError(null);
      return;
    }
    const key = linkKey.current;
    try {
      const approvals = await api.get<Approval[]>(
        `/api/companies/${company.id}/approvals?kind=decision_stack`,
      );
      let targetError: string | null = null;
      // The list carries only the newest settled reviews.
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
      if (version !== reviewRequest.current) return;
      const waiting = approvals.some(
        (approval) =>
          approval.id === linkedReviewId &&
          isStackReview(approval) &&
          approval.status === "pending",
      );
      if (linkedReviewId && sendsToStack(key, waiting)) {
        navigate(`/c/${company.slug}/decisions#review-${linkedReviewId}`, { replace: true });
        return;
      }
      setReviews(
        approvals.filter((approval) => isStackReview(approval) && approval.status !== "pending"),
      );
      setReviewError(null);
      if (linkedReviewId) setLinkedError(targetError);
    } catch (err) {
      if (version !== reviewRequest.current) return;
      setReviewError(errorMessage(err, "Could not load email and work reviews"));
      setReviews((current) => current ?? []);
    }
  }, [company.id, company.slug, canReview, linkedReviewId, navigate, sendsToStack]);

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    setLinkedError(null);
    void reload();
    return () => {
      // Advance the latest request counter so every outstanding read is discarded.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      decisionRequest.current++;
    };
  }, [reload]);
  React.useEffect(() => {
    setReviews(null);
    setReviewError(null);
    void reloadReviews();
    return () => {
      // Invalidate outstanding reads; this counter is not a rendered-node ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      reviewRequest.current++;
    };
  }, [reloadReviews]);

  // Live: a pickup session still reporting on an answered Decision writes to
  // the same rows, so its outcome fills in here without a refresh.
  useLiveRefetch("decision", reload);
  useLiveRefetch("approval", reloadReviews);

  // A linked row must not hide behind an earlier filter or search.
  React.useEffect(() => {
    if (linkedDecisionId || linkedReviewId) {
      setFilter("all");
      setSearch("");
    }
  }, [location.key, linkedDecisionId, linkedReviewId]);
  useScrollToStackLink();

  const afterRestore = React.useCallback(
    async (announcement?: string) => {
      // The restored Decision is waiting again, so it leaves this list for the stack.
      await reload();
      if (announcement) setNotice(announcement);
    },
    [reload],
  );

  async function retryDecisions() {
    setRetryingDecisions(true);
    try {
      await reload();
    } finally {
      setRetryingDecisions(false);
    }
  }

  async function retryReviews() {
    setRetryingReviews(true);
    try {
      await reloadReviews();
    } finally {
      setRetryingReviews(false);
    }
  }

  const query = search.trim().toLocaleLowerCase();
  const decisions = rows ?? [];
  const settledReviews = canReview ? (reviews ?? []) : [];
  const matching = decisions.filter((row) => decisionMatches(row, query));
  const shown = matching.filter((row) => filter === "all" || row.status === filter);
  const working = matching.filter((row) => row.pickupStatus === "running").length;
  const matchingReviews = settledReviews.filter((row) => reviewMatches(row, query));

  return (
    <div className="page-shell p-4 sm:p-8">
      <TopBar title="Decision history" />
      <p className="mb-5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        {canReview
          ? "Answered and dismissed decisions, and settled email and work reviews, with what happened next."
          : "Answered and dismissed decisions, with what happened next."}{" "}
        Anything still waiting stays in the stack.
      </p>
      {notice && (
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {notice}
        </div>
      )}
      {decisions.length || settledReviews.length ? (
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <StackSearch
            label="Search decision history"
            placeholder="Search by customer, AI Employee, or outcome…"
            value={search}
            onChange={setSearch}
          />
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
            Retry decision history
          </Button>
        </div>
      )}
      {reviewError && (
        <div className="mb-5 space-y-2">
          <FormError message={reviewError} />
          <Button
            size="sm"
            variant="secondary"
            loading={retryingReviews}
            onClick={() => void retryReviews()}
          >
            Retry email and work reviews
          </Button>
        </div>
      )}
      {canReview && reviews === null && rows !== null && (
        <div className="mb-5 flex items-center gap-2 text-sm text-slate-500">
          <Spinner size={14} /> Loading email and work reviews…
        </div>
      )}
      {rows === null ? (
        !loadError && <Spinner />
      ) : !decisions.length && !settledReviews.length && reviews !== null ? (
        !loadError &&
        !reviewError && (
          <EmptyState
            title="No decision history yet"
            description="Decisions appear here once they are answered or dismissed, with what the AI Employee did next."
          />
        )
      ) : query && !matching.length && !matchingReviews.length ? (
        <EmptyState
          title="No matching items"
          description="Try a customer name, AI Employee, or a word from the outcome."
        />
      ) : (
        <div className="flex flex-col gap-6">
          {matching.length > 0 && (
            <StackSection
              title="Decisions"
              aside={
                <>
                  {working > 0 && (
                    <span className="rounded-full bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300">
                      {working} being worked on now
                    </span>
                  )}
                  <div
                    role="group"
                    aria-label="Show decisions"
                    className="ml-auto flex items-center gap-1"
                  >
                    {FILTERS.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        aria-pressed={filter === f.id}
                        onClick={() => setFilter(f.id)}
                        className={clsx(
                          "rounded-md px-2 py-0.5 text-[11px] font-medium transition",
                          filter === f.id
                            ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                            : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800",
                        )}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </>
              }
            >
              {shown.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  Nothing in this state yet.
                </div>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {shown.map((d) => (
                    <DecisionOutcome
                      key={d.id}
                      company={company}
                      decision={d}
                      onRestored={afterRestore}
                      canRestore={!d.assignee || d.assignee.id === me.id || canReview}
                    />
                  ))}
                </ul>
              )}
            </StackSection>
          )}

          {matchingReviews.length > 0 && (
            <StackSection title="Email and work reviews">
              <ul className="space-y-3">
                {matchingReviews.map((approval) =>
                  approval.kind === "mail_send" ? (
                    <MailReviewOutcome key={approval.id} company={company} approval={approval} />
                  ) : (
                    <WorkReviewOutcome key={approval.id} company={company} approval={approval} />
                  ),
                )}
              </ul>
            </StackSection>
          )}
        </div>
      )}
    </div>
  );
}
