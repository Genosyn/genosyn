import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  Download,
  FileSignature,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { api, Customer, CustomerContract } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Select } from "../components/ui/Select";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { ContractUploadModal } from "../components/ContractUploadModal";
import { formatContractSize, formatSignedDate } from "../lib/contracts";
import { CustomersOutletCtx } from "./CustomersLayout";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Every signed contract for the company, across all customers — the
 * "upload all the contracts" surface. Each row links to its customer (when
 * tagged) and offers download / edit / delete. Per-customer uploads live on
 * the customer edit page; both share the same upload modal.
 */
export default function ContractsIndex() {
  const { company } = useOutletContext<CustomersOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const [contracts, setContracts] = React.useState<CustomerContract[] | null>(null);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [filter, setFilter] = React.useState("");
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerContract | null>(null);

  const reload = React.useCallback(async () => {
    const list = await api.get<CustomerContract[]>(
      `/api/companies/${company.id}/contracts`,
    );
    setContracts(list);
  }, [company.id]);

  React.useEffect(() => {
    reload().catch(() => setContracts([]));
    api
      .get<Customer[]>(`/api/companies/${company.id}/customers`)
      .then(setCustomers)
      .catch(() => setCustomers([]));
  }, [reload, company.id]);

  useLiveRefetch(["contract", "customer"], reload);

  const visible = React.useMemo(() => {
    if (!contracts) return [];
    if (!filter) return contracts;
    if (filter === "__none__") return contracts.filter((c) => !c.customerId);
    return contracts.filter((c) => c.customerId === filter);
  }, [contracts, filter]);

  async function remove(c: CustomerContract) {
    const ok = await dialog.confirm({
      title: `Delete “${c.title}”?`,
      message: "This permanently removes the uploaded file. This cannot be undone.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/contracts/${c.id}`);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  function openUpload() {
    setEditing(null);
    setUploadOpen(true);
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Customers", to: `/c/${company.slug}/customers` }, { label: "Contracts" }]} />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Contracts
        </h1>
        <div className="flex items-center gap-3">
          {customers.length > 0 && (
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-9"
              aria-label="Filter by customer"
            >
              <option value="">All customers</option>
              <option value="__none__">Unassigned</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
          <Button onClick={openUpload}>
            <Plus size={14} /> Upload contract
          </Button>
        </div>
      </div>

      {contracts === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <FileSignature size={24} className="mx-auto text-slate-300 dark:text-slate-600" />
          <h3 className="mt-3 text-base font-semibold text-slate-900 dark:text-slate-100">
            {contracts.length === 0 ? "No contracts yet" : "No matching contracts"}
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {contracts.length === 0
              ? "Upload the agreements you've signed with customers to keep them in one place."
              : "Try a different customer filter."}
          </p>
          {contracts.length === 0 && (
            <div className="mt-4">
              <Button onClick={openUpload}>
                <Plus size={14} /> Upload contract
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Title</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-left font-medium">Signed</th>
                <th className="px-4 py-2 text-right font-medium">Size</th>
                <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {c.title}
                    </div>
                    {c.title !== c.filename && (
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                        {c.filename}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {c.customer ? (
                      c.customer.name
                    ) : (
                      <span className="text-slate-400">Unassigned</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {c.signedAt ? (
                      formatSignedDate(c.signedAt)
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-500 dark:text-slate-400">
                    {formatContractSize(c.sizeBytes)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <a
                        href={`/api/companies/${company.id}/contracts/${c.id}/file`}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                        aria-label="Download contract"
                        title="Download"
                      >
                        <Download size={16} />
                      </a>
                      <RowMenu
                        onEdit={() => {
                          setEditing(c);
                          setUploadOpen(true);
                        }}
                        onDelete={() => remove(c)}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}

      <ContractUploadModal
        company={company}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSaved={() => reload()}
        customers={customers}
        existing={editing}
      />
    </div>
  );
}

function RowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <Menu
      align="right"
      width={160}
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
            label="Edit details"
            onSelect={() => {
              close();
              onEdit();
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
