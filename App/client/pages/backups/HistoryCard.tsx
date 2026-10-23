import React from "react";
import { Button, buttonClassName } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { MenuItem } from "@/components/ui/Menu";
import { Download, RefreshCw, RotateCcw, Send, Trash2 } from "lucide-react";
import {
  api,
  type BackupCopiesStarted,
  type BackupDestination,
  type BackupHistoryItem,
} from "@/lib/api";
import {
  copyViews,
  formatBytes,
  formatWhen,
  KIND_HINT,
  KIND_LABEL,
  locationSentence,
  plainReason,
  serverPlace,
  type CopyView,
  type Tone,
} from "@/lib/backupStatus";
import { errorMessage } from "@/lib/errors";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Spinner } from "@/components/ui/Spinner";
import { clsx } from "@/components/ui/clsx";
import { TONE_CHIP, ToneIcon, RowMenu, SectionError, TechnicalDetail } from "./ui";

/** Admin → Backups: every backup, and where each one lives. */

/** History rows shown before "Show all". */
const HISTORY_PREVIEW = 10;

type RowBusy = "restore" | "delete" | `copy:${string}`;

export function HistoryCard({
  rows,
  error,
  onRetry,
  destinations,
  onChanged,
  onCopy,
  now,
}: {
  rows: BackupHistoryItem[] | null;
  error: string | null;
  onRetry: () => void;
  destinations: BackupDestination[] | null;
  onChanged: () => Promise<void>;
  onCopy: (backup: BackupHistoryItem, destinationId?: string) => Promise<BackupCopiesStarted>;
  now: Date;
}) {
  const dialog = useDialog();
  const [showAll, setShowAll] = React.useState(false);
  const [busy, setBusy] = React.useState<Record<string, RowBusy | undefined>>({});
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [notes, setNotes] = React.useState<Record<string, string | undefined>>({});
  const restoring = Object.values(busy).includes("restore");
  const enabledDestinations = (destinations ?? []).filter((dest) => dest.enabled);

  const act = async (backup: BackupHistoryItem, action: RowBusy, work: () => Promise<void>) => {
    setBusy((current) => ({ ...current, [backup.id]: action }));
    setErrors((current) => ({ ...current, [backup.id]: undefined }));
    setNotes((current) => ({ ...current, [backup.id]: undefined }));
    try {
      await work();
    } catch (err) {
      setErrors((current) => ({ ...current, [backup.id]: errorMessage(err) }));
    } finally {
      setBusy((current) => ({ ...current, [backup.id]: undefined }));
    }
  };

  const restore = async (backup: BackupHistoryItem) => {
    const ok = await dialog.confirm({
      title: `Restore the backup from ${formatWhen(backup.createdAt, now)}?`,
      message:
        "Everything on this install is replaced with what was in this backup: every company's data, files and settings. Genosyn backs up what is here now first, so this can be undone. Everyone is signed out when it finishes.",
      confirmLabel: "Restore this backup",
      variant: "danger",
    });
    if (!ok) return;
    await act(backup, "restore", async () => {
      await api.post(`/api/backups/${backup.id}/restore`);
      window.setTimeout(() => window.location.reload(), 600);
    });
  };

  const remove = async (backup: BackupHistoryItem) => {
    const copies = backup.copies.filter((copy) => copy.status === "copied").length;
    const ok = await dialog.confirm({
      title: `Delete the backup from ${formatWhen(backup.createdAt, now)}?`,
      message:
        copies > 0
          ? "It is deleted from this server and from History. Its copies on off-box destinations stay there until off-box retention removes them."
          : "It is deleted from this server and from History.",
      confirmLabel: "Delete backup",
      variant: "danger",
    });
    if (!ok) return;
    await act(backup, "delete", async () => {
      await api.del(`/api/backups/${backup.id}`);
      await onChanged();
    });
  };

  const copy = (backup: BackupHistoryItem, destinationId?: string) =>
    act(backup, `copy:${destinationId ?? "all"}`, async () => {
      const result = await onCopy(backup, destinationId);
      if (result.alreadyRunning) {
        setNotes((current) => ({
          ...current,
          [backup.id]: "This backup is already being copied off-box.",
        }));
      }
    });

  const visible = rows ? (showAll ? rows : rows.slice(0, HISTORY_PREVIEW)) : [];
  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">History</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Every backup, newest first, and where each one is: on this server, on your off-box
          destinations, or both.
        </p>
      </CardHeader>
      <CardBody>
        {rows === null ? (
          error ? (
            <SectionError message={error} onRetry={onRetry} />
          ) : (
            <Spinner />
          )
        ) : rows.length === 0 ? (
          <EmptyState
            title="No backups yet"
            description="Press Back up now at the top of the page, or turn on automatic backups."
          />
        ) : (
          <>
            {error && <FormError message={error} className="mb-3" />}
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {visible.map((backup) => (
                <HistoryRow
                  key={backup.id}
                  backup={backup}
                  destinations={destinations}
                  canCopy={enabledDestinations.length > 0}
                  now={now}
                  busy={busy[backup.id]}
                  locked={restoring}
                  error={errors[backup.id]}
                  note={notes[backup.id]}
                  onRestore={() => void restore(backup)}
                  onDelete={() => void remove(backup)}
                  onCopy={(destinationId) => void copy(backup, destinationId)}
                />
              ))}
            </ul>
            {rows.length > HISTORY_PREVIEW && (
              <div className="mt-3">
                <Button size="sm" variant="ghost" onClick={() => setShowAll(!showAll)}>
                  {showAll ? "Show fewer" : `Show all ${rows.length} backups`}
                </Button>
              </div>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Place({
  tone,
  children,
  title,
}: {
  tone: Tone;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <li
      title={title}
      className={clsx(
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        TONE_CHIP[tone],
      )}
    >
      <ToneIcon tone={tone} size={12} />
      <span className="min-w-0 truncate">{children}</span>
    </li>
  );
}

function HistoryRow({
  backup,
  destinations,
  canCopy,
  now,
  busy,
  locked,
  error,
  note,
  onRestore,
  onDelete,
  onCopy,
}: {
  backup: BackupHistoryItem;
  destinations: BackupDestination[] | null;
  canCopy: boolean;
  now: Date;
  busy: RowBusy | undefined;
  /** A restore is starting: nothing else may run. */
  locked: boolean;
  error: string | undefined;
  note: string | undefined;
  onRestore: () => void;
  onDelete: () => void;
  onCopy: (destinationId?: string) => void;
}) {
  const server = serverPlace(backup);
  const copies: CopyView[] = destinations ? copyViews(backup, destinations, now) : [];
  // Until the destinations load, their names can't be given: say only what is known.
  const sentence = destinations ? locationSentence(backup, copies) : null;
  const moving = backup.copies.some(
    (copy) => copy.status === "pending" || copy.status === "copying",
  );
  const restorable = backup.status === "completed" && backup.onServer;
  const problems = copies.filter((copy) => copy.state === "failed" || copy.state === "missing");
  // Only on this server, and never sent anywhere: copying it off-box belongs
  // right under the line that says so.
  const onlyHere =
    restorable &&
    canCopy &&
    !moving &&
    copies.length > 0 &&
    copies.every((copy) => copy.state === "not-copied");
  const failure = backup.status === "failed" ? plainReason(backup.errorMessage, "server") : null;
  const disabled = busy !== undefined || locked;
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {formatWhen(backup.createdAt, now)}
            </span>
            <span
              className="text-xs text-slate-500 dark:text-slate-400"
              title={KIND_HINT[backup.kind]}
            >
              {KIND_LABEL[backup.kind]}
            </span>
            {backup.status === "completed" && (
              <span className="text-xs tabular-nums text-slate-500 dark:text-slate-400">
                {formatBytes(backup.sizeBytes)}
              </span>
            )}
          </div>
          {sentence && (
            <p className="mt-0.5 break-words text-sm text-slate-600 dark:text-slate-300">
              {sentence}
            </p>
          )}
          <TechnicalDetail detail={failure?.technical} className="mt-1" />
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Where this backup is">
            <Place tone={server.tone}>{server.label}</Place>
            {copies.map((copy) => (
              <Place key={copy.destinationId} tone={copy.tone} title={copy.detail ?? undefined}>
                {copy.label}
              </Place>
            ))}
          </ul>
          {onlyHere && (
            <div className="mt-2">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 px-2 text-xs"
                onClick={() => onCopy()}
                loading={busy === "copy:all"}
                disabled={disabled}
              >
                <Send size={12} />
                Copy off-box now
              </Button>
            </div>
          )}
          {problems.map((copy) => (
            <div key={copy.destinationId} className="mt-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-rose-700 dark:text-rose-300">
                <span className="min-w-0 break-words">
                  <span className="font-medium">{copy.name}:</span>{" "}
                  {copy.detail ?? "The copy isn't there."}
                </span>
                {copy.canRetry && !moving && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => onCopy(copy.destinationId)}
                    loading={busy === `copy:${copy.destinationId}`}
                    disabled={disabled}
                  >
                    <RefreshCw size={12} />
                    Try again
                  </Button>
                )}
              </div>
              <TechnicalDetail detail={copy.technical} className="mt-0.5" />
            </div>
          ))}
          <FormError message={error} className="mt-2" />
          <FormSuccess message={note} className="mt-2" />
        </div>
        <div className="flex shrink-0 items-center gap-1 self-start">
          {restorable && (
            <>
              <a
                href={`/api/backups/${backup.id}/download`}
                className={buttonClassName({ variant: "ghost", size: "sm" })}
              >
                <Download size={12} />
                Download
              </a>
              <Button
                size="sm"
                variant="ghost"
                onClick={onRestore}
                loading={busy === "restore"}
                disabled={disabled}
              >
                <RotateCcw size={12} />
                {busy === "restore" ? "Restoring…" : "Restore"}
              </Button>
            </>
          )}
          <RowMenu
            label={`More for the backup from ${formatWhen(backup.createdAt, now)}`}
            loading={busy === "delete" || busy === "copy:all"}
            disabled={disabled}
          >
            {(close) => (
              <>
                {restorable && canCopy && !moving && (
                  <MenuItem
                    icon={<Send size={14} />}
                    label="Copy off-box now"
                    onSelect={() => {
                      close();
                      onCopy();
                    }}
                  />
                )}
                {!backup.inProgress && (
                  <MenuItem
                    icon={<Trash2 size={14} />}
                    label="Delete backup"
                    className="text-rose-700 dark:text-rose-300"
                    onSelect={() => {
                      close();
                      onDelete();
                    }}
                  />
                )}
                {backup.inProgress && (
                  <p className="px-2 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                    Nothing to do until it finishes.
                  </p>
                )}
              </>
            )}
          </RowMenu>
        </div>
      </div>
    </li>
  );
}
