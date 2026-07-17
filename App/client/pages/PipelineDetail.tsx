import React from "react";
import {
  AlertCircle,
  CheckCircle2,
  History,
  Pause,
  Play,
  Save,
  Trash2,
  Workflow,
} from "lucide-react";
import { Link, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { Breadcrumbs } from "@/components/AppShell";
import { Button } from "@/components/ui/Button";
import { useDialog } from "@/components/ui/Dialog";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { api, type Company, type Pipeline, type PipelineGraph, type PipelineNode } from "@/lib/api";
import type { PipelinesContext } from "@/pages/PipelinesLayout";
import { PipelineCanvas } from "@/pages/pipelines/PipelineCanvas";
import { PipelineNodePanel } from "@/pages/pipelines/PipelineNodePanel";
import { PipelinePalette } from "@/pages/pipelines/PipelinePalette";
import { PipelineRuns } from "@/pages/pipelines/PipelineRuns";
import { usePipelineResources } from "@/pages/pipelines/pipelineResources";
import {
  arrangePipelineGraph,
  getPipelineIssues,
  nodeDisplayName,
  pipelineStatus,
} from "@/pages/pipelines/pipelineUi";
import { AsyncResourceTagPicker } from "@/components/TagPicker";

export default function PipelineDetail({ company }: { company: Company }) {
  const { pSlug = "" } = useParams();
  const navigate = useNavigate();
  const {
    catalog,
    integrationTools,
    loading: catalogLoading,
    error: catalogError,
    refresh: refreshList,
  } = useOutletContext<PipelinesContext>();
  const resources = usePipelineResources(company.id);
  const { toast } = useToast();
  const dialog = useDialog();

  const [pipeline, setPipeline] = React.useState<Pipeline | null>(null);
  const [graph, setGraph] = React.useState<PipelineGraph | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [enabled, setEnabled] = React.useState(true);
  const [dirty, setDirty] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [tab, setTab] = React.useState<"builder" | "runs">("builder");
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.get<Pipeline>(`/api/companies/${company.id}/pipelines/${pSlug}`);
      setPipeline(result);
      setGraph(result.graph);
      setName(result.name);
      setDescription(result.description ?? "");
      setEnabled(result.enabled);
      setDirty(false);
    } catch (err) {
      setLoadError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [company.id, pSlug]);

  React.useEffect(() => {
    setSelectedNodeId(null);
    setTab("builder");
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const catalogByType = React.useMemo(
    () => new Map(catalog.map((entry) => [entry.type, entry])),
    [catalog],
  );
  const issues = React.useMemo(
    () => (graph ? getPipelineIssues(graph, catalog) : []),
    [catalog, graph],
  );
  const blockingIssues = issues.filter((issue) => issue.severity === "error");
  const selectedNode = graph?.nodes.find((node) => node.id === selectedNodeId) ?? null;
  const selectedEntry = selectedNode ? (catalogByType.get(selectedNode.type) ?? null) : null;

  function updateGraph(next: PipelineGraph) {
    setGraph(next);
    setDirty(true);
  }

  function addNode(type: string) {
    if (!graph) return;
    const entry = catalogByType.get(type);
    if (!entry) return;
    const id = `n_${Math.random().toString(36).slice(2, 8)}`;
    const config: Record<string, unknown> = {};
    for (const field of entry.fields) {
      if (field.default !== undefined) config[field.key] = field.default;
    }

    const selected = graph.nodes.find((node) => node.id === selectedNodeId);
    const triggerNodes = graph.nodes.filter((node) => node.type.startsWith("trigger."));
    let x = 72;
    let y = 88;
    if (type.startsWith("trigger.")) {
      y = 88 + triggerNodes.length * 152;
    } else if (selected) {
      x = selected.x + 320;
      y = selected.y;
    } else if (graph.nodes.length > 0) {
      const rightmost = graph.nodes.reduce((best, node) => (node.x > best.x ? node : best));
      x = rightmost.x + 320;
      y = rightmost.y;
    }

    const node: PipelineNode = { id, type, x, y, config };
    const edges = [...graph.edges];
    if (selected && !type.startsWith("trigger.")) {
      const selectedCatalog = catalogByType.get(selected.type);
      const handles = selectedCatalog?.outputs ?? ["out"];
      const handle = handles.length === 1 ? handles[0] : null;
      const alreadyConnected = handle
        ? edges.some(
            (edge) => edge.fromNodeId === selected.id && (edge.fromHandle ?? "out") === handle,
          )
        : true;
      if (handle && !alreadyConnected) {
        edges.push({
          id: `e_${Math.random().toString(36).slice(2, 8)}`,
          fromNodeId: selected.id,
          toNodeId: id,
          fromHandle: handle,
        });
      }
    }
    updateGraph({ nodes: [...graph.nodes, node], edges });
    setSelectedNodeId(id);
  }

  function updateNode(id: string, next: PipelineNode) {
    if (!graph) return;
    updateGraph({
      ...graph,
      nodes: graph.nodes.map((node) => (node.id === id ? next : node)),
    });
  }

  async function deleteNode(id: string) {
    if (!graph) return;
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    const isConnected = graph.edges.some((edge) => edge.fromNodeId === id || edge.toNodeId === id);
    if (isConnected || node.type.startsWith("trigger.")) {
      const confirmed = await dialog.confirm({
        title: `Delete “${nodeDisplayName(node, catalogByType)}”?`,
        message: isConnected
          ? "The connections into and out of this step will also be removed."
          : "This changes how the pipeline starts.",
        confirmLabel: "Delete step",
        variant: "danger",
      });
      if (!confirmed) return;
    }
    updateGraph({
      nodes: graph.nodes.filter((candidate) => candidate.id !== id),
      edges: graph.edges.filter((edge) => edge.fromNodeId !== id && edge.toNodeId !== id),
    });
    if (selectedNodeId === id) setSelectedNodeId(null);
    toast("Step removed. Save to keep this change.", "info");
  }

  function setConnection(fromId: string, handle: string, toId: string | null) {
    if (!graph) return;
    const edges = graph.edges.filter(
      (edge) => !(edge.fromNodeId === fromId && (edge.fromHandle ?? "out") === handle),
    );
    if (toId && toId !== fromId) {
      edges.push({
        id: `e_${Math.random().toString(36).slice(2, 8)}`,
        fromNodeId: fromId,
        toNodeId: toId,
        fromHandle: handle,
      });
    }
    updateGraph({ ...graph, edges });
  }

  function deleteEdge(id: string) {
    if (!graph) return;
    updateGraph({
      ...graph,
      edges: graph.edges.filter((edge) => edge.id !== id),
    });
  }

  async function save(): Promise<boolean> {
    if (!pipeline || !graph || !name.trim()) return false;
    setSaving(true);
    try {
      const updated = await api.patch<Pipeline>(
        `/api/companies/${company.id}/pipelines/${pipeline.id}`,
        {
          name: name.trim(),
          description: description.trim(),
          enabled,
          graph,
        },
      );
      setPipeline(updated);
      setGraph(updated.graph);
      setName(updated.name);
      setDescription(updated.description);
      setEnabled(updated.enabled);
      setDirty(false);
      await refreshList();
      toast("Pipeline saved", "success");
      if (updated.slug !== pSlug) {
        navigate(`/c/${company.slug}/pipelines/${updated.slug}`, {
          replace: true,
        });
      }
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
    } finally {
      setSaving(false);
    }
  }

  const saveRef = React.useRef(save);
  saveRef.current = save;
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function runNow() {
    if (!pipeline || !enabled || blockingIssues.length > 0) return;
    setRunning(true);
    try {
      if (dirty && !(await save())) return;
      const result = await api.post<{
        status: string;
        errorMessage: string | null;
      }>(`/api/companies/${company.id}/pipelines/${pipeline.id}/run`, {});
      if (result.status === "completed") {
        toast("Test run succeeded", "success");
      } else if (result.status === "failed") {
        toast(`Test run failed: ${result.errorMessage ?? "No error message"}`, "error");
      } else {
        toast(`Test run ${result.status}`, "info");
      }
      await load();
      await refreshList();
      setTab("runs");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setRunning(false);
    }
  }

  async function destroy() {
    if (!pipeline) return;
    const confirmed = await dialog.confirm({
      title: `Delete pipeline “${pipeline.name}”?`,
      message: "This deletes the builder and all Run history. This cannot be undone.",
      confirmLabel: "Delete pipeline",
      variant: "danger",
    });
    if (!confirmed) return;
    try {
      await api.del(`/api/companies/${company.id}/pipelines/${pipeline.id}`);
      await refreshList();
      navigate(`/c/${company.slug}/pipelines`, { replace: true });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (loading || (catalogLoading && catalog.length === 0)) {
    return (
      <div className="flex h-full min-h-80 items-center justify-center">
        <div className="text-center">
          <Spinner size={22} />
          <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Opening pipeline…</p>
        </div>
      </div>
    );
  }

  if (loadError || (!catalogLoading && catalog.length === 0 && catalogError)) {
    return (
      <div className="mx-auto max-w-xl p-6 sm:p-8">
        <div className="rounded-xl border border-rose-200 bg-white p-6 text-center shadow-sm dark:border-rose-900 dark:bg-slate-950">
          <AlertCircle size={24} className="mx-auto text-rose-500" />
          <h1 className="mt-3 text-lg font-semibold text-slate-950 dark:text-slate-50">
            This pipeline could not be opened
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {loadError ?? catalogError}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            <Link to={`/c/${company.slug}/pipelines`}>
              <Button variant="secondary">Back to pipelines</Button>
            </Link>
            <Button onClick={() => void load()}>Try again</Button>
          </div>
        </div>
      </div>
    );
  }

  if (!pipeline || !graph) return null;

  const status = pipelineStatus({ enabled, graph }, catalog);
  const canRun = enabled && blockingIssues.length === 0 && Boolean(name.trim());
  const selectedNodeName = selectedNode ? nodeDisplayName(selectedNode, catalogByType) : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-slate-50 dark:bg-slate-900">
      <header className="shrink-0 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950 sm:px-6">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Pipelines", to: `/c/${company.slug}/pipelines` },
            { label: pipeline.name },
          ]}
        />
        <div className="mt-2 flex flex-col gap-3 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Workflow size={18} className="shrink-0 text-indigo-600 dark:text-indigo-300" />
              <input
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setDirty(true);
                }}
                maxLength={80}
                aria-label="Pipeline name"
                className="min-w-0 flex-1 bg-transparent text-lg font-semibold text-slate-950 outline-none placeholder:text-slate-400 dark:text-slate-50"
              />
              <span
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${status.tone}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </span>
            </div>
            <textarea
              value={description}
              onChange={(event) => {
                setDescription(event.target.value);
                setDirty(true);
              }}
              maxLength={500}
              rows={1}
              aria-label="Pipeline purpose"
              placeholder="Add a short purpose so others know when to use this pipeline"
              className="mt-1.5 min-h-7 w-full resize-none bg-transparent text-sm leading-5 text-slate-500 outline-none placeholder:text-slate-400 dark:text-slate-400 dark:placeholder:text-slate-600"
            />
            <div className="mt-2 max-w-xl">
              <AsyncResourceTagPicker
                companyId={company.id}
                resourceType="pipeline"
                resourceId={pipeline.id}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => {
                setEnabled((current) => !current);
                setDirty(true);
              }}
              className={
                "inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-xs font-medium transition " +
                (enabled
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200"
                  : "border-slate-200 bg-slate-100 text-slate-600 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300")
              }
              title={enabled ? "Pause automatic and webhook runs" : "Allow this pipeline to run"}
            >
              {enabled ? <CheckCircle2 size={14} /> : <Pause size={14} />}
              {enabled ? "On" : "Paused"}
            </button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void runNow()}
              disabled={!canRun || running || saving}
              title={
                !enabled
                  ? "Turn the pipeline on before running it"
                  : blockingIssues.length > 0
                    ? "Finish the setup issues before running"
                    : "Save any changes and start a manual test run"
              }
            >
              <Play size={14} /> {running ? "Running…" : "Run now"}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!dirty || saving || !name.trim()}
              title="Save pipeline (⌘S or Ctrl+S)"
            >
              <Save size={14} /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
            <button
              type="button"
              onClick={() => void destroy()}
              className="rounded-lg p-2 text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/10 dark:hover:text-rose-300"
              title="Delete pipeline"
              aria-label="Delete pipeline"
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        <div className="mt-3 flex items-center gap-1" role="tablist" aria-label="Pipeline views">
          <TabButton active={tab === "builder"} icon={Workflow} onClick={() => setTab("builder")}>
            Builder
          </TabButton>
          <TabButton active={tab === "runs"} icon={History} onClick={() => setTab("runs")}>
            Run history
          </TabButton>
        </div>
      </header>

      {tab === "builder" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <ReadinessBar
            enabled={enabled}
            dirty={dirty}
            issues={issues}
            onReview={(nodeId) => {
              setTab("builder");
              if (nodeId) setSelectedNodeId(nodeId);
            }}
          />
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <PipelinePalette
              catalog={catalog}
              selectedNodeName={selectedNodeName}
              onAdd={addNode}
            />
            <PipelineCanvas
              graph={graph}
              catalog={catalogByType}
              issues={issues}
              selectedNodeId={selectedNodeId}
              onSelect={setSelectedNodeId}
              onMove={(id, x, y) => {
                const node = graph.nodes.find((candidate) => candidate.id === id);
                if (node) updateNode(id, { ...node, x, y });
              }}
              onConnect={(fromId, toId, handle) => setConnection(fromId, handle, toId)}
              onDeleteEdge={deleteEdge}
              onArrange={() => updateGraph(arrangePipelineGraph(graph))}
            />
            <PipelineNodePanel
              company={company}
              pipeline={pipeline}
              graph={graph}
              catalog={catalogByType}
              node={selectedNode}
              entry={selectedEntry}
              issues={issues}
              resources={resources}
              integrationTools={integrationTools}
              onChange={(next) => updateNode(next.id, next)}
              onDelete={(id) => void deleteNode(id)}
              onClose={() => setSelectedNodeId(null)}
              onSetConnection={setConnection}
              onDeleteEdge={deleteEdge}
              onSelectIssue={setSelectedNodeId}
              onTokenRegenerated={(token) => {
                setGraph((current) =>
                  current
                    ? {
                        ...current,
                        nodes: current.nodes.map((node) =>
                          node.id === selectedNodeId
                            ? {
                                ...node,
                                config: { ...node.config, token },
                              }
                            : node,
                        ),
                      }
                    : current,
                );
                void refreshList();
              }}
            />
          </div>
        </div>
      ) : (
        <PipelineRuns
          company={company}
          pipelineId={pipeline.id}
          onOpenBuilder={() => setTab("builder")}
        />
      )}
    </div>
  );
}

