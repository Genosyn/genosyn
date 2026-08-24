import crypto from "node:crypto";
import { IsNull, LessThan, LessThanOrEqual, Not } from "typeorm";
import { AppDataSource } from "../../db/datasource.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { PipelineRun } from "../../db/entities/PipelineRun.js";
import { runPipeline } from "./executor.js";
import { PipelineGraph, PipelineNode, PipelineNodeKind } from "./types.js";
import { withSchedulerLease } from "../schedulerLeases.js";
import { constantTimeEqual } from "../../lib/constantTime.js";
import { isSchedulableCron, nextRunFor } from "./cron.js";

/**
 * Public pipeline service surface. Glues the executor to the rest of the app:
 *
 *   - `parseGraph` / `serializeGraph` — JSON ↔ object, with shape validation.
 *   - `syncScheduleFields` — recomputes `cronExpr` + `nextRunAt` from any
 *     Schedule trigger nodes, so the cron heartbeat can find due rows
 *     without parsing the graph each tick.
 *   - `ensureWebhookTokens` — assigns a fresh hex token to any Webhook
 *     trigger node missing one.
 *   - `findPipelineByWebhook` — webhook router uses this to resolve a hit.
 *   - `bootPipelineCron` — starts the heartbeat that fires due Schedule
 *     triggers.
 */

export const PIPELINE_HEARTBEAT_INTERVAL_MS = 30 * 1000;

let heartbeat: NodeJS.Timeout | null = null;
let ticking = false;

export function parseGraph(json: string): PipelineGraph {
  if (!json) return { nodes: [], edges: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Invalid graph JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    return { nodes: [], edges: [] };
  }
  const nodes = (parsed as { nodes?: PipelineNode[] }).nodes ?? [];
  const edges = (parsed as { edges?: PipelineGraph["edges"] }).edges ?? [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    throw new Error("Graph must have nodes[] and edges[]");
  }
  return { nodes, edges };
}

export function serializeGraph(graph: PipelineGraph): string {
  return JSON.stringify({
    nodes: graph.nodes ?? [],
    edges: graph.edges ?? [],
  });
}

export function isTriggerKind(kind: PipelineNodeKind): boolean {
  return kind.startsWith("trigger.");
}

/**
 * Walk the graph and:
 *   - pick the earliest cron expression among Schedule trigger nodes
 *   - assign a fresh token to any Webhook trigger missing one
 * Mutates `pipeline` in-place; caller saves.
 */
export function syncScheduleFields(pipeline: Pipeline): void {
  const graph = parseGraph(pipeline.graphJson);
  ensureWebhookTokens(graph);
  const cronExprs: string[] = [];
  for (const node of graph.nodes) {
    if (node.type !== "trigger.schedule") continue;
    const expr = String((node.config?.cronExpr as string) ?? "").trim();
    if (!expr) continue;
    if (!isSchedulableCron(expr)) continue;
    cronExprs.push(expr);
  }
  pipeline.graphJson = serializeGraph(graph);
  if (!pipeline.enabled || cronExprs.length === 0) {
    pipeline.cronExpr = null;
    pipeline.nextRunAt = null;
    return;
  }
  // Pick the earliest of the candidates from now.
  const now = new Date();
  let bestExpr: string | null = null;
  let bestNext: Date | null = null;
  for (const expr of cronExprs) {
    const next = nextRunFor(expr, now);
    if (!next) continue;
    if (!bestNext || next < bestNext) {
      bestNext = next;
      bestExpr = expr;
    }
  }
  pipeline.cronExpr = bestExpr;
  pipeline.nextRunAt = bestNext;
}

/**
 * Carry each Webhook trigger's existing secret across a whole-graph replace.
 *
 * The graph is replaced entire on every save, and `ensureWebhookTokens` mints
 * a fresh secret for any Webhook step that arrives without one. For the
 * builder that is invisible — it round-trips the token it was given. For an
 * author composing JSON it is a trap with no warning attached: rebuild the
 * step without echoing 48 hex characters back and the URL a third party is
 * already posting to dies, silently, on an edit about something else.
 *
 * So a step that keeps its id keeps its secret unless the caller sent a
 * different one. Rotation stays an explicit act — `regenerateWebhookToken` —
 * which says out loud that the old URL just stopped working.
 */
export function preserveWebhookTokens(next: PipelineGraph, previous: PipelineGraph): void {
  const before = new Map(
    previous.nodes
      .filter((node) => node.type === "trigger.webhook")
      .map((node) => [node.id, String(node.config?.token ?? "")]),
  );
  for (const node of next.nodes) {
    if (node.type !== "trigger.webhook") continue;
    const config = (node.config = (node.config ?? {}) as Record<string, unknown>);
    if (typeof config.token === "string" && config.token.trim()) continue;
    const kept = before.get(node.id);
    if (kept) config.token = kept;
  }
}

export function ensureWebhookTokens(graph: PipelineGraph): void {
  for (const node of graph.nodes) {
    if (node.type !== "trigger.webhook") continue;
    const config = (node.config = (node.config ?? {}) as Record<string, unknown>);
    if (!config.token || typeof config.token !== "string" || !config.token) {
      config.token = crypto.randomBytes(24).toString("hex");
    }
  }
}

