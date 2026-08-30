import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { Bot, ChevronDown, ChevronRight, ScrollText, X } from "lucide-react";
import {
  api,
  auditQuery,
  AuditEvent,
  AuditFilters,
  AuditPage,
  type AuditActorKind,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Card, CardBody } from "../components/ui/Card";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { FeatureGateCard } from "../components/FeatureGateCard";
import { Select } from "../components/ui/Select";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Append-only audit trail for a company. Server writes events at mutation
 * points via `recordAudit`. Here we render them, newest-first, with a friendly
 * summary line and an expandable raw-JSON payload for forensics.
 *
 * The page grew filters in M58 because a flat newest-200 feed is browsable and
 * not investigable: the first question after a bad autonomous night is "what
 * did that employee, or that Run, actually touch", and the log held the answer
 * without any way to ask it. An AI Employee's rows also rendered as "System"
 * until now, which made the most interesting actor in the table the one it
 * could not name.
 *
 * The reading surface is edition/plan-gated (M56): without the `auditLog`
 * entitlement we show the upgrade card and never fetch — the server keeps
 * writing events regardless, so history exists the day they upgrade. Reading
 * what ONE Run did is deliberately not gated; that lives on the Run itself.
 */

const PAGE_SIZE = 200;

const ACTOR_KINDS: { value: AuditActorKind | ""; label: string }[] = [
  { value: "", label: "Anyone" },
  { value: "ai", label: "AI employees" },
  { value: "user", label: "Members" },
  { value: "cron", label: "Scheduler" },
  { value: "webhook", label: "Webhooks" },
  { value: "system", label: "System" },
];

