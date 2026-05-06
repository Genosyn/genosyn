import React from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import {
  Bot,
  BookOpen,
  CalendarClock,
  Clock,
  Copy,
  Database,
  FolderPlus,
  Globe,
  ListTodo,
  type LucideIcon,
  MessageSquare,
  Play,
  Plug,
  Plus,
  Save,
  Split,
  Trash2,
  Variable,
  Webhook,
  Workflow,
  X,
} from "lucide-react";
import {
  api,
  Company,
  Pipeline,
  PipelineGraph,
  PipelineNode,
  PipelineNodeCatalogEntry,
  PipelineRunDetail,
  PipelineRunSummary,
} from "../lib/api";
import { copyToClipboard } from "../lib/clipboard";
import { Breadcrumbs } from "../components/AppShell";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Textarea } from "../components/ui/Textarea";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { useDialog } from "../components/ui/Dialog";
import { PipelinesContext } from "./PipelinesLayout";

/**
 * The Pipeline editor: visual canvas of nodes + edges, right-side config
 * panel, run-history tab. Custom canvas (no react-flow): nodes are absolutely
 * positioned divs, edges are SVG cubic Beziers between handle points.
 *
 * Local state holds the in-flight graph. "Save" PATCHes the whole graph back
 * (the server recomputes cron + webhook tokens). "Run now" fires the manual
 * trigger and refreshes the run history tab.
 */

const NODE_WIDTH = 240;
const NODE_HEIGHT_BASE = 80;

// ─── Icon map (catalog ships an icon name; we resolve to the component) ─────

const ICON_MAP: Record<string, LucideIcon> = {
  Play,
  Webhook,
  CalendarClock,
  MessageSquare,
  ListTodo,
  FolderPlus,
  DatabasePlus: Database,
  Bot,
  BookOpen,
  Globe,
  Variable,
  Split,
  Clock,
  Plug,
  Workflow,
};

function iconFor(name?: string): LucideIcon {
  if (name && ICON_MAP[name]) return ICON_MAP[name];
  return Workflow;
}

const FAMILY_TONE: Record<string, string> = {
  trigger:
    "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-500/10 dark:text-amber-200",
  action:
    "border-indigo-200 bg-indigo-50 text-indigo-900 dark:border-indigo-700/60 dark:bg-indigo-500/10 dark:text-indigo-200",
  logic:
    "border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
  integration:
    "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-500/10 dark:text-emerald-200",
};