export function regenerateWebhookToken(graph: PipelineGraph, nodeId: string): string {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw new Error("Node not found");
  if (node.type !== "trigger.webhook") {
    throw new Error("Node is not a Webhook trigger");
  }
  const token = crypto.randomBytes(24).toString("hex");
  (node.config ??= {})["token"] = token;
  return token;
}

/**
 * Look up `(pipeline, webhookNodeId)` for a given webhook URL hit. Returns
 * null when the pipeline doesn't exist, is disabled, or the token doesn't
 * match any Webhook trigger node in the graph.
 */
export async function findPipelineByWebhook(
  pipelineId: string,
  token: string,
): Promise<{ pipeline: Pipeline; nodeId: string } | null> {
  const pipeline = await AppDataSource.getRepository(Pipeline).findOneBy({
    id: pipelineId,
  });
  if (!pipeline || !pipeline.enabled) return null;
  let graph: PipelineGraph;
  try {
    graph = parseGraph(pipeline.graphJson);
  } catch {
    return null;
  }
  for (const node of graph.nodes) {
    if (node.type !== "trigger.webhook") continue;
    const t = (node.config?.token as string) ?? "";
    if (t && constantTimeEqual(token, t)) {
      return { pipeline, nodeId: node.id };
    }
  }
  return null;
}

/**
 * Manual fire — runs the first `trigger.manual` node, or the first trigger
 * of any kind if no manual exists. Useful for "Run now" from the UI.
 */
export async function fireManually(
  pipeline: Pipeline,
  payload: unknown = {},
): Promise<ReturnType<typeof runPipeline>> {
  const graph = parseGraph(pipeline.graphJson);
  const manual = graph.nodes.find((n) => n.type === "trigger.manual");
  const trigger = manual ?? graph.nodes.find((n) => isTriggerKind(n.type));
  if (!trigger) {
    throw new Error("Pipeline has no trigger node");
  }
  return runPipeline({
    pipeline,
    // The Member clicked Run now, even when the graph only has a schedule or
    // webhook trigger. Keep the Run history honest about what started it.
    triggerKind: "manual",
    triggerNodeId: trigger.id,
    payload,
  });
}

/**
 * A run executes in memory, so a row still 'running' hours later means its
 * process died (deploy, crash) without reaching the terminal write. The
 * cutoff is generous because in a horizontally scaled install another
 * process may legitimately hold a slow run — six hours is far beyond any
 * real run, and the sweep runs under the scheduler lease.
 */
const STALE_RUN_CUTOFF_MS = 6 * 60 * 60 * 1000;

async function sweepStaleRuns(now: Date): Promise<void> {
  const repo = AppDataSource.getRepository(PipelineRun);
  const cutoff = new Date(now.getTime() - STALE_RUN_CUTOFF_MS);
  const stale = await repo.find({
    where: { status: "running", startedAt: LessThan(cutoff) },
    take: 100,
  });
  for (const run of stale) {
    run.status = "failed";
    run.finishedAt = now;
    run.errorMessage = "Run was interrupted (the server stopped before it finished)";
    await repo.save(run);
  }
}

async function tickPipelines(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await withSchedulerLease("pipelines", PIPELINE_HEARTBEAT_INTERVAL_MS * 3, async () => {
      const repo = AppDataSource.getRepository(Pipeline);
      const now = new Date();
      await sweepStaleRuns(now);
      const due = await repo.find({
        where: {
          enabled: true,
          nextRunAt: LessThanOrEqual(now),
          cronExpr: Not(IsNull()),
        },
      });
      for (const p of due) {
        const next = p.cronExpr ? nextRunFor(p.cronExpr, now) : null;
        p.nextRunAt = next;
        await repo.save(p);
        const graph = parseGraph(p.graphJson);
        const scheduleNode = graph.nodes.find(
          (n) => n.type === "trigger.schedule" && n.config?.cronExpr === p.cronExpr,
        );
        if (!scheduleNode) continue;
        runPipeline({
          pipeline: p,
          triggerKind: "schedule",
          triggerNodeId: scheduleNode.id,
          payload: { firedAt: now.toISOString() },
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[pipelines] ${p.id} failed:`, err);
        });
      }
    });
  } finally {
    ticking = false;
  }
}

export async function bootPipelineCron(): Promise<void> {
  // Boot sweep: fill in nextRunAt for any enabled+scheduled row missing one.
  const repo = AppDataSource.getRepository(Pipeline);
  const orphans = await repo.find({
    where: { enabled: true, nextRunAt: IsNull(), cronExpr: Not(IsNull()) },
  });
  for (const p of orphans) {
    if (!p.cronExpr) continue;
    p.nextRunAt = nextRunFor(p.cronExpr);
    await repo.save(p);
  }
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = setInterval(() => {
    tickPipelines().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[pipelines] heartbeat failed:", err);
    });
  }, PIPELINE_HEARTBEAT_INTERVAL_MS);
  tickPipelines().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[pipelines] initial tick failed:", err);
  });
}
