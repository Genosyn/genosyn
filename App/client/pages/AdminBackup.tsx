import React from "react";
import { Download, RotateCcw, Trash2, Upload } from "lucide-react";
import { api, Backup, BackupFrequency, BackupSchedule } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";

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
  const [running, setRunning] = React.useState(false);
  const [savingSchedule, setSavingSchedule] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const [list, sched] = await Promise.all([
        api.get<Backup[]>("/api/backups"),
        api.get<BackupSchedule>("/api/backups/schedule"),
      ]);
      setRows(list);
      setSchedule(sched);
    } catch (err) {
      toast((err as Error).message, "error");
      setRows([]);
    }
  }, [toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const backupNow = async () => {
    setRunning(true);
    try {
      await api.post<Backup>("/api/backups");
      toast("Backup created", "success");
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
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
      toast("Backup uploaded", "success");
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
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
      toast("Restore complete — reloading", "success");
      setTimeout(() => window.location.reload(), 600);
    } catch (err) {
      toast((err as Error).message, "error");
      setRestoringId(null);
    }
  };

  return (
    <>
      <TopBar title="Backups" />
      <div className="flex flex-col gap-4">
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
                  disabled={uploading || running || restoringId !== null}
                >
                  <Upload size={12} />
                  {uploading ? "Uploading…" : "Upload backup"}
                </Button>
                <Button
                  size="sm"
                  onClick={backupNow}
                  disabled={running || uploading || restoringId !== null}
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
          onSave={async (patch) => {
            setSavingSchedule(true);
            try {
              const next = await api.put<BackupSchedule>(
                "/api/backups/schedule",
                patch,
              );
              setSchedule(next);
              toast("Schedule saved", "success");
            } catch (err) {
              toast((err as Error).message, "error");
            } finally {
              setSavingSchedule(false);
            }
          }}
        />

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
                  <li
                    key={b.id}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                          {b.filename}
                        </code>
                        <BackupStatusBadge status={b.status} kind={b.kind} />
                      </div>
                      <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                        {formatTimestamp(b.createdAt)} · {formatBytes(b.sizeBytes)}
                        {b.status === "failed" && b.errorMessage
                          ? ` · ${b.errorMessage}`
                          : ""}
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
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => restoreFrom(b)}
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
                        disabled={restoringId !== null}
                        onClick={async () => {
                          const ok = await dialog.confirm({
                            title: `Delete "${b.filename}"?`,
                            message: "The archive file will be removed from disk.",
                            confirmLabel: "Delete backup",
                            variant: "danger",
                          });
                          if (!ok) return;
                          try {
                            await api.del(`/api/backups/${b.id}`);
                            await reload();
                          } catch (err) {
                            toast((err as Error).message, "error");
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

function BackupStatusBadge({
  status,
  kind,
}: {
  status: Backup["status"];
  kind: Backup["kind"];
}) {
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

const DAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function ScheduleCard({
  schedule,
  saving,
  onSave,
}: {
  schedule: BackupSchedule | null;
  saving: boolean;
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
          Server-local time. Schedule fires in the background — the cron restarts
          automatically on boot.
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
              <select
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
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Hour of day
              </label>
              <select
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                value={draft.hour}
                onChange={(e) =>
                  setDraft({ ...draft, hour: parseInt(e.target.value, 10) })
                }
                disabled={!draft.enabled}
              >
                {Array.from({ length: 24 }).map((_, h) => (
                  <option key={h} value={h}>
                    {h.toString().padStart(2, "0")}:00
                  </option>
                ))}
              </select>
            </div>

            {draft.frequency === "weekly" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Day of week
                </label>
                <select
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
                  value={draft.dayOfWeek}
                  onChange={(e) =>
                    setDraft({ ...draft, dayOfWeek: parseInt(e.target.value, 10) })
                  }
                  disabled={!draft.enabled}
                >
                  {DAY_LABELS.map((d, i) => (
                    <option key={i} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {draft.frequency === "monthly" && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                  Day of month
                </label>
                <select
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
                </select>
              </div>
            )}
          </div>

          <div className="flex items-center justify-between pt-1 text-xs text-slate-500 dark:text-slate-400">
            <span>
              {schedule.lastRunAt
                ? `Last run: ${formatTimestamp(schedule.lastRunAt)}`
                : "No scheduled runs yet."}
            </span>
            <Button type="submit" size="sm" disabled={!dirty || saving}>
              {saving ? "Saving…" : "Save schedule"}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
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
