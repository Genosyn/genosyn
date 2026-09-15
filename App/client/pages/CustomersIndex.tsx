import React from "react";
import { Link, useNavigate, useOutletContext, useSearchParams } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  Globe2,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, formatMoney, type Customer, type CustomerListPage } from "../lib/api";
import { errorMessage } from "../lib/errors";
import {
  CUSTOMER_LIST_QUERY_MAX_LENGTH,
  clampCustomerPage,
  customerListApiParams,
  customerListPageRange,
  customerListRangeLabel,
  customerListViewKey,
  parseCustomerListParams,
  patchCustomerListParams,
  type CustomerListUrlState,
} from "../lib/customerList";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { CustomersOutletCtx } from "./CustomersLayout";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Customers list — the landing page of the standalone Customers section.
 * Creating and editing happen on a dedicated `customers/new` /
 * `customers/:slug/edit` page (not a modal) so the form has room for
 * contacts and contracts.
 */
export default function CustomersIndex() {
  const { company } = useOutletContext<CustomersOutletCtx>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const background = useBackgroundAction();
  const dialog = useDialog();

  const listState = React.useMemo(() => parseCustomerListParams(searchParams), [searchParams]);
  const searchParamsKey = searchParams.toString();
  const viewKey = `${company.id}:${customerListViewKey(listState)}`;
  const [searchDraft, setSearchDraft] = React.useState(listState.query);
  const [showArchivedDraft, setShowArchivedDraft] = React.useState(listState.showArchived);
  const [loaded, setLoaded] = React.useState<{
    viewKey: string;
    page: CustomerListPage;
  } | null>(null);
  const [failedView, setFailedView] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const pendingCustomerIdsRef = React.useRef<Set<string>>(new Set());
  const [pendingCustomerIds, setPendingCustomerIds] = React.useState<ReadonlySet<string>>(
    pendingCustomerIdsRef.current,
  );
  const latestRequest = React.useRef(0);
  const latestViewKey = React.useRef(viewKey);
  const reloadRef = React.useRef<() => void>(() => undefined);
  latestViewKey.current = viewKey;

  React.useEffect(() => {
    setSearchDraft(listState.query);
  }, [listState.query, searchParamsKey]);

  React.useEffect(() => {
    setShowArchivedDraft(listState.showArchived);
  }, [listState.showArchived]);

  React.useEffect(() => {
    const normalized = searchDraft.trim().slice(0, CUSTOMER_LIST_QUERY_MAX_LENGTH);
    if (normalized === listState.query) return;
    const timer = window.setTimeout(() => {
      setSearchParams((current) => patchCustomerListParams(current, { query: searchDraft }), {
        replace: true,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [listState.query, searchDraft, searchParamsKey, setSearchParams]);

  const reload = React.useCallback(async () => {
    const requestId = ++latestRequest.current;
    setLoading(true);
    setFailedView((current) => (current === viewKey ? null : current));
    try {
      const query = customerListApiParams(listState);
      const page = await api.get<CustomerListPage>(
        `/api/companies/${company.id}/customers?${query.toString()}`,
      );
      if (requestId !== latestRequest.current || latestViewKey.current !== viewKey) return;

      const boundedPage = clampCustomerPage(listState.page, page.total);
      if (boundedPage !== listState.page) {
        setSearchParams((current) => patchCustomerListParams(current, { page: boundedPage }), {
          replace: true,
        });
        return;
      }
      setLoaded({ viewKey, page });
      setFailedView(null);
    } catch {
      if (requestId !== latestRequest.current || latestViewKey.current !== viewKey) return;
      setFailedView(viewKey);
    } finally {
      if (requestId === latestRequest.current && latestViewKey.current === viewKey) {
        setLoading(false);
      }
    }
  }, [company.id, listState, setSearchParams, viewKey]);
  reloadRef.current = () => {
    void reload();
  };

  React.useEffect(() => {
    void reload();
    return () => {
      latestRequest.current += 1;
    };
  }, [reload]);

  useLiveRefetch("customer", reload);

  const page = loaded?.viewKey === viewKey ? loaded.page : null;
  const customers = page?.customers ?? null;
  const total = page?.total ?? 0;
  const range = customerListPageRange(listState.page, total);
  const loadError = failedView === viewKey;
  let resultStatus = "Loading customers…";
  if (loadError) resultStatus = "Couldn’t load customers.";
  else if (customers && loading) resultStatus = "Updating customers…";
  else if (customers?.length) resultStatus = customerListRangeLabel(listState.page, total);
  else if (customers && total > 0) resultStatus = "Updating customers…";
  else if (customers && listState.query) resultStatus = "No customers match your search.";
  else if (customers) resultStatus = "No customers to show.";

  const updateListParams = React.useCallback(
    (patch: Partial<CustomerListUrlState>, replace = false) => {
      setSearchParams(
        (current) =>
          patchCustomerListParams(current, {
            ...patch,
            query: patch.query ?? searchDraft,
          }),
        { replace },
      );
    },
    [searchDraft, setSearchParams],
  );

  function beginCustomerMutation(customerId: string): boolean {
    if (pendingCustomerIdsRef.current.has(customerId)) return false;
    const next = new Set(pendingCustomerIdsRef.current);
    next.add(customerId);
    pendingCustomerIdsRef.current = next;
    setPendingCustomerIds(next);
    return true;
  }

  function finishCustomerMutation(customerId: string): void {
    const next = new Set(pendingCustomerIdsRef.current);
    next.delete(customerId);
    pendingCustomerIdsRef.current = next;
    setPendingCustomerIds(next);
  }

  function clearSearch() {
    setSearchDraft("");
    updateListParams({ query: "" }, true);
  }

  function updateCurrentPage(
    actionViewKey: string,
    update: (current: CustomerListPage) => CustomerListPage,
  ) {
    setLoaded((current) => {
      if (!current || current.viewKey !== actionViewKey) return current;
      return { ...current, page: update(current.page) };
    });
  }

  function archive(c: Customer) {
    if (!beginCustomerMutation(c.id)) return;
    const archived = !c.archivedAt;
    const actionViewKey = viewKey;
    const originalIndex = customers?.findIndex((item) => item.id === c.id) ?? -1;
    const dropped = archived && !listState.showArchived;
    const optimistic = {
      ...c,
      archivedAt: archived ? new Date().toISOString() : null,
    };
    updateCurrentPage(actionViewKey, (current) => {
      const nextCustomers = dropped
        ? current.customers.filter((item) => item.id !== c.id)
        : current.customers.map((item) => (item.id === c.id ? optimistic : item));
      return {
        ...current,
        customers: nextCustomers,
        total: dropped ? Math.max(0, current.total - 1) : current.total,
      };
    });
    background(
      () =>
        api.patch<Customer>(`/api/companies/${company.id}/customers/${c.slug}`, {
          archived,
        }),
      {
        title: "Couldn’t update the customer",
        error: (error) => `${errorMessage(error)} The change was undone.`,
        onSuccess: () => {
          finishCustomerMutation(c.id);
          reloadRef.current();
        },
        onError: () => {
          updateCurrentPage(actionViewKey, (current) => {
            if (current.customers.some((item) => item.id === c.id)) {
              return {
                ...current,
                customers: current.customers.map((item) => (item.id === c.id ? c : item)),
              };
            }
            const next = [...current.customers];
            next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, c);
            return {
              ...current,
              customers: next,
              total: dropped ? current.total + 1 : current.total,
            };
          });
          finishCustomerMutation(c.id);
          reloadRef.current();
        },
      },
    );
  }

  async function remove(c: Customer) {
    const confirmed = await dialog.confirm({
      title: `Delete ${c.name}?`,
      message: "This cannot be undone. Customers with invoices cannot be deleted.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!confirmed) return;
    if (!beginCustomerMutation(c.id)) return;
    const actionViewKey = viewKey;
    const originalIndex = customers?.findIndex((item) => item.id === c.id) ?? -1;
    updateCurrentPage(actionViewKey, (current) => ({
      ...current,
      customers: current.customers.filter((item) => item.id !== c.id),
      total: Math.max(0, current.total - 1),
    }));
    background(() => api.del(`/api/companies/${company.id}/customers/${c.slug}`), {
      title: "Couldn’t delete the customer",
      error: (error) => `${errorMessage(error)} It has been restored.`,
      onSuccess: () => {
        finishCustomerMutation(c.id);
        reloadRef.current();
      },
      onError: () => {
        updateCurrentPage(actionViewKey, (current) => {
          if (current.customers.some((item) => item.id === c.id)) return current;
          const next = [...current.customers];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, c);
          return { ...current, customers: next, total: current.total + 1 };
        });
        finishCustomerMutation(c.id);
        reloadRef.current();
      },
    });
  }

  return (
    <div className="page-shell p-4 sm:p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Customers" }]} />
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Customers</h1>
        <Button onClick={() => navigate(`/c/${company.slug}/customers/new`)}>
          <Plus size={14} /> New customer
        </Button>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative min-w-0 flex-1">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
          />
          <input
            type="search"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            maxLength={CUSTOMER_LIST_QUERY_MAX_LENGTH}
            aria-label="Search customers"
            placeholder="Search customers…"
            className="h-10 w-full appearance-none rounded-lg border border-slate-200 bg-white pl-9 pr-10 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:ring-indigo-500/25"
          />
          {searchDraft && (
            <button
              type="button"
              onClick={clearSearch}
              aria-label="Clear customer search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <label className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showArchivedDraft}
            onChange={(event) => {
              setShowArchivedDraft(event.target.checked);
              updateListParams({ showArchived: event.target.checked });
            }}
            className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
          />
          Show archived
        </label>
      </div>

      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {resultStatus}
      </p>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load customers
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong fetching this list.
          </p>
          <Button variant="secondary" className="mt-4" onClick={() => reloadRef.current()}>
            Try again
          </Button>
        </div>
      ) : customers === null ? (
        <div className="flex justify-center p-16" aria-label="Loading customers">
          <Spinner size={20} />
        </div>
      ) : customers.length === 0 && total > 0 ? (
        <div className="flex items-center justify-center gap-2 p-16 text-sm text-slate-500 dark:text-slate-400">
          <Spinner size={20} /> Updating customer list…
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {listState.query ? "No customers match your search" : "No customers yet"}
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {listState.query
              ? "Try a different search term, or clear the search to see every customer."
              : "Add the first customer you bill so you can issue an invoice."}
          </p>
          <div className="mt-4">
            {listState.query ? (
              <Button variant="secondary" onClick={clearSearch}>
                <X size={14} /> Clear search
              </Button>
            ) : (
              <Button onClick={() => navigate(`/c/${company.slug}/customers/new`)}>
                <Plus size={14} /> New customer
              </Button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div
            className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
            aria-busy={loading}
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <caption className="sr-only">Customers</caption>
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Name</th>
                    <th className="px-4 py-2 text-left font-medium">Domain</th>
                    <th className="px-4 py-2 text-left font-medium">Email</th>
                    <th className="px-4 py-2 text-left font-medium">Contacts</th>
                    <th className="px-4 py-2 text-right font-medium">Annual contract value</th>
                    <th className="px-4 py-2 text-left font-medium">Currency</th>
                    <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {customers.map((c) => (
                    <tr key={c.id} className={c.archivedAt ? "opacity-60" : ""}>
                      <td className="px-4 py-3">
                        <Link
                          to={`/c/${company.slug}/customers/${c.slug}`}
                          className="font-medium text-slate-900 hover:text-indigo-600 hover:underline dark:text-slate-100 dark:hover:text-indigo-400"
                        >
                          {c.name}
                        </Link>
                        {c.taxNumber && (
                          <div className="text-xs text-slate-500 dark:text-slate-400">
                            Tax #: {c.taxNumber}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {c.domain ? (
                          <span
                            className="inline-flex max-w-[220px] items-center gap-1"
                            title={c.domain}
                          >
                            <Globe2 size={12} className="shrink-0" />
                            <span className="truncate">{c.domain}</span>
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {c.email ? (
                          <span className="inline-flex items-center gap-1">
                            <Mail size={12} /> {c.email}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {c.contacts.length > 0 ? (
                          <span className="inline-flex items-center gap-1 text-xs">
                            <Users size={12} /> {c.contacts.length}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-700 dark:text-slate-200">
                        {c.annualContractValueCents > 0 ? (
                          formatMoney(c.annualContractValueCents, c.currency)
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                        {c.currency}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <RowMenu
                          onEdit={() => navigate(`/c/${company.slug}/customers/${c.slug}/edit`)}
                          onArchive={() => archive(c)}
                          onDelete={() => remove(c)}
                          archived={!!c.archivedAt}
                          disabled={pendingCustomerIds.has(c.id)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
            <span className="tabular-nums">{customerListRangeLabel(listState.page, total)}</span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={!range.hasPrevious || loading}
                onClick={() => updateListParams({ page: listState.page - 1 })}
              >
                <ChevronLeft size={14} /> Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={!range.hasNext || loading}
                onClick={() => updateListParams({ page: listState.page + 1 })}
              >
                Next <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function RowMenu({
  onEdit,
  onArchive,
  onDelete,
  archived,
  disabled,
}: {
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  archived: boolean;
  disabled: boolean;
}) {
  return (
    <Menu
      align="right"
      width={176}
      trigger={({ ref, onClick }) => (
        <button
          ref={ref}
          onClick={onClick}
          disabled={disabled}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-wait disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          aria-label="Row menu"
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon={<Pencil size={14} />}
            label="Edit"
            onSelect={() => {
              close();
              onEdit();
            }}
          />
          <MenuItem
            icon={archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            label={archived ? "Unarchive" : "Archive"}
            onSelect={() => {
              close();
              onArchive();
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={14} className="text-red-500" />}
            label={<span className="text-red-600 dark:text-red-400">Delete</span>}
            onSelect={() => {
              close();
              onDelete();
            }}
          />
        </>
      )}
    </Menu>
  );
}
