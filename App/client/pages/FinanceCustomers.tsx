import React from "react";
import { useOutletContext } from "react-router-dom";
import { Archive, ArchiveRestore, Mail, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { api, Customer } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Customers list + edit drawer for Phase A of the Finance milestone (M19).
 *
 * Editing happens in a modal rather than a dedicated detail route — Phase A
 * customers are billing-only, no per-customer history view yet. Phase B
 * adds the AR-aging detail page.
 */
export default function FinanceCustomers() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const [customers, setCustomers] = React.useState<Customer[] | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [editing, setEditing] = React.useState<Customer | "new" | null>(null);

  const reload = React.useCallback(async () => {
    const list = await api.get<Customer[]>(
      `/api/companies/${company.id}/customers?archived=${showArchived}`,
    );
    setCustomers(list);
  }, [company.id, showArchived]);

  React.useEffect(() => {
    reload().catch(() => setCustomers([]));
  }, [reload]);

  async function archive(c: Customer) {
    await api.patch(`/api/companies/${company.id}/customers/${c.slug}`, {
      archived: !c.archivedAt,
    });
    reload();
  }

  async function remove(c: Customer) {
    const confirmed = await dialog.confirm({
      title: `Delete ${c.name}?`,
      message: "This cannot be undone. Customers with invoices cannot be deleted.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!confirmed) return;
    try {
      await api.del(`/api/companies/${company.id}/customers/${c.slug}`);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Customers" }]} />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Customers
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
            <Plus size={14} /> New customer
          </Button>
        </div>
      </div>

      {customers === null ? (
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
            <Button onClick={() => setEditing("new")}>
              <Plus size={14} /> New customer
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
              {customers.map((c) => (
                <tr key={c.id} className={c.archivedAt ? "opacity-60" : ""}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {c.name}
                    </div>
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
                  <td className="px-4 py-3 font-mono text-xs text-slate-500 dark:text-slate-400">
                    {c.currency}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RowMenu
                      onEdit={() => setEditing(c)}
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
      )}

      {editing && (
        <CustomerEditor
          companyId={company.id}
          customer={editing === "new" ? null : editing}
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

function CustomerEditor({
  companyId,
  customer,
  onClose,
  onSaved,
}: {
  companyId: string;
  customer: Customer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = React.useState(customer?.name ?? "");
  const [email, setEmail] = React.useState(customer?.email ?? "");
  const [phone, setPhone] = React.useState(customer?.phone ?? "");
  const [taxNumber, setTaxNumber] = React.useState(customer?.taxNumber ?? "");
  const [currency, setCurrency] = React.useState(customer?.currency ?? "USD");
  const [billingAddress, setBillingAddress] = React.useState(
    customer?.billingAddress ?? "",
  );
  const [notes, setNotes] = React.useState(customer?.notes ?? "");
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
        billingAddress,
        notes,
      };
      if (customer) {
        await api.patch(
          `/api/companies/${companyId}/customers/${customer.slug}`,
          body,
        );
      } else {
        await api.post(`/api/companies/${companyId}/customers`, body);
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
      title={customer ? `Edit ${customer.name}` : "New customer"}
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
          maxLength={200}
        />
        <Input
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          maxLength={60}
        />
        <Input
          label="Tax / VAT number"
          value={taxNumber}
          onChange={(e) => setTaxNumber(e.target.value)}
          maxLength={60}
        />
        <Input
          label="Default currency (ISO)"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          maxLength={3}
          placeholder="USD"
        />
        <div className="sm:col-span-2">
          <Textarea
            label="Billing address"
            value={billingAddress}
            onChange={(e) => setBillingAddress(e.target.value)}
            rows={3}
            placeholder="Street address, city, postcode, country"
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
            {customer ? "Save" : "Create customer"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