function ReadinessBar({
  enabled,
  dirty,
  issues,
  onReview,
}: {
  enabled: boolean;
  dirty: boolean;
  issues: ReturnType<typeof getPipelineIssues>;
  onReview: (nodeId?: string) => void;
}) {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  if (!enabled) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-b border-slate-200 bg-slate-100 px-4 py-2 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-800 dark:text-slate-300 sm:px-6">
        <Pause size={14} className="shrink-0" />
        <span>This pipeline is paused. Scheduled and webhook runs will not start.</span>
        {dirty && <span className="ml-auto shrink-0 font-medium">Unsaved change</span>}
      </div>
    );
  }
  if (errors.length > 0) {
    const first = errors[0];
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-500/10 dark:text-amber-200 sm:px-6">
        <AlertCircle size={14} className="shrink-0" />
        <span>
          <strong>
            {errors.length} setup {errors.length === 1 ? "item" : "items"}
          </strong>{" "}
          before this pipeline can run. {first.title}.
        </span>
        <button
          type="button"
          onClick={() => onReview(first.nodeId)}
          className="ml-auto shrink-0 font-semibold underline underline-offset-2"
        >
          Review first item
        </button>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200 sm:px-6">
      <CheckCircle2 size={14} className="shrink-0" />
      <span>
        Ready to test
        {warnings.length > 0
          ? ` · ${warnings.length} optional warning${warnings.length === 1 ? "" : "s"}`
          : ""}
        .
      </span>
      {dirty && <span className="ml-auto shrink-0 font-medium">Unsaved changes</span>}
    </div>
  );
}

function TabButton({
  active,
  icon: Icon,
  children,
  onClick,
}: {
  active: boolean;
  icon: typeof Workflow;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={
        "inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition " +
        (active
          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-500 hover:bg-slate-50 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-900 dark:hover:text-slate-200")
      }
    >
      <Icon size={14} /> {children}
    </button>
  );
}
