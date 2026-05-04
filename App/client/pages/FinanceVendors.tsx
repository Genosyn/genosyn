import React from "react";
import { useOutletContext } from "react-router-dom";
import { Archive, ArchiveRestore, Mail, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { api, Vendor } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Vendors page. Phase G of the Finance milestone (M19). Mirrors the
 * Customers page; same modal-edit, archive-or-delete affordances. Two
 * pages stay separate (rather than one shared "Counterparties" view)
 * because billing-side and supplier-side workflows diverge fast as
 * Phase G+ adds vendor-specific fields (W-9 status, payment terms).
 */
export default function FinanceVendors() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const [vendors, setVendors] = React.useState<Vendor[] | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [editing, setEditing] = React.useState<Vendor | "new" | null>(null);

  const reload = React.useCallback(async () => {
    const list = await api.get<Vendor[]>(
      `/api/companies/${company.id}/vendors?archived=${showArchived}`,
    );
    setVendors(list);
  }, [company.id, showArchived]);

  React.useEffect(() => {
    reload().catch(() => setVendors([]));
  }, [reload]);

  async function archive(v: Vendor) {
    await api.patch(`/api/companies/${company.id}/vendors/${v.slug}`, {
      archived: !v.archivedAt,
    });
    reload();
  }

  async function remove(v: Vendor) {
    const ok = await dialog.confirm({
      title: `Delete ${v.name}?`,
      message: "Vendors with bills cannot be deleted.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/vendors/${v.slug}`);
      reload();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Vendors" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Vendors
        </h1>
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
          <Button onClick={() => setEditing("new")}>
            <Plus size={14} /> New vendor
          </Button>
        </div>
      </div>

      {vendors === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : vendors.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No vendors yet
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Add the suppliers and contractors you pay so you can record bills.
          </p>
          <div className="mt-4">
            <Button onClick={() => setEditing("new")}>
              <Plus size={14} /> New vendor
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Currency</th>
                <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {vendors.map((v) => (
                <tr key={v.id} className={v.archivedAt ? "opacity-60" : ""}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {v.name}
                    </div>
                    {v.taxNumber && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        Tax #: {v.taxNumber}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {v.email ? (
                      <span className="inline-flex items-center gap-1">
                        <Mail size={12} /> {v.email}
                      </span>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {v.currency}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RowMenu
                      vendor={v}
                      onEdit={() => setEditing(v)}
                      onArchive={() => archive(v)}
                      onDelete={() => remove(v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <VendorEditor
          companyId={company.id}
          vendor={editing === "new" ? null : editing}
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

function RowMenu({
  vendor,
  onEdit,
  onArchive,
  onDelete,
}: {
  vendor: Vendor;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        aria-label="Row menu"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-lg border border-slate-200 bg-white py-1 text-left text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
            <button
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              <Pencil size={14} /> Edit
            </button>
            <button
              onClick={() => {
                setOpen(false);
                onArchive();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
            >
              {vendor.archivedAt ? (
                <>
                  <ArchiveRestore size={14} /> Unarchive
                </>
              ) : (
                <>
                  <Archive size={14} /> Archive
                </>
              )}
            </button>
            <button
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 border-t border-slate-100 px-3 py-2 text-red-600 hover:bg-red-50 dark:border-slate-800 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function VendorEditor({
  companyId,
  vendor,
  onClose,
  onSaved,
}: {
  companyId: string;
  vendor: Vendor | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = React.useState(vendor?.name ?? "");
  const [email, setEmail] = React.useState(vendor?.email ?? "");
  const [phone, setPhone] = React.useState(vendor?.phone ?? "");
  const [taxNumber, setTaxNumber] = React.useState(vendor?.taxNumber ?? "");
  const [currency, setCurrency] = React.useState(vendor?.currency ?? "USD");
  const [address, setAddress] = React.useState(vendor?.address ?? "");
  const [notes, setNotes] = React.useState(vendor?.notes ?? "");
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        taxNumber: taxNumber.trim(),
        currency: currency.trim().toUpperCase(),
        address,
        notes,
      };
      if (vendor) {
        await api.patch(`/api/companies/${companyId}/vendors/${vendor.slug}`, body);
      } else {
        await api.post(`/api/companies/${companyId}/vendors`, body);
      }
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={vendor ? `Edit ${vendor.name}` : "New vendor"}
      size="lg"
    >
      <form onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={120}
          />
        </div>
        <Input
          label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
        />
        <Input
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Input
          label="Tax / VAT number"
          value={taxNumber}
          onChange={(e) => setTaxNumber(e.target.value)}
        />
        <Input
          label="Default currency (ISO)"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          maxLength={3}
        />
        <div className="sm:col-span-2">
          <Textarea
            label="Address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            rows={3}
          />
        </div>
        <div className="sm:col-span-2">
          <Textarea
            label="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
          />
        </div>
        <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {vendor ? "Save" : "Create vendor"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
