import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { Routine } from "../db/entities/Routine.js";
import { AIModel } from "../db/entities/AIModel.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import path from "node:path";
import {
  employeeDir,
  ensureDir,
  soulPath,
} from "../services/paths.js";
import { isModelConnected } from "../services/providers.js";
import { readText, removeDir, soulTemplate, writeText } from "../services/files.js";
import { unregisterRoutine } from "../services/cron.js";
import { deleteEmployeeConversations } from "./employeeSurface.js";

export const employeesRouter = Router({ mergeParams: true });
employeesRouter.use(requireAuth);
employeesRouter.use(requireCompanyMember);

async function loadCompany(cid: string): Promise<Company | null> {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function uniqueEmpSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(AIEmployee);
  let slug = base || "employee";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

employeesRouter.get("/", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await loadCompany(cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: cid },
  });
  // Include a lightweight model summary per employee so the dashboard can
  // show connection chips from a single roundtrip. Keep it minimal — the
  // full model shape lives at /employees/:eid/model.
  const models = await AppDataSource.getRepository(AIModel).find();
  const byEmp = new Map(models.map((m) => [m.employeeId, m]));
  const rows = emps.map((e) => {
    const m = byEmp.get(e.id);
    return {
      ...e,
      model: m
        ? {
            provider: m.provider,
            model: m.model,
            status: isModelConnected(m, co, e) ? "connected" : "not_connected",
          }
        : null,
    };
  });
  res.json(rows);
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(80),
});

employeesRouter.post("/", validateBody(createSchema), async (req, res) => {
  const body = req.body as z.infer<typeof createSchema>;
  const co = await loadCompany((req.params as Record<string, string>).cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const repo = AppDataSource.getRepository(AIEmployee);
  const slug = await uniqueEmpSlug(co.id, toSlug(body.name));
  const emp = repo.create({
    companyId: co.id,
    name: body.name,
    role: body.role,
    slug,
  });
  await repo.save(emp);
  const dir = employeeDir(co.slug, slug);
  ensureDir(dir);
  // Scaffold the expected directory structure so the Workspace view shows
  // `skills/` and `routines/` from day one, even before any are created.
  ensureDir(path.join(dir, "skills"));
  ensureDir(path.join(dir, "routines"));
  writeText(soulPath(co.slug, slug), soulTemplate(body.name, body.role));
  res.json(emp);
});

employeesRouter.get("/:eid", async (req, res) => {
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  res.json(emp);
});

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  role: z.string().min(1).max(80).optional(),
});

employeesRouter.patch("/:eid", validateBody(patchSchema), async (req, res) => {
  const body = req.body as z.infer<typeof patchSchema>;
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({ id: req.params.eid, companyId: (req.params as Record<string, string>).cid });
  if (!emp) return res.status(404).json({ error: "Not found" });
  if (body.name !== undefined) emp.name = body.name;
  if (body.role !== undefined) emp.role = body.role;
  await repo.save(emp);
  res.json(emp);
});

employeesRouter.delete("/:eid", async (req, res) => {
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const emp = await empRepo.findOneBy({ id: req.params.eid, companyId: (req.params as Record<string, string>).cid });
  if (!emp) return res.status(404).json({ error: "Not found" });
  const co = await loadCompany((req.params as Record<string, string>).cid);

  // Unregister any cron tasks for routines belonging to this employee.
  const routines = await AppDataSource.getRepository(Routine).find({
    where: { employeeId: emp.id },
  });
  for (const r of routines) unregisterRoutine(r.id);

  await AppDataSource.getRepository(Routine).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(Skill).delete({ employeeId: emp.id });
  await AppDataSource.getRepository(AIModel).delete({ employeeId: emp.id });
  await deleteEmployeeConversations(emp.id);
  await empRepo.delete({ id: emp.id });

  if (co) removeDir(employeeDir(co.slug, emp.slug));
  res.json({ ok: true });
});

// SOUL
employeesRouter.get("/:eid/soul", async (req, res) => {
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  const co = await loadCompany((req.params as Record<string, string>).cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  res.json({ content: readText(soulPath(co.slug, emp.slug)) });
});

const soulSchema = z.object({ content: z.string() });

employeesRouter.put("/:eid/soul", validateBody(soulSchema), async (req, res) => {
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: req.params.eid,
    companyId: (req.params as Record<string, string>).cid,
  });
  if (!emp) return res.status(404).json({ error: "Not found" });
  const co = await loadCompany((req.params as Record<string, string>).cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  writeText(soulPath(co.slug, emp.slug), (req.body as z.infer<typeof soulSchema>).content);
  res.json({ ok: true });
});
