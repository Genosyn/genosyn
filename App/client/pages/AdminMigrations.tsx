import React from "react";
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  Layers,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  api,
  InstanceSeverity,
  MigrationEntry,
  MigrationIssue,
  MigrationReport,
  MigrationState,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody } from "../components/ui/Card";
import { EmptyState } from "../components/ui/EmptyState";
import { Spinner } from "../components/ui/Spinner";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { clsx } from "../components/ui/clsx";

/**
 * Admin → Migrations. A read-only view of the schema history: which TypeORM
 * migrations this build ships, which of them the database has actually run, and
 * whether the two agree. It sits one level below Instance Health, which only
 * reports a pending count — this page names the migrations behind that number.
 *
 * The honest limitation this page is built around: the TypeORM `migrations`
 * table stores only `id`, `timestamp`, and `name`. There is no wall-clock
 * "applied at" column, so we can never tell the operator *when* a migration
 * ran — only the order it ran in (`batchId`). Every date on this page is the
 * migration's AUTHORED timestamp, parsed from its class-name suffix, and is
 * labelled as such. Do not relabel it "Applied at".
 */

const SEVERITY_STYLE: Record<
  InstanceSeverity,
  { icon: typeof CheckCircle2; tone: string; badge: string; ring: string; chip: string }
