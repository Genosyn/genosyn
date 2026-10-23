import React from "react";
import {
  Link,
  useLocation,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import {
  api,
  financeSubsidiaries,
  Subsidiary,
  Customer,
  Estimate,
  formatMoney,
  Invoice,
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
import { customerOptionLabel } from "../lib/customerLabel";
import { withSavedCustomer } from "../lib/customerBillTo";
import {
  type DiscountDraft,
  discountDraftFrom,
  discountDraftProblem,
  discountFromDraft,
  NO_DISCOUNT_DRAFT,
  previewTotals,
} from "../lib/discountForm";
import { errorMessage } from "../lib/errors";
import {
  DEFAULT_PAYMENT_TERMS_DAYS,
  draftCustomerRequest,
  draftFromRecurringInvoice,
  invoiceDraftState,
  readInvoiceDraft,
  recurringInvoiceFromDraft,
  switchInvoiceKindPath,
  type InvoiceDraftLine,
} from "../lib/invoiceKind";
import {
  changeRecurringInvoiceNameCustomer,
  existingRecurringInvoiceName,
  initialRecurringInvoiceCustomer,
  initialRecurringInvoiceName,
  recurringInvoiceNameToSave,
  recurringInvoicePrefill,
  requestedRecurringInvoiceCustomerId,
  requestedRecurringInvoiceSource,
  typedRecurringInvoiceName,
  type RecurringInvoiceNameState,
  type RecurringInvoiceSourceDocument,
  type RecurringInvoiceSourceKind,
  type RecurringInvoiceSourceRef,
} from "../lib/recurringInvoiceForm";
import { canWriteFinance } from "../lib/subpages";
import {
  defaultRecurringInvoiceName,
  RECURRING_INVOICE_NAME_MAX_LENGTH,
} from "../../shared/recurringInvoiceName";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Select } from "../components/ui/Select";
import { FormError } from "../components/ui/FormError";
import { DiscountField } from "@/components/finance/DiscountField";
import { InvoiceIssuerSelect } from "@/components/finance/InvoiceIssuer";
import { CustomerBillTo } from "@/components/finance/CustomerBillTo";
import { FinanceReadOnlyPage } from "@/components/finance/FinanceReadOnly";
import { InvoiceKindSwitch } from "@/components/finance/InvoiceKind";
import { FinanceOutletCtx } from "./FinanceLayout";

type LineRow = {
  key: string;
  productId: string | null;
  description: string;
  quantityText: string;
  priceText: string;
  taxRateId: string;
};

function lineKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

function emptyLine(): LineRow {
  return {
    key: lineKey(),
    productId: null,
    description: "",
    quantityText: "1",
    priceText: "0.00",
    taxRateId: "",
  };
}

/** A line the one-time form handed over when someone switched. */
function lineRowFromDraft(line: InvoiceDraftLine): LineRow {
  return { key: lineKey(), ...line };
}

function lineRowFromExisting(l: {
  productId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRateId: string | null;
}): LineRow {
  return {
    key: lineKey(),
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
  "h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:focus:ring-indigo-500/25";

/** The invoice or estimate a new schedule was copied from, as the form describes it. */
type SourceSummary = {
  kind: RecurringInvoiceSourceKind;
  /** Empty for a draft, which has no number yet. */
  number: string;
  path: string;
  untaxedLines: number;
};

function sourceDocumentPath(financeBase: string, source: RecurringInvoiceSourceRef): string {
  return `${financeBase}/${source.kind === "invoice" ? "invoices" : "estimates"}/${source.slug}`;
}

async function loadSourceDocument(
  companyId: string,
  source: RecurringInvoiceSourceRef,
): Promise<{ document: RecurringInvoiceSourceDocument; number: string }> {
  const slug = encodeURIComponent(source.slug);
  if (source.kind === "invoice") {
    const invoice = await api.get<Invoice>(`/api/companies/${companyId}/invoices/${slug}`);
    return { document: invoice, number: invoice.number };
  }
  const estimate = await api.get<Estimate>(`/api/companies/${companyId}/estimates/${slug}`);
  return { document: estimate, number: estimate.number };
}

/**
 * `recurring-invoices/new` and `recurring-invoices/:recurringSlug/edit`.
 * Saving either needs Full finance access, so a read-only Member who lands
 * here gets a note instead of a form that could only be refused.
 */
export default function FinanceRecurringInvoiceNew() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { recurringSlug } = useParams();
  if (!canWriteFinance(company)) {
    return (
      <FinanceReadOnlyPage
        company={company}
        list={{ label: "Recurring invoices", path: "recurring-invoices" }}
        title={recurringSlug ? "Edit schedule" : "New recurring invoice"}
        backTo={recurringSlug ? `recurring-invoices/${recurringSlug}` : "recurring-invoices"}
      />
    );
  }
  return <RecurringInvoiceForm />;
}

/**
 * Recurring-invoice form — handles both create and edit. The lifecycle
 * controls (pause / resume / end / run now) live on the detail page.
 *
 * A new schedule is named after its customer until the person types a name
 * of their own (`lib/recurringInvoiceForm.ts`). `?customerId=` picks the
 * customer it starts with, which is how a customer's Billing tab opens it.
 * `?fromInvoice=` / `?fromEstimate=` start it as a copy of that document —
 * Make recurring on an invoice or estimate — leaving only the schedule to pick.
 *
 * A new schedule keeps a One-time / Recurring switch at the top. Switching to
 * One-time hands what was typed to the one-time invoice form, and coming
 * back from it fills this form with what was typed there
 * (`lib/invoiceKind.ts`), in place of any document named in the link.
 */
function RecurringInvoiceForm() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const navigate = useNavigate();
  const location = useLocation();
  const { recurringSlug } = useParams();
  const isEdit = Boolean(recurringSlug);
  const [searchParams] = useSearchParams();
  const requestedCustomerId = isEdit ? null : requestedRecurringInvoiceCustomerId(searchParams);
  // What the one-time form handed over, read once: the state is cleared
  // below, so a reload or a later Back starts the form fresh.
  const [received] = React.useState(() => (isEdit ? null : readInvoiceDraft(location.state)));
  React.useEffect(() => {
    if (!readInvoiceDraft(location.state)) return;
    navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location, navigate]);
  const sourceRef = isEdit || received ? null : requestedRecurringInvoiceSource(searchParams);
  const sourceKind = sourceRef?.kind ?? null;
  const sourceSlug = sourceRef?.slug ?? null;
  const financeBase = `/c/${company.slug}/finance`;
  // Cancel returns to where the person came from: the schedule being edited,
  // the document being copied, or the list.
  const backPath =
    isEdit && recurringSlug
      ? `${financeBase}/recurring-invoices/${recurringSlug}`
      : sourceRef
        ? sourceDocumentPath(financeBase, sourceRef)
        : `${financeBase}/recurring-invoices`;

  const [customers, setCustomers] = React.useState<Customer[] | null>(null);
  const [products, setProducts] = React.useState<Product[]>([]);
  const [taxRates, setTaxRates] = React.useState<TaxRate[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);

  const [subsidiaries, setSubsidiaries] = React.useState<Subsidiary[]>([]);
  const [subsidiaryId, setSubsidiaryId] = React.useState("");
  const [savedSubsidiaryId, setSavedSubsidiaryId] = React.useState<string | null>(null);
  const [customerId, setCustomerId] = React.useState("");
  // The customer the form was asked to start with — by the link, a copied
  // document, or the one-time form — which a switch passes on.
  const [askedCustomerId, setAskedCustomerId] = React.useState<string | null>(null);
  const [requestedCustomerUnavailable, setRequestedCustomerUnavailable] = React.useState(false);
  const [name, setName] = React.useState<RecurringInvoiceNameState>(() =>
    initialRecurringInvoiceName(null),
  );
  const [schedule, setSchedule] = React.useState<ScheduleParts>(defaultScheduleParts);
  const [daysUntilDue, setDaysUntilDue] = React.useState(DEFAULT_PAYMENT_TERMS_DAYS);
  const [autoSend, setAutoSend] = React.useState(false);
  const [currency, setCurrency] = React.useState("USD");
  const [notes, setNotes] = React.useState("");
  const [footer, setFooter] = React.useState("");
  const [maxRunsText, setMaxRunsText] = React.useState("");
  const [endsOn, setEndsOn] = React.useState("");
  const [lines, setLines] = React.useState<LineRow[]>([emptyLine()]);
  const [discount, setDiscount] = React.useState<DiscountDraft>(NO_DISCOUNT_DRAFT);
  const [source, setSource] = React.useState<SourceSummary | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const [c, p, t, subsidiaries] = await Promise.all([
          api.get<Customer[]>(`/api/companies/${company.id}/customers`),
          api.get<Product[]>(`/api/companies/${company.id}/products`),
          api.get<TaxRate[]>(`/api/companies/${company.id}/tax-rates`),
          financeSubsidiaries.list(company.id),
        ]);
        setCustomers(c);
        setProducts(p);
        setTaxRates(t);
        setSubsidiaries(subsidiaries);
        if (isEdit && recurringSlug) {
          const existing = await api.get<RecurringInvoice>(
            `/api/companies/${company.id}/recurring-invoices/${recurringSlug}`,
          );
          setCustomerId(existing.customerId);
          setSubsidiaryId(existing.subsidiaryId ?? "");
          setSavedSubsidiaryId(existing.subsidiaryId);

          setName(existingRecurringInvoiceName(existing.name));
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
          setEndsOn(existing.endsOn ? new Date(existing.endsOn).toISOString().slice(0, 10) : "");
          setLines(
            existing.lines.length === 0 ? [emptyLine()] : existing.lines.map(lineRowFromExisting),
          );
          setDiscount(discountDraftFrom(existing));
        } else {
          const ref = sourceKind && sourceSlug ? { kind: sourceKind, slug: sourceSlug } : null;
          const loaded = ref ? await loadSourceDocument(company.id, ref) : null;
          const prefill = loaded
            ? recurringInvoicePrefill(loaded.document, {
                productIds: new Set(p.map((product) => product.id)),
                taxRateIds: new Set(t.map((rate) => rate.id)),
                subsidiaryIds: new Set(subsidiaries.map((subsidiary) => subsidiary.id)),
              })
            : null;
          // A copied document's customer is asked for like a `?customerId=`
          // one: if it is archived, the form starts with nobody rather than
          // billing whoever is first in the list.
          const asked = prefill?.customerId ?? draftCustomerRequest(received, requestedCustomerId);
          setAskedCustomerId(asked);
          const initial = initialRecurringInvoiceCustomer(c, asked);
          setRequestedCustomerUnavailable(initial.requestedUnavailable);
          if (initial.customer) {
            setCustomerId(initial.customer.id);
            setCurrency(initial.customer.currency || "USD");
          }
          setName(initialRecurringInvoiceName(initial.customer));
          if (received) {
            const start = recurringInvoiceFromDraft(received, initial.customer);
            setSubsidiaryId(start.subsidiaryId);
            setCurrency(start.currency);
            setNotes(start.notes);
            setFooter(start.footer);
            setLines(start.lines.length === 0 ? [emptyLine()] : start.lines.map(lineRowFromDraft));
            setDiscount(start.discount);
            setDaysUntilDue(start.daysUntilDue);
            setName(start.name);
            setSchedule(start.schedule);
            setAutoSend(start.autoSend);
            setMaxRunsText(start.maxRunsText);
            setEndsOn(start.endsOn);
          }
          if (ref && loaded && prefill) {
            setSubsidiaryId(prefill.subsidiaryId);
            setCurrency(prefill.currency);
            if (prefill.daysUntilDue !== null) setDaysUntilDue(prefill.daysUntilDue);
            setNotes(prefill.notes);
            setFooter(prefill.footer);
            if (prefill.lines.length > 0) setLines(prefill.lines.map(lineRowFromExisting));
            setDiscount(discountDraftFrom(prefill.discount));
            setSource({
              kind: ref.kind,
              number: loaded.number,
              path: sourceDocumentPath(`/c/${company.slug}/finance`, ref),
              untaxedLines: prefill.untaxedLines,
            });
          }
        }
        setReady(true);
      } catch (err) {
        setLoadError((err as Error).message);
        setReady(true);
      }
    })();
  }, [
    company.id,
    company.slug,
    recurringSlug,
    isEdit,
    requestedCustomerId,
    sourceKind,
    sourceSlug,
    received,
  ]);

  function changeCustomer(id: string) {
    setCustomerId(id);
    setRequestedCustomerUnavailable(false);
    const c = customers?.find((x) => x.id === id) ?? null;
    if (c?.currency) setCurrency(c.currency);
    setName((current) => changeRecurringInvoiceNameCustomer(current, c));
  }

  function patchLine(idx: number, patch: Partial<LineRow>) {
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  // The line Add line just made, so its description takes the cursor. Lines
  // already there — and every line on an edit page — never take focus.
  const [newLineKey, setNewLineKey] = React.useState<string | null>(null);
  function addLine() {
    const line = emptyLine();
    setLines((ls) => [...ls, line]);
    setNewLineKey(line.key);
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

  // What each run's invoice will total, worked out the way the server prices
  // it, discount included.
  const preview = React.useMemo(
    () => previewTotals(lines, taxRates, discount),
    [lines, taxRates, discount],
  );

  const selectedCustomer = customers?.find((c) => c.id === customerId) ?? null;
  const customerName = defaultRecurringInvoiceName(selectedCustomer);
  const nameToSave = recurringInvoiceNameToSave(name, selectedCustomer);

  const canSave =
    !!customerId &&
    !!nameToSave &&
    lines.some((l) => l.description.trim().length > 0) &&
    !discountDraftProblem(discount);

  // Switching to One-time hands that form everything typed here, as it stands.
  const switchToOneTime = isEdit
    ? null
    : {
        to: switchInvoiceKindPath("one-time", financeBase, customerId, askedCustomerId),
        state: invoiceDraftState(
          draftFromRecurringInvoice(
            {
              customerId,
              subsidiaryId,
              currency,
              notes,
              footer,
              lines,
              discount,
              daysUntilDue,
              name,
              schedule,
              autoSend,
              maxRunsText,
              endsOn,
            },
            received,
          ),
        ),
      };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
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
        subsidiaryId: subsidiaryId || null,
        name: nameToSave,
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
        ...discountFromDraft(discount),
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
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!ready || (customers === null && !loadError)) {
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
          <Link to={backPath}>
            <Button variant="secondary">Back</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (!isEdit && customers?.length === 0) {
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
    <form onSubmit={save} className="page-shell p-8">
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

      <div
        className={
          "flex flex-wrap items-center justify-between gap-3 " + (switchToOneTime ? "mb-4" : "mb-6")
        }
      >
        <div className="flex items-center gap-3">
          <Link
            to={backPath}
            aria-label="Back"
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {isEdit ? "Edit schedule" : "New recurring invoice"}
          </h1>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Link to={backPath}>
            <Button type="button" variant="secondary" disabled={busy}>
              Cancel
            </Button>
          </Link>
          <Button type="submit" loading={busy} disabled={!canSave}>
            {isEdit ? "Save changes" : "Create schedule"}
          </Button>
        </div>
      </div>

      {switchToOneTime && (
        <InvoiceKindSwitch
          current="recurring"
          to={switchToOneTime.to}
          state={switchToOneTime.state}
          disabled={busy}
        />
      )}

      <FormError message={error} className="mb-4" />

      {source && <SourceNote source={source} />}

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-6 max-w-xl">
          <InvoiceIssuerSelect
            company={company}
            subsidiaries={subsidiaries}
            value={subsidiaryId}
            savedSubsidiaryId={savedSubsidiaryId}
            onChange={setSubsidiaryId}
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <Input
              label="Name"
              value={name.value}
              onChange={(e) => setName(typedRecurringInvoiceName(e.target.value))}
              placeholder={customerName || "Name this schedule"}
              maxLength={RECURRING_INVOICE_NAME_MAX_LENGTH}
            />
            {!name.value.trim() && customerName && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Leave blank to use the customer&apos;s name.
              </p>
            )}
          </div>
          <div className="min-w-0">
            <Select
              label="Customer"
              value={customerId}
              onChange={(e) => changeCustomer(e.target.value)}
              required
            >
              {customers?.map((c) => (
                <option key={c.id} value={c.id}>
                  {customerOptionLabel(c)}
                </option>
              ))}
            </Select>
            <CustomerBillTo
              companyId={company.id}
              customer={selectedCustomer}
              kind="recurringInvoice"
              onCustomerSaved={(saved) => setCustomers((list) => withSavedCustomer(list, saved))}
            />
            {requestedCustomerUnavailable && !customerId && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                The customer you came from is archived or no longer exists. Choose who to bill.
              </p>
            )}
          </div>
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
                    intervalCount: Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)),
                  })
                }
                className={`${scheduleField} w-16 text-center tabular-nums`}
                aria-label="Interval count"
              />
              <Select
                value={schedule.frequency}
                onChange={(e) =>
                  setSchedule({ ...schedule, frequency: e.target.value as Frequency })
                }
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
              </Select>

              {schedule.frequency === "weekly" && (
                <>
                  <span>on</span>
                  <Select
                    value={schedule.weekday}
                    onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}
                    aria-label="Day of week"
                  >
                    {WEEKDAY_LABELS.map((w, i) => (
                      <option key={w} value={i}>
                        {w}
                      </option>
                    ))}
                  </Select>
                </>
              )}

              {schedule.frequency === "yearly" && (
                <>
                  <span>in</span>
                  <Select
                    value={schedule.month}
                    onChange={(e) => setSchedule({ ...schedule, month: Number(e.target.value) })}
                    aria-label="Month"
                  >
                    {MONTH_LABELS.map((mn, i) => (
                      <option key={mn} value={i + 1}>
                        {mn}
                      </option>
                    ))}
                  </Select>
                </>
              )}

              {schedule.frequency !== "weekly" && schedule.frequency !== "daily" && (
                <>
                  <span>on the</span>
                  <Select
                    value={schedule.dayOfMonth}
                    onChange={(e) =>
                      setSchedule({ ...schedule, dayOfMonth: Number(e.target.value) })
                    }
                    aria-label="Day of month"
                  >
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {ordinal(d)}
                      </option>
                    ))}
                  </Select>
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
                — without this, each tick creates a draft you review and send manually.
              </span>
            </span>
          </label>
        </div>

        <div className="mt-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Line items</h2>
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
                  lineTotal = gross + Math.round((gross * rate.ratePercent) / 100);
                }
                return (
                  <tbody
                    key={l.key}
                    className={i > 0 ? "border-t border-slate-100 dark:border-slate-800" : ""}
                  >
                    <tr>
                      <td className="px-2 pt-2 align-top">
                        <Select
                          value={l.productId ?? ""}
                          onChange={(e) => pickProduct(i, e.target.value)}
                          aria-label={`Line ${i + 1} product`}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">—</option>
                          {products.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="px-2 pt-2 align-top">
                        <input
                          value={l.quantityText}
                          onChange={(e) => patchLine(i, { quantityText: e.target.value })}
                          inputMode="decimal"
                          aria-label={`Line ${i + 1} quantity`}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="px-2 pt-2 align-top">
                        <input
                          value={l.priceText}
                          onChange={(e) => patchLine(i, { priceText: e.target.value })}
                          inputMode="decimal"
                          aria-label={`Line ${i + 1} unit price`}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-right text-sm tabular-nums dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                      <td className="px-2 pt-2 align-top">
                        <Select
                          value={l.taxRateId}
                          onChange={(e) => patchLine(i, { taxRateId: e.target.value })}
                          aria-label={`Line ${i + 1} tax`}
                          className="h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                        >
                          <option value="">No tax</option>
                          {taxRates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name} ({t.ratePercent}%{t.inclusive ? " incl" : ""})
                            </option>
                          ))}
                        </Select>
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
                      <td colSpan={6} className="px-2 pb-3 pt-2">
                        {/* Multi-line, like the one-time form's: an `<input>`
                            would drop the line breaks of a description copied
                            from an invoice or carried over by a switch. */}
                        <textarea
                          value={l.description}
                          onChange={(e) => patchLine(i, { description: e.target.value })}
                          autoFocus={l.key === newLineKey}
                          aria-label={`Line ${i + 1} description`}
                          placeholder="Description"
                          rows={2}
                          className="block w-full resize-y rounded-md border border-slate-200 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                        />
                      </td>
                    </tr>
                  </tbody>
                );
              })}
            </table>
            <div className="border-t border-slate-100 bg-slate-50/40 p-2 dark:border-slate-800 dark:bg-slate-900/30">
              <Button type="button" variant="secondary" onClick={addLine} size="sm">
                <Plus size={14} /> Add line
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-4 ml-auto w-full space-y-1 text-sm sm:w-72">
          <div className="flex justify-between text-slate-500 dark:text-slate-400">
            <span>Subtotal</span>
            <span className="tabular-nums">
              {formatMoney(preview.subtotalCents + preview.discountCents, currency)}
            </span>
          </div>
          <DiscountField
            draft={discount}
            onChange={setDiscount}
            currency={currency}
            discountCents={preview.discountCents}
          />
          <div className="flex justify-between text-slate-500 dark:text-slate-400">
            <span>Tax</span>
            <span className="tabular-nums">{formatMoney(preview.taxCents, currency)}</span>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-2 text-base font-semibold text-slate-900 dark:border-slate-700 dark:text-slate-100">
            <span>Total per invoice</span>
            <span className="tabular-nums">{formatMoney(preview.totalCents, currency)}</span>
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
            {subsidiaryId && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Leave blank to use this subsidiary&apos;s footer.
              </p>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}

/**
 * Which invoice or estimate this schedule copies, and what of it could not
 * come along: a tax rate deleted since the document was written.
 */
function SourceNote({ source }: { source: SourceSummary }) {
  const noun = source.kind;
  const link = (
    <Link
      to={source.path}
      className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
    >
      {source.number || `this draft ${noun}`}
    </Link>
  );
  return (
    <div className="mb-4 space-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
      <p>
        Copied from {source.number ? <>{noun} {link}</> : link}. Choose how often to bill it
        below; the {noun} itself stays as it is.
      </p>
      {source.untaxedLines > 0 && (
        <p className="text-amber-700 dark:text-amber-300">
          {source.untaxedLines === 1 ? "One line" : `${source.untaxedLines} lines`} on the {noun}{" "}
          used a tax rate that has since been deleted, so{" "}
          {source.untaxedLines === 1 ? "it starts" : "they start"} untaxed here.
        </p>
      )}
    </div>
  );
}
