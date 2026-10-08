import React from "react";
import { Plus, Settings2, Trash2 } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAskAiPageContext } from "@/components/askAi/AskAiProvider";
import { api, Approval, Company, Decision, DecisionPolicyRule, Employee, Me } from "../lib/api";
import { hasRetiredRoutingRules, routingRuleLabel } from "../lib/decisionRouting";
import { errorMessage } from "../lib/errors";
import { DecisionStackCard } from "@/components/decisions/DecisionStackCard";
import {
  StackSearch,
  StackSection,
  decisionMatches,
  isStackReview,
  reviewMatches,
  stackLinkFromHash,
  useScrollToStackLink,
} from "@/components/decisions/stackPage";
import {
  compareStackItems,
  decisionItem,
  reviewItem,
  stackItemPending,
  useDecisionFollowUps,
} from "@/components/decisions/useDecisionFollowUps";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Modal } from "../components/ui/Modal";
import { Select } from "../components/ui/Select";
import { ButtonSpinner, Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { clsx } from "../components/ui/clsx";
import { EnabledToggle } from "./RevenueSignals";

/**
 * The Decision Stack — every question an AI Employee raised for a Member, and
 * every email or work review, that is still waiting on someone.
 *
 * The split that matters is **assigned to you** versus
 * **anyone can answer**: an employee that named a Member did so because that
 * person holds the context, and burying those in one long list is how a
 * question addressed to somebody specific sits for three days.
 *
 * A card you act on stays where it is while you follow it — answering starts
 * the employee's work session, and its report comes back onto the card — until
 * you close it. Everything already settled lives on its own page,
 * `DecisionHistory`, so this one only ever holds what still needs someone. A
 * link to a settled item (`#decision-<id>`, `#review-<id>`) is sent on there.
 */

function isFutureSnooze(decision: Decision, now: number): boolean {
  if (decision.status !== "pending" || !decision.snoozedUntil) return false;
  const until = Date.parse(decision.snoozedUntil);
  return Number.isFinite(until) && until > now;
}

export default function Decisions({ company, me }: { company: Company; me: Me }) {
  const location = useLocation();
  const navigate = useNavigate();
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
  const [routingOpen, setRoutingOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [workReviews, setWorkReviews] = React.useState<Approval[] | null>(null);
  const [workError, setWorkError] = React.useState<string | null>(null);
  const [resolutionNotice, setResolutionNotice] = React.useState<{ message: string } | null>(null);
  const [retryingDecisions, setRetryingDecisions] = React.useState(false);
  const [retryingWork, setRetryingWork] = React.useState(false);
  const canReview = company.role === "owner" || company.role === "admin";
  const workRequest = React.useRef(0);
  const followUps = useDecisionFollowUps(company, me.id);
  const clearClosedFollowUps = followUps.clearClosed;

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

  return (
    <div className="page-shell p-4 sm:p-8">
      <TopBar
        title="Decision stack"
        right={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRoutingOpen(true)}
            title="Which AI decider answers whose questions before humans are paged"
          >
            <Settings2 size={14} /> Routing
          </Button>
        }
      />
      {routingOpen && <RoutingModal company={company} onClose={() => setRoutingOpen(false)} />}
      <p className="mb-5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        Major choices that need your judgment. Your AI Employees handle routine preparation within
        their Grants. Reviewed email replies stay in Genosyn until an owner or admin sends or
        discards them. After you act, follow the timeline here and close the card when you are done;
        it stays in{" "}
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
      {canReview && (
        <Link
          to={`/c/${company.slug}/approvals`}
          className="mb-5 inline-block text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Other Approvals
        </Link>
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
              <Stack>
                {needsYou.map((item) => (
                  <DecisionStackCard
                    key={item.key}
                    company={company}
                    item={item}
                    followUps={followUps}
                    onResolved={
                      item.kind === "decision"
                        ? reloadDecisionsAfterAction
                        : reloadReviewsAfterAction
                    }
                  />
                ))}
              </Stack>
            </StackSection>
          )}

          {assignedElsewhere.length > 0 && (
            <StackSection title={`Assigned to other Members (${assignedElsewhere.length})`}>
              <Stack>
                {assignedElsewhere.map((d) => (
                  <DecisionStackCard
                    key={d.id}
                    company={company}
                    item={decisionItem(d)}
                    followUps={followUps}
                    onResolved={reloadDecisionsAfterAction}
                    canAnswer={company.role === "owner" || company.role === "admin"}
                  />
                ))}
              </Stack>
            </StackSection>
          )}
        </div>
      )}
    </div>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
      {children}
    </ul>
  );
}

// ───────────────────────── routing rules (M53a) ──────────────────────────

/**
 * The decision-rights matrix behind the header gear: which AI decider a
 * question is routed to before the human bell rings. Reads are member-level —
 * every Member can see who answers for whom — but the controls are admin-only,
 * because a rule redirects questions away from human inboxes. Server 400s
 * (self-answer, a missing decider) surface inline. Every rule names its
 * decider; a "their manager" rule saved before reporting lines were removed
 * still lists, marked retired, so an admin can see why it no longer routes.
 */