> = {
  ok: {
    icon: CheckCircle2,
    tone: "text-emerald-600 dark:text-emerald-400",
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
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

/**
 * Row-level state styling. Colour tracks *severity*, not state, so the palette
 * keeps meaning: applied is the healthy case, while pending and unknown are
 * both warnings and therefore both amber. The icon and label carry the
 * distinction between them.
 */
const STATE_STYLE: Record<
  MigrationState,
  { icon: typeof CheckCircle2; label: string; pill: string }
> = {
  applied: {
    icon: CheckCircle2,
    label: "Applied",
    pill: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  },
  pending: {
    icon: Clock,
    label: "Pending",
    pill: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  },
  unknown: {
    icon: HelpCircle,
    label: "Unknown",
    pill: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  },
};

const DRIVER_LABEL: Record<MigrationReport["driver"], string> = {
  sqlite: "SQLite",
  postgres: "PostgreSQL",
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

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

/**
 * The report the server sends when it could not read the migrations table at
 * all (`unreadableReport()` in server/services/adminMigrations.ts). The route
 * still answers 200 — a database that won't talk is a reportable state, not a
 * 500 — so this arrives as an ordinary report and the fetch-error branch below
 * never fires.
 *
 * It needs its own branch because every count in it is 0 as a SENTINEL FOR
 * "unknown", not as a fact, and `migrations` is empty because no single
 * migration's state is knowable. Rendering it through the normal
 * banner/tiles/list would report "0 issues need attention" in error rose,
 * "Pending 0" in calm slate, and "this build ships no migration files" directly
 * under a Total tile reading 78 — three confident falsehoods at the exact
 * moment the instance is broken. `status` is the signal: every derived issue is
 * a `warn`, so `error` can only come from `unreadableReport()`. The empty
 * `issues`/`migrations` checks are belt-and-braces against that changing.
 */
function isUnreadable(report: MigrationReport): boolean {
  return (
    report.status === "error" &&
    report.issues.length === 0 &&
    report.migrations.length === 0
  );
}

export function AdminMigrations() {
  const [report, setReport] = React.useState<MigrationReport | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    setLoading(true);
    try {
      setReport(await api.get<MigrationReport>("/api/admin/migrations"));
      setError(null);
    } catch (err) {
      // Keep any previously-loaded report on screen; surface the failure as its
      // own state instead of masquerading as an instance with no migrations.
      setError((err as Error).message);
      toast((err as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const retry = (
    <Button variant="secondary" onClick={reload} disabled={loading}>
      <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Retry
    </Button>
  );

  return (
    <>
      <TopBar
        title="Migrations"
        right={
          <Button variant="secondary" onClick={reload} disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </Button>
        }
      />

      {error && report === null ? (
        <EmptyState
          title="Couldn't load migrations"
          description={error}
          action={retry}
        />
      ) : report !== null && isUnreadable(report) ? (
        // The server reached a verdict — it just couldn't read the table. Say
        // that, and show nothing derived from the placeholder counts.
        <EmptyState
          title="Schema history unavailable"
          description={report.summary}
          action={retry}
        />
      ) : report === null ? (
        <Card>
          <CardBody>
            <Spinner />
          </CardBody>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <OverallBanner report={report} />
          <StatGrid report={report} />
          <LastAppliedPanel report={report} />

          {/* No issues means the banner already told the whole story — an
              all-clear card here would just be noise. */}
          {report.issues.length > 0 && (
            <div>
              <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Issues
              </h2>
              <Card>
                <CardBody className="p-0">
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {report.issues.map((i) => (
                      <IssueRow key={i.id} issue={i} />
                    ))}
                  </ul>
                </CardBody>
              </Card>
            </div>
          )}

          <div>
            <h2 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              All migrations
            </h2>
            <p className="mb-2 px-1 text-xs text-slate-500 dark:text-slate-400">
              Dates below are when a migration was{" "}
              <span className="font-medium">authored</span>, not when it ran. The
              schema history table records only the execution order (#) — there is
              no timestamp for when a migration was applied.
            </p>
            <MigrationList migrations={report.migrations} />
          </div>
        </div>
      )}
    </>
  );
}

function OverallBanner({ report }: { report: MigrationReport }) {
  const style = SEVERITY_STYLE[report.status];
  const Icon = style.icon;
  const headline =
    report.status === "ok"
      ? "Schema is up to date"
      : `${report.issues.length} ${
          report.issues.length === 1 ? "issue needs" : "issues need"
        } attention`;
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
            {report.summary} · {DRIVER_LABEL[report.driver]} · checked{" "}
            {relativeTime(report.generatedAt)}
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

function StatGrid({ report }: { report: MigrationReport }) {
  // A healthy instance should read as calm: the pending and unknown tiles only
  // light up once they actually have something in them.
  const warnStyle = SEVERITY_STYLE.warn;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {/* Total counts only what the build defines, so Total = Applied + Pending
          and the unknown drift rows sit OUTSIDE it — by definition they have no
          class in this build to be counted against. That makes the tiles look
          like they don't sum against the longer list below, hence the hint. */}
      <StatTile
        icon={Layers}
        label="Total"
        value={report.total}
        hint="Migrations defined in this build — applied plus pending. Unknown migrations exist only in the database, so they are counted separately and are not part of this total."
      />
      <StatTile
        icon={CheckCircle2}
        label="Applied"
        value={report.appliedCount}
        hint="Defined in this build and recorded in the database."
      />
      <StatTile
        icon={Clock}
        label="Pending"
        value={report.pendingCount}
        hint="Defined in this build but not yet recorded in the database."
        tone={report.pendingCount > 0 ? warnStyle.tone : undefined}
        ring={report.pendingCount > 0 ? warnStyle.ring : undefined}
      />
      <StatTile
        icon={HelpCircle}
        label="Unknown"
        value={report.unknownCount}
        hint="Recorded in the database but absent from this build — schema drift. Not included in Total."
        tone={report.unknownCount > 0 ? warnStyle.tone : undefined}
        ring={report.unknownCount > 0 ? warnStyle.ring : undefined}
      />
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
  ring,
}: {
  icon: typeof CheckCircle2;
  label: string;
  value: number;
  hint?: string;
  tone?: string;
  ring?: string;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border bg-white p-3 shadow-sm dark:bg-slate-900",
        ring ?? "border-slate-200 dark:border-slate-800",
      )}
      title={hint}
    >
      <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <Icon size={13} className="shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div
        className={clsx(
          "mt-1 truncate text-2xl font-semibold tabular-nums",
          tone ?? "text-slate-900 dark:text-slate-100",
        )}
      >
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function LastAppliedPanel({ report }: { report: MigrationReport }) {
  const last = report.lastApplied;
  if (!last) return null;
  return (
    <dl className="grid gap-x-6 gap-y-2 rounded-lg border border-slate-100 bg-slate-50/60 p-3 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-800/30">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
          Last applied
        </dt>
        <dd
          className="min-w-0 truncate text-right font-mono text-xs font-medium text-slate-800 dark:text-slate-200"
          title={last.name}
        >
          {last.name}
        </dd>
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
          Order · authored
        </dt>
        <dd
          className="min-w-0 truncate text-right text-xs font-medium tabular-nums text-slate-800 dark:text-slate-200"
          title={`Ran ${
            last.batchId === null ? "in an unknown position" : `in position #${last.batchId}`
          } · authored ${formatDateTime(last.authoredAt)}`}
        >
          {last.batchId === null ? "—" : `#${last.batchId}`} · {formatDate(last.authoredAt)}
        </dd>
      </div>
    </dl>
  );
}

function IssueRow({ issue }: { issue: MigrationIssue }) {
  const style = SEVERITY_STYLE[issue.severity];
  const Icon = style.icon;
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <Icon size={16} className={clsx("mt-0.5 shrink-0", style.tone)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {issue.title}
          </h3>
          <span
            className={clsx(
              "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              style.badge,
            )}
          >
            {SEVERITY_LABEL[issue.severity]}
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{issue.detail}</p>
        {issue.migrations.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {issue.migrations.map((name) => (
              <span
                key={name}
                className="max-w-full truncate rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                title={name}
              >
                {name}
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

function MigrationList({ migrations }: { migrations: MigrationEntry[] }) {
  const [query, setQuery] = React.useState("");

  // Searching the state string too means typing "pending" narrows the list to
  // the migrations an operator is most likely hunting for.
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return migrations;
    return migrations.filter((m) =>
      [m.name, m.title, m.state].some((f) => f.toLowerCase().includes(q)),
    );
  }, [migrations, query]);

  // Both halves of this copy are load-bearing claims, and they are only true
  // because `isUnreadable` already peeled off the can't-read case upstream —
  // otherwise this would assert "ships no migration files" under a Total tile
  // reading 78. What's left is genuinely empty: no drift row can be hiding
  // either, since a drift row would itself put an entry in this list. If you
  // ever render MigrationList somewhere that hasn't made that check, this
  // wording has to become conditional.
  if (migrations.length === 0) {
    return (
      <EmptyState
        title="No migrations"
        description="This build ships no migration files and the schema history table is empty."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or state…"
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-indigo-900"
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {filtered.length} of {migrations.length}
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No matching migrations" description="Try a different search term." />
      ) : (
        <Card>
          <CardBody className="p-0">
            <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:border-slate-800 dark:text-slate-500">
              <span className="min-w-0 flex-1">Migration</span>
              <span className="hidden w-24 shrink-0 text-right sm:block">Authored</span>
              <span className="w-12 shrink-0 text-right" title="Execution order — the rank a migration ran in, not a time">
                Order
              </span>
              <span className="w-24 shrink-0 text-center">State</span>
            </div>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.map((m) => (
                <MigrationRow key={m.name} entry={m} />
              ))}
            </ul>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function MigrationRow({ entry }: { entry: MigrationEntry }) {
  const style = STATE_STYLE[entry.state];
  const Icon = style.icon;
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
          {entry.title}
        </div>
        <div
          className="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400"
          title={entry.name}
        >
          {entry.name}
        </div>
      </div>
      <div
        className="hidden w-24 shrink-0 text-right text-xs tabular-nums text-slate-400 sm:block dark:text-slate-500"
        title={`Authored ${formatDateTime(entry.authoredAt)}`}
      >
        {formatDate(entry.authoredAt)}
      </div>
      <div
        className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-400 dark:text-slate-500"
        title={
          entry.batchId === null
            ? "Not applied yet — no execution order"
            : `Ran in position #${entry.batchId}`
        }
      >
        {entry.batchId === null ? "—" : `#${entry.batchId}`}
      </div>
      <span
        className={clsx(
          "inline-flex w-24 shrink-0 items-center justify-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
          style.pill,
        )}
        title={
          entry.state === "unknown"
            ? "Recorded in the database but absent from this build — schema drift"
            : undefined
        }
      >
        <Icon size={10} className="shrink-0" /> {style.label}
      </span>
    </li>
  );
}
