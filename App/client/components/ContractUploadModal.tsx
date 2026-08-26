import React from "react";
import { api, Company, Customer, CustomerContract } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { Button } from "./ui/Button";
import { FormError } from "./ui/FormError";
import { Input } from "./ui/Input";
import { Modal } from "./ui/Modal";
import { Select } from "./ui/Select";
import { Textarea } from "./ui/Textarea";

/**
 * Upload a new signed contract or edit an existing one's metadata. Shared by
 * the global Contracts page and the per-customer contracts panel.
 *
 * `Modal` renders through a portal to `document.body`, so this can be mounted
 * from inside another `<form>` (the customer edit page) without nesting forms
 * — which would be invalid HTML and would route the modal's Enter key to the
 * outer form.
 */
export function ContractUploadModal({
  company,
  open,
  onClose,
  onSaved,
  customers,
  lockedCustomerId,
  existing,
}: {
  company: Company;
  open: boolean;
  onClose: () => void;
  onSaved: (contract: CustomerContract) => void;
  /** Customers to pick from. Omit to hide the picker (e.g. locked context). */
  customers?: Customer[];
  /** Lock the contract to this customer and hide the picker. */
  lockedCustomerId?: string;
  /** Edit this contract's metadata instead of uploading a new file. */
  existing?: CustomerContract | null;
}) {
  const isEdit = Boolean(existing);
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [customerId, setCustomerId] = React.useState("");
  const [signedAt, setSignedAt] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reseed the fields whenever the modal opens or its target changes.
  React.useEffect(() => {
    if (!open) return;
    setError(null);
    setFile(null);
    setTitle(existing?.title ?? "");
    setCustomerId(lockedCustomerId ?? existing?.customerId ?? "");
    setSignedAt(existing?.signedAt ? existing.signedAt.slice(0, 10) : "");
    setNotes(existing?.notes ?? "");
  }, [open, existing, lockedCustomerId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!isEdit && !file) {
      setError("Choose a file to upload");
      return;
    }
    setBusy(true);
    try {
      let saved: CustomerContract;
      if (isEdit && existing) {
        saved = await api.patch<CustomerContract>(
          `/api/companies/${company.id}/contracts/${existing.id}`,
          {
            title: title.trim() || existing.filename,
            customerId: customerId || null,
            signedAt: signedAt || null,
            notes: notes.trim(),
          },
        );
      } else {
        saved = await api.uploadFile<CustomerContract>(
          `/api/companies/${company.id}/contracts`,
          file as File,
          {
            title: title.trim(),
            customerId,
            signedAt,
            notes: notes.trim(),
          },
        );
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const showPicker = !lockedCustomerId && customers !== undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit contract" : "Upload contract"}
      onSubmit={save}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || (!isEdit && !file)}>
            {isEdit ? "Save changes" : "Upload"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {isEdit ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {existing?.filename}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700 dark:text-slate-300">File</label>
            <input
              type="file"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                if (f && !title.trim()) setTitle(f.name);
              }}
              className="text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100 dark:text-slate-300 dark:file:bg-indigo-500/10 dark:file:text-indigo-300"
            />
            <p className="text-xs text-slate-400 dark:text-slate-500">
              PDF, image, or document up to 25 MB.
            </p>
          </div>
        )}

        <Input
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          placeholder="Master Services Agreement"
        />

        {showPicker && (
          <Select
            label="Customer"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          >
            <option value="">— No customer —</option>
            {customers?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}

        <Input
          label="Signed date"
          type="date"
          value={signedAt}
          onChange={(e) => setSignedAt(e.target.value)}
        />

        <Textarea
          label="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="min-h-[5rem]"
        />
        <FormError message={error} />
      </div>
    </Modal>
  );
}
