import React from "react";
import { AlertCircle, ArrowRight, CheckCircle2, Copy, Info, Trash2, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Textarea";
import { useToast } from "@/components/ui/Toast";
import {
  api,
  type BaseDetail,
  type Company,
  type Pipeline,
  type PipelineGraph,
  type PipelineNode,
  type PipelineNodeCatalogEntry,
  type PipelineNodeField,
} from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { CRON_PRESETS, cronHuman, cronIsReadable } from "@/lib/cron";
import type {
  PipelineIntegrationTool,
  PipelineResources,
} from "@/pages/pipelines/pipelineResources";
import {
  PIPELINE_FAMILY_META,
  type PipelineIssue,
  nodeDisplayName,
  pipelineIcon,
} from "@/pages/pipelines/pipelineUi";

type SelectOption = { value: string; label: string; description?: string };

export function PipelineNodePanel({
  company,
  pipeline,
  graph,
  catalog,
  node,
  entry,
  issues,
  resources,
  integrationTools,
  onChange,
  onDelete,
  onClose,
  onSetConnection,
  onDeleteEdge,
  onSelectIssue,
  onTokenRegenerated,
}: {
  company: Company;
  pipeline: Pipeline;
  graph: PipelineGraph;
  catalog: Map<string, PipelineNodeCatalogEntry>;
  node: PipelineNode | null;
  entry: PipelineNodeCatalogEntry | null;
  issues: PipelineIssue[];
  resources: PipelineResources;
  integrationTools: Record<string, PipelineIntegrationTool[]>;
  onChange: (next: PipelineNode) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onSetConnection: (fromId: string, handle: string, toId: string | null) => void;
  onDeleteEdge: (edgeId: string) => void;
  onSelectIssue: (nodeId: string) => void;
  onTokenRegenerated: (token: string) => void;
}) {
  const [tables, setTables] = React.useState<SelectOption[]>([]);
  const [tablesLoading, setTablesLoading] = React.useState(false);
  const baseSlug =
    node?.type === "action.createBaseRecord" ? String(node.config.baseSlug ?? "") : "";

  React.useEffect(() => {
    let cancelled = false;
    if (!baseSlug) {
      setTables([]);
      return;
    }
    setTablesLoading(true);
    api
      .get<BaseDetail>(`/api/companies/${company.id}/bases/${baseSlug}`)
      .then((detail) => {
        if (!cancelled) {
          setTables(
            detail.tables.map((table) => ({
              value: table.slug,
              label: table.name,
            })),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      })
      .finally(() => {
        if (!cancelled) setTablesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [baseSlug, company.id]);

  if (!node || !entry) {
    return <BuilderGuide issues={issues} onSelectIssue={onSelectIssue} />;
  }

  const Icon = pipelineIcon(entry.icon);
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);
  const selectedConnection = resources.connections.find(
    (connection) => connection.id === node.config.connectionId,
  );
  const toolOptions = selectedConnection
    ? (integrationTools[selectedConnection.provider] ?? []).map((tool) => ({
        value: tool.name,
        label: humanizeToolName(tool.name),
        description: tool.description,
      }))
    : [];
  const selectedTool = selectedConnection
    ? ((integrationTools[selectedConnection.provider] ?? []).find(
        (tool) => tool.name === node.config.toolName,
      ) ?? null)
    : null;

  return (
    <>
      <div
        className="fixed inset-0 z-30 bg-slate-950/30 lg:hidden"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="fixed inset-x-0 bottom-0 z-40 max-h-[78vh] w-full overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white shadow-2xl dark:border-slate-800 dark:bg-slate-950 lg:static lg:z-auto lg:max-h-none lg:w-96 lg:shrink-0 lg:rounded-none lg:border-l lg:border-t-0 lg:shadow-none">
        <div className="sticky top-0 z-10 flex items-start gap-2 border-b border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
          <div
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${PIPELINE_FAMILY_META[entry.family].tone}`}
          >
            <Icon size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-950 dark:text-slate-50">
              {entry.label}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">
              {entry.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Close step settings"
            aria-label="Close step settings"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-6 p-4 pb-8">
          {nodeIssues.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-500/10">
              <div className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-200">
                <AlertCircle size={14} />
                {nodeIssues.length} {nodeIssues.length === 1 ? "item" : "items"} to review
              </div>
              <ul className="mt-2 space-y-1.5 text-xs leading-5 text-amber-800/90 dark:text-amber-200/90">
                {nodeIssues.map((issue) => (
                  <li key={issue.id}>{issue.title}</li>
                ))}
              </ul>
            </div>
          )}

          <section>
            <SectionHeading
              title="Step details"
              description="Give this step a name that explains its role."
            />
            <div className="mt-3 space-y-3">
              <Input
                label="Display name (optional)"
                value={node.label ?? ""}
                placeholder={entry.label}
                onChange={(event) =>
                  onChange({
                    ...node,
                    label: event.target.value || undefined,
                  })
                }
              />
              {!node.type.startsWith("trigger.") && <ReferenceKey nodeId={node.id} />}
            </div>
          </section>

          {entry.fields.some((field) => field.key !== "token") && (
            <section>
              <SectionHeading
                title="Setup"
                description="Required fields must be complete before this pipeline can run."
              />
              <div className="mt-3 space-y-4">
                {entry.fields
                  .filter((field) => field.key !== "token")
                  .map((field) => {
                    const resource = resourceOptionsForField({
                      field,
                      company,
                      resources,
                      tables,
                      tablesLoading,
                      toolOptions,
                    });
                    return (
                      <FieldEditor
                        key={field.key}
                        field={field}
                        value={node.config[field.key]}
                        resource={resource}
                        selectedTool={field.key === "args" ? selectedTool : null}
                        onChange={(value) => {
                          const config = { ...node.config, [field.key]: value };
                          if (field.key === "baseSlug") config.tableSlug = "";
                          if (field.key === "connectionId") {
                            config.toolName = "";
                            config.args = "{}";
                          }
                          if (field.key === "toolName") config.args = "{}";
                          onChange({ ...node, config });
                        }}
                      />
                    );
                  })}
              </div>
            </section>
          )}

          {node.type === "trigger.webhook" && (
            <WebhookSettings
              company={company}
              pipeline={pipeline}
              node={node}
              onRegenerate={onTokenRegenerated}
            />
          )}

          <FlowSettings
            node={node}
            entry={entry}
            graph={graph}
            catalog={catalog}
            onSetConnection={onSetConnection}
            onDeleteEdge={onDeleteEdge}
          />

          <TemplateHelp node={node} />

          <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:text-rose-300 dark:hover:bg-rose-500/10"
              onClick={() => onDelete(node.id)}
            >
              <Trash2 size={15} /> Delete this step
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}

function BuilderGuide({
  issues,
  onSelectIssue,
}: {
  issues: PipelineIssue[];
  onSelectIssue: (nodeId: string) => void;
}) {
  const errors = issues.filter((issue) => issue.severity === "error");
  return (
    <aside className="hidden w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950 xl:block">
      <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
        {errors.length === 0 ? "Ready to test" : "Finish setting up"}
      </div>
      <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
        {errors.length === 0
          ? "Every required field and connection is in place. Save, then run once to check the result."
          : "The builder checks required fields and connections as you work."}
      </p>
      <div className="mt-4 space-y-2">
        {errors.length === 0 ? (
          <div className="flex gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs leading-5 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0" />
            <span>No blocking setup issues were found.</span>
          </div>
        ) : (
          errors.map((issue) => (
            <button
              key={issue.id}
              type="button"
              onClick={() => issue.nodeId && onSelectIssue(issue.nodeId)}
              disabled={!issue.nodeId}
              className="w-full rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-xs text-amber-900 disabled:cursor-default dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-200"
            >
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-semibold">{issue.title}</span>
                  <span className="mt-0.5 block leading-5 opacity-80">{issue.description}</span>
                </span>
              </div>
            </button>
          ))
        )}
      </div>
      <div className="mt-5 rounded-lg bg-slate-50 p-3 dark:bg-slate-900">
        <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">How to build</div>
        <ol className="mt-2 space-y-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
          <li>1. Add a trigger and the steps it should run.</li>
          <li>2. Select each step to configure and connect it.</li>
          <li>3. Save, click Run now, then check Run history.</li>
        </ol>
      </div>
    </aside>
  );
}

function FlowSettings({
  node,
  entry,
  graph,
  catalog,
  onSetConnection,
  onDeleteEdge,
}: {
  node: PipelineNode;
  entry: PipelineNodeCatalogEntry;
  graph: PipelineGraph;
  catalog: Map<string, PipelineNodeCatalogEntry>;
  onSetConnection: (fromId: string, handle: string, toId: string | null) => void;
  onDeleteEdge: (edgeId: string) => void;
}) {
  const incoming = graph.edges.filter((edge) => edge.toNodeId === node.id);
  const targets = graph.nodes.filter(
    (candidate) => candidate.id !== node.id && !candidate.type.startsWith("trigger."),
  );
  const handles = entry.outputs ?? ["out"];
  return (
    <section>
      <SectionHeading
        title="Flow"
        description="Choose what should happen immediately after this step."
      />
      <div className="mt-3 space-y-3">
        {!node.type.startsWith("trigger.") && (
          <div className="rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-900">
            <div className="font-medium text-slate-700 dark:text-slate-300">Runs after</div>
            {incoming.length === 0 ? (
              <p className="mt-1 text-amber-700 dark:text-amber-300">
                Nothing is connected before this step yet.
              </p>
            ) : (
              <div className="mt-1 space-y-1">
                {incoming.map((edge) => {
                  const previous = graph.nodes.find(
                    (candidate) => candidate.id === edge.fromNodeId,
                  );
                  return (
                    <div
                      key={edge.id}
                      className="flex items-center gap-2 text-slate-600 dark:text-slate-400"
                    >
                      <ArrowRight size={12} />
                      <span className="min-w-0 flex-1 truncate">
                        {previous ? nodeDisplayName(previous, catalog) : "Missing step"}
                      </span>
                      <button
                        type="button"
                        onClick={() => onDeleteEdge(edge.id)}
                        className="text-slate-400 hover:text-rose-600"
                        aria-label="Remove incoming connection"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {handles.map((handle) => {
          const edge = graph.edges.find(
            (candidate) =>
              candidate.fromNodeId === node.id && (candidate.fromHandle ?? "out") === handle,
          );
          return (
            <label key={handle} className="block">
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                {handle === "true" ? "If true" : handle === "false" ? "If false" : "Next step"}
              </span>
              <select
                value={edge?.toNodeId ?? ""}
                onChange={(event) => onSetConnection(node.id, handle, event.target.value || null)}
                className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900"
              >
                <option value="">End the run here</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {nodeDisplayName(target, catalog)}
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function FieldEditor({
  field,
  value,
  resource,
  selectedTool,
  onChange,
}: {
  field: PipelineNodeField;
  value: unknown;
  resource: ResourceField | null;
  selectedTool: PipelineIntegrationTool | null;
  onChange: (value: unknown) => void;
}) {
  const normalized = value === undefined || value === null ? "" : value;
  const label = `${field.label}${field.required ? " *" : ""}`;

  if (resource) {
    const current = String(normalized);
    const hasCurrent = resource.options.some((option) => option.value === current);
    return (
      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</label>
        <select
          value={current}
          onChange={(event) => onChange(event.target.value)}
          disabled={resource.loading}
          className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900"
        >
          <option value="">
            {resource.loading ? "Loading…" : `Choose ${resource.singular.toLowerCase()}`}
          </option>
          {current && !hasCurrent && <option value={current}>{current}</option>}
          {resource.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {current && resource.options.find((option) => option.value === current)?.description && (
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            {resource.options.find((option) => option.value === current)?.description}
          </p>
        )}
        {!resource.loading && resource.options.length === 0 && (
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
            No {resource.plural.toLowerCase()} are available.{" "}
            {resource.href && (
              <Link
                to={resource.href}
                className="font-medium text-indigo-600 hover:underline dark:text-indigo-300"
              >
                Create or connect one
              </Link>
            )}
          </p>
        )}
        {field.hint && resource.options.length > 0 && (
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{field.hint}</p>
        )}
      </div>
    );
  }

  if (field.type === "longtext" || field.type === "code") {
    const text = typeof normalized === "string" ? normalized : JSON.stringify(normalized);
    const jsonValid = field.type !== "code" || !text.trim() || isJsonObject(text);
    return (
      <div>
        <Textarea
          label={label}
          value={text}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          rows={field.type === "code" ? 6 : 4}
          className={
            "min-h-0 font-normal " +
            (field.type === "code" ? "font-mono text-xs " : "") +
            (!jsonValid ? "border-rose-400 focus:border-rose-500 focus:ring-rose-100" : "")
          }
        />
        {!jsonValid && (
          <p className="mt-1 flex items-center gap-1 text-xs text-rose-600 dark:text-rose-300">
            <AlertCircle size={12} /> Enter a valid JSON object.
          </p>
        )}
        {selectedTool && field.key === "args" && (
          <ToolSchemaHelp tool={selectedTool} onInsert={(next) => onChange(next)} />
        )}
        {field.hint && (
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{field.hint}</p>
        )}
      </div>
    );
  }

  if (field.type === "boolean") {
    return (
      <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm text-slate-700 dark:border-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={Boolean(normalized)}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-4 w-4 accent-indigo-600"
        />
        <span>
          <span className="font-medium">{field.label}</span>
          {field.hint && (
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
              {field.hint}
            </span>
          )}
        </span>
      </label>
    );
  }

  if (field.type === "select" && field.options) {
    return (
      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">{label}</label>
        <select
          value={String(normalized)}
          onChange={(event) => onChange(event.target.value)}
          className="mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-indigo-900"
        >
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.hint && (
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{field.hint}</p>
        )}
      </div>
    );
  }

  if (field.type === "number") {
    return (
      <div>
        <Input
          label={label}
          type="number"
          value={
            typeof normalized === "number"
              ? normalized
              : normalized === ""
                ? ""
                : Number(normalized)
          }
          onChange={(event) =>
            onChange(event.target.value === "" ? "" : Number(event.target.value))
          }
          placeholder={field.placeholder}
        />
        {field.hint && (
          <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{field.hint}</p>
        )}
      </div>
    );
  }

  const valueAsString = String(normalized);
  const isCron = field.key === "cronExpr";
  return (
    <div>
      <Input
        label={label}
        value={valueAsString}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder}
      />
      {isCron && valueAsString && (
        <p
          className={
            "mt-1 text-xs leading-5 " +
            (cronIsReadable(valueAsString)
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-rose-600 dark:text-rose-300")
          }
        >
          {cronIsReadable(valueAsString)
            ? cronHuman(valueAsString)
            : "This schedule is not valid yet."}
        </p>
      )}
      {isCron && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {CRON_PRESETS.map((preset) => (
            <button
              key={preset.expr}
              type="button"
              onClick={() => onChange(preset.expr)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[10px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-indigo-700 dark:hover:text-indigo-300"
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
      {field.hint && (
        <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{field.hint}</p>
      )}
    </div>
  );
}

type ResourceField = {
  singular: string;
  plural: string;
  options: SelectOption[];
  loading: boolean;
  href?: string;
};

function resourceOptionsForField({
  field,
  company,
  resources,
  tables,
  tablesLoading,
  toolOptions,
}: {
  field: PipelineNodeField;
  company: Company;
  resources: PipelineResources;
  tables: SelectOption[];
  tablesLoading: boolean;
  toolOptions: SelectOption[];
}): ResourceField | null {
  const root = `/c/${company.slug}`;
  if (field.key === "channelIdOrSlug") {
    return {
      singular: "Channel",
      plural: "Channels",
      options: resources.channels.map((channel) => ({
        value: channel.slug ?? channel.id,
        label: `#${channel.name ?? channel.slug ?? "channel"}`,
        description: channel.topic || undefined,
      })),
      loading: resources.loading,
      href: `${root}/workspace`,
    };
  }
  if (field.key === "projectSlug") {
    return {
      singular: "Project",
      plural: "Projects",
      options: resources.projects.map((project) => ({
        value: project.slug,
        label: project.name,
        description: project.description || undefined,
      })),
      loading: resources.loading,
      href: `${root}/tasks`,
    };
  }
  if (field.key === "baseSlug") {
    return {
      singular: "Base",
      plural: "Bases",
      options: resources.bases.map((base) => ({
        value: base.slug,
        label: base.name,
        description: base.description || undefined,
      })),
      loading: resources.loading,
      href: `${root}/bases`,
    };
  }
  if (field.key === "tableSlug") {
    return {
      singular: "Table",
      plural: "Tables",
      options: tables,
      loading: tablesLoading,
      href: `${root}/bases`,
    };
  }
  if (field.key === "employeeSlug") {
    return {
      singular: "AI employee",
      plural: "AI employees",
      options: resources.employees.map((employee) => ({
        value: employee.slug,
        label: employee.name,
        description: employee.role,
      })),
      loading: resources.loading,
      href: `${root}/employees`,
    };
  }
  if (field.key === "connectionId") {
    return {
      singular: "Connection",
      plural: "Connections",
      options: resources.connections.map((connection) => ({
        value: connection.id,
        label: connection.label,
        description: `${connection.provider} · ${connection.status}`,
      })),
      loading: resources.loading,
      href: `${root}/settings/integrations`,
    };
  }
  if (field.key === "toolName") {
    return {
      singular: "Action",
      plural: "Actions",
      options: toolOptions,
      loading: resources.loading,
      href: `${root}/settings/integrations`,
    };
  }
  return null;
}

function ReferenceKey({ nodeId }: { nodeId: string }) {
  const { toast } = useToast();
  return (
    <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-900">
      <span className="text-slate-500 dark:text-slate-400">Output reference</span>
      <code className="min-w-0 flex-1 truncate font-mono text-slate-700 dark:text-slate-300">
        {`{{${nodeId}.…}}`}
      </code>
      <button
        type="button"
        onClick={async () => {
          const ok = await copyToClipboard(`{{${nodeId}.}}`);
          toast(ok ? "Reference copied" : "Could not access clipboard", ok ? "success" : "error");
        }}
        className="text-slate-400 hover:text-indigo-600"
        title="Copy output reference"
        aria-label="Copy output reference"
      >
        <Copy size={13} />
      </button>
    </div>
  );
}

function TemplateHelp({ node }: { node: PipelineNode }) {
  const isTrigger = node.type.startsWith("trigger.");
  const triggerExample =
    node.type === "trigger.emailReceived"
      ? "{{trigger.payload.message.subject}}"
      : node.type === "trigger.todoCreated"
        ? "{{trigger.payload.task.title}}"
        : node.type === "trigger.schedule"
          ? "{{trigger.payload.firedAt}}"
          : "{{trigger.payload.name}}";
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
      <div className="flex items-center gap-2 font-semibold text-slate-700 dark:text-slate-300">
        <Info size={14} /> {isTrigger ? "Data this trigger provides" : "Use data from earlier steps"}
      </div>
      <p className="mt-1.5">
        Insert trigger data with{" "}
        <code className="rounded bg-white px-1 py-0.5 font-mono text-[10px] dark:bg-slate-950">
          {triggerExample}
        </code>
        .
        {!isTrigger && (
          <>
            {" "}
            Later steps can use this step&apos;s output with{" "}
            <code className="rounded bg-white px-1 py-0.5 font-mono text-[10px] dark:bg-slate-950">
              {"{{" + node.id + ".field}}"}
            </code>
            .
          </>
        )}
      </p>
    </div>
  );
}

