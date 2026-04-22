import React from "react";
import { useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  CreditCard,
  Database,
  Mail,
  Plug,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  Company,
  IntegrationCatalogEntry,
  IntegrationCatalogField,
  IntegrationConnection,
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
 * Company-level **Integrations** page. Two panels:
 *   - "Your connections" — every IntegrationConnection for this company,
 *     with status, account hint, refresh, and delete.
 *   - "Available" — the static catalog. Click to add a connection
 *     (API-key → modal; OAuth → popup).
 *
 * AI employees gain access to a connection via a Grant, managed on the
 * per-employee Connections tab.
 */

const ICONS: Record<string, LucideIcon> = {
  CreditCard,
  BarChart3,
  Database,
  Mail,
  Plug,
};

function useCtx(): SettingsOutletCtx {
  return useOutletContext<SettingsOutletCtx>();
}

export function SettingsIntegrations() {
  const { company } = useCtx();
  const { toast } = useToast();
  const dialog = useDialog();

  const [catalog, setCatalog] = React.useState<IntegrationCatalogEntry[] | null>(null);
  const [connections, setConnections] = React.useState<IntegrationConnection[] | null>(null);
  const [adding, setAdding] = React.useState<IntegrationCatalogEntry | null>(null);
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const [cat, conns] = await Promise.all([
        api.get<IntegrationCatalogEntry[]>(
          `/api/companies/${company.id}/integrations/catalog`,
        ),
        api.get<IntegrationConnection[]>(
          `/api/companies/${company.id}/integrations/connections`,
        ),
      ]);
      setCatalog(cat);
      setConnections(conns);
    } catch (err) {
      toast((err as Error).message, "error");
      setCatalog([]);
      setConnections([]);
    }
  }, [company.id, toast]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  // When an OAuth popup finishes, it posts a message to the opener window
  // (this page). Refresh the list on success so the new connection appears.
  React.useEffect(() => {
    function handler(ev: MessageEvent) {
      const data = ev.data as { source?: string; ok?: boolean; title?: string; detail?: string } | null;
      if (!data || data.source !== "genosyn-oauth") return;
      if (data.ok) {
        toast(data.title ?? "Connected", "success");
        reload();
      } else {
        toast(data.detail ?? data.title ?? "OAuth failed", "error");
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [reload, toast]);

  const byProvider = React.useMemo(() => {
    const out = new Map<string, IntegrationConnection[]>();
    if (!connections) return out;
    for (const c of connections) {
      const arr = out.get(c.provider) ?? [];
      arr.push(c);
      out.set(c.provider, arr);
    }
    return out;
  }, [connections]);

  async function startConnect(entry: IntegrationCatalogEntry) {
    if (!entry.enabled) {
      toast(entry.disabledReason ?? "Integration not enabled", "error");
      return;
    }
    if (entry.authMode === "oauth2") {
      try {
        const { authorizeUrl } = await api.post<{ authorizeUrl: string }>(
          `/api/companies/${company.id}/integrations/oauth/start`,
          { provider: entry.provider, label: defaultLabel(entry) },
        );
        const popup = window.open(authorizeUrl, "genosyn-oauth", "width=520,height=700");
        if (!popup) {
          toast("Popup blocked — allow popups for this site and try again.", "error");
        }
      } catch (err) {
        toast((err as Error).message, "error");
      }
      return;
    }
    setAdding(entry);
  }

  async function refreshStatus(conn: IntegrationConnection) {
    setRefreshingId(conn.id);
    try {
      const updated = await api.post<IntegrationConnection>(
        `/api/companies/${company.id}/integrations/connections/${conn.id}/check`,
      );
      setConnections((prev) =>
        (prev ?? []).map((c) => (c.id === updated.id ? updated : c)),
      );
      if (updated.status === "connected") {
        toast("Connection is healthy", "success");
      } else {
        toast(updated.statusMessage || "Connection reports an error", "error");
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setRefreshingId(null);
    }
  }

  async function removeConnection(conn: IntegrationConnection) {
    const ok = await dialog.confirm({
      title: `Disconnect ${conn.label}?`,
      message:
        "Every AI employee that has a grant on this connection will lose access on their next spawn.",
      confirmLabel: "Disconnect",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/integrations/connections/${conn.id}`);
      setConnections((prev) => (prev ?? []).filter((c) => c.id !== conn.id));
      toast("Disconnected", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <>
      <TopBar title="Integrations" />

      <section className="mb-6">
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold">Your connections</h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Third-party accounts your AI employees can access once granted. Credentials are encrypted at rest.
            </p>
          </CardHeader>
          <CardBody>
            {connections === null ? (
              <Spinner />
            ) : connections.length === 0 ? (
              <EmptyState
                title="No connections yet"
                description="Pick an integration below to connect your first account."
              />
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {connections.map((c) => {
                  const entry = catalog?.find((e) => e.provider === c.provider);
                  const Icon = entry ? ICONS[entry.icon] ?? Plug : Plug;
                  return (
                    <li key={c.id} className="flex items-center gap-3 py-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                        <Icon size={16} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm font-medium">
                          <span className="truncate">{c.label}</span>
                          <StatusBadge status={c.status} message={c.statusMessage} />
                        </div>
                        <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {entry?.name ?? c.provider} · {c.accountHint || "—"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => refreshStatus(c)}
                          disabled={refreshingId === c.id}
                          title="Check status"
                        >
                          <RefreshCw
                            size={12}
                            className={refreshingId === c.id ? "animate-spin" : ""}
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeConnection(c)}
                        >
                          <Trash2 size={12} />
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Available integrations</h2>
        {catalog === null ? (
          <Spinner />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {catalog.map((entry) => {
              const Icon = ICONS[entry.icon] ?? Plug;
              const existing = byProvider.get(entry.provider)?.length ?? 0;
              return (
                <button
                  key={entry.provider}
                  onClick={() => startConnect(entry)}
                  disabled={!entry.enabled}
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
                      {existing > 0 && (
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          {existing} connected
                        </span>
                      )}
                      <span className="ml-auto text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
                        {entry.authMode === "oauth2" ? "OAuth" : "API key"}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {entry.tagline}
                    </p>
                    {!entry.enabled && entry.disabledReason && (
                      <p className="mt-2 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                        <AlertCircle size={12} className="mt-0.5 shrink-0" />
                        <span>{entry.disabledReason}</span>
                      </p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <ApiKeyModal
        open={adding !== null}
        entry={adding}
        companyId={company.id}
        onClose={() => setAdding(null)}
        onSaved={async () => {
          setAdding(null);
          await reload();
        }}
      />
    </>
  );
}

function defaultLabel(entry: IntegrationCatalogEntry): string {
  return entry.name;
}

function StatusBadge({
  status,
  message,
}: {
  status: IntegrationConnection["status"];
  message: string;
}) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
        <CheckCircle2 size={10} /> Connected
      </span>
    );
  }
  return (
    <span
      title={message}
      className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
    >
      <AlertCircle size={10} /> {status === "expired" ? "Expired" : "Error"}
    </span>
  );
}

function ApiKeyModal({
  open,
  entry,
  companyId,
  onClose,
  onSaved,
}: {
  open: boolean;
  entry: IntegrationCatalogEntry | null;
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = React.useState("");
  const [fields, setFields] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const { toast } = useToast();

  React.useEffect(() => {
    if (open && entry) {
      setLabel(entry.name);
      setFields({});
    }
  }, [open, entry]);

  if (!entry || entry.authMode !== "apikey") return null;

  return (
    <Modal open={open} onClose={onClose} title={`Connect ${entry.name}`} size="lg">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.post(`/api/companies/${companyId}/integrations/connections`, {
              provider: entry.provider,
              label: label.trim() || entry.name,
              fields,
            });
            toast(`${entry.name} connected`, "success");
            onSaved();
          } catch (err) {
            toast((err as Error).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        {entry.description && (
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {entry.description}
          </p>
        )}
        <Input
          label="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={entry.name}
          required
        />
        {(entry.fields ?? []).map((f: IntegrationCatalogField) => (
          <div key={f.key}>
            <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
              {f.label}
              {f.required && <span className="ml-1 text-red-500">*</span>}
            </label>
            <input
              type={f.type === "password" ? "password" : "text"}
              required={f.required}
              placeholder={f.placeholder}
              value={fields[f.key] ?? ""}
              onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
            />
            {f.hint && (
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{f.hint}</p>
            )}
          </div>
        ))}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? "Testing…" : "Connect"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
