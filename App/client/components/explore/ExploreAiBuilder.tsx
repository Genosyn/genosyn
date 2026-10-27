import React from "react";
import { ArrowRight, Bot, CheckCircle2, LockKeyhole, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { Avatar, employeeAvatarUrl } from "@/components/ui/Avatar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { FormError } from "@/components/ui/FormError";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Spinner } from "@/components/ui/Spinner";
import { api, type Company, type Employee } from "@/lib/api";
import { errorMessage } from "@/lib/errors";
import type { ExploreBase } from "@/lib/explore";

export type ExploreAiConnection = {
  id: string;
  provider: string;
  label: string;
  accountHint: string;
  status: string;
};

/**
 * What the employee builds from: a connected database, or a Base with an
 * active table (an AI Employee never reads an archived one). `key` is the
 * picker's value.
 */
type AiSource =
  | { kind: "connection"; key: string; connection: ExploreAiConnection }
  | { kind: "base"; key: string; base: ExploreBase };

type SourceGrant = {
  employeeId: string;
};

/**
 * Explore's human-to-AI handoff. A Member picks a data source — a database
 * Connection or a Base — and an AI Employee, grants the source when needed,
 * then lands in ordinary Chat with a reviewed starter request. The employee
 * completes the work through Explore's grant-gated tools, so Charts and
 * Dashboards appear in the same UI and carry the usual audit trail.
 */
export function ExploreAiBuilder({
  open,
  company,
  connections,
  bases,
  initialConnectionId,
  onClose,
}: {
  open: boolean;
  company: Company;
  /** Null while loading, like `bases`. */
  connections: ExploreAiConnection[] | null;
  bases: ExploreBase[] | null;
  initialConnectionId?: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const sources = React.useMemo(
    () => (connections && bases ? aiSources(connections, bases) : null),
    [connections, bases],
  );
  const [sourceKey, setSourceKey] = React.useState("");
  const [employees, setEmployees] = React.useState<Employee[] | null>(null);
  const [employeesError, setEmployeesError] = React.useState<string | null>(null);
  const [grantedIds, setGrantedIds] = React.useState<Set<string> | null>(null);
  const [grantsError, setGrantsError] = React.useState<string | null>(null);
  const [busyEmployeeId, setBusyEmployeeId] = React.useState<string | null>(null);
  const [request, setRequest] = React.useState("");
  const [actionError, setActionError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setEmployees(null);
    setEmployeesError(null);
    setActionError(null);
    api
      .get<Employee[]>(`/api/companies/${company.id}/employees`)
      .then(setEmployees)
      .catch((error: unknown) => {
        setEmployees([]);
        setEmployeesError(errorMessage(error, "Could not load the AI Employees"));
      });
  }, [company.id, open]);

  // Each opening starts from the preferred source and its starter request. A
  // live refresh of the source lists keeps the choice and any edits to the
  // request, unless the chosen source is gone.
  React.useEffect(() => {
    if (!open) {
      setSourceKey("");
      return;
    }
    if (!sources || sources.some((source) => source.key === sourceKey)) return;
    const preferred =
      sources.find((source) => source.key === `connection:${initialConnectionId}`) ?? sources[0];
    setSourceKey(preferred?.key ?? "");
    setRequest(defaultRequest(preferred));
  }, [initialConnectionId, open, sourceKey, sources]);

  const selectedSource = sources?.find((source) => source.key === sourceKey);
  const grantNoun = selectedSource?.kind === "base" ? "Base" : "Connection";
  const grantsPath = selectedSource ? sourceGrantsPath(company.id, selectedSource) : null;

  React.useEffect(() => {
    if (!open || !grantsPath) {
      setGrantedIds(new Set());
      setGrantsError(null);
      return;
    }
    let cancelled = false;
    setGrantedIds(null);
    setGrantsError(null);
    api
      .get<SourceGrant[]>(grantsPath)
      .then((grants) => {
        if (!cancelled) setGrantedIds(new Set(grants.map((grant) => grant.employeeId)));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGrantedIds(new Set());
        setGrantsError(errorMessage(error, `Could not load the ${grantNoun} grants`));
      });
    return () => {
      cancelled = true;
    };
  }, [grantNoun, grantsPath, open]);

  // Only a failed AI Employee fetch has nothing to render in place of: the
  // grants fetch supplies a per-row badge, and its catch falls back to an empty
  // set so every row still offers "Grant & open chat".
  const loadError = employeesError;
  const connectionSources = (sources ?? []).filter((source) => source.kind === "connection");
  const baseSources = (sources ?? []).filter((source) => source.kind === "base");

  function changeSource(nextKey: string) {
    setSourceKey(nextKey);
    setRequest(defaultRequest(sources?.find((source) => source.key === nextKey)));
  }

  async function openEmployeeChat(employee: Employee) {
    if (!selectedSource || !request.trim()) return;
    setBusyEmployeeId(employee.id);
    setActionError(null);
    try {
      if (!grantedIds?.has(employee.id)) {
        await grantSource(company.id, selectedSource, employee.id);
        setGrantedIds((current) => new Set([...(current ?? []), employee.id]));
      }
      onClose();
      navigate(`/c/${company.slug}/employees/${employee.slug}/chat`, {
        state: { starterPrompt: request.trim() },
      });
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setBusyEmployeeId(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Build with an AI Employee" size="lg">
      {sources === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          title="Add a data source first"
          description="AI Employees build from the same Postgres, MySQL, or ClickHouse Connections and Bases as Explore."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link to={`/c/${company.slug}/explore/integrations`} onClick={onClose}>
                <Button size="sm">Connect a database</Button>
              </Link>
              <Link to={`/c/${company.slug}/bases`} onClick={onClose}>
                <Button size="sm" variant="secondary">
                  Open Bases
                </Button>
              </Link>
            </div>
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
                  Your employee can inspect the data, check each query, save Charts, and assemble a
                  Dashboard. You review the request in Chat before sending it.
                </p>
              </div>
            </div>
          </div>

          <div>
            <Select
              label="Data source"
              value={sourceKey}
              onChange={(event) => changeSource(event.target.value)}
              searchPlaceholder="Search data sources…"
            >
              {connectionSources.length > 0 && (
                <optgroup label="Databases">
                  {connectionSources.map((source) => (
                    <option key={source.key} value={source.key}>
                      {sourceLabel(source)}
                    </option>
                  ))}
                </optgroup>
              )}
              {baseSources.length > 0 && (
                <optgroup label="Bases">
                  {baseSources.map((source) => (
                    <option key={source.key} value={source.key}>
                      {sourceLabel(source)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              {selectedSource?.kind === "base"
                ? "A Base Grant also lets the employee read and edit this Base's records and fields."
                : "A Connection Grant lets the employee run any SQL its database role allows."}
            </p>
          </div>

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
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Chat opens with this as a draft. Nothing runs until you send it.
            </p>
          </label>

          <div>
            <div className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
              Choose an AI Employee
            </div>
            <FormError message={grantsError} className="mb-2" />
            {loadError ? (
              <FormError message={loadError} />
            ) : employees === null || grantedIds === null ? (
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
                            <Badge tone="success" icon={<CheckCircle2 />}>
                              {grantNoun} granted
                            </Badge>
                          ) : (
                            <Badge icon={<LockKeyhole />}>Grant on continue</Badge>
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
                          loading={busyEmployeeId === employee.id}
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
            <FormError message={actionError} className="mt-3" />
          </div>
        </div>
      )}
    </Modal>
  );
}

function aiSources(connections: ExploreAiConnection[], bases: ExploreBase[]): AiSource[] {
  return [
    ...connections
      .filter((connection) => connection.status === "connected")
      .map(
        (connection): AiSource => ({
          kind: "connection",
          key: `connection:${connection.id}`,
          connection,
        }),
      ),
    ...bases
      .filter((base) => base.tables.some((table) => !table.archived))
      .map((base): AiSource => ({ kind: "base", key: `base:${base.id}`, base })),
  ];
}

function sourceLabel(source: AiSource): string {
  if (source.kind === "base") return source.base.name;
  return `${source.connection.label} · ${providerLabel(source.connection.provider)}`;
}

function sourceGrantsPath(companyId: string, source: AiSource): string {
  if (source.kind === "base") return `/api/companies/${companyId}/bases/${source.base.slug}/grants`;
  return `/api/companies/${companyId}/integrations/connections/${source.connection.id}/grants`;
}

function grantSource(companyId: string, source: AiSource, employeeId: string): Promise<unknown> {
  if (source.kind === "base") {
    return api.post(`/api/companies/${companyId}/bases/${source.base.slug}/grants`, {
      employeeId,
    });
  }
  return api.post(`/api/companies/${companyId}/integrations/employees/${employeeId}/grants`, {
    connectionId: source.connection.id,
  });
}

function defaultRequest(source: AiSource | undefined): string {
  if (source?.kind === "base") {
    const { name, slug } = source.base;
    return `Use the granted Base “${name}” to build a useful starter analytics dashboard.

Start with get_base for baseSlug “${slug}” to read its active tables and the table and field ids each Chart needs. Identify 3–5 decision-useful metrics. Save each one with create_chart, passing baseSlug “${slug}” and a baseQuery built from those ids, as a clearly named Chart with the most appropriate visualization, and check it with run_chart. Then create one Dashboard with create_dashboard and add the Charts in a readable order with add_dashboard_card.

Explain any assumptions or data-quality concerns. Do not change the Base's records.`;
  }
  const label = source?.connection.label ?? "the selected database";
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
