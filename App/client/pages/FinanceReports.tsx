import React from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import {
  api,
  BalanceSheetReport,
  CashFlowReport,
  CompanyFinanceSettings,
  FinancialTrendsReport,
  formatBalanceMagnitude,
  formatMoney,
  IncomeStatementReport,
  PeriodPreset,
  PeriodRange,
  priorRangeOf,
  rangeFromPreset,
  ReportEnvelope,
  ReportRow,
} from "../lib/api";
import { parseFinanceReportLink } from "../../shared/financeReportLink";
import { Breadcrumbs } from "../components/AppShell";
import { AccountActivityPanel } from "../components/finance/AccountActivityPanel";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";
import {
  FinancialTrendChart,
  TREND_COLORS,
  type FinancialTrendSeries,
} from "../components/finance/FinancialTrendChart";

type Tab = "income" | "balance" | "cashflow";

const TABS: { key: Tab; label: string; sub: string }[] = [
  { key: "income", label: "Income statement", sub: "Revenue minus expenses for the period" },
  { key: "balance", label: "Balance sheet", sub: "Assets / liabilities / equity as of a date" },
  { key: "cashflow", label: "Cash flow", sub: "Bank movements bucketed by activity" },
];

const PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: "this_month", label: "This month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "this_year", label: "Year to date" },
  { key: "last_month", label: "Last month" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "last_year", label: "Last year" },
  { key: "custom", label: "Custom" },
];

