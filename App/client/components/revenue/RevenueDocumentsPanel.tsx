import React from "react";
import { ExternalLink, FileText, Paperclip, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../../lib/api";
import type { RevenueDocument, RevenueDocumentKind, RevenueResourceType } from "../../lib/revenue";
import { Button } from "../ui/Button";
import { FormError } from "../ui/FormError";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";

const KIND_LABEL: Record<RevenueDocumentKind, string> = {
  proposal: "Proposal",
  rfp: "RFP",
  security_questionnaire: "Security questionnaire",
  contract: "Contract",
  email_attachment: "Email attachment",
  other: "Other",
};

function resourceBody(resourceType: RevenueResourceType, resourceId: string) {
  if (resourceType === "account") return { customerId: resourceId };
  return { [`${resourceType}Id`]: resourceId };
}

export function RevenueDocumentsPanel({
  companyId,
  resourceType,
  resourceId,
}: {
  companyId: string;
  resourceType: RevenueResourceType;
  resourceId: string;
}) {
  const base = `/api/companies/${companyId}/revenue`;
  const queryKey = resourceType === "account" ? "customerId" : `${resourceType}Id`;
  const [rows, setRows] = React.useState<RevenueDocument[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<RevenueDocument | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const result = await api.get<{ rows: RevenueDocument[] }>(
      `${base}/documents?${queryKey}=${resourceId}`,
    );
    setRows(result.rows);
    setError(null);
  }, [base, queryKey, resourceId]);

  React.useEffect(() => {
    reload().catch((cause) => {
      setRows([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [reload]);

  async function remove(id: string) {
    try {
      await api.del(`${base}/documents/${id}`);
      setRows((current) => current?.filter((row) => row.id !== id) ?? current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
            <Paperclip size={16} /> Documents
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            Proposals, RFPs, questionnaires, contracts, and mail attachments.
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
          <Plus size={14} /> Link
        </Button>
      </div>
      {error && <FormError message={error} />}
      {rows?.length ? (
        <div className="space-y-2">
          {rows.map((document) => {
            const href = document.attachment
              ? `${base}/documents/${document.id}/file`
              : document.externalUrl || null;
            return (
              <div
                key={document.id}
                className="flex items-center gap-3 rounded-lg border border-slate-100 p-3 dark:border-slate-800"
              >
                <FileText size={16} className="shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 truncate text-sm font-medium text-indigo-600 hover:underline"
                    >
                      {document.title} <ExternalLink size={11} />
                    </a>
                  ) : (
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-200">
                      {document.title}
                    </p>
                  )}
                  <p className="text-xs text-slate-500">
                    {KIND_LABEL[document.kind]}
                    {document.attachment ? ` · ${document.attachment.filename}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setEditing(document)}
                  className="rounded p-1 text-slate-400 hover:bg-indigo-50 hover:text-indigo-600 dark:hover:bg-indigo-950"
                  aria-label={`Edit ${document.title}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void remove(document.id)}
                  className="rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950"
                  aria-label={`Remove ${document.title}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No formal documents linked yet.</p>
      )}

      <AddDocumentModal
        open={adding}
        onClose={() => setAdding(false)}
        base={base}
        resource={resourceBody(resourceType, resourceId)}
        onAdded={() => {
          setAdding(false);
          void reload();
        }}
      />
      <EditDocumentModal
        document={editing}
        base={base}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void reload();
        }}
      />
    </section>
  );
}

function EditDocumentModal({
  document,
  base,
  onClose,
  onSaved,
}: {
  document: RevenueDocument | null;
  base: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = React.useState<RevenueDocumentKind>("other");
  const [title, setTitle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    setKind(document?.kind ?? "other");
    setTitle(document?.title ?? "");
    setNotes(document?.notes ?? "");
    setUrl(document?.externalUrl ?? "");
    setError(null);
  }, [document]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!document) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${base}/documents/${document.id}`, {
        kind,
        title,
        notes,
        externalUrl: url.trim(),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open={document !== null} onClose={onClose} title="Edit document">
      <form onSubmit={submit} className="space-y-4">
        <Select
          label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as RevenueDocumentKind)}
        >
          {Object.entries(KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Input
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
        <Input
          label="External URL"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Textarea
          label="Notes"
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AddDocumentModal({
  open,
  onClose,
  base,
  resource,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  base: string;
  resource: Record<string, string>;
  onAdded: () => void;
}) {
  const [kind, setKind] = React.useState<RevenueDocumentKind>("proposal");
  const [title, setTitle] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [url, setUrl] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!file && !url.trim()) {
      setError("Choose a file or enter a URL");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const attachment = file
        ? await api.uploadFile<{ id: string }>(`${base}/documents/upload`, file)
        : null;
      await api.post(`${base}/documents`, {
        kind,
        title,
        notes,
        externalUrl: url.trim(),
        attachmentId: attachment?.id ?? null,
        ...resource,
      });
      setTitle("");
      setNotes("");
      setUrl("");
      setFile(null);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Link a document">
      <form onSubmit={submit} className="space-y-4">
        <Select
          label="Kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as RevenueDocumentKind)}
        >
          {Object.entries(KIND_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Input
          label="Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
        <Input
          label="External URL"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…"
        />
        <Input
          label="Or upload a file"
          type="file"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
        />
        <Textarea
          label="Notes"
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        {error && <FormError message={error} />}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Linking…" : "Link document"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
