import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { ArrowRight, Contact2, Info, Target } from "lucide-react";
import { api, formatMoney } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";
import { RevenueOutletCtx } from "./RevenueLayout";

/**
 * Revenue → Insights. The landing page of the Revenue section, backed by the
 * single composite report at `GET /revenue/reports/overview`.
 *
 * Everything here is read-only and derived server-side (`services/revenue/*`) —
 * this page does no arithmetic beyond laying out bars, which is deliberate: the
 * numbers on this screen end up in board decks, and two places computing a win
 * rate is two places to get it wrong.
 *
 * Money arrives as integer minor units and is rendered with `formatMoney` from
 * `lib/api`. The one local addition is {@link compactMoney}, for the in-chart
 * labels where a full "$12,345.00" does not fit in a 100px column.
 */

// ── The payload, as `services/revenue/reports.ts` shapes it ────────────────

type StageLike = {
  id: string;
  name: string;
  sortOrder: number;
  probability: number;
  kind: "open" | "won" | "lost";
};

type MrrMovement = {
  startingCents: number;
  newCents: number;
  expansionCents: number;
  reactivationCents: number;
  /** Positive magnitudes — the sign is in the name, not the number. */
  contractionCents: number;
  churnCents: number;
  netCents: number;
  endingCents: number;
  counts: {
    new: number;
    expanded: number;
    reactivated: number;
    contracted: number;
    churned: number;
    retained: number;
  };
};

type MrrSeriesPoint = { month: string } & MrrMovement;

type StageFunnelRow = {
  stage: StageLike;
  count: number;
  valueCents: number;
  weightedValueCents: number;
};

type StageConversionRow = {
  fromStage: StageLike;
  toStage: StageLike;
  conversionPct: number | null;
};

type ChannelCac = {
  channel: string;
  spendCents: number;
  /** May be fractional — the server splits a win across attributed channels. */
  wonCount: number;
  cacCents: number | null;
  note: "ok" | "no-wins" | "organic";
};

type RevenueOverview = {
  /** Dates cross the wire as ISO strings. */
  period: { from: string; to: string };
  mrr: {
    currentCents: number;
    movement: MrrMovement;
    series: MrrSeriesPoint[];
  };
  arrCents: number;
  retention: {
    cohortSize: number;
    startingCents: number;
    endingCents: number;
    retainedCents: number;
    churnedCount: number;
    nrrPct: number | null;
    grrPct: number | null;
  };
  funnel: {
    stages: StageFunnelRow[];
    orphanedCount: number;
    conversion: StageConversionRow[];
    winRate: { won: number; lost: number; winRatePct: number | null };
    salesCycleDays: number | null;
  };
  coverage: {
    openCents: number;
    weightedCents: number;
    coverage: number | null;
    weightedCoverage: number | null;
  };
  cac: {
    channels: ChannelCac[];
    blendedCacCents: number | null;
    spendCents: number;
    wonCount: number;
    arpaCents: number | null;
    monthlyChurnPct: number | null;
    ltvCents: number | null;
    ltvToCac: number | null;
    paybackMonths: number | null;
    spendIsProxy: boolean;
  };
  collectedCents: number;
  currency: string;
};

// ── Period switcher ────────────────────────────────────────────────────────

const PERIODS = [
  { id: "month", label: "This month" },
  { id: "quarter", label: "This quarter" },
  { id: "ytd", label: "Year to date" },
  { id: "trailing12", label: "Last 12 months" },
] as const;

type PeriodId = (typeof PERIODS)[number]["id"];

/**
 * Half-open `[from, to)` in UTC, matching the convention the report services
 * state on their own types. Every window ends at the start of *next* month so
 * the current, incomplete month is included — a dashboard that stops a month
 * ago reads as broken.
 */
