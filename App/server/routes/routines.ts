import { Router } from "express";
import { z } from "zod";
import cron from "node-cron";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { routineDir, routineReadme } from "../services/paths.js";
import { readText, removeDir, routineTemplate, writeText } from "../services/files.js";
import { registerRoutine, unregisterRoutine } from "../services/cron.js";
import { runRoutine } from "../services/runner.js";

export const routinesRouter = Router({ mergeParams: true });
routinesRouter.use(requireAuth);
routinesRouter.use(requireCompanyMember);

async function loadEmp(cid: string, eid: string) {
  return AppDataSource.getRepository(AIEmployee).findOneBy({ id: eid, companyId: cid });
}
async function loadCo(cid: string) {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function uniqueSlug(employeeId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Routine);
  let slug = base || "routine";
  let n = 1;
  while (await repo.findOneBy({ employeeId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

routinesRouter.get("/employees/:eid/routines", async (req, res) => {
  const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: emp.id },
  });
  res.json(routines);
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  cronExpr: z.string().refine((v) => cron.validate(v), "Invalid cron expression"),
  modelId: z.string().uuid().optional(),
});

routinesRouter.post(
  "/employees/:eid/routines",
  validateBody(createSchema),
  async (req, res) => {
    const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const co = await loadCo((req.params as Record<string, string>).cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const body = req.body as z.infer<typeof createSchema>;
    const slug = await uniqueSlug(emp.id, toSlug(body.name));
    const repo = AppDataSource.getRepository(Routine);
    const r = repo.create({
      employeeId: emp.id,
      name: body.name,
      slug,
      cronExpr: body.cronExpr,
      enabled: true,
      lastRunAt: null,
      modelId: body.modelId ?? null,
    });
    await repo.save(r);
    writeText(routineReadme(co.slug, emp.slug, slug), routineTemplate(body.name, body.cronExpr));
    registerRoutine(r);
    res.json(r);
  },
);

async function loadRoutine(cid: string, rid: string) {
  const r = await AppDataSource.getRepository(Routine).findOneBy({ id: rid });
  if (!r) return null;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: r.employeeId,
    companyId: cid,
  });
  if (!emp) return null;
  const co = await loadCo(cid);
  if (!co) return null;
  return { routine: r, emp, co };
}

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  cronExpr: z
    .string()
    .refine((v) => cron.validate(v), "Invalid cron expression")
    .optional(),
  enabled: z.boolean().optional(),
  modelId: z.string().uuid().nullable().optional(),
});

routinesRouter.patch(
  "/routines/:rid",
  validateBody(patchSchema),
  async (req, res) => {
    const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
    if (!found) return res.status(404).json({ error: "Not found" });
    const body = req.body as z.infer<typeof patchSchema>;
    const r = found.routine;
    if (body.name !== undefined) r.name = body.name;
    if (body.cronExpr !== undefined) r.cronExpr = body.cronExpr;
    if (body.enabled !== undefined) r.enabled = body.enabled;
    if (body.modelId !== undefined) r.modelId = body.modelId;
    await AppDataSource.getRepository(Routine).save(r);
    registerRoutine(r);
    res.json(r);
  },
);

routinesRouter.delete("/routines/:rid", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  unregisterRoutine(found.routine.id);
  await AppDataSource.getRepository(Routine).delete({ id: found.routine.id });
  removeDir(routineDir(found.co.slug, found.emp.slug, found.routine.slug));
  res.json({ ok: true });
});

routinesRouter.get("/routines/:rid/readme", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  res.json({
    content: readText(routineReadme(found.co.slug, found.emp.slug, found.routine.slug)),
  });
});

const readmeSchema = z.object({ content: z.string() });

routinesRouter.put(
  "/routines/:rid/readme",
  validateBody(readmeSchema),
  async (req, res) => {
    const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
    if (!found) return res.status(404).json({ error: "Not found" });
    writeText(
      routineReadme(found.co.slug, found.emp.slug, found.routine.slug),
      (req.body as z.infer<typeof readmeSchema>).content,
    );
    res.json({ ok: true });
  },
);

routinesRouter.post("/routines/:rid/run", async (req, res) => {
  const found = await loadRoutine((req.params as Record<string, string>).cid, req.params.rid);
  if (!found) return res.status(404).json({ error: "Not found" });
  const run = await runRoutine(found.routine);
  res.json(run);
});