export default function AuditLog() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const gated = !company.entitlements.features.auditLog;
  const [rows, setRows] = React.useState<AuditEvent[] | null>(null);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [employees, setEmployees] = React.useState<
    { id: string; slug: string; name: string; role: string }[]
  >([]);
  const [filters, setFilters] = React.useState<AuditFilters>({});

  const filterKey = JSON.stringify(filters);

  const reload = React.useCallback(async () => {
    if (gated) return;
    try {
      const page = await api.get<AuditPage>(
        `/api/companies/${company.id}/audit${auditQuery({ ...filters, take: PAGE_SIZE })}`,
      );
      setRows(page.items);
      setNextCursor(page.nextCursor);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the audit log"));
      setRows([]);
      setNextCursor(null);
    }
    // `filterKey` stands in for `filters` so a new object with identical values
    // does not re-fetch on every keystroke elsewhere in the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, gated, filterKey]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  React.useEffect(() => {
    if (gated) return;
    api
      .get<{ employees: typeof employees }>(`/api/companies/${company.id}/audit/actors`)
      .then((r) => setEmployees(r.employees))
      .catch(() => setEmployees([]));
  }, [company.id, gated]);

  // The audit log is written on essentially every human/AI mutation, so it is
  // the one page that reflects the whole company's activity as it happens.
  useLiveRefetch("audit", reload);

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await api.get<AuditPage>(
        `/api/companies/${company.id}/audit${auditQuery({ ...filters, take: PAGE_SIZE, cursor: nextCursor })}`,
      );
      setRows((prev) => [...(prev ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load more audit events"));
    } finally {
      setLoadingMore(false);
    }
  };

  const set = (patch: AuditFilters) => setFilters((f) => ({ ...f, ...patch }));
  const filtered = Object.values(filters).some((v) => v !== undefined && v !== "");

  if (gated) {
    return (
      <>
        <TopBar title="Audit log" />
        <FeatureGateCard
          feature="auditLog"
          entitlements={company.entitlements}
          company={company}
        />
      </>
    );
  }

  return (
    <>
      <TopBar title="Audit log" />
      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Actor kind"
            className="w-40"
            value={filters.actorKind ?? ""}
            onChange={(e) =>
              set({
                actorKind: (e.target.value || undefined) as AuditActorKind | undefined,
                // Naming an employee already implies the AI kind; keeping a
                // contradictory pair selected would silently return nothing.
                actorEmployeeId: e.target.value === "ai" ? filters.actorEmployeeId : undefined,
              })
            }
          >
            {ACTOR_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
          {employees.length > 0 && (
            <Select
              aria-label="AI employee"
              className="w-48"
              value={filters.actorEmployeeId ?? ""}
              onChange={(e) =>
                set({
                  actorEmployeeId: e.target.value || undefined,
                  actorKind: e.target.value ? "ai" : filters.actorKind,
                })
              }
            >
              <option value="">Any AI employee</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </Select>
          )}
          <input
            aria-label="Action"
            placeholder="Action, e.g. invoice."
            className="w-48 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={filters.action ?? ""}
            onChange={(e) => set({ action: e.target.value || undefined })}
          />
          <input
            aria-label="Since"
            type="date"
            className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
            value={filters.since?.slice(0, 10) ?? ""}
            onChange={(e) =>
              set({
                since: e.target.value ? new Date(`${e.target.value}T00:00:00Z`).toISOString() : undefined,
              })
            }
          />
          {filtered && (
            <button
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
              onClick={() => setFilters({})}
            >
              <X size={13} /> Clear
            </button>
          )}
        </CardBody>
      </Card>
      {loadError ? (
        <FormError message={loadError} />
      ) : rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title={filtered ? "Nothing matches those filters" : "No audit events yet"}
          description={
            filtered
              ? "Widen the window or clear the filters to see the rest of the trail."
              : "Mutations across employees, routines, secrets, approvals, and models will show up here."
          }
        />
      ) : (
        <Card>
          <CardBody>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((e) => (
                <AuditRow key={e.id} event={e} companySlug={company.slug} />
              ))}
            </ul>
            {nextCursor && (
              <div className="pt-3">
                <button
                  className="w-full rounded-lg border border-slate-200 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load older events"}
                </button>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </>
  );
}

function AuditRow({ event, companySlug }: { event: AuditEvent; companySlug: string }) {
  const [open, setOpen] = React.useState(false);
  const actor =
    event.actorKind === "ai"
      ? (event.actorEmployee?.name ?? "An AI employee")
      : event.actorKind === "user"
        ? (event.actor?.name ?? event.actor?.email ?? "(unknown user)")
        : event.actorKind === "webhook"
          ? "Webhook"
          : event.actorKind === "cron"
            ? "Scheduler"
            : "System";
  const hasMeta = !!event.metadata && Object.keys(event.metadata).length > 0;
  return (
    <li className="py-2">
      <button
        className="flex w-full items-start gap-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <div className="mt-0.5 text-slate-400 dark:text-slate-500">
          {hasMeta ? (
            open ? (
              <ChevronDown size={14} />
            ) : (
              <ChevronRight size={14} />
            )
          ) : (
            <ScrollText size={14} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="flex items-center gap-1 font-medium text-slate-900 dark:text-slate-100">
              {event.actorKind === "ai" && (
                <Bot size={13} className="text-slate-400 dark:text-slate-500" />
              )}
              {actor}
            </span>
            <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              {event.action}
            </code>
            {event.targetLabel && (
              <span className="truncate text-slate-600 dark:text-slate-300">
                {event.targetLabel}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {new Date(event.createdAt).toLocaleString()}
            {event.runId && event.actorEmployee && (
              <>
                {" · "}
                <Link
                  className="underline decoration-dotted underline-offset-2 hover:text-slate-700 dark:hover:text-slate-200"
                  to={`/c/${companySlug}/employees/${event.actorEmployee.slug}/routines?run=${event.runId}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  in a routine run
                </Link>
              </>
            )}
          </div>
        </div>
      </button>
      {open && hasMeta && (
        <pre className="ml-6 mt-1 overflow-x-auto rounded bg-slate-50 p-2 text-[11px] text-slate-700 dark:bg-slate-900 dark:text-slate-200">
          {JSON.stringify(event.metadata, null, 2)}
        </pre>
      )}
    </li>
  );
}
