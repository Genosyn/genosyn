import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { Pipeline } from "../db/entities/Pipeline.js";
import { PipelineRun } from "../db/entities/PipelineRun.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import {
  parseGraph,
  serializeGraph,
  syncScheduleFields,
  fireManually,
  regenerateWebhookToken,
} from "../services/pipelines/index.js";
import { NODE_CATALOG } from "../services/pipelines/catalog.js";
import { PipelineGraph } from "../services/pipelines/types.js";
import { recordAudit } from "../services/audit.js";
import { PIPELINE_LOG_MAX_BYTES } from "../services/pipelines/log.js";

export const pipelinesRouter = Router({ mergeParams: true });
pipelinesRouter.use(requireAuth);
pipelinesRouter.use(requireCompanyMember);

async function uniqueSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Pipeline);
  let slug = base || "pipeline";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function findByName(
  companyId: string,
  name: string,
  excludeId?: string,
): Promise<Pipeline | null> {
  const qb = AppDataSource.getRepository(Pipeline)
    .createQueryBuilder("p")
    .where("p.companyId = :companyId", { companyId })
    .andWhere("LOWER(p.name) = LOWER(:name)", { name: name.trim() });
  if (excludeId) qb.andWhere("p.id != :excludeId", { excludeId });
  return qb.getOne();
}

function dto(p: Pipeline) {
  return {
    id: p.id,
    companyId: p.companyId,
    name: p.name,
    slug: p.slug,
    description: p.description,
    enabled: p.enabled,
    graph: parseGraph(p.graphJson),
    cronExpr: p.cronExpr,
    nextRunAt: p.nextRunAt?.toISOString() ?? null,
    lastRunAt: p.lastRunAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ─── Static catalog (drives the editor's node palette + per-node forms) ─────

pipelinesRouter.get("/pipelines/catalog", (_req, res) => {
  res.json({ catalog: NODE_CATALOG });
});

// ─── List + create ──────────────────────────────────────────────────────────

pipelinesRouter.get("/pipelines", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(Pipeline);
  const rows = await repo.find({ where: { companyId: cid }, order: { createdAt: "ASC" } });
  res.json(rows.map(dto));
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

pipelinesRouter.post(
  "/pipelines",
  validateBody(createSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof createSchema>;
    if (await findByName(cid, body.name)) {
      return res
        .status(409)
        .json({ error: "A pipeline with that name already exists" });
    }
    const repo = AppDataSource.getRepository(Pipeline);
    const slug = await uniqueSlug(cid, toSlug(body.name));
    const p = repo.create({
      companyId: cid,
      name: body.name,
      slug,
      description: body.description ?? "",
      enabled: true,
      graphJson: JSON.stringify({
        nodes: [
          {
            id: "trigger",
            type: "trigger.manual",
            x: 80,
            y: 80,
            config: {},
          },
        ],
        edges: [],
      }),
      cronExpr: null,
      nextRunAt: null,
      lastRunAt: null,
      createdById: req.userId ?? null,
    });
    await repo.save(p);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "pipeline.create",
      targetType: "pipeline",
      targetId: p.id,
      targetLabel: p.name,
    });
    res.json(dto(p));
  },
);

// ─── Detail / patch / delete ────────────────────────────────────────────────

async function loadPipeline(cid: string, idOrSlug: string): Promise<Pipeline | null> {
  const repo = AppDataSource.getRepository(Pipeline);
  return (
    (await repo.findOneBy({ id: idOrSlug, companyId: cid })) ||
    (await repo.findOneBy({ slug: idOrSlug, companyId: cid }))
  );
}

pipelinesRouter.get("/pipelines/:idOrSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadPipeline(cid, req.params.idOrSlug);
  if (!p) return res.status(404).json({ error: "Not found" });
  res.json(dto(p));
});

const graphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().optional(),
  x: z.number(),
  y: z.number(),
  config: z.record(z.any()).default({}),
});
const graphEdgeSchema = z.object({
  id: z.string().min(1),
  fromNodeId: z.string().min(1),
  toNodeId: z.string().min(1),
  fromHandle: z.string().optional(),
});
const graphSchema = z.object({
  nodes: z.array(graphNodeSchema),
  edges: z.array(graphEdgeSchema),
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  graph: graphSchema.optional(),
});

