import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, Company, UsageSummary } from "../lib/api";
import { TopBar } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { errorMessage } from "../lib/errors";
import type { SettingsOutletCtx } from "./SettingsLayout";
import { formatTokens } from "../components/routines/RunViews";

/**
 * Run-count, compute-time, and token visibility per company. Tokens are the
 * provider's own per-turn counts summed onto each Run; dollar costs are not
 * computed because pricing varies per provider/model/contract — the note
 * under the title says so, and the token columns let operators do their own
 * arithmetic.
 */
const WINDOW_OPTIONS = [
  { label: "Last 24 hours", value: 1 },
  { label: "Last 7 days", value: 7 },
  { label: "Last 30 days", value: 30 },
  { label: "Last 90 days", value: 90 },
];

export default function Usage() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [days, setDays] = React.useState(30);
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const s = await api.get<UsageSummary>(
        `/api/companies/${company.id}/usage?days=${days}`,
      );
      setSummary(s);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load usage"));
    }
  }, [company.id, days]);

  React.useEffect(() => {
    setSummary(null);
    setLoadError(null);
    reload();
  }, [reload]);

  // Token spend rolls up per Run; refetch (silently) as runs complete.
  useLiveRefetch("run", reload);

  return (
    <>
      <TopBar
        title="Usage"
        right={
          <Select value={days} onChange={(e) => setDays(parseInt(e.target.value, 10))}>
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        }
      />
      <p className="mb-6 text-xs text-slate-500 dark:text-slate-400">
        Measured from routine runs. Tokens are the provider&apos;s own counts, summed per run;
        runs from before token accounting shipped count as zero. Dollar costs depend on your
        model pricing, so they&apos;re left to you.
      </p>
      {loadError ? (
        <FormError message={loadError} />
      ) : summary === null ? (
        <Spinner />
      ) : summary.totals.runs === 0 ? (
        <EmptyState
          title="No runs yet in this window"
          description="Runs are recorded when a routine executes on its schedule, is triggered by webhook, or is run manually."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <TotalsCards summary={summary} />
          <ByEmployeeTable summary={summary} company={company} />
          <ByRoutineTable summary={summary} company={company} />
        </div>
      )}
    </>
  );
}

function TotalsCards({ summary }: { summary: UsageSummary }) {
  const t = summary.totals;
  const successRate = t.runs ? Math.round((t.completed / t.runs) * 100) : 0;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard label="Runs" value={String(t.runs)} sub={`over ${summary.windowDays} days`} />
      <StatCard
        label="Tokens"
        value={formatTokens((t.tokensIn ?? 0) + (t.tokensOut ?? 0))}
        sub={`${formatTokens(t.tokensIn ?? 0)} in · ${formatTokens(t.tokensOut ?? 0)} out`}
      />
      <StatCard label="Compute time" value={formatDuration(t.durationMs)} sub="wall-clock" />
      <StatCard label="Completed" value={`${t.completed}`} sub={`${successRate}% success`} />
      <StatCard
        label="Problems"
        value={String(t.failed + t.timeout + t.interrupted)}
        sub={`${t.failed} failed · ${t.timeout} timed out · ${t.interrupted} interrupted · ${t.skipped} skipped`}
      />
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-slate-100">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function ByEmployeeTable({ summary, company }: { summary: UsageSummary; company: Company }) {
  const rows = summary.byEmployee.filter((e) => e.runs > 0);
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">By employee</h2>
      </CardHeader>
      <CardBody>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <tr>
              <th className="py-2">Employee</th>
              <th className="py-2 text-right">Runs</th>
              <th className="py-2 text-right">Tokens</th>
              <th className="py-2 text-right">Compute</th>
              <th className="py-2 text-right">Success</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((e) => (
              <tr key={e.employeeId}>
                <td className="py-2">
                  <Link
                    to={`/c/${company.slug}/employees/${e.slug}`}
                    className="font-medium text-slate-900 hover:text-indigo-600 dark:text-slate-100"
                  >
                    {e.name}
                  </Link>
                </td>
                <td className="py-2 text-right tabular-nums">{e.runs}</td>
                <td
                  className="py-2 text-right tabular-nums"
                  title={`${formatTokens(e.tokensIn ?? 0)} in · ${formatTokens(e.tokensOut ?? 0)} out`}
                >
                  {formatTokens((e.tokensIn ?? 0) + (e.tokensOut ?? 0))}
                </td>
                <td className="py-2 text-right tabular-nums">{formatDuration(e.durationMs)}</td>
                <td className="py-2 text-right tabular-nums">
                  {e.runs ? Math.round((e.completed / e.runs) * 100) : 0}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

function ByRoutineTable({ summary, company }: { summary: UsageSummary; company: Company }) {
  const rows = summary.byRoutine.filter((r) => r.runs > 0);
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">By routine</h2>
      </CardHeader>
      <CardBody>
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            <tr>
              <th className="py-2">Routine</th>
              <th className="py-2">Employee</th>
              <th className="py-2 text-right">Runs</th>
              <th className="py-2 text-right">Tokens</th>
              <th className="py-2 text-right">Compute</th>
              <th className="py-2 text-right">Avg duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => {
              // Every status that produced a duration, or the average is wrong.
              const finished = r.completed + r.failed + r.timeout + r.interrupted;
              const avg = finished > 0 ? r.durationMs / finished : 0;
              return (
                <tr key={r.routineId}>
                  <td className="py-2 font-medium text-slate-900 dark:text-slate-100">{r.name}</td>
                  <td className="py-2">
                    {r.employeeName ? (
                      <Link
                        to={`/c/${company.slug}/employees/${r.employeeSlug}`}
                        className="text-slate-600 hover:text-indigo-600 dark:text-slate-300"
                      >
                        {r.employeeName}
                      </Link>
                    ) : (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{r.runs}</td>
                  <td
                    className="py-2 text-right tabular-nums"
                    title={`${formatTokens(r.tokensIn ?? 0)} in · ${formatTokens(r.tokensOut ?? 0)} out`}
                  >
                    {formatTokens((r.tokensIn ?? 0) + (r.tokensOut ?? 0))}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatDuration(r.durationMs)}</td>
                  <td className="py-2 text-right tabular-nums">{formatDuration(avg)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardBody>
    </Card>
  );
}

function formatDuration(ms: number): string {
  if (!ms || ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
