import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import {
  Account,
  api,
  Bill,
  BillLineDraft,
  formatMoney,
  parseMoneyToCents,
  TaxRate,
  Vendor,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Select } from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { FinanceOutletCtx } from "./FinanceLayout";

type LineRow = {
  key: string;
  expenseAccountId: string;
  description: string;
  quantityText: string;
  priceText: string;
  taxRateId: string;
};

function emptyLine(defaultExpenseId: string): LineRow {
  return {
    key: Math.random().toString(36).slice(2, 10),
    expenseAccountId: defaultExpenseId,
    description: "",
    quantityText: "1",
    priceText: "0.00",
    taxRateId: "",
  };
}

/**
 * Bill creator. Phase G of the Finance milestone (M19). Mirrors the
 * invoice creator but each line picks an expense account instead of a
 * product — that's the natural accountant model for inbound bills.
 */
export default function FinanceBillNew() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [vendors, setVendors] = React.useState<Vendor[] | null>(null);
  const [accounts, setAccounts] = React.useState<Account[]>([]);
  const [taxRates, setTaxRates] = React.useState<TaxRate[]>([]);

  const [vendorId, setVendorId] = React.useState("");
  const [vendorRef, setVendorRef] = React.useState("");
  const [issueDate, setIssueDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = React.useState(
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  );
  const [currency, setCurrency] = React.useState("USD");
  const [notes, setNotes] = React.useState("");
  const [lines, setLines] = React.useState<LineRow[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    Promise.all([
      api.get<Vendor[]>(`/api/companies/${company.id}/vendors`),
      api.get<Account[]>(`/api/companies/${company.id}/accounts`),
      api.get<TaxRate[]>(`/api/companies/${company.id}/tax-rates`),
    ]).then(([v, a, t]) => {
      setVendors(v);
      setAccounts(a);
      setTaxRates(t);
      const defaultExpense = a.find((acc) => acc.code === "6000")?.id ?? "";
      setLines([emptyLine(defaultExpense)]);
      if (v.length > 0) {
        setVendorId(v[0].id);
        setCurrency(v[0].currency || "USD");
      }
    });
  }, [company.id]);

  function changeVendor(id: string) {
    setVendorId(id);
    const v = vendors?.find((x) => x.id === id);
    if (v?.currency) setCurrency(v.currency);
  }

  function patchLine(idx: number, patch: Partial<LineRow>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() {
    const defaultExpense = accounts.find((a) => a.code === "6000")?.id ?? "";
    setLines((ls) => [...ls, emptyLine(defaultExpense)]);
  }
  function removeLine(idx: number) {
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, i) => i !== idx)));
  }

  const expenseAccounts = React.useMemo(
    () => accounts.filter((a) => a.type === "expense" && !a.archivedAt),
    [accounts],
  );

  const preview = React.useMemo(() => {
    let subtotal = 0;
    let tax = 0;
    let total = 0;
    for (const l of lines) {
      const qty = Number(l.quantityText) || 0;
      const unit = parseMoneyToCents(l.priceText);
      const gross = Math.round(qty * unit);
      const rate = taxRates.find((r) => r.id === l.taxRateId);
      const pct = rate?.ratePercent ?? 0;
      const inclusive = rate?.inclusive ?? false;
      if (pct <= 0) {
        subtotal += gross;
        total += gross;
        continue;
      }
      if (inclusive) {
        const t = Math.round((gross * pct) / (100 + pct));
        subtotal += gross - t;
        tax += t;
        total += gross;
      } else {
        const t = Math.round((gross * pct) / 100);
        subtotal += gross;
        tax += t;
        total += gross + t;
      }
    }
    return { subtotal, tax, total };
  }, [lines, taxRates]);

  const canSave =
    !!vendorId && lines.some((l) => l.description.trim().length > 0);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const lineDrafts: BillLineDraft[] = lines
        .filter((l) => l.description.trim())
        .map((l, i) => ({
          expenseAccountId: l.expenseAccountId || null,
          description: l.description.trim(),
          quantity: Number(l.quantityText) || 0,
          unitPriceCents: parseMoneyToCents(l.priceText),
          taxRateId: l.taxRateId || null,
          sortOrder: i,
        }));
      const bill = await api.post<Bill>(`/api/companies/${company.id}/bills`, {
        vendorId,
        vendorRef: vendorRef.trim(),
        issueDate: new Date(issueDate).toISOString(),
        dueDate: new Date(dueDate).toISOString(),
        currency,
        notes,
        lines: lineDrafts,
      });
      navigate(`/c/${company.slug}/finance/bills/${bill.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (vendors === null) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }
  if (vendors.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Add a vendor first
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Bills need a vendor to bill from.
          </p>
          <div className="mt-4">
            <Link to={`/c/${company.slug}/finance/vendors`}>
              <Button>Add vendor</Button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Bills", to: `/c/${company.slug}/finance/bills` },
            { label: "New" },
          ]}
        />
      </div>
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to={`/c/${company.slug}/finance/bills`}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            New bill
          </h1>
        </div>
        <div className="flex gap-2">
          <Link to={`/c/${company.slug}/finance/bills`}>
            <Button type="button" variant="secondary" disabled={busy}>
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={busy || !canSave}>
            Save draft
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <Select
              label="Vendor"
              value={vendorId}
              onChange={(e) => changeVendor(e.target.value)}
              required
            >
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </div>
          <Input
            label="Vendor's ref"
            value={vendorRef}
            onChange={(e) => setVendorRef(e.target.value)}
            placeholder="vendor's invoice #"
          />
          <Input
            label="Currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            required
          />
          <Input
            label="Issue date"
            type="date"
            value={issueDate}
            onChange={(e) => setIssueDate(e.target.value)}
            required
          />
          <Input
            label="Due date"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            required
          />
        </div>

        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Line items
          </h2>
          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Expense account</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="w-20 px-3 py-2 text-right font-medium">Qty</th>
                  <th className="w-32 px-3 py-2 text-right font-medium">Unit price</th>
                  <th className="w-40 px-3 py-2 text-left font-medium">Tax</th>
                  <th className="w-32 px-3 py-2 text-right font-medium">Total</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {lines.map((l, i) => {
                  const qty = Number(l.quantityText) || 0;
                  const unit = parseMoneyToCents(l.priceText);
                  const gross = Math.round(qty * unit);
                  const rate = taxRates.find((r) => r.id === l.taxRateId);
                  let lineTotal = gross;
                  if (rate && !rate.inclusive) {
                    lineTotal = gross + Math.round((gross * rate.ratePercent) / 100);
                  }
                  return (
                    <tr key={l.key}>
                      <td className="px-2 py-2 align-top">
                        <select
                          value={l.expenseAccountId}
                          onChange={(e) => patchLine(i, { expenseAccountId: e.target.value })}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">— Pick —</option>
                          {expenseAccounts.map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.code} {a.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 py-2 align-top">
                        <input
                          value={l.description}
                          onChange={(e) => patchLine(i, { description: e.target.value })}
                          placeholder="Item description"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="px-2 py-2 align-top">
                        <input
                          value={l.quantityText}
                          onChange={(e) => patchLine(i, { quantityText: e.target.value })}
                          inputMode="decimal"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="px-2 py-2 align-top">
                        <input
                          value={l.priceText}
                          onChange={(e) => patchLine(i, { priceText: e.target.value })}
                          inputMode="decimal"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="px-2 py-2 align-top">
                        <select
                          value={l.taxRateId}
                          onChange={(e) => patchLine(i, { taxRateId: e.target.value })}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">No tax</option>
                          {taxRates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} ({t.ratePercent}%{t.inclusive ? " incl" : ""})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right align-middle text-sm tabular-nums text-slate-700 dark:text-slate-200">
                        {formatMoney(lineTotal, currency)}
                      </td>
                      <td className="px-2 py-2 text-center align-middle">
                        <button
                          type="button"
                          onClick={() => removeLine(i)}
                          disabled={lines.length === 1}
                          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                          aria-label="Remove"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2">
            <button
              type="button"
              onClick={addLine}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
            >
              <Plus size={12} /> Add line
            </button>
          </div>
        </div>

        <div className="mt-6">
          <Textarea
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </div>

        <div className="mt-6 ml-auto w-72 space-y-1 text-sm">
          <div className="flex justify-between text-slate-500 dark:text-slate-400">
            <span>Subtotal</span>
            <span className="tabular-nums">
              {formatMoney(preview.subtotal, currency)}
            </span>
          </div>
          <div className="flex justify-between text-slate-500 dark:text-slate-400">
            <span>Tax</span>
            <span className="tabular-nums">
              {formatMoney(preview.tax, currency)}
            </span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
            <span>Total</span>
            <span className="tabular-nums">
              {formatMoney(preview.total, currency)}
            </span>
          </div>
        </div>
      </div>
    </form>
  );
}
