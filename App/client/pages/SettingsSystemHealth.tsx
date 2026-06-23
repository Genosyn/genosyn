import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
} from "lucide-react";
import { api, HealthCheck, HealthSeverity, SystemHealthReport } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Settings → System Health. A read-only roll-up of everything that might be
 * quietly broken for this company: failed / stuck / skipped routine runs,
 * employees with no AI model, stale approvals, email + integration failures.
 * Each row deep-links to where the member can fix it (the routine's run
 * history, the employee's model settings, the approvals inbox, …).
 */

const SEVERITY_RANK: Record<HealthSeverity, number> = { ok: 0, warn: 1, error: 2 };

const SEVERITY_STYLE: Record<
  HealthSeverity,
  { icon: typeof CheckCircle2; tone: string; badge: string; ring: string }
> = {
  ok: {
    icon: CheckCircle2,
    tone: "text-emerald-600 dark:text-emerald-400",
    badge:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    ring: "border-emerald-200 dark:border-emerald-500/30",
  },
  warn: {
    icon: AlertTriangle,
    tone: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    ring: "border-amber-200 dark:border-amber-500/30",
  },
  error: {
    icon: AlertOctagon,
    tone: "text-rose-600 dark:text-rose-400",
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
    ring: "border-rose-200 dark:border-rose-500/30",
  },
};

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
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<SystemHealthReport>(
        `/api/companies/${company.id}/system-health`,
      );
      setReport(data);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // Unhealthy checks first (error, then warn), healthy ones last.
  const checks = report
    ? [...report.checks].sort(
        (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
      )
    : [];

  return (
    <>
      <TopBar
        title="System Health"
        right={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />{" "}
            Refresh
          </Button>
        }
      />

      {report === null ? (
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
  const style = SEVERITY_STYLE[report.status];
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
          {report.status === "ok" ? (
            <Activity size={20} />
          ) : (
            <Icon size={20} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {headline}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Watching routine runs, AI models, approvals, email and integrations
            over the last {report.windowHours} hours · checked{" "}
            {relativeTime(report.generatedAt)}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function CheckCard({ check }: { check: HealthCheck }) {
  const style = SEVERITY_STYLE[check.severity];
  const Icon = style.icon;
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Icon size={18} className={clsx("mt-0.5 shrink-0", style.tone)} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {check.title}
              </h2>
              {check.count > 0 && (
                <span
                  className={clsx(
                    "rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
                    style.badge,
                  )}
                >
                  {check.count}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {check.summary}
            </p>
          </div>
        </div>

        {check.items.length > 0 && (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            {check.items.map((item, i) => {
              const body = (
                <div className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm text-slate-900 dark:text-slate-100">
                      {item.label}
                    </div>
                    {item.sublabel && (
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {item.sublabel}
                      </div>
                    )}
                  </div>
                  {item.badge && (
                    <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-400">
                      {item.badge}
                    </span>
                  )}
                  {item.link && (
                    <ChevronRight
                      size={14}
                      className="shrink-0 text-slate-300 group-hover:text-slate-500 dark:text-slate-600 dark:group-hover:text-slate-400"
                    />
                  )}
                </div>
              );
              return (
                <li key={i}>
                  {item.link ? (
                    <Link
                      to={item.link}
                      className="group block transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    >
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
