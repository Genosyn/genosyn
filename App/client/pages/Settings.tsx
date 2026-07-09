import React from "react";
import { useOutletContext } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import { api, Company, Member, Secret } from "../lib/api";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Avatar, memberAvatarUrl } from "../components/ui/Avatar";
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
 *
 * Account-global pages (Profile) live under the Account section; install-wide
 * pages (Backups, Instance Health) live under the Admin section. This file is
 * deliberately company-scoped only.
 */

function useCtx(): SettingsOutletCtx {
  return useOutletContext<SettingsOutletCtx>();
}

function normalizeSlugInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function SettingsCompany() {
  const { company, onCompaniesChanged } = useCtx();
  const [name, setName] = React.useState(company.name);
  const [slug, setSlug] = React.useState(company.slug);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    setName(company.name);
    setSlug(company.slug);
  }, [company.id, company.name, company.slug]);

  const normalizedSlug = normalizeSlugInput(slug);
  const dirty =
    name.trim() !== company.name ||
    (normalizedSlug.length > 0 && normalizedSlug !== company.slug);

  return (
    <>
      <TopBar title="Company" />
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold">General</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Renaming the slug updates every URL for this company and renames its
            directory under <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">data/companies/</code>.
          </p>
        </CardHeader>
        <CardBody>
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!dirty || saving) return;
              const patch: { name?: string; slug?: string } = {};
              if (name.trim() !== company.name) patch.name = name.trim();
              if (normalizedSlug && normalizedSlug !== company.slug) {
                patch.slug = normalizedSlug;
              }
              setError(null);
              setSaving(true);
              try {
                const updated = await api.patch<Company>(
                  `/api/companies/${company.id}`,
                  patch,
                );
                if (updated.slug !== company.slug) {
                  // URL / workspace paths changed — reload at the new slug so
                  // every open tab + route lines up with the renamed company.
                  window.location.assign(`/c/${updated.slug}/settings/company`);
                  return;
                }
                onCompaniesChanged();
                toast("Company updated", "success");
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <FormError message={error} />
            <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <div>
              <Input
                label="Slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                onBlur={() => setSlug((s) => normalizeSlugInput(s))}
                placeholder="acme"
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                title="Lowercase letters, digits, and single dashes"
                required
              />
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                URL: <code className="font-mono">/c/{normalizedSlug || "…"}</code>
              </p>
            </div>
            <div className="flex justify-end pt-1">
              <Button type="submit" disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>
      <DangerZoneCard />
    </>
  );
}

function DangerZoneCard() {
  const { company, me, onCompaniesChanged } = useCtx();
  const [open, setOpen] = React.useState(false);
  const [confirmText, setConfirmText] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { toast } = useToast();

  // Only the owner can hard-delete. Admins/members get nothing — the row
  // would otherwise be a footgun for someone with limited authority.
  if (company.role !== "owner") return null;

  async function doDelete() {
    if (confirmText !== company.name || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await api.del<{ ok: true }>(`/api/companies/${company.id}`);
      // The current company is gone — bounce to the company switcher in
      // AppShell. We refresh first so the dropdown reflects the new list.
      onCompaniesChanged();
      toast(`Deleted ${company.name}`, "success");
      // Pick a destination that won't 404. The shell's redirect logic
      // sends users with no companies to /onboarding; users with at least
      // one will be re-routed to that company's home.
      window.location.assign("/");
    } catch (err) {
      setError((err as Error).message);
      setDeleting(false);
    }
  }

  return (
    <>
      <Card className="mt-4 border-rose-200 dark:border-rose-500/40">
        <CardHeader>
          <h2 className="text-sm font-semibold text-rose-700 dark:text-rose-300">
            Danger zone
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Permanently delete <strong>{company.name}</strong> and everything
            inside it — employees, channels, bases, finance data, notes, and
            uploaded files. This cannot be undone.
          </p>
        </CardHeader>
        <CardBody>
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Signed in as <span className="font-mono">{me.email}</span> ·
              owner of this company.
            </div>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmText("");
                setError(null);
                setOpen(true);
              }}
            >
              <Trash2 size={14} /> Delete company
            </Button>
          </div>
        </CardBody>
      </Card>
      <Modal
        open={open}
        onClose={() => (deleting ? null : setOpen(false))}
        title={`Delete ${company.name}?`}
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This will permanently remove the company, all AI employees,
            channels, bases, finance data, notes, attachments, and the on-disk
            directory at{" "}
            <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs dark:bg-slate-800">
              data/companies/{company.slug}/
            </code>
            . It cannot be undone.
          </p>
          <FormError message={error} />
          <Input
            label={`Type "${company.name}" to confirm`}
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            autoFocus
            placeholder={company.name}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="secondary"
              onClick={() => setOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={doDelete}
              disabled={confirmText !== company.name || deleting}
            >
              {deleting ? "Deleting…" : "Delete forever"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

export function SettingsMembers() {
  const { company } = useCtx();
  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [inviteEmail, setInviteEmail] = React.useState("");
  const [inviteError, setInviteError] = React.useState<string | null>(null);
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
                <li key={m.userId} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar
                      name={m.name ?? m.email ?? "unknown"}
                      size="md"
                      src={memberAvatarUrl(company.id, m.userId, m.avatarKey)}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{m.name ?? "(unknown)"}</div>
                      <div className="truncate text-xs text-slate-500 dark:text-slate-400">{m.email}</div>
                    </div>
                  </div>
                  <span className="text-xs uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    {m.role}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <form
            className="flex flex-col gap-3 border-t border-slate-100 pt-4 dark:border-slate-800"
            onSubmit={async (e) => {
              e.preventDefault();
              setInviteError(null);
              try {
                await api.post(`/api/companies/${company.id}/invitations`, {
                  email: inviteEmail,
                });
                setInviteEmail("");
                toast("Invite sent", "success");
              } catch (err) {
                setInviteError((err as Error).message);
              }
            }}
          >
            <FormError message={inviteError} />
            <div className="flex items-end gap-3">
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
            </div>
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
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName(secret?.name ?? "");
      setValue("");
      setDescription(secret?.description ?? "");
      setError(null);
    }
  }, [open, secret]);

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? `Edit ${secret?.name}` : "Add secret"}>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
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
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormError message={error} />
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
