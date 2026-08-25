import React from "react";
import { Paperclip, X } from "lucide-react";
import { StagedAttachment, mailApi } from "../lib/mail";
import { errorMessage } from "../lib/errors";
import { Spinner } from "./ui/Spinner";
import { useDialog } from "./ui/Dialog";

/**
 * Outbound-attachment picker shared by the compose modal and the reply
 * composer. Files are uploaded (staged in memory server-side) as soon as
 * they're chosen; the returned tokens travel with the send/draft call. The
 * hook owns the list; `<AttachmentBar>` renders the button + chips.
 */
export function useMailAttachments(companyId: string, accountId: string) {
  const dialog = useDialog();
  const [items, setItems] = React.useState<StagedAttachment[]>([]);
  const [uploading, setUploading] = React.useState(0);

  const addFiles = React.useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      // The dialog holds one request at a time, so reporting from inside the
      // loop would leave only the last failure on screen. Collect them and
      // name every file that didn't make it in a single message.
      const failed: { name: string; error: unknown }[] = [];
      for (const file of list) {
        setUploading((n) => n + 1);
        try {
          const staged = await mailApi.uploadAttachment(companyId, accountId, file);
          setItems((prev) => [...prev, staged]);
        } catch (err) {
          failed.push({ name: file.name, error: err });
        } finally {
          setUploading((n) => n - 1);
        }
      }
      if (failed.length === 1) {
        const [only] = failed;
        void dialog.error(only.error, { title: `Couldn’t attach ${only.name}` });
      } else if (failed.length > 1) {
        void dialog.error(null, {
          title: `Couldn’t attach ${failed.length} files`,
          message: failed.map((f) => `${f.name}: ${errorMessage(f.error)}`).join("\n"),
        });
      }
    },
    [companyId, accountId, dialog],
  );

  const remove = React.useCallback((id: string) => {
    setItems((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const clear = React.useCallback(() => setItems([]), []);

  return {
    items,
    ids: items.map((a) => a.id),
    uploading: uploading > 0,
    addFiles,
    remove,
    clear,
  };
}

export function AttachmentBar({
  items,
  uploading,
  onAdd,
  onRemove,
}: {
  items: StagedAttachment[];
  uploading: boolean;
  onAdd: (files: FileList) => void;
  onRemove: (id: string) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
      >
        {uploading ? <Spinner size={12} /> : <Paperclip size={12} />} Attach
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) onAdd(e.target.files);
          e.target.value = "";
        }}
      />
      {items.map((a) => (
        <span
          key={a.id}
          className="flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1 text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300"
        >
          <span className="max-w-40 truncate">{a.filename}</span>
          <span className="text-slate-400">{formatBytes(a.size)}</span>
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            className="text-slate-400 hover:text-red-500"
            title="Remove"
          >
            <X size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
