import React from "react";
import { FileText, X } from "lucide-react";
import type { StagedChatAttachment } from "../../lib/stagedChatAttachments";

/** The same image preview and removable tray on every AI conversation. */
export function ChatAttachments({
  attachments,
  urlFor,
  onRemove,
}: {
  attachments: StagedChatAttachment[];
  urlFor: (id: string) => string;
  onRemove?: (id: string) => void;
}) {
  if (!attachments.length) return null;
  return (
    <div className="my-2 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="relative max-w-44 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900"
        >
          <a
            href={attachment.previewUrl ?? urlFor(attachment.id)}
            target="_blank"
            rel="noreferrer"
            className="block"
          >
            {attachment.isImage ? (
              <img
                src={attachment.previewUrl ?? urlFor(attachment.id)}
                alt={attachment.filename}
                className="h-24 w-36 object-contain"
              />
            ) : (
              <FileText size={20} className="m-3 text-slate-400" />
            )}
            <span
              className="block truncate px-2 py-1 text-xs text-slate-600 dark:text-slate-300"
              title={attachment.filename}
            >
              {attachment.filename}
            </span>
          </a>
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(attachment.id)}
              aria-label={`Remove ${attachment.filename}`}
              className="absolute right-1 top-1 rounded-full bg-white p-1 text-slate-500 shadow-sm hover:text-rose-600 dark:bg-slate-800"
            >
              <X size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
