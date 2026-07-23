import React from "react";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import {
  Archive,
  ArchiveRestore,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { api, Customer, formatMoney } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
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
  const { background } = useToast();
  const dialog = useDialog();
  const [customers, setCustomers] = React.useState<Customer[] | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [showArchived, setShowArchived] = React.useState(false);

  const reload = React.useCallback(async () => {
    const list = await api.get<Customer[]>(
      `/api/companies/${company.id}/customers?archived=${showArchived}`,
    );
    setCustomers(list);
    setLoadError(false);
  }, [company.id, showArchived]);

  React.useEffect(() => {
    reload().catch(() => {
      setCustomers([]);
      setLoadError(true);
    });
  }, [reload]);

  useLiveRefetch("customer", reload);

  function archive(c: Customer) {
    const archived = !c.archivedAt;
    const originalIndex = customers?.findIndex((item) => item.id === c.id) ?? -1;
    const optimistic = {
      ...c,
      archivedAt: archived ? new Date().toISOString() : null,
    };
    setCustomers((current) => {
      if (!current) return current;
      if (archived && !showArchived) return current.filter((item) => item.id !== c.id);
      return current.map((item) => (item.id === c.id ? optimistic : item));
    });
    background(
      () =>
        api.patch<Customer>(`/api/companies/${company.id}/customers/${c.slug}`, {
          archived,
        }),
      {
        loading: archived ? "Archiving customer…" : "Restoring customer…",
        success: archived ? "Customer archived" : "Customer restored",
        error: (error) =>
          `Couldn\u2019t update the customer: ${
            error instanceof Error ? error.message : "Unknown error"
          }. The change was undone.`,
        onSuccess: () => void reload(),
        onError: () => {
          setCustomers((current) => {
            if (!current) return current;
            if (current.some((item) => item.id === c.id)) {
              return current.map((item) => (item.id === c.id ? c : item));
            }
            const next = [...current];
            next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, c);
            return next;
          });
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
    const originalIndex = customers?.findIndex((item) => item.id === c.id) ?? -1;
    setCustomers((current) => current?.filter((item) => item.id !== c.id) ?? current);
    background(() => api.del(`/api/companies/${company.id}/customers/${c.slug}`), {
      loading: "Deleting customer…",
      success: "Customer deleted",
      error: (error) =>
        `Couldn\u2019t delete the customer: ${
          error instanceof Error ? error.message : "Unknown error"
        }. It has been restored.`,
      onError: () => {
        setCustomers((current) => {
          if (!current || current.some((item) => item.id === c.id)) return current;
          const next = [...current];
          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, c);
          return next;
        });
      },
    });
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Customers" }]} />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Customers</h1>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
              className="rounded border-slate-300"
            />
            Show archived
          </label>
          <Button onClick={() => navigate(`/c/${company.slug}/customers/new`)}>
            <Plus size={14} /> New customer
          </Button>
        </div>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            Couldn&apos;t load customers
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Something went wrong fetching this list.
          </p>
          <Button
            variant="secondary"
            className="mt-4"
            onClick={() =>
              reload().catch(() => {
                setCustomers([]);
                setLoadError(true);
              })
            }
          >
            Try again
          </Button>
        </div>
      ) : customers === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : customers.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No customers yet
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Add the first customer you bill so you can issue an invoice.
          </p>
          <div className="mt-4">
            <Button onClick={() => navigate(`/c/${company.slug}/customers/new`)}>
              <Plus size={14} /> New customer
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
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
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function RowMenu({
  onEdit,
  onArchive,
  onDelete,
  archived,
}: {
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  archived: boolean;
}) {
  return (
    <Menu
      align="right"
      width={176}
      trigger={({ ref, onClick }) => (
        <button
          ref={ref}
          onClick={onClick}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
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
