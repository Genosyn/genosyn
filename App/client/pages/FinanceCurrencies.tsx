import React from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import {
  api,
  CompanyFinanceSettings,
  Currency,
  ExchangeRate,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Multi-currency management. Phase E of the Finance milestone (M19).
 *
 * Three sections:
 *   - Home currency picker (the company's reporting currency).
 *   - Currencies catalog (the list invoices can be denominated in).
 *   - Exchange rates (manual entry, walk-back lookup at FX time).
 */
export default function FinanceCurrencies() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();

  const [settings, setSettings] = React.useState<CompanyFinanceSettings | null>(null);
  const [currencies, setCurrencies] = React.useState<Currency[] | null>(null);
  const [rates, setRates] = React.useState<ExchangeRate[] | null>(null);
  const [showRateModal, setShowRateModal] = React.useState(false);
  const [showAddCurrency, setShowAddCurrency] = React.useState(false);

  const reload = React.useCallback(async () => {
    const [s, c, r] = await Promise.all([
      api.get<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`),
      api.get<Currency[]>(`/api/companies/${company.id}/currencies`),
      api.get<ExchangeRate[]>(`/api/companies/${company.id}/exchange-rates`),
    ]);
    setSettings(s);
    setCurrencies(c);
    setRates(r);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => {
      setSettings(null);
      setCurrencies([]);
      setRates([]);
    });
  }, [reload]);

  async function changeHomeCurrency(code: string) {
    try {
      const s = await api.patch<CompanyFinanceSettings>(
        `/api/companies/${company.id}/finance-settings`,
        { homeCurrency: code },
      );
      setSettings(s);
      toast(`Home currency set to ${code}`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteCurrency(c: Currency) {
    const ok = await dialog.confirm({
      title: `Delete ${c.code}?`,
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/currencies/${c.id}`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  async function deleteRate(r: ExchangeRate) {
    const ok = await dialog.confirm({
      title: `Delete this rate?`,
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/exchange-rates/${r.id}`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  const loading = !settings || !currencies || !rates;

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Currencies" },
          ]}
        />
      </div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Currencies & exchange rates
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        The home currency is what the ledger reports in. Foreign-currency
        invoices convert at issue using the most recent rate on or
        before the issue date; payments convert at the payment date,
        with the difference posting to FX gain or loss.
      </p>

      {loading ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : (
        <>
          <div className="mt-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Home currency
            </h2>
            <div className="mt-3 max-w-xs">
              <Select
                value={settings.homeCurrency}
                onChange={(e) => changeHomeCurrency(e.target.value)}
              >
                {currencies.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Already-posted ledger entries are not retroactively
              converted; changes apply to new postings.
            </p>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Currencies
              </h2>
              <Button onClick={() => setShowAddCurrency(true)} size="sm">
                <Plus size={14} /> Add currency
              </Button>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="w-20 px-4 py-2 text-left font-medium">Code</th>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="w-24 px-4 py-2 text-left font-medium">Symbol</th>
                  <th className="w-28 px-4 py-2 text-left font-medium">Decimals</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {currencies.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {c.code}
                    </td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">
                      {c.name}
                    </td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">
                      {c.symbol || "—"}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">
                      {c.decimalPlaces}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {c.code !== settings.homeCurrency && (
                        <button
                          onClick={() => deleteCurrency(c)}
                          className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                          aria-label="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Exchange rates
              </h2>
              <Button onClick={() => setShowRateModal(true)} size="sm">
                <Plus size={14} /> Set rate
              </Button>
            </div>
            {rates.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-slate-400">
                No exchange rates yet. Add one before issuing
                foreign-currency invoices.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="w-28 px-4 py-2 text-left font-medium">Date</th>
                    <th className="w-32 px-4 py-2 text-left font-medium">From → To</th>
                    <th className="w-32 px-4 py-2 text-right font-medium">Rate</th>
                    <th className="px-4 py-2 text-left font-medium">Source</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {rates.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {r.date.slice(0, 10)}
                      </td>
                      <td className="px-4 py-2 font-mono text-slate-700 dark:text-slate-200">
                        {r.fromCurrency} → {r.toCurrency}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                        {r.rate}
                      </td>
                      <td className="px-4 py-2 text-slate-500 dark:text-slate-400">
                        {r.source}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          onClick={() => deleteRate(r)}
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
            )}
          </div>
        </>
      )}

      {showRateModal && currencies && (
        <RateModal
          companyId={company.id}
          currencies={currencies}
          homeCurrency={settings?.homeCurrency ?? "USD"}
          onClose={() => setShowRateModal(false)}
          onSaved={() => {
            setShowRateModal(false);
            reload();
          }}
        />
      )}
      {showAddCurrency && (
        <AddCurrencyModal
          companyId={company.id}
          onClose={() => setShowAddCurrency(false)}
          onSaved={() => {
            setShowAddCurrency(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function RateModal({
  companyId,
  currencies,
  homeCurrency,
  onClose,
  onSaved,
}: {
  companyId: string;
  currencies: Currency[];
  homeCurrency: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [from, setFrom] = React.useState(
    currencies.find((c) => c.code !== homeCurrency)?.code ?? "EUR",
  );
  const [to, setTo] = React.useState(homeCurrency);
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [rate, setRate] = React.useState("1.0");
  const [source, setSource] = React.useState("manual");
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/exchange-rates`, {
        fromCurrency: from,
        toCurrency: to,
        date: new Date(date).toISOString(),
        rate: Number(rate),
        source,
      });
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Set exchange rate">
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Select label="From" value={from} onChange={(e) => setFrom(e.target.value)}>
            {currencies.map((c) => (
              <option key={c.id} value={c.code}>
                {c.code}
              </option>
            ))}
          </Select>
          <Select label="To" value={to} onChange={(e) => setTo(e.target.value)}>
            {currencies.map((c) => (
              <option key={c.id} value={c.code}>
                {c.code}
              </option>
            ))}
          </Select>
        </div>
        <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        <Input
          label={`Rate (1 ${from} = ? ${to})`}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          inputMode="decimal"
          required
        />
        <Input
          label="Source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="manual / ECB / bank"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || from === to || !rate}>
            Save rate
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AddCurrencyModal({
  companyId,
  onClose,
  onSaved,
}: {
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [symbol, setSymbol] = React.useState("");
  const [decimalPlaces, setDecimalPlaces] = React.useState("2");
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/api/companies/${companyId}/currencies`, {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        symbol: symbol.trim(),
        decimalPlaces: Number(decimalPlaces),
      });
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Add currency">
      <form onSubmit={save} className="space-y-4">
        <Input
          label="ISO code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={3}
          placeholder="e.g. SEK"
          required
        />
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Symbol"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            placeholder="kr"
          />
          <Input
            label="Decimals"
            value={decimalPlaces}
            onChange={(e) => setDecimalPlaces(e.target.value)}
            inputMode="numeric"
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !code || !name}>
            Add currency
          </Button>
        </div>
      </form>
    </Modal>
  );
}
