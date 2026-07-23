import React from "react";
import { Link, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Download, ExternalLink, Printer } from "lucide-react";
import {
  api,
  CustomerStatement as Statement,
  CustomerStatementResponse,
  formatMoney,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { CustomersOutletCtx } from "./CustomersLayout";

/**
 * Customer statement — a statement of account for one customer: a
 * chronological ledger of every issued invoice (charge) and payment
 * (credit) with a running balance, opening/closing totals, and an aging
 * summary of what's still owed. Rendered in-app for viewing, and the same
 * data is available as printable HTML / a downloadable PDF via the
 * `/statement/html` + `/statement/pdf` routes.
 */

type Preset = "all" | "this_month" | "this_quarter" | "ytd" | "last_12m" | "custom";

const PRESETS: { key: Preset; label: string }[] = [
  { key: "all", label: "All time" },
  { key: "this_month", label: "This month" },
  { key: "this_quarter", label: "This quarter" },
  { key: "ytd", label: "Year to date" },
  { key: "last_12m", label: "Last 12 months" },
  { key: "custom", label: "Custom" },
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Resolve a preset into `{ from, to }` ISO date strings. `from === ""`
 *  means no lower bound (all history). `to` is always today. */
function presetRange(p: Exclude<Preset, "custom">, now = new Date()): {
  from: string;
  to: string;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const today = iso(now);
  switch (p) {
    case "all":
      return { from: "", to: today };
    case "this_month":
      return { from: iso(new Date(Date.UTC(y, m, 1))), to: today };
    case "this_quarter":
      return { from: iso(new Date(Date.UTC(y, Math.floor(m / 3) * 3, 1))), to: today };
    case "ytd":
      return { from: iso(new Date(Date.UTC(y, 0, 1))), to: today };
    case "last_12m":
      return { from: iso(new Date(Date.UTC(y - 1, m, d))), to: today };
  }
}

export default function CustomerStatement() {
  const { company } = useOutletContext<CustomersOutletCtx>();
  const { customerSlug } = useParams();
  const customersUrl = `/c/${company.slug}/customers`;

  const [preset, setPreset] = React.useState<Preset>("all");
  const today = React.useMemo(() => iso(new Date()), []);
  const [customFrom, setCustomFrom] = React.useState("");
  const [customTo, setCustomTo] = React.useState(today);
  // "" = let the server pick the default currency; otherwise the explicit
  // currency the user selected from the switcher.
  const [currency, setCurrency] = React.useState("");

  const { from, to } = React.useMemo(() => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    return presetRange(preset);
  }, [preset, customFrom, customTo]);

  const [data, setData] = React.useState<CustomerStatementResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const queryString = React.useMemo(() => {
    const q = new URLSearchParams();
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    if (currency) q.set("currency", currency);
    const s = q.toString();
    return s ? `?${s}` : "";
  }, [from, to, currency]);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<CustomerStatementResponse>(
        `/api/companies/${company.id}/customers/${customerSlug}/statement${queryString}`,
      );
      setData(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [company.id, customerSlug, queryString]);

  React.useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  // A statement is derived from issued invoices + payments — refetch when the
  // customer's billing changes.
  useLiveRefetch("invoice", reload);

  const statement = data?.statement ?? null;
  const customerName = data?.customer.name ?? customerSlug ?? "";
  const baseUrl = `/api/companies/${company.id}/customers/${customerSlug}/statement`;

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Customers", to: customersUrl },
            { label: customerName, to: `${customersUrl}/${customerSlug}` },
            { label: "Statement" },
          ]}
        />
      </div>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Link
            to={`${customersUrl}/${customerSlug}`}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              Statement of account
            </h1>
            <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              {customerName}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            onClick={() => window.open(`${baseUrl}/html${queryString}`, "_blank")}
          >
            <Printer size={14} /> Print view
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              window.location.href = `${baseUrl}/pdf${queryString}`;
            }}
          >
            <Download size={14} /> Download PDF
          </Button>
        </div>
      </div>

      {/* Controls — period presets, custom range, currency switcher. */}
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPreset(p.key)}
              className={
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors " +
                (preset === p.key
                  ? "bg-indigo-600 text-white"
                  : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800")
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-2 text-sm">
            <input
              type="date"
              value={customFrom}
              max={customTo || today}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
            />
            <span className="text-slate-400">→</span>
            <input
              type="date"
              value={customTo}
              min={customFrom || undefined}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
            />
          </div>
        )}
        {statement && statement.availableCurrencies.length > 1 && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-xs text-slate-500 dark:text-slate-400">Currency</span>
            <select
              value={currency || statement.currency}
              onChange={(e) => setCurrency(e.target.value)}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
            >
              {statement.availableCurrencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {error}
        </div>
      ) : loading && !statement ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : statement ? (
        <StatementBody statement={statement} customersUrl={customersUrl} dim={loading} />
      ) : null}
    </div>
  );
}

