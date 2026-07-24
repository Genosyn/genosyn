import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import { api, VendorCredit, formatMoney } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Spinner } from "../components/ui/Spinner";
import { FinanceOutletCtx } from "./FinanceLayout";

const STATUS_BADGE: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700 dark:bg-slate-700/40 dark:text-slate-200",
  issued: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  void: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
};

/**
 * Vendor credits list. Phase H of the Finance milestone (M19) — the AP mirror
 * of the credit-notes register. Vendor credits are raised from a bill's detail
 * page.
 */
export default function FinanceVendorCredits() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const [credits, setCredits] = React.useState<VendorCredit[] | null>(null);

  const reload = React.useCallback(async () => {
    setCredits(await api.get<VendorCredit[]>(`/api/companies/${company.id}/vendor-credits`));
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setCredits([]));
  }, [reload]);
  useLiveRefetch("bill", reload);

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Vendor credits" },
          ]}
        />
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Vendor credits
      </h1>
      {credits === null ? (
        <div className="flex justify-center p-12">
          <Spinner />
        </div>
      ) : credits.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          No vendor credits yet. Raise one from a bill&apos;s detail page with the{" "}
          <span className="font-medium">Vendor credit</span> action.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2">Number</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-right">Open</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {credits.map((c) => (
                <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2 font-medium">
                    <Link
                      to={`/c/${company.slug}/finance/vendor-credits/${c.slug}`}
                      className="text-sky-600 hover:underline dark:text-sky-400"
                    >
                      {c.number || "(draft)"}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(c.totalCents, c.currency)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatMoney(c.openCents, c.currency)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        "inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                        (STATUS_BADGE[c.status] ?? STATUS_BADGE.draft)
                      }
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-slate-500 dark:text-slate-400">
                    {new Date(c.issueDate).toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
