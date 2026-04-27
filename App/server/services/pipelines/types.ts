/**
 * Type contracts for the Pipelines executor.
 *
 * `PipelineGraph` is the JSON document persisted on `Pipeline.graphJson`. The
 * executor walks `nodes` in topological order from a firing trigger, passing
 * each node's `outputs` into a shared environment that downstream nodes can
 * reference via `{{<node-id>.<path>}}` template syntax.
 *
 * Adding a new node type:
 *   1. Add an entry to `NODE_CATALOG` in catalog.ts (icon, label, defaults).
 *   2. Implement the runtime in handlers.ts under the same `type` key.
 *   3. (Frontend) the editor reads NODE_CATALOG via `/api/.../pipelines/catalog`.
 */

export type PipelineNodeKind =
  // Triggers
  | "trigger.manual"
  | "trigger.webhook"
  | "trigger.schedule"
  // Genosyn actions (write into our own DB / surface)
  | "action.sendMessage"
  | "action.createTodo"
  | "action.createProject"
  | "action.createBaseRecord"
  | "action.askEmployee"
  | "action.journalNote"
  // Logic / IO
  | "logic.http"
  | "logic.set"
  | "logic.branch"
  | "logic.delay"
  // Integrations
  | "integration.invoke";

export type PipelineNode = {
  id: string;
  type: PipelineNodeKind;
  /** Display label override (otherwise uses catalog default). */
  label?: string;
  x: number;
  y: number;
  /** Per-type config blob. Validated at execute time, not at save time. */
  config: Record<string, unknown>;
};

export type PipelineEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  /** For branch nodes: 'true' | 'false'. Default 'out'. */
  fromHandle?: string;
};

export type PipelineGraph = {
  nodes: PipelineNode[];
  edges: PipelineEdge[];
};

export type NodeOutputs = Record<string, unknown>;

/**
 * Per-run environment. `nodeOutputs[nodeId]` is the outputs object the node
 * with that id produced. Templates resolve against this map.
 */
export type RunEnv = {
  trigger: { kind: "manual" | "schedule" | "webhook"; payload: unknown };
  nodeOutputs: Record<string, NodeOutputs>;
};

/** Context handed to every node handler. */
export type NodeContext = {
  companyId: string;
  /** The pipeline owning this node (for logging / lookups). */
  pipelineId: string;
  pipelineName: string;
  /** Current run id — useful for audit metadata. */
  runId: string;
  env: RunEnv;
  /** Append a line to the run log. Caller takes care of cap. */
  log: (line: string) => void;
  /** Resolved (post-template) config for the node. */
  config: Record<string, unknown>;
  /** The raw node entry from the graph (in case the handler needs `id`). */
  node: PipelineNode;
};

export type NodeResult = {
  outputs: NodeOutputs;
  /**
   * For branching nodes — selects which outgoing edge to follow. The default
   * 'out' is taken when the handler returns nothing or 'out'.
   */
  branch?: string;
};
