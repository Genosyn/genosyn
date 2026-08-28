import React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  api,
  Company,
  Employee,
  Me,
  RevisionProposal,
  RevisionProposalKind,
  RevisionProposalStatus,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { Textarea } from "../components/ui/Textarea";
import { clsx } from "../components/ui/clsx";
import { DiffLine, diffLines } from "../lib/revisionDiff";

/**
 * Revisions — the review queue for Soul, Skill, and Routine edits AI
 * employees proposed for themselves (M52).
 *
 * A proposal carries the exact body it was diffed against (`baseBody`), so
 * the before/after view here is what the server will apply — and when the
 * live document has drifted since, Apply refuses with a 400 and stamps
 * `errorMessage` on the row rather than clobbering someone's newer edit.
 * Reads are member-level; Apply/Reject are admin/owner-only, so this page
 * simply declines to offer the buttons to plain members.
 */

type Filter = RevisionProposalStatus | "all";

const FILTERS: Array<[Filter, string]> = [
  ["pending", "Pending"],
  ["applied", "Applied"],
  ["rejected", "Rejected"],
  ["all", "All"],
];

const STATUS_LABEL: Record<RevisionProposalStatus, string> = {
  pending: "Pending",
  applied: "Applied",
  rejected: "Rejected",
};

const STATUS_CHIP: Record<RevisionProposalStatus, string> = {
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  applied: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  rejected: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

const KIND_LABEL: Record<RevisionProposalKind, string> = {
  soul: "Soul",
  skill: "Skill",
  routine_body: "Routine brief",
  routine_criteria: "Acceptance criteria",
};

const EMPTY_COPY: Record<Filter, { title: string; description: string }> = {
  pending: {
    title: "Nothing is waiting for review",
    description:
      "Employees propose revisions to their own Soul, Skills, and Routines when their retrospectives find a durable fix. New proposals land here for a human to apply or reject.",
  },
  applied: {
    title: "No applied revisions yet",
    description: "When you apply a proposal, the decision is kept here for the record.",
  },
  rejected: {
    title: "No rejected revisions",
    description: "When you reject a proposal, the decision is kept here for the record.",
  },
  all: {
    title: "No revision proposals yet",
    description:
      "Employees propose revisions to their own Soul, Skills, and Routines when their retrospectives find a durable fix. Every proposal — pending or decided — shows up here.",
  },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function Revisions({ company }: { company: Company; me: Me }) {
  const [rows, setRows] = React.useState<RevisionProposal[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>("pending");
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());

  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      const qs = filter === "all" ? "" : `?status=${filter}`;
      setRows(
        await api.get<RevisionProposal[]>(`/api/companies/${company.id}/revision-proposals${qs}`),
      );
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the revision proposals"));
      setRows([]);
    }
  }, [company.id, filter]);

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    void reload();
  }, [reload]);

  // Live: a retrospective staging a new proposal, or another admin deciding
  // one, lands on this list without a manual reload.
  useLiveRefetch("revision", reload);

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

  const employeesById = React.useMemo(
    () => new Map(employees.map((e) => [e.id, e])),
    [employees],
  );

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="page-shell p-8">
      <TopBar
        title="Revisions"
        right={
          rows !== null && rows.length > 0 ? (
            <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {rows.length === 1 ? "1 proposal" : `${rows.length} proposals`}
            </span>
          ) : undefined
        }
      />

      <div className="mb-4 flex w-fit gap-1 rounded-lg border border-slate-200 p-1 dark:border-slate-700">
        {FILTERS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={clsx(
              "rounded-md px-3 py-1 text-sm font-medium transition",
              filter === key
                ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {loadError ? (
        <FormError message={loadError} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState title={EMPTY_COPY[filter].title} description={EMPTY_COPY[filter].description} />
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              company={company}
              proposal={proposal}
              employee={employeesById.get(proposal.employeeId) ?? null}
              canManage={canManage}
              expanded={expanded.has(proposal.id)}
              onToggle={() => toggle(proposal.id)}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── one card ────────────────────────────────

function ProposalCard({
  company,
  proposal,
  employee,
  canManage,
  expanded,
  onToggle,
  onChanged,
}: {
  company: Company;
  proposal: RevisionProposal;
  employee: Employee | null;
  canManage: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const [confirm, setConfirm] = React.useState<"apply" | "reject" | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const diff = React.useMemo(
    () => (expanded ? diffLines(proposal.baseBody, proposal.proposedBody) : []),
    [expanded, proposal.baseBody, proposal.proposedBody],
  );

  async function decide(action: "apply" | "reject") {
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      await api.post(
        `/api/companies/${company.id}/revision-proposals/${proposal.id}/${action}`,
        trimmed ? { note: trimmed } : {},
      );
      setConfirm(null);
      setNote("");
      onChanged();
    } catch (err) {
      setError(
        errorMessage(
          err,
          action === "apply" ? "Could not apply the proposal" : "Could not reject the proposal",
        ),
      );
      // A drift refusal also stamps `errorMessage` on the row server-side —
      // refetch so the rose note under the header matches what it now holds.
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  const evidenceCount = proposal.evidenceRunIds.length;

  return (
    <Card>
      <div className="flex items-start gap-2 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
        >
          <span className="mt-0.5 shrink-0 text-slate-400 dark:text-slate-500">
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span
                className={clsx(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  STATUS_CHIP[proposal.status],
                )}
              >
                {STATUS_LABEL[proposal.status]}
              </span>
              <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
                {employee?.name ?? "A former employee"}
              </span>
              <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
                ·
              </span>
              <span className="text-sm text-slate-500 dark:text-slate-400">
                {KIND_LABEL[proposal.kind]}
              </span>
              <span className="min-w-0 truncate text-sm text-slate-700 dark:text-slate-300">
                {proposal.targetLabel}
              </span>
            </span>
            <span className="mt-1 block whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">
              {proposal.rationale}
            </span>
            <span className="mt-1 block text-xs text-slate-400 dark:text-slate-500">
              Proposed {formatDate(proposal.createdAt)}
              {evidenceCount > 0 &&
                ` · Cites ${evidenceCount === 1 ? "1 run" : `${evidenceCount} runs`}`}
            </span>
            {proposal.decidedAt && (
              <span className="mt-1 block text-xs text-slate-400 dark:text-slate-500">
                {STATUS_LABEL[proposal.status]} {formatDate(proposal.decidedAt)}
                {proposal.reviewNote && ` — “${proposal.reviewNote}”`}
              </span>
            )}
            {proposal.errorMessage && (
              <span className="mt-2 block rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
                {proposal.errorMessage}
              </span>
            )}
          </span>
        </button>
        <Button variant="ghost" size="sm" onClick={onToggle} className="shrink-0">
          {expanded ? "Hide" : "Review"}
        </Button>
      </div>

      {expanded && (
        <div className="border-t border-slate-100 p-4 dark:border-slate-800">
          <div className="grid gap-3 md:grid-cols-2">
            <DiffColumn title="Current" side="left" lines={diff} />
            <DiffColumn title="Proposed" side="right" lines={diff} />
          </div>

          {canManage && proposal.status === "pending" && (
            <div className="mt-4">
              <FormError message={error} className="mb-3" />
              {confirm === null ? (
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => setConfirm("apply")}>
                    Apply
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setConfirm("reject")}>
                    Reject
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                    {confirm === "apply"
                      ? `Apply this revision? The proposed text replaces the current ${KIND_LABEL[proposal.kind]} right away.`
                      : "Reject this revision? The document stays as it is."}
                  </div>
                  <Textarea
                    label="Note (optional)"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    className="min-h-[60px]"
                    placeholder={
                      confirm === "apply"
                        ? "Anything the employee should know about this approval."
                        : "Why not — the employee learns from this."
                    }
                    hint="The employee reads this note in its journal."
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={confirm === "reject" ? "danger" : "primary"}
                      disabled={busy}
                      onClick={() => void decide(confirm)}
                    >
                      {confirm === "apply" ? "Apply revision" : "Reject revision"}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setConfirm(null);
                        setError(null);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ────────────────────────────── the diff ─────────────────────────────────

/**
 * One side of the before/after view. Both columns walk the same diff rows in
 * document order; the left drops `added` rows, the right drops `removed`
 * ones, so shared context lines up well enough to read without gutters.
 */
function DiffColumn({
  title,
  side,
  lines,
}: {
  title: string;
  side: "left" | "right";
  lines: DiffLine[];
}) {
  const visible = lines.filter((l) => (side === "left" ? l.kind !== "added" : l.kind !== "removed"));
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
        {title}
      </div>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/60 py-1 dark:border-slate-800 dark:bg-slate-950/40">
        {visible.length === 0 ? (
          <div className="px-3 py-1 text-xs italic text-slate-400 dark:text-slate-500">Empty</div>
        ) : (
          visible.map((line, idx) => (
            <div
              key={idx}
              className={clsx(
                "whitespace-pre-wrap break-words px-3 font-mono text-xs leading-5",
                line.kind === "removed" &&
                  "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
                line.kind === "added" &&
                  "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                line.kind === "same" && "text-slate-600 dark:text-slate-300",
              )}
            >
              {line.text === "" ? "\u00A0" : line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
