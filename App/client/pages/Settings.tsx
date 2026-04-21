import React from "react";
import { useOutletContext } from "react-router-dom";
import { Pencil, Trash2 } from "lucide-react";
import { api, Company, Member, Secret } from "../lib/api";
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
