import React from "react";
import { AlertTriangle, Loader2, Send, Trash2, Users } from "lucide-react";
import { MailDraftSendPreview } from "../lib/mail";
import { Button } from "../components/ui/Button";
import { clsx } from "../components/ui/clsx";

/**
 * The gate in front of every batch action on the drafts queue.
 *
 * Sending mail cannot be undone, so a bare "Send 320 drafts?" is not enough to
 * consent to: the number says how much, never to whom. This dialog answers both
 * — the count, which Routines produced them, and a sample of the actual
 * addresses about to receive mail — and scales its friction with the blast
 * radius: past {@link ACK_THRESHOLD} the confirm button stays disabled until
 * the sender explicitly acknowledges the size and the mailbox it goes out from.
 */

/** Above this many drafts, require the typed-out acknowledgement. */
const ACK_THRESHOLD = 25;

export type BulkProgress = { done: number; total: number };

export function MailBulkSendDialog({
  action,
  preview,
  progress,
  onCancel,
  onConfirm,
}: {
  action: "send" | "discard";
  preview: MailDraftSendPreview;
  progress: BulkProgress | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [acknowledged, setAcknowledged] = React.useState(false);
  const running = progress !== null;

  // A new batch is a new decision. The dialog stays mounted when the selection
  // is replaced (cancel one, open another), and carrying a tick across would
  // let someone acknowledge "send 12" and unknowingly confirm "send 400".
  React.useEffect(() => {
    setAcknowledged(false);
  }, [preview]);
  const sending = action === "send";

  // Discarding never leaves the building, so only sending escalates. `truncated`
  // means the selection hit the server's resolve cap — the person is acting on
  // more than they can see, which deserves the same friction as a large batch.
  const count = sending ? preview.sendable : preview.total;
  const needsAck = sending && (count > ACK_THRESHOLD || preview.truncated);
  const blocked = running || count === 0 || (needsAck && !acknowledged);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, running]);

  const breakdown = preview.byRoutine.length > 0 ? preview.byRoutine : preview.byEmployee;
  const breakdownLabel = preview.byRoutine.length > 0 ? "By routine" : "By author";

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 p-4 dark:bg-black/60"
      onMouseDown={running ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-send-title"
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900"
      >
        <div className="flex items-start gap-3 px-5 py-4">
          <div
            className={clsx(
              "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
              sending
                ? "bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-400"
                : "bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400",
            )}
          >
            {sending ? <AlertTriangle size={18} /> : <Trash2 size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="bulk-send-title"
              className="text-base font-semibold text-slate-900 dark:text-slate-100"
            >
              {sending
                ? `Send ${count} ${count === 1 ? "draft" : "drafts"}?`
                : `Discard ${count} ${count === 1 ? "draft" : "drafts"}?`}
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              {sending ? (
                <>
                  This sends real email from{" "}
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {preview.accountAddress}
                  </span>
                  . It cannot be undone.
                </>
              ) : (
                <>
                  The drafts are deleted from this mailbox and from Gmail. This cannot be
                  undone.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-slate-100 px-5 py-4 dark:border-slate-800">
          {sending && preview.sampleRecipients.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                <Users size={13} /> Going to
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {preview.sampleRecipients.map((address) => (
                  <span
                    key={address}
                    className="max-w-full truncate rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                  >
                    {address}
                  </span>
                ))}
                {count > preview.sampleRecipients.length && (
                  <span className="px-1 py-1 text-xs text-slate-400 dark:text-slate-500">
                    and more…
                  </span>
                )}
              </div>
            </section>
          )}

          {breakdown.length > 0 && (
            <section>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                {breakdownLabel}
              </h3>
              <ul className="space-y-1">
                {breakdown.slice(0, 6).map((row) => (
                  <li
                    key={row.id ?? row.name}
                    className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300"
                  >
                    <span className="min-w-0 flex-1 truncate">{row.name}</span>
                    <span className="shrink-0 tabular-nums text-slate-400">{row.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {sending && preview.missingRecipient > 0 && (
            <p className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
              {preview.missingRecipient}{" "}
              {preview.missingRecipient === 1 ? "draft has" : "drafts have"} no recipient and will
              be skipped.
            </p>
          )}

          {needsAck && (
            <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={running}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-amber-300 text-indigo-600 focus:ring-indigo-500 dark:border-amber-500/50"
              />
              <span>
                I understand this sends {count} {count === 1 ? "email" : "emails"} via{" "}
                {preview.accountAddress}.
              </span>
            </label>
          )}

          {running && (
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
                <span>{sending ? "Sending…" : "Discarding…"}</span>
                <span className="tabular-nums">
                  {progress.done} of {progress.total}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                <div
                  className="h-full rounded-full bg-indigo-600 transition-[width] dark:bg-indigo-500"
                  style={{
                    width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-slate-100 bg-slate-50/70 px-5 py-3 dark:border-slate-800 dark:bg-slate-900/50">
          <Button size="sm" variant="secondary" disabled={running} onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={sending ? "primary" : "danger"}
            disabled={blocked}
            onClick={onConfirm}
          >
            {running ? (
              <Loader2 size={14} className="animate-spin" />
            ) : sending ? (
              <Send size={14} />
            ) : (
              <Trash2 size={14} />
            )}
            {sending ? `Send ${count}` : `Discard ${count}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
