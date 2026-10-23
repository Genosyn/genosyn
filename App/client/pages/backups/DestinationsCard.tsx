import React from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { FormError, FormSuccess } from "@/components/ui/FormError";
import { MenuItem } from "@/components/ui/Menu";
import {
  HardDrive,
  Network,
  Pause,
  Pencil,
  Play,
  Plug,
  Plus,
  Send,
  Server,
  Trash2,
} from "lucide-react";
import {
  api,
  type BackupCopiesStarted,
  type BackupDestination,
  type BackupDestinationKind,
  type BackupDestinationTest,
  type BackupHistoryItem,
  type SftpAuthMode,
} from "@/lib/api";
import { destinationHealth, plainReason } from "@/lib/backupStatus";
import { errorMessage } from "@/lib/errors";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { Textarea } from "@/components/ui/Textarea";
import { clsx } from "@/components/ui/clsx";
import { TONE_TEXT, ToneIcon, RowMenu, SectionError, TechnicalDetail } from "./ui";

/**
 * Admin → Backups: the places outside this server that keep a copy of every
 * backup, each with Test beside it and its result shown right there.
 */

/** Well-known port per destination kind (a folder has none). */
const DEFAULT_PORT: Record<BackupDestinationKind, number> = { local: 0, sftp: 22, smb: 445 };

const KIND_BADGE: Record<BackupDestinationKind, string> = {
  local: "Folder",
  sftp: "SFTP",
  smb: "SMB",
};

function KindIcon({ kind }: { kind: BackupDestinationKind }) {
  if (kind === "local") return <HardDrive size={16} aria-hidden />;
  if (kind === "smb") return <Network size={16} aria-hidden />;
  return <Server size={16} aria-hidden />;
}

type DestinationBusy = "test" | "toggle" | "remove" | "copy";

