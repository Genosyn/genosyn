import React from "react";
import { Link } from "react-router-dom";
import {
  X,
  MessageSquare,
  Paperclip,
  Trash2,
  Send,
  Image as ImageIcon,
  FileText,
  Download,
  User as UserIcon,
  Bot,
  Maximize2,
} from "lucide-react";
import {
  api,
  Base,
  BaseField,
  BaseLinkOption,
  BaseRecord,
  BaseRecordAttachment,
  BaseRecordComment,
  BaseResourceOption,
  BaseTable,
  Company,
} from "../lib/api";
import { errorMessage } from "../lib/errors";
import { CellEditor, CellView } from "./BaseGridCells";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { FormError } from "../components/ui/FormError";
import { useDialog } from "../components/ui/Dialog";
import { ButtonSpinner } from "../components/ui/Spinner";
import { clsx } from "../components/ui/clsx";

/**
 * Record detail surfaces. The slide-in drawer opens a Base record like a
 * form; the routed full page (BaseRecordPage.tsx) shows the same content
 * with room to breathe. Both compose the exported sections below —
 * RecordFieldsGrid, RecordFilesSection, RecordCommentsSection — so the two
 * surfaces can't drift apart.
 *
 * Nothing here mutates state directly — every action goes through the same
 * REST endpoints the inline grid uses, then reloads. That keeps the row
 * grid in BaseDetail.tsx authoritative.
 */

/** API base for one record's cell/comment/attachment endpoints. */
export function recordApiUrl(
  company: Company,
  base: Base,
  table: BaseTable,
  recordId: string,
): string {
  return `/api/companies/${company.id}/bases/${base.slug}/tables/${table.id}/rows/${recordId}`;
}

/** Client route of the full-page record view. */
export function recordPageUrl(
  company: Company,
  base: Base,
  table: BaseTable,
  recordId: string,
): string {
  return `/c/${company.slug}/bases/${base.slug}/${table.slug}/r/${recordId}`;
}

/** The record's display title — its primary field value. */
export function recordTitle(fields: BaseField[], record: BaseRecord): string {
  const primaryField = fields.find((f) => f.isPrimary) ?? fields[0];
  const raw = primaryField ? record.data[primaryField.id] : undefined;
  if (typeof raw === "string" && raw.trim()) return raw;
  if (typeof raw === "number") return String(raw);
  return "(untitled record)";
}

