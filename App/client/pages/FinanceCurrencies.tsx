import React from "react";
import { useOutletContext } from "react-router-dom";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  api,
  CompanyFinanceSettings,
  Currency,
  ExchangeRate,
  ExchangeRateOverview,
  formatExchangeRate,
} from "../lib/api";
import { canWriteFinance } from "../lib/subpages";
import { Breadcrumbs } from "../components/AppShell";
import { useLiveRefetch } from "../components/CompanySocket";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Select } from "../components/ui/Select";
import { FormError, FormSuccess } from "../components/ui/FormError";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { clsx } from "../components/ui/clsx";
import { errorMessage } from "../lib/errors";
import { FinanceReadOnlyNote } from "@/components/finance/FinanceReadOnly";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Multi-currency management. Phase E of the Finance milestone (M19).
 *
 * Three sections:
 *   - Home currency picker (the company's reporting currency).
 *   - Currencies catalog (the list invoices can be denominated in).
 *   - Exchange rates: automatic rates from the ECB (on by default, with Update
 *     now), the rate each currency converts at today, and the rates a person
 *     set, which win for their day.
 *
 * A read-only Member sees all three. The home currency stays a disabled
 * picker, since it is the one value the page has to show; adding and
 * deleting currencies and rates, the automatic switch and Update now are
 * simply not offered.
 */
export default function FinanceCurrencies() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const canWrite = canWriteFinance(company);
  const dialog = useDialog();
  const background = useBackgroundAction();

  const [settings, setSettings] = React.useState<CompanyFinanceSettings | null>(null);
  const [currencies, setCurrencies] = React.useState<Currency[] | null>(null);
  /** Only the rates a person set; fetched ones show as today's rates instead. */
  const [rates, setRates] = React.useState<ExchangeRate[] | null>(null);
  const [overview, setOverview] = React.useState<ExchangeRateOverview | null>(null);
  const [showRateModal, setShowRateModal] = React.useState(false);
  const [showAddCurrency, setShowAddCurrency] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  const [refreshNote, setRefreshNote] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const [s, c, r, o] = await Promise.all([
      api.get<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`),
      api.get<Currency[]>(`/api/companies/${company.id}/currencies`),
      api.get<ExchangeRate[]>(`/api/companies/${company.id}/exchange-rates?automatic=false`),
      api.get<ExchangeRateOverview>(`/api/companies/${company.id}/exchange-rates/overview`),
    ]);
    setSettings(s);
    setCurrencies(c);
    setRates(r);
    setOverview(o);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => {
      setSettings(null);
      setCurrencies([]);
      setRates([]);
    });
  }, [reload]);

  useLiveRefetch(["currency", "financesettings"], reload);

  function setAutomatic(on: boolean) {
    if (!settings || settings.automaticExchangeRates === on) return;
    const previous = settings;
    setSettings({ ...settings, automaticExchangeRates: on });
    setRefreshError(null);
    setRefreshNote(null);
    background(
      () =>
        api.patch<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`, {
          automaticExchangeRates: on,
        }),
      {
        title: on ? "Couldn’t turn on automatic rates" : "Couldn’t turn off automatic rates",
        error: (error) => `${errorMessage(error)} The previous setting has been restored.`,
        onSuccess: (saved) => {
          setSettings(saved);
          void reload();
        },
        onError: () => setSettings(previous),
      },
    );
  }

  async function updateNow() {
    setRefreshing(true);
    setRefreshError(null);
    setRefreshNote(null);
    try {
      const result = await api.post<{ added: number; latestDate: string }>(
        `/api/companies/${company.id}/exchange-rates/refresh`,
        {},
      );
      await reload();
      // New rates show in the table; with none, nothing on screen moves.
      if (result.added === 0) {
        setRefreshNote(`Already up to date with the ECB rates of ${dayLabel(result.latestDate)}.`);
      }
    } catch (err) {
      setRefreshError(errorMessage(err));
    } finally {
      setRefreshing(false);
    }
  }

  function changeHomeCurrency(code: string) {
    if (!settings || settings.homeCurrency === code) return;
    const previous = settings;
    setSettings({ ...settings, homeCurrency: code });
    background(
      () =>
        api.patch<CompanyFinanceSettings>(`/api/companies/${company.id}/finance-settings`, {
          homeCurrency: code,
        }),
      {
        title: "Couldn’t change the home currency",
        error: (error) => `${errorMessage(error)} The previous currency has been restored.`,
        onSuccess: setSettings,
        onError: () => setSettings(previous),
      },
    );
  }

  async function deleteCurrency(c: Currency) {
    const ok = await dialog.confirm({
      title: `Delete ${c.code}?`,
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const originalIndex = currencies?.findIndex((item) => item.id === c.id) ?? -1;
    setCurrencies((current) => current?.filter((item) => item.id !== c.id) ?? current);
    background(() => api.del(`/api/companies/${company.id}/currencies/${c.id}`), {
      title: "Couldn’t delete the currency",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onError: () => {
        setCurrencies((current) => {
          if (!current || current.some((item) => item.id === c.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, c);
          return next;
        });
      },
    });
  }

  async function deleteRate(r: ExchangeRate) {
    const ok = await dialog.confirm({
      title: `Delete this rate?`,
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    const originalIndex = rates?.findIndex((item) => item.id === r.id) ?? -1;
    setRates((current) => current?.filter((item) => item.id !== r.id) ?? current);
    background(() => api.del(`/api/companies/${company.id}/exchange-rates/${r.id}`), {
      title: "Couldn’t delete the exchange rate",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onError: () => {
        setRates((current) => {
          if (!current || current.some((item) => item.id === r.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, r);
          return next;
        });
      },
    });
  }

  const loading = !settings || !currencies || !rates || !overview;

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Currencies" }]}
        />
      </div>
      <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
        Currencies & exchange rates
      </h1>
      <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        The home currency is what the ledger reports in. A foreign-currency invoice or bill converts
        at the most recent rate on or before its issue date and keeps that rate; each payment locks
        the rate of the day it was paid, with the difference posting to FX gain or loss.
      </p>
      {!canWrite && <FinanceReadOnlyNote className="mt-4" />}

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
                disabled={!canWrite}
              >
                {currencies.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
              Already-posted ledger entries are not retroactively converted; changes apply to new
              postings.
            </p>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Currencies
              </h2>
              {canWrite && (
                <Button onClick={() => setShowAddCurrency(true)} size="sm">
                  <Plus size={14} /> Add currency
                </Button>
              )}
            </div>
            <table className="w-full text-sm">
              <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                <tr>
                  <th className="w-20 px-4 py-2 text-left font-medium">Code</th>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="w-24 px-4 py-2 text-left font-medium">Symbol</th>
                  <th className="w-28 px-4 py-2 text-left font-medium">Decimals</th>
                  {canWrite && <th className="w-10" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {currencies.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {c.code}
                    </td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">{c.name}</td>
                    <td className="px-4 py-2 text-slate-700 dark:text-slate-200">
                      {c.symbol || "—"}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-slate-500 dark:text-slate-400">
                      {c.decimalPlaces}
                    </td>
                    {canWrite && (
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
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
                Exchange rates
              </h2>
              {canWrite && (
                <div className="flex gap-2">
                  {settings.automaticExchangeRates && overview.automatic.available && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={refreshing}
                      onClick={() => void updateNow()}
                    >
                      <RefreshCw size={14} /> Update now
                    </Button>
                  )}
                  <Button onClick={() => setShowRateModal(true)} size="sm">
                    <Plus size={14} /> Set rate
                  </Button>
                </div>
              )}
            </div>

            <AutomaticRates
              enabled={settings.automaticExchangeRates}
              overview={overview}
              canWrite={canWrite}
              onChange={setAutomatic}
            />
            {(refreshError || refreshNote) && (
              <div className="border-b border-slate-100 px-4 py-3 dark:border-slate-800">
                <FormError message={refreshError} />
                <FormSuccess message={refreshNote} />
              </div>
            )}

            <TodaysRates overview={overview} />

            <div className="border-t border-slate-100 dark:border-slate-800">
              <h3 className="text-xs font-medium px-4 pb-2 pt-4 text-slate-500 dark:text-slate-400">
                Rates you set
              </h3>
              {rates.length === 0 ? (
                <p className="px-4 pb-5 text-sm text-slate-500 dark:text-slate-400">
                  {settings.automaticExchangeRates
                    ? "None yet. Set a rate to use your bank's rate for a day instead of the ECB's."
                    : "None yet. Set a rate before issuing foreign-currency invoices or bills."}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
                      <tr>
                        <th className="w-28 px-4 py-2 text-left font-medium">Date</th>
                        <th className="w-32 px-4 py-2 text-left font-medium">From → To</th>
                        <th className="w-32 px-4 py-2 text-right font-medium">Rate</th>
                        <th className="px-4 py-2 text-left font-medium">Source</th>
                        {canWrite && <th className="w-10" />}
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
                          {canWrite && (
                            <td className="px-4 py-2 text-right">
                              <button
                                onClick={() => deleteRate(r)}
                                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                                aria-label="Delete"
                              >
                                <Trash2 size={14} />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
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

/** A reference day as "22 Oct", with the year when it isn't this one. Dates are UTC days. */
function dayLabel(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** The ECB switch, and how current the fetched rates are. */
function AutomaticRates({
  enabled,
  overview,
  canWrite,
  onChange,
}: {
  enabled: boolean;
  overview: ExchangeRateOverview;
  canWrite: boolean;
  onChange: (on: boolean) => void;
}) {
  const { homeCurrency, automatic } = overview;
  let detail: React.ReactNode;
  if (!automatic.available) {
    detail = `The ECB doesn't publish ${homeCurrency}, so set the rates into it yourself.`;
  } else if (!enabled) {
    detail = "Off. Conversions use only the rates you set.";
  } else {
    detail = (
      <>
        Official daily reference rates, converted into {homeCurrency} and checked every few hours.{" "}
        {automatic.latestDate
          ? `Up to date with the rates of ${dayLabel(automatic.latestDate)}.`
          : "The first rates are on their way."}{" "}
        A rate you set wins for its day.
      </>
    );
  }
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-4 py-4 dark:border-slate-800">
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
          Automatic rates from the European Central Bank
        </div>
        <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{detail}</p>
      </div>
      {canWrite ? (
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Automatic rates from the European Central Bank"
          disabled={!enabled && !automatic.available}
          onClick={() => onChange(!enabled)}
          className={clsx(
            "mt-0.5 h-5 w-9 shrink-0 rounded-full p-0.5 transition-colors disabled:opacity-60",
            enabled ? "bg-indigo-600 dark:bg-indigo-500" : "bg-slate-200 dark:bg-slate-700",
          )}
        >
          <span
            className={clsx(
              "block h-4 w-4 rounded-full bg-white transition-transform",
              enabled && "translate-x-4",
            )}
          />
        </button>
      ) : (
        <span className="mt-0.5 shrink-0 text-xs font-medium text-slate-500 dark:text-slate-400">
          {enabled ? "On" : "Off"}
        </span>
      )}
    </div>
  );
}

/** The rate each currency in use converts at today, and where it came from. */
function TodaysRates({ overview }: { overview: ExchangeRateOverview }) {
  if (overview.rates.length === 0) return null;
  return (
    <div>
      <h3 className="text-xs font-medium px-4 pb-2 pt-4 text-slate-500 dark:text-slate-400">
        Today&apos;s rates
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-200 bg-slate-50/80 text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-400">
            <tr>
              <th className="w-28 px-4 py-2 text-left font-medium">Currency</th>
              <th className="w-40 px-4 py-2 text-right font-medium">
                1 unit in {overview.homeCurrency}
              </th>
              <th className="w-32 px-4 py-2 text-left font-medium">As of</th>
              <th className="px-4 py-2 text-left font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {overview.rates.map((row) => (
              <tr key={row.currency}>
                <td className="px-4 py-2 font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {row.currency}
                </td>
                <td className="px-4 py-2 text-right tabular-nums text-slate-900 dark:text-slate-100">
                  {row.rate === null ? "—" : formatExchangeRate(row.rate)}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500 dark:text-slate-400">
                  {row.date ? dayLabel(row.date) : "—"}
                </td>
                <td className="px-4 py-2">
                  {row.rate === null ? (
                    <span className="text-xs text-slate-400 dark:text-slate-500">
                      No rate on file
                    </span>
                  ) : row.automatic ? (
                    <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      ECB
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-flex rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300">
                        Set by you
                      </span>
                      {row.source && row.source !== "manual" && (
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {row.source}
                        </span>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  const [from, setFrom] = React.useState(
    currencies.find((c) => c.code !== homeCurrency)?.code ?? "EUR",
  );
  const [to, setTo] = React.useState(homeCurrency);
  const [date, setDate] = React.useState(new Date().toISOString().slice(0, 10));
  const [rate, setRate] = React.useState("1.0");
  const [source, setSource] = React.useState("manual");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
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
      setError(errorMessage(err));
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
        <Input
          label="Date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
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
          placeholder="manual, or your bank's name"
        />
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={from === to || !rate}>
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
  const [code, setCode] = React.useState("");
  const [name, setName] = React.useState("");
  const [symbol, setSymbol] = React.useState("");
  const [decimalPlaces, setDecimalPlaces] = React.useState("2");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/companies/${companyId}/currencies`, {
        code: code.trim().toUpperCase(),
        name: name.trim(),
        symbol: symbol.trim(),
        decimalPlaces: Number(decimalPlaces),
      });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
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
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
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
        <FormError message={error} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!code || !name}>
            Add currency
          </Button>
        </div>
      </form>
    </Modal>
  );
}
