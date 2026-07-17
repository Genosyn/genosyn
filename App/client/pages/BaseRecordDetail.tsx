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
  Loader2,
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
import { CellEditor, CellView } from "./BaseGridCells";
import { Avatar, employeeAvatarUrl, memberAvatarUrl } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
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
  const { toast } = useToast();
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
    try {
      await api.patch(baseUrl, { fieldId, value });
      await onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
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
  const { toast } = useToast();
  const dialog = useDialog();
  const [attachments, setAttachments] = React.useState<BaseRecordAttachment[] | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const loadAttachments = React.useCallback(async () => {
    try {
      const list = await api.get<BaseRecordAttachment[]>(`${baseUrl}/attachments`);
      setAttachments(list);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [baseUrl, toast]);

  React.useEffect(() => {
    void loadAttachments();
  }, [loadAttachments]);

  async function uploadFile(file: File) {
    if (file.size > 25 * 1024 * 1024) {
      toast("File exceeds the 25 MB upload cap", "error");
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
      toast((err as Error).message, "error");
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
    try {
      await api.del(`${baseUrl}/attachments/${a.id}`);
      await loadAttachments();
    } catch (err) {
      toast((err as Error).message, "error");
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
          variant="secondary"
          size="sm"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <>
              <Loader2 size={12} className="animate-spin" /> Uploading…
            </>
          ) : (
            <>
              <Paperclip size={12} /> Upload
            </>
          )}
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
      <div className="mt-2 space-y-1.5">
        {attachments === null ? (
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
  const { toast } = useToast();
  const dialog = useDialog();
  const [comments, setComments] = React.useState<BaseRecordComment[] | null>(null);
  const [commentDraft, setCommentDraft] = React.useState("");
  const [postingComment, setPostingComment] = React.useState(false);

  const loadComments = React.useCallback(async () => {
    try {
      const list = await api.get<BaseRecordComment[]>(`${baseUrl}/comments`);
      setComments(list);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }, [baseUrl, toast]);

  React.useEffect(() => {
    void loadComments();
  }, [loadComments]);

  async function postComment() {
    const text = commentDraft.trim();
    if (!text) return;
    setPostingComment(true);
    try {
      await api.post<BaseRecordComment>(`${baseUrl}/comments`, { body: text });
      setCommentDraft("");
      await loadComments();
    } catch (err) {
      toast((err as Error).message, "error");
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
    try {
      await api.del(`${baseUrl}/comments/${c.id}`);
      await loadComments();
    } catch (err) {
      toast((err as Error).message, "error");
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
        {comments === null ? (
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
              onDelete={() => void deleteComment(c)}
            />
          ))
        )}
      </div>

      <div className="mt-3 flex items-end gap-2">
        <textarea
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
          className="min-h-[38px] flex-1 resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        />
        <Button
          size="sm"
          disabled={postingComment || !commentDraft.trim()}
          onClick={() => void postComment()}
        >
          {postingComment ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Send size={12} />
          )}
          Send
        </Button>
      </div>
    </div>
  );
}

function CommentRow({
  company,
  comment,
  onDelete,
}: {
  company: Company;
  comment: BaseRecordComment;
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
    <div className="flex gap-3">
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
          <button
            onClick={onDelete}
            className="ml-auto rounded p-1 text-slate-300 opacity-0 transition hover:bg-red-50 hover:text-red-600 group-hover:opacity-100 dark:text-slate-600 dark:hover:bg-red-950/30"
            title="Delete"
          >
            <Trash2 size={11} />
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
  onDelete,
}: {
  company: Company;
  attachment: BaseRecordAttachment;
  downloadUrl: string;
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
      <button
        onClick={onDelete}
        className="rounded p-1 text-slate-300 transition hover:bg-red-50 hover:text-red-600 dark:text-slate-600 dark:hover:bg-red-950/30"
        title="Delete"
      >
        <Trash2 size={13} />
      </button>
      {/* keep eslint happy when company isn't otherwise referenced */}
      <span className="hidden">{company.id}</span>
    </div>
  );
}

function isImageIconType(mime: string): boolean {
  return mime.startsWith("image/");
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