export default function PipelineDetail({ company }: { company: Company }) {
  const params = useParams();
  const navigate = useNavigate();
  const slug = params.pSlug ?? "";
  const { refresh: refreshList } = useOutletContext<PipelinesContext>();
  const { toast } = useToast();
  const dialog = useDialog();

  const [pipeline, setPipeline] = React.useState<Pipeline | null>(null);
  const [catalog, setCatalog] = React.useState<PipelineNodeCatalogEntry[]>([]);
  const [graph, setGraph] = React.useState<PipelineGraph | null>(null);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [enabled, setEnabled] = React.useState(true);
  const [dirty, setDirty] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [tab, setTab] = React.useState<"editor" | "runs">("editor");
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null);

  // ── Load pipeline + catalog ──
  const load = React.useCallback(async () => {
    const [p, cat] = await Promise.all([
      api.get<Pipeline>(`/api/companies/${company.id}/pipelines/${slug}`),
      api.get<{ catalog: PipelineNodeCatalogEntry[] }>(
        `/api/companies/${company.id}/pipelines/catalog`,
      ),
    ]);
    setPipeline(p);
    setGraph(p.graph);
    setName(p.name);
    setDescription(p.description ?? "");
    setEnabled(p.enabled);
    setCatalog(cat.catalog);
    setDirty(false);
  }, [company.id, slug]);

  React.useEffect(() => {
    load().catch((err) => toast((err as Error).message, "error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // ── Mutate graph ──
  const updateGraph = React.useCallback((next: PipelineGraph) => {
    setGraph(next);
    setDirty(true);
  }, []);

  const addNode = React.useCallback(
    (type: string, x: number, y: number) => {
      if (!graph) return;
      const entry = catalog.find((c) => c.type === type);
      if (!entry) return;
      const id = `n_${Math.random().toString(36).slice(2, 8)}`;
      const config: Record<string, unknown> = {};
      for (const f of entry.fields) {
        if (f.default !== undefined) config[f.key] = f.default;
      }
      const node: PipelineNode = { id, type, x, y, config };
      updateGraph({ ...graph, nodes: [...graph.nodes, node] });
      setSelectedNodeId(id);
    },
    [graph, catalog, updateGraph],
  );

  const updateNode = React.useCallback(
    (id: string, updater: (n: PipelineNode) => PipelineNode) => {
      if (!graph) return;
      updateGraph({
        ...graph,
        nodes: graph.nodes.map((n) => (n.id === id ? updater(n) : n)),
      });
    },
    [graph, updateGraph],
  );

  const deleteNode = React.useCallback(
    (id: string) => {
      if (!graph) return;
      updateGraph({
        nodes: graph.nodes.filter((n) => n.id !== id),
        edges: graph.edges.filter(
          (e) => e.fromNodeId !== id && e.toNodeId !== id,
        ),
      });
      if (selectedNodeId === id) setSelectedNodeId(null);
    },
    [graph, updateGraph, selectedNodeId],
  );

  const addEdge = React.useCallback(
    (fromNodeId: string, toNodeId: string, fromHandle = "out") => {
      if (!graph) return;
      if (fromNodeId === toNodeId) return;
      // Replace any existing edge from the same (node, handle) so the editor
      // stays a tree-like UI. Users can branch only via explicit branch nodes.
      const next = graph.edges.filter(
        (e) =>
          !(e.fromNodeId === fromNodeId && (e.fromHandle ?? "out") === fromHandle),
      );
      next.push({
        id: `e_${Math.random().toString(36).slice(2, 8)}`,
        fromNodeId,
        toNodeId,
        fromHandle,
      });
      updateGraph({ ...graph, edges: next });
    },
    [graph, updateGraph],
  );

  const deleteEdge = React.useCallback(
    (id: string) => {
      if (!graph) return;
      updateGraph({ ...graph, edges: graph.edges.filter((e) => e.id !== id) });
    },
    [graph, updateGraph],
  );

  // ── Save / run ──
  async function save() {
    if (!pipeline || !graph) return;
    setSaving(true);
    try {
      const updated = await api.patch<Pipeline>(
        `/api/companies/${company.id}/pipelines/${pipeline.id}`,
        { name, description, enabled, graph },
      );
      setPipeline(updated);
      setGraph(updated.graph);
      setDirty(false);
      await refreshList();
      toast("Saved", "success");
      // If the slug changed (we don't currently rename slug, but keep guard)
      if (updated.slug !== slug) {
        navigate(`/c/${company.slug}/pipelines/${updated.slug}`, { replace: true });
      }
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    if (!pipeline) return;
    setRunning(true);
    try {
      if (dirty) {
        await save();
      }
      const result = await api.post<{ status: string; errorMessage: string | null }>(
        `/api/companies/${company.id}/pipelines/${pipeline.id}/run`,
        {},
      );
      if (result.status === "completed") {
        toast("Pipeline completed", "success");
      } else if (result.status === "failed") {
        toast(`Pipeline failed: ${result.errorMessage ?? "(no message)"}`, "error");
      } else {
        toast(`Pipeline ${result.status}`, "info");
      }
      setTab("runs");
    } catch (err) {
      toast((err as Error).message, "error");
    } finally {
      setRunning(false);
    }
  }

  async function destroy() {
    if (!pipeline) return;
    const ok = await dialog.confirm({
      title: `Delete pipeline "${pipeline.name}"?`,
      message:
        "This deletes the pipeline and all its run history. This cannot be undone.",
      confirmLabel: "Delete pipeline",
      variant: "danger",
    });
    if (!ok) return;
    try {
      await api.del(`/api/companies/${company.id}/pipelines/${pipeline.id}`);
      await refreshList();
      navigate(`/c/${company.slug}/pipelines`, { replace: true });
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  if (!pipeline || !graph) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={20} />
      </div>
    );
  }

  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const catalogByType = new Map(catalog.map((c) => [c.type, c]));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="border-b border-slate-200 bg-white px-6 py-3 dark:border-slate-800 dark:bg-slate-950">
        <Breadcrumbs
          items={[
            { label: company.name, to: `/c/${company.slug}` },
            { label: "Pipelines", to: `/c/${company.slug}/pipelines` },
            { label: pipeline.name },
          ]}
        />
        <div className="mt-2 flex items-center gap-3">
          <Workflow size={18} className="text-indigo-600" />
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            className="flex-1 bg-transparent text-lg font-semibold text-slate-900 outline-none focus:ring-0 dark:text-slate-100"
          />
          <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setDirty(true);
              }}
              className="h-4 w-4 accent-indigo-600"
            />
            Enabled
          </label>
          <Button variant="secondary" size="sm" onClick={runNow} disabled={running}>
            <Play size={14} /> {running ? "Running…" : "Run now"}
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            <Save size={14} /> {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </Button>
          <button
            onClick={destroy}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800"
            title="Delete pipeline"
            aria-label="Delete pipeline"
          >
            <Trash2 size={16} />
          </button>
        </div>
        <Textarea
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            setDirty(true);
          }}
          placeholder="Optional description"
          rows={1}
          className="mt-2 min-h-[34px] resize-none px-2 py-1 text-sm"
        />
        <div className="mt-3 flex items-center gap-1 text-sm">
          <TabBtn active={tab === "editor"} onClick={() => setTab("editor")}>
            Editor
          </TabBtn>
          <TabBtn active={tab === "runs"} onClick={() => setTab("runs")}>
            Runs
          </TabBtn>
        </div>
      </div>

      {/* Body */}
      {tab === "editor" ? (
        <div className="flex min-h-0 flex-1">
          <Palette catalog={catalog} onAdd={(type) => addNode(type, 120, 120)} />
          <Canvas
            graph={graph}
            catalog={catalogByType}
            selectedNodeId={selectedNodeId}
            onSelect={setSelectedNodeId}
            onMove={(id, x, y) => updateNode(id, (n) => ({ ...n, x, y }))}
            onConnect={addEdge}
            onDeleteEdge={deleteEdge}
          />
          <RightPanel
            company={company}
            pipeline={pipeline}
            node={selectedNode}
            entry={selectedNode ? catalogByType.get(selectedNode.type) ?? null : null}
            onChange={(next) => updateNode(next.id, () => next)}
            onDelete={(id) => deleteNode(id)}
            onClose={() => setSelectedNodeId(null)}
            onTokenRegenerated={(token) => {
              if (!selectedNode) return;
              updateNode(selectedNode.id, (n) => ({
                ...n,
                config: { ...n.config, token },
              }));
              toast("Webhook token regenerated", "success");
            }}
          />
        </div>
      ) : (
        <RunsTab company={company} pipelineId={pipeline.id} />
      )}
    </div>
  );
}