/** Convert a Date to the YYYY-MM-DD string an `<input type="date">` wants. */
function dateInputValue(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Financial reports — Income Statement, Balance Sheet, Cash Flow. Phase
 * C of the Finance milestone (M19).
 *
 * Single page with three tabs because they share the period picker and
 * compare-to-prior toggle. Click any account row to drill through to the
 * entries behind it (`AccountActivityPanel`, the Trial balance's panel too):
 * the period's entries for a P&L line, everything up to the date for a
 * balance sheet line.
 */
export default function FinanceReports() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  // A link from elsewhere — a letter to the board's money figure — opens the
  // report it names on the dates it was read for. Read once, on arrival.
  const [searchParams] = useSearchParams();
  const [linked] = React.useState(() => parseFinanceReportLink(searchParams));
  const [tab, setTab] = React.useState<Tab>(linked?.report ?? "income");
  const [preset, setPreset] = React.useState<PeriodPreset>(linked ? "custom" : "this_year");
  const [compare, setCompare] = React.useState(false);
  // Drill-through state: when set, render the side panel for this account
  // over these days (`from` null: its whole history). Cleared on close.
  const [drill, setDrill] = React.useState<{
    accountId: string;
    from: string | null;
    to: string;
  } | null>(null);

  const range = React.useMemo(() => rangeFromPreset(preset), [preset]);
  const [customFrom, setCustomFrom] = React.useState(
    () => linked?.from ?? dateInputValue(range.from),
  );
  const [customTo, setCustomTo] = React.useState(() => linked?.to ?? dateInputValue(range.to));

  // Sync custom inputs to preset selection so switching from a preset to
  // custom remembers what the preset showed.
  React.useEffect(() => {
    if (preset !== "custom") {
      setCustomFrom(dateInputValue(range.from));
      setCustomTo(dateInputValue(range.to));
    }
  }, [preset, range.from, range.to]);

  const effectiveRange: PeriodRange = React.useMemo(() => {
    if (preset === "custom") {
      return { from: new Date(customFrom), to: new Date(customTo) };
    }
    return range;
  }, [preset, range, customFrom, customTo]);

  const priorRange = React.useMemo(() => priorRangeOf(effectiveRange), [effectiveRange]);
  const [trends, setTrends] = React.useState<FinancialTrendsReport | null>(null);
  const [trendsLoading, setTrendsLoading] = React.useState(true);
  const [trendError, setTrendError] = React.useState("");
  const [homeCurrency, setHomeCurrency] = React.useState("USD");

  React.useEffect(() => {
    if (Number.isNaN(effectiveRange.from.getTime()) || Number.isNaN(effectiveRange.to.getTime())) {
      setTrendError("Choose a valid date range to draw the chart.");
      setTrends(null);
      return;
    }
    let alive = true;
    // The chart keeps the previous period's months up, dimmed, until these land.
    setTrendsLoading(true);
    setTrendError("");
    const query = new URLSearchParams({
      from: effectiveRange.from.toISOString(),
      to: effectiveRange.to.toISOString(),
    });
    api
      .get<FinancialTrendsReport>(`/api/companies/${company.id}/reports/trends?${query.toString()}`)
      .then((report) => {
        if (alive) setTrends(report);
      })
      .catch((err: unknown) => {
        if (alive) setTrendError((err as Error).message || "Could not load chart data");
      })
      .finally(() => {
        if (alive) setTrendsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [company.id, effectiveRange.from, effectiveRange.to]);

  React.useEffect(() => {
    let alive = true;
    api
      .get<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`)
      .then((settings) => {
        if (alive) setHomeCurrency(settings.homeCurrency);
      })
      .catch(() => {
        if (alive) setHomeCurrency("USD");
      });
    return () => {
      alive = false;
    };
  }, [company.id]);

  const trendConfig = trendSeriesFor(tab);

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Reports" }]}
        />
      </div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Reports</h1>
      <p className="mt-1 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
        Profit and loss, balance sheet, and cash flow, straight from your books. Click any line to
        see the entries behind it.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-900">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPreset(p.key)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition " +
                (preset === p.key
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
                  : "text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800")
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <>
            <input
              type="date"
              aria-label="From date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <span className="text-xs text-slate-400">to</span>
            <input
              type="date"
              aria-label="To date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
          </>
        )}
        <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            checked={compare}
            onChange={(e) => setCompare(e.target.checked)}
            className="rounded border-slate-300"
          />
          Compare to prior period
        </label>
      </div>

      <div className="mt-6 flex border-b border-slate-200 dark:border-slate-700">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={
              "border-b-2 px-4 py-2 text-sm font-medium transition " +
              (tab === t.key
                ? "border-indigo-500 text-indigo-700 dark:text-indigo-300"
                : "border-transparent text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {trendError ? (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-500/10 dark:text-red-300">
            {trendError}
          </div>
        ) : (
          <FinancialTrendChart
            title={trendConfig.title}
            subtitle={trendConfig.subtitle}
            points={trends?.points ?? null}
            series={trendConfig.series}
            truncated={trends?.truncated}
            homeCurrency={homeCurrency}
            loading={trendsLoading}
          />
        )}
      </div>

      <div className="mt-6">
        {tab === "income" && (
          <IncomeStatementView
            companyId={company.id}
            homeCurrency={homeCurrency}
            range={effectiveRange}
            priorRange={compare ? priorRange : null}
            onDrill={(accountId) =>
              setDrill({
                accountId,
                from: dateInputValue(effectiveRange.from),
                to: dateInputValue(effectiveRange.to),
              })
            }
          />
        )}
        {tab === "balance" && (
          <BalanceSheetView
            companyId={company.id}
            homeCurrency={homeCurrency}
            asOf={effectiveRange.to}
            priorAsOf={compare ? priorRange.to : null}
            onDrill={(accountId) =>
              // Balance sheet is cumulative — drill-through shows the
              // account's whole history up to the sheet's date.
              setDrill({ accountId, from: null, to: dateInputValue(effectiveRange.to) })
            }
          />
        )}
        {tab === "cashflow" && (
          <CashFlowView
            companyId={company.id}
            homeCurrency={homeCurrency}
            range={effectiveRange}
            priorRange={compare ? priorRange : null}
          />
        )}
      </div>

      {drill && (
        <AccountActivityPanel
          key={`${drill.accountId}:${drill.from}:${drill.to}`}
          companyId={company.id}
          homeCurrency={homeCurrency}
          accountId={drill.accountId}
          from={drill.from}
          to={drill.to}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

function trendSeriesFor(tab: Tab): {
  title: string;
  subtitle: string;
  series: FinancialTrendSeries[];
} {
  // Each report draws its two flows as columns and what they come to as a
  // line, coloured in that order.
  const [first, second, line] = TREND_COLORS;
  if (tab === "balance") {
    return {
      title: "Balance sheet trend",
      subtitle: "Month-end assets, liabilities, and equity from the live ledger.",
      series: [
        { key: "assets", label: "Assets", color: first, kind: "bar", summary: "last" },
        { key: "liabilities", label: "Liabilities", color: second, kind: "bar", summary: "last" },
        { key: "equity", label: "Equity", color: line, kind: "line", summary: "last" },
      ],
    };
  }
  if (tab === "cashflow") {
    return {
      title: "Cash-flow trend",
      subtitle: "Monthly operating cash and net change, with the closing cash balance.",
      series: [
        {
          key: "operatingCash",
          label: "Operating cash",
          color: first,
          kind: "bar",
          summary: "sum",
        },
        { key: "netCash", label: "Net change", color: second, kind: "bar", summary: "sum" },
        { key: "closingCash", label: "Closing cash", color: line, kind: "line", summary: "last" },
      ],
    };
  }
  return {
    title: "Profit and loss trend",
    subtitle: "Monthly revenue, expenses, and net income.",
    series: [
      { key: "revenue", label: "Revenue", color: first, kind: "bar", summary: "sum" },
      { key: "expenses", label: "Expenses", color: second, kind: "bar", summary: "sum" },
      { key: "netIncome", label: "Net income", color: line, kind: "line", summary: "sum" },
    ],
  };
}

// ────────────────────────── Income Statement ─────────────────────────

function IncomeStatementView({
  companyId,
  homeCurrency,
  range,
  priorRange,
  onDrill,
}: {
  companyId: string;
  homeCurrency: string;
  range: PeriodRange;
  priorRange: PeriodRange | null;
  onDrill: (accountId: string) => void;
}) {
  const data = useReport<IncomeStatementReport>(
    companyId,
    "/reports/income-statement",
    range,
    priorRange,
  );
  if (data === "loading") return <ReportSpinner />;
  if (data === "error") return <ReportError />;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <ReportTable
        title="Revenue"
        homeCurrency={homeCurrency}
        rows={data.current.revenue}
        priorRows={data.prior?.revenue}
        total={data.current.totalRevenue}
        priorTotal={data.prior?.totalRevenue}
        onDrill={onDrill}
      />
      <ReportTable
        title="Expenses"
        homeCurrency={homeCurrency}
        rows={data.current.expenses}
        priorRows={data.prior?.expenses}
        total={data.current.totalExpenses}
        priorTotal={data.prior?.totalExpenses}
        onDrill={onDrill}
      />
      <div className="flex items-center justify-between border-t-2 border-slate-300 bg-slate-50 px-4 py-3 dark:border-slate-600 dark:bg-slate-800/60">
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Net income</div>
        <div className="flex gap-12">
          {data.prior && (
            <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {formatMoney(data.prior.netIncome, homeCurrency)}
            </div>
          )}
          <div
            className={
              "tabular-nums text-base font-semibold " +
              (data.current.netIncome >= 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400")
            }
          >
            {formatMoney(data.current.netIncome, homeCurrency)}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportTable({
  title,
  homeCurrency,
  rows,
  priorRows,
  total,
  priorTotal,
  onDrill,
}: {
  title: string;
  homeCurrency: string;
  rows: ReportRow[];
  priorRows?: ReportRow[];
  total: number;
  priorTotal?: number;
  onDrill: (accountId: string) => void;
}) {
  const priorByAcct = new Map((priorRows ?? []).map((r) => [r.account.id, r.amountCents]));
  return (
    <div className="border-b border-slate-100 last:border-b-0 dark:border-slate-800">
      <div className="bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500 dark:bg-slate-800/40 dark:text-slate-400 inline-block first-letter:uppercase">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="px-4 py-3 text-sm text-slate-400">No activity in this period.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.account.id}>
                <td className="w-20 px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {r.account.code}
                </td>
                <td className="px-2 py-2">
                  <button
                    onClick={() => onDrill(r.account.id)}
                    className="text-left text-slate-700 hover:underline dark:text-slate-200"
                  >
                    {r.account.name}
                  </button>
                </td>
                {priorRows !== undefined && (
                  <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {priorByAcct.has(r.account.id)
                      ? formatMoney(priorByAcct.get(r.account.id)!, homeCurrency)
                      : ""}
                  </td>
                )}
                <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {formatMoney(r.amountCents, homeCurrency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/30">
        <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Total {title.toLowerCase()}
        </div>
        <div className="flex gap-12">
          {priorTotal !== undefined && (
            <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {formatMoney(priorTotal, homeCurrency)}
            </div>
          )}
          <div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(total, homeCurrency)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Balance Sheet ────────────────────────────

function BalanceSheetView({
  companyId,
  homeCurrency,
  asOf,
  priorAsOf,
  onDrill,
}: {
  companyId: string;
  homeCurrency: string;
  asOf: Date;
  priorAsOf: Date | null;
  onDrill: (accountId: string) => void;
}) {
  const data = useBalanceSheet(companyId, asOf, priorAsOf);
  if (data === "loading") return <ReportSpinner />;
  if (data === "error") return <ReportError />;

  const liabAndEquity = data.current.totalLiabilities + data.current.totalEquity;
  const balanced = liabAndEquity === data.current.totalAssets;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <BSSection
        title="Assets"
        homeCurrency={homeCurrency}
        rows={data.current.assets}
        priorRows={data.prior?.assets}
        total={data.current.totalAssets}
        priorTotal={data.prior?.totalAssets}
        onDrill={onDrill}
      />
      <BSSection
        title="Liabilities"
        homeCurrency={homeCurrency}
        rows={data.current.liabilities}
        priorRows={data.prior?.liabilities}
        total={data.current.totalLiabilities}
        priorTotal={data.prior?.totalLiabilities}
        onDrill={onDrill}
      />
      <BSSection
        title="Equity"
        homeCurrency={homeCurrency}
        rows={data.current.equity}
        priorRows={data.prior?.equity}
        extraRow={{
          label: "Current period earnings",
          amount: data.current.currentEarnings,
          priorAmount: data.prior?.currentEarnings,
        }}
        total={data.current.totalEquity}
        priorTotal={data.prior?.totalEquity}
        onDrill={onDrill}
      />
      <div className="flex items-center justify-between border-t-2 border-slate-300 bg-slate-50 px-4 py-3 dark:border-slate-600 dark:bg-slate-800/60">
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Liabilities + equity
        </div>
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(liabAndEquity, homeCurrency)}
          </div>
          <span
            className={
              "rounded-full px-2 py-0.5 text-xs font-medium inline-block first-letter:uppercase " +
              (balanced
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                : "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300")
            }
          >
            {balanced ? "Balanced" : "Unbalanced"}
          </span>
        </div>
      </div>
    </div>
  );
}

function BSSection({
  title,
  homeCurrency,
  rows,
  priorRows,
  total,
  priorTotal,
  extraRow,
  onDrill,
}: {
  title: string;
  homeCurrency: string;
  rows: ReportRow[];
  priorRows?: ReportRow[];
  total: number;
  priorTotal?: number;
  extraRow?: { label: string; amount: number; priorAmount?: number };
  onDrill: (accountId: string) => void;
}) {
  const priorByAcct = new Map((priorRows ?? []).map((r) => [r.account.id, r.amountCents]));
  const showPrior = priorRows !== undefined;
  return (
    <div className="border-b border-slate-100 last:border-b-0 dark:border-slate-800">
      <div className="bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500 dark:bg-slate-800/40 dark:text-slate-400 inline-block first-letter:uppercase">
        {title}
      </div>
      {rows.length === 0 && !extraRow ? (
        <div className="px-4 py-3 text-sm text-slate-400">No balance.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.account.id}>
                <td className="w-20 px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                  {r.account.code}
                </td>
                <td className="px-2 py-2">
                  <button
                    onClick={() => onDrill(r.account.id)}
                    className="text-left text-slate-700 hover:underline dark:text-slate-200"
                  >
                    {r.account.name}
                  </button>
                </td>
                {showPrior && (
                  <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {priorByAcct.has(r.account.id)
                      ? formatMoney(priorByAcct.get(r.account.id)!, homeCurrency)
                      : ""}
                  </td>
                )}
                <td
                  className={
                    "w-32 px-4 py-2 text-right tabular-nums " +
                    (r.amountCents < 0
                      ? "text-amber-700 dark:text-amber-400"
                      : "text-slate-900 dark:text-slate-100")
                  }
                >
                  {r.amountCents < 0
                    ? `(${formatBalanceMagnitude(r.amountCents, homeCurrency)})`
                    : formatMoney(r.amountCents, homeCurrency)}
                </td>
              </tr>
            ))}
            {extraRow && (
              <tr>
                <td className="w-20 px-4 py-2 font-mono text-xs text-slate-400">—</td>
                <td className="px-2 py-2 italic text-slate-500 dark:text-slate-400">
                  {extraRow.label}
                </td>
                {showPrior && (
                  <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {extraRow.priorAmount !== undefined
                      ? formatMoney(extraRow.priorAmount, homeCurrency)
                      : ""}
                  </td>
                )}
                <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                  {formatMoney(extraRow.amount, homeCurrency)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/30">
        <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
          Total {title.toLowerCase()}
        </div>
        <div className="flex gap-12">
          {priorTotal !== undefined && (
            <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {formatMoney(priorTotal, homeCurrency)}
            </div>
          )}
          <div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(total, homeCurrency)}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Cash Flow ────────────────────────────────

function CashFlowView({
  companyId,
  homeCurrency,
  range,
  priorRange,
}: {
  companyId: string;
  homeCurrency: string;
  range: PeriodRange;
  priorRange: PeriodRange | null;
}) {
  const data = useReport<CashFlowReport>(companyId, "/reports/cash-flow", range, priorRange);
  if (data === "loading") return <ReportSpinner />;
  if (data === "error") return <ReportError />;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <CFRow
        label="Opening cash balance"
        homeCurrency={homeCurrency}
        amount={data.current.openingBalance}
        priorAmount={data.prior?.openingBalance}
        bold
      />
      <CFSection
        section={data.current.operating}
        priorSection={data.prior?.operating}
        homeCurrency={homeCurrency}
      />
      <CFSection
        section={data.current.investing}
        priorSection={data.prior?.investing}
        homeCurrency={homeCurrency}
      />
      <CFSection
        section={data.current.financing}
        priorSection={data.prior?.financing}
        homeCurrency={homeCurrency}
      />
      <CFRow
        label="Net change in cash"
        homeCurrency={homeCurrency}
        amount={data.current.netChange}
        priorAmount={data.prior?.netChange}
        bold
        accent
      />
      <CFRow
        label="Closing cash balance"
        homeCurrency={homeCurrency}
        amount={data.current.closingBalance}
        priorAmount={data.prior?.closingBalance}
        bold
      />
    </div>
  );
}

function CFSection({
  section,
  priorSection,
  homeCurrency,
}: {
  section: CashFlowReport["operating"];
  priorSection?: CashFlowReport["operating"];
  homeCurrency: string;
}) {
  return (
    <div className="border-t border-slate-100 dark:border-slate-800">
      <div className="bg-slate-50 px-4 py-2 text-xs font-medium text-slate-500 dark:bg-slate-800/40 dark:text-slate-400 inline-block first-letter:uppercase">
        {section.label}
      </div>
      {section.lines.length === 0 ? (
        <div className="px-4 py-2 text-sm text-slate-400">None in this period.</div>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {section.lines.map((l, i) => (
              <tr key={`${l.entryId}-${i}`}>
                <td className="px-4 py-2 text-slate-700 dark:text-slate-200">{l.description}</td>
                <td
                  className={
                    "w-32 px-4 py-2 text-right tabular-nums " +
                    (l.cents < 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-slate-900 dark:text-slate-100")
                  }
                >
                  {formatMoney(l.cents, homeCurrency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CFRow
        label={`Total ${section.label.toLowerCase()}`}
        homeCurrency={homeCurrency}
        amount={section.total}
        priorAmount={priorSection?.total}
        small
      />
    </div>
  );
}

function CFRow({
  label,
  homeCurrency,
  amount,
  priorAmount,
  bold,
  small,
  accent,
}: {
  label: string;
  homeCurrency: string;
  amount: number;
  priorAmount?: number;
  bold?: boolean;
  small?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      className={
        "flex items-center justify-between border-t border-slate-100 px-4 py-2 dark:border-slate-800 " +
        (bold ? "bg-slate-50 dark:bg-slate-800/40 " : small ? "" : "")
      }
    >
      <div
        className={
          (small
            ? "text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400"
            : "text-sm text-slate-700 dark:text-slate-200") +
          (bold ? " font-semibold text-slate-900 dark:text-slate-100" : "")
        }
      >
        {label}
      </div>
      <div className="flex gap-12">
        {priorAmount !== undefined && (
          <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
            {formatMoney(priorAmount, homeCurrency)}
          </div>
        )}
        <div
          className={
            "tabular-nums " +
            (bold ? "text-base font-semibold " : "text-sm ") +
            (accent
              ? amount >= 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-rose-700 dark:text-rose-400"
              : "text-slate-900 dark:text-slate-100")
          }
        >
          {formatMoney(amount, homeCurrency)}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Loaders ──────────────────────────────────

function useReport<T>(
  companyId: string,
  path: string,
  range: PeriodRange,
  priorRange: PeriodRange | null,
): ReportEnvelope<T> | "loading" | "error" {
  const [data, setData] = React.useState<ReportEnvelope<T> | "loading" | "error">("loading");
  React.useEffect(() => {
    let alive = true;
    setData("loading");
    const params = new URLSearchParams({
      from: range.from.toISOString(),
      to: range.to.toISOString(),
    });
    if (priorRange) {
      params.set("compareFrom", priorRange.from.toISOString());
      params.set("compareTo", priorRange.to.toISOString());
    }
    api
      .get<ReportEnvelope<T>>(`/api/companies/${companyId}${path}?${params}`)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => {
        if (alive) setData("error");
      });
    return () => {
      alive = false;
    };
  }, [companyId, path, range.from, range.to, priorRange]);
  return data;
}

function useBalanceSheet(companyId: string, asOf: Date, priorAsOf: Date | null) {
  const [data, setData] = React.useState<ReportEnvelope<BalanceSheetReport> | "loading" | "error">(
    "loading",
  );
  React.useEffect(() => {
    let alive = true;
    setData("loading");
    const params = new URLSearchParams({ asOf: asOf.toISOString() });
    if (priorAsOf) params.set("compareAsOf", priorAsOf.toISOString());
    api
      .get<ReportEnvelope<BalanceSheetReport>>(
        `/api/companies/${companyId}/reports/balance-sheet?${params}`,
      )
      .then((r) => {
        if (alive) setData(r);
      })
      .catch(() => {
        if (alive) setData("error");
      });
    return () => {
      alive = false;
    };
  }, [companyId, asOf, priorAsOf]);
  return data;
}

function ReportSpinner() {
  return (
    <div className="flex justify-center p-16">
      <Spinner size={20} />
    </div>
  );
}

function ReportError() {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-300">
      Failed to load this report.
    </div>
  );
}
