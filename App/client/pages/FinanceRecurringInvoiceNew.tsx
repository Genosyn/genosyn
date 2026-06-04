import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import {
  api,
  Customer,
  formatMoney,
  parseMoneyToCents,
  Product,
  RecurringInvoice,
  RecurringInvoiceLineDraft,
  TaxRate,
} from "../lib/api";
import {
  cronToParts,
  defaultScheduleParts,
  describeParts,
  Frequency,
  MONTH_LABELS,
  ordinal,
  partsToCron,
  ScheduleParts,
  timeInputValue,
  WEEKDAY_LABELS,
  withTime,
} from "../lib/schedule";
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
  productId: string | null;
  description: string;
  quantityText: string;
  priceText: string;
  taxRateId: string;
};

function emptyLine(): LineRow {
  return {
    key: Math.random().toString(36).slice(2, 10),
    productId: null,
    description: "",
    quantityText: "1",
    priceText: "0.00",
    taxRateId: "",
  };
}

function lineRowFromExisting(l: {
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId: string | null;
}): LineRow {
  return {
    key: Math.random().toString(36).slice(2, 10),
    productId: l.productId,
    description: l.description,
    quantityText: String(l.quantity),
    priceText: (l.unitPriceCents / 100).toFixed(2),
    taxRateId: l.taxRateId ?? "",
  };
}

// Shared styling for the inline schedule controls so they read as one
// natural sentence ("Every month on the 1st at 09:00") and match the
// app's other form fields.
const scheduleField =
  "h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900";

/**
 * Recurring-invoice form — handles both create and edit. The lifecycle
 * controls (pause / resume / end / run now) live on the detail page.
 */
