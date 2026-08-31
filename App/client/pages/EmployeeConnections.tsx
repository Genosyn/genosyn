import React from "react";
import { Link, useOutletContext } from "react-router-dom";
import {
  AlertCircle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  CreditCard,
  Database,
  GitFork,
  Github,
  Layers,
  Mail,
  Plug,
  Send,
  Server,
  Table2,
  Trash2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { api, ConnectionGrant, IntegrationCatalogEntry, IntegrationConnection } from "../lib/api";
import { errorMessage } from "../lib/errors";
import { TopBar } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Card, CardBody, CardHeader } from "../components/ui/Card";
import { Spinner } from "../components/ui/Spinner";
import { Modal } from "../components/ui/Modal";
import { EmptyState } from "../components/ui/EmptyState";
import { FormError } from "../components/ui/FormError";
import { useBackgroundAction, useDialog } from "../components/ui/Dialog";
import type { EmployeeOutletCtx } from "./EmployeeLayout";
import { useLiveRefetch } from "../components/CompanySocket";

/**
 * The employee's Connections page, at Settings → Connections. Shows the
 * integration Connections the employee has been granted — i.e. the
 * third-party data sources they can reach via MCP tools on their next spawn.
 * Adding a grant picks from the company's existing Connections; creating new
 * Connections is the AI Employees product Integrations page.
 */

const ICONS: Record<string, LucideIcon> = {
  CreditCard,
  BarChart3,
  BookOpen,
  Database,
  GitFork,
  Github,
  Layers,
  Mail,
  Plug,
  Send,
  Server,
  Table2,
  Zap,
};

function useCtx(): EmployeeOutletCtx {
  return useOutletContext<EmployeeOutletCtx>();
}

export function EmployeeConnections() {
  const { company, emp } = useCtx();
  const dialog = useDialog();
  const background = useBackgroundAction();

  const [grants, setGrants] = React.useState<ConnectionGrant[] | null>(null);
  const [catalog, setCatalog] = React.useState<IntegrationCatalogEntry[]>([]);
  const [pool, setPool] = React.useState<IntegrationConnection[]>([]);
  const [picker, setPicker] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pickError, setPickError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try {
      const [g, cat, conns] = await Promise.all([
        api.get<ConnectionGrant[]>(
          `/api/companies/${company.id}/integrations/employees/${emp.id}/grants`,
        ),
        api.get<IntegrationCatalogEntry[]>(`/api/companies/${company.id}/integrations/catalog`),
        api.get<IntegrationConnection[]>(`/api/companies/${company.id}/integrations/connections`),
      ]);
      setGrants(g);
      setCatalog(cat);
      setPool(conns);
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err, "Could not load the connections"));
      setGrants([]);
    }
  }, [company.id, emp.id]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  useLiveRefetch(["connection", "grant"], reload);

  async function revoke(grant: ConnectionGrant) {
    const ok = await dialog.confirm({
      title: `Revoke ${grant.connection.label}?`,
      message: `${emp.name} loses access to this connection on their next spawn.`,
      confirmLabel: "Revoke",
      variant: "danger",
    });
    if (!ok) return;
    const originalIndex = grants?.findIndex((item) => item.id === grant.id) ?? -1;
    setGrants((current) => current?.filter((item) => item.id !== grant.id) ?? current);
    background(
      () =>
        api.del(
          `/api/companies/${company.id}/integrations/employees/${emp.id}/grants/${grant.connectionId}`,
        ),
      {
        title: "Couldn’t revoke access",
        error: (error) => `${errorMessage(error)} The grant has been restored.`,
        onError: () => {
          setGrants((current) => {
            if (!current || current.some((item) => item.id === grant.id)) return current;
            const next = [...current];
            next.splice(Math.max(0, Math.min(originalIndex, next.length)), 0, grant);
            return next;
          });
        },
      },
    );
  }

  const grantedIds = React.useMemo(
    () => new Set((grants ?? []).map((g) => g.connectionId)),
    [grants],
  );
  const grantable = React.useMemo(
    () => pool.filter((c) => !grantedIds.has(c.id)),
    [pool, grantedIds],
  );

  return (
    <>
      <TopBar
        title="Connections"
        right={
          <Button onClick={() => setPicker(true)} disabled={pool.length === 0}>
            <Plug size={14} /> Grant access
          </Button>
        }
      />
      <Card>
      <CardHeader>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Third-party accounts {emp.name} can reach through MCP tools on their next spawn.
        </p>
      </CardHeader>
      <CardBody>
        {loadError ? (
          <FormError message={loadError} />
        ) : grants === null ? (
          <Spinner />
        ) : pool.length === 0 ? (
          <EmptyState
            title="No connections in this company yet"
            description="Connect Stripe, Google Workspace, or GitHub in AI Employees → Integrations before granting access."
            action={
              <Link
                to={`/c/${company.slug}/employees/integrations`}
                className="text-sm font-medium text-indigo-600 hover:underline dark:text-indigo-400"
              >
                Open Integrations →
              </Link>
            }
          />
        ) : grants.length === 0 ? (
          <EmptyState
            title="No grants yet"
            description={`Give ${emp.name} access to one of your company's connections.`}
            action={
              <Button size="sm" onClick={() => setPicker(true)}>
                Grant access
              </Button>
            }
          />
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {grants.map((g) => {
              const entry = catalog.find((e) => e.provider === g.connection.provider);
              const Icon = entry ? (ICONS[entry.icon] ?? Plug) : Plug;
              return (
                <li key={g.id} className="flex items-center gap-3 py-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{g.connection.label}</span>
                      <StatusBadge
                        status={g.connection.status}
                        message={g.connection.statusMessage}
                      />
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {entry?.name ?? g.connection.provider} · {g.connection.accountHint || "—"}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => revoke(g)}>
                    <Trash2 size={12} />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
      </Card>

      <GrantPickerModal
        open={picker}
        onClose={() => {
          setPicker(false);
          setPickError(null);
        }}
        onPick={async (connection) => {
          setPickError(null);
          try {
            await api.post<ConnectionGrant>(
              `/api/companies/${company.id}/integrations/employees/${emp.id}/grants`,
              { connectionId: connection.id },
            );
            setPicker(false);
            reload();
          } catch (err) {
            setPickError(errorMessage(err));
          }
        }}
        error={pickError}
        options={grantable}
        catalog={catalog}
      />
    </>
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

function GrantPickerModal({
  open,
  onClose,
  onPick,
  error,
  options,
  catalog,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (c: IntegrationConnection) => void;
  error: string | null;
  options: IntegrationConnection[];
  catalog: IntegrationCatalogEntry[];
}) {
  return (
    <Modal open={open} onClose={onClose} title="Grant access to a connection" size="lg">
      <FormError message={error} className="mb-3" />
      {options.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Every company connection is already granted to this employee. Add more in Settings →
          Integrations.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {options.map((c) => {
            const entry = catalog.find((e) => e.provider === c.provider);
            const Icon = entry ? (ICONS[entry.icon] ?? Plug) : Plug;
            return (
              <li key={c.id}>
                <button
                  onClick={() => onPick(c)}
                  className="flex w-full items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-indigo-700 dark:hover:bg-indigo-950/30"
                >
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                      {c.label}
                    </div>
                    <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                      {entry?.name ?? c.provider} · {c.accountHint || "—"}
                    </div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
