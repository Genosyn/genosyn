import React from "react";
import { useOutletContext } from "react-router-dom";
import { Activity, RefreshCw } from "lucide-react";
import { api, HealthProbe, HealthSeverity, SystemHealthReport } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { FormError } from "../components/ui/FormError";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { clsx } from "../components/ui/clsx";
import { HealthCheckDetail, HEALTH_SEVERITY_STYLE } from "../components/health/HealthCheckDetail";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → System Health. A read-only roll-up of everything that might be
 * quietly broken for this company: failed / stuck / skipped routine runs,
 * employees with no AI model, stale approvals, email + integration failures.
 * Each row deep-links to where the member can fix it (the routine's run
 * history, the employee's model settings, the approvals inbox, …).
 */

const SEVERITY_RANK: Record<HealthSeverity, number> = { ok: 0, warn: 1, error: 2 };

function relativeTime(iso: string): string {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  return `${hr}h ago`;
}

export function SettingsSystemHealth() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  const [report, setReport] = React.useState<SystemHealthReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<SystemHealthReport>(`/api/companies/${company.id}/system-health`);
      setReport(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load system health"));
    } finally {
      setLoading(false);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Unhealthy checks first (error, then warn), healthy ones last.
  const checks = report
    ? [...report.checks].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    : [];

  return (
    <>
      <TopBar
        title="System Health"
        right={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      {loadError ? (
        <FormError message={loadError} />
      ) : report === null ? (
        <Card>
          <CardBody>
            <Spinner />
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          <OverallBanner report={report} />
          {checks.map((c) => (
            <CheckCard key={c.id} check={c} />
          ))}
        </div>
      )}
    </>
  );
}

function OverallBanner({ report }: { report: SystemHealthReport }) {
  const style = HEALTH_SEVERITY_STYLE[report.status];
  const Icon = style.icon;
  const headline =
    report.status === "ok"
      ? "All systems healthy"
      : `${report.issueCount} ${report.issueCount === 1 ? "issue" : "issues"} need attention`;
  return (
    <Card className={clsx("border", style.ring)}>
      <CardBody className="flex items-center gap-3">
        <span
          className={clsx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            report.status === "ok"
              ? "bg-emerald-100 dark:bg-emerald-500/15"
              : report.status === "warn"
                ? "bg-amber-100 dark:bg-amber-500/15"
                : "bg-rose-100 dark:bg-rose-500/15",
            style.tone,
          )}
        >
          {report.status === "ok" ? <Activity size={20} /> : <Icon size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">{headline}</div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Watching routine runs, AI models, approvals, email and integrations over the last{" "}
            {report.windowHours} hours · checked {relativeTime(report.generatedAt)}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function CheckCard({ check }: { check: HealthProbe }) {
  return (
    <Card>
      <CardBody>
        <HealthCheckDetail check={check} />
      </CardBody>
    </Card>
  );
}
