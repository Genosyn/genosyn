import React from "react";
import { ArrowRight, Bot, CheckCircle2, LockKeyhole, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { api, type Company, type Employee } from "@/lib/api";

export type ExploreAiConnection = {
  id: string;
  provider: string;
  label: string;
  accountHint: string;
  status: string;
};

type ConnectionGrant = {
  employeeId: string;
};

/**
 * Explore's human-to-AI handoff. A Member picks a database Connection and an
 * AI Employee, grants the Connection when needed, then lands in ordinary Chat
 * with a reviewed starter request. The employee completes the work through
 * Explore's grant-gated tools, so Charts and Dashboards appear in the same UI
 * and carry the usual audit trail.
 */
export function ExploreAiBuilder({
  open,
  company,
  connections,
  initialConnectionId,
  onClose,
}: {
  open: boolean;
  company: Company;
  connections: ExploreAiConnection[];
  initialConnectionId?: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const connected = React.useMemo(
    () => connections.filter((connection) => connection.status === "connected"),
    [connections],
  );
  const [connectionId, setConnectionId] = React.useState("");
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [grantedIds, setGrantedIds] = React.useState<Set<string> | null>(null);
  const [busyEmployeeId, setBusyEmployeeId] = React.useState<string | null>(null);
  const [request, setRequest] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    const preferred = connected.some((connection) => connection.id === initialConnectionId)
      ? initialConnectionId!
      : (connected[0]?.id ?? "");
    setConnectionId(preferred);
    setRequest(defaultRequest(connected.find((connection) => connection.id === preferred)));
    setEmployees(null);
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(setEmployees)
      .catch((error) => {
        setEmployees([]);
        toast((error as Error).message, "error");
      });
  }, [company.id, connected, initialConnectionId, open, toast]);

  React.useEffect(() => {
    if (!open || !connectionId) {
      setGrantedIds(new Set());
      return;
    }
    let cancelled = false;
    setGrantedIds(null);
    api
      .get<ConnectionGrant[]>(
        `/api/companies/${company.id}/integrations/connections/${connectionId}/grants`,
      )
      .then((grants) => {
        if (!cancelled) setGrantedIds(new Set(grants.map((grant) => grant.employeeId)));
      })
      .catch((error) => {
        if (cancelled) return;
        setGrantedIds(new Set());
        toast((error as Error).message, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [company.id, connectionId, open, toast]);

  const selectedConnection = connected.find((connection) => connection.id === connectionId);

  function changeConnection(nextId: string) {
    setConnectionId(nextId);
    setRequest(defaultRequest(connected.find((connection) => connection.id === nextId)));
  }

  async function openEmployeeChat(employee: Employee) {
    if (!selectedConnection || !request.trim()) return;
    setBusyEmployeeId(employee.id);
    try {
      if (!grantedIds?.has(employee.id)) {
        await api.post(
          `/api/companies/${company.id}/integrations/employees/${employee.id}/grants`,
          { connectionId: selectedConnection.id },
        );
        setGrantedIds((current) => new Set([...(current ?? []), employee.id]));
        toast(`Granted ${employee.name} access to ${selectedConnection.label}`, "success");
      }
      onClose();
      navigate(`/c/${company.slug}/employees/${employee.slug}/chat`, {
        state: { starterPrompt: request.trim() },
      });
    } catch (error) {
      toast((error as Error).message, "error");
    } finally {
      setBusyEmployeeId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Build with an AI Employee" size="lg">
      {connected.length === 0 ? (
        <EmptyState
          title="Connect a database first"
          description="AI Employees use the same Postgres, MySQL, or ClickHouse Connections as Explore."
          action={
            <Link to={`/c/${company.slug}/explore/integrations`} onClick={onClose}>
              <Button size="sm">Connect a database</Button>
            </Link>
          }
        />
      ) : (
        <div className="space-y-5">
          <div className="rounded-xl border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-900 dark:bg-violet-950/25">
            <div className="flex items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white text-violet-600 shadow-sm dark:bg-slate-900 dark:text-violet-300">
                <Sparkles size={17} />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Delegate the whole analytics loop
                </h3>
                <p className="mt-1 text-xs leading-5 text-slate-600 dark:text-slate-300">
                  Your employee can inspect the schema, validate SQL, save Charts, and assemble a
                  Dashboard. You review the request in Chat before sending it.
                </p>
              </div>
            </div>
          </div>

          <Select
            label="Database Connection"
            value={connectionId}
            onChange={(event) => changeConnection(event.target.value)}
            searchPlaceholder="Search database Connections…"
          >
            {connected.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label} · {providerLabel(connection.provider)}
              </option>
            ))}
          </Select>

          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-slate-700 dark:text-slate-300">
              Request
            </span>
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              rows={6}
              className="w-full resize-y rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm leading-6 text-slate-800 focus:border-indigo-400 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
            <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
              Chat opens with this as a draft. Nothing runs until you send it.
            </p>
          </label>

          <div>
            <div className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
              Choose an AI Employee
            </div>
            {employees === null || grantedIds === null ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : employees.length === 0 ? (
              <EmptyState
                title="Hire an AI Employee first"
                description="Explore work is delegated through an AI Employee with a connected AI Model."
                action={
                  <Link to={`/c/${company.slug}/employees/new`} onClick={onClose}>
                    <Button size="sm">Hire AI Employee</Button>
                  </Link>
                }
              />
            ) : (
              <ul className="space-y-2">
                {employees.map((employee) => {
                  const granted = grantedIds.has(employee.id);
                  const modelReady = employee.model?.status === "connected";
                  return (
                    <li
                      key={employee.id}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900"
                    >
                      <Avatar
                        name={employee.name}
                        kind="ai"
                        size="md"
                        src={employeeAvatarUrl(company.id, employee.id, employee.avatarKey)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                            {employee.name}
                          </span>
                          {granted ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                              <CheckCircle2 size={10} /> Connection granted
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                              <LockKeyhole size={10} /> Grant on continue
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
                          {employee.role}
                          {!modelReady && " · AI Model not connected"}
                        </div>
                      </div>
                      {modelReady ? (
                        <Button
                          size="sm"
                          onClick={() => void openEmployeeChat(employee)}
                          disabled={!request.trim() || busyEmployeeId !== null}
                        >
                          <Bot size={13} /> {granted ? "Open chat" : "Grant & open chat"}
                          <ArrowRight size={13} />
                        </Button>
                      ) : (
                        <Link
                          to={`/c/${company.slug}/employees/${employee.slug}/settings/model`}
                          onClick={onClose}
                          className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                        >
                          Connect AI Model
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function defaultRequest(connection: ExploreAiConnection | undefined): string {
  const label = connection?.label ?? "the selected database";
  return `Use the granted Explore Connection “${label}” to build a useful starter analytics dashboard.

Start by listing your Explore Connections and inspecting this Connection's schema. Identify 3–5 decision-useful metrics, validate each SQL query against the live data, and save each one as a clearly named Chart with the most appropriate visualization. Then create one Dashboard and add the Charts in a readable order.

Explain any assumptions or data-quality concerns. Do not change source data.`;
}

function providerLabel(provider: string): string {
  if (provider === "postgres") return "Postgres";
  if (provider === "mysql") return "MySQL";
  if (provider === "clickhouse") return "ClickHouse";
  return provider;
}