export function DestinationsCard({
  destinations,
  error,
  onRetry,
  onChanged,
  latestOnServer,
  onCopyLatest,
  now,
}: {
  destinations: BackupDestination[] | null;
  error: string | null;
  onRetry: () => void;
  onChanged: () => Promise<void>;
  latestOnServer: BackupHistoryItem | null;
  onCopyLatest: (destinationId: string) => Promise<BackupCopiesStarted | null>;
  now: Date;
}) {
  const dialog = useDialog();
  const [modal, setModal] = React.useState<{ open: boolean; editing: BackupDestination | null }>({
    open: false,
    editing: null,
  });
  const [busy, setBusy] = React.useState<Record<string, DestinationBusy | undefined>>({});
  // Each destination's last Test result, kept by id: the list reloading after
  // a test must not take the result away with it.
  const [results, setResults] = React.useState<Record<string, BackupDestinationTest | undefined>>(
    {},
  );
  const [errors, setErrors] = React.useState<Record<string, string | undefined>>({});
  const [notes, setNotes] = React.useState<Record<string, string | undefined>>({});

  const mark = (id: string, action: DestinationBusy | undefined) =>
    setBusy((current) => ({ ...current, [id]: action }));
  const setFor = <T,>(
    set: React.Dispatch<React.SetStateAction<Record<string, T | undefined>>>,
    id: string,
    value: T | undefined,
  ) => set((current) => ({ ...current, [id]: value }));

  const test = async (dest: Pick<BackupDestination, "id">) => {
    mark(dest.id, "test");
    setFor(setErrors, dest.id, undefined);
    setFor(setNotes, dest.id, undefined);
    setFor(setResults, dest.id, undefined);
    let result: BackupDestinationTest;
    try {
      result = await api.post<BackupDestinationTest>(`/api/backup-destinations/${dest.id}/test`);
    } catch (err) {
      result = {
        ok: false,
        message: errorMessage(err, "The test couldn't run."),
        stillFailing: false,
        testedAt: new Date().toISOString(),
      };
    }
    setFor(setResults, dest.id, result);
    mark(dest.id, undefined);
    // The row's health line moves with the test; the result above stays.
    await onChanged();
  };

  const toggle = async (dest: BackupDestination) => {
    mark(dest.id, "toggle");
    setFor(setErrors, dest.id, undefined);
    try {
      await api.put<BackupDestination>(`/api/backup-destinations/${dest.id}`, {
        enabled: !dest.enabled,
      });
      await onChanged();
    } catch (err) {
      setFor(
        setErrors,
        dest.id,
        errorMessage(err, dest.enabled ? "Couldn't pause it." : "Couldn't resume it."),
      );
    } finally {
      mark(dest.id, undefined);
    }
  };

  const remove = async (dest: BackupDestination) => {
    const ok = await dialog.confirm({
      title: `Remove “${dest.name}”?`,
      message:
        "Genosyn stops copying backups there. Backups already on it stay there: delete them on the destination itself if you want them gone.",
      confirmLabel: "Remove destination",
      variant: "danger",
    });
    if (!ok) return;
    mark(dest.id, "remove");
    setFor(setErrors, dest.id, undefined);
    try {
      await api.del(`/api/backup-destinations/${dest.id}`);
      setFor(setResults, dest.id, undefined);
      await onChanged();
    } catch (err) {
      setFor(setErrors, dest.id, errorMessage(err, "Couldn't remove it."));
    } finally {
      mark(dest.id, undefined);
    }
  };

  const copyLatest = async (dest: BackupDestination) => {
    mark(dest.id, "copy");
    setFor(setErrors, dest.id, undefined);
    try {
      const started = await onCopyLatest(dest.id);
      setFor(setResults, dest.id, undefined);
      setFor<string>(
        setNotes,
        dest.id,
        started?.alreadyRunning
          ? "That backup is already being copied. Follow it in History."
          : "Copying the latest backup here. Follow it in History.",
      );
    } catch (err) {
      setFor(setErrors, dest.id, errorMessage(err, "Couldn't start the copy."));
    } finally {
      mark(dest.id, undefined);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Off-box destinations
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Places outside this server where Genosyn keeps a copy of every backup, so losing this
              server doesn&apos;t lose your backups: a NAS folder, an SFTP server, or an SMB share.
            </p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setModal({ open: true, editing: null })}
            className="self-start sm:shrink-0"
          >
            <Plus size={12} />
            Add destination
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {destinations === null ? (
          error ? (
            <SectionError message={error} onRetry={onRetry} />
          ) : (
            <Spinner />
          )
        ) : destinations.length === 0 ? (
          <EmptyState
            title="No off-box destination yet"
            description="Your backups are only on this server. Add a NAS folder, an SFTP server or an SMB share, and Genosyn copies every backup there too."
            action={
              <Button size="sm" onClick={() => setModal({ open: true, editing: null })}>
                <Plus size={12} />
                Add destination
              </Button>
            }
          />
        ) : (
          <>
            {error && <FormError message={error} className="mb-3" />}
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {destinations.map((dest) => (
                <DestinationRow
                  key={dest.id}
                  dest={dest}
                  now={now}
                  busy={busy[dest.id]}
                  result={results[dest.id]}
                  error={errors[dest.id]}
                  note={notes[dest.id]}
                  canCopyLatest={latestOnServer !== null}
                  onTest={() => void test(dest)}
                  onEdit={() => setModal({ open: true, editing: dest })}
                  onToggle={() => void toggle(dest)}
                  onRemove={() => void remove(dest)}
                  onCopyLatest={() => void copyLatest(dest)}
                />
              ))}
            </ul>
          </>
        )}
      </CardBody>
      <DestinationModal
        open={modal.open}
        editing={modal.editing}
        onClose={() => setModal({ open: false, editing: null })}
        onSaved={async (saved) => {
          setModal({ open: false, editing: null });
          await onChanged();
          // Show straight away whether the new settings work.
          await test(saved);
        }}
      />
    </Card>
  );
}

