import React from "react";
import { Download, FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { api, Company, CustomerContract } from "../lib/api";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { ContractUploadModal } from "../components/ContractUploadModal";
import { formatContractSize, formatSignedDate } from "../lib/contracts";

/**
 * The signed contracts for one customer, shown on the customer edit page.
 * Lives inside the customer `<form>`, so every control here is
 * `type="button"` — the upload modal itself portals out of the form.
 */
export function CustomerContractsPanel({
  company,
  customerId,
  customerName,
}: {
  company: Company;
  customerId: string;
  customerName: string;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [contracts, setContracts] = React.useState<CustomerContract[] | null>(null);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<CustomerContract | null>(null);

  const reload = React.useCallback(async () => {
    const list = await api.get<CustomerContract[]>(
      `/api/companies/${company.id}/contracts?customerId=${customerId}`,
    );
    setContracts(list);
  }, [company.id, customerId]);

  React.useEffect(() => {
    reload().catch(() => setContracts([]));
  }, [reload]);

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

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Contracts
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Signed agreements you hold with {customerName || "this customer"}.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditing(null);
            setUploadOpen(true);
          }}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
        >
          <Plus size={12} /> Upload contract
        </button>
      </div>

      {contracts === null ? (
        <div className="flex justify-center p-8">
          <Spinner size={18} />
        </div>
      ) : contracts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400 dark:border-slate-700 dark:text-slate-500">
          No contracts uploaded yet.
        </div>
      ) : (
        <ul className="space-y-2">
          {contracts.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
            >
              <FileText size={16} className="shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                  {c.title}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {formatSignedDate(c.signedAt)} · {formatContractSize(c.sizeBytes)}
                </div>
              </div>
              <a
                href={`/api/companies/${company.id}/contracts/${c.id}/file`}
                target="_blank"
                rel="noreferrer"
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                aria-label="Download contract"
                title="Download"
              >
                <Download size={15} />
              </a>
              <button
                type="button"
                onClick={() => {
                  setEditing(c);
                  setUploadOpen(true);
                }}
                className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                aria-label="Edit contract"
                title="Edit"
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                onClick={() => remove(c)}
                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                aria-label="Delete contract"
                title="Delete"
              >
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ContractUploadModal
        company={company}
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onSaved={() => reload()}
        lockedCustomerId={customerId}
        existing={editing}
      />
    </div>
  );
}