function periodRange(id: PeriodId, now: Date): { from: Date; to: Date } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const nextMonth = new Date(Date.UTC(year, month + 1, 1));
  if (id === "month") return { from: new Date(Date.UTC(year, month, 1)), to: nextMonth };
  if (id === "quarter") {
    const firstOfQuarter = Math.floor(month / 3) * 3;
    return {
      from: new Date(Date.UTC(year, firstOfQuarter, 1)),
      to: new Date(Date.UTC(year, firstOfQuarter + 3, 1)),
    };
  }
  if (id === "ytd") return { from: new Date(Date.UTC(year, 0, 1)), to: nextMonth };
  return { from: new Date(Date.UTC(year, month - 11, 1)), to: nextMonth };
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Money for chart labels only. `formatMoney` is the house formatter and is used
 * everywhere a number is read exactly; this exists because "$1.2M" fits under a
 * bar and "$1,248,300.00" does not.
 */
function compactMoney(cents: number, currency: string): string {
  const c = currency || "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: c,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(cents / 100);
  } catch {
    return `${Math.round(cents / 100)} ${c}`;
  }
}

function formatPct(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(1)}%`;
}

/** Win counts can be fractional when one deal is split across channels. */
function formatCount(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A company that has never used Revenue must not be shown six tiles of zeros —
 * that reads as a broken page rather than an empty one. "Nothing at all" is
 * every source of truth on the payload being untouched, not just MRR.
 */
function hasNothing(o: RevenueOverview): boolean {
  const m = o.mrr.movement;
  return (
    o.mrr.currentCents === 0 &&
    m.startingCents === 0 &&
    m.endingCents === 0 &&
    o.collectedCents === 0 &&
    o.coverage.openCents === 0 &&
    o.funnel.winRate.won === 0 &&
    o.funnel.winRate.lost === 0 &&
    o.funnel.orphanedCount === 0 &&
    o.funnel.stages.every((row) => row.count === 0) &&
    o.cac.channels.length === 0
  );
}

export default function RevenueIndex() {
  const { company } = useOutletContext<RevenueOutletCtx>();
  const [period, setPeriod] = React.useState<PeriodId>("trailing12");
  const [overview, setOverview] = React.useState<RevenueOverview | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  // Switching periods fires a second request while the first is in flight;
  // without this the slower (stale) response can land last and win.
  const requestSeq = React.useRef(0);

  const reload = React.useCallback(() => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const { from, to } = periodRange(period, new Date());
    const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
    return api
      .get<RevenueOverview>(
        `/api/companies/${company.id}/revenue/reports/overview?${qs.toString()}`,
      )
      .then(
        (data) => {
          if (seq !== requestSeq.current) return;
          setOverview(data);
          setLoadError(false);
        },
        () => {
          if (seq !== requestSeq.current) return;
          setOverview(null);
          setLoadError(true);
        },
      );
  }, [company.id, period]);

  React.useEffect(() => {
    setOverview(null);
    setLoadError(false);
    void reload();
  }, [reload]);

  useLiveRefetch(["deal", "dealstage", "contact", "activity"], reload);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Revenue" }]} />
      </div>

      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Insights
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {overview
              ? `${formatDay(overview.period.from)} — ${formatDay(overview.period.to)} · reported in ${overview.currency}`
              : "Recurring revenue, pipeline and acquisition for the selected period."}
          </p>
        </div>
        <PeriodSwitcher value={period} onChange={setPeriod} />
      </div>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load insights
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong building the report for this period.
          </p>
          <Button variant="secondary" className="mt-4" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : overview === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : hasNothing(overview) ? (
        <NothingYet slug={company.slug} />
      ) : (
        <div className="space-y-8">
          <StatTiles overview={overview} />
          <MrrWaterfall
            movement={overview.mrr.movement}
            currency={overview.currency}
            coldStart={overview.mrr.series.length <= 1}
          />
          <StageFunnel
            rows={overview.funnel.stages}
            orphanedCount={overview.funnel.orphanedCount}
            currency={overview.currency}
          />
          <CacByChannel cac={overview.cac} currency={overview.currency} />
        </div>
      )}
    </div>
  );
}

function PeriodSwitcher({
  value,
  onChange,
}: {
  value: PeriodId;
  onChange: (next: PeriodId) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Reporting period"
      className="inline-flex flex-wrap gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
    >
      {PERIODS.map((p) => (
        <button
          key={p.id}
          type="button"
          aria-pressed={value === p.id}
          onClick={() => onChange(p.id)}
          className={clsx(
            "rounded-md px-3 py-1.5 text-xs font-medium transition",
            value === p.id
              ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
              : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800",
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ── Headline tiles ─────────────────────────────────────────────────────────

function StatTiles({ overview }: { overview: RevenueOverview }) {
  const { currency } = overview;
  const { winRate } = overview.funnel;
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Tile
        label="MRR"
        value={formatMoney(overview.mrr.currentCents, currency)}
        hint="Recurring revenue in the final month of the period"
      />
      <Tile
        label="ARR"
        value={formatMoney(overview.arrCents, currency)}
        hint="Annual run rate off that month"
      />
      <Tile
        label="Open pipeline"
        value={formatMoney(overview.coverage.openCents, currency)}
        hint="Every deal still in play"
      />
      <Tile
        label="Weighted pipeline"
        value={formatMoney(overview.coverage.weightedCents, currency)}
        hint="Discounted by stage probability"
      />
      <Tile
        label="Win rate"
        value={formatPct(winRate.winRatePct)}
        hint={
          winRate.won + winRate.lost === 0
            ? "Nothing closed in this period"
            : `${winRate.won} won · ${winRate.lost} lost`
        }
      />
      <Tile
        label="Net revenue retention"
        value={formatPct(overview.retention.nrrPct)}
        hint={
          overview.retention.cohortSize === 0
            ? "No opening cohort to measure"
            : `GRR ${formatPct(overview.retention.grrPct)} · ${overview.retention.cohortSize} customers`
        }
      />
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </div>
      <div className="mt-1 text-xs tabular-nums text-slate-400 dark:text-slate-500">{hint}</div>
    </div>
  );
}

// ── MRR movement waterfall ─────────────────────────────────────────────────

const CHART_W = 640;
const CHART_H = 208;
const PAD_TOP = 14;
const PAD_BOTTOM = 52;
const PAD_X = 10;
const PLOT_H = CHART_H - PAD_TOP - PAD_BOTTOM;
const BAR_W = 52;

type WaterfallBar = {
  key: string;
  label: string;
  delta: number;
  start: number;
  end: number;
  tone: "up" | "down" | "net";
};

/**
 * New → expansion → reactivation → contraction → churn → net, drawn as a
 * floating waterfall off a zero baseline. Deliberately hand-rolled SVG: the
 * chart is six rectangles, and a charting library would be more bytes than the
 * whole page.
 */
function MrrWaterfall({
  movement,
  currency,
  coldStart,
}: {
  movement: MrrMovement;
  currency: string;
  coldStart: boolean;
}) {
  const titleId = React.useId();

  const bars: WaterfallBar[] = React.useMemo(() => {
    const steps: Array<{ key: string; label: string; delta: number }> = [
      { key: "new", label: "New", delta: movement.newCents },
      { key: "expansion", label: "Expansion", delta: movement.expansionCents },
      { key: "reactivation", label: "Reactivation", delta: movement.reactivationCents },
      { key: "contraction", label: "Contraction", delta: -movement.contractionCents },
      { key: "churn", label: "Churn", delta: -movement.churnCents },
    ];
    let running = 0;
    const out: WaterfallBar[] = steps.map((step) => {
      const start = running;
      running += step.delta;
      return {
        ...step,
        start,
        end: running,
        tone: step.delta < 0 ? "down" : "up",
      };
    });
    out.push({
      key: "net",
      label: "Net",
      delta: movement.netCents,
      start: 0,
      end: movement.netCents,
      tone: "net",
    });
    return out;
  }, [movement]);

  const colW = (CHART_W - PAD_X * 2) / bars.length;
  const bounds = React.useMemo(() => {
    const values = [0];
    for (const bar of bars) values.push(bar.start, bar.end);
    const max = Math.max(...values);
    const min = Math.min(...values);
    return { max, min, span: max - min || 1 };
  }, [bars]);

  const y = (value: number) => PAD_TOP + ((bounds.max - value) / bounds.span) * PLOT_H;
  const zeroY = y(0);

  const summary = bars
    .map((bar) => `${bar.label} ${formatMoney(bar.delta, currency)}`)
    .join(", ");

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          MRR movement
        </h2>
        <div className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
          {formatMoney(movement.startingCents, currency)} →{" "}
          {formatMoney(movement.endingCents, currency)}
        </div>
      </div>

      <div className="overflow-x-auto p-4">
        <svg
          role="img"
          aria-labelledby={titleId}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="h-auto w-full min-w-[560px]"
        >
          <title id={titleId}>
            {`MRR movement for the selected period. ${summary}. Ending at ${formatMoney(
              movement.endingCents,
              currency,
            )}.`}
          </title>

          <line
            x1={PAD_X}
            x2={CHART_W - PAD_X}
            y1={zeroY}
            y2={zeroY}
            strokeWidth={1}
            className="stroke-slate-200 dark:stroke-slate-700"
          />

          {bars.map((bar, i) => {
            const x = PAD_X + i * colW + (colW - BAR_W) / 2;
            const top = y(Math.max(bar.start, bar.end));
            const height = Math.max(1.5, y(Math.min(bar.start, bar.end)) - top);
            const next = bars[i + 1];
            const fill =
              bar.tone === "up"
                ? "fill-emerald-500 dark:fill-emerald-400"
                : bar.tone === "down"
                  ? "fill-rose-500 dark:fill-rose-400"
                  : "fill-slate-400 dark:fill-slate-500";
            return (
              <g key={bar.key}>
                {next && next.key !== "net" && (
                  <line
                    x1={x + BAR_W}
                    x2={PAD_X + (i + 1) * colW + (colW - BAR_W) / 2}
                    y1={y(bar.end)}
                    y2={y(bar.end)}
                    strokeWidth={1}
                    strokeDasharray="3 3"
                    className="stroke-slate-300 dark:stroke-slate-600"
                  />
                )}
                <rect x={x} y={top} width={BAR_W} height={height} rx={3} className={fill} />
                <text
                  x={x + BAR_W / 2}
                  y={CHART_H - 30}
                  textAnchor="middle"
                  className="fill-slate-500 text-[10px] dark:fill-slate-400"
                >
                  {bar.label}
                </text>
                <text
                  x={x + BAR_W / 2}
                  y={CHART_H - 14}
                  textAnchor="middle"
                  className="fill-slate-700 text-[11px] font-medium tabular-nums dark:fill-slate-200"
                >
                  {`${bar.delta < 0 ? "−" : "+"}${compactMoney(Math.abs(bar.delta), currency)}`}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-slate-100 px-4 py-3 text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
        <LegendDot className="bg-emerald-500 dark:bg-emerald-400" label="Growth" />
        <LegendDot className="bg-rose-500 dark:bg-rose-400" label="Loss" />
        <LegendDot className="bg-slate-400 dark:bg-slate-500" label="Net change" />
        <span className="tabular-nums">
          {movement.counts.new} new · {movement.counts.expanded} expanded ·{" "}
          {movement.counts.churned} churned · {movement.counts.retained} retained
        </span>
      </div>

      {coldStart && (
        <p className="border-t border-slate-100 px-4 py-3 text-xs leading-relaxed text-slate-500 dark:border-slate-800 dark:text-slate-400">
          This window is one month long, so it has no month to compare against — every paying
          customer in it reads as new business rather than as retained. Pick a longer period to
          see real movement.
        </p>
      )}
    </section>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={clsx("inline-block h-2 w-2 rounded-sm", className)} />
      {label}
    </span>
  );
}

// ── Stage funnel ───────────────────────────────────────────────────────────

function StageFunnel({
  rows,
  orphanedCount,
  currency,
}: {
  rows: StageFunnelRow[];
  orphanedCount: number;
  currency: string;
}) {
  const widest = Math.max(1, ...rows.map((r) => r.valueCents));

  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Pipeline by stage
        </h2>
      </div>

      {rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          No stages defined yet.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row) => {
            const pct = Math.round((row.valueCents / widest) * 100);
            const barTone =
              row.stage.kind === "won"
                ? "bg-emerald-500 dark:bg-emerald-400"
                : row.stage.kind === "lost"
                  ? "bg-rose-500 dark:bg-rose-400"
                  : "bg-indigo-500 dark:bg-indigo-400";
            return (
              <li key={row.stage.id} className="px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {row.stage.name}
                  </span>
                  <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                    {row.count} {row.count === 1 ? "deal" : "deals"} ·{" "}
                    <span className="text-slate-700 dark:text-slate-200">
                      {formatMoney(row.valueCents, currency)}
                    </span>{" "}
                    · weighted {formatMoney(row.weightedValueCents, currency)}
                  </span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={clsx("h-full rounded-full", barTone)}
                    style={{ width: `${Math.max(row.valueCents > 0 ? 2 : 0, pct)}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {orphanedCount > 0 && (
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-amber-700 dark:border-slate-800 dark:text-amber-400">
          {orphanedCount} open {orphanedCount === 1 ? "deal sits" : "deals sit"} in a stage that
          no longer exists, so {orphanedCount === 1 ? "it is" : "they are"} missing from the bars
          above.
        </p>
      )}
    </section>
  );
}