function RoutingModal({ company, onClose }: { company: Company; onClose: () => void }) {
  const [rules, setRules] = React.useState<DecisionPolicyRule[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [rowError, setRowError] = React.useState<string | null>(null);
  const [busyRuleId, setBusyRuleId] = React.useState<string | null>(null);
  const [removingRuleId, setRemovingRuleId] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const canManage = company.role === "owner" || company.role === "admin";
  const base = `/api/companies/${company.id}/decision-policies`;

  const reload = React.useCallback(async () => {
    try {
      setRules(await api.get<DecisionPolicyRule[]>(base));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the routing rules"));
      setRules([]);
    }
  }, [base]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Policy edits ride the "decision" live-sync kind, so another admin's change
  // lands here without a reopen.
  useLiveRefetch("decision", reload);

  React.useEffect(() => {
    let cancelled = false;
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then((list) => {
        if (!cancelled) setEmployees(list);
      })
      .catch(() => {
        if (!cancelled) setEmployees([]);
      });
    return () => {
      cancelled = true;
    };
  }, [company.id]);

  const employeesById = React.useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  async function toggle(rule: DecisionPolicyRule, enabled: boolean) {
    setBusyRuleId(rule.id);
    setRowError(null);
    try {
      await api.patch(`${base}/${rule.id}`, { enabled });
      await reload();
    } catch (err) {
      setRowError(errorMessage(err, "Could not update the rule"));
    } finally {
      setBusyRuleId(null);
    }
  }

  async function remove(rule: DecisionPolicyRule) {
    setBusyRuleId(rule.id);
    setRemovingRuleId(rule.id);
    setRowError(null);
    try {
      await api.del(`${base}/${rule.id}`);
      await reload();
    } catch (err) {
      setRowError(errorMessage(err, "Could not delete the rule"));
    } finally {
      setBusyRuleId(null);
      setRemovingRuleId(null);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Routing"
      description="Routed questions skip the human bell; a decline or 4 hours of silence pages humans as before."
      size="lg"
      footer={
        <Button variant="secondary" type="button" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {loadError ? (
          <FormError message={loadError} />
        ) : rules === null ? (
          <Spinner />
        ) : (
          <>
            <FormError message={rowError} />
            {rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-200 p-4 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
                No routing rules yet — every question pages humans directly.
              </div>
            ) : (
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
                {rules.map((rule) => {
                  const { asking, decider, retired } = routingRuleLabel(rule, employeesById);
                  return (
                    <li key={rule.id} className="flex items-center gap-3 px-3 py-2">
                      <div
                        className={clsx(
                          "min-w-0 flex-1 text-sm",
                          rule.enabled
                            ? "text-slate-700 dark:text-slate-200"
                            : "text-slate-400 dark:text-slate-500",
                        )}
                      >
                        <span className="font-medium">{asking}</span>
                        <span className="mx-1.5 text-slate-400 dark:text-slate-500">→</span>
                        <span>{decider}</span>
                        {retired && (
                          <span className="ml-2 whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                            was their manager
                          </span>
                        )}
                      </div>
                      {canManage ? (
                        <>
                          <EnabledToggle
                            enabled={rule.enabled}
                            label={`${rule.enabled ? "Disable" : "Enable"} routing ${asking} → ${decider}`}
                            disabled={busyRuleId !== null}
                            onChange={(next) => void toggle(rule, next)}
                          />
                          <button
                            type="button"
                            onClick={() => void remove(rule)}
                            disabled={busyRuleId !== null}
                            aria-busy={removingRuleId === rule.id || undefined}
                            aria-label={`Delete routing ${asking} → ${decider}`}
                            className="rounded p-1 text-slate-400 transition hover:bg-slate-100 hover:text-red-600 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-red-400"
                          >
                            {removingRuleId === rule.id ? (
                              <ButtonSpinner size={14} />
                            ) : (
                              <Trash2 size={14} />
                            )}
                          </button>
                        </>
                      ) : (
                        !rule.enabled && (
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                            off
                          </span>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {hasRetiredRoutingRules(rules) && (
              <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                Rules that sent questions to “their manager” stopped routing when reporting lines
                were removed, so those questions page people. To route them again, delete the rule
                and add one that names the employee who answers.
              </p>
            )}
            {canManage && (
              <AddRuleForm base={base} employees={employees} onAdded={() => void reload()} />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function AddRuleForm({
  base,
  employees,
  onAdded,
}: {
  base: string;
  employees: Employee[];
  onAdded: () => void;
}) {
  const [askingEmployeeId, setAskingEmployeeId] = React.useState("");
  const [deciderEmployeeId, setDeciderEmployeeId] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deciderEmployeeId) {
      setError("Pick the employee who answers.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Every rule names its decider; there is no reporting line to follow.
      await api.post(base, {
        askingEmployeeId: askingEmployeeId || null,
        deciderKind: "employee",
        deciderEmployeeId,
      });
      setAskingEmployeeId("");
      setDeciderEmployeeId("");
      onAdded();
    } catch (err) {
      setError(errorMessage(err, "Could not add the rule"));
    } finally {
      setSaving(false);
    }
  }

  return (
    // noValidate: the browser's own check on the required decider would only
    // move focus, silently; `save` says what is missing, inline, instead.
    <form noValidate onSubmit={save} className="flex flex-col gap-3">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Add a rule
      </div>
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label="Questions from"
          value={askingEmployeeId}
          onChange={(e) => {
            const next = e.target.value;
            setAskingEmployeeId(next);
            // An employee never answers its own questions, so the decider
            // list drops whoever now asks — clear a pick it no longer offers.
            if (next && next === deciderEmployeeId) setDeciderEmployeeId("");
          }}
        >
          <option value="">Any employee</option>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        <Select
          label="Are answered by"
          value={deciderEmployeeId}
          onChange={(e) => setDeciderEmployeeId(e.target.value)}
          required
        >
          <option value="">Choose an employee…</option>
          {employees
            .filter((e) => e.id !== askingEmployeeId)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
        </Select>
      </div>
      <div>
        <Button type="submit" size="sm" loading={saving}>
          <Plus size={14} /> Add rule
        </Button>
      </div>
    </form>
  );
}
