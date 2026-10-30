import { AppDataSource } from "../../db/datasource.js";
import type { AIModelWait } from "../../db/entities/AIModelWait.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { PipelineRun, PipelineTriggerKind } from "../../db/entities/PipelineRun.js";
import { recordAudit } from "../audit.js";
import {
  parseWaitPayload,
  waitForModel,
  type ModelWaitHandler,
  type ModelWaitResult,
} from "../modelWaits.js";
import { CATALOG_BY_TYPE } from "./catalog.js";
import { HANDLERS } from "./handlers.js";
import { PipelineLog } from "./log.js";
import { resolveConfig } from "./templates.js";
import {
  PipelineEventContext,
  PipelineGraph,
  PipelineNode,
  PipelineStepWaitsForModel,
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
 * looping forever. The executor commits final status synchronously; a row
 * left 'running' by a dead process is failed by the heartbeat's stale-run
 * sweep (see sweepStaleRuns in services/pipelines/index.ts).
 *
 * A step that needs an AI Employee whose AI Model is unavailable does not fail
 * the run, and never hands the next step the model's error as an answer: the
 * run **pauses** at that step (`status: "paused"`), keeping every output so
 * far, and carries on from the same step by itself when the model answers
 * again (`pipelineRunWait`, through `services/modelWaits.ts`) — on the graph
 * it started with, so an edit made meanwhile never splices two versions of a
 * Pipeline into one run.
 */

const MAX_NODES_PER_RUN = 200;

export type RunPipelineArgs = {
  pipeline: Pipeline;
  triggerKind: PipelineTriggerKind;
  triggerNodeId: string;
  payload: unknown;
  eventContext?: PipelineEventContext;
  /** A parent worker's cancellation boundary, checked before each new node. */
  beforeEffect?: () => void | Promise<void>;
};

/** Where a walk through the graph stands: what is next, what already ran. */
type WalkState = {
  queue: { nodeId: string; arrivedFrom?: string }[];
  visited: Set<string>;
  count: number;
};

type WalkContext = {
  run: PipelineRun;
  pipeline: Pipeline;
  graph: PipelineGraph;
  env: RunEnv;
  log: PipelineLog;
  triggerKind: PipelineTriggerKind;
  triggerNodeId: string;
  eventContext?: PipelineEventContext;
  beforeEffect?: () => void | Promise<void>;
};

/** What a paused run keeps to carry on from where it stopped. */
export type PipelineResumeSnapshot = {
  version: 1;
  /** The graph the run started on. */
  graph: PipelineGraph;
  queue: { nodeId: string; arrivedFrom?: string }[];
  visited: string[];
  count: number;
  eventContext?: PipelineEventContext;
};

export async function runPipeline(args: RunPipelineArgs): Promise<PipelineRun> {
  const runRepo = AppDataSource.getRepository(PipelineRun);

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
  const state: WalkState = { queue: [], visited: new Set(), count: 0 };
  // Mark the trigger as already executed (it produced no outputs of its own
  // beyond `env.trigger`, but downstream nodes may template against
  // `{{<trigger-id>.payload}}` for ergonomics).
  env.nodeOutputs[triggerNode.id] = {
    payload: args.payload ?? {},
    kind: args.triggerKind,
  };
  state.visited.add(triggerNode.id);
  for (const next of childrenOf(graph, triggerNode.id, "out")) {
    state.queue.push({ nodeId: next, arrivedFrom: triggerNode.id });
  }

  return walk(
    {
      run,
      pipeline: args.pipeline,
      graph,
      env,
      log,
      triggerKind: args.triggerKind,
      triggerNodeId: args.triggerNodeId,
      eventContext: args.eventContext,
      beforeEffect: args.beforeEffect,
    },
    state,
  );
}

async function walk(ctx: WalkContext, state: WalkState): Promise<PipelineRun> {
  const { run, graph, env, log } = ctx;
  while (state.queue.length > 0) {
    if (state.count >= MAX_NODES_PER_RUN) {
      log.line(`[ABORT] exceeded ${MAX_NODES_PER_RUN} steps; possible cycle`);
      return finish(
        run,
        "failed",
        `exceeded max steps (${MAX_NODES_PER_RUN})`,
        log,
        env.nodeOutputs,
      );
    }
    const step = state.queue.shift()!;
    const { nodeId } = step;
    if (state.visited.has(nodeId)) continue;
    state.visited.add(nodeId);
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) {
      log.line(`[skip] node ${nodeId} missing from graph`);
      continue;
    }
    state.count += 1;
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
      await ctx.beforeEffect?.();
      const resolved = resolveConfig(node.config ?? {}, env);
      const result = await handler({
        companyId: ctx.pipeline.companyId,
        pipelineId: ctx.pipeline.id,
        pipelineName: ctx.pipeline.name,
        runId: run.id,
        env,
        config: resolved,
        node,
        eventContext: ctx.eventContext,
        log: (line) => log.line(`  ${line}`),
      });
      outputs = result.outputs ?? {};
      if (result.branch) branch = result.branch;
    } catch (err) {
      if (err instanceof PipelineStepWaitsForModel) {
        // Not this step's failure: it runs again, from the start, once the
        // model is back. Everything before it stays done.
        state.visited.delete(nodeId);
        state.count -= 1;
        state.queue.unshift(step);
        return pause(ctx, state, err);
      }
      const msg = err instanceof Error ? err.message : String(err);
      log.line(`  [error] ${msg}`);
      return finish(run, "failed", msg, log, env.nodeOutputs);
    }
    env.nodeOutputs[node.id] = outputs;
    for (const next of childrenOf(graph, node.id, branch)) {
      state.queue.push({ nodeId: next, arrivedFrom: node.id });
    }
  }

  log.line(`\n[${new Date().toISOString()}] pipeline finished — ${state.count} step(s)`);
  try {
    // Stamp lastRunAt on the pipeline row. Bookkeeping must never leave the
    // run row stuck in 'running' — a failed save here (or a pipeline deleted
    // mid-run) still falls through to the terminal write below.
    ctx.pipeline.lastRunAt = new Date();
    await AppDataSource.getRepository(Pipeline).save(ctx.pipeline);
    await recordAudit({
      companyId: ctx.pipeline.companyId,
      actorKind: triggerKindToActor(ctx.triggerKind),
      action: `pipeline.run.${ctx.triggerKind}`,
      targetType: "pipeline",
      targetId: ctx.pipeline.id,
      targetLabel: ctx.pipeline.name,
      metadata: { triggerNodeId: ctx.triggerNodeId, steps: state.count },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[pipelines] post-run bookkeeping failed for ${ctx.pipeline.id}:`, err);
  }
  return finish(run, "completed", null, log, env.nodeOutputs);
}

/**
 * Stop the run at a step whose AI Model is unavailable, as itself: what ran
 * keeps its outputs, nothing is marked failed, and it waits to carry on.
 */
async function pause(
  ctx: WalkContext,
  state: WalkState,
  waiting: PipelineStepWaitsForModel,
): Promise<PipelineRun> {
  const { run, log, env } = ctx;
  log.line(
    `  [paused] ${waiting.employee.name}'s AI Model is unavailable. ` +
      "The run waits here and carries on from this step when it is back.",
  );
  run.status = "paused";
  run.finishedAt = null;
  run.errorMessage = null;
  run.logContent = log.value();
  run.outputJson = safeJson(env.nodeOutputs);
  const saved = await AppDataSource.getRepository(PipelineRun).save(run);
  const snapshot: PipelineResumeSnapshot = {
    version: 1,
    graph: ctx.graph,
    queue: state.queue,
    visited: [...state.visited],
    count: state.count,
    ...(ctx.eventContext ? { eventContext: ctx.eventContext } : {}),
  };
  await waitForModel({
    kind: "pipeline_run",
    targetId: run.id,
    companyId: ctx.pipeline.companyId,
    employeeId: waiting.employee.id,
    model: waiting.model,
    groupKey: ctx.pipeline.id,
    payload: snapshot,
  });
  return saved;
}

function isSnapshot(value: Partial<PipelineResumeSnapshot>): value is PipelineResumeSnapshot {
  return (
    value.version === 1 &&
    Boolean(value.graph) &&
    Array.isArray(value.graph?.nodes) &&
    Array.isArray(value.graph?.edges) &&
    Array.isArray(value.queue) &&
    Array.isArray(value.visited) &&
    typeof value.count === "number"
  );
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(json || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The fence a paused run carries on behind. A run an arriving email started
 * stops, failed, if its mailbox was paused or disconnected while it waited —
 * as the inbound queue stops one whose mailbox is paused mid-run.
 */
function resumedFence(run: PipelineRun): (() => Promise<void>) | undefined {
  const payload = parseObject(run.inputJson) as { event?: unknown; message?: { accountId?: unknown } };
  const accountId = payload.event === "email.received" ? payload.message?.accountId : undefined;
  if (typeof accountId !== "string" || !accountId) return undefined;
  return async () => {
    const account = await AppDataSource.getRepository(MailAccount).findOneBy({ id: accountId });
    if (!account || account.status === "paused") {
      throw new Error("The mailbox was paused or disconnected before this run could finish.");
    }
  };
}

/**
 * Carry on a run that paused for its AI Model: claim it, and walk on from the
 * step it stopped at with the outputs it had. A Pipeline deleted or turned off
 * meanwhile ends the run failed, saying so. Null when another process took it.
 */
export async function resumePipelineRun(
  runId: string,
  snapshot: PipelineResumeSnapshot,
): Promise<PipelineRun | null> {
  const runs = AppDataSource.getRepository(PipelineRun);
  const claimed = await runs.update({ id: runId, status: "paused" }, { status: "running" });
  if (claimed.affected !== 1) return null;
  const run = await runs.findOneBy({ id: runId });
  if (!run) return null;
  const log = new PipelineLog();
  log.write(run.logContent);
  const nodeOutputs = parseObject(run.outputJson) as RunEnv["nodeOutputs"];
  const pipeline = await AppDataSource.getRepository(Pipeline).findOneBy({ id: run.pipelineId });
  if (!pipeline) {
    log.line(`\n[${new Date().toISOString()}] the Pipeline was deleted while this run waited`);
    return finish(run, "failed", "The Pipeline was deleted while this run waited for its AI Model.", log, nodeOutputs);
  }
  if (!pipeline.enabled) {
    log.line(`\n[${new Date().toISOString()}] the Pipeline was turned off while this run waited`);
    return finish(
      run,
      "failed",
      "The Pipeline was turned off while this run waited for its AI Model.",
      log,
      nodeOutputs,
    );
  }
  log.line(`\n[${new Date().toISOString()}] [resumed] The AI Model is answering again.`);
  const triggerKind = run.triggerKind;
  return walk(
    {
      run,
      pipeline,
      graph: snapshot.graph,
      env: {
        trigger: { kind: triggerKind, payload: parseObject(run.inputJson) },
        nodeOutputs,
      },
      log,
      triggerKind,
      triggerNodeId: run.triggerNodeId ?? "",
      eventContext: snapshot.eventContext,
      beforeEffect: resumedFence(run),
    },
    {
      queue: snapshot.queue,
      visited: new Set(snapshot.visited),
      count: snapshot.count,
    },
  );
}

/**
 * A run paused at an AI step, carried on once that step's AI Employee's model
 * is back. A run that meets the model unavailable again pauses again at the
 * same step; after ten such pauses it ends failed, saying why.
 */
export const pipelineRunWait: ModelWaitHandler = {
  concurrency: 2,
  resume: async (wait: AIModelWait): Promise<ModelWaitResult> => {
    const snapshot = parseWaitPayload<PipelineResumeSnapshot>(wait);
    if (!isSnapshot(snapshot)) {
      await failPaused(wait.targetId, "This run could not carry on from where it paused.");
      return { status: "done" };
    }
    const run = await resumePipelineRun(wait.targetId, snapshot);
    return run?.status === "paused" ? { status: "waiting" } : { status: "done" };
  },
  abandon: async (wait) => {
    await failPaused(
      wait.targetId,
      "The AI Model kept becoming unavailable each time this run carried on, so it stopped.",
    );
  },
};

async function failPaused(runId: string, message: string): Promise<void> {
  const runs = AppDataSource.getRepository(PipelineRun);
  const run = await runs.findOneBy({ id: runId, status: "paused" });
  if (!run) return;
  const log = new PipelineLog();
  log.write(run.logContent);
  log.line(`\n[${new Date().toISOString()}] [error] ${message}`);
  await runs.update(
    { id: runId, status: "paused" },
    {
      status: "failed",
      finishedAt: new Date(),
      errorMessage: message,
      logContent: log.value(),
    },
  );
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

function safeJson(outputs: Record<string, unknown>): string {
  try {
    return JSON.stringify(outputs);
  } catch {
    // A handler smuggled something non-JSON-safe (cycle, BigInt) into its
    // outputs — the terminal status write still matters more than the data.
    return '{"error":"outputs were not JSON-serializable"}';
  }
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
  // Clamp so a handler cannot bloat the row with a runaway error string.
  run.errorMessage = errorMessage === null ? null : errorMessage.slice(0, 16_384);
  run.logContent = log.value();
  run.outputJson = safeJson(outputs);
  return AppDataSource.getRepository(PipelineRun).save(run);
}

function triggerKindToActor(kind: PipelineTriggerKind): "system" | "webhook" | "cron" {
  if (kind === "webhook") return "webhook";
  if (kind === "schedule") return "cron";
  return "system";
}
