import React from "react";
import { Select } from "@/components/ui/Select";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HardDrive,
  Network,
  Pencil,
  Plug,
  Plus,
  RotateCcw,
  Send,
  Server,
  Trash2,
  Upload,
  XCircle,
} from "lucide-react";
import {
  api,
  Backup,
  BackupDeliveryResult,
  BackupDestination,
  BackupDestinationKind,
  BackupFrequency,
  BackupSchedule,
  BackupVerification,
  SftpAuthMode,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { FormError } from "../components/ui/FormError";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { TopBar } from "../components/AppShell";
import { useDialog } from "../components/ui/Dialog";
import { errorMessage } from "../lib/errors";

const FIELD_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";

/** Well-known port per destination kind (`local` has no host, hence the 0). */
const DEFAULT_PORT: Record<BackupDestinationKind, number> = {
  local: 0,
  sftp: 22,
  smb: 445,
};

const portDefaultFor = (kind: BackupDestinationKind) => DEFAULT_PORT[kind];

/** Short badge label for a destination row. */
const KIND_LABEL: Record<BackupDestinationKind, string> = {
  local: "Path",
  sftp: "SFTP",
  smb: "SMB",
};

/**
 * Admin → Backups. Install-wide backup surface: a "Back up now" button that
 * zips the entire data directory into `<dataDir>/Backup/`, a recurring-schedule
 * form (daily / weekly / monthly + hour of day), and a list of past archives
 * with download / restore / delete actions. A backup covers every company's
 * data, so it lives under Admin rather than a single company's Settings.
 */
export function AdminBackup() {
  const [rows, setRows] = React.useState<Backup[] | null>(null);
  const [schedule, setSchedule] = React.useState<BackupSchedule | null>(null);
  const [destinations, setDestinations] = React.useState<BackupDestination[] | null>(null);
  /** undefined while loading; null before the first verification has run. */
  const [verification, setVerification] = React.useState<BackupVerification | null | undefined>(
    undefined,
  );
  const [verifying, setVerifying] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [savingSchedule, setSavingSchedule] = React.useState(false);
  const [savingRetention, setSavingRetention] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);
  const [sendingId, setSendingId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [scheduleError, setScheduleError] = React.useState<string | null>(null);
  const [retentionError, setRetentionError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const [list, sched, dests, last] = await Promise.all([
        api.get<Backup[]>("/api/backups"),
        api.get<BackupSchedule>("/api/backups/schedule"),
        api.get<BackupDestination[]>("/api/backup-destinations"),
        api.get<{ verification: BackupVerification | null }>("/api/backups/verification"),
      ]);
      setRows(list);
      setSchedule(sched);
      setDestinations(dests);
      setVerification(last.verification);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the backups"));
      setRows([]);
      setDestinations([]);
      setVerification(null);
    }
  }, []);

  const verifyNow = async () => {
    setVerifying(true);
    try {
      const result = await api.post<{ verification: BackupVerification }>(
        "/api/backups/verification",
      );
      setVerification(result.verification);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t verify the backups" });
    } finally {
      setVerifying(false);
    }
  };

  /**
   * Shared by both schedule cards — they PUT the same row. Saving enforces
   * retention server-side, so History has to be refetched whenever the save
   * reports that it deleted something.
   */
  const saveSchedule = React.useCallback(
    async (patch: Partial<BackupSchedule>): Promise<BackupSchedule> => {
      const next = await api.put<BackupSchedule>("/api/backups/schedule", patch);
      setSchedule(next);
      if (next.prunedNow) setRows(await api.get<Backup[]>("/api/backups"));
      return next;
    },
    [],
  );

  const sendToDestinations = async (b: Backup) => {
    setSendingId(b.id);
    try {
      const { results } = await api.post<{ results: BackupDeliveryResult[] }>(
        `/api/backups/${b.id}/deliver`,
      );
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        void dialog.error(
          `Sent to ${okCount}, failed ${failed.length}: ${failed
            .map((f) => `${f.destinationName} (${f.error ?? "error"})`)
            .join("; ")}`,
          { title: "Couldn’t send to every destination" },
        );
      } else if (okCount === 0) {
        void dialog.error("No enabled destinations to send to.", {
          title: "Couldn’t send the backup",
        });
      }
      await reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t send the backup" });
    } finally {
      setSendingId(null);
    }
  };

  React.useEffect(() => {
    reload();
  }, [reload]);

  const backupNow = async () => {
    setRunning(true);
    try {
      await api.post<Backup>("/api/backups");
      await reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t create the backup" });
    } finally {
      setRunning(false);
    }
  };

  const uploadArchive = async (file: File) => {
    setUploading(true);
    try {
      const res = await fetch("/api/backups/upload", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/zip" },
        body: file,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let msg = res.statusText;
        try {
          msg = JSON.parse(text).error ?? msg;
        } catch {
          if (text) msg = text;
        }
        throw new Error(msg);
      }
      await reload();
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t upload the backup" });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const restoreFrom = async (b: Backup) => {
    const ok = await dialog.confirm({
      title: `Restore from "${b.filename}"?`,
      message:
        "This replaces every file in the data directory with the contents of the archive. A pre-restore safety backup will be created first. You will be signed out when the restore completes.",
      confirmLabel: "Restore data",
      variant: "danger",
    });
    if (!ok) return;
    setRestoringId(b.id);
    try {
      await api.post(`/api/backups/${b.id}/restore`);
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      void dialog.error(err, { title: "Couldn’t restore from the backup" });
      setRestoringId(null);
    }
  };

  return (
    <>
      <TopBar title="Backups" />
      <div className="flex flex-col gap-4">
        <FormError message={loadError} />
        <OffBoxFailures destinations={destinations} />
        <VerificationCard
          verification={verification}
          verifying={verifying}
          onVerify={verifyNow}
        />

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">Manual backup</h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Zips the entire data directory into{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    data/Backup/
                  </code>
                  . Upload an existing{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    .zip
                  </code>{" "}
                  archive to restore from elsewhere.
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadArchive(f);
                  }}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => fileInputRef.current?.click()}
                  loading={uploading}
                  disabled={running || restoringId !== null}
                >
                  <Upload size={12} />
                  {uploading ? "Uploading…" : "Upload backup"}
                </Button>
                <Button
                  size="sm"
                  onClick={backupNow}
                  loading={running}
                  disabled={uploading || restoringId !== null}
                >
                  {running ? "Backing up…" : "Back up now"}
                </Button>
              </div>
            </div>
          </CardHeader>
        </Card>

        <ScheduleCard
          schedule={schedule}
          saving={savingSchedule}
          error={scheduleError}
          onSave={async (patch) => {
            setSavingSchedule(true);
            setScheduleError(null);
            try {
              await saveSchedule(patch);
            } catch (err) {
              setScheduleError(errorMessage(err));
            } finally {
              setSavingSchedule(false);
            }
          }}
        />

        <RetentionCard
          schedule={schedule}
          saving={savingRetention}
          error={retentionError}
          onSave={async (patch) => {
            setSavingRetention(true);
            setRetentionError(null);
            try {
              await saveSchedule(patch);
            } catch (err) {
              setRetentionError(errorMessage(err));
            } finally {
              setSavingRetention(false);
            }
          }}
        />

        <DestinationsCard destinations={destinations} onChanged={reload} />

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">History</h2>
          </CardHeader>
          <CardBody>
            {rows === null ? (
              <Spinner />
            ) : rows.length === 0 ? (
              <EmptyState
                title="No backups yet"
                description="Click “Back up now” above or enable a schedule to start archiving."
              />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                          {b.filename}
                        </code>
                        <BackupStatusBadge status={b.status} kind={b.kind} />
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {formatTimestamp(b.createdAt)} · {formatBytes(b.sizeBytes)}
                        {b.status === "failed" && b.errorMessage ? ` · ${b.errorMessage}` : ""}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {b.status === "completed" && (
                        <>
                          <a
                            href={`/api/backups/${b.id}/download`}
                            className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                          >
                            <Download size={12} /> Download
                          </a>
                          {destinations && destinations.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => sendToDestinations(b)}
                              loading={sendingId === b.id}
                              disabled={sendingId !== null || restoringId !== null}
                              title="Copy this archive to every enabled destination"
                            >
                              <Send size={12} />
                              {sendingId === b.id ? "Sending…" : "Send"}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => restoreFrom(b)}
                            loading={restoringId === b.id}
                            disabled={restoringId !== null || running || uploading}
                          >
                            <RotateCcw size={12} />
                            {restoringId === b.id ? "Restoring…" : "Restore"}
                          </Button>
                        </>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={deletingId === b.id}
                        disabled={restoringId !== null}
                        onClick={async () => {
                          const ok = await dialog.confirm({
                            title: `Delete "${b.filename}"?`,
                            message: "The archive file will be removed from disk.",
                            confirmLabel: "Delete backup",
                            variant: "danger",
                          });
                          if (!ok) return;
                          setDeletingId(b.id);
                          try {
                            await api.del(`/api/backups/${b.id}`);
                            await reload();
                          } catch (err) {
                            void dialog.error(err, { title: "Couldn’t delete the backup" });
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}

function DestinationsCard({
  destinations,
  onChanged,
}: {
  destinations: BackupDestination[] | null;
  onChanged: () => Promise<void>;
}) {
  const dialog = useDialog();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BackupDestination | null>(null);
  const [busy, setBusy] = React.useState<{
    id: string;
    action: "test" | "toggle" | "remove";
  } | null>(null);

  const openNew = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (d: BackupDestination) => {
    setEditing(d);
    setModalOpen(true);
  };

  const testOne = async (d: BackupDestination) => {
    setBusy({ id: d.id, action: "test" });
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/api/backup-destinations/${d.id}/test`,
      );
      if (!res.ok) {
        void dialog.error(res.message, { title: `Couldn’t reach "${d.name}"` });
      }
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t test "${d.name}"` });
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = async (d: BackupDestination) => {
    setBusy({ id: d.id, action: "toggle" });
    try {
      await api.put<BackupDestination>(`/api/backup-destinations/${d.id}`, {
        enabled: !d.enabled,
      });
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t update "${d.name}"` });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: BackupDestination) => {
    const ok = await dialog.confirm({
      title: `Remove "${d.name}"?`,
      message:
        "Backups already delivered there stay on the remote — this only stops future mirroring.",
      confirmLabel: "Remove destination",
      variant: "danger",
    });
    if (!ok) return;
    setBusy({ id: d.id, action: "remove" });
    try {
      await api.del(`/api/backup-destinations/${d.id}`);
      await onChanged();
    } catch (err) {
      void dialog.error(err, { title: `Couldn’t remove "${d.name}"` });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Off-box destinations</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Mirror every completed backup to a NAS path, an SFTP host, or an SMB share so a lost
              disk does not take the backups with it. Deliveries run automatically after each
              backup; use <span className="font-medium">Send</span> in History to push an existing
              archive on demand.
            </p>
          </div>
          <Button size="sm" onClick={openNew} className="shrink-0">
            <Plus size={12} /> Add destination
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {destinations === null ? (
          <Spinner />
        ) : destinations.length === 0 ? (
          <EmptyState
            title="No destinations yet"
            description="Add a mounted NAS path, an SFTP target, or an SMB share to store backups off this machine."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {destinations.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span className="mt-0.5 text-slate-400 dark:text-slate-500">
                    {d.kind === "local" ? (
                      <HardDrive size={16} />
                    ) : d.kind === "smb" ? (
                      <Network size={16} />
                    ) : (
                      <Server size={16} />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-slate-800 dark:text-slate-100">
                        {d.name}
                      </span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                        {KIND_LABEL[d.kind]}
                      </span>
                      {!d.enabled && (
                        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                          paused
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
                      {d.hint || "—"}
                    </div>
                    <DestinationHealth d={d} />
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <label
                    className="mr-1 inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
                    title="Auto-mirror new backups here"
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                      checked={d.enabled}
                      disabled={busy !== null}
                      onChange={() => toggleEnabled(d)}
                    />
                    Enabled
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => testOne(d)}
                    loading={busy?.id === d.id && busy.action === "test"}
                    disabled={busy !== null}
                  >
                    <Plug size={12} />
                    {busy?.id === d.id && busy.action === "test" ? "Testing…" : "Test"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(d)}
                    disabled={busy !== null}
                  >
                    <Pencil size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(d)}
                    loading={busy?.id === d.id && busy.action === "remove"}
                    disabled={busy !== null}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
      <DestinationModal
        open={modalOpen}
        editing={editing}
        onClose={() => setModalOpen(false)}
        onSaved={async () => {
          setModalOpen(false);
          await onChanged();
        }}
      />
    </Card>
  );
}

/** A destination backups aren't reaching: deliveries are failing, or its last connection test failed. */
function isFailing(d: BackupDestination): boolean {
  return d.enabled && (d.failingSince !== null || d.lastStatus === "error");
}

/**
 * Destinations backups aren't reaching, at the top of the page. A failing one
 * used to show only as a red line inside its own row, which is how an install
 * went weeks without a backup leaving the machine.
 */
function OffBoxFailures({ destinations }: { destinations: BackupDestination[] | null }) {
  const failing = (destinations ?? []).filter(isFailing);
  if (failing.length === 0) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-medium">
            {failing.length === 1
              ? `Backups aren’t reaching “${failing[0].name}”`
              : `Backups aren’t reaching ${failing.length} off-box destinations`}
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {failing.map((d) => (
              <li key={d.id} className="break-words">
                <span className="font-medium">{d.name}</span>
                {d.failingSince ? ` · failing since ${formatTimestamp(d.failingSince)}` : ""}
                {` · last copy ${d.lastSyncedAt ? formatTimestamp(d.lastSyncedAt) : "never"}`}
                {d.lastError ? ` · ${d.lastError}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-rose-700 dark:text-rose-300">
            Backups are still being taken on this server. This clears once a copy gets through —
            after fixing the destination, use <span className="font-medium">Send</span> on the
            newest backup in History. Master admins are emailed about it, at most once a day,
            through Admin → Email transport.
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * Daily backup verification: whether every backup the schedule and retention
 * policies promise is really there, on this server and on each destination.
 * Near the top because it answers the question the rest of the page can't —
 * could this install be restored today?
 */
function VerificationCard({
  verification,
  verifying,
  onVerify,
}: {
  verification: BackupVerification | null | undefined;
  verifying: boolean;
  onVerify: () => void;
}) {
  const problems = verification ? verification.areas.flatMap((area) => area.problems) : [];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Daily verification</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Each day, a few hours after the scheduled backup, Genosyn verifies that every
              scheduled backup ran, that the archives here open, and that the backups each
              retention policy keeps are still here and on every destination. Master admins are
              emailed about anything missing.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={onVerify}
            loading={verifying}
            className="shrink-0"
          >
            {verifying ? "Verifying…" : "Verify now"}
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {verification === undefined ? (
          <Spinner />
        ) : verification === null ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Not run yet. The first verification runs within the hour, or use Verify now.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p
              className={
                problems.length === 0
                  ? "inline-flex flex-wrap items-center gap-1.5 text-sm font-medium text-emerald-700 dark:text-emerald-400"
                  : "inline-flex flex-wrap items-center gap-1.5 text-sm font-medium text-rose-700 dark:text-rose-300"
              }
            >
              {problems.length === 0 ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
              {problems.length === 0
                ? "Every backup is in place"
                : problems.length === 1
                  ? "1 problem found"
                  : `${problems.length} problems found`}
              <span className="font-normal text-slate-400 dark:text-slate-500">
                · verified {formatTimestamp(verification.verifiedAt)}
              </span>
            </p>
            <ul className="flex flex-col gap-2">
              {verification.areas.map((area) => (
                <li key={area.id} className="text-xs">
                  <span className="font-medium text-slate-700 dark:text-slate-200">
                    {area.title}
                  </span>
                  <span className="text-slate-500 dark:text-slate-400"> · {area.summary}</span>
                  {area.problems.length > 0 && (
                    <ul className="mt-1 space-y-0.5 border-l-2 border-rose-200 pl-2.5 dark:border-rose-500/30">
                      {area.problems.map((problem) => (
                        <li
                          key={problem.key}
                          className={
                            problem.severity === "error"
                              ? "break-words text-rose-700 dark:text-rose-300"
                              : "break-words text-amber-700 dark:text-amber-300"
                          }
                        >
                          {problem.message}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function DestinationHealth({ d }: { d: BackupDestination }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {d.failingSince ? (
        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
          <XCircle size={12} /> Failing since {formatTimestamp(d.failingSince)}
        </span>
      ) : d.lastStatus === "ok" ? (
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 size={12} /> Healthy
        </span>
      ) : d.lastStatus === "error" ? (
        <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
          <XCircle size={12} /> Error
        </span>
      ) : (
        <span className="text-slate-400 dark:text-slate-500">Not tested yet</span>
      )}
      {d.lastSyncedAt ? (
        <span className="text-slate-400 dark:text-slate-500">
          · Last copy {formatTimestamp(d.lastSyncedAt)}
        </span>
      ) : d.lastCheckedAt ? (
        <span className="text-slate-400 dark:text-slate-500">
          · Last checked {formatTimestamp(d.lastCheckedAt)}
        </span>
      ) : null}
      {d.failingSince && d.lastAttemptAt && (
        <span className="text-slate-400 dark:text-slate-500">
          · Last attempt {formatTimestamp(d.lastAttemptAt)}
        </span>
      )}
      {d.configError && (
        <span className="text-rose-600 dark:text-rose-400">
          · Config could not be decrypted (was the encryption key rotated?)
        </span>
      )}
      {d.lastStatus === "error" && d.lastError && (
        <span className="text-rose-600 dark:text-rose-400">· {d.lastError}</span>
      )}
    </div>
  );
}

function DestinationModal({
  open,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: BackupDestination | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<BackupDestinationKind>("local");
  const [path, setPath] = React.useState("");
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState(DEFAULT_PORT.sftp);
  const [username, setUsername] = React.useState("");
  const [remoteDir, setRemoteDir] = React.useState("");
  const [authMode, setAuthMode] = React.useState<SftpAuthMode>("password");
  const [password, setPassword] = React.useState("");
  const [privateKey, setPrivateKey] = React.useState("");
  const [passphrase, setPassphrase] = React.useState("");
  const [share, setShare] = React.useState("");
  const [domain, setDomain] = React.useState("");
  const [encrypt, setEncrypt] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Re-seed the form whenever the modal opens for a new target.
  React.useEffect(() => {
    if (!open) return;
    const nextKind = editing?.kind ?? "local";
    setName(editing?.name ?? "");
    setKind(nextKind);
    setPath(editing?.path ?? "");
    setHost(editing?.host ?? "");
    setPort(editing?.port ?? portDefaultFor(nextKind));
    setUsername(editing?.username ?? "");
    setRemoteDir(editing?.remoteDir ?? "");
    setAuthMode(editing?.authMode ?? "password");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
    setShare(editing?.share ?? "");
    setDomain(editing?.domain ?? "");
    setEncrypt(editing?.encrypt ?? true);
    setError(null);
  }, [open, editing]);

  const isEdit = editing !== null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Only include secret fields when the operator actually typed one, so an
      // edit that leaves them blank keeps whatever is already stored.
      const payload: Record<string, unknown> = { name };
      if (kind === "local") {
        payload.path = path;
      } else if (kind === "smb") {
        payload.host = host;
        payload.port = port;
        payload.share = share;
        payload.remoteDir = remoteDir;
        payload.domain = domain;
        payload.username = username;
        payload.encrypt = encrypt;
        if (password) payload.password = password;
      } else {
        payload.host = host;
        payload.port = port;
        payload.username = username;
        payload.remoteDir = remoteDir;
        payload.authMode = authMode;
        if (authMode === "password") {
          if (password) payload.password = password;
        } else {
          if (privateKey) payload.privateKey = privateKey;
          if (passphrase) payload.passphrase = passphrase;
        }
      }
      if (isEdit) {
        await api.put(`/api/backup-destinations/${editing.id}`, payload);
      } else {
        payload.kind = kind;
        await api.post("/api/backup-destinations", payload);
      }
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? "Edit destination" : "Add destination"}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Name
          </label>
          <input
            className={FIELD_CLASS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Office NAS"
            required
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Type
          </label>
          <Select
            className={FIELD_CLASS}
            value={kind}
            disabled={isEdit}
            onChange={(e) => {
              const next = e.target.value as BackupDestinationKind;
              setKind(next);
              // Carry the operator to the new kind's well-known port rather
              // than leaving 22 sitting in an SMB form.
              setPort(portDefaultFor(next));
            }}
          >
            <option value="local">Mounted path (NAS / remote volume)</option>
            <option value="sftp">SFTP / SSH host</option>
            <option value="smb">SMB / CIFS share (no mount)</option>
          </Select>
          {isEdit && (
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Type can&apos;t be changed after creation.
            </p>
          )}
        </div>

        {kind === "local" ? (
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              Filesystem path
            </label>
            <input
              className={`${FIELD_CLASS} font-mono`}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/mnt/nas/genosyn-backups"
            />
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              Mount your NAS share (SMB / NFS) on the host or into the container first, then point
              here. The folder is created if missing. If you can&apos;t mount it, use the SMB type
              instead.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Host
                </label>
                <input
                  className={FIELD_CLASS}
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="nas.local"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Port
                </label>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  className={FIELD_CLASS}
                  value={port}
                  onChange={(e) => setPort(parseInt(e.target.value, 10) || portDefaultFor(kind))}
                />
              </div>
            </div>
            {kind === "smb" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      Share
                    </label>
                    <input
                      className={`${FIELD_CLASS} font-mono`}
                      value={share}
                      onChange={(e) => setShare(e.target.value)}
                      placeholder="backups"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      Folder in share (optional)
                    </label>
                    <input
                      className={`${FIELD_CLASS} font-mono`}
                      value={remoteDir}
                      onChange={(e) => setRemoteDir(e.target.value)}
                      placeholder="genosyn"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      Username
                    </label>
                    <input
                      className={FIELD_CLASS}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="backup"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      Domain / workgroup (optional)
                    </label>
                    <input
                      className={FIELD_CLASS}
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      placeholder="WORKGROUP"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Password
                  </label>
                  <input
                    type="password"
                    className={FIELD_CLASS}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing?.hasPassword ? "•••••• (unchanged)" : ""}
                    autoComplete="new-password"
                  />
                </div>
                <label className="flex cursor-pointer items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                    checked={encrypt}
                    onChange={(e) => setEncrypt(e.target.checked)}
                  />
                  <span>
                    Encrypt in transit
                    <span className="mt-0.5 block text-slate-400 dark:text-slate-500">
                      Uses SMB3 encryption so the archive isn&apos;t readable on your network. Turn
                      this off only if the NAS predates SMB3.
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      Username
                    </label>
                    <input
                      className={FIELD_CLASS}
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="backup"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      Remote directory
                    </label>
                    <input
                      className={`${FIELD_CLASS} font-mono`}
                      value={remoteDir}
                      onChange={(e) => setRemoteDir(e.target.value)}
                      placeholder="/volume1/genosyn"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    Authentication
                  </label>
                  <Select
                    className={FIELD_CLASS}
                    value={authMode}
                    onChange={(e) => setAuthMode(e.target.value as SftpAuthMode)}
                  >
                    <option value="password">Password</option>
                    <option value="key">Private key</option>
                  </Select>
                </div>
                {authMode === "password" ? (
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                      Password
                    </label>
                    <input
                      type="password"
                      className={FIELD_CLASS}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder={editing?.hasPassword ? "•••••• (unchanged)" : ""}
                      autoComplete="new-password"
                    />
                  </div>
                ) : (
                  <>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                        Private key (PEM)
                      </label>
                      <textarea
                        className={`${FIELD_CLASS} h-28 resize-y font-mono text-xs`}
                        value={privateKey}
                        onChange={(e) => setPrivateKey(e.target.value)}
                        placeholder={
                          editing?.hasPrivateKey
                            ? "Stored — leave blank to keep the current key"
                            : "-----BEGIN OPENSSH PRIVATE KEY-----"
                        }
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                        Key passphrase (optional)
                      </label>
                      <input
                        type="password"
                        className={FIELD_CLASS}
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        autoComplete="new-password"
                      />
                    </div>
                  </>
                )}
              </>
            )}
          </>
        )}

        <FormError message={error} />

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add destination"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function BackupStatusBadge({ status, kind }: { status: Backup["status"]; kind: Backup["kind"] }) {
  const statusClass =
    status === "completed"
      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
      : status === "running"
        ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300"
        : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300";
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span className={`rounded px-1.5 py-0.5 ${statusClass}`}>{status}</span>
      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        {kind}
      </span>
    </span>
  );
}

const DAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function ScheduleCard({
  schedule,
  saving,
  error,
  onSave,
}: {
  schedule: BackupSchedule | null;
  saving: boolean;
  error: string | null;
  onSave: (patch: Partial<BackupSchedule>) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState<BackupSchedule | null>(schedule);

  React.useEffect(() => {
    setDraft(schedule);
  }, [schedule]);

  if (!draft || !schedule) {
    return (
      <Card>
        <CardBody>
          <Spinner />
        </CardBody>
      </Card>
    );
  }

  const dirty =
    draft.enabled !== schedule.enabled ||
    draft.frequency !== schedule.frequency ||
    draft.hour !== schedule.hour ||
    draft.dayOfWeek !== schedule.dayOfWeek ||
    draft.dayOfMonth !== schedule.dayOfMonth;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Recurring backup</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Server-local time. Schedule fires in the background — the cron restarts automatically on
          boot.
        </p>
      </CardHeader>
      <CardBody>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!dirty) return;
            await onSave({
              enabled: draft.enabled,
              frequency: draft.frequency,
              hour: draft.hour,
              dayOfWeek: draft.dayOfWeek,
              dayOfMonth: draft.dayOfMonth,
            });
          }}
        >
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
              checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            <span className="font-medium">Enable scheduled backups</span>
          </label>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Frequency
              </label>
              <Select
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                value={draft.frequency}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    frequency: e.target.value as BackupFrequency,
                  })
                }
                disabled={!draft.enabled}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </Select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Hour of day
              </label>
              <Select
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                value={draft.hour}
                onChange={(e) => setDraft({ ...draft, hour: parseInt(e.target.value, 10) })}
                disabled={!draft.enabled}
              >
                {Array.from({ length: 24 }).map((_, h) => (
                  <option key={h} value={h}>
                    {h.toString().padStart(2, "0")}:00
                  </option>
                ))}
              </Select>
            </div>

            {draft.frequency === "weekly" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Day of week
                </label>
                <Select
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                  value={draft.dayOfWeek}
                  onChange={(e) => setDraft({ ...draft, dayOfWeek: parseInt(e.target.value, 10) })}
                  disabled={!draft.enabled}
                >
                  {DAY_LABELS.map((d, i) => (
                    <option key={i} value={i}>
                      {d}
                    </option>
                  ))}
                </Select>
              </div>
            )}

            {draft.frequency === "monthly" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Day of month
                </label>
                <Select
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                  value={draft.dayOfMonth}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      dayOfMonth: parseInt(e.target.value, 10),
                    })
                  }
                  disabled={!draft.enabled}
                >
                  {Array.from({ length: 28 }).map((_, i) => (
                    <option key={i} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>

          <FormError message={error} />

          <div className="flex items-center justify-between pt-1 text-xs text-slate-500 dark:text-slate-400">
            <span>
              {schedule.lastRunAt
                ? `Last run: ${formatTimestamp(schedule.lastRunAt)}`
                : "No scheduled runs yet."}
            </span>
            <Button type="submit" size="sm" loading={saving} disabled={!dirty}>
              {saving ? "Saving…" : "Save schedule"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

/**
 * Retention: one policy for archives on this server and one for copies on
 * off-box destinations, because the two stores have different room — a NAS
 * usually keeps far more history than the server's disk. Deliberately its own
 * card rather than a row inside {@link ScheduleCard}: archives pile up whether
 * or not the recurring backup is on, so the toggles are independent — the copy
 * has to say so, because "delete old backups" sitting under "recurring backup"
 * reads like it only covers scheduled ones.
 */
function RetentionCard({
  schedule,
  saving,
  error,
  onSave,
}: {
  schedule: BackupSchedule | null;
  saving: boolean;
  error: string | null;
  onSave: (patch: Partial<BackupSchedule>) => Promise<void>;
}) {
  const [draft, setDraft] = React.useState<BackupSchedule | null>(schedule);

  React.useEffect(() => {
    setDraft(schedule);
  }, [schedule]);

  if (!draft || !schedule) {
    return (
      <Card>
        <CardBody>
          <Spinner />
        </CardBody>
      </Card>
    );
  }

  const dirty =
    draft.retentionEnabled !== schedule.retentionEnabled ||
    draft.retentionDays !== schedule.retentionDays ||
    draft.offBoxRetentionEnabled !== schedule.offBoxRetentionEnabled ||
    draft.offBoxRetentionDays !== schedule.offBoxRetentionDays;

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Retention</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Delete archives once they pass a certain age, separately on this server and on off-box
          destinations, so neither fills up.
        </p>
      </CardHeader>
      <CardBody>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!dirty) return;
            await onSave({
              retentionEnabled: draft.retentionEnabled,
              retentionDays: draft.retentionDays,
              offBoxRetentionEnabled: draft.offBoxRetentionEnabled,
              offBoxRetentionDays: draft.offBoxRetentionDays,
            });
          }}
        >
          <RetentionPolicy
            title="On this server"
            enabled={draft.retentionEnabled}
            days={draft.retentionDays}
            onChange={(enabled, days) =>
              setDraft({ ...draft, retentionEnabled: enabled, retentionDays: days })
            }
            note="Covers every archive in the backup folder — including ones you made by hand — even when the recurring backup above is off. Applied hourly, and again after every backup. The newest completed archive is always kept, however old it is, and archives you uploaded here are never deleted."
          />
          <RetentionPolicy
            title="On off-box destinations"
            enabled={draft.offBoxRetentionEnabled}
            days={draft.offBoxRetentionDays}
            onChange={(enabled, days) =>
              setDraft({ ...draft, offBoxRetentionEnabled: enabled, offBoxRetentionDays: days })
            }
            note="Applied to each destination every time a backup is copied there, and the copy just made is always kept. Only archives Genosyn delivered (backup-….zip) and partial copies of them are deleted; anything else in the folder is left alone."
          />

          <FormError message={error} />

          <div className="flex items-center justify-between gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span>
              {`This server: ${retentionSummary(schedule.retentionEnabled, schedule.retentionDays)}. Off-box: ${retentionSummary(schedule.offBoxRetentionEnabled, schedule.offBoxRetentionDays)}.`}
            </span>
            <Button type="submit" size="sm" loading={saving} disabled={!dirty} className="shrink-0">
              {saving ? "Saving…" : "Save retention"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function retentionSummary(enabled: boolean, days: number): string {
  return enabled
    ? `archives older than ${days} day${days === 1 ? "" : "s"} are deleted`
    : "archives are kept until you delete them";
}

/** One retention policy: a toggle and the age past which archives go. */
function RetentionPolicy({
  title,
  enabled,
  days,
  onChange,
  note,
}: {
  title: string;
  enabled: boolean;
  days: number;
  onChange: (enabled: boolean, days: number) => void;
  note: string;
}) {
  const daysId = React.useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </legend>
      <label className="inline-flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked, days)}
        />
        <span className="font-medium">Automatically delete old backups</span>
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label
            htmlFor={daysId}
            className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300"
          >
            Delete after
          </label>
          <div className="flex items-center gap-2">
            <input
              id={daysId}
              type="number"
              min={1}
              max={3650}
              className={FIELD_CLASS}
              value={days}
              onChange={(e) => onChange(enabled, parseInt(e.target.value, 10) || 30)}
              disabled={!enabled}
            />
            <span className="text-sm text-slate-500 dark:text-slate-400">days</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500">{note}</p>
    </fieldset>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