export default function FinanceRecurringInvoiceNew() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { recurringSlug } = useParams();
  const isEdit = Boolean(recurringSlug);

  const [customers, setCustomers] = React.useState<Customer[] | null>(null);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [taxRates, setTaxRates] = React.useState<TaxRate[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);

  const [customerId, setCustomerId] = React.useState("");
  const [name, setName] = React.useState("");
  const [schedule, setSchedule] = React.useState<ScheduleParts>(defaultScheduleParts);
  const [daysUntilDue, setDaysUntilDue] = React.useState(14);
  const [autoSend, setAutoSend] = React.useState(false);
  const [currency, setCurrency] = React.useState("USD");
  const [notes, setNotes] = React.useState("");
  const [footer, setFooter] = React.useState("");
  const [maxRunsText, setMaxRunsText] = React.useState("");
  const [endsOn, setEndsOn] = React.useState("");
  const [lines, setLines] = React.useState<LineRow[]>([emptyLine()]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const [c, p, t] = await Promise.all([
          api.get<Customer[]>(`/api/companies/${company.id}/customers`),
          api.get<Product[]>(`/api/companies/${company.id}/products`),
          api.get<TaxRate[]>(`/api/companies/${company.id}/tax-rates`),
        ]);
        setCustomers(c);
        setProducts(p);
        setTaxRates(t);
        if (isEdit && recurringSlug) {
          const existing = await api.get<RecurringInvoice>(
            `/api/companies/${company.id}/recurring-invoices/${recurringSlug}`,
          );
          setCustomerId(existing.customerId);
          setName(existing.name);
          setSchedule({
            ...cronToParts(existing.cronExpr),
            intervalCount: existing.intervalCount ?? 1,
          });
          setDaysUntilDue(existing.daysUntilDue);
          setAutoSend(existing.autoSend);
          setCurrency(existing.currency);
          setNotes(existing.notes);
          setFooter(existing.footer);
          setMaxRunsText(existing.maxRuns != null ? String(existing.maxRuns) : "");
          setEndsOn(
            existing.endsOn
              ? new Date(existing.endsOn).toISOString().slice(0, 10)
              : "",
          );
          setLines(
            existing.lines.length === 0
              ? [emptyLine()]
              : existing.lines.map(lineRowFromExisting),
          );
        } else if (c.length > 0) {
          setCustomerId(c[0].id);
          setCurrency(c[0].currency || "USD");
          setName(`Monthly retainer — ${c[0].name}`);
        }
        setReady(true);
      } catch (err) {
        setLoadError((err as Error).message);
        setReady(true);
      }
    })();
  }, [company.id, recurringSlug, isEdit]);

  function changeCustomer(id: string) {
    setCustomerId(id);
    const c = customers?.find((x) => x.id === id);
    if (c?.currency) setCurrency(c.currency);
    if (!isEdit && c) setName(`Monthly retainer — ${c.name}`);
  }

  function patchLine(idx: number, patch: Partial<LineRow>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((ls) => [...ls, emptyLine()]);
  }
  function removeLine(idx: number) {
    setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, i) => i !== idx)));
  }
  function pickProduct(idx: number, productId: string) {
    if (!productId) {
      patchLine(idx, { productId: null });
      return;
    }
    const p = products.find((pp) => pp.id === productId);
    if (!p) return;
    patchLine(idx, {
      productId: p.id,
      description: p.name + (p.description ? ` — ${p.description}` : ""),
      priceText: (p.unitPriceCents / 100).toFixed(2),
      taxRateId: p.defaultTaxRateId ?? "",
    });
  }

  const scheduleSummary = React.useMemo(() => describeParts(schedule), [schedule]);

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
    !!customerId &&
    !!name.trim() &&
    lines.some((l) => l.description.trim().length > 0);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    try {
      const lineDrafts: RecurringInvoiceLineDraft[] = lines
        .filter((l) => l.description.trim())
        .map((l, i) => ({
          productId: l.productId,
          description: l.description.trim(),
          quantity: Number(l.quantityText) || 0,
          unitPriceCents: parseMoneyToCents(l.priceText),
          taxRateId: l.taxRateId || null,
          sortOrder: i,
        }));
      const maxRuns =
        maxRunsText.trim() === "" ? null : Math.max(1, parseInt(maxRunsText, 10) || 0);
      const body = {
        customerId,
        name: name.trim(),
        cronExpr: partsToCron(schedule),
        frequency: schedule.frequency,
        intervalCount: schedule.intervalCount,
        daysUntilDue,
        autoSend,
        currency,
        notes,
        footer,
        maxRuns,
        endsOn: endsOn ? new Date(endsOn).toISOString() : null,
        lines: lineDrafts,
      };
      const ri =
        isEdit && recurringSlug
          ? await api.patch<RecurringInvoice>(
              `/api/companies/${company.id}/recurring-invoices/${recurringSlug}`,
              body,
            )
          : await api.post<RecurringInvoice>(
              `/api/companies/${company.id}/recurring-invoices`,
              body,
            );
      navigate(`/c/${company.slug}/finance/recurring-invoices/${ri.slug}`);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!ready || customers === null) {
    return (
      <div className="flex justify-center p-16">
        <Spinner size={20} />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            {
              label: "Recurring invoices",
              to: `/c/${company.slug}/finance/recurring-invoices`,
            },
            { label: isEdit ? "Edit" : "New" },
          ]}
        />
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {loadError}
        </div>
        <div className="mt-4">
          <Link
            to={
              recurringSlug
                ? `/c/${company.slug}/finance/recurring-invoices/${recurringSlug}`
                : `/c/${company.slug}/finance/recurring-invoices`
            }
          >
            <Button variant="secondary">Back</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (!isEdit && customers.length === 0) {
    return (
      <div className="mx-auto max-w-3xl p-8">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            {
              label: "Recurring invoices",
              to: `/c/${company.slug}/finance/recurring-invoices`,
            },
            { label: "New" },
          ]}
        />
        <div className="mt-6 rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Add a customer first
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Recurring invoices need a customer to bill.
          </p>
          <div className="mt-4">
            <Link to={`/c/${company.slug}/customers`}>
              <Button>Add customer</Button>
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
            {
              label: "Recurring invoices",
              to: `/c/${company.slug}/finance/recurring-invoices`,
            },
            { label: isEdit ? "Edit" : "New" },
          ]}
        />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to={
              isEdit && recurringSlug
                ? `/c/${company.slug}/finance/recurring-invoices/${recurringSlug}`
                : `/c/${company.slug}/finance/recurring-invoices`
            }
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {isEdit ? "Edit schedule" : "New recurring invoice"}
          </h1>
        </div>
        <div className="flex gap-2">
          <Link
            to={
              isEdit && recurringSlug
                ? `/c/${company.slug}/finance/recurring-invoices/${recurringSlug}`
                : `/c/${company.slug}/finance/recurring-invoices`
            }
          >
            <Button type="button" variant="secondary" disabled={busy}>
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={busy || !canSave}>
            {isEdit ? "Save changes" : "Create schedule"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Monthly retainer — Acme"
            required
          />
          <Select
            label="Customer"
            value={customerId}
            onChange={(e) => changeCustomer(e.target.value)}
            required
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Schedule
            </label>
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <span>Every</span>
              <input
                type="number"
                min={1}
                max={99}
                value={schedule.intervalCount}
                onChange={(e) =>
                  setSchedule({
                    ...schedule,
                    intervalCount: Math.max(
                      1,
                      Math.min(99, parseInt(e.target.value, 10) || 1),
                    ),
                  })
                }
                className={`${scheduleField} w-16 text-center tabular-nums`}
                aria-label="Interval count"
              />
              <select
                value={schedule.frequency}
                onChange={(e) =>
                  setSchedule({ ...schedule, frequency: e.target.value as Frequency })
                }
                className={scheduleField}
                aria-label="Frequency"
              >
                {[
                  { value: "daily", unit: "day" },
                  { value: "weekly", unit: "week" },
                  { value: "monthly", unit: "month" },
                  { value: "quarterly", unit: "quarter" },
                  { value: "yearly", unit: "year" },
                ].map((u) => (
                  <option key={u.value} value={u.value}>
                    {schedule.intervalCount > 1 ? `${u.unit}s` : u.unit}
                  </option>
                ))}
              </select>

              {schedule.frequency === "weekly" && (
                <>
                  <span>on</span>
                  <select
                    value={schedule.weekday}
                    onChange={(e) =>
                      setSchedule({ ...schedule, weekday: Number(e.target.value) })
                    }
                    className={scheduleField}
                    aria-label="Day of week"
                  >
                    {WEEKDAY_LABELS.map((w, i) => (
                      <option key={w} value={i}>
                        {w}
                      </option>
                    ))}
                  </select>
                </>
              )}

              {schedule.frequency === "yearly" && (
                <>
                  <span>in</span>
                  <select
                    value={schedule.month}
                    onChange={(e) =>
                      setSchedule({ ...schedule, month: Number(e.target.value) })
                    }
                    className={scheduleField}
                    aria-label="Month"
                  >
                    {MONTH_LABELS.map((mn, i) => (
                      <option key={mn} value={i + 1}>
                        {mn}
                      </option>
                    ))}
                  </select>
                </>
              )}

              {schedule.frequency !== "weekly" &&
                schedule.frequency !== "daily" && (
                <>
                  <span>on the</span>
                  <select
                    value={schedule.dayOfMonth}
                    onChange={(e) =>
                      setSchedule({ ...schedule, dayOfMonth: Number(e.target.value) })
                    }
                    className={scheduleField}
                    aria-label="Day of month"
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {ordinal(d)}
                      </option>
                    ))}
                  </select>
                </>
              )}

              <span>at</span>
              <input
                type="time"
                value={timeInputValue(schedule)}
                onChange={(e) => setSchedule(withTime(schedule, e.target.value))}
                className={scheduleField}
                aria-label="Time of day"
              />
            </div>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              {scheduleSummary}
              {schedule.frequency !== "weekly" &&
                schedule.frequency !== "daily" &&
                schedule.dayOfMonth > 28 &&
                " · the 29th–31st are skipped in shorter months"}
            </p>
          </div>
          <Input
            label="Days until due"
            type="number"
            min={0}
            max={365}
            value={daysUntilDue}
            onChange={(e) => setDaysUntilDue(parseInt(e.target.value, 10) || 0)}
          />
          <Input
            label="Currency"
            value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            maxLength={3}
            required
          />
          <Input
            label="Max runs (optional)"
            type="number"
            min={1}
            value={maxRunsText}
            onChange={(e) => setMaxRunsText(e.target.value)}
            placeholder="Unlimited"
          />
          <Input
            label="Ends on (optional)"
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-slate-700 sm:col-span-2 dark:text-slate-200">
            <input
              type="checkbox"
              checked={autoSend}
              onChange={(e) => setAutoSend(e.target.checked)}
              className="rounded border-slate-300"
            />
            <span>
              <span className="font-medium">Auto-issue and email</span>
              <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
                — without this, each tick creates a draft you review and send
                manually.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Line items
            </h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Copied onto every generated invoice
            </span>
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Product</th>
                  <th className="w-20 px-3 py-2 text-right font-medium">Qty</th>
                  <th className="w-32 px-3 py-2 text-right font-medium">Unit price</th>
                  <th className="w-40 px-3 py-2 text-left font-medium">Tax</th>
                  <th className="w-32 px-3 py-2 text-right font-medium">Total</th>
                  <th className="w-10" />
                </tr>
              </thead>
              {lines.map((l, i) => {
                const qty = Number(l.quantityText) || 0;
                const unit = parseMoneyToCents(l.priceText);
                const gross = Math.round(qty * unit);
                const rate = taxRates.find((r) => r.id === l.taxRateId);
                let lineTotal = gross;
                if (rate && !rate.inclusive) {
                  lineTotal =
                    gross + Math.round((gross * rate.ratePercent) / 100);
                }
                return (
                  <tbody
                    key={l.key}
                    className={
                      i > 0
                        ? "border-t border-slate-100 dark:border-slate-800"
                        : ""
                    }
                  >
                    <tr>
                      <td className="px-2 pt-2 align-top">
                        <select
                          value={l.productId ?? ""}
                          onChange={(e) => pickProduct(i, e.target.value)}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">—</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 pt-2 align-top">
                        <input
                          value={l.quantityText}
                          onChange={(e) =>
                            patchLine(i, { quantityText: e.target.value })
                          }
                          inputMode="decimal"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="px-2 pt-2 align-top">
                        <input
                          value={l.priceText}
                          onChange={(e) =>
                            patchLine(i, { priceText: e.target.value })
                          }
                          inputMode="decimal"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="px-2 pt-2 align-top">
                        <select
                          value={l.taxRateId}
                          onChange={(e) =>
                            patchLine(i, { taxRateId: e.target.value })
                          }
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">No tax</option>
                          {taxRates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} ({t.ratePercent}%
                              {t.inclusive ? " incl" : ""})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-2 pt-2 text-right align-top tabular-nums text-slate-700 dark:text-slate-200">
                        {formatMoney(lineTotal, currency)}
                      </td>
                      <td className="px-2 pt-2 align-top">
                        <button
                          type="button"
                          onClick={() => removeLine(i)}
                          disabled={lines.length === 1}
                          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                          aria-label="Remove line"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                    <tr>
                      <td colSpan={6} className="px-2 pb-2">
                        <input
                          value={l.description}
                          onChange={(e) =>
                            patchLine(i, { description: e.target.value })
                          }
                          placeholder="Description"
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                    </tr>
                  </tbody>
                );
              })}
            </table>
            <div className="border-t border-slate-100 bg-slate-50/40 p-2 dark:border-slate-800 dark:bg-slate-900/30">
              <Button
                type="button"
                variant="secondary"
                onClick={addLine}
                size="sm"
              >
                <Plus size={14} /> Add line
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col items-end gap-1 text-sm tabular-nums">
          <div className="flex w-64 justify-between text-slate-500 dark:text-slate-400">
            <span>Subtotal</span>
            <span>{formatMoney(preview.subtotal, currency)}</span>
          </div>
          <div className="flex w-64 justify-between text-slate-500 dark:text-slate-400">
            <span>Tax</span>
            <span>{formatMoney(preview.tax, currency)}</span>
          </div>
          <div className="flex w-64 justify-between text-base font-semibold text-slate-900 dark:text-slate-100">
            <span>Total per invoice</span>
            <span>{formatMoney(preview.total, currency)}</span>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Textarea
              label="Notes"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Shown on each generated invoice above the totals."
            />
          </div>
          <div>
            <Textarea
              label="Footer"
              rows={3}
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Payment terms, bank details, thank-you note."
            />
          </div>
        </div>
      </div>
    </form>
  );
}
