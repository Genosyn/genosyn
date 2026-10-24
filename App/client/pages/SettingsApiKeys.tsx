import React from "react";
import { Select } from "@/components/ui/Select";
import { useOutletContext } from "react-router-dom";
import { BookOpen, Cable, Check, Copy, KeyRound, PlugZap, Trash2, Unplug } from "lucide-react";
import { api, ApiKey, ApiKeyCreated, Company, type ConnectedApp } from "../lib/api";
import { apiKeyCurlExample, apiReferenceUrl, companyApiBaseUrl } from "../lib/apiAccess";
import { appHost } from "../lib/appConsent";
import { copyToClipboard } from "../lib/clipboard";
import {
  API_KEY_PLACEHOLDER,
  companyMcpUrl,
  KEY_MCP_CLIENTS,
  MCP_CLIENTS,
  mcpClientSetup,
  type McpClientId,
} from "../lib/mcpSetup";
import { CONNECTED_APP_IDLE_DAYS, mayConnectApps } from "../../shared/connectedApps";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { FormError } from "../components/ui/FormError";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { EmptyState } from "../components/ui/EmptyState";
import { TopBar } from "../components/AppShell";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import { errorMessage } from "../lib/errors";
import type { SettingsOutletCtx } from "./SettingsLayout";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * Settings → API keys. Personal-not-shared programmatic tokens for the same
 * REST surface the web UI hits. Each key authenticates as the calling user
 * and is scoped to one company; the plaintext is shown exactly once on
 * create. Revocation is soft so audit history survives.
 *
 * The same keys open the Genosyn MCP server, so its endpoint and the setup
 * for each MCP client sit here too — and, filled in with the real key, at the
 * one moment the key is shown. Apps that sign in to that server instead of
 * taking a key — claude.ai, ChatGPT — are listed here as connected apps, the
 * place to disconnect them.
 */
export function SettingsApiKeys() {
  const { company } = useOutletContext<SettingsOutletCtx>();
  return (
    <>
      <TopBar title="API keys" />
      <ApiKeysCard company={company} />
      <ConnectedAppsCard company={company} />
      <McpServerCard company={company} />
    </>
  );
}