export function RecordDetailDrawer({
  company,
  base,
  table,
  record,
  fields,
  linkOptions,
  resourceOptions,
  onClose,
  onChanged,
}: {
  company: Company;
  base: Base;
  table: BaseTable;
  record: BaseRecord;
  fields: BaseField[];
  linkOptions: Record<string, BaseLinkOption[]>;
  resourceOptions: Record<string, BaseResourceOption[]>;
  onClose: () => void;
  /** Re-fetch the parent grid after a cell write so link labels stay fresh. */
  onChanged: () => Promise<void> | void;
}) {
  const [error, setError] = React.useState<string | null>(null);
  const baseUrl = recordApiUrl(company, base, table, record.id);

  // Close on Escape so the drawer feels like a modal.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function patchCell(fieldId: string, value: unknown) {
    setError(null);
    try {
      await api.patch(baseUrl, { fieldId, value });
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div
      onMouseDown={onClose}
      className="fixed inset-0 z-[60] flex justify-end bg-slate-900/40 dark:bg-black/60"
      aria-modal="true"
      role="dialog"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-[640px] flex-col border-l border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3 dark:border-slate-700">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-slate-400 dark:text-slate-500">
              {table.name}
            </div>
            <div className="truncate text-base font-semibold text-slate-900 dark:text-slate-100">
              {recordTitle(fields, record)}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link
              to={recordPageUrl(company, base, table, record.id)}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              title="Open full page"
            >
              <Maximize2 size={15} />
            </Link>
            <button
              onClick={onClose}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Body — scroll */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-4">
            <FormError message={error} className="mb-3" />
            <RecordFieldsGrid
              fields={fields}
              record={record}
              linkOptions={linkOptions}
              resourceOptions={resourceOptions}
              onPatchCell={patchCell}
            />
          </div>

          <div className="mx-5 border-t border-slate-100 dark:border-slate-800" />

          <div className="px-5 py-4">
            <RecordFilesSection company={company} baseUrl={baseUrl} />
          </div>

          <div className="mx-5 border-t border-slate-100 dark:border-slate-800" />

          <div className="px-5 py-4">
            <RecordCommentsSection company={company} baseUrl={baseUrl} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ───── Fields ────────────────────────────────────────────────────────────────

export function RecordFieldsGrid({
  fields,
  record,
  linkOptions,
  resourceOptions,
  onPatchCell,
}: {
  fields: BaseField[];
  record: BaseRecord;
  linkOptions: Record<string, BaseLinkOption[]>;
  resourceOptions: Record<string, BaseResourceOption[]>;
  onPatchCell: (fieldId: string, value: unknown) => Promise<void> | void;
}) {
  const [editingField, setEditingField] = React.useState<string | null>(null);

  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 gap-y-2">
      {fields.map((f) => {
        const editing = editingField === f.id;
        const value = record.data[f.id];
        return (
          <React.Fragment key={f.id}>
            <div className="flex items-center pt-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              {f.name}
            </div>
            <div
              className={clsx(
                "min-h-[36px] rounded-md border px-2 py-1.5 text-sm",
                editing
                  ? "border-indigo-300 ring-2 ring-indigo-100 dark:border-indigo-500 dark:ring-indigo-500/20"
                  : "border-transparent hover:border-slate-200 dark:hover:border-slate-700",
              )}
              onClick={() => {
                if (f.type === "checkbox") {
                  void onPatchCell(f.id, !value);
                  return;
                }
                if (!editing) setEditingField(f.id);
              }}
            >
              {editing && f.type !== "checkbox" ? (
                <CellEditor
                  field={f}
                  value={value}
                  linkOptionsByTable={linkOptions}
                  resourceOptions={resourceOptions}
                  autoFocus
                  onCommit={(next) => void onPatchCell(f.id, next)}
                  onClose={() => setEditingField(null)}
                />
              ) : (
                <CellView
                  field={f}
                  value={value}
                  linkOptionsByTable={linkOptions}
                  resourceOptions={resourceOptions}
                />
              )}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

// ───── Attachments ───────────────────────────────────────────────────────────

export function RecordFilesSection({
  company,
  baseUrl,
}: {
  company: Company;
  baseUrl: string;
}) {
  const dialog = useDialog();
  const [attachments, setAttachments] = React.useState<BaseRecordAttachment[] | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const uploadButtonRef = React.useRef<HTMLButtonElement>(null);
  const focusAfterDelete = useFocusAfterDelete(attachments, uploadButtonRef);

  const loadAttachments = React.useCallback(async () => {
    try {
      const list = await api.get<BaseRecordAttachment[]>(`${baseUrl}/attachments`);
      setAttachments(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the files"));
      setAttachments([]);
    }
  }, [baseUrl]);

  React.useEffect(() => {
    void loadAttachments();
  }, [loadAttachments]);

  async function uploadFile(file: File) {
    setUploadError(null);
    if (file.size > 25 * 1024 * 1024) {
      setUploadError("File exceeds the 25 MB upload cap");
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`${baseUrl}/attachments`, {
        method: "POST",
        credentials: "same-origin",
        body: fd,
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (!res.ok) {
        throw new Error((data && (data.error || data.message)) || res.statusText);
      }
      await loadAttachments();
    } catch (err) {
      setUploadError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  async function deleteAttachment(a: BaseRecordAttachment) {
    const ok = await dialog.confirm({
      title: `Delete "${a.filename}"?`,
      message: "The file is removed for everyone and cannot be recovered.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(a.id);
    try {
      await api.del(`${baseUrl}/attachments/${a.id}`);
      focusAfterDelete.rowDeleted(a.id);
      await loadAttachments();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the file" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <Paperclip size={12} /> Files
          {attachments && attachments.length > 0 && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {attachments.length}
            </span>
          )}
        </div>
        <Button
          ref={uploadButtonRef}
          variant="secondary"
          size="sm"
          loading={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <Paperclip size={12} /> {uploading ? "Uploading…" : "Upload"}
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadFile(f);
            e.target.value = "";
          }}
        />
      </div>
      <FormError message={uploadError} className="mt-2" />
      <div className="mt-2 space-y-1.5">
        {loadError ? (
          <FormError message={loadError} />
        ) : attachments === null ? (
          <div className="text-xs text-slate-400 dark:text-slate-500">Loading…</div>
        ) : attachments.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            No files yet. Drop a file with the Upload button above.
          </div>
        ) : (
          attachments.map((a) => (
            <AttachmentRow
              key={a.id}
              company={company}
              attachment={a}
              downloadUrl={`/api/companies/${company.id}/base-attachments/${a.id}`}
              deleteButtonRef={focusAfterDelete.deleteButtonRef(a.id)}
              deleting={deletingId === a.id}
              onDelete={() => void deleteAttachment(a)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ───── Comments ──────────────────────────────────────────────────────────────

export function RecordCommentsSection({
  company,
  baseUrl,
}: {
  company: Company;
  baseUrl: string;
}) {
  const dialog = useDialog();
  const [comments, setComments] = React.useState<BaseRecordComment[] | null>(null);
  const [commentDraft, setCommentDraft] = React.useState("");
  const [postingComment, setPostingComment] = React.useState(false);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [postError, setPostError] = React.useState<string | null>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const focusAfterDelete = useFocusAfterDelete(comments, composerRef);

  const loadComments = React.useCallback(async () => {
    try {
      const list = await api.get<BaseRecordComment[]>(`${baseUrl}/comments`);
      setComments(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the comments"));
      setComments([]);
    }
  }, [baseUrl]);

  React.useEffect(() => {
    void loadComments();
  }, [loadComments]);

  async function postComment() {
    const text = commentDraft.trim();
    if (!text) return;
    setPostingComment(true);
    setPostError(null);
    try {
      await api.post<BaseRecordComment>(`${baseUrl}/comments`, { body: text });
      setCommentDraft("");
      await loadComments();
    } catch (err) {
      setPostError(errorMessage(err));
    } finally {
      setPostingComment(false);
    }
  }

  async function deleteComment(c: BaseRecordComment) {
    const ok = await dialog.confirm({
      title: "Delete this comment?",
      message: "It will be removed for everyone.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (!ok) return;
    setDeletingId(c.id);
    try {
      await api.del(`${baseUrl}/comments/${c.id}`);
      focusAfterDelete.rowDeleted(c.id);
      await loadComments();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t delete the comment" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        <MessageSquare size={12} /> Comments
        {comments && comments.length > 0 && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {comments.length}
          </span>
        )}
      </div>
      <div className="mt-2 space-y-3">
        {loadError ? (
          <FormError message={loadError} />
        ) : comments === null ? (
          <div className="text-xs text-slate-400 dark:text-slate-500">Loading…</div>
        ) : comments.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-200 px-3 py-3 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
            No comments yet. Start the thread below.
          </div>
        ) : (
          comments.map((c) => (
            <CommentRow
              key={c.id}
              company={company}
              comment={c}
              deleteButtonRef={focusAfterDelete.deleteButtonRef(c.id)}
              deleting={deletingId === c.id}
              onDelete={() => void deleteComment(c)}
            />
          ))
        )}
      </div>

      <FormError message={postError} className="mt-3" />

      <div className="mt-3 flex items-end gap-2">
        <textarea
          ref={composerRef}
          value={commentDraft}
          onChange={(e) => setCommentDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void postComment();
            }
          }}
          placeholder="Add a comment… (⌘↵ to send)"
          rows={2}
          className="min-h-[38px] flex-1 resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-500/25"
        />
        <Button
          size="sm"
          loading={postingComment}
          disabled={!commentDraft.trim()}
          onClick={() => void postComment()}
        >
          <Send size={12} />
          Send
        </Button>
      </div>
    </div>
  );
}

function CommentRow({
  company,
  comment,
  deleteButtonRef,
  deleting,
  onDelete,
}: {
  company: Company;
  comment: BaseRecordComment;
  deleteButtonRef: React.Ref<HTMLButtonElement>;
  deleting: boolean;
  onDelete: () => void;
}) {
  const author = comment.author;
  const isAi = author?.kind === "ai";
  const avatarSrc =
    author?.kind === "human"
      ? memberAvatarUrl(company.id, author.id, author.avatarKey)
      : author?.kind === "ai"
        ? employeeAvatarUrl(company.id, author.id, author.avatarKey)
        : null;
  const name = author?.name ?? "Unknown";
  const when = new Date(comment.createdAt);

  return (
    <div className="group flex gap-3">
      <Avatar
        size="sm"
        name={name}
        src={avatarSrc}
        kind={isAi ? "ai" : "human"}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {name}
          </span>
          {isAi && (
            <span className="inline-flex items-center gap-0.5 rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">
              <Bot size={9} /> AI
            </span>
          )}
          <span className="text-[11px] text-slate-400 dark:text-slate-500">
            {when.toLocaleString([], {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
          {/* Revealed on row hover, on keyboard focus, while its delete is in
            flight (the pointer left the row for the confirm dialog), and
            always on touch screens, where there is no hover to reveal it. Busy
            rather than disabled while it runs: a disabled button drops focus,
            and this one holds it until the row it deletes is gone. */}
          <button
            ref={deleteButtonRef}
            onClick={deleting ? undefined : onDelete}
            aria-disabled={deleting || undefined}
            aria-busy={deleting || undefined}
            className="ml-auto rounded p-1 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-red-950/30 aria-busy:opacity-100 [@media(hover:none)]:opacity-100"
            title="Delete"
          >
            {deleting ? <ButtonSpinner size={11} /> : <Trash2 size={11} />}
          </button>
        </div>
        <div className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200">
          {comment.body}
        </div>
      </div>
    </div>
  );
}

function AttachmentRow({
  company,
  attachment,
  downloadUrl,
  deleteButtonRef,
  deleting,
  onDelete,
}: {
  company: Company;
  attachment: BaseRecordAttachment;
  downloadUrl: string;
  deleteButtonRef: React.Ref<HTMLButtonElement>;
  deleting: boolean;
  onDelete: () => void;
}) {
  const uploader = attachment.uploader;
  const isAi = uploader?.kind === "ai";
  const isImage = attachment.isImage;
  const sizeLabel = humanSize(attachment.sizeBytes);

  return (
    <div className="group flex items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded bg-slate-100 dark:bg-slate-800">
        {isImage ? (
          <img
            src={downloadUrl}
            alt=""
            className="h-9 w-9 rounded object-cover"
          />
        ) : isImageIconType(attachment.mimeType) ? (
          <ImageIcon size={14} className="text-slate-500 dark:text-slate-400" />
        ) : (
          <FileText size={14} className="text-slate-500 dark:text-slate-400" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <a
          href={downloadUrl}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-sm font-medium text-slate-900 hover:underline dark:text-slate-100"
        >
          {attachment.filename}
        </a>
        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
          <span>{sizeLabel}</span>
          <span>•</span>
          <span className="inline-flex items-center gap-0.5">
            {isAi ? <Bot size={10} /> : <UserIcon size={10} />}
            {uploader?.name ?? "Unknown"}
          </span>
        </div>
      </div>
      <a
        href={downloadUrl}
        target="_blank"
        rel="noreferrer"
        className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        title="Download"
      >
        <Download size={14} />
      </a>
      {/* Busy rather than disabled, like CommentRow's: it holds focus until
          the row it deletes is gone. */}
      <button
        ref={deleteButtonRef}
        onClick={deleting ? undefined : onDelete}
        aria-disabled={deleting || undefined}
        aria-busy={deleting || undefined}
        className="rounded p-1 text-slate-300 transition hover:bg-red-50 hover:text-red-600 dark:text-slate-600 dark:hover:bg-red-950/30"
        title="Delete"
      >
        {deleting ? <ButtonSpinner size={13} /> : <Trash2 size={13} />}
      </button>
      {/* keep eslint happy when company isn't otherwise referenced */}
      <span className="hidden">{company.id}</span>
    </div>
  );
}

// ───── Focus after a delete ──────────────────────────────────────────────────

/**
 * Keeps keyboard focus in a list when one of its rows is deleted. The row's
 * delete button holds focus while the request runs, but the reload after it
 * unmounts that button, and focus that goes down with a node lands on <body>:
 * the next Tab would start over at the top of the page, or in the page behind
 * the drawer. So once the row is gone, focus moves to the row that took its
 * place, else the one above it, else `emptyTarget`, the control that adds one.
 */
function useFocusAfterDelete(
  rows: { id: string }[] | null,
  emptyTarget: React.RefObject<HTMLElement>,
) {
  const deleteButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const successors = React.useRef<string[] | null>(null);

  // `rows` changing is the commit that took the deleted row off the page.
  React.useLayoutEffect(() => {
    const candidates = successors.current;
    if (!candidates) return;
    successors.current = null;
    // Wherever the person went while the delete ran, they stay.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const target =
      candidates.map((id) => deleteButtons.current.get(id)).find(Boolean) ?? emptyTarget.current;
    target?.focus();
  }, [rows, emptyTarget]);

  return {
    deleteButtonRef: (id: string) => (button: HTMLButtonElement | null) => {
      if (button) deleteButtons.current.set(id, button);
      else deleteButtons.current.delete(id);
    },
    /** Row `id` is deleted. Call before the reload that drops it from `rows`. */
    rowDeleted(id: string) {
      // Only focus that is on the row moves on with it: not after a click in a
      // browser that leaves buttons unfocused, nor once the person has moved.
      if (document.activeElement !== deleteButtons.current.get(id)) return;
      const ids = rows?.map((row) => row.id) ?? [];
      const index = ids.indexOf(id);
      successors.current = [ids[index + 1], ids[index - 1]].filter(
        (candidate): candidate is string => candidate !== undefined,
      );
    },
  };
}

function isImageIconType(mime: string): boolean {
  return mime.startsWith("image/");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
