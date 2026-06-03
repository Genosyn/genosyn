import React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { api, Company, Customer, CustomerContract } from "../lib/api";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Select } from "./ui/Select";
import { Textarea } from "./ui/Textarea";
import { useToast } from "./ui/Toast";

/**
 * Upload a new signed contract or edit an existing one's metadata. Shared by
 * the global Contracts page and the per-customer contracts panel.
 *
 * Rendered through a portal to `document.body` so it can be mounted from
 * inside another `<form>` (the customer edit page) without nesting forms —
 * which would be invalid HTML and would route the modal's Enter key to the
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
  const { toast } = useToast();
  const isEdit = Boolean(existing);
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [customerId, setCustomerId] = React.useState("");
  const [signedAt, setSignedAt] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // Reseed the fields whenever the modal opens or its target changes.
  React.useEffect(() => {
    if (!open) return;
    setFile(null);
    setTitle(existing?.title ?? "");
    setCustomerId(lockedCustomerId ?? existing?.customerId ?? "");
    setSignedAt(existing?.signedAt ? existing.signedAt.slice(0, 10) : "");
    setNotes(existing?.notes ?? "");
  }, [open, existing, lockedCustomerId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!isEdit && !file) {
      toast("Choose a file to upload", "error");
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
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;
  const showPicker = !lockedCustomerId && customers !== undefined;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
      onClick={onClose}
    >
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3 dark:border-slate-800">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {isEdit ? "Edit contract" : "Upload contract"}
          </h2>
          <button
            type="button"
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {isEdit ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
              {existing?.filename}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                File
              </label>
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
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 px-5 py-3 dark:border-slate-800">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || (!isEdit && !file)}>
            {isEdit ? "Save changes" : "Upload"}
          </Button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
