import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  ACCOUNT_TYPE_LABEL,
  AccountType,
  api,
  formatBalanceMagnitude,
  formatMoney,
  TrialBalanceResponse,
  TrialBalanceRow,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";

const TYPE_ORDER: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

/**
 * Trial balance view. Phase B of the Finance milestone (M19).
 *
 * For every active account, sum debits / credits up through `asOf`.
 * Asset and expense accounts are debit-normal (balance in the debit
 * column when positive); the rest are credit-normal. The footer
 * confirms `sum(debits) === sum(credits)` so accountants get an
 * instant sanity check on the entire ledger.
 *
 * Phase C builds the Income Statement and Balance Sheet on top of
 * exactly this aggregation.
 */
export default function FinanceTrialBalance() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const [asOf, setAsOf] = React.useState(
    new Date().toISOString().slice(0, 10),
  );
  const [data, setData] = React.useState<TrialBalanceResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    api
      .get<TrialBalanceResponse>(
        `/api/companies/${company.id}/ledger/trial-balance?asOf=${encodeURIComponent(
          new Date(asOf).toISOString(),
        )}`,
      )
      .then((r) => {
        if (!alive) return;
        setData(r);
        setLoadError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setLoadError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [company.id, asOf]);

  // Group rows by type, keep them ordered the way accountants expect.
  const grouped = React.useMemo(() => {
    if (!data) return null;
    const m = new Map<AccountType, TrialBalanceRow[]>();
    for (const t of TYPE_ORDER) m.set(t, []);
    for (const r of data.rows) m.get(r.account.type)?.push(r);
    return m;
  }, [data]);

  const totals = React.useMemo(() => {
    if (!data) return { d: 0, c: 0 };
    let d = 0;
    let c = 0;
    for (const r of data.rows) {
      d += r.debitCents;
      c += r.creditCents;
    }
    return { d, c };
  }, [data]);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Trial balance" },
          ]}
        />
      </div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Trial balance
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Snapshot of every account&apos;s debit and credit totals.
            Debits should equal credits.
          </p>
        </div>
        <div className="w-44">
          <Input
            label="As of"
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
          />
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300">
          {loadError}
        </div>
      ) : grouped === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="w-20 px-4 py-2 text-left font-medium">Code</th>
                <th className="px-4 py-2 text-left font-medium">Account</th>
                <th className="w-32 px-4 py-2 text-right font-medium">Debit</th>
                <th className="w-32 px-4 py-2 text-right font-medium">Credit</th>
                <th className="w-32 px-4 py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {TYPE_ORDER.map((type) => {
                const rows = grouped.get(type) ?? [];
                if (rows.length === 0) return null;
                return (
                  <React.Fragment key={type}>
                    <tr className="bg-slate-50 dark:bg-slate-800/40">
                      <td
                        colSpan={5}
                        className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400"
                      >
                        {ACCOUNT_TYPE_LABEL[type]}
                      </td>
                    </tr>
                    {rows.map((r) => (
                      <tr
                        key={r.account.id}
                        className="border-t border-slate-100 dark:border-slate-800"
                      >
                        <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                          {r.account.code}
                        </td>
                        <td className="px-4 py-2 text-slate-900 dark:text-slate-100">
                          {r.account.name}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                          {r.debitCents > 0 ? formatMoney(r.debitCents, "USD") : ""}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-slate-700 dark:text-slate-200">
                          {r.creditCents > 0 ? formatMoney(r.creditCents, "USD") : ""}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums font-medium text-slate-900 dark:text-slate-100">
                          {r.balanceCents !== 0
                            ? formatBalanceMagnitude(r.balanceCents, "USD")
                            : ""}
                        </td>
                      </tr>
                    ))}
                  </React.Fragment>
                );
              })}
              <tr className="border-t-2 border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-800/60">
                <td className="px-4 py-2.5" />
                <td className="px-4 py-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Totals
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                  {formatMoney(totals.d, "USD")}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums font-semibold text-slate-900 dark:text-slate-100">
                  {formatMoney(totals.c, "USD")}
                </td>
                <td
                  className={
                    "px-4 py-2.5 text-right tabular-nums font-semibold " +
                    (totals.d === totals.c
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-amber-600 dark:text-amber-400")
                  }
                >
                  {totals.d === totals.c ? "Balanced" : "Unbalanced"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