function StatementBody({
  statement,
  customersUrl,
  dim,
}: {
  statement: Statement;
  customersUrl: string;
  dim: boolean;
}) {
  const cur = statement.currency;
  const money = (cents: number) => formatMoney(cents, cur);
  const financeBase = customersUrl.replace(/\/customers$/, "/finance");
  const a = statement.aging;

  return (
    <div className={dim ? "opacity-60 transition-opacity" : "transition-opacity"}>
      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <SummaryCard label="Opening balance" value={money(statement.openingBalanceCents)} />
        <SummaryCard label="Invoiced" value={money(statement.totalChargesCents)} />
        <SummaryCard label="Paid" value={money(statement.totalPaymentsCents)} />
        <SummaryCard
          label="Balance due"
          value={money(statement.closingBalanceCents)}
          accent={statement.closingBalanceCents > 0}
        />
      </div>

      {/* Aging */}
      {statement.closingBalanceCents > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Outstanding by age
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <AgingBucket label="Current" value={money(a.currentCents)} />
            <AgingBucket label="1–30 days" value={money(a.d1to30Cents)} />
            <AgingBucket label="31–60 days" value={money(a.d31to60Cents)} />
            <AgingBucket label="61–90 days" value={money(a.d61to90Cents)} />
            <AgingBucket label="90+ days" value={money(a.d90PlusCents)} hot={a.d90PlusCents > 0} />
          </div>
        </section>
      )}

      {/* Activity */}
      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
          Activity
        </h2>
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Date</th>
                  <th className="px-4 py-2 text-left font-medium">Reference</th>
                  <th className="px-4 py-2 text-left font-medium">Details</th>
                  <th className="px-4 py-2 text-right font-medium">Charges</th>
                  <th className="px-4 py-2 text-right font-medium">Payments</th>
                  <th className="px-4 py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                <tr className="text-slate-500 dark:text-slate-400">
                  <td className="px-4 py-3 italic">{statement.fromDate ?? "Start"}</td>
                  <td className="px-4 py-3 italic" colSpan={2}>
                    Opening balance
                  </td>
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3" />
                  <td className="px-4 py-3 text-right tabular-nums">
                    {money(statement.openingBalanceCents)}
                  </td>
                </tr>
                {statement.transactions.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-sm text-slate-400 dark:text-slate-500"
                    >
                      No activity in this period.
                    </td>
                  </tr>
                ) : (
                  statement.transactions.map((t, i) => (
                    <tr key={i} className="text-slate-700 dark:text-slate-200">
                      <td className="px-4 py-3 tabular-nums">{t.date}</td>
                      <td className="px-4 py-3">
                        {t.invoiceSlug ? (
                          <Link
                            to={`${financeBase}/invoices/${t.invoiceSlug}`}
                            className="font-mono text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                          >
                            {t.reference}
                          </Link>
                        ) : (
                          <span className="text-xs">{t.reference || "—"}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-500 dark:text-slate-400">
                        {t.description}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {t.chargeCents > 0 ? money(t.chargeCents) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-emerald-700 dark:text-emerald-400">
                        {t.paymentCents > 0 ? money(t.paymentCents) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-medium tabular-nums">
                        {money(t.balanceCents)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 font-semibold text-slate-900 dark:border-slate-600 dark:text-slate-100">
                  <td className="px-4 py-3" colSpan={5}>
                    Balance due
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {money(statement.closingBalanceCents)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
        <p className="mt-3 flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500">
          <ExternalLink size={12} /> Invoice numbers link to the full document in Finance.
        </p>
      </section>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className={
          "mt-2 text-xl font-semibold tabular-nums " +
          (accent
            ? "text-amber-600 dark:text-amber-400"
            : "text-slate-900 dark:text-slate-100")
        }
      >
        {value}
      </div>
    </div>
  );
}

function AgingBucket({
  label,
  value,
  hot,
}: {
  label: string;
  value: string;
  hot?: boolean;
}) {
  return (
    <div
      className={
        "rounded-xl border p-3 text-center shadow-sm " +
        (hot
          ? "border-red-200 bg-red-50 dark:border-red-500/30 dark:bg-red-500/10"
          : "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900")
      }
    >
      <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
      <div
        className={
          "mt-1 text-sm font-semibold tabular-nums " +
          (hot ? "text-red-700 dark:text-red-300" : "text-slate-900 dark:text-slate-100")
        }
      >
        {value}
      </div>
    </div>
  );
}
