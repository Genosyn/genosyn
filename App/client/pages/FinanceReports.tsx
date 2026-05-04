import React from "react";
import { useOutletContext } from "react-router-dom";
import { X } from "lucide-react";
import {
  AccountActivityReport,
  api,
  BalanceSheetReport,
  CashFlowReport,
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
import { Breadcrumbs } from "../components/AppShell";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";

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
 * compare-to-prior toggle. Click any account row to drill through to a
 * running-balance ledger of that account in the period — same panel
 * across all three reports.
 */
export default function FinanceReports() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const [tab, setTab] = React.useState<Tab>("income");
  const [preset, setPreset] = React.useState<PeriodPreset>("this_year");
  const [compare, setCompare] = React.useState(false);
  // Drill-through state: when set, render the side panel for this
  // account + period. Cleared when the user closes it.
  const [drill, setDrill] = React.useState<{ accountId: string; range: PeriodRange | null } | null>(null);

  const range = React.useMemo(() => rangeFromPreset(preset), [preset]);
  const [customFrom, setCustomFrom] = React.useState(() => dateInputValue(range.from));
  const [customTo, setCustomTo] = React.useState(() => dateInputValue(range.to));

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

  const priorRange = React.useMemo(
    () => priorRangeOf(effectiveRange),
    [effectiveRange],
  );

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Reports" },
          ]}
        />
      </div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Reports
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        Pulled live from the general ledger. Click any line to drill
        through to its source entries.
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
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
            />
            <span className="text-xs text-slate-400">to</span>
            <input
              type="date"
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
        {tab === "income" && (
          <IncomeStatementView
            companyId={company.id}
            range={effectiveRange}
            priorRange={compare ? priorRange : null}
            onDrill={(accountId) =>
              setDrill({ accountId, range: effectiveRange })
            }
          />
        )}
        {tab === "balance" && (
          <BalanceSheetView
            companyId={company.id}
            asOf={effectiveRange.to}
            priorAsOf={compare ? priorRange.to : null}
            onDrill={(accountId) =>
              // Balance sheet is cumulative — drill-through shows
              // everything-to-date so accountants see the full history.
              setDrill({ accountId, range: null })
            }
          />
        )}
        {tab === "cashflow" && (
          <CashFlowView
            companyId={company.id}
            range={effectiveRange}
            priorRange={compare ? priorRange : null}
          />
        )}
      </div>

      {drill && (
        <DrillPanel
          companyId={company.id}
          accountId={drill.accountId}
          range={drill.range}
          onClose={() => setDrill(null)}
        />
      )}
    </div>
  );
}

// ────────────────────────── Income Statement ─────────────────────────

