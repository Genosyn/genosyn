import React from "react";
import {
  CheckCircle2,
  Download,
  HardDrive,
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
  SftpAuthMode,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import { Spinner } from "../components/ui/Spinner";
import { EmptyState } from "../components/ui/EmptyState";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";

const FIELD_CLASS =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900";

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
  const [destinations, setDestinations] = React.useState<
    BackupDestination[] | null
  >(null);
  const [running, setRunning] = React.useState(false);
  const [savingSchedule, setSavingSchedule] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [restoringId, setRestoringId] = React.useState<string | null>(null);
  const [sendingId, setSendingId] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const [list, sched, dests] = await Promise.all([
        api.get<Backup[]>("/api/backups"),
        api.get<BackupSchedule>("/api/backups/schedule"),
        api.get<BackupDestination[]>("/api/backup-destinations"),
      ]);
      setRows(list);
      setSchedule(sched);
      setDestinations(dests);
    } catch (err) {
      toast((err as Error).message, "error");
      setRows([]);
      setDestinations([]);
    }
  }, [toast]);

  const sendToDestinations = async (b: Backup) => {
    setSendingId(b.id);
    try {
      const { results } = await api.post<{ results: BackupDeliveryResult[] }>(
        `/api/backups/${b.id}/deliver`,
      );
      const okCount = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        toast(
          okCount === 0
            ? "No enabled destinations to send to"
            : `Sent to ${okCount} destination${okCount === 1 ? "" : "s"}`,
          okCount === 0 ? "info" : "success",
        );
      } else {
        toast(
          `Sent to ${okCount}, failed ${failed.length}: ${failed
            .map((f) => `${f.destinationName} (${f.error ?? "error"})`)
            .join("; ")}`,
          "error",
        );
      }
      await reload();
    } catch (err) {
      toast((err as Error).message, "error");
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
                          {destinations && destinations.length > 0 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => sendToDestinations(b)}
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

function DestinationsCard({
  destinations,
  onChanged,
}: {
  destinations: BackupDestination[] | null;
  onChanged: () => Promise<void>;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<BackupDestination | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const openNew = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (d: BackupDestination) => {
    setEditing(d);
    setModalOpen(true);
  };

  const testOne = async (d: BackupDestination) => {
    setBusyId(d.id);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/api/backup-destinations/${d.id}/test`,
      );
      toast(res.message, res.ok ? "success" : "error");
      await onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  };

  const toggleEnabled = async (d: BackupDestination) => {
    setBusyId(d.id);
    try {
      await api.put<BackupDestination>(`/api/backup-destinations/${d.id}`, {
        enabled: !d.enabled,
      });
      await onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
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
    setBusyId(d.id);
    try {
      await api.del(`/api/backup-destinations/${d.id}`);
      await onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Off-box destinations</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Mirror every completed backup to a NAS path or an SFTP host so a
              lost disk does not take the backups with it. Deliveries run
              automatically after each backup; use{" "}
              <span className="font-medium">Send</span> in History to push an
              existing archive on demand.
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
            description="Add a mounted NAS path or an SFTP target to store backups off this machine."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {destinations.map((d) => (
              <li
                key={d.id}
                className="flex items-center justify-between gap-3 py-2.5 text-sm"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  <span className="mt-0.5 text-slate-400 dark:text-slate-500">
                    {d.kind === "local" ? (
                      <HardDrive size={16} />
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
                        {d.kind === "local" ? "Path" : "SFTP"}
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
                      disabled={busyId !== null}
                      onChange={() => toggleEnabled(d)}
                    />
                    Enabled
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => testOne(d)}
                    disabled={busyId !== null}
                  >
                    <Plug size={12} />
                    {busyId === d.id ? "Testing…" : "Test"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(d)}
                    disabled={busyId !== null}
                  >
                    <Pencil size={12} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(d)}
                    disabled={busyId !== null}
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

function DestinationHealth({ d }: { d: BackupDestination }) {
  const when = d.lastSyncedAt ?? d.lastCheckedAt;
  const label = d.lastSyncedAt ? "Last synced" : "Last checked";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {d.lastStatus === "ok" ? (
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
      {when && (
        <span className="text-slate-400 dark:text-slate-500">
          · {label} {formatTimestamp(when)}
        </span>
      )}
      {d.configError && (
        <span className="text-rose-600 dark:text-rose-400">
          · Config could not be decrypted (was sessionSecret rotated?)
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
  const { toast } = useToast();
  const [name, setName] = React.useState("");
  const [kind, setKind] = React.useState<BackupDestinationKind>("local");
  const [path, setPath] = React.useState("");
  const [host, setHost] = React.useState("");
  const [port, setPort] = React.useState(22);
  const [username, setUsername] = React.useState("");
  const [remoteDir, setRemoteDir] = React.useState("");
  const [authMode, setAuthMode] = React.useState<SftpAuthMode>("password");
  const [password, setPassword] = React.useState("");
  const [privateKey, setPrivateKey] = React.useState("");
  const [passphrase, setPassphrase] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  // Re-seed the form whenever the modal opens for a new target.
  React.useEffect(() => {
    if (!open) return;
    setName(editing?.name ?? "");
    setKind(editing?.kind ?? "local");
    setPath(editing?.path ?? "");
    setHost(editing?.host ?? "");
    setPort(editing?.port ?? 22);
    setUsername(editing?.username ?? "");
    setRemoteDir(editing?.remoteDir ?? "");
    setAuthMode(editing?.authMode ?? "password");
    setPassword("");
    setPrivateKey("");
    setPassphrase("");
  }, [open, editing]);

  const isEdit = editing !== null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      // Only include secret fields when the operator actually typed one, so an
      // edit that leaves them blank keeps whatever is already stored.
      const payload: Record<string, unknown> = { name };
      if (kind === "local") {
        payload.path = path;
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
        toast("Destination updated", "success");
      } else {
        payload.kind = kind;
        await api.post("/api/backup-destinations", payload);
        toast("Destination added", "success");
      }
      await onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit destination" : "Add destination"}
    >
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
          <select
            className={FIELD_CLASS}
            value={kind}
            disabled={isEdit}
            onChange={(e) => setKind(e.target.value as BackupDestinationKind)}
          >
            <option value="local">Mounted path (NAS / remote volume)</option>
            <option value="sftp">SFTP / SSH host</option>
          </select>
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
              Mount your NAS share (SMB / NFS) on the host or into the container
              first, then point here. The folder is created if missing.
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
                  onChange={(e) => setPort(parseInt(e.target.value, 10) || 22)}
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
              <select
                className={FIELD_CLASS}
                value={authMode}
                onChange={(e) => setAuthMode(e.target.value as SftpAuthMode)}
              >
                <option value="password">Password</option>
                <option value="key">Private key</option>
              </select>
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
                  placeholder={
                    editing?.hasPassword ? "•••••• (unchanged)" : ""
                  }
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

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add destination"}
          </Button>
        </div>
      </form>
    </Modal>
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
