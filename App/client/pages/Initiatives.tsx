import React from "react";
import {
  api,
  Company,
  Employee,
  Initiative,
  InitiativeStatus,
  Me,
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
import { cronHuman, cronIsReadable } from "../lib/cron";

/**
 * Initiatives — standing work AI employees proposed for the company (M54).
 *
 * Each row carries the evidence the employee gathered, what it proposes, and
 * the exact Routine that accepting creates — spec'd up front so the human is
 * approving a schedule, not a vibe. Accept CREATES that Routine, owned by the
 * proposer; decline records why. Reads are member-level; Accept/Decline are
 * admin/owner-only, so this page simply declines to offer the buttons to
 * plain members.
 */

type Filter = InitiativeStatus | "all";

const FILTERS: Array<[Filter, string]> = [
  ["pending", "Pending"],
  ["accepted", "Accepted"],
  ["declined", "Declined"],
  ["all", "All"],
];

const STATUS_LABEL: Record<InitiativeStatus, string> = {
  pending: "Pending",
  accepted: "Accepted",
  declined: "Declined",
};

const STATUS_CHIP: Record<InitiativeStatus, string> = {
  pending: "bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  accepted: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  declined: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
};

const EMPTY_COPY: Record<Filter, { title: string; description: string }> = {
  pending: {
    title: "Nothing proposed",
    description:
      "Employees file initiatives when they notice work the company should be doing on a schedule.",
  },
  accepted: {
    title: "No accepted initiatives yet",
    description: "When you accept one, the decision — and the Routine it created — is kept here.",
  },
  declined: {
    title: "No declined initiatives",
    description: "When you decline an initiative, the decision is kept here for the record.",
  },
  all: {
    title: "No initiatives yet",
    description:
      "Employees file initiatives when they notice work the company should be doing on a schedule. Every one — pending or decided — shows up here.",
  },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function Initiatives({ company }: { company: Company; me: Me }) {
  const [rows, setRows] = React.useState<Initiative[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<Filter>("pending");
  const [employees, setEmployees] = React.useState<Employee[]>([]);

  const canManage = company.role === "owner" || company.role === "admin";

  const reload = React.useCallback(async () => {
    try {
      const qs = filter === "all" ? "" : `?status=${filter}`;
      setRows(await api.get<Initiative[]>(`/api/companies/${company.id}/initiatives${qs}`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the initiatives"));
      setRows([]);
    }
  }, [company.id, filter]);

  React.useEffect(() => {
    setRows(null);
    setLoadError(null);
    void reload();
  }, [reload]);

  // Live: an employee filing a new initiative, or another admin deciding one,
  // lands on this list without a manual reload.
  useLiveRefetch("initiative", reload);

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

  return (
    <div className="page-shell p-8">
      <TopBar
        title="Initiatives"
        right={
          rows !== null && rows.length > 0 ? (
            <span className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {rows.length === 1 ? "1 initiative" : `${rows.length} initiatives`}
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
          {rows.map((initiative) => (
            <InitiativeCard
              key={initiative.id}
              company={company}
              initiative={initiative}
              employee={employeesById.get(initiative.employeeId) ?? null}
              canManage={canManage}
              onChanged={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── one card ────────────────────────────────

function InitiativeCard({
  company,
  initiative,
  employee,
  canManage,
  onChanged,
}: {
  company: Company;
  initiative: Initiative;
  employee: Employee | null;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [confirm, setConfirm] = React.useState<"accept" | "decline" | null>(null);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function decide(action: "accept" | "decline") {
    setBusy(true);
    setError(null);
    try {
      const trimmed = note.trim();
      await api.post(
        `/api/companies/${company.id}/initiatives/${initiative.id}/${action}`,
        trimmed ? { note: trimmed } : {},
      );
      setConfirm(null);
      setNote("");
      onChanged();
    } catch (err) {
      setError(
        errorMessage(
          err,
          action === "accept"
            ? "Could not accept the initiative"
            : "Could not decline the initiative",
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  const spec = initiative.routineSpec;

  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={clsx(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
              STATUS_CHIP[initiative.status],
            )}
          >
            {STATUS_LABEL[initiative.status]}
          </span>
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {employee?.name ?? "A former employee"}
          </span>
          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate text-sm text-slate-700 dark:text-slate-300">
            {initiative.title}
          </span>
          <span className="shrink-0 text-xs text-slate-400 dark:text-slate-500">
            Proposed {formatDate(initiative.createdAt)}
          </span>
        </div>

        <CollapsibleEvidence text={initiative.evidence} />

        <div className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
          {initiative.proposal}
        </div>

        {spec && (
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
              What accept creates
            </div>
            <div className="flex flex-col gap-1.5 text-sm">
              <div className="font-medium text-slate-900 dark:text-slate-100">{spec.name}</div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                <code className="rounded bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                  {spec.cronExpr}
                </code>
                {cronIsReadable(spec.cronExpr) && (
                  <span className="ml-2">{cronHuman(spec.cronExpr)}</span>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50/60 px-3 py-2 font-mono text-xs leading-5 text-slate-700 dark:bg-slate-950/40 dark:text-slate-300">
                {spec.body}
              </div>
              {spec.acceptanceCriteria?.trim() && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  <span className="font-medium">Acceptance criteria:</span>{" "}
                  <span className="whitespace-pre-wrap">{spec.acceptanceCriteria}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {!spec && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            The stored routine spec is malformed — accepting would refuse it.
          </div>
        )}

        {initiative.decidedAt && (
          <div className="text-xs text-slate-400 dark:text-slate-500">
            {STATUS_LABEL[initiative.status]} {formatDate(initiative.decidedAt)}
            {initiative.reviewNote && ` — “${initiative.reviewNote}”`}
          </div>
        )}
        {initiative.status === "accepted" && initiative.createdRoutineId && (
          <div className="text-xs text-slate-400 dark:text-slate-500">
            Routine created — it now runs on {employee?.name ?? "the proposer"}&apos;s schedule
            like any other.
          </div>
        )}

        {canManage && initiative.status === "pending" && (
          <div>
            <FormError message={error} className="mb-3" />
            {confirm === null ? (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => setConfirm("accept")}>
                  Accept
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setConfirm("decline")}>
                  Decline
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-200">
                  {confirm === "accept"
                    ? "Accept this initiative? The Routine above is created right away, owned by the proposing employee."
                    : "Decline this initiative? Nothing is created."}
                </div>
                <Textarea
                  label="Note (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="min-h-[60px]"
                  placeholder={
                    confirm === "accept"
                      ? "Anything the employee should know about this acceptance."
                      : "Why not — the employee learns from this."
                  }
                  hint="The employee reads this note in its journal."
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant={confirm === "decline" ? "danger" : "primary"}
                    disabled={busy}
                    onClick={() => void decide(confirm)}
                  >
                    {confirm === "accept" ? "Accept initiative" : "Decline initiative"}
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
    </Card>
  );
}

// ───────────────────────────── the evidence ──────────────────────────────

/**
 * The employee's evidence, markdown-ish plain text. Long dossiers collapse
 * past ~6 lines behind a Show more toggle so a stacked queue stays scannable;
 * short ones render in full with no chrome.
 */
function CollapsibleEvidence({ text }: { text: string }) {
  const [expanded, setExpanded] = React.useState(false);
  const long = text.split("\n").length > 6 || text.length > 600;

  return (
    <div>
      <div
        className={clsx(
          "whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300",
          long && !expanded && "line-clamp-6",
        )}
      >
        {text}
      </div>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
