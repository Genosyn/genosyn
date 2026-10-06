import React from "react";
import { useOutletContext } from "react-router-dom";
import { Archive, ArchiveRestore, Building2, Pencil, Plus } from "lucide-react";
import { financeSubsidiaries, InvoiceIssuer, Subsidiary } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import { Breadcrumbs } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/FormError";
import { useDialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { FinanceOutletCtx } from "@/pages/FinanceLayout";

export default function FinanceSubsidiaries() {
  const { company } = useOutletContext<FinanceOutletCtx>();
  const dialog = useDialog();
  const canManage = company.role === "owner" || company.role === "admin";
  const [subsidiaries, setSubsidiaries] = React.useState<Subsidiary[] | null>(null);
  const [editing, setEditing] = React.useState<Subsidiary | "new" | null>(null);
  const [showArchived, setShowArchived] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [retrying, setRetrying] = React.useState(false);

  const reload = React.useCallback(async () => {
    try {
      setSubsidiaries(await financeSubsidiaries.list(company.id));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [company.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  async function retry() {
    setRetrying(true);
    try {
      await reload();
    } finally {
      setRetrying(false);
    }
  }

  async function setArchived(subsidiary: Subsidiary) {
    setBusyId(subsidiary.id);
    setError(null);
    try {
      const updated = await financeSubsidiaries.update(company.id, subsidiary.id, {
        archived: !subsidiary.archived,
      });
      setSubsidiaries(
        (current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null,
      );
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t update the subsidiary" });
    } finally {
      setBusyId(null);
    }
  }

  const visible = subsidiaries?.filter((item) => showArchived || !item.archived) ?? [];
  return (
    <div className="page-shell p-4 sm:p-8">
      <Breadcrumbs
        items={[{ label: "Finance", to: `/c/${company.slug}/finance` }, { label: "Subsidiaries" }]}
      />
      <div className="mb-6 mt-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Subsidiaries
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-500 dark:text-slate-400">
            Add the legal entities that issue your invoices and estimates. Choose an issuer when
            preparing each document.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setEditing("new")}>
            <Plus size={14} /> Add subsidiary
          </Button>
        )}
      </div>

      <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/40 dark:text-slate-300">
        Documents keep their saved issuer details when a subsidiary changes. Numbering, the ledger,
        and email delivery settings stay shared across the company.
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
            className="rounded border-slate-300"
          />
          Show archived
        </label>
        {!canManage && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Owners and admins manage subsidiaries.
          </p>
        )}
      </div>
      <FormError message={error} className="mb-4" />
      {subsidiaries === null ? (
        error ? (
          <Button variant="secondary" loading={retrying} onClick={() => void retry()}>
            Try again
          </Button>
        ) : (
          <div className="flex justify-center p-16">
            <Spinner size={20} />
          </div>
        )
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-200 bg-white px-6 py-12 text-center dark:border-slate-700 dark:bg-slate-900">
          <Building2 size={24} className="mx-auto mb-3 text-slate-400" />
          <h2 className="font-semibold text-slate-900 dark:text-slate-100">
            {subsidiaries.length ? "No active subsidiaries" : "No subsidiaries yet"}
          </h2>
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Your company remains the default issuer. Add a subsidiary to bill from another legal
            entity.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((subsidiary) => (
            <div
              key={subsidiary.id}
              className="flex flex-wrap items-start justify-between gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
            >
              <div className="min-w-0 flex-1 basis-64 break-words">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium text-slate-900 dark:text-slate-100">
                    {subsidiary.name}
                  </h2>
                  {subsidiary.archived && (
                    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      Archived
                    </span>
                  )}
                </div>
                {(subsidiary.address || subsidiary.country) && (
                  <p className="mt-1 whitespace-pre-line text-sm text-slate-500 dark:text-slate-400">
                    {[subsidiary.address, subsidiary.country].filter(Boolean).join("\n")}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                  {subsidiary.taxNumber && <span>Tax / VAT: {subsidiary.taxNumber}</span>}
                  {subsidiary.registrationNumber && (
                    <span>Registration: {subsidiary.registrationNumber}</span>
                  )}
                  {subsidiary.email && <span>{subsidiary.email}</span>}
                </div>
              </div>
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => setEditing(subsidiary)}>
                    <Pencil size={13} /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busyId === subsidiary.id}
                    onClick={() => void setArchived(subsidiary)}
                  >
                    {subsidiary.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
                    {subsidiary.archived ? "Reactivate" : "Archive"}
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {editing && (
        <SubsidiaryEditor
          companyId={company.id}
          subsidiary={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setSubsidiaries((current) => {
              const rows = current ?? [];
              return (
                rows.some((item) => item.id === saved.id)
                  ? rows.map((item) => (item.id === saved.id ? saved : item))
                  : [...rows, saved]
              ).sort((a, b) => a.name.localeCompare(b.name));
            });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function SubsidiaryEditor({
  companyId,
  subsidiary,
  onClose,
  onSaved,
}: {
  companyId: string;
  subsidiary: Subsidiary | null;
  onClose: () => void;
  onSaved: (subsidiary: Subsidiary) => void;
}) {
  const [draft, setDraft] = React.useState<InvoiceIssuer>({
    name: subsidiary?.name ?? "",
    address: subsidiary?.address ?? "",
    country: subsidiary?.country ?? "",
    taxNumber: subsidiary?.taxNumber ?? "",
    registrationNumber: subsidiary?.registrationNumber ?? "",
    email: subsidiary?.email ?? "",
    phone: subsidiary?.phone ?? "",
    website: subsidiary?.website ?? "",
    footer: subsidiary?.footer ?? "",
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  function field(key: keyof InvoiceIssuer, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...draft, name: draft.name.trim(), email: draft.email.trim() };
      const saved = subsidiary
        ? await financeSubsidiaries.update(companyId, subsidiary.id, body)
        : await financeSubsidiaries.create(companyId, body);
      onSaved(saved);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={subsidiary ? "Edit subsidiary" : "Add subsidiary"}
      size="lg"
    >
      <form onSubmit={save} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Input
            label="Legal name"
            value={draft.name}
            onChange={(event) => field("name", event.target.value)}
            required
            maxLength={200}
          />
        </div>
        <div className="sm:col-span-2">
          <Textarea
            label="Registered address"
            value={draft.address}
            onChange={(event) => field("address", event.target.value)}
            rows={3}
            maxLength={2000}
          />
        </div>
        <Input
          label="Country"
          value={draft.country}
          onChange={(event) => field("country", event.target.value)}
          maxLength={120}
        />
        <Input
          label="Tax / VAT number"
          value={draft.taxNumber}
          onChange={(event) => field("taxNumber", event.target.value)}
          maxLength={120}
        />
        <Input
          label="Registration number"
          value={draft.registrationNumber}
          onChange={(event) => field("registrationNumber", event.target.value)}
          maxLength={120}
        />
        <Input
          label="Email"
          type="email"
          value={draft.email}
          onChange={(event) => field("email", event.target.value)}
          maxLength={320}
        />
        <Input
          label="Phone"
          value={draft.phone}
          onChange={(event) => field("phone", event.target.value)}
          maxLength={80}
        />
        <Input
          label="Website"
          value={draft.website}
          onChange={(event) => field("website", event.target.value)}
          maxLength={500}
          placeholder="https://example.com"
        />
        <div className="sm:col-span-2">
          <Textarea
            label="Default footer"
            value={draft.footer}
            onChange={(event) => field("footer", event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Payment terms, bank details, or other legal information"
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Used when the document&apos;s own footer is blank.
          </p>
        </div>
        <FormError message={error} className="sm:col-span-2" />
        <div className="flex justify-end gap-2 pt-2 sm:col-span-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!draft.name.trim()}>
            {subsidiary ? "Save changes" : "Create subsidiary"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