function ApiKeysCard({ company }: { company: Company }) {
  const [rows, setRows] = React.useState<ApiKey[] | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [justCreated, setJustCreated] = React.useState<ApiKeyCreated | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const background = useBackgroundAction();
  const dialog = useDialog();

  const reload = React.useCallback(async () => {
    try {
      const list = await api.get<ApiKey[]>(`/api/companies/${company.id}/api-keys`);
      setRows(list);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the API keys"));
      setRows([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch("apikey", reload);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Personal access tokens</h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Authenticate as you against the same REST surface the UI uses. Pass{" "}
                <code className="font-mono">Authorization: Bearer gen_…</code>.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <a
                href={apiReferenceUrl(window.location.origin)}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
              >
                <BookOpen size={12} /> API reference
              </a>
              <Button size="sm" onClick={() => setCreating(true)}>
                Generate key
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardBody>
          <ApiBaseUrl companyId={company.id} />
          {loadError ? (
            <FormError message={loadError} />
          ) : rows === null ? (
            <Spinner />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No API keys yet"
              description="Generate a key to script Genosyn from CI, your terminal, or any HTTP client."
            />
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((k) => (
                <ApiKeyRow
                  key={k.id}
                  apiKey={k}
                  onRevoke={async () => {
                    const ok = await dialog.confirm({
                      title: `Revoke "${k.name}"?`,
                      message:
                        "Any process using this token will start getting 401s on the next request. This can't be undone.",
                      confirmLabel: "Revoke key",
                      variant: "danger",
                    });
                    if (!ok) return;
                    const originalIndex = rows.findIndex((item) => item.id === k.id);
                    setRows((current) => current?.filter((item) => item.id !== k.id) ?? current);
                    background(() => api.del(`/api/companies/${company.id}/api-keys/${k.id}`), {
                      title: "Couldn’t revoke the API key",
                      error: (error) => `${errorMessage(error)} It has been restored.`,
                      onError: () => {
                        setRows((current) => {
                          if (!current || current.some((item) => item.id === k.id)) {
                            return current;
                          }
                          const next = [...current];
                          next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, k);
                          return next;
                        });
                      },
                    });
                  }}
                />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <CreateApiKeyModal
        open={creating}
        companyId={company.id}
        onClose={() => setCreating(false)}
        onCreated={async (created) => {
          setCreating(false);
          setJustCreated(created);
          await reload();
        }}
      />

      <NewKeyTokenModal
        created={justCreated}
        companyId={company.id}
        onClose={() => setJustCreated(null)}
      />
    </>
  );
}

/**
 * Where this company's endpoints live. A key only works below this prefix, so
 * it is the one thing a script needs besides the key itself.
 */
function ApiBaseUrl({ companyId }: { companyId: string }) {
  return (
    <CopyableUrl
      label="Base URL"
      url={companyApiBaseUrl(window.location.origin, companyId)}
      copyLabel="Copy the base URL"
      hint="Every request a key for this company makes starts here."
      className="mb-3 border-b border-slate-100 pb-3 dark:border-slate-800"
    />
  );
}

/** A labelled URL with a copy button, wrapping rather than overflowing on a phone. */
function CopyableUrl({
  label,
  url,
  copyLabel,
  hint,
  className,
}: {
  label: string;
  url: string;
  copyLabel: string;
  hint: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState<string | null>(null);
  return (
    <div className={className}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <code className="min-w-0 break-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-700 dark:bg-slate-800 dark:text-slate-200">
          {url}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={copyLabel}
          onClick={async () => {
            setCopyError(null);
            if (await copyToClipboard(url)) setCopied(true);
            else setCopyError("Could not access the clipboard — copy the URL manually.");
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{hint}</p>
      <FormError message={copyError} className="mt-2" />
    </div>
  );
}

/**
 * The apps the Member approved, through OAuth, to use the MCP server as them
 * in this company — claude.ai, ChatGPT — and the place to disconnect one.
 */
function ConnectedAppsCard({ company }: { company: Company }) {
  const [rows, setRows] = React.useState<ConnectedApp[] | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const background = useBackgroundAction();
  const dialog = useDialog();
  const canConnect = mayConnectApps(company.role);

  const reload = React.useCallback(async () => {
    try {
      setRows(await api.get<ConnectedApp[]>(`/api/companies/${company.id}/connected-apps`));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the connected apps"));
      setRows([]);
    }
  }, [company.id]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex items-start gap-2">
          <PlugZap size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Connected apps</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Apps such as claude.ai and ChatGPT that you approved to use the MCP server below as
              you. Each stays connected until you disconnect it, or after {CONNECTED_APP_IDLE_DAYS}{" "}
              days without use.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardBody>
        {loadError ? (
          <FormError message={loadError} />
        ) : rows === null ? (
          <Spinner />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No connected apps"
            description={
              canConnect
                ? "Add the MCP server's endpoint to claude.ai or ChatGPT, and approve the app when Genosyn asks."
                : "Only owners and admins can connect apps that sign in. Use an API key with Claude Desktop, Claude Code or Cursor."
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((app) => (
              <ConnectedAppRow
                key={app.id}
                app={app}
                onDisconnect={async () => {
                  const ok = await dialog.confirm({
                    title: `Disconnect "${app.name}"?`,
                    message:
                      "It stops working at once: its next request to Genosyn is refused. To use it again, connect it from the app.",
                    confirmLabel: "Disconnect",
                    variant: "danger",
                  });
                  if (!ok) return;
                  const now = new Date().toISOString();
                  const replace = (next: ConnectedApp) =>
                    setRows((current) =>
                      current ? current.map((row) => (row.id === app.id ? next : row)) : current,
                    );
                  replace({ ...app, revokedAt: now, revokedReason: "member" });
                  background(
                    async () => {
                      replace(
                        await api.del<ConnectedApp>(
                          `/api/companies/${company.id}/connected-apps/${app.id}`,
                        ),
                      );
                    },
                    {
                      title: "Couldn’t disconnect the app",
                      error: (error) => `${errorMessage(error)} It is still connected.`,
                      onError: () => replace(app),
                    },
                  );
                }}
              />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

const REVOKED_LABELS: Record<NonNullable<ConnectedApp["revokedReason"]>, string> = {
  member: "Disconnected",
  app: "Disconnected by the app",
  reuse: "Disconnected: a token was reused",
};

function ConnectedAppRow({
  app,
  onDisconnect,
}: {
  app: ConnectedApp;
  onDisconnect: () => void | Promise<void>;
}) {
  const revoked = !!app.revokedAt;
  const expired = !revoked && new Date(app.expiresAt).getTime() <= Date.now();
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Cable size={14} className="text-slate-400" />
          <span className="truncate font-medium text-slate-900 dark:text-slate-100">
            {app.name}
          </span>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {appHost(app.redirectOrigin)}
          </code>
          {revoked && (
            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              {REVOKED_LABELS[app.revokedReason ?? "member"]}
            </span>
          )}
          {expired && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              Expired
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <span>Connected {new Date(app.createdAt).toLocaleDateString()}</span>
          <span>
            {app.lastUsedAt
              ? `Last used ${new Date(app.lastUsedAt).toLocaleString()}`
              : "Never used"}
          </span>
          {!revoked && !expired && (
            <span>Expires {new Date(app.expiresAt).toLocaleDateString()} unless used</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!revoked && !expired && (
          <Button variant="ghost" size="sm" onClick={onDisconnect}>
            <Unplug size={12} /> Disconnect
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * The Genosyn MCP server: its endpoint and how to point each client at it.
 * claude.ai and ChatGPT take the endpoint alone and sign in; the rest take a
 * key, shown as a placeholder — the real one is shown only once, when it is
 * generated, and the new-key dialog fills it in there.
 */
function McpServerCard({ company }: { company: Company }) {
  const url = companyMcpUrl(window.location.origin, company.id);
  return (
    <Card className="mt-4">
      <CardHeader>
        <div className="flex items-start gap-2">
          <Cable size={16} className="mt-0.5 shrink-0 text-slate-500 dark:text-slate-400" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">MCP server</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Connect Claude, ChatGPT, Cursor or any MCP client to this company. It acts as one
              Member — you, once you approve an app, or an API key&apos;s Member — and can find,
              read and change whatever they can, and nothing more.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-4">
        <CopyableUrl
          label="Endpoint"
          url={url}
          copyLabel="Copy the MCP endpoint"
          hint="Streamable HTTP. claude.ai and ChatGPT sign in with OAuth; other clients send an API key from above as a Bearer token."
        />
        <McpClientSetupPanel
          url={url}
          token={null}
          clients={MCP_CLIENTS}
          canConnectApps={mayConnectApps(company.role)}
        />
      </CardBody>
    </Card>
  );
}

/** Pick a client, copy its setup. With `token`, the setup carries the real key. */
function McpClientSetupPanel({
  url,
  token,
  clients,
  canConnectApps = true,
}: {
  url: string;
  token: string | null;
  clients: typeof MCP_CLIENTS;
  canConnectApps?: boolean;
}) {
  const [client, setClient] = React.useState<McpClientId>(clients[0].id);
  const [copied, setCopied] = React.useState<McpClientId | null>(null);
  const [copyError, setCopyError] = React.useState<string | null>(null);
  const label = clients.find((candidate) => candidate.id === client)?.label ?? "";
  const setup = mcpClientSetup(client, { url, token });
  const panelId = React.useId();
  return (
    <div className="min-w-0">
      <div className="overflow-x-auto">
        <div
          role="tablist"
          aria-label="MCP client"
          className="flex min-w-max gap-0.5 border-b border-slate-200 dark:border-slate-800"
        >
          {clients.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="tab"
              aria-selected={client === candidate.id}
              aria-controls={panelId}
              onClick={() => {
                setClient(candidate.id);
                setCopyError(null);
              }}
              className={
                "-mb-px whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs font-medium transition " +
                (client === candidate.id
                  ? "border-indigo-600 text-indigo-700 dark:border-indigo-400 dark:text-indigo-300"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")
              }
            >
              {candidate.label}
            </button>
          ))}
        </div>
      </div>
      <div id={panelId} role="tabpanel" aria-label={`${label} setup`} className="mt-2 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-xs text-slate-500 dark:text-slate-400">
            {setup.where}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`Copy the ${label} setup`}
            onClick={async () => {
              setCopyError(null);
              if (await copyToClipboard(setup.snippet)) setCopied(client);
              else setCopyError("Could not access the clipboard — copy the setup manually.");
            }}
          >
            {copied === client ? <Check size={12} /> : <Copy size={12} />}{" "}
            {copied === client ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="mt-1 max-w-full overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
          {setup.snippet}
        </pre>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{setup.note}</p>
        {setup.signsIn && !canConnectApps && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Only owners and admins can approve an app that signs in. Use an API key with Claude
            Desktop, Claude Code or Cursor instead.
          </p>
        )}
        {!setup.signsIn && !token && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Replace <code className="font-mono">{API_KEY_PLACEHOLDER}</code> with a key from above.
          </p>
        )}
        <FormError message={copyError} className="mt-2" />
      </div>
    </div>
  );
}

function ApiKeyRow({ apiKey, onRevoke }: { apiKey: ApiKey; onRevoke: () => void | Promise<void> }) {
  const revoked = !!apiKey.revokedAt;
  const expired = !!apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= Date.now();
  return (
    <li className="flex items-center justify-between gap-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <KeyRound size={14} className="text-slate-400" />
          <span className="truncate font-medium text-slate-900 dark:text-slate-100">
            {apiKey.name}
          </span>
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {apiKey.prefix}…
          </code>
          {revoked && (
            <span className="rounded bg-rose-100 px-1.5 py-0.5 text-xs font-medium text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              Revoked
            </span>
          )}
          {!revoked && expired && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              Expired
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
          <span>Created {new Date(apiKey.createdAt).toLocaleDateString()}</span>
          <span>
            {apiKey.lastUsedAt
              ? `Last used ${new Date(apiKey.lastUsedAt).toLocaleString()}`
              : "Never used"}
          </span>
          {apiKey.expiresAt && !revoked && (
            <span>
              {expired
                ? `Expired ${new Date(apiKey.expiresAt).toLocaleDateString()}`
                : `Expires ${new Date(apiKey.expiresAt).toLocaleDateString()}`}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {!revoked && (
          <Button variant="ghost" size="sm" onClick={onRevoke}>
            <Trash2 size={12} /> Revoke
          </Button>
        )}
      </div>
    </li>
  );
}

function CreateApiKeyModal({
  open,
  companyId,
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  onClose: () => void;
  onCreated: (created: ApiKeyCreated) => void;
}) {
  const [name, setName] = React.useState("");
  const [expiresIn, setExpiresIn] = React.useState<"never" | "30d" | "90d" | "365d">("never");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setName("");
      setExpiresIn("never");
      setError(null);
    }
  }, [open]);

  function computeExpiresAt(): string | null {
    if (expiresIn === "never") return null;
    const days = expiresIn === "30d" ? 30 : expiresIn === "90d" ? 90 : 365;
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  return (
    <Modal open={open} onClose={onClose} title="Generate API key">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setBusy(true);
          try {
            const created = await api.post<ApiKeyCreated>(`/api/companies/${companyId}/api-keys`, {
              name: name.trim(),
              expiresAt: computeExpiresAt(),
            });
            onCreated(created);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <FormError message={error} />
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="GitHub Actions, local CLI, …"
          required
          autoFocus
        />
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Expires
          </label>
          <Select
            value={expiresIn}
            onChange={(e) => setExpiresIn(e.target.value as typeof expiresIn)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
          >
            <option value="never">Never</option>
            <option value="30d">In 30 days</option>
            <option value="90d">In 90 days</option>
            <option value="365d">In 1 year</option>
          </Select>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={name.trim().length === 0}>
            Generate
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function NewKeyTokenModal({
  created,
  companyId,
  onClose,
}: {
  created: ApiKeyCreated | null;
  companyId: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (created) {
      setCopied(false);
      setCopyError(null);
    }
  }, [created]);

  if (!created) return null;

  return (
    <Modal open onClose={onClose} title="Copy your new API key" size="lg">
      <div className="flex flex-col gap-4">
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          This is the only time you&apos;ll see the full token. Store it somewhere safe (a password
          manager, your CI secrets, …) — if you lose it, generate a new one and revoke this one.
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Token
          </label>
          <div className="flex gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
              {created.token}
            </code>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={async () => {
                setCopyError(null);
                const ok = await copyToClipboard(created.token);
                if (ok) {
                  setCopied(true);
                } else {
                  setCopyError("Could not access the clipboard — copy the token manually.");
                }
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <FormError message={copyError} className="mt-2" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Try it
          </label>
          <pre className="overflow-x-auto rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100">
            {apiKeyCurlExample(window.location.origin, companyId, created.token)}
          </pre>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            It answers with the Member the key acts as, their role, and the key.
          </p>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
            Connect an MCP client
          </label>
          <McpClientSetupPanel
            url={companyMcpUrl(window.location.origin, companyId)}
            token={created.token}
            clients={KEY_MCP_CLIENTS}
          />
        </div>
        <div className="flex justify-end pt-2">
          <Button onClick={onClose}>Done</Button>
        </div>
      </div>
    </Modal>
  );
}
