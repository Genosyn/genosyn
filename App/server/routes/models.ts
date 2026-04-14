import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIModel } from "../db/entities/AIModel.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";

export const modelsRouter = Router({ mergeParams: true });
modelsRouter.use(requireAuth);
modelsRouter.use(requireCompanyMember);

const providerSchema = z.enum(["claude-code", "codex", "opencode"]);

modelsRouter.get("/", async (req, res) => {
  const models = await AppDataSource.getRepository(AIModel).find({
    where: { companyId: (req.params as Record<string, string>).cid },
  });
  res.json(models);
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  provider: providerSchema,
  model: z.string().min(1).max(120),
  configJson: z.record(z.unknown()).optional(),
});

modelsRouter.post("/", validateBody(createSchema), async (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  const repo = AppDataSource.getRepository(AIModel);
  const m = repo.create({
    companyId: (req.params as Record<string, string>).cid,
    name: body.name,
    provider: body.provider,
    model: body.model,
    configJson: JSON.stringify(body.configJson ?? {}),
  });
  await repo.save(m);
  res.json(m);
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  provider: providerSchema.optional(),
  model: z.string().min(1).max(120).optional(),
  configJson: z.record(z.unknown()).optional(),
});

modelsRouter.patch("/:mid", validateBody(patchSchema), async (req, res) => {
  const repo = AppDataSource.getRepository(AIModel);
  const m = await repo.findOneBy({ id: req.params.mid, companyId: (req.params as Record<string, string>).cid });
  if (!m) return res.status(404).json({ error: "Not found" });
  const body = req.body as z.infer<typeof patchSchema>;
  if (body.name !== undefined) m.name = body.name;
  if (body.provider !== undefined) m.provider = body.provider;
  if (body.model !== undefined) m.model = body.model;
  if (body.configJson !== undefined) m.configJson = JSON.stringify(body.configJson);
  await repo.save(m);
  res.json(m);
});

modelsRouter.delete("/:mid", async (req, res) => {
  const repo = AppDataSource.getRepository(AIModel);
  const m = await repo.findOneBy({ id: req.params.mid, companyId: (req.params as Record<string, string>).cid });
  if (!m) return res.status(404).json({ error: "Not found" });
  await repo.delete({ id: m.id });
  res.json({ ok: true });
});
