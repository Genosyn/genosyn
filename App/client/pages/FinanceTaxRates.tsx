import React from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import { api, TaxRate } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Tax rates registry. Phase A of the Finance milestone (M19).
 *
 * Phase E will replace this with a composable jurisdictional tax engine
 * — for now, every company defines its own flat list of named rates and
 * each invoice line snapshots whichever one was applied.
 */
export default function FinanceTaxRates() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const [rates, setRates] = React.useState<TaxRate[] | null>(null);
  const [editing, setEditing] = React.useState<TaxRate | "new" | null>(null);

  const reload = React.useCallback(async () => {
    const list = await api.get<TaxRate[]>(`/api/companies/${company.id}/tax-rates`);
    setRates(list);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setRates([]));
  }, [reload]);

  async function remove(t: TaxRate) {
    const ok = await dialog.confirm({
      title: `Delete ${t.name}?`,
      message: "Historical invoices keep their snapshotted tax info.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/tax-rates/${t.id}`);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Tax rates" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Tax rates
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Define the rates you charge. Each invoice line snapshots its
            chosen rate, so editing here never changes a historical invoice.
          </p>
        </div>
        <Button onClick={() => setEditing("new")}>
          <Plus size={14} /> New rate
        </Button>
      </div>

      {rates === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : rates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No tax rates defined
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Skip if you don&apos;t charge tax — invoices work fine without one.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-right font-medium">Rate</th>
                <th className="px-4 py-2 text-left font-medium">Inclusive</th>
                <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rates.map((t) => (
                <tr key={t.id}>
                  <td className="px-4 py-3 font-medium text-slate-900 dark:text-slate-100">
                    <button
                      onClick={() => setEditing(t)}
                      className="text-left hover:underline"
                    >
                      {t.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                    {t.ratePercent}%
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {t.inclusive ? "Yes" : "No"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => remove(t)}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      aria-label="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <TaxRateEditor
          companyId={company.id}
          rate={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function TaxRateEditor({
  companyId,
  rate,
  onClose,
  onSaved,
}: {
  companyId: string;
  rate: TaxRate | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = React.useState(rate?.name ?? "");
  const [ratePercent, setRatePercent] = React.useState(
    rate ? String(rate.ratePercent) : "",
  );
  const [inclusive, setInclusive] = React.useState(rate?.inclusive ?? false);
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        ratePercent: Number(ratePercent),
        inclusive,
      };
      if (rate) {
        await api.patch(`/api/companies/${companyId}/tax-rates/${rate.id}`, body);
      } else {
        await api.post(`/api/companies/${companyId}/tax-rates`, body);
      }
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={rate ? `Edit ${rate.name}` : "New tax rate"}>
      <form onSubmit={save} className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. VAT 20%"
          required
        />
        <Input
          label="Rate (%)"
          value={ratePercent}
          onChange={(e) => setRatePercent(e.target.value)}
          inputMode="decimal"
          required
          placeholder="20"
        />
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={inclusive}
            onChange={(e) => setInclusive(e.target.checked)}
            className="mt-0.5 rounded border-slate-300"
          />
          <span>
            <span className="font-medium text-slate-900 dark:text-slate-100">
              Inclusive
            </span>
            <span className="block text-xs text-slate-500 dark:text-slate-400">
              The unit price already contains the tax (EU/AU/NZ VAT/GST style).
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {rate ? "Save" : "Create rate"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
