import React from "react";
import { useOutletContext } from "react-router-dom";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { api, formatMoney, parseMoneyToCents, Product, TaxRate } from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Select } from "../components/ui/Select";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { FinanceOutletCtx } from "./FinanceLayout";

/**
 * Products + Services catalog. Phase A of the Finance milestone (M19).
 *
 * Products are *templates* — invoice line items snapshot description /
 * unit price / tax at create time, so editing or deleting a product
 * never mutates a historical invoice.
 */
export default function FinanceProducts() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const { toast } = useToast();
  const dialog = useDialog();
  const [products, setProducts] = React.useState<Product[] | null>(null);
  const [taxRates, setTaxRates] = React.useState<TaxRate[]>([]);
  const [showArchived, setShowArchived] = React.useState(false);
  const [editing, setEditing] = React.useState<Product | "new" | null>(null);

  const reload = React.useCallback(async () => {
    const [p, t] = await Promise.all([
      api.get<Product[]>(
        `/api/companies/${company.id}/products?archived=${showArchived}`,
      ),
      api.get<TaxRate[]>(`/api/companies/${company.id}/tax-rates`),
    ]);
    setProducts(p);
    setTaxRates(t);
  }, [company.id, showArchived]);

  React.useEffect(() => {
    reload().catch(() => setProducts([]));
  }, [reload]);

  async function archive(p: Product) {
    await api.patch(`/api/companies/${company.id}/products/${p.slug}`, {
      archived: !p.archivedAt,
    });
    reload();
  }

  async function remove(p: Product) {
    const ok = await dialog.confirm({
      title: `Delete ${p.name}?`,
      message: "Existing invoices will keep their snapshotted line items.",
      variant: "danger",
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/products/${p.slug}`);
      reload();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  const taxById = React.useMemo(
    () => new Map(taxRates.map((t) => [t.id, t])),
    [taxRates],
  );

  return (
    <div className="mx-auto max-w-5xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Finance", to: `/c/${company.slug}/finance` },
            { label: "Products" },
          ]}
        />
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
          Products & services
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
            <Plus size={14} /> New product
          </Button>
        </div>
      </div>

      {products === null ? (
        <div className="flex justify-center p-16">
          <Spinner size={20} />
        </div>
      ) : products.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white p-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No products yet
          </h3>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Add reusable line items so invoicing is one click.
          </p>
          <div className="mt-4">
            <Button onClick={() => setEditing("new")}>
              <Plus size={14} /> New product
            </Button>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-right font-medium">Unit price</th>
                <th className="px-4 py-2 text-left font-medium">Default tax</th>
                <th className="px-4 py-2 text-right font-medium">&nbsp;</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {products.map((p) => (
                <tr key={p.id} className={p.archivedAt ? "opacity-60" : ""}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900 dark:text-slate-100">
                      {p.name}
                    </div>
                    {p.description && (
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        {p.description}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-slate-900 dark:text-slate-100">
                    {formatMoney(p.unitPriceCents, p.currency)}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                    {p.defaultTaxRateId
                      ? taxById.get(p.defaultTaxRateId)?.name ?? "—"
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RowMenu
                      archived={!!p.archivedAt}
                      onEdit={() => setEditing(p)}
                      onArchive={() => archive(p)}
                      onDelete={() => remove(p)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ProductEditor
          companyId={company.id}
          taxRates={taxRates}
          product={editing === "new" ? null : editing}
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

function ProductEditor({
  companyId,
  taxRates,
  product,
  onClose,
  onSaved,
}: {
  companyId: string;
  taxRates: TaxRate[];
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = React.useState(product?.name ?? "");
  const [description, setDescription] = React.useState(product?.description ?? "");
  const [priceText, setPriceText] = React.useState(
    product ? (product.unitPriceCents / 100).toFixed(2) : "",
  );
  const [currency, setCurrency] = React.useState(product?.currency ?? "USD");
  const [defaultTaxRateId, setDefaultTaxRateId] = React.useState(
    product?.defaultTaxRateId ?? "",
  );
  const [busy, setBusy] = React.useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description,
        unitPriceCents: parseMoneyToCents(priceText),
        currency: currency.trim().toUpperCase(),
        defaultTaxRateId: defaultTaxRateId || null,
      };
      if (product) {
        await api.patch(
          `/api/companies/${companyId}/products/${product.slug}`,
          body,
        );
      } else {
        await api.post(`/api/companies/${companyId}/products`, body);
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
      title={product ? `Edit ${product.name}` : "New product"}
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
        <div className="sm:col-span-2">
          <Textarea
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <Input
          label="Unit price"
          value={priceText}
          onChange={(e) => setPriceText(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
        />
        <Input
          label="Currency (ISO)"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          maxLength={3}
        />
        <div className="sm:col-span-2">
          <Select
            label="Default tax rate"
            value={defaultTaxRateId}
            onChange={(e) => setDefaultTaxRateId(e.target.value)}
          >
            <option value="">— None —</option>
            {taxRates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.ratePercent}%{t.inclusive ? ", incl." : ""})
              </option>
            ))}
          </Select>
        </div>
        <div className="sm:col-span-2 flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {product ? "Save" : "Create product"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
