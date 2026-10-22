import { formatMoney } from "@/lib/api";
import { anyLineTaxed, lineAmountCents, lineTaxLabel } from "../../../shared/lineTax";

/** What the table reads from an invoice, estimate or bill line. */
type DocumentLine = {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxName: string;
  taxPercent: number;
  taxInclusive: boolean;
  lineTaxCents: number;
  lineTotalCents: number;
};

/**
 * The line items on an invoice, estimate or bill detail page, laid out like
 * the printed document: a taxed line shows its tax beside its amount, which
 * stays quantity × unit price. With no tax on any line there is no Tax column.
 */
export function DocumentLinesTable({ lines, currency }: { lines: DocumentLine[]; currency: string }) {
  const taxed = anyLineTaxed(lines);
  return (
    <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200 dark:border-slate-700">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Description</th>
            <th className="w-20 px-3 py-2 text-right font-medium">Qty</th>
            <th className="w-32 px-3 py-2 text-right font-medium">Unit</th>
            {taxed && <th className="w-32 px-3 py-2 text-right font-medium">Tax</th>}
            <th className="w-32 px-3 py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
          {lines.length === 0 ? (
            <tr>
              <td colSpan={4} className="p-6 text-center text-sm text-slate-400">
                No line items
              </td>
            </tr>
          ) : (
            lines.map((l) => (
              <tr key={l.id}>
                <td className="px-3 py-2 text-slate-700 dark:text-slate-200">{l.description}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {l.quantity}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {formatMoney(l.unitPriceCents, currency)}
                </td>
                {taxed && (
                  <td className="px-3 py-2 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {l.taxPercent > 0 ? (
                      <>
                        {formatMoney(l.lineTaxCents, currency)}
                        <div className="text-xs text-slate-400">{lineTaxLabel(l)}</div>
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                )}
                <td className="px-3 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {formatMoney(lineAmountCents(l), currency)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
