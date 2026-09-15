import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowRight, ScrollText } from "lucide-react";
import { api, type Customer } from "@/lib/api";
import { Breadcrumbs } from "@/components/AppShell";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import CustomerStatement from "@/pages/CustomerStatement";
import { type FinanceOutletCtx } from "@/pages/FinanceLayout";

/**
 * Finance entry point for customer statements. The accounting statement
 * remains the same shared view used by Customers; this page only owns the
 * customer chooser and Finance-specific route.
 */
export default function FinanceCustomerStatements() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { customerSlug } = useParams();
  const navigate = useNavigate();
  const financeUrl = `/c/${company.slug}/finance`;
  const statementsUrl = `${financeUrl}/customer-statements`;
  const [customers, setCustomers] = React.useState<Customer[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<Customer[]>(
        `/api/companies/${company.id}/customers?archived=true`,
      );
      setCustomers(list);
      setLoadError(false);
    } catch {
      setCustomers([]);
      setLoadError(true);
    }
  }, [company.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  useLiveRefetch("customer", reload);

  const customerSwitcher = (
    <CustomerSwitcher
      customers={customers}
      error={loadError}
      value={customerSlug ?? ""}
      onChange={(slug) => navigate(`${statementsUrl}/${slug}`)}
      onRetry={reload}
    />
  );

  if (customerSlug) {
    return (
      <CustomerStatement
        key={customerSlug}
        surface="finance"
        customerSwitcher={customerSwitcher}
      />
    );
  }

  return (
    <div className="page-shell p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[{ label: "Finance", to: financeUrl }, { label: "Customer statements" }]}
        />
      </div>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Customer statements
        </h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          View, print, or download a statement of account.
        </p>
      </div>

      {customerSwitcher}

      {!loadError && customers?.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <ScrollText size={24} className="mx-auto text-slate-300 dark:text-slate-600" />
          <h2 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
            No customers yet
          </h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Add a customer before creating a statement of account.
          </p>
          <Link
            to={`/c/${company.slug}/customers`}
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
          >
            Go to Customers <ArrowRight size={14} />
          </Link>
        </div>
      ) : !loadError && customers ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Select a customer to view their statement.
        </p>
      ) : null}
    </div>
  );
}

function CustomerSwitcher({
  customers,
  error,
  value,
  onChange,
  onRetry,
}: {
  customers: Customer[] | null;
  error: boolean;
  value: string;
  onChange: (slug: string) => void;
  onRetry: () => Promise<void>;
}) {
  const active = customers?.filter((customer) => !customer.archivedAt) ?? [];
  const archived = customers?.filter((customer) => customer.archivedAt) ?? [];

  function optionLabel(customer: Customer): string {
    const detail = customer.email || customer.domain;
    const archivedLabel = customer.archivedAt ? " (archived)" : "";
    return `${customer.name}${detail ? ` — ${detail}` : ""}${archivedLabel}`;
  }

  return (
    <div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="max-w-xl">
        <label
          htmlFor="statement-customer"
          className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
        >
          Customer
        </label>
        {error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <span>Couldn&apos;t load customers.</span>
            <Button variant="secondary" onClick={() => void onRetry()}>
              Try again
            </Button>
          </div>
        ) : customers === null ? (
          <div className="flex h-10 items-center px-3 text-slate-400">
            <Spinner size={16} />
          </div>
        ) : (
          <Select
            id="statement-customer"
            aria-label="Customer"
            value={value}
            disabled={customers.length === 0}
            onChange={(event) => onChange(event.target.value)}
            searchPlaceholder="Search customers…"
            emptyMessage="No customers found"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
          >
            <option value="" disabled>
              Select a customer…
            </option>
            {active.length > 0 && (
              <optgroup label="Active customers">
                {active.map((customer) => (
                  <option
                    key={customer.id}
                    value={customer.slug}
                    data-search-text={`${customer.email} ${customer.domain} ${customer.currency}`}
                  >
                    {optionLabel(customer)}
                  </option>
                ))}
              </optgroup>
            )}
            {archived.length > 0 && (
              <optgroup label="Archived customers">
                {archived.map((customer) => (
                  <option
                    key={customer.id}
                    value={customer.slug}
                    data-search-text={`${customer.email} ${customer.domain} ${customer.currency}`}
                  >
                    {optionLabel(customer)}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        )}
      </div>
    </div>
  );
}
