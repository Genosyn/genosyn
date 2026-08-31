import React from "react";
import {
  AlertCircle,
  CheckCircle2,
  FolderTree,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Vault,
} from "lucide-react";
import { useLiveRefetch } from "@/components/CompanySocket";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import type { Company } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { VaultVisibility } from "@/lib/vault";
import { isTwoStepLoginError, type VaultSource, vaultSourcesApi } from "@/lib/vaultSources";

/**
 * The company's connected Bitwarden and Vaultwarden vaults, and the form that
 * connects one.
 *
 * A source holds the master password to an entire external vault, so every
 * route behind this panel is admin-gated on the server. The panel matches that
 * and renders for owners and admins only — a Member sees the mirrored items in
 * the list above, and nothing about where they came from.
 */
export function VaultSourcesPanel({
  company,
  onChanged,
}: {
  company: Company;
  onChanged: () => void | Promise<void>;
}) {
  if (company.role !== "owner" && company.role !== "admin") return null;
  return <SourcesPanel company={company} onChanged={onChanged} />;
}

function SourcesPanel({
  company,
  onChanged,
}: {
  company: Company;
  onChanged: () => void | Promise<void>;
}) {
  const dialog = useDialog();
  const [sources, setSources] = React.useState<VaultSource[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [connecting, setConnecting] = React.useState(false);
  const [editing, setEditing] = React.useState<VaultSource | null>(null);
  const [syncingId, setSyncingId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    setError(null);
    try {
      setSources(await vaultSourcesApi.list(company.id));
    } catch (cause) {
      setError(errorMessage(cause, "Vault sources could not be loaded."));
      setSources([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    setSources(null);
    void reload();
  }, [reload]);

  useLiveRefetch(["vault_source"], reload);

  async function syncNow(source: VaultSource) {
    if (syncingId) return;
    setSyncingId(source.id);
    try {
      const synced = await vaultSourcesApi.sync(company.id, source.id);
      setSources(
        (current) =>
          current?.map((row) => (row.id === synced.source.id ? synced.source : row)) ?? current,
      );
      await onChanged();
    } catch (cause) {
      // A failed read is written back onto the source, so reloading flips this
      // row to "Needs attention" and prints what the external vault said.
      await reload();
      void dialog.error(cause, { title: `Couldn’t sync ${source.label}` });
    } finally {
      setSyncingId(null);
    }
  }

  async function disconnect(source: VaultSource) {
    const mirrored =
      source.itemCount === 0
        ? "This source is not mirroring any items right now."
        : `The ${source.itemCount === 1 ? "item" : `${source.itemCount} items`} it mirrors will disappear from the Vault, together with their Member access and AI Employee Grants.`;
    const confirmed = await dialog.confirm({
      title: `Disconnect ${source.label}?`,
      message: `${mirrored} Nothing is removed from Bitwarden: every item stays exactly where it is, and reconnecting mirrors them again.`,
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await vaultSourcesApi.remove(company.id, source.id);
      await reload();
      await onChanged();
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t disconnect the Vault source" });
    }
  }

  async function handleSaved() {
    setConnecting(false);
    setEditing(null);
    await reload();
    await onChanged();
  }

  return (
    <section className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-start sm:justify-between dark:border-slate-800">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
            <Vault size={15} className="text-slate-400" />
            Vault sources
          </h2>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-500 dark:text-slate-400">
            Mirror a Bitwarden or Vaultwarden vault into this Vault. Genosyn reads the items and
            never writes to them: a mirrored item shows its title, username, and website, and its
            password is read from Bitwarden at the moment it is used rather than copied into
            Genosyn.
          </p>
        </div>
        <Button size="sm" className="self-start" onClick={() => setConnecting(true)}>
          <Plus size={13} /> Connect a Vault source
        </Button>
      </div>

      {sources === null ? (
        <div className="flex min-h-32 items-center justify-center">
          <Spinner size={18} />
        </div>
      ) : error ? (
        <div className="flex min-h-32 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{error}</p>
          <Button variant="secondary" size="sm" onClick={() => void reload()}>
            <RefreshCw size={13} /> Try again
          </Button>
        </div>
      ) : sources.length === 0 ? (
        <div className="p-6">
          <EmptyState
            title="No Vault sources connected"
            description="Connect the company's Bitwarden or Vaultwarden vault and its logins appear here as mirrored items — usable by Members and granted AI Employees, with the secrets left where they already are."
            action={
              <Button size="sm" onClick={() => setConnecting(true)}>
                <Plus size={13} /> Connect a Vault source
              </Button>
            }
          />
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              syncing={syncingId === source.id}
              syncDisabled={syncingId !== null}
              onSync={() => void syncNow(source)}
              onEdit={() => setEditing(source)}
              onDisconnect={() => void disconnect(source)}
            />
          ))}
        </ul>
      )}

      <VaultSourceForm
        companyId={company.id}
        open={connecting}
        onClose={() => setConnecting(false)}
        onSaved={handleSaved}
      />
      <VaultSourceForm
        companyId={company.id}
        source={editing ?? undefined}
        open={editing !== null}
        onClose={() => setEditing(null)}
        onSaved={handleSaved}
      />
    </section>
  );
}

function SourceRow({
  source,
  syncing,
  syncDisabled,
  onSync,
  onEdit,
  onDisconnect,
}: {
  source: VaultSource;
  syncing: boolean;
  syncDisabled: boolean;
  onSync: () => void;
  onEdit: () => void;
  onDisconnect: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-start">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
        <Vault size={16} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {source.label}
          </span>
          <StatusPill status={source.status} />
          {source.usesApiKey && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              API key
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span className="max-w-72 truncate">{source.serverUrl}</span>
          {source.accountHint && <span className="max-w-64 truncate">{source.accountHint}</span>}
          {source.scopeName && (
            <span className="inline-flex max-w-64 items-center gap-1 truncate">
              <FolderTree size={11} /> {source.scopeName}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-slate-400 dark:text-slate-500">
          <span>
            {source.itemCount} mirrored {source.itemCount === 1 ? "item" : "items"}
          </span>
          <span>
            {source.lastSyncedAt
              ? `Last synced ${new Date(source.lastSyncedAt).toLocaleString()}`
              : "Not synced yet — choose Sync now"}
          </span>
        </div>
        {source.statusMessage && (
          <p
            className={`mt-1.5 text-xs leading-5 ${
              source.status === "connected"
                ? "text-slate-500 dark:text-slate-400"
                : "text-red-700 dark:text-red-300"
            }`}
          >
            {source.statusMessage}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">
        <Button variant="secondary" size="sm" disabled={syncDisabled} onClick={onSync}>
          <RefreshCw size={13} className={syncing ? "animate-spin" : ""} />
          {syncing ? "Syncing…" : "Sync now"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onEdit}>
          <Pencil size={13} /> Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDisconnect}>
          <Trash2 size={13} /> Disconnect
        </Button>
      </div>
    </li>
  );
}

function StatusPill({ status }: { status: VaultSource["status"] }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 size={10} /> Connected
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">
      <AlertCircle size={10} /> Needs attention
    </span>
  );
}

function VaultSourceForm({
  companyId,
  source,
  open,
  onClose,
  onSaved,
}: {
  companyId: string;
  source?: VaultSource;
  open: boolean;
  onClose: () => void;
  onSaved: (source: VaultSource) => void | Promise<void>;
}) {
  const editing = !!source;
  const [label, setLabel] = React.useState("");
  const [serverUrl, setServerUrl] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [masterPassword, setMasterPassword] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [apiKeyOpen, setApiKeyOpen] = React.useState(false);
  const [scopeName, setScopeName] = React.useState("");
  const [defaultVisibility, setDefaultVisibility] = React.useState<VaultVisibility>("restricted");
  const [twoFactorCode, setTwoFactorCode] = React.useState("");
  const [twoFactorWanted, setTwoFactorWanted] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setLabel(source?.label ?? "");
    setServerUrl(source?.serverUrl ?? "");
    setEmail(source?.accountHint ?? "");
    setMasterPassword("");
    setClientId("");
    setClientSecret("");
    setApiKeyOpen(source?.usesApiKey ?? false);
    setScopeName(source?.scopeName ?? "");
    setDefaultVisibility(source?.defaultVisibility ?? "restricted");
    setTwoFactorCode("");
    setTwoFactorWanted(false);
    setBusy(false);
    setError(null);
  }, [open, source]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (Boolean(id) !== Boolean(secret)) {
      setError("A Bitwarden API key needs both its client ID and its client secret.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const common = {
        label: label.trim(),
        serverUrl: serverUrl.trim(),
        email: email.trim(),
        scopeName: scopeName.trim(),
        defaultVisibility,
        ...(id && secret ? { clientId: id, clientSecret: secret } : {}),
        ...(twoFactorCode.trim() ? { twoFactorCode: twoFactorCode.trim() } : {}),
      };
      const saved = source
        ? await vaultSourcesApi.update(companyId, source.id, {
            ...common,
            ...(masterPassword ? { masterPassword } : {}),
          })
        : await vaultSourcesApi.create(companyId, { ...common, masterPassword });
      await onSaved(saved);
    } catch (cause) {
      const message = errorMessage(cause, "The Vault source could not be saved.");
      setError(message);
      if (isTwoStepLoginError(message)) setTwoFactorWanted(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title={source ? `Edit ${source.label}` : "Connect a Vault source"}
      size="lg"
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <FormError message={error} />

        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
          Genosyn signs in to read this vault and never writes to it. Each readable item is mirrored
          as a Vault item carrying its title, username, and website; the value itself stays in
          Bitwarden and is fetched only when someone reveals or copies it, or a granted AI Employee
          fills it.
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Label"
            value={label}
            disabled={busy}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Company Bitwarden"
            autoFocus
            required
          />
          <Input
            label="Server URL"
            value={serverUrl}
            disabled={busy}
            onChange={(event) => setServerUrl(event.target.value)}
            placeholder="https://vault.example.com"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Email"
            type="email"
            value={email}
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="vault@example.com"
            autoComplete="off"
            required
          />
          <div>
            <Input
              label="Master password"
              type="password"
              value={masterPassword}
              disabled={busy}
              onChange={(event) => setMasterPassword(event.target.value)}
              placeholder={editing ? "Leave blank to keep the current one" : "Master password"}
              autoComplete="new-password"
              required={!editing}
            />
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              Encrypted at rest and used only to unlock the vault for a read.
            </p>
          </div>
        </div>

        <details
          className="rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700"
          open={apiKeyOpen}
          onToggle={(event) => setApiKeyOpen(event.currentTarget.open)}
        >
          <summary className="cursor-pointer text-xs text-slate-600 dark:text-slate-300">
            Bitwarden API key <span className="text-slate-400">(optional)</span>
          </summary>
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Input
                label="Client ID"
                value={clientId}
                disabled={busy}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="user.00000000-0000-0000-0000-000000000000"
                autoComplete="off"
              />
              <Input
                label="Client secret"
                type="password"
                value={clientSecret}
                disabled={busy}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder={
                  source?.usesApiKey ? "Leave blank to keep the current one" : "Client secret"
                }
                autoComplete="new-password"
              />
            </div>
            <p className="text-xs leading-5 text-slate-500 dark:text-slate-400">
              Recommended on Bitwarden&apos;s own cloud: an API key login skips two-step login and
              new-device verification, so scheduled syncs keep working unattended. Find it under My
              account → Security → Keys → View API key. A self-hosted Vaultwarden rarely needs one.
            </p>
          </div>
        </details>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Input
              label="Folder or collection"
              value={scopeName}
              disabled={busy}
              onChange={(event) => setScopeName(event.target.value)}
              placeholder="Shared logins"
              autoComplete="off"
            />
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              Optional. Leave blank to mirror the whole vault.
            </p>
          </div>
          <div>
            <Select
              label="Default visibility"
              value={defaultVisibility}
              disabled={busy}
              onChange={(event) => setDefaultVisibility(event.target.value as VaultVisibility)}
            >
              <option value="restricted">Restricted — only selected Members</option>
              <option value="company">Company-wide — every Member can view</option>
            </Select>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              How mirrored items arrive. AI Employees still need an explicit Grant.
            </p>
          </div>
        </div>

        {twoFactorWanted && (
          <div>
            <Input
              label="Authenticator code"
              value={twoFactorCode}
              disabled={busy}
              onChange={(event) => setTwoFactorCode(event.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={12}
              autoFocus
            />
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              This account uses two-step login. Enter a current code and save again — Genosyn
              remembers this device afterwards, so later syncs run without one.
            </p>
          </div>
        )}

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              busy ||
              !label.trim() ||
              !serverUrl.trim() ||
              !email.trim() ||
              (!editing && !masterPassword)
            }
          >
            {busy
              ? editing
                ? "Saving…"
                : "Connecting…"
              : editing
                ? "Save changes"
                : "Connect Vault source"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
