import React from "react";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { api, InstanceCheck, InstanceHealthReport, InstanceSeverity } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Instance Health. A read-only probe of the deployment substrate every
 * company shares: database connectivity, pending migrations, a writable data
 * directory, the backup story, and the runtime. Distinct from the company-
 * scoped System Health under Settings, which watches a company's routines,
 * models, and integrations.
 */

const SEVERITY_STYLE: Record<
  InstanceSeverity,
  { icon: typeof CheckCircle2; tone: string; badge: string; ring: string; chip: string }
> = {
  ok: {
    icon: CheckCircle2,
    tone: "text-emerald-600 dark:text-emerald-400",
    badge:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
    ring: "border-emerald-200 dark:border-emerald-500/30",
    chip: "bg-emerald-100 dark:bg-emerald-500/15",
  },
  warn: {
    icon: AlertTriangle,
    tone: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
    ring: "border-amber-200 dark:border-amber-500/30",
    chip: "bg-amber-100 dark:bg-amber-500/15",
  },
  error: {
    icon: AlertOctagon,
    tone: "text-rose-600 dark:text-rose-400",
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300",
    ring: "border-rose-200 dark:border-rose-500/30",
    chip: "bg-rose-100 dark:bg-rose-500/15",
  },
};

const SEVERITY_LABEL: Record<InstanceSeverity, string> = {
  ok: "Healthy",
  warn: "Warning",
  error: "Error",
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

export function AdminInstanceHealth() {
  const [report, setReport] = React.useState<InstanceHealthReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<InstanceHealthReport>("/api/admin/instance-health");
      setReport(data);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return (
    <>
      <TopBar
        title="Instance Health"
        right={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
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
          {report.checks.map((c) => (
            <CheckCard key={c.id} check={c} />
          ))}
        </div>
      )}
    </>
  );
}

function OverallBanner({ report }: { report: InstanceHealthReport }) {
  const style = SEVERITY_STYLE[report.status];
  const Icon = style.icon;
  const headline =
    report.status === "ok"
      ? "This instance is healthy"
      : `${report.issueCount} ${report.issueCount === 1 ? "check needs" : "checks need"} attention`;
  return (
    <Card className={clsx("border", style.ring)}>
      <CardBody className="flex items-center gap-3">
        <span
          className={clsx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
            style.chip,
            style.tone,
          )}
        >
          {report.status === "ok" ? <Activity size={20} /> : <Icon size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {headline}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Testing the database, migrations, data directory, backups, and
            runtime · checked {relativeTime(report.generatedAt)}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function CheckCard({ check }: { check: InstanceCheck }) {
  const style = SEVERITY_STYLE[check.severity];
  const Icon = style.icon;
  return (
    <Card>
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Icon size={18} className={clsx("mt-0.5 shrink-0", style.tone)} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {check.title}
              </h2>
              <span
                className={clsx(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                  style.badge,
                )}
              >
                {SEVERITY_LABEL[check.severity]}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {check.summary}
            </p>
          </div>
        </div>

        {check.facts.length > 0 && (
          <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-slate-100 bg-slate-50/60 p-3 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-800/30">
            {check.facts.map((f, i) => (
              <div key={i} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {f.label}
                </dt>
                <dd
                  className={clsx(
                    "min-w-0 truncate text-right text-xs font-medium text-slate-800 dark:text-slate-200",
                    f.mono && "font-mono",
                  )}
                  title={f.value}
                >
                  {f.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardBody>
    </Card>
  );
}
