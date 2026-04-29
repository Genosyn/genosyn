import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  Antenna,
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  CreditCard,
  Database,
  Github,
  Layers,
  Mail,
  Pencil,
  Plug,
  Plug2,
  RefreshCw,
  Search,
  Send,
  Server,
  Table2,
  Trash2,
  Twitter,
  Users,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  api,
  Company,
  ConnectionGrantWithEmployee,
  Employee,
  IntegrationCatalogEntry,
  IntegrationCatalogField,
  IntegrationConnection,
  INTEGRATION_CATEGORY_ORDER,
  type IntegrationCategory,
} from "../lib/api";
import { Avatar, employeeAvatarUrl } from "../components/ui/Avatar";
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
  Antenna,
  BarChart3,
  BookOpen,
  CreditCard,
  Database,
  Github,
  Layers,
  Mail,
  Plug,
  Send,
  Server,
  Table2,
  Twitter,
  Workflow,
  Zap,
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
  const [addingApiKey, setAddingApiKey] = React.useState<IntegrationCatalogEntry | null>(null);
  const [addingGoogle, setAddingGoogle] = React.useState<IntegrationCatalogEntry | null>(null);
  const [reconnecting, setReconnecting] = React.useState<{
    entry: IntegrationCatalogEntry;
    conn: IntegrationConnection;
  } | null>(null);
  const [refreshingId, setRefreshingId] = React.useState<string | null>(null);
  const [managing, setManaging] = React.useState<IntegrationConnection | null>(null);
  const [search, setSearch] = React.useState("");

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

  const groupedCatalog = React.useMemo(() => {
    if (!catalog) return [] as Array<{ category: IntegrationCategory; entries: IntegrationCatalogEntry[] }>;
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? catalog.filter((e) => {
          const hay = `${e.name} ${e.tagline} ${e.description ?? ""} ${e.provider} ${e.category}`.toLowerCase();
          return hay.includes(needle);
        })
      : catalog;
    const groups = new Map<IntegrationCategory, IntegrationCatalogEntry[]>();
    for (const entry of filtered) {
      const arr = groups.get(entry.category) ?? [];
      arr.push(entry);
      groups.set(entry.category, arr);
    }
    return INTEGRATION_CATEGORY_ORDER.flatMap((category) => {
      const entries = groups.get(category);
      if (!entries || entries.length === 0) return [];
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return [{ category, entries }];
    });
  }, [catalog, search]);

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
    // OAuth integrations now collect clientId / secret per Connection,
    // and Google additionally supports service-account JSON. Both flows
    // open a unified modal; API-key integrations keep their old form.
    if (entry.oauth || entry.serviceAccount) {
      setAddingGoogle(entry);
      return;
    }
    setAddingApiKey(entry);
  }

  async function reconnect(conn: IntegrationConnection) {
    const entry = catalog?.find((e) => e.provider === conn.provider);
    if (!entry) {
      toast(`Unknown integration: ${conn.provider}`, "error");
      return;
    }
    setReconnecting({ entry, conn });
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

  async function renameConnection(conn: IntegrationConnection) {
    const next = await dialog.prompt({
      title: "Rename connection",
      defaultValue: conn.label,
      placeholder: "Stripe US",
      confirmLabel: "Rename",
      validate: (v) => (v.trim().length === 0 ? "Label is required" : null),
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed === conn.label) return;
    try {
      const updated = await api.patch<IntegrationConnection>(
        `/api/companies/${company.id}/integrations/connections/${conn.id}`,
        { label: trimmed },
      );
      setConnections((prev) =>
        (prev ?? []).map((c) => (c.id === updated.id ? updated : c)),
      );
      toast("Connection renamed", "success");
    } catch (err) {
      toast((err as Error).message, "error");
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
                          <AuthModeBadge mode={c.authMode} />
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
                          onClick={() => setManaging(c)}
                          title="Manage employee access"
                        >
                          <Users size={12} /> Access
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => renameConnection(c)}
                          title="Rename"
                        >
                          <Pencil size={12} />
                        </Button>
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
                          onClick={() => reconnect(c)}
                          title="Reconnect"
                        >
                          <Plug2 size={12} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeConnection(c)}
                          title="Disconnect"
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
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-sm font-semibold">Available integrations</h2>
          <div className="relative ml-auto w-full max-w-xs">
            <Search
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search integrations…"
              className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-8 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 dark:placeholder:text-slate-500 dark:focus:border-indigo-700 dark:focus:ring-indigo-900"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                aria-label="Clear search"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        {catalog === null ? (
          <Spinner />
        ) : groupedCatalog.length === 0 ? (
          <EmptyState
            title="No matching integrations"
            description={`No integrations match "${search.trim()}". Try a different keyword or clear the search.`}
          />
        ) : (
          <div className="flex flex-col gap-6">
            {groupedCatalog.map(({ category, entries }) => (
              <div key={category}>
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    {category}
                  </h3>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">
                    {entries.length}
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {entries.map((entry) => {
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
              </div>
            ))}
          </div>
        )}
      </section>

      <ApiKeyModal
        open={
          addingApiKey !== null ||
          (reconnecting !== null && reconnecting.conn.authMode === "apikey")
        }
        entry={
          addingApiKey ??
          (reconnecting?.conn.authMode === "apikey" ? reconnecting.entry : null)
        }
        reconnect={
          reconnecting?.conn.authMode === "apikey"
            ? { connectionId: reconnecting.conn.id, label: reconnecting.conn.label }
            : null
        }
        companyId={company.id}
        onClose={() => {
          setAddingApiKey(null);
          setReconnecting(null);
        }}
        onSaved={async () => {
          setAddingApiKey(null);
          setReconnecting(null);
          await reload();
        }}
      />
      <OauthOrServiceAccountModal
        open={
          addingGoogle !== null ||
          (reconnecting !== null &&
            (reconnecting.conn.authMode === "oauth2" ||
              reconnecting.conn.authMode === "service_account"))
        }
        entry={
          addingGoogle ??
          (reconnecting?.conn.authMode === "oauth2" ||
          reconnecting?.conn.authMode === "service_account"
            ? reconnecting.entry
            : null)
        }
        reconnect={
          reconnecting?.conn.authMode === "oauth2" ||
          reconnecting?.conn.authMode === "service_account"
            ? {
                connectionId: reconnecting.conn.id,
                label: reconnecting.conn.label,
                authMode: reconnecting.conn.authMode,
                scopeGroups: reconnecting.conn.scopeGroups,
              }
            : null
        }
        companyId={company.id}
        onClose={() => {
          setAddingGoogle(null);
          setReconnecting(null);
        }}
        onSaved={async () => {
          setAddingGoogle(null);
          setReconnecting(null);
          await reload();
        }}
      />
      <ManageAccessModal
        open={managing !== null}
        connection={managing}
        company={company}
        catalog={catalog ?? []}
        onClose={() => setManaging(null)}
      />
    </>
  );
}

function defaultLabel(entry: IntegrationCatalogEntry): string {
  return entry.name;
}

/**
 * Per-connection grant manager. Shows every AI employee in the company and
 * lets the user toggle access on/off without leaving the Integrations page.
 * Mirrors the per-employee `EmployeeConnections` flow with the axes flipped.
 */
function ManageAccessModal({
  open,
  connection,
  company,
  catalog,
  onClose,
}: {
  open: boolean;
  connection: IntegrationConnection | null;
  company: Company;
  catalog: IntegrationCatalogEntry[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [grants, setGrants] = React.useState<ConnectionGrantWithEmployee[] | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open || !connection) return;
    let cancelled = false;
    setEmployees(null);
    setGrants(null);
    (async () => {
      try {
        const [emps, gs] = await Promise.all([
          api.get<Employee[]>(`/api/companies/${company.id}/employees`),
          api.get<ConnectionGrantWithEmployee[]>(
            `/api/companies/${company.id}/integrations/connections/${connection.id}/grants`,
          ),
        ]);
        if (cancelled) return;
        setEmployees(emps);
        setGrants(gs);
      } catch (err) {
        if (cancelled) return;
        toast((err as Error).message, "error");
        setEmployees([]);
        setGrants([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, connection, company.id, toast]);

  const grantedIds = React.useMemo(
    () => new Set((grants ?? []).map((g) => g.employeeId)),
    [grants],
  );

  async function grant(emp: Employee) {
    if (!connection) return;
    setBusyId(emp.id);
    try {
      const created = await api.post<ConnectionGrantWithEmployee>(
        `/api/companies/${company.id}/integrations/employees/${emp.id}/grants`,
        { connectionId: connection.id },
      );
      // The /employees/:eid/grants response embeds `connection`, not
      // `employee` — synthesize the employee shape locally so the row
      // updates without a refetch.
      setGrants((prev) => [
        ...(prev ?? []),
        {
          id: created.id,
          employeeId: emp.id,
          connectionId: connection.id,
          createdAt: created.createdAt,
          employee: {
            id: emp.id,
            name: emp.name,
            slug: emp.slug,
            role: emp.role,
            avatarKey: emp.avatarKey ?? null,
          },
        },
      ]);
      toast(`Granted ${emp.name}`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  }

  async function revoke(emp: Employee) {
    if (!connection) return;
    setBusyId(emp.id);
    try {
      await api.del(
        `/api/companies/${company.id}/integrations/employees/${emp.id}/grants/${connection.id}`,
      );
      setGrants((prev) => (prev ?? []).filter((g) => g.employeeId !== emp.id));
      toast(`Revoked ${emp.name}`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusyId(null);
    }
  }

  if (!connection) return null;

  const entry = catalog.find((e) => e.provider === connection.provider);
  const Icon = entry ? ICONS[entry.icon] ?? Plug : Plug;
  const ready = employees !== null && grants !== null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Manage access · ${connection.label}`}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-3 rounded-lg bg-slate-50 p-3 dark:bg-slate-800/60">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-slate-700 shadow-sm dark:bg-slate-900 dark:text-slate-200">
            <Icon size={16} />
          </div>
          <div className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-300">
            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
              {entry?.name ?? connection.provider}
              {connection.accountHint && (
                <span className="ml-1 font-normal text-slate-500 dark:text-slate-400">
                  · {connection.accountHint}
                </span>
              )}
            </div>
            <p className="mt-0.5">
              Pick which AI employees can use this connection through their MCP tools on the next spawn.
            </p>
          </div>
        </div>

        {!ready ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : employees!.length === 0 ? (
          <EmptyState
            title="No AI employees yet"
            description="Create an AI employee before granting connection access."
            action={
              <Link
                to={`/c/${company.slug}/employees`}
                className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open Employees →
              </Link>
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {employees!.map((emp) => {
              const isGranted = grantedIds.has(emp.id);
              const isBusy = busyId === emp.id;
              return (
                <li
                  key={emp.id}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"
                >
                  <Avatar
                    name={emp.name}
                    kind="ai"
                    size="md"
                    src={employeeAvatarUrl(company.id, emp.id, emp.avatarKey ?? null)}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {emp.name}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {emp.role}
                    </div>
                  </div>
                  {isGranted ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                        <Check size={10} /> Granted
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => revoke(emp)}
                        disabled={isBusy}
                      >
                        Revoke
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => grant(emp)}
                      disabled={isBusy}
                    >
                      Grant access
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex justify-end pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AuthModeBadge({ mode }: { mode: IntegrationConnection["authMode"] }) {
  const label =
    mode === "oauth2"
      ? "OAuth"
      : mode === "service_account"
        ? "Service account"
        : "API key";
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      {label}
    </span>
  );
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
  reconnect,
  companyId,
  onClose,
  onSaved,
}: {
  open: boolean;
  entry: IntegrationCatalogEntry | null;
  reconnect: { connectionId: string; label: string } | null;
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
      setLabel(reconnect?.label ?? entry.name);
      setFields({});
    }
  }, [open, entry, reconnect]);

  if (!entry || entry.authMode !== "apikey") return null;

  const isReconnect = reconnect !== null;
  const title = isReconnect
    ? `Reconnect ${reconnect.label}`
    : `Connect ${entry.name}`;

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            if (isReconnect) {
              await api.put(
                `/api/companies/${companyId}/integrations/connections/${reconnect.connectionId}/credentials`,
                { fields },
              );
              toast(`${entry.name} reconnected`, "success");
            } else {
              await api.post(`/api/companies/${companyId}/integrations/connections`, {
                provider: entry.provider,
                label: label.trim() || entry.name,
                fields,
              });
              toast(`${entry.name} connected`, "success");
            }
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
            {isReconnect
              ? `Replace the credentials for "${reconnect.label}". Existing employee grants and the connection id are preserved.`
              : entry.description}
          </p>
        )}
        {!isReconnect && (
          <Input
            label="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={entry.name}
            required
          />
        )}
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
            {busy ? "Testing…" : isReconnect ? "Reconnect" : "Connect"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type ConnectMode = "oauth" | "service_account";

function OauthOrServiceAccountModal({
  open,
  entry,
  reconnect,
  companyId,
  onClose,
  onSaved,
}: {
  open: boolean;
  entry: IntegrationCatalogEntry | null;
  reconnect: {
    connectionId: string;
    label: string;
    authMode: "oauth2" | "service_account";
    scopeGroups: string[];
  } | null;
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const supportsOauth = !!entry?.oauth;
  const supportsSa = !!entry?.serviceAccount;
  const isReconnect = reconnect !== null;
  // Reconnect locks the auth mode to whatever the existing connection
  // already uses; we never silently change auth modes mid-flight (that
  // would orphan the client credentials).
  const [mode, setMode] = React.useState<ConnectMode>("oauth");
  const [label, setLabel] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");
  const [keyJson, setKeyJson] = React.useState("");
  const [impersonationEmail, setImpersonationEmail] = React.useState("");
  const [selectedScopeGroups, setSelectedScopeGroups] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open && entry) {
      const initialMode: ConnectMode = isReconnect
        ? reconnect.authMode === "oauth2"
          ? "oauth"
          : "service_account"
        : supportsOauth
          ? "oauth"
          : "service_account";
      setMode(initialMode);
      setLabel(reconnect?.label ?? defaultLabel(entry));
      setClientId("");
      setClientSecret("");
      setKeyJson("");
      setImpersonationEmail("");
      // Default to all available scope groups checked. For reconnect with a
      // non-empty stored selection, prefill from that. Legacy connections
      // (empty stored array) fall back to "all" so the user sees the
      // current grant rather than an empty list.
      const allGroupKeys = (
        initialMode === "oauth"
          ? entry.oauth?.scopeGroups
          : entry.serviceAccount?.scopeGroups
      )?.map((g) => g.key) ?? [];
      const stored = reconnect?.scopeGroups ?? [];
      setSelectedScopeGroups(stored.length > 0 ? stored : allGroupKeys);
    }
  }, [open, entry, supportsOauth, isReconnect, reconnect]);

  if (!entry) return null;

  async function submitOauth(e: React.FormEvent) {
    e.preventDefault();
    if (!entry) return;
    setBusy(true);
    try {
      const isOauthReconnect = isReconnect && reconnect.authMode === "oauth2";
      const { authorizeUrl } = isOauthReconnect
        ? await api.post<{ authorizeUrl: string }>(
            `/api/companies/${companyId}/integrations/connections/${reconnect.connectionId}/reconnect/oauth`,
            { scopeGroups: selectedScopeGroups },
          )
        : await api.post<{ authorizeUrl: string }>(
            `/api/companies/${companyId}/integrations/oauth/start`,
            {
              provider: entry.provider,
              label: label.trim() || entry.name,
              clientId: clientId.trim(),
              clientSecret: clientSecret.trim(),
              scopeGroups: selectedScopeGroups,
            },
          );
      const popup = window.open(authorizeUrl, "genosyn-oauth", "width=520,height=700");
      if (!popup) {
        toast("Popup blocked — allow popups for this site and try again.", "error");
      } else {
        // Close modal optimistically; the parent listens for the popup's
        // postMessage and refreshes the connection list on success.
        onSaved();
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function submitServiceAccount(e: React.FormEvent) {
    e.preventDefault();
    if (!entry) return;
    setBusy(true);
    try {
      if (isReconnect) {
        await api.put(
          `/api/companies/${companyId}/integrations/connections/${reconnect.connectionId}/service-account`,
          {
            keyJson,
            impersonationEmail: impersonationEmail.trim() || undefined,
            scopeGroups: selectedScopeGroups,
          },
        );
        toast(`${entry.name} reconnected`, "success");
      } else {
        await api.post(
          `/api/companies/${companyId}/integrations/connections/service-account`,
          {
            provider: entry.provider,
            label: label.trim() || entry.name,
            keyJson,
            impersonationEmail: impersonationEmail.trim() || undefined,
            scopeGroups: selectedScopeGroups,
          },
        );
        toast(`${entry.name} connected`, "success");
      }
      onSaved();
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleScopeGroup(key: string) {
    setSelectedScopeGroups((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  const oauthApp = entry?.oauth?.app ?? "google";
  const redirectUri =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/integrations/oauth/callback/${oauthApp}`
      : "";
  // Per-provider OAuth setup copy. Each entry knows where the user must
  // register the OAuth client and what the resulting client id looks
  // like, so the connect form can show concrete instructions instead of
  // generic OAuth boilerplate.
  const oauthSetup =
    oauthApp === "x"
      ? {
          consoleStep:
            "developer.x.com → Projects & Apps → your project → Keys and tokens → User authentication settings → enable OAuth 2.0 (Confidential client).",
          clientIdPlaceholder: "Client ID (looks like a 25-char base64-ish string)",
          clientSecretPlaceholder: "Client Secret",
          consentTitle: "X",
        }
      : {
          consoleStep:
            "Google Cloud Console → APIs & Services → Credentials → Create OAuth Client ID (Web application).",
          clientIdPlaceholder: "123456789-abcdef.apps.googleusercontent.com",
          clientSecretPlaceholder: "GOCSPX-…",
          consentTitle: "Google",
        };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isReconnect ? `Reconnect ${reconnect.label}` : `Connect ${entry.name}`}
      size="lg"
    >
      <div className="flex flex-col gap-4">
        {isReconnect ? (
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {reconnect.authMode === "oauth2"
              ? `Re-run ${oauthSetup.consentTitle}'s consent screen for "${reconnect.label}" to refresh tokens or change which products this connection can access. The connection id and existing employee grants are preserved.`
              : `Replace the service-account JSON for "${reconnect.label}". Existing employee grants and the connection id are preserved.`}
          </p>
        ) : entry.description ? (
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
            {entry.description}
          </p>
        ) : null}

        {!isReconnect && supportsOauth && supportsSa && (
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-xs dark:bg-slate-800">
            <button
              type="button"
              onClick={() => setMode("oauth")}
              className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                mode === "oauth"
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              OAuth
            </button>
            <button
              type="button"
              onClick={() => setMode("service_account")}
              className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                mode === "service_account"
                  ? "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100"
                  : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              }`}
            >
              Service account
            </button>
          </div>
        )}

        {mode === "oauth" && supportsOauth ? (
          <form className="flex flex-col gap-3" onSubmit={submitOauth}>
            {!isReconnect && (
              <>
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300">
                  <p className="font-medium">Set up an OAuth Client ID first</p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-4">
                    <li>{oauthSetup.consoleStep}</li>
                    <li>
                      Add this redirect URI under <em>Authorized redirect URIs</em>:
                      <code className="ml-1 break-all rounded bg-amber-100 px-1 py-0.5 font-mono dark:bg-amber-900/40">
                        {redirectUri}
                      </code>
                    </li>
                    <li>Paste the resulting Client ID and Client Secret below.</li>
                  </ol>
                </div>
                <Input
                  label="Label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder={entry.name}
                  required
                />
                <Input
                  label="OAuth Client ID"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={oauthSetup.clientIdPlaceholder}
                  required
                />
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                    OAuth Client Secret <span className="ml-1 text-red-500">*</span>
                  </label>
                  <input
                    type="password"
                    required
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder={oauthSetup.clientSecretPlaceholder}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-mono shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
                  />
                  <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                    Encrypted at rest with the app&apos;s session secret. Used to refresh access tokens.
                  </p>
                </div>
              </>
            )}
            <ScopeGroupPicker
              groups={entry.oauth?.scopeGroups ?? []}
              selected={selectedScopeGroups}
              onToggle={toggleScopeGroup}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  selectedScopeGroups.length === 0 ||
                  (!isReconnect && (!clientId.trim() || !clientSecret.trim()))
                }
              >
                {busy
                  ? "Starting…"
                  : isReconnect
                    ? "Reconnect"
                    : `Connect with ${entry.name}`}
              </Button>
            </div>
          </form>
        ) : null}

        {mode === "service_account" && supportsSa ? (
          <form className="flex flex-col gap-3" onSubmit={submitServiceAccount}>
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300">
              <p className="font-medium">Service account JSON key</p>
              <p className="mt-1">
                Google Cloud Console → IAM &amp; Admin → Service Accounts → pick or create one → Keys → Add key → JSON. Paste the entire downloaded file below.
              </p>
              {entry.serviceAccount?.impersonation && (
                <p className="mt-2">
                  Service accounts can&apos;t read personal Gmail. To act on a Workspace user&apos;s mailbox, set <em>domain-wide delegation</em> in the Workspace Admin Console (Security → API controls) and provide the user&apos;s email below.
                </p>
              )}
            </div>
            {!isReconnect && (
              <Input
                label="Label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={entry.name}
                required
              />
            )}
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">
                Service account JSON <span className="ml-1 text-red-500">*</span>
              </label>
              <textarea
                required
                value={keyJson}
                onChange={(e) => setKeyJson(e.target.value)}
                placeholder='{ "type": "service_account", "project_id": "…", "private_key": "…", "client_email": "…", … }'
                rows={8}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-[11px] shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 dark:bg-slate-900 dark:border-slate-600"
              />
              <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                Encrypted at rest. The private key never leaves the server.
              </p>
            </div>
            {entry.serviceAccount?.impersonation && (
              <Input
                label="Impersonate user (optional)"
                value={impersonationEmail}
                onChange={(e) => setImpersonationEmail(e.target.value)}
                placeholder="user@yourcompany.com"
                type="email"
              />
            )}
            <ScopeGroupPicker
              groups={entry.serviceAccount?.scopeGroups ?? []}
              selected={selectedScopeGroups}
              onToggle={toggleScopeGroup}
            />
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={busy || !keyJson.trim() || selectedScopeGroups.length === 0}
              >
                {busy
                  ? "Validating…"
                  : isReconnect
                    ? "Reconnect"
                    : "Save service account"}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Modal>
  );
}

/**
 * Render a list of provider-defined scope bundles as checkboxes. Used by
 * both the OAuth and Service Account flows so the user can pick which
 * services (Mail, Calendar, Drive, …) the connection is allowed to touch.
 */
function ScopeGroupPicker({
  groups,
  selected,
  onToggle,
}: {
  groups: { key: string; label: string; description: string; required?: boolean; workspaceOnly?: boolean }[];
  selected: string[];
  onToggle: (key: string) => void;
}) {
  if (groups.length === 0) return null;
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-700 dark:text-slate-200">
        What can this connection access?
      </label>
      <p className="mb-2 text-[11px] text-slate-500 dark:text-slate-400">
        Pick the products this connection can touch. You can change this later by reconnecting.
      </p>
      <div className="flex flex-col divide-y divide-slate-100 rounded-md border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
        {groups.map((g) => {
          const checked = selected.includes(g.key) || !!g.required;
          return (
            <label
              key={g.key}
              className="flex cursor-pointer items-start gap-2.5 p-2.5 transition hover:bg-slate-50 dark:hover:bg-slate-800/40"
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!!g.required}
                onChange={() => onToggle(g.key)}
                className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 dark:border-slate-600 dark:bg-slate-900"
              />
              <span className="flex-1 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-slate-900 dark:text-slate-100">
                  {g.label}
                  {g.workspaceOnly && (
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      Workspace only
                    </span>
                  )}
                  {g.required && (
                    <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wider text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                      Required
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">
                  {g.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