function ToolSchemaHelp({
  tool,
  onInsert,
}: {
  tool: PipelineIntegrationTool;
  onInsert: (value: string) => void;
}) {
  const keys = Object.keys(tool.inputSchema.properties);
  return (
    <div className="mt-2 rounded-lg bg-slate-50 p-3 text-xs dark:bg-slate-900">
      <div className="font-medium text-slate-700 dark:text-slate-300">Expected fields</div>
      <p className="mt-1 leading-5 text-slate-500 dark:text-slate-400">
        {keys.length > 0 ? keys.join(", ") : "This action takes no fields."}
      </p>
      {keys.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const example = Object.fromEntries(keys.map((key) => [key, ""]));
            onInsert(JSON.stringify(example, null, 2));
          }}
          className="mt-2 font-medium text-indigo-600 hover:underline dark:text-indigo-300"
        >
          Insert a JSON outline
        </button>
      )}
    </div>
  );
}

function WebhookSettings({
  company,
  pipeline,
  node,
  onRegenerate,
}: {
  company: Company;
  pipeline: Pipeline;
  node: PipelineNode;
  onRegenerate: (token: string) => void;
}) {
  const { toast } = useToast();
  const dialog = useDialog();
  const token = String(node.config.token ?? "");
  const url = token
    ? `${window.location.origin}/api/webhooks/pipelines/${pipeline.id}/${token}`
    : null;

  async function regenerate() {
    const confirmed = await dialog.confirm({
      title: "Replace this webhook URL?",
      message: "The current URL will stop working immediately. Update any system that uses it.",
      confirmLabel: "Replace URL",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      const result = await api.post<{ token: string }>(
        `/api/companies/${company.id}/pipelines/${pipeline.id}/webhook-token`,
        { nodeId: node.id },
      );
      onRegenerate(result.token);
      toast("Webhook URL replaced", "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  return (
    <section>
      <SectionHeading
        title="Webhook URL"
        description="Keep this private. Anyone with the URL can start this pipeline."
      />
      <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-900">
        {url ? (
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-white px-2 py-1.5 font-mono text-[10px] text-slate-700 dark:bg-slate-950 dark:text-slate-300">
              {url}
            </code>
            <button
              type="button"
              onClick={async () => {
                const ok = await copyToClipboard(url);
                toast(
                  ok ? "Webhook URL copied" : "Could not access clipboard",
                  ok ? "success" : "error",
                );
              }}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
              title="Copy webhook URL"
              aria-label="Copy webhook URL"
            >
              <Copy size={14} />
            </button>
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Save the pipeline once to create its private URL.
          </p>
        )}
        <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-400">
          Send a POST request with JSON. Later steps can read it from{" "}
          <code className="rounded bg-white px-1 py-0.5 font-mono text-[10px] dark:bg-slate-950">
            {"{{trigger.payload}}"}
          </code>
          .
        </p>
        {url && (
          <button
            type="button"
            onClick={() => void regenerate()}
            className="mt-2 text-xs font-medium text-rose-600 hover:underline dark:text-rose-300"
          >
            Replace this URL
          </button>
        )}
      </div>
    </section>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
      <p className="mt-0.5 text-xs leading-5 text-slate-500 dark:text-slate-400">{description}</p>
    </div>
  );
}

function isJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  } catch {
    return false;
  }
}

function humanizeToolName(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
