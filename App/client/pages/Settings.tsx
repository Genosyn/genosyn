import React from "react";
import { useOutletContext } from "react-router-dom";
import { Download, Pencil, Trash2 } from "lucide-react";
import {
  api,
  Backup,
  BackupFrequency,
  BackupSchedule,
  Company,
  Me,
  Member,
  Secret,
} from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { EmptyState } from "../components/ui/EmptyState";
import { TopBar } from "../components/AppShell";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import type { SettingsOutletCtx } from "./SettingsLayout";

/**
 * Company-level settings split into sidebar-addressable sub-pages. Each page
 * reads `company` + the companies-changed callback from SettingsLayout's
 * Outlet context, so pages don't re-fetch the company on mount.
 */

function useCtx(): SettingsOutletCtx {
  return useOutletContext<SettingsOutletCtx>();
}

export function SettingsAccount() {
  const { me, onCompaniesChanged } = useCtx();
  const [name, setName] = React.useState(me.name);
  const [email, setEmail] = React.useState(me.email);
  const [savingProfile, setSavingProfile] = React.useState(false);
  const [currentPassword, setCurrentPassword] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");
  const [confirmPassword, setConfirmPassword] = React.useState("");
  const [savingPassword, setSavingPassword] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    setName(me.name);
    setEmail(me.email);
  }, [me.id, me.name, me.email]);

  const profileDirty = name.trim() !== me.name || email.trim().toLowerCase() !== me.email;

  return (
    <>
      <TopBar title="Profile" />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Personal details</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              This name and email appear on your account and on any invitations you send.
            </p>
          </CardHeader>
          <CardBody>
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!profileDirty) return;
                setSavingProfile(true);
                try {
                  await api.patch<Me>("/api/auth/me", {
                    name: name.trim(),
                    email: email.trim().toLowerCase(),
                  });
                  onCompaniesChanged();
                  toast("Profile updated", "success");
                } catch (err) {
                  toast((err as Error).message, "error");
                } finally {
                  setSavingProfile(false);
                }
              }}
            >
              <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
              <Input
                label="Email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={!profileDirty || savingProfile}>
                  {savingProfile ? "Saving…" : "Save changes"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Change password</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              At least 8 characters. You'll stay signed in after changing it.
            </p>
          </CardHeader>
          <CardBody>
            <form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                if (newPassword.length < 8) {
                  toast("New password must be at least 8 characters", "error");
                  return;
                }
                if (newPassword !== confirmPassword) {
                  toast("New passwords don't match", "error");
                  return;
                }
                setSavingPassword(true);
                try {
                  await api.post("/api/auth/password", { currentPassword, newPassword });
                  setCurrentPassword("");
                  setNewPassword("");
                  setConfirmPassword("");
                  toast("Password changed", "success");
                } catch (err) {
                  toast((err as Error).message, "error");
                } finally {
                  setSavingPassword(false);
                }
              }}
            >
              <Input
                label="Current password"
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <Input
                label="New password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
              <Input
                label="Confirm new password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
              <div className="flex justify-end pt-1">
                <Button
                  type="submit"
                  disabled={
                    savingPassword ||
                    currentPassword.length === 0 ||
                    newPassword.length === 0 ||
                    confirmPassword.length === 0
                  }
                >
                  {savingPassword ? "Saving…" : "Change password"}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>
    </>
  );
}

export function SettingsCompany() {
  const { company, onCompaniesChanged } = useCtx();
  const [name, setName] = React.useState(company.name);
  const { toast } = useToast();

  React.useEffect(() => {
    setName(company.name);
  }, [company.id, company.name]);

  return (
    <>
      <TopBar title="Company" />
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">General</h2>
        </CardHeader>
        <CardBody>
          <form
            className="flex items-end gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.patch(`/api/companies/${company.id}`, { name });
                onCompaniesChanged();
                toast("Company updated", "success");
              } catch (err) {
                toast((err as Error).message, "error");
              }
            }}
          >
            <div className="flex-1">
              <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit">Save</Button>
          </form>
        </CardBody>
      </Card>
    </>
  );
}

