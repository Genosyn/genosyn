import React from "react";
import { Link } from "react-router-dom";
import { api, Company, UsageSummary } from "../lib/api";
import { Breadcrumbs, TopBar } from "../components/AppShell";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { useToast } from "../components/ui/Toast";

/**
 * Compute-time + run-count visibility per company. We don't have provider
 * token/cost metadata yet — this page reports what we can measure from the
 * Run table (count + wall-clock duration). A tooltip calls this out so
 * operators know what's missing.
 */
const WINDOW_OPTIONS = [
  { label: "Last 24 hours", value: 1 },
  { label: "Last 7 days", value: 7 },
  { label: "Last 30 days", value: 30 },
  { label: "Last 90 days", value: 90 },
];

export default function Usage({ company }: { company: Company }) {
  const [days, setDays] = React.useState(30);
  const [summary, setSummary] = React.useState<UsageSummary | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    setSummary(null);
    (async () => {
      try {
        const s = await api.get<UsageSummary>(
          `/api/companies/${company.id}/usage?days=${days}`,
        );
        setSummary(s);
      } catch (err) {
        toast((err as Error).message, "error");
      }
    })();
  }, [company.id, days, toast]);

  return (
    <main className="min-w-0 flex-1 overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-5xl p-8">
        <div className="mb-3">
          <Breadcrumbs items={[{ label: "Usage" }]} />
        </div>
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
        <p className="mb-6 text-xs text-slate-500">
          Measured from routine runs. Token counts and dollar costs aren't tracked yet — the
          provider CLIs don't surface that metadata in a stable way.
        </p>
        {summary === null ? (
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
      </div>
    </main>
  );
}

function TotalsCards({ summary }: { summary: UsageSummary }) {
  const t = summary.totals;
  const successRate = t.runs ? Math.round((t.completed / t.runs) * 100) : 0;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
      <StatCard label="Runs" value={String(t.runs)} sub={`over ${summary.windowDays} days`} />
      <StatCard label="Compute time" value={formatDuration(t.durationMs)} sub="wall-clock" />
      <StatCard label="Completed" value={`${t.completed}`} sub={`${successRate}% success`} />
      <StatCard
        label="Problems"
        value={String(t.failed + t.timeout)}
        sub={`${t.failed} failed · ${t.timeout} timed out · ${t.skipped} skipped`}
      />
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <CardBody>
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
        <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
        {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
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
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2">Employee</th>
              <th className="py-2 text-right">Runs</th>
              <th className="py-2 text-right">Compute</th>
              <th className="py-2 text-right">Success</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((e) => (
              <tr key={e.employeeId}>
                <td className="py-2">
                  <Link
                    to={`/c/${company.slug}/employees/${e.slug}`}
                    className="font-medium text-slate-900 hover:text-indigo-600"
                  >
                    {e.name}
                  </Link>
                </td>
                <td className="py-2 text-right tabular-nums">{e.runs}</td>
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
          <thead className="text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2">Routine</th>
              <th className="py-2">Employee</th>
              <th className="py-2 text-right">Runs</th>
              <th className="py-2 text-right">Compute</th>
              <th className="py-2 text-right">Avg duration</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const finished = r.completed + r.failed + r.timeout;
              const avg = finished > 0 ? r.durationMs / finished : 0;
              return (
                <tr key={r.routineId}>
                  <td className="py-2 font-medium text-slate-900">{r.name}</td>
                  <td className="py-2">
                    {r.employeeName ? (
                      <Link
                        to={`/c/${company.slug}/employees/${r.employeeSlug}`}
                        className="text-slate-600 hover:text-indigo-600"
                      >
                        {r.employeeName}
                      </Link>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{r.runs}</td>
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
