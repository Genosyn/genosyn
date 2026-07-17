import React from "react";
import { AlertCircle, CheckCircle2, LayoutGrid, MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { PipelineGraph, PipelineNode, PipelineNodeCatalogEntry } from "@/lib/api";
import {
  PIPELINE_FAMILY_META,
  PIPELINE_NODE_HEIGHT,
  PIPELINE_NODE_WIDTH,
  type PipelineIssue,
  nodeDisplayName,
  pipelineIcon,
} from "@/pages/pipelines/pipelineUi";

type Drag =
  | { kind: "node"; nodeId: string; offsetX: number; offsetY: number }
  | {
      kind: "edge";
      fromNodeId: string;
      fromHandle: string;
      cursorX: number;
      cursorY: number;
    };

export function PipelineCanvas({
  graph,
  catalog,
  issues,
  selectedNodeId,
  onSelect,
  onMove,
  onConnect,
  onDeleteEdge,
  onArrange,
}: {
  graph: PipelineGraph;
  catalog: Map<string, PipelineNodeCatalogEntry>;
  issues: PipelineIssue[];
  selectedNodeId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
  onConnect: (fromId: string, toId: string, fromHandle: string) => void;
  onDeleteEdge: (edgeId: string) => void;
  onArrange: () => void;
}) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const nodesWithErrors = React.useMemo(
    () =>
      new Set(
        issues
          .filter((issue) => issue.severity === "error" && issue.nodeId)
          .map((issue) => issue.nodeId),
      ),
    [issues],
  );

  function clientToCanvas(event: { clientX: number; clientY: number }) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: event.clientX - rect.left + (ref.current?.scrollLeft ?? 0),
      y: event.clientY - rect.top + (ref.current?.scrollTop ?? 0),
    };
  }

  function onMouseMove(event: React.MouseEvent) {
    if (!drag) return;
    if (drag.kind === "node") {
      const position = clientToCanvas(event);
      onMove(
        drag.nodeId,
        Math.max(16, position.x - drag.offsetX),
        Math.max(16, position.y - drag.offsetY),
      );
      return;
    }
    const position = clientToCanvas(event);
    setDrag({ ...drag, cursorX: position.x, cursorY: position.y });
  }

  function startNodeDrag(node: PipelineNode, event: React.MouseEvent) {
    if ((event.target as HTMLElement).closest("[data-handle]")) return;
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(node.id);
    const position = clientToCanvas(event);
    setDrag({
      kind: "node",
      nodeId: node.id,
      offsetX: position.x - node.x,
      offsetY: position.y - node.y,
    });
  }

  function startEdgeDrag(node: PipelineNode, handle: string, event: React.MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    const position = clientToCanvas(event);
    setDrag({
      kind: "edge",
      fromNodeId: node.id,
      fromHandle: handle,
      cursorX: position.x,
      cursorY: position.y,
    });
  }

  function endEdgeDrag(targetId: string) {
    if (drag?.kind === "edge") {
      onConnect(drag.fromNodeId, targetId, drag.fromHandle);
    }
    setDrag(null);
  }

  const maxX = Math.max(900, ...graph.nodes.map((node) => node.x + PIPELINE_NODE_WIDTH + 120));
  const maxY = Math.max(620, ...graph.nodes.map((node) => node.y + 220));

  return (
    <div
      ref={ref}
      className="relative min-h-[520px] min-w-0 flex-1 overflow-auto bg-slate-50 [background-image:radial-gradient(circle,rgba(148,163,184,0.2)_1px,transparent_1px)] [background-size:16px_16px] dark:bg-slate-900"
      onMouseMove={onMouseMove}
      onMouseUp={() => setDrag(null)}
      onMouseLeave={() => setDrag(null)}
      onClick={(event) => {
        if (event.target === ref.current) onSelect(null);
      }}
    >
      <div className="sticky left-0 top-0 z-20 flex w-full justify-end p-3 pointer-events-none">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="pointer-events-auto shadow-sm"
          onClick={onArrange}
          disabled={graph.nodes.length < 2}
          title="Lay out connected steps from left to right"
        >
          <LayoutGrid size={14} /> Arrange
        </Button>
      </div>

      {graph.nodes.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8">
          <div className="max-w-sm rounded-xl border border-dashed border-slate-300 bg-white/90 p-6 text-center shadow-sm dark:border-slate-700 dark:bg-slate-950/90">
            <MousePointer2 size={22} className="mx-auto text-indigo-500" />
            <div className="mt-3 text-sm font-semibold text-slate-900 dark:text-slate-100">
              Add a trigger to begin
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">
              Use the step library to choose what starts this pipeline.
            </p>
          </div>
        </div>
      )}

      <div className="relative -mt-14" style={{ width: maxX, height: maxY }}>
        <svg
          width={maxX}
          height={maxY}
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
        >
          <defs>
            <marker
              id="pipeline-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="rgb(99 102 241)" />
            </marker>
            <marker
              id="pipeline-arrow-true"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="rgb(16 185 129)" />
            </marker>
            <marker
              id="pipeline-arrow-false"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <path d="M0,0 L8,4 L0,8 Z" fill="rgb(244 63 94)" />
            </marker>
          </defs>
          {graph.edges.map((edge) => {
            const from = graph.nodes.find((node) => node.id === edge.fromNodeId);
            const to = graph.nodes.find((node) => node.id === edge.toNodeId);
            if (!from || !to) return null;
            const handle = edge.fromHandle ?? "out";
            const fromEntry = catalog.get(from.type);
            const handles = fromEntry?.outputs ?? ["out"];
            const handleIndex = Math.max(0, handles.indexOf(handle));
            const fromPoint = handlePosition(from, "right", handleIndex, handles.length);
            const toPoint = handlePosition(to, "left", 0, 1);
            const color =
              handle === "false"
                ? "rgb(244 63 94)"
                : handle === "true"
                  ? "rgb(16 185 129)"
                  : "rgb(99 102 241)";
            const marker =
              handle === "false"
                ? "url(#pipeline-arrow-false)"
                : handle === "true"
                  ? "url(#pipeline-arrow-true)"
                  : "url(#pipeline-arrow)";
            return (
              <g key={edge.id} className="pointer-events-auto">
                <path
                  d={cubic(fromPoint, toPoint)}
                  stroke={color}
                  strokeWidth={2}
                  fill="none"
                  markerEnd={marker}
                />
                <path
                  d={cubic(fromPoint, toPoint)}
                  stroke="transparent"
                  strokeWidth={16}
                  fill="none"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteEdge(edge.id);
                  }}
                  className="cursor-pointer"
                >
                  <title>Click to remove this connection</title>
                </path>
              </g>
            );
          })}
          {drag?.kind === "edge" &&
            (() => {
              const node = graph.nodes.find((item) => item.id === drag.fromNodeId);
              if (!node) return null;
              const entry = catalog.get(node.type);
              const handles = entry?.outputs ?? ["out"];
              const index = Math.max(0, handles.indexOf(drag.fromHandle));
              const fromPoint = handlePosition(node, "right", index, handles.length);
              return (
                <path
                  d={cubic(fromPoint, {
                    x: drag.cursorX,
                    y: drag.cursorY,
                  })}
                  stroke="rgb(99 102 241)"
                  strokeDasharray="4 4"
                  strokeWidth={2}
                  fill="none"
                />
              );
            })()}
        </svg>

        {graph.nodes.map((node) => {
          const entry = catalog.get(node.type);
          const Icon = pipelineIcon(entry?.icon);
          const handles = entry?.outputs ?? ["out"];
          const isSelected = node.id === selectedNodeId;
          const hasError = nodesWithErrors.has(node.id);
          const family = entry?.family ?? "logic";
          return (
            <div
              key={node.id}
              className={
                "absolute select-none rounded-xl border shadow-sm transition-shadow " +
                PIPELINE_FAMILY_META[family].tone +
                (isSelected
                  ? " ring-2 ring-indigo-500 ring-offset-2 ring-offset-slate-50 dark:ring-offset-slate-900"
                  : " hover:shadow-md")
              }
              style={{ left: node.x, top: node.y, width: PIPELINE_NODE_WIDTH }}
              onMouseDown={(event) => startNodeDrag(node, event)}
              onMouseUp={() => {
                if (drag?.kind === "edge") endEdgeDrag(node.id);
              }}
              onClick={(event) => {
                event.stopPropagation();
                onSelect(node.id);
              }}
              role="button"
              tabIndex={0}
              aria-label={`Configure ${nodeDisplayName(node, catalog)}`}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              {!entry?.type.startsWith("trigger.") && (
                <button
                  type="button"
                  data-handle="in"
                  className="absolute -left-2 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border-2 border-white bg-indigo-500 shadow ring-1 ring-indigo-600/20"
                  onMouseUp={(event) => {
                    event.stopPropagation();
                    if (drag?.kind === "edge") endEdgeDrag(node.id);
                  }}
                  title="Drop a connection here"
                  aria-label={`Connect into ${nodeDisplayName(node, catalog)}`}
                />
              )}
              <div className="flex items-start gap-2.5 px-3.5 pt-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white/70 shadow-sm dark:bg-slate-950/40">
                  <Icon size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {nodeDisplayName(node, catalog)}
                  </div>
                  <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide opacity-60">
                    {PIPELINE_FAMILY_META[family].shortLabel}
                  </div>
                </div>
                {hasError ? (
                  <AlertCircle
                    size={15}
                    className="mt-1 shrink-0 text-amber-600 dark:text-amber-300"
                  />
                ) : (
                  <CheckCircle2
                    size={15}
                    className="mt-1 shrink-0 text-emerald-600 dark:text-emerald-300"
                  />
                )}
              </div>
              <NodeSummary node={node} entry={entry} hasError={hasError} />

              {handles.map((handle, index) => (
                <div
                  key={handle}
                  className="absolute -right-2 flex items-center gap-1"
                  style={{
                    top:
                      handles.length === 1
                        ? "50%"
                        : `${38 + index * (42 / Math.max(1, handles.length - 1))}%`,
                    transform: "translateY(-50%)",
                  }}
                >
                  {handles.length > 1 && (
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase shadow-sm " +
                        (handle === "true"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200"
                          : "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-200")
                      }
                    >
                      {handle}
                    </span>
                  )}
                  <button
                    type="button"
                    data-handle="out"
                    data-handle-name={handle}
                    className="h-4 w-4 rounded-full border-2 border-white bg-indigo-500 shadow ring-1 ring-indigo-600/20"
                    onMouseDown={(event) => startEdgeDrag(node, handle, event)}
                    title="Drag to the next step"
                    aria-label={`Connect ${nodeDisplayName(node, catalog)} ${handle} output`}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {graph.nodes.length > 0 && graph.edges.length === 0 && (
        <div className="pointer-events-none sticky bottom-3 left-0 flex justify-center px-4">
          <div className="rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-[11px] text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-950/95 dark:text-slate-400">
            Select a step and use “Next step”, or drag its right dot to connect it.
          </div>
        </div>
      )}
    </div>
  );
}

function NodeSummary({
  node,
  entry,
  hasError,
}: {
  node: PipelineNode;
  entry: PipelineNodeCatalogEntry | undefined;
  hasError: boolean;
}) {
  if (!entry) return null;
  let preview = "";
  for (const field of entry.fields) {
    if (field.key === "token") continue;
    const value = node.config[field.key];
    if (value === undefined || value === null || value === "" || value === "{}") {
      continue;
    }
    preview = `${field.label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
    break;
  }
  return (
    <div className="px-3.5 pb-3 pt-2 text-[11px] leading-4 opacity-75">
      {preview ? (
        <span className="line-clamp-2">{preview}</span>
      ) : hasError ? (
        <span className="font-medium">Setup needed — click to finish</span>
      ) : (
        <span>{entry.description}</span>
      )}
    </div>
  );
}

function handlePosition(
  node: PipelineNode,
  side: "left" | "right",
  handleIndex: number,
  handleCount: number,
): { x: number; y: number } {
  const x = side === "left" ? node.x : node.x + PIPELINE_NODE_WIDTH;
  let y = node.y + PIPELINE_NODE_HEIGHT / 2;
  if (handleCount > 1 && side === "right") {
    y =
      node.y + PIPELINE_NODE_HEIGHT * (0.38 + (handleIndex / Math.max(1, handleCount - 1)) * 0.42);
  }
  return { x, y };
}

function cubic(from: { x: number; y: number }, to: { x: number; y: number }): string {
  const distance = Math.abs(to.x - from.x);
  const first = from.x + Math.max(40, distance / 2);
  const second = to.x - Math.max(40, distance / 2);
  return `M ${from.x} ${from.y} C ${first} ${from.y}, ${second} ${to.y}, ${to.x} ${to.y}`;
}