export function SettingsMembers() {
  const { company } = useCtx();
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const { toast } = useToast();

  const reload = React.useCallback(async () => {
    try {
      const m = await api.get<Member[]>(`/api/companies/${company.id}/members`);
      setMembers(m);
    } catch {
      setMembers([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return (
    <>
      <TopBar title="Members" />
      <Card>
        <CardBody className="flex flex-col gap-4">
          {members === null ? (
            <Spinner />
          ) : members.length === 0 ? (
            <EmptyState
              title="No members yet"
              description="Invite teammates by email to collaborate on this company."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between py-2 text-sm">
                  <div>
                    <div className="font-medium">{m.name ?? "(unknown)"}</div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">{m.email}</div>
                  </div>
                  <span className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    {m.role}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex items-end gap-3 border-t border-slate-100 pt-4 dark:border-slate-800"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.post(`/api/companies/${company.id}/invitations`, {
                  email: inviteEmail,
                });
                setInviteEmail("");
                toast("Invite sent", "success");
              } catch (err) {
                toast((err as Error).message, "error");
              }
            }}
          >
            <div className="flex-1">
              <Input
                label="Invite by email"
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                required
              />
            </div>
            <Button type="submit">Send invite</Button>
          </form>
        </CardBody>
      </Card>
    </>
  );
}

export function SettingsSecrets() {
  const { company } = useCtx();
  return (
    <>
      <TopBar title="Secrets" />
      <SecretsCard company={company} />
    </>
  );
}

/**
 * Per-company vault. Secrets are encrypted at rest and injected into every
 * employee spawn (routine + chat) as environment variables. The plaintext
 * value is never returned by the API — only a masked preview. "Edit" lets a
 * user rotate the value; we never show the old one.
 */
function SecretsCard({ company }: { company: Company }) {
  const [rows, setRows] = React.useState<Secret[] | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<Secret | null>(null);
  const { toast } = useToast();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<Secret[]>(`/api/companies/${company.id}/secrets`);
      setRows(list);
    } catch (err) {
      toast((err as Error).message, "error");
      setRows([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold">Vault</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Encrypted at rest. Injected into every employee run and chat as environment variables.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreating(true)}>
            Add secret
          </Button>
        </div>
      </CardHeader>
      <CardBody>
        {rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No secrets yet"
            description="Store API keys, tokens, and other sensitive values once and make them available to every employee."
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                      {s.name}
                    </code>
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">{s.preview}</span>
                  </div>
                  {s.description && (
                    <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{s.description}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>
                    <Pencil size={12} /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      const ok = await dialog.confirm({
                        title: `Delete "${s.name}"?`,
                        message: "Employees lose access to this secret on their next run.",
                        confirmLabel: "Delete secret",
                        variant: "danger",
                      });
                      if (!ok) return;
                      try {
                        await api.del(`/api/companies/${company.id}/secrets/${s.id}`);
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

      <SecretModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={async () => {
          setCreating(false);
          await reload();
        }}
        companyId={company.id}
      />
      <SecretModal
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await reload();
        }}
        companyId={company.id}
        secret={editing ?? undefined}
      />
    </Card>
  );
}

function SecretModal({
  open,
  onClose,
  onSaved,
  companyId,
  secret,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  companyId: string;
  secret?: Secret;
}) {
  const isEdit = !!secret;
  const [name, setName] = React.useState(secret?.name ?? "");
  const [value, setValue] = React.useState("");
  const [description, setDescription] = React.useState(secret?.description ?? "");
  const [busy, setBusy] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    if (open) {
      setName(secret?.name ?? "");
      setValue("");
      setDescription(secret?.description ?? "");
    }
  }, [open, secret]);

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${secret?.name}` : "Add secret"}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (isEdit) {
              const body: { value?: string; description?: string } = { description };
              if (value.length > 0) body.value = value;
              await api.patch(`/api/companies/${companyId}/secrets/${secret!.id}`, body);
            } else {
              await api.post(`/api/companies/${companyId}/secrets`, {
                name: name.trim(),
                value,
                description,
              });
            }
            onSaved();
          } catch (err) {
            toast((err as Error).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {!isEdit && (
          <Input
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            placeholder="STRIPE_API_KEY"
            pattern="[A-Z_][A-Z0-9_]*"
            title="Uppercase letters, digits, and underscores; must start with a letter or underscore"
            required
          />
        )}
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Value {isEdit && <span className="text-slate-400 dark:text-slate-500">(leave blank to keep current)</span>}
          </label>
          <input
            type="password"
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
            required={!isEdit}
          />
        </div>
        <Input
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is this for?"
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {isEdit ? "Save" : "Add secret"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Install-wide backup page. Surfaces three things: a "Back up now" button that
 * zips the entire data directory into `<dataDir>/Backup/`, a recurring-schedule
 * form (daily / weekly / monthly + hour of day), and a list of past archives
 * with download + delete actions.
 */
export function SettingsBackup() {
  const [rows, setRows] = React.useState<Backup[] | null>(null);
  const [schedule, setSchedule] = React.useState<BackupSchedule | null>(null);
  const [running, setRunning] = React.useState(false);
  const [savingSchedule, setSavingSchedule] = React.useState(false);
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

  return (
    <>
      <TopBar title="Backup" />
      <div className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Manual backup</h2>
                <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  Zips the entire data directory into{" "}
                  <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
                    data/Backup/
                  </code>
                  .
                </p>
              </div>
              <Button size="sm" onClick={backupNow} disabled={running}>
                {running ? "Backing up…" : "Back up now"}
              </Button>
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
                        <a
                          href={`/api/backups/${b.id}/download`}
                          className="inline-flex h-8 items-center gap-1 rounded-lg px-3 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <Download size={12} /> Download
                        </a>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
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
