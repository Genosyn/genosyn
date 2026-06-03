import React from "react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ArrowLeft, Plus, Star, Trash2 } from "lucide-react";
import {
  api,
  Customer,
  CustomerContact,
  CustomerContactDraft,
  parseMoneyToCents,
} from "../lib/api";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Spinner";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { useToast } from "../components/ui/Toast";
import { CustomersOutletCtx } from "./CustomersLayout";
import { CustomerContractsPanel } from "./CustomerContractsPanel";

/**
 * Customer create / edit page. The form has room to breathe and scrolls
 * naturally with the page when contacts pile up. Handles both create (no
 * `:customerSlug` route param) and edit (param present), mirroring the
 * invoice / estimate / bill flows. In edit mode it also surfaces the
 * customer's signed contracts.
 */

/**
 * Row in the inline contacts editor. Carries a stable `key` so React
 * doesn't lose focus when sibling rows are added or removed mid-edit.
 * `id` is null for newly-added rows that haven't been persisted yet — the
 * save path uses it to choose POST vs PATCH per row.
 */
type ContactRow = {
  key: string;
  id: string | null;
  name: string;
  email: string;
  phone: string;
  role: string;
  isPrimary: boolean;
};

function emptyContactRow(): ContactRow {
  return {
    key: Math.random().toString(36).slice(2, 10),
    id: null,
    name: "",
    email: "",
    phone: "",
    role: "",
    isPrimary: false,
  };
}

function rowFromContact(c: CustomerContact): ContactRow {
  return {
    key: c.id,
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    role: c.role,
    isPrimary: c.isPrimary,
  };
}