pipelinesRouter.patch(
  "/pipelines/:idOrSlug",
  validateBody(patchSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadPipeline(cid, req.params.idOrSlug);
    if (!p) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof patchSchema>;
    if (body.name !== undefined) {
      if (await findByName(cid, body.name, p.id)) {
        return res
          .status(409)
          .json({ error: "A pipeline with that name already exists" });
      }
      p.name = body.name;
    }
    if (body.description !== undefined) p.description = body.description;
    if (body.enabled !== undefined) p.enabled = body.enabled;
    if (body.graph !== undefined) {
      // Cast the validated graph back to the wider PipelineGraph type — zod's
      // string `type` is what the executor will interpret at run time.
      p.graphJson = serializeGraph(body.graph as unknown as PipelineGraph);
    }
    syncScheduleFields(p);
    await AppDataSource.getRepository(Pipeline).save(p);
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "pipeline.update",
      targetType: "pipeline",
      targetId: p.id,
      targetLabel: p.name,
      metadata: { fields: Object.keys(body) },
    });
    res.json(dto(p));
  },
);

pipelinesRouter.delete("/pipelines/:idOrSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadPipeline(cid, req.params.idOrSlug);
  if (!p) return res.status(404).json({ error: "Not found" });
  await AppDataSource.getRepository(PipelineRun).delete({ pipelineId: p.id });
  await AppDataSource.getRepository(Pipeline).delete({ id: p.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "pipeline.delete",
    targetType: "pipeline",
    targetId: p.id,
    targetLabel: p.name,
  });
  res.json({ ok: true });
});

// ─── Run now (manual trigger) ───────────────────────────────────────────────

const runSchema = z.object({
  payload: z.unknown().optional(),
});

pipelinesRouter.post(
  "/pipelines/:idOrSlug/run",
  validateBody(runSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadPipeline(cid, req.params.idOrSlug);
    if (!p) return res.status(404).json({ error: "Not found" });
    if (!p.enabled) {
      return res.status(409).json({ error: "Pipeline is disabled" });
    }
    const body = req.body as z.infer<typeof runSchema>;
    try {
      const run = await fireManually(p, body.payload ?? {});
      res.json({
        id: run.id,
        pipelineId: run.pipelineId,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString() ?? null,
        triggerKind: run.triggerKind,
        errorMessage: run.errorMessage,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

// ─── Run history ────────────────────────────────────────────────────────────

pipelinesRouter.get("/pipelines/:idOrSlug/runs", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const p = await loadPipeline(cid, req.params.idOrSlug);
  if (!p) return res.status(404).json({ error: "Not found" });
  const runs = await AppDataSource.getRepository(PipelineRun)
    .createQueryBuilder("r")
    .select([
      "r.id",
      "r.pipelineId",
      "r.startedAt",
      "r.finishedAt",
      "r.status",
      "r.triggerKind",
      "r.triggerNodeId",
      "r.errorMessage",
      "r.createdAt",
    ])
    .where("r.pipelineId = :pid", { pid: p.id })
    .orderBy("r.startedAt", "DESC")
    .take(50)
    .getMany();
  res.json(
    runs.map((r) => ({
      id: r.id,
      pipelineId: r.pipelineId,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      status: r.status,
      triggerKind: r.triggerKind,
      triggerNodeId: r.triggerNodeId,
      errorMessage: r.errorMessage,
    })),
  );
});

pipelinesRouter.get("/pipeline-runs/:runId", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const run = await AppDataSource.getRepository(PipelineRun).findOneBy({
    id: req.params.runId,
  });
  if (!run) return res.status(404).json({ error: "Not found" });
  const p = await AppDataSource.getRepository(Pipeline).findOneBy({
    id: run.pipelineId,
    companyId: cid,
  });
  if (!p) return res.status(404).json({ error: "Not found" });
  const size = Buffer.byteLength(run.logContent ?? "", "utf8");
  res.json({
    id: run.id,
    pipelineId: run.pipelineId,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    status: run.status,
    triggerKind: run.triggerKind,
    triggerNodeId: run.triggerNodeId,
    inputJson: run.inputJson,
    outputJson: run.outputJson,
    logContent: run.logContent ?? "",
    truncated: size >= PIPELINE_LOG_MAX_BYTES,
    errorMessage: run.errorMessage,
  });
});

// ─── Regenerate a Webhook node's token ──────────────────────────────────────

const regenSchema = z.object({ nodeId: z.string().min(1) });

pipelinesRouter.post(
  "/pipelines/:idOrSlug/webhook-token",
  validateBody(regenSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const p = await loadPipeline(cid, req.params.idOrSlug);
    if (!p) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof regenSchema>;
    const graph = parseGraph(p.graphJson);
    let token: string;
    try {
      token = regenerateWebhookToken(graph, body.nodeId);
    } catch (err) {
      return res
        .status(400)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
    p.graphJson = serializeGraph(graph);
    syncScheduleFields(p);
    await AppDataSource.getRepository(Pipeline).save(p);
    res.json({ token, graph });
  },
);