function TabBtn({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded-md px-3 py-1.5 text-sm font-medium " +
        (active
          ? "bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100"
          : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800")
      }
    >
      {children}
    </button>
  );
}

// ─── Palette (left rail with the node catalog) ──────────────────────────────

function Palette({
  catalog,
  onAdd,
}: {
  catalog: PipelineNodeCatalogEntry[];
  onAdd: (type: string) => void;
}) {
  const families: { key: PipelineNodeCatalogEntry["family"]; label: string }[] = [
    { key: "trigger", label: "Triggers" },
    { key: "action", label: "Genosyn actions" },
    { key: "logic", label: "Logic" },
    { key: "integration", label: "Integrations" },
  ];
  return (
    <aside className="w-60 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        Add node
      </div>
      {families.map((fam) => {
        const items = catalog.filter((c) => c.family === fam.key);
        if (items.length === 0) return null;
        return (
          <div key={fam.key} className="mb-3">
            <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
              {fam.label}
            </div>
            <div className="space-y-1">
              {items.map((entry) => {
                const Icon = iconFor(entry.icon);
                return (
                  <button
                    key={entry.type}
                    type="button"
                    onClick={() => onAdd(entry.type)}
                    className={
                      "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm " +
                      (FAMILY_TONE[entry.family] ?? "")
                    }
                    title={entry.description}
                  >
                    <Icon size={14} />
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    <Plus size={12} className="opacity-60" />
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </aside>
  );
}

// ─── Canvas ─────────────────────────────────────────────────────────────────

type Drag =
  | { kind: "node"; nodeId: string; offsetX: number; offsetY: number }
  | { kind: "edge"; fromNodeId: string; fromHandle: string; cursorX: number; cursorY: number };

function Canvas({
  graph,
  catalog,
  selectedNodeId,
  onSelect,
  onMove,
  onConnect,
  onDeleteEdge,
}: {
  graph: PipelineGraph;
  catalog: Map<string, PipelineNodeCatalogEntry>;
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onConnect: (fromId: string, toId: string, fromHandle: string) => void;
  onDeleteEdge: (edgeId: string) => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);

  function clientToCanvas(e: { clientX: number; clientY: number }) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: e.clientX - rect.left + (ref.current?.scrollLeft ?? 0),
      y: e.clientY - rect.top + (ref.current?.scrollTop ?? 0),
    };
  }

  function onMouseMove(e: React.MouseEvent) {
    if (!drag) return;
    if (drag.kind === "node") {
      const pos = clientToCanvas(e);
      onMove(drag.nodeId, Math.max(0, pos.x - drag.offsetX), Math.max(0, pos.y - drag.offsetY));
    } else if (drag.kind === "edge") {
      const pos = clientToCanvas(e);
      setDrag({ ...drag, cursorX: pos.x, cursorY: pos.y });
    }
  }

  function endDrag() {
    setDrag(null);
  }

  function startNodeDrag(node: PipelineNode, e: React.MouseEvent) {
    if ((e.target as HTMLElement).closest("[data-handle]")) return;
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(node.id);
    const pos = clientToCanvas(e);
    setDrag({
      kind: "node",
      nodeId: node.id,
      offsetX: pos.x - node.x,
      offsetY: pos.y - node.y,
    });
  }

  function startEdgeDrag(node: PipelineNode, handle: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const pos = clientToCanvas(e);
    setDrag({
      kind: "edge",
      fromNodeId: node.id,
      fromHandle: handle,
      cursorX: pos.x,
      cursorY: pos.y,
    });
  }

  function endEdgeDrag(targetId: string) {
    if (drag?.kind === "edge") {
      onConnect(drag.fromNodeId, targetId, drag.fromHandle);
    }
    setDrag(null);
  }

  // Compute bounding box so the canvas grows with the graph.
  const maxX = Math.max(900, ...graph.nodes.map((n) => n.x + NODE_WIDTH + 80));
  const maxY = Math.max(600, ...graph.nodes.map((n) => n.y + 200));

  return (
    <div
      ref={ref}
      className="relative min-w-0 flex-1 overflow-auto bg-slate-50 dark:bg-slate-900"
      style={{
        backgroundImage:
          "radial-gradient(circle, rgba(148,163,184,0.18) 1px, transparent 1px)",
        backgroundSize: "16px 16px",
      }}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onClick={(e) => {
        if (e.target === ref.current) onSelect(null);
      }}
    >
      <div className="relative" style={{ width: maxX, height: maxY }}>
        {/* Edges */}
        <svg
          width={maxX}
          height={maxY}
          className="pointer-events-none absolute inset-0"
        >
          {graph.edges.map((edge) => {
            const from = graph.nodes.find((n) => n.id === edge.fromNodeId);
            const to = graph.nodes.find((n) => n.id === edge.toNodeId);
            if (!from || !to) return null;
            const handle = edge.fromHandle ?? "out";
            const fromEntry = catalog.get(from.type);
            const handles = fromEntry?.outputs ?? ["out"];
            const handleIdx = Math.max(0, handles.indexOf(handle));
            const fromPt = handlePosition(from, "right", handleIdx, handles.length);
            const toPt = handlePosition(to, "left", 0, 1);
            return (
              <g key={edge.id} className="pointer-events-auto">
                <path
                  d={cubic(fromPt, toPt)}
                  stroke={
                    handle === "false"
                      ? "rgb(244 63 94)"
                      : handle === "true"
                        ? "rgb(16 185 129)"
                        : "rgb(99 102 241)"
                  }
                  strokeWidth={2}
                  fill="none"
                />
                <path
                  d={cubic(fromPt, toPt)}
                  stroke="transparent"
                  strokeWidth={14}
                  fill="none"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteEdge(edge.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <title>Click to remove edge</title>
                </path>
              </g>
            );
          })}
          {/* Pending edge while dragging */}
          {drag?.kind === "edge" &&
            (() => {
              const node = graph.nodes.find((n) => n.id === drag.fromNodeId);
              if (!node) return null;
              const entry = catalog.get(node.type);
              const handles = entry?.outputs ?? ["out"];
              const idx = Math.max(0, handles.indexOf(drag.fromHandle));
              const fromPt = handlePosition(node, "right", idx, handles.length);
              const toPt = { x: drag.cursorX, y: drag.cursorY };
              return (
                <path
                  d={cubic(fromPt, toPt)}
                  stroke="rgb(99 102 241)"
                  strokeDasharray="4 4"
                  strokeWidth={2}
                  fill="none"
                />
              );
            })()}
        </svg>

        {/* Nodes */}
        {graph.nodes.map((node) => {
          const entry = catalog.get(node.type);
          const Icon = iconFor(entry?.icon);
          const handles = entry?.outputs ?? ["out"];
          const isSelected = node.id === selectedNodeId;
          const tone = FAMILY_TONE[entry?.family ?? "logic"] ?? FAMILY_TONE.logic;
          return (
            <div
              key={node.id}
              className={
                "absolute select-none rounded-xl border shadow-sm " +
                tone +
                (isSelected ? " ring-2 ring-indigo-500" : "")
              }
              style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
              onMouseDown={(e) => startNodeDrag(node, e)}
              onMouseUp={() => {
                if (drag?.kind === "edge") endEdgeDrag(node.id);
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(node.id);
              }}
            >
              {/* Input handle (left) */}
              {!entry?.type.startsWith("trigger.") && (
                <div
                  data-handle="in"
                  className="absolute left-[-7px] top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-white bg-indigo-500 shadow"
                  onMouseUp={(e) => {
                    e.stopPropagation();
                    if (drag?.kind === "edge") endEdgeDrag(node.id);
                  }}
                />
              )}
              <div className="flex items-center gap-2 px-3 pt-2 text-sm font-medium">
                <Icon size={14} />
                <span className="min-w-0 flex-1 truncate">
                  {node.label ?? entry?.label ?? node.type}
                </span>
              </div>
              <div className="px-3 pb-2 pt-0.5 text-[11px] uppercase tracking-wide text-current/70">
                {entry?.family ?? "logic"} · {node.type}
              </div>
              <NodeSummary node={node} entry={entry} />

              {/* Output handles (right) */}
              {handles.map((h, i) => (
                <div
                  key={h}
                  data-handle="out"
                  data-handle-name={h}
                  className="absolute right-[-7px] flex items-center gap-1"
                  style={{
                    top: handles.length === 1
                      ? "50%"
                      : `${30 + (i * 100) / Math.max(1, handles.length - 1) * 0.4 + 10}%`,
                    transform: "translateY(-50%)",
                  }}
                  onMouseDown={(e) => startEdgeDrag(node, h, e)}
                >
                  {handles.length > 1 && (
                    <span
                      className={
                        "rounded px-1 text-[10px] font-semibold " +
                        (h === "true"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200"
                          : h === "false"
                            ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200"
                            : "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-200")
                      }
                    >
                      {h}
                    </span>
                  )}
                  <div className="h-3 w-3 rounded-full border-2 border-white bg-indigo-500 shadow" />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NodeSummary({
  node,
  entry,
}: {
  node: PipelineNode;
  entry: PipelineNodeCatalogEntry | undefined;
}) {
  if (!entry) return null;
  // Pick the first non-empty field value as a quick preview line.
  let preview = "";
  for (const f of entry.fields) {
    const v = node.config[f.key];
    if (v === undefined || v === null || v === "" || v === "{}") continue;
    preview = `${f.label}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
    break;
  }
  if (!preview) return <div className="px-3 pb-3 text-[11px] italic opacity-60">unconfigured</div>;
  return <div className="line-clamp-2 px-3 pb-3 text-[11px] opacity-80">{preview}</div>;
}

function handlePosition(
  node: PipelineNode,
  side: "left" | "right",
  handleIdx: number,
  handleCount: number,
): { x: number; y: number } {
  const x = side === "left" ? node.x : node.x + NODE_WIDTH;
  let y = node.y + NODE_HEIGHT_BASE / 2 + 6;
  if (handleCount > 1 && side === "right") {
    // Match the visual placement above (30% / 70%).
    y =
      node.y +
      NODE_HEIGHT_BASE *
        (0.3 + (handleIdx / Math.max(1, handleCount - 1)) * 0.4 + 0.1);
  }
  return { x, y };
}

function cubic(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const dx = Math.abs(b.x - a.x);
  const cx1 = a.x + Math.max(40, dx / 2);
  const cx2 = b.x - Math.max(40, dx / 2);
  return `M ${a.x} ${a.y} C ${cx1} ${a.y}, ${cx2} ${b.y}, ${b.x} ${b.y}`;
}

// ─── Right config panel ────────────────────────────────────────────────────

function RightPanel({
  company,
  pipeline,
  node,
  entry,
  onChange,
  onDelete,
  onClose,
  onTokenRegenerated,
}: {
  company: Company;
  pipeline: Pipeline;
  node: PipelineNode | null;
  entry: PipelineNodeCatalogEntry | null;
  onChange: (next: PipelineNode) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
  onTokenRegenerated: (token: string) => void;
}) {
  if (!node || !entry) {
    return (
      <aside className="hidden w-80 shrink-0 border-l border-slate-200 bg-white p-4 text-sm text-slate-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400 md:block">
        Click a node to configure it. Drag from the right handle to another
        node&apos;s left handle to connect them.
      </aside>
    );
  }
  const Icon = iconFor(entry.icon);
  return (
    <aside className="hidden w-96 shrink-0 overflow-y-auto border-l border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 md:block">
      <div className="flex items-center gap-2 border-b border-slate-200 p-3 dark:border-slate-800">
        <Icon size={16} className="text-indigo-600" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
            {entry.label}
          </div>
          <div className="truncate text-xs text-slate-500 dark:text-slate-400">
            {entry.description}
          </div>
        </div>
        <button
          onClick={() => onDelete(node.id)}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-rose-600 dark:hover:bg-slate-800"
          title="Delete node"
          aria-label="Delete node"
        >
          <Trash2 size={14} />
        </button>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800"
          title="Close panel"
          aria-label="Close panel"
        >
          <X size={14} />
        </button>
      </div>
      <div className="space-y-4 p-4">
        <Input
          label="Display label"
          value={node.label ?? ""}
          placeholder={entry.label}
          onChange={(e) => onChange({ ...node, label: e.target.value || undefined })}
        />
        {entry.fields.map((f) => (
          <FieldEditor
            key={f.key}
            field={f}
            value={node.config[f.key]}
            onChange={(value) =>
              onChange({ ...node, config: { ...node.config, [f.key]: value } })
            }
          />
        ))}
        {node.type === "trigger.webhook" && (
          <WebhookCallout
            company={company}
            pipeline={pipeline}
            node={node}
            onRegenerate={onTokenRegenerated}
          />
        )}
      </div>
    </aside>
  );
}

function FieldEditor({
  field,
  value,
  onChange,
}: {
  field: PipelineNodeCatalogEntry["fields"][number];
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const v = value === undefined || value === null ? "" : value;
  if (field.type === "longtext" || field.type === "code") {
    return (
      <Textarea
        label={field.label}
        value={typeof v === "string" ? v : JSON.stringify(v)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        rows={field.type === "code" ? 6 : 4}
      />
    );
  }
  if (field.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
        <input
          type="checkbox"
          checked={Boolean(v)}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-indigo-600"
        />
        {field.label}
      </label>
    );
  }
  if (field.type === "select" && field.options) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
          {field.label}
        </label>
        <select
          value={String(v)}
          onChange={(e) => onChange(e.target.value)}
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.hint && (
          <p className="text-xs text-slate-500 dark:text-slate-400">{field.hint}</p>
        )}
      </div>
    );
  }
  if (field.type === "number") {
    return (
      <Input
        label={field.label}
        type="number"
        value={typeof v === "number" ? v : v === "" ? "" : Number(v)}
        onChange={(e) =>
          onChange(e.target.value === "" ? "" : Number(e.target.value))
        }
        placeholder={field.placeholder}
      />
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <Input
        label={field.label}
        value={String(v)}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
      />
      {field.hint && (
        <p className="text-xs text-slate-500 dark:text-slate-400">{field.hint}</p>
      )}
    </div>
  );
}

function WebhookCallout({
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
  const token = String(node.config.token ?? "");
  const url = token
    ? `${window.location.origin}/api/webhooks/pipelines/${pipeline.id}/${token}`
    : null;
  async function regen() {
    try {
      const result = await api.post<{ token: string }>(
        `/api/companies/${company.id}/pipelines/${pipeline.id}/webhook-token`,
        { nodeId: node.id },
      );
      onRegenerate(result.token);
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-1 font-semibold text-slate-700 dark:text-slate-200">
        Webhook URL
      </div>
      {url ? (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto rounded bg-white px-2 py-1 font-mono text-[11px] text-slate-700 dark:bg-slate-950 dark:text-slate-300">
            {url}
          </code>
          <button
            onClick={async () => {
              const ok = await copyToClipboard(url);
              toast(ok ? "Copied" : "Could not access clipboard", ok ? "success" : "error");
            }}
            className="rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
            title="Copy URL"
            aria-label="Copy URL"
          >
            <Copy size={12} />
          </button>
        </div>
      ) : (
        <p className="text-slate-500 dark:text-slate-400">
          Save the pipeline to mint a token.
        </p>
      )}
      <p className="mt-2 text-slate-500 dark:text-slate-400">
        POST any JSON to this URL to fire the pipeline. The body becomes
        <code className="mx-1 rounded bg-slate-200 px-1 dark:bg-slate-800">trigger.payload</code>.
      </p>
      <Button
        variant="secondary"
        size="sm"
        className="mt-2"
        onClick={regen}
      >
        Regenerate token
      </Button>
    </div>
  );
}

// ─── Runs tab ───────────────────────────────────────────────────────────────

function RunsTab({ company, pipelineId }: { company: Company; pipelineId: string }) {
  const [runs, setRuns] = React.useState<PipelineRunSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<PipelineRunDetail | null>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await api.get<PipelineRunSummary[]>(
          `/api/companies/${company.id}/pipelines/${pipelineId}/runs`,
        );
        if (!cancelled) {
          setRuns(list);
          if (list.length && !selectedId) setSelectedId(list[0].id);
        }
      } catch (err) {
        if (!cancelled) toast((err as Error).message, "error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const interval = window.setInterval(load, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, pipelineId]);

  React.useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    async function load() {
      try {
        const d = await api.get<PipelineRunDetail>(
          `/api/companies/${company.id}/pipeline-runs/${selectedId}`,
        );
        if (!cancelled) setDetail(d);
      } catch (err) {
        if (!cancelled) toast((err as Error).message, "error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company.id, selectedId]);

  return (
    <div className="flex min-h-0 flex-1 bg-slate-50 dark:bg-slate-900">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
        {loading ? (
          <div className="p-4 text-xs text-slate-400">Loading runs…</div>
        ) : runs.length === 0 ? (
          <div className="p-4 text-xs text-slate-500 dark:text-slate-400">
            No runs yet. Click <em>Run now</em> in the editor to fire a manual
            execution.
          </div>
        ) : (
          <ul>
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setSelectedId(r.id)}
                  className={
                    "block w-full border-b border-slate-100 px-3 py-2 text-left text-sm dark:border-slate-800 " +
                    (r.id === selectedId
                      ? "bg-indigo-50 dark:bg-indigo-500/10"
                      : "hover:bg-slate-50 dark:hover:bg-slate-800")
                  }
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={r.status} />
                    <span className="font-medium text-slate-800 dark:text-slate-100">
                      {r.status}
                    </span>
                    <span className="ml-auto text-[11px] text-slate-500 dark:text-slate-400">
                      {r.triggerKind}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {new Date(r.startedAt).toLocaleString()}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {detail ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <StatusDot status={detail.status} />
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Run · {detail.status}
              </h3>
              <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">
                {new Date(detail.startedAt).toLocaleString()}
                {detail.finishedAt &&
                  ` → ${new Date(detail.finishedAt).toLocaleString()}`}
              </span>
            </div>
            {detail.errorMessage && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-500/10 dark:text-rose-200">
                {detail.errorMessage}
              </div>
            )}
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Log
              </div>
              <pre className="max-h-96 overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-3 text-[12px] leading-snug text-slate-100">
                {detail.logContent || "(no log captured)"}
                {detail.truncated && "\n\n[truncated]"}
              </pre>
            </div>
            <details className="rounded-lg border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-950">
              <summary className="cursor-pointer text-slate-700 dark:text-slate-300">
                Trigger payload
              </summary>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap text-slate-600 dark:text-slate-400">
                {pretty(detail.inputJson)}
              </pre>
            </details>
            <details className="rounded-lg border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-950">
              <summary className="cursor-pointer text-slate-700 dark:text-slate-300">
                Final outputs (per node)
              </summary>
              <pre className="mt-2 overflow-auto whitespace-pre-wrap text-slate-600 dark:text-slate-400">
                {pretty(detail.outputJson)}
              </pre>
            </details>
          </div>
        ) : (
          <div className="text-sm text-slate-500 dark:text-slate-400">
            Select a run to view its log.
          </div>
        )}
      </main>
    </div>
  );
}

function pretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

function StatusDot({ status }: { status: PipelineRunSummary["status"] }) {
  const tone =
    status === "completed"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-rose-500"
        : status === "running"
          ? "bg-amber-500 animate-pulse"
          : "bg-slate-400";
  return <span className={`inline-block h-2 w-2 rounded-full ${tone}`} />;
}
