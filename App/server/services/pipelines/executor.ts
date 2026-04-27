import { AppDataSource } from "../../db/datasource.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { PipelineRun, PipelineTriggerKind } from "../../db/entities/PipelineRun.js";
import { recordAudit } from "../audit.js";
import { CATALOG_BY_TYPE } from "./catalog.js";
import { HANDLERS } from "./handlers.js";
import { PipelineLog } from "./log.js";
import { resolveConfig } from "./templates.js";
import {
  PipelineGraph,
  PipelineNode,
  RunEnv,
} from "./types.js";

/**
 * Pipeline executor.
 *
 * Walks the graph from a firing trigger node in topological order. Each node
 * receives a per-run env (`trigger` payload + every upstream node's outputs)
 * which its config templates resolve against. Branch nodes select which
 * outgoing edge to follow via the returned `branch` handle; nodes whose
 * inputs were never reached are skipped.
 *
 * Execution is bounded by a depth limit to prevent accidental cycles from
 * looping forever; the heartbeat can recover if the run row is stuck in
 * 'running' beyond a timeout, but in practice the executor commits final
 * status synchronously.
 */

const MAX_NODES_PER_RUN = 200;

export type RunPipelineArgs = {
  pipeline: Pipeline;
  triggerKind: PipelineTriggerKind;
  triggerNodeId: string;
  payload: unknown;
};

export async function runPipeline(args: RunPipelineArgs): Promise<PipelineRun> {
  const runRepo = AppDataSource.getRepository(PipelineRun);
  const pipelineRepo = AppDataSource.getRepository(Pipeline);

  const startedAt = new Date();
  const run = runRepo.create({
    pipelineId: args.pipeline.id,
    startedAt,
    status: "running",
    triggerKind: args.triggerKind,
    triggerNodeId: args.triggerNodeId,
    inputJson: JSON.stringify(args.payload ?? {}),
    outputJson: "{}",
    logContent: "",
    errorMessage: null,
  });
  await runRepo.save(run);

  const log = new PipelineLog();
  log.line(
    `[${startedAt.toISOString()}] pipeline "${args.pipeline.name}" started ` +
      `(trigger: ${args.triggerKind} node ${args.triggerNodeId})`,
  );

  let graph: PipelineGraph;
  try {
    graph = parseGraph(args.pipeline.graphJson);
  } catch (err) {
    return finish(run, "failed", err instanceof Error ? err.message : String(err), log, {});
  }

  const env: RunEnv = {
    trigger: { kind: args.triggerKind, payload: args.payload ?? {} },
    nodeOutputs: {},
  };

  const triggerNode = graph.nodes.find((n) => n.id === args.triggerNodeId);
  if (!triggerNode) {
    return finish(
      run,
      "failed",
      `Trigger node ${args.triggerNodeId} not in graph`,
      log,
      env.nodeOutputs,
    );
  }

  // BFS-ish walk from the trigger node, respecting the chosen branch handle
  // at each branch step. We don't pre-compute a topological order because
  // branches can prune entire subgraphs; instead we visit children lazily
  // and dedupe via `visited`.
  const queue: { nodeId: string; arrivedFrom?: string }[] = [];
  const visited = new Set<string>();
  // Mark the trigger as already executed (it produced no outputs of its own
  // beyond `env.trigger`, but downstream nodes may template against
  // `{{<trigger-id>.payload}}` for ergonomics).
  env.nodeOutputs[triggerNode.id] = {
    payload: args.payload ?? {},
    kind: args.triggerKind,
  };
  visited.add(triggerNode.id);
  for (const next of childrenOf(graph, triggerNode.id, "out")) {
    queue.push({ nodeId: next, arrivedFrom: triggerNode.id });
  }

  let count = 0;
  while (queue.length > 0) {
    if (count >= MAX_NODES_PER_RUN) {
      log.line(`[ABORT] exceeded ${MAX_NODES_PER_RUN} steps; possible cycle`);
      return finish(
        run,
        "failed",
        `exceeded max steps (${MAX_NODES_PER_RUN})`,
        log,
        env.nodeOutputs,
      );
    }
    const { nodeId } = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      log.line(`[skip] node ${nodeId} missing from graph`);
      continue;
    }
    count += 1;
    const handler = HANDLERS[node.type];
    const label = node.label ?? CATALOG_BY_TYPE.get(node.type)?.label ?? node.type;
    log.line(`\n→ [${node.id}] ${label} (${node.type})`);
    if (!handler) {
      log.line(`  [error] no handler registered for ${node.type}`);
      return finish(
        run,
        "failed",
        `No handler for node type ${node.type}`,
        log,
        env.nodeOutputs,
      );
    }
    let outputs;
    let branch = "out";
    try {
      const resolved = resolveConfig(node.config ?? {}, env);
      const result = await handler({
        companyId: args.pipeline.companyId,
        pipelineId: args.pipeline.id,
        pipelineName: args.pipeline.name,
        runId: run.id,
        env,
        config: resolved,
        node,
        log: (line) => log.line(`  ${line}`),
      });
      outputs = result.outputs ?? {};
      if (result.branch) branch = result.branch;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.line(`  [error] ${msg}`);
      return finish(run, "failed", msg, log, env.nodeOutputs);
    }
    env.nodeOutputs[node.id] = outputs;
    for (const next of childrenOf(graph, node.id, branch)) {
      queue.push({ nodeId: next, arrivedFrom: node.id });
    }
  }

  log.line(`\n[${new Date().toISOString()}] pipeline finished — ${count} step(s)`);
  // Stamp lastRunAt on the pipeline row.
  args.pipeline.lastRunAt = new Date();
  await pipelineRepo.save(args.pipeline);
  await recordAudit({
    companyId: args.pipeline.companyId,
    actorKind: triggerKindToActor(args.triggerKind),
    action: `pipeline.run.${args.triggerKind}`,
    targetType: "pipeline",
    targetId: args.pipeline.id,
    targetLabel: args.pipeline.name,
    metadata: { triggerNodeId: args.triggerNodeId, steps: count },
  });
  return finish(run, "completed", null, log, env.nodeOutputs);
}

function childrenOf(graph: PipelineGraph, nodeId: string, handle: string): string[] {
  return graph.edges
    .filter((e) => e.fromNodeId === nodeId && (e.fromHandle ?? "out") === handle)
    .map((e) => e.toNodeId);
}

function parseGraph(json: string): PipelineGraph {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("graphJson is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("graphJson is empty");
  const nodes = (parsed as { nodes?: PipelineNode[] }).nodes;
  const edges = (parsed as { edges?: PipelineGraph["edges"] }).edges;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new Error("graphJson must have nodes[] and edges[]");
  }
  return { nodes, edges };
}

async function finish(
  run: PipelineRun,
  status: PipelineRun["status"],
  errorMessage: string | null,
  log: PipelineLog,
  outputs: Record<string, unknown>,
): Promise<PipelineRun> {
  run.finishedAt = new Date();
  run.status = status;
  run.errorMessage = errorMessage;
  run.logContent = log.value();
  run.outputJson = JSON.stringify(outputs);
  return AppDataSource.getRepository(PipelineRun).save(run);
}

function triggerKindToActor(kind: PipelineTriggerKind): "system" | "webhook" | "cron" {
  if (kind === "webhook") return "webhook";
  if (kind === "schedule") return "cron";
  return "system";
}