function DestinationRow({
  dest,
  now,
  busy,
  result,
  error,
  note,
  canCopyLatest,
  onTest,
  onEdit,
  onToggle,
  onRemove,
  onCopyLatest,
}: {
  dest: BackupDestination;
  now: Date;
  busy: DestinationBusy | undefined;
  result: BackupDestinationTest | undefined;
  error: string | undefined;
  note: string | undefined;
  canCopyLatest: boolean;
  onTest: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onRemove: () => void;
  onCopyLatest: () => void;
}) {
  const health = destinationHealth(dest, now);
  return (
    <li className="py-3 first:pt-0 last:pb-0" aria-label={dest.name}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 text-slate-400 dark:text-slate-500">
            <KindIcon kind={dest.kind} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900 dark:text-slate-100">{dest.name}</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                {KIND_BADGE[dest.kind]}
              </span>
            </div>
            <p className="mt-0.5 break-all font-mono text-xs text-slate-500 dark:text-slate-400">
              {dest.hint || "—"}
            </p>
            <div className={clsx("mt-1 flex items-start gap-1.5 text-xs", TONE_TEXT[health.tone])}>
              <ToneIcon tone={health.tone} size={12} className="mt-0.5" />
              <div className="min-w-0 break-words">
                {health.label}
                {health.detail && (
                  <span className="block text-slate-500 dark:text-slate-400">{health.detail}</span>
                )}
                <TechnicalDetail detail={health.technical} className="mt-0.5" />
              </div>
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 self-start">
          <Button
            size="sm"
            variant="secondary"
            onClick={onTest}
            loading={busy === "test"}
            disabled={busy !== undefined}
          >
            <Plug size={12} />
            {busy === "test" ? "Testing…" : "Test"}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} disabled={busy !== undefined}>
            <Pencil size={12} />
            Edit
          </Button>
          <RowMenu
            label={`More for ${dest.name}`}
            loading={busy === "toggle" || busy === "remove"}
            disabled={busy !== undefined}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={dest.enabled ? <Pause size={14} /> : <Play size={14} />}
                  label={dest.enabled ? "Pause copies here" : "Resume copies here"}
                  onSelect={() => {
                    close();
                    onToggle();
                  }}
                />
                <MenuItem
                  icon={<Trash2 size={14} />}
                  label="Remove destination"
                  className="text-rose-700 dark:text-rose-300"
                  onSelect={() => {
                    close();
                    onRemove();
                  }}
                />
              </>
            )}
          </RowMenu>
        </div>
      </div>
      {result &&
        (result.ok ? (
          <div className="mt-3 flex flex-col gap-2">
            <FormSuccess message={result.message} />
            {result.stillFailing && canCopyLatest && (
              <div>
                <Button
                  size="sm"
                  onClick={onCopyLatest}
                  loading={busy === "copy"}
                  disabled={busy !== undefined}
                >
                  <Send size={12} />
                  Copy the latest backup here now
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-1">
            <FormError
              message={plainReason(result.message, "destination")?.text ?? result.message}
            />
            <TechnicalDetail detail={plainReason(result.message, "destination")?.technical} />
          </div>
        ))}
      {note && <FormSuccess message={note} className="mt-3" />}
      {error && <FormError message={error} className="mt-3" />}
    </li>
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
  onSaved: (saved: BackupDestination) => Promise<void>;
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
    setPort(editing?.port ?? DEFAULT_PORT[nextKind]);
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

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // Secrets go only when typed, so an edit that leaves them blank keeps
      // whatever is stored.
      const payload: Record<string, unknown> = { name };
      if (kind === "local") {
        payload.path = path;
      } else if (kind === "smb") {
        Object.assign(payload, { host, port, share, remoteDir, domain, username, encrypt });
        if (password) payload.password = password;
      } else {
        Object.assign(payload, { host, port, username, remoteDir, authMode });
        if (authMode === "password") {
          if (password) payload.password = password;
        } else {
          if (privateKey) payload.privateKey = privateKey;
          if (passphrase) payload.passphrase = passphrase;
        }
      }
      const saved = isEdit
        ? await api.put<BackupDestination>(`/api/backup-destinations/${editing.id}`, payload)
        : await api.post<BackupDestination>("/api/backup-destinations", { ...payload, kind });
      await onSaved(saved);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the destination."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit destination" : "Add destination"}
      description="Genosyn tests it as soon as it is saved."
      onSubmit={submit}
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" size="sm" loading={saving}>
            {saving ? "Saving…" : isEdit ? "Save changes" : "Add destination"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Office NAS"
          required
        />
        <div className="flex flex-col gap-1">
          <Select
            label="Type"
            value={kind}
            disabled={isEdit}
            onChange={(e) => {
              const next = e.target.value as BackupDestinationKind;
              setKind(next);
              setPort(DEFAULT_PORT[next]);
            }}
          >
            <option value="local">A folder on this server (a mounted NAS or disk)</option>
            <option value="sftp">An SFTP / SSH server</option>
            <option value="smb">An SMB / Windows share (no mount needed)</option>
          </Select>
          {isEdit && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              The type can&apos;t be changed once it is added.
            </p>
          )}
        </div>
        {kind === "local" ? (
          <div className="flex flex-col gap-1">
            <Input
              label="Folder"
              className="font-mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/mnt/nas/genosyn-backups"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Mount the NAS share (SMB or NFS) on this server, or into the Genosyn container, then
              enter that folder. It is created if it doesn&apos;t exist. Can&apos;t mount it? Choose
              the SMB type instead.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <Input
                  label="Host"
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="nas.local"
                />
              </div>
              <Input
                label="Port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value, 10) || DEFAULT_PORT[kind])}
              />
            </div>
            {kind === "smb" ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Share"
                    className="font-mono"
                    value={share}
                    onChange={(e) => setShare(e.target.value)}
                    placeholder="backups"
                  />
                  <Input
                    label="Folder in the share (optional)"
                    className="font-mono"
                    value={remoteDir}
                    onChange={(e) => setRemoteDir(e.target.value)}
                    placeholder="genosyn"
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="backup"
                  />
                  <Input
                    label="Domain or workgroup (optional)"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="WORKGROUP"
                  />
                </div>
                <Input
                  label="Password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editing?.hasPassword ? "•••••• (unchanged)" : ""}
                  autoComplete="new-password"
                />
                <label className="flex cursor-pointer items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600"
                    checked={encrypt}
                    onChange={(e) => setEncrypt(e.target.checked)}
                  />
                  <span>
                    Encrypt in transit
                    <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                      Uses SMB3 encryption so the backup isn&apos;t readable on your network. Turn
                      this off only if the NAS predates SMB3.
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Input
                    label="Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="backup"
                  />
                  <Input
                    label="Folder on the server"
                    className="font-mono"
                    value={remoteDir}
                    onChange={(e) => setRemoteDir(e.target.value)}
                    placeholder="/volume1/genosyn"
                  />
                </div>
                <Select
                  label="Sign in with"
                  value={authMode}
                  onChange={(e) => setAuthMode(e.target.value as SftpAuthMode)}
                >
                  <option value="password">A password</option>
                  <option value="key">A private key</option>
                </Select>
                {authMode === "password" ? (
                  <Input
                    label="Password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={editing?.hasPassword ? "•••••• (unchanged)" : ""}
                    autoComplete="new-password"
                  />
                ) : (
                  <>
                    <Textarea
                      label="Private key (PEM)"
                      className="min-h-[7rem] font-mono text-xs"
                      value={privateKey}
                      onChange={(e) => setPrivateKey(e.target.value)}
                      placeholder={
                        editing?.hasPrivateKey
                          ? "Stored. Leave blank to keep the current key."
                          : "-----BEGIN OPENSSH PRIVATE KEY-----"
                      }
                    />
                    <Input
                      label="Key passphrase (optional)"
                      type="password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      autoComplete="new-password"
                    />
                  </>
                )}
              </>
            )}
          </>
        )}
        <FormError message={error} />
      </div>
    </Modal>
  );
}
