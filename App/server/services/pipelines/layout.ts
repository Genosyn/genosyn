import type { PipelineEdge, PipelineGraph, PipelineNode } from "./types.js";

/**
 * A graph as an author hands it over: positions optional, and `type` still a
 * plain string because it came off the wire. `validateGraph` is what turns it
 * back into a known {@link PipelineNode["type"]}, the same division
 * `routes/pipelines.ts` already makes between its zod shape and the executor's.
 */
export type DraftPipelineNode = {
  id: string;
  type: string;
  label?: string;
  x?: number;
  y?: number;
  config?: Record<string, unknown>;
};

export type DraftPipelineGraph = {
  nodes: DraftPipelineNode[];
  edges: PipelineEdge[];
};

/**
 * Fill in canvas coordinates for steps that arrived without them.
 *
 * `x`/`y` exist for the builder, not for the pipeline: nothing in the executor
 * reads them. But they are required columns on every step, so an author
 * composing a graph as JSON would otherwise have to invent a layout for a
 * canvas it cannot see — and whatever it invented would be what a human opens
 * the pipeline to. Laying the graph out here means the MCP tools can leave the
 * coordinates optional and still hand the builder something readable: one
 * column per hop from the trigger, steps stacked down the column in the order
 * they were written.
 *
 * Positions that were supplied are left exactly as they are, so a human who
 * arranged a pipeline by hand does not get it rearranged by an employee's next
 * edit.
 */

/** Matches the builder's own starter placement (`starters.ts`). */
const ORIGIN_X = 72;
const ORIGIN_Y = 88;
const COLUMN_WIDTH = 280;
const ROW_HEIGHT = 160;

/** Whether a step arrived with a position of its own on this axis. */
function isPlaced(node: DraftPipelineNode | PipelineNode, axis?: "x" | "y"): boolean {
  if (axis) return typeof node[axis] === "number";
  return typeof node.x === "number" && typeof node.y === "number";
}

/**
 * Depth of each step measured in hops from the nearest trigger. Steps no
 * trigger reaches (which `validateGraph` reports as a warning) fall back to
 * the column after the deepest reachable one, so they are visible rather than
 * stacked on top of the entry point.
 */
function depthByNode(graph: PipelineGraph): Map<string, number> {
  const depth = new Map<string, number>();
  const queue: Array<{ id: string; at: number }> = graph.nodes
    .filter((node) => node.type.startsWith("trigger."))
    .map((node) => ({ id: node.id, at: 0 }));

  while (queue.length > 0) {
    const { id, at } = queue.shift()!;
    const known = depth.get(id);
    if (known !== undefined && known <= at) continue;
    depth.set(id, at);
    for (const edge of graph.edges) {
      if (edge.fromNodeId === id) queue.push({ id: edge.toNodeId, at: at + 1 });
    }
  }

  const orphanColumn = Math.max(0, ...depth.values()) + 1;
  for (const node of graph.nodes) {
    if (!depth.has(node.id)) depth.set(node.id, orphanColumn);
  }
  return depth;
}

/**
 * Return a graph in which every step has coordinates. Steps that arrived with
 * both `x` and `y` keep them; the rest are placed around whatever is already
 * on the canvas.
 */
export function withLaidOutNodes(graph: DraftPipelineGraph): PipelineGraph {
  const placed = graph.nodes.map((node) => ({
    ...node,
    config: node.config ?? {},
  })) as PipelineNode[];
  const complete: PipelineGraph = { nodes: placed, edges: graph.edges };
  if (placed.every((node) => isPlaced(node))) return complete;

  const depth = depthByNode(complete);
  const usedRows = new Map<number, number>();
  for (const node of placed) {
    // Count rows a human already occupies in each column so auto-placed steps
    // land below them instead of on top.
    if (isPlaced(node, "y")) {
      const column = depth.get(node.id) ?? 0;
      usedRows.set(column, (usedRows.get(column) ?? 0) + 1);
    }
  }

  for (const node of placed) {
    if (isPlaced(node)) continue;
    const column = depth.get(node.id) ?? 0;
    const row = usedRows.get(column) ?? 0;
    usedRows.set(column, row + 1);
    // Per axis: the schema lets a step supply one and not the other, and
    // overwriting the one it gave us would contradict the promise above.
    if (!isPlaced(node, "x")) node.x = ORIGIN_X + column * COLUMN_WIDTH;
    if (!isPlaced(node, "y")) node.y = ORIGIN_Y + row * ROW_HEIGHT;
  }

  return complete;
}
