import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  Activity,
  Archive,
  Bot,
  Building2,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  GitCommitHorizontal,
  HardDrive,
  Mail,
  MemoryStick,
  RefreshCw,
  Tag,
  Users,
} from "lucide-react";
import { api, InstanceCheck, InstanceHealthReport, InstanceSeverity } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";
import type { AdminOutletCtx } from "./AdminLayout";

/**
 * Admin → Overview. The system-wide dashboard: an at-a-glance instance health
 * status, the deployment's build + runtime facts, an inventory of what's
 * installed, and a roll-up of every instance-health check with a jump into the
 * detailed page. Reads the same `/api/admin/instance-health` payload the
 * Instance Health page uses.
 */

const DOT: Record<InstanceSeverity, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-rose-500",
};

const STATUS_STYLE: Record<
  InstanceSeverity,
  { tone: string; chip: string; ring: string; label: string }
> = {
  ok: {
    tone: "text-emerald-600 dark:text-emerald-400",
    chip: "bg-emerald-100 dark:bg-emerald-500/15",
    ring: "border-emerald-200 dark:border-emerald-500/30",
    label: "All systems healthy",
  },
  warn: {
    tone: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-100 dark:bg-amber-500/15",
    ring: "border-amber-200 dark:border-amber-500/30",
    label: "Attention needed",
  },
  error: {
    tone: "text-rose-600 dark:text-rose-400",
    chip: "bg-rose-100 dark:bg-rose-500/15",
    ring: "border-rose-200 dark:border-rose-500/30",
    label: "Action required",
  },
};

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export function AdminOverview() {
  const { company } = useOutletContext<AdminOutletCtx>();
  const [report, setReport] = React.useState<InstanceHealthReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const { toast } = useToast();
  const base = `/c/${company.slug}/admin`;

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.get<InstanceHealthReport>("/api/admin/instance-health"));
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (report === null) {
    return (
      <>
        <TopBar title="Overview" />
        <Card>
          <CardBody>
            <Spinner />
          </CardBody>
        </Card>
      </>
    );
  }

  const info = report.instance;
  const status = STATUS_STYLE[report.status];

  const runtimeTiles: { icon: typeof Tag; label: string; value: string; mono?: boolean }[] = [
    { icon: Tag, label: "Version", value: `v${__APP_VERSION__}` },
    { icon: GitCommitHorizontal, label: "Build", value: __APP_COMMIT__, mono: true },
    { icon: Database, label: "Database", value: info.dbDriver },
    { icon: Cpu, label: "Runtime", value: `Node ${info.nodeVersion}` },
    { icon: Clock, label: "Uptime", value: formatUptime(info.uptimeSeconds) },
    { icon: MemoryStick, label: "Memory (RSS)", value: formatBytes(info.memory.rssBytes) },
  ];

  const inventory: { icon: typeof Building2; label: string; value: number }[] = [
    { icon: Building2, label: "Companies", value: info.counts.companies },
    { icon: Users, label: "Members", value: info.counts.users },
    { icon: Bot, label: "AI employees", value: info.counts.employees },
  ];

  return (
    <>
      <TopBar
        title="Overview"
        right={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        {/* Instance health hero */}
        <Card className={clsx("border", status.ring)}>
          <CardBody className="flex items-center gap-4">
            <span
              className={clsx(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
                status.chip,
                status.tone,
              )}
            >
              <Activity size={24} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {status.label}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {report.issueCount === 0
                  ? "Every instance check passed."
                  : `${report.issueCount} of ${report.checks.length} checks need attention.`}{" "}
                <Link to={`${base}/instance-health`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                  View instance health
                </Link>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Runtime + build facts */}
        <div>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Deployment
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {runtimeTiles.map((t) => (
              <StatTile
                key={t.label}
                icon={t.icon}
                label={t.label}
                value={t.value}
                mono={t.mono}
              />
            ))}
          </div>
        </div>

        {/* Inventory */}
        <div>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Inventory
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {inventory.map((t) => (
              <StatTile
                key={t.label}
                icon={t.icon}
                label={t.label}
                value={t.value.toLocaleString()}
                big
              />
            ))}
          </div>
        </div>

        {/* Health check roll-up */}
        <div>
          <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Checks
          </h2>
          <Card>
            <CardBody className="p-0">
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {report.checks.map((c) => (
                  <CheckRow key={c.id} check={c} to={`${base}/instance-health`} />
                ))}
              </ul>
            </CardBody>
          </Card>
        </div>

        {/* Quick actions */}
        <div className="grid gap-3 sm:grid-cols-2">
          <NavCard
            to={`${base}/instance-health`}
            icon={Activity}
            title="Instance Health"
            description="Database, migrations, disk, and runtime checks."
          />
          <NavCard
            to={`${base}/email`}
            icon={Mail}
            title="Email transport"
            description="Configure the global SMTP server for system emails."
          />
          <NavCard
            to={`${base}/backup`}
            icon={Archive}
            title="Backups"
            description="Archive the data directory and restore from a snapshot."
          />
        </div>

        <div className="flex items-center gap-2 px-1 text-xs text-slate-400 dark:text-slate-500">
          <HardDrive size={12} className="shrink-0" />
          <span className="min-w-0 truncate font-mono" title={info.dataDir}>
            {info.dataDir}
          </span>
        </div>
      </div>
    </>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  mono,
  big,
}: {
  icon: typeof Tag;
  label: string;
  value: string;
  mono?: boolean;
  big?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <Icon size={13} className="shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div
        className={clsx(
          "mt-1 truncate text-slate-900 dark:text-slate-100",
          big ? "text-2xl font-semibold tabular-nums" : "text-sm font-medium",
          mono && "font-mono",
        )}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

function CheckRow({ check, to }: { check: InstanceCheck; to: string }) {
  return (
    <li>
      <Link
        to={to}
        className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
      >
        <span className={clsx("h-2 w-2 shrink-0 rounded-full", DOT[check.severity])} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {check.title}
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {check.summary}
          </div>
        </div>
        <ChevronRight
          size={14}
          className="shrink-0 text-slate-300 group-hover:text-slate-500 dark:text-slate-600 dark:group-hover:text-slate-400"
        />
      </Link>
    </li>
  );
}

function NavCard({
  to,
  icon: Icon,
  title,
  description,
}: {
  to: string;
  icon: typeof Activity;
  title: string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700 dark:hover:bg-slate-800/50"
    >
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-sm font-medium text-slate-900 dark:text-slate-100">
          {title}
          <ChevronRight
            size={14}
            className="text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500 dark:text-slate-600"
          />
        </div>
        <div className="text-xs text-slate-500 dark:text-slate-400">{description}</div>
      </div>
    </Link>
  );
}