export default function CustomerNew() {
  const { company } = useOutletContext<CustomersOutletCtx>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { customerSlug } = useParams();
  const isEdit = Boolean(customerSlug);
  const customersUrl = `/c/${company.slug}/customers`;

  const [ready, setReady] = React.useState(!isEdit);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [taxNumber, setTaxNumber] = React.useState("");
  const [currency, setCurrency] = React.useState("USD");
  // Annual Contract Value kept as the raw text the user types; converted to
  // cents on save and back to a plain amount when loading an existing row.
  const [acv, setAcv] = React.useState("");
  const [billingAddress, setBillingAddress] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [contacts, setContacts] = React.useState<ContactRow[]>([]);
  // Track which previously-persisted contacts the user removed so we can
  // delete them in the save pass.
  const [removedContactIds, setRemovedContactIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!isEdit || !customerSlug) return;
    (async () => {
      try {
        const c = await api.get<Customer>(
          `/api/companies/${company.id}/customers/${customerSlug}`,
        );
        setCustomerId(c.id);
        setName(c.name);
        setEmail(c.email);
        setPhone(c.phone);
        setTaxNumber(c.taxNumber);
        setCurrency(c.currency || "USD");
        setAcv(
          c.annualContractValueCents > 0
            ? (c.annualContractValueCents / 100).toFixed(2)
            : "",
        );
        setBillingAddress(c.billingAddress);
        setNotes(c.notes);
        setContacts(c.contacts.map(rowFromContact));
        setReady(true);
      } catch (err) {
        setLoadError((err as Error).message);
        setReady(true);
      }
    })();
  }, [company.id, customerSlug, isEdit]);

  function patchContact(idx: number, patch: Partial<ContactRow>) {
    setContacts((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
  function addContact() {
    setContacts((rows) => [...rows, emptyContactRow()]);
  }
  function removeContact(idx: number) {
    setContacts((rows) => {
      const removed = rows[idx];
      if (removed.id) {
        setRemovedContactIds((ids) => [...ids, removed.id!]);
      }
      return rows.filter((_, i) => i !== idx);
    });
  }
  function setPrimary(idx: number) {
    setContacts((rows) =>
      rows.map((r, i) => ({ ...r, isPrimary: i === idx ? !r.isPrimary : false })),
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const trimmedContacts = contacts
        .map((r, i) => ({ ...r, sortOrder: i }))
        .filter((r) => r.name.trim().length > 0);

      const baseBody = {
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim(),
        taxNumber: taxNumber.trim(),
        currency: currency.trim().toUpperCase(),
        annualContractValueCents: parseMoneyToCents(acv),
        billingAddress,
        notes,
      };

      if (isEdit && customerSlug) {
        // Updates: patch the customer row, then reconcile contacts row by
        // row — POST new ones, PATCH existing ones, DELETE removed ones.
        await api.patch(
          `/api/companies/${company.id}/customers/${customerSlug}`,
          baseBody,
        );
        for (const id of removedContactIds) {
          await api.del(
            `/api/companies/${company.id}/customers/${customerSlug}/contacts/${id}`,
          );
        }
        for (let i = 0; i < trimmedContacts.length; i += 1) {
          const r = trimmedContacts[i];
          const payload = {
            name: r.name.trim(),
            email: r.email.trim(),
            phone: r.phone.trim(),
            role: r.role.trim(),
            isPrimary: r.isPrimary,
            sortOrder: i,
          };
          if (r.id) {
            await api.patch(
              `/api/companies/${company.id}/customers/${customerSlug}/contacts/${r.id}`,
              payload,
            );
          } else {
            await api.post(
              `/api/companies/${company.id}/customers/${customerSlug}/contacts`,
              payload,
            );
          }
        }
      } else {
        // Creates: send everything in one round-trip so a freshly-created
        // customer never exists momentarily without its contacts.
        const inlineContacts: CustomerContactDraft[] = trimmedContacts.map(
          (r, i) => ({
            name: r.name.trim(),
            email: r.email.trim(),
            phone: r.phone.trim(),
            role: r.role.trim(),
            isPrimary: r.isPrimary,
            sortOrder: i,
          }),
        );
        await api.post(`/api/companies/${company.id}/customers`, {
          ...baseBody,
          contacts: inlineContacts,
        });
      }
      toast(isEdit ? "Customer updated" : "Customer created", "success");
      navigate(customersUrl);
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!ready) {
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
            { label: "Customers", to: customersUrl },
            { label: "Edit" },
          ]}
        />
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          {loadError}
        </div>
        <div className="mt-4">
          <Link to={customersUrl}>
            <Button variant="secondary">Back</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={save} className="mx-auto max-w-3xl p-8">
      <div className="mb-6">
        <Breadcrumbs
          items={[
            { label: "Customers", to: customersUrl },
            { label: isEdit ? "Edit" : "New" },
          ]}
        />
      </div>

      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link
            to={customersUrl}
            className="rounded-md p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {isEdit ? "Edit customer" : "New customer"}
          </h1>
        </div>
        <div className="flex gap-2">
          <Link to={customersUrl}>
            <Button type="button" variant="secondary" disabled={busy}>
              Cancel
            </Button>
          </Link>
          <Button type="submit" disabled={busy || !name.trim()}>
            {isEdit ? "Save changes" : "Create customer"}
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <Input
            label={`Annual contract value (${currency || "USD"})`}
            value={acv}
            onChange={(e) => setAcv(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
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
        </div>

        <div className="mt-6 border-t border-slate-100 pt-6 dark:border-slate-800">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Contacts
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                People at this account. The email above is used for invoices
                and estimates; contacts are for your records.
              </p>
            </div>
            <button
              type="button"
              onClick={addContact}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
            >
              <Plus size={12} /> Add contact
            </button>
          </div>

          {contacts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-400 dark:border-slate-700 dark:text-slate-500">
              No additional contacts yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {contacts.map((r, i) => (
                <li
                  key={r.key}
                  className="rounded-lg border border-slate-200 p-3 dark:border-slate-700"
                >
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Input
                      label="Name"
                      value={r.name}
                      onChange={(e) => patchContact(i, { name: e.target.value })}
                      maxLength={120}
                      required
                    />
                    <Input
                      label="Role / title (optional)"
                      value={r.role}
                      onChange={(e) => patchContact(i, { role: e.target.value })}
                      maxLength={120}
                    />
                    <Input
                      label="Email"
                      value={r.email}
                      onChange={(e) => patchContact(i, { email: e.target.value })}
                      type="email"
                      maxLength={200}
                    />
                    <Input
                      label="Phone"
                      value={r.phone}
                      onChange={(e) => patchContact(i, { phone: e.target.value })}
                      maxLength={60}
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setPrimary(i)}
                      className={
                        "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition " +
                        (r.isPrimary
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300"
                          : "text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800")
                      }
                      aria-pressed={r.isPrimary}
                    >
                      <Star size={12} className={r.isPrimary ? "fill-current" : ""} />
                      {r.isPrimary ? "Primary contact" : "Mark primary"}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeContact(i)}
                      className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                      aria-label="Remove contact"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {isEdit && customerId && (
        <div className="mt-6">
          <CustomerContractsPanel
            company={company}
            customerId={customerId}
            customerName={name}
          />
        </div>
      )}
    </form>
  );
}