// ── CAC by channel ─────────────────────────────────────────────────────────

const CAC_NOTES: Record<ChannelCac["note"], string> = {
  ok: "—",
  "no-wins": "No wins yet",
  organic: "Organic",
};

function CacByChannel({
  cac,
  currency,
}: {
  cac: RevenueOverview["cac"];
  currency: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Acquisition cost by channel
        </h2>
        <div className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
          Blended{" "}
          {cac.blendedCacCents === null ? "—" : formatMoney(cac.blendedCacCents, currency)} ·{" "}
          {formatCount(cac.wonCount)} won
        </div>
      </div>

      {cac.channels.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
          No channel spend or attributed wins in this period.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Channel</th>
                <th className="px-4 py-2 text-right font-medium">Authorized spend</th>
                <th className="px-4 py-2 text-right font-medium">Won</th>
                <th className="px-4 py-2 text-right font-medium">CAC</th>
                <th className="px-4 py-2 text-left font-medium">Note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {cac.channels.map((row) => (
                <tr key={row.channel}>
                  <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100">
                    {row.channel}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {formatMoney(row.spendCents, currency)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {formatCount(row.wonCount)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {row.cacCents === null ? (
                      <span className="text-slate-400 dark:text-slate-500">—</span>
                    ) : (
                      formatMoney(row.cacCents, currency)
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500 dark:text-slate-400">
                    {CAC_NOTES[row.note]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Required, not decorative: the spend column is authorized budget, and
          printing it as settled spend would put an invented CAC in a deck. */}
      <div className="flex items-start gap-2 border-t border-slate-100 px-4 py-3 dark:border-slate-800">
        <Info
          size={14}
          className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden="true"
        />
        <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          <span className="font-medium text-slate-700 dark:text-slate-200">
            Spend is a proxy.
          </span>{" "}
          These figures come from authorized budget changes recorded against your ad accounts,
          not from settled platform spend. A budget authorized on the 1st and paused on the 2nd
          counts in full here; a campaign left running on an untouched budget counts as nothing.
          Treat CAC on this page as a direction, and reconcile against each platform&apos;s
          billing before quoting it.
        </p>
      </div>
    </section>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

/**
 * What a brand-new company sees. Six zeros would be technically accurate and
 * completely useless — this says what the section measures and where the two
 * inputs it needs are created.
 */
function NothingYet({ slug }: { slug: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-200 bg-white p-10 text-center dark:border-slate-700 dark:bg-slate-900">
      <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
        Nothing to report yet
      </h3>
      <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-slate-500 dark:text-slate-400">
        Insights reads your pipeline and your billing history and answers four questions:
        what recurring revenue did, what is still in play, how much of it closes, and what
        each channel costs to acquire. It fills in on its own once there is something to
        measure — add the people you are selling to, then the deals you are working.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Link to={`/c/${slug}/revenue/deals`}>
          <Button>
            <Target size={14} /> Go to Deals
          </Button>
        </Link>
        <Link to={`/c/${slug}/revenue/contacts`}>
          <Button variant="secondary">
            <Contact2 size={14} /> Go to Contacts
          </Button>
        </Link>
      </div>
      <p className="mt-5 text-xs text-slate-400 dark:text-slate-500">
        <Link
          to={`/c/${slug}/revenue/sequences`}
          className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400"
        >
          Or start a sequence to fill the top of the funnel <ArrowRight size={12} />
        </Link>
      </p>
    </div>
  );
}