function IncomeStatementView({
  companyId,
  range,
  priorRange,
  onDrill,
}: {
  companyId: string;
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
        rows={data.current.revenue}
        priorRows={data.prior?.revenue}
        total={data.current.totalRevenue}
        priorTotal={data.prior?.totalRevenue}
        onDrill={onDrill}
      />
      <ReportTable
        title="Expenses"
        rows={data.current.expenses}
        priorRows={data.prior?.expenses}
        total={data.current.totalExpenses}
        priorTotal={data.prior?.totalExpenses}
        onDrill={onDrill}
      />
      <div className="flex items-center justify-between border-t-2 border-slate-300 bg-slate-50 px-4 py-3 dark:border-slate-600 dark:bg-slate-800/60">
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Net income
        </div>
        <div className="flex gap-12">
          {data.prior && (
            <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {formatMoney(data.prior.netIncome, "USD")}
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
            {formatMoney(data.current.netIncome, "USD")}
          </div>
        </div>
      </div>
    </div>
  );
}

function ReportTable({
  title,
  rows,
  priorRows,
  total,
  priorTotal,
  onDrill,
}: {
  title: string;
  rows: ReportRow[];
  priorRows?: ReportRow[];
  total: number;
  priorTotal?: number;
  onDrill: (accountId: string) => void;
}) {
  const priorByAcct = new Map(
    (priorRows ?? []).map((r) => [r.account.id, r.amountCents]),
  );
  return (
    <div className="border-b border-slate-100 last:border-b-0 dark:border-slate-800">
      <div className="bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
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
                      ? formatMoney(priorByAcct.get(r.account.id)!, "USD")
                      : ""}
                  </td>
                )}
                <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {formatMoney(r.amountCents, "USD")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/30">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Total {title.toLowerCase()}
        </div>
        <div className="flex gap-12">
          {priorTotal !== undefined && (
            <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {formatMoney(priorTotal, "USD")}
            </div>
          )}
          <div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(total, "USD")}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Balance Sheet ────────────────────────────

function BalanceSheetView({
  companyId,
  asOf,
  priorAsOf,
  onDrill,
}: {
  companyId: string;
  asOf: Date;
  priorAsOf: Date | null;
  onDrill: (accountId: string) => void;
}) {
  const data = useBalanceSheet(companyId, asOf, priorAsOf);
  if (data === "loading") return <ReportSpinner />;
  if (data === "error") return <ReportError />;

  const liabAndEquity =
    data.current.totalLiabilities + data.current.totalEquity;
  const balanced = liabAndEquity === data.current.totalAssets;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <BSSection
        title="Assets"
        rows={data.current.assets}
        priorRows={data.prior?.assets}
        total={data.current.totalAssets}
        priorTotal={data.prior?.totalAssets}
        onDrill={onDrill}
      />
      <BSSection
        title="Liabilities"
        rows={data.current.liabilities}
        priorRows={data.prior?.liabilities}
        total={data.current.totalLiabilities}
        priorTotal={data.prior?.totalLiabilities}
        onDrill={onDrill}
      />
      <BSSection
        title="Equity"
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
            {formatMoney(liabAndEquity, "USD")}
          </div>
          <span
            className={
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
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
  rows,
  priorRows,
  total,
  priorTotal,
  extraRow,
  onDrill,
}: {
  title: string;
  rows: ReportRow[];
  priorRows?: ReportRow[];
  total: number;
  priorTotal?: number;
  extraRow?: { label: string; amount: number; priorAmount?: number };
  onDrill: (accountId: string) => void;
}) {
  const priorByAcct = new Map(
    (priorRows ?? []).map((r) => [r.account.id, r.amountCents]),
  );
  const showPrior = priorRows !== undefined;
  return (
    <div className="border-b border-slate-100 last:border-b-0 dark:border-slate-800">
      <div className="bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
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
                      ? formatMoney(priorByAcct.get(r.account.id)!, "USD")
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
                    ? `(${formatBalanceMagnitude(r.amountCents, "USD")})`
                    : formatMoney(r.amountCents, "USD")}
                </td>
              </tr>
            ))}
            {extraRow && (
              <tr>
                <td className="w-20 px-4 py-2 font-mono text-xs text-slate-400">
                  —
                </td>
                <td className="px-2 py-2 italic text-slate-500 dark:text-slate-400">
                  {extraRow.label}
                </td>
                {showPrior && (
                  <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {extraRow.priorAmount !== undefined
                      ? formatMoney(extraRow.priorAmount, "USD")
                      : ""}
                  </td>
                )}
                <td className="w-32 px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                  {formatMoney(extraRow.amount, "USD")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
      <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-800/30">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Total {title.toLowerCase()}
        </div>
        <div className="flex gap-12">
          {priorTotal !== undefined && (
            <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
              {formatMoney(priorTotal, "USD")}
            </div>
          )}
          <div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {formatMoney(total, "USD")}
          </div>
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Cash Flow ────────────────────────────────

function CashFlowView({
  companyId,
  range,
  priorRange,
}: {
  companyId: string;
  range: PeriodRange;
  priorRange: PeriodRange | null;
}) {
  const data = useReport<CashFlowReport>(
    companyId,
    "/reports/cash-flow",
    range,
    priorRange,
  );
  if (data === "loading") return <ReportSpinner />;
  if (data === "error") return <ReportError />;

  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <CFRow
        label="Opening cash balance"
        amount={data.current.openingBalance}
        priorAmount={data.prior?.openingBalance}
        bold
      />
      <CFSection section={data.current.operating} priorSection={data.prior?.operating} />
      <CFSection section={data.current.investing} priorSection={data.prior?.investing} />
      <CFSection section={data.current.financing} priorSection={data.prior?.financing} />
      <CFRow
        label="Net change in cash"
        amount={data.current.netChange}
        priorAmount={data.prior?.netChange}
        bold
        accent
      />
      <CFRow
        label="Closing cash balance"
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
}: {
  section: CashFlowReport["operating"];
  priorSection?: CashFlowReport["operating"];
}) {
  return (
    <div className="border-t border-slate-100 dark:border-slate-800">
      <div className="bg-slate-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
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
                  {formatMoney(l.cents, "USD")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CFRow
        label={`Total ${section.label.toLowerCase()}`}
        amount={section.total}
        priorAmount={priorSection?.total}
        small
      />
    </div>
  );
}

function CFRow({
  label,
  amount,
  priorAmount,
  bold,
  small,
  accent,
}: {
  label: string;
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
        (bold
          ? "bg-slate-50 dark:bg-slate-800/40 "
          : small
            ? ""
            : "")
      }
    >
      <div
        className={
          (small ? "text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400" : "text-sm text-slate-700 dark:text-slate-200") +
          (bold ? " font-semibold text-slate-900 dark:text-slate-100" : "")
        }
      >
        {label}
      </div>
      <div className="flex gap-12">
        {priorAmount !== undefined && (
          <div className="text-sm tabular-nums text-slate-500 dark:text-slate-400">
            {formatMoney(priorAmount, "USD")}
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
          {formatMoney(amount, "USD")}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────── Drill panel ───────────────────────────────

function DrillPanel({
  companyId,
  accountId,
  range,
  onClose,
}: {
  companyId: string;
  accountId: string;
  range: PeriodRange | null;
  onClose: () => void;
}) {
  const [data, setData] = React.useState<AccountActivityReport | null | "error">(null);

  React.useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ accountId });
    if (range) {
      params.set("from", range.from.toISOString());
      params.set("to", range.to.toISOString());
    }
    api
      .get<AccountActivityReport>(
        `/api/companies/${companyId}/reports/account-activity?${params}`,
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
  }, [companyId, accountId, range]);

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-slate-900/30 dark:bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-3 dark:border-slate-800">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Account activity
            </div>
            <div className="mt-0.5 text-base font-semibold text-slate-900 dark:text-slate-100">
              {data && data !== "error" ? (
                <>
                  <span className="font-mono text-sm text-slate-500 dark:text-slate-400">
                    {data.account.code}
                  </span>{" "}
                  {data.account.name}
                </>
              ) : (
                "…"
              )}
            </div>
            {range && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {dateInputValue(range.from)} → {dateInputValue(range.to)}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {data === null ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner size={20} />
          </div>
        ) : data === "error" ? (
          <div className="p-6 text-sm text-rose-600">
            Failed to load account activity.
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <div className="flex items-center justify-between bg-slate-50 px-4 py-2 text-xs dark:bg-slate-800/40">
              <span className="text-slate-500 dark:text-slate-400">Opening</span>
              <span className="tabular-nums text-slate-700 dark:text-slate-200">
                {formatMoney(data.openingBalance, "USD")}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800/40 dark:text-slate-400">
                <tr>
                  <th className="w-24 px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">Debit</th>
                  <th className="w-24 px-3 py-2 text-right font-medium">Credit</th>
                  <th className="w-28 px-3 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-sm text-slate-400">
                      No activity in this period.
                    </td>
                  </tr>
                ) : (
                  data.rows.map((r, i) => (
                    <tr key={`${r.entryId}-${i}`}>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {r.date.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2 text-slate-700 dark:text-slate-200">
                        <div>{r.memo || r.description || <span className="text-slate-400">(no memo)</span>}</div>
                        {r.description && r.memo && (
                          <div className="text-xs text-slate-400">{r.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                        {r.debitCents > 0 ? formatMoney(r.debitCents, "USD") : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                        {r.creditCents > 0 ? formatMoney(r.creditCents, "USD") : ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                        {formatMoney(r.runningBalanceCents, "USD")}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-t-2 border-slate-300 bg-slate-50 px-4 py-2 text-sm dark:border-slate-600 dark:bg-slate-800/60">
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                Closing
              </span>
              <span className="font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                {formatMoney(data.closingBalance, "USD")}
              </span>
            </div>
          </div>
        )}
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
  const [data, setData] = React.useState<ReportEnvelope<T> | "loading" | "error">(
    "loading",
  );
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

function useBalanceSheet(
  companyId: string,
  asOf: Date,
  priorAsOf: Date | null,
) {
  const [data, setData] = React.useState<
    ReportEnvelope<BalanceSheetReport> | "loading" | "error"
  >("loading");
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

