import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  CheckCircle2,
  FolderTree,
  type LucideIcon,
  Pencil,
  Plug,
  RefreshCw,
  Trash2,
  Vault,
} from "lucide-react";
import { Breadcrumbs } from "@/components/AppShell";
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
import {
  isTwoStepLoginError,
  type VaultSource,
  type VaultSourceKind,
  vaultSourcesApi,
} from "@/lib/vaultSources";
import type { VaultOutletCtx } from "@/pages/VaultLayout";

/**
 * Vault → Integrations: the external password managers this Vault mirrors,
 * and the form that connects one.
 *
 * These rows are `VaultSource`s, not Integration Connections — "Integrations"
 * is what the rail calls them, because that is what someone looking for one
 * calls them. The distinction is load-bearing and AGENTS.md §3 explains it: a
 * Connection is granted to an AI Employee wholesale, whereas a mirrored item
 * keeps the Vault's per-item Grants and its secret never reaches the model.
 *
 * A source holds the master password to an entire external vault, so every
 * route behind this page is admin-gated on the server. The page matches that;
 * a Member sees the mirrored items on the Vault itself, and nothing about
 * where they came from.
 */

type VaultSourceCatalogEntry = {
  kind: VaultSourceKind;
  name: string;
  icon: LucideIcon;
  tagline: string;
  description: string;
};

/**
 * One entry per protocol, not per host: Bitwarden's own cloud and a
 * Vaultwarden someone self-hosts speak the same API and differ only by the
 * server URL. A second entry here means a second implementation behind it —
 * `server/lib/bitwarden/` is Bitwarden-specific all the way down.
 */
const VAULT_SOURCE_CATALOG: readonly VaultSourceCatalogEntry[] = [
  {
    kind: "bitwarden",
    name: "Bitwarden",
    icon: Vault,
    tagline: "Bitwarden or Vaultwarden — the same protocol, hosted or self-hosted.",
    description:
      "Logins and secure notes appear in the Vault as mirrored items. Their passwords stay in Bitwarden and are read at the moment they are used.",
  },
];

/** The server refuses a sixth source; the card says so rather than the error. */
const MAX_VAULT_SOURCES = 5;

export default function VaultIntegrations() {
  const { company } = useOutletContext<VaultOutletCtx>();
  const canAdminister = company.role === "owner" || company.role === "admin";

  return (
    <div className="page-shell p-4 pb-14 sm:p-8">
      <div className="mb-4">
        <Breadcrumbs
          items={[{ label: "Vault", to: `/c/${company.slug}/vault` }, { label: "Integrations" }]}
        />
      </div>

      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
          <Plug size={21} />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-50">
            Integrations
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500 dark:text-slate-400">
            Mirror the password manager your company already runs. Genosyn reads it and never writes
            to it: a mirrored item shows its title, username, and website, and its password is
            fetched from the source at the moment it is used rather than copied here.
          </p>
        </div>
      </div>

      {canAdminister ? (
        <SourcesPanel company={company} />
      ) : (
        <div className="mt-7">
          <EmptyState
            title="Only owners and admins manage Vault sources"
            description="A source holds the master password to an entire external vault. Ask an owner or admin to connect one — the items it mirrors show up in the Vault for everyone it is shared with."
          />
        </div>
      )}
    </div>
  );
}

function SourcesPanel({ company }: { company: Company }) {
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
    } catch (cause) {
      void dialog.error(cause, { title: "Couldn’t disconnect the Vault source" });
    }
  }

  async function handleSaved() {
    setConnecting(false);
    setEditing(null);
    await reload();
  }

  // A failed list is an empty array, so the cap cannot be judged from it — the
  // card says it does not know rather than inviting a connect the server may
  // refuse as the sixth.
  const catalogDisabledReason = error
    ? "How many sources are connected could not be read just now."
    : (sources?.length ?? 0) >= MAX_VAULT_SOURCES
      ? `A company can connect at most ${MAX_VAULT_SOURCES} Vault sources.`
      : null;

  return (
    <>
      <section className="mt-7">
        {/* "Your sources", not "Connected" — a row here can be in the error
            state, and its own pill is what says which. Mirrors the "Your
            connections" heading on Settings → Integrations. */}
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Your sources</h2>
        {/* The empty state draws its own dashed frame, so it is the one branch
            that is not wrapped in the solid card — two nested borders read as a
            mistake. */}
        {sources === null ? (
          <div className="mt-3 flex min-h-32 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <Spinner size={18} />
          </div>
        ) : error ? (
          <div className="mt-3 flex min-h-32 flex-col items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => void reload()}>
              <RefreshCw size={13} /> Try again
            </Button>
          </div>
        ) : sources.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              title="Nothing connected yet"
              description="Choose a password manager below and its logins appear in the Vault as mirrored items — usable by Members and granted AI Employees, with the secrets left where they already are."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
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
      </section>

      <section className="mt-7">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Available integrations
        </h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {VAULT_SOURCE_CATALOG.map((entry) => (
            <CatalogCard
              key={entry.kind}
              entry={entry}
              connected={
                error ? 0 : (sources?.filter((source) => source.kind === entry.kind).length ?? 0)
              }
              // Inert until the list lands: the cap cannot be judged yet, and a
              // spinner above plus an inviting card below is a mixed message.
              disabled={sources === null}
              disabledReason={catalogDisabledReason}
              onConnect={() => setConnecting(true)}
            />
          ))}
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-400 dark:text-slate-500">
          More password managers will appear here as Genosyn learns to read them.
        </p>
      </section>

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
    </>
  );
}

function CatalogCard({
  entry,
  connected,
  disabled,
  disabledReason,
  onConnect,
}: {
  entry: VaultSourceCatalogEntry;
  connected: number;
  disabled: boolean;
  /** Shown beside the card when there is something to explain about `disabled`. */
  disabledReason: string | null;
  onConnect: () => void;
}) {
  const Icon = entry.icon;
  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={disabled || disabledReason !== null}
      className="group flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
    >
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700 group-hover:bg-indigo-100 group-hover:text-indigo-600 dark:bg-slate-800 dark:text-slate-200 dark:group-hover:bg-indigo-900 dark:group-hover:text-indigo-300">
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {entry.name}
          </span>
          {connected > 0 && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              {connected} connected
            </span>
          )}
          <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Read-only
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{entry.tagline}</p>
        <p className="mt-1.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
          {entry.description}
        </p>
        {disabledReason && (
          <p className="mt-2 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertCircle size={12} className="mt-0.5 shrink-0" />
            <span>{disabledReason}</span>
          </p>
        )}
      </div>
    </button>
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
