import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { Routine } from "../db/entities/Routine.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import {
  employeeDir,
  ensureDir,
  soulPath,
} from "../services/paths.js";
import { readText, removeDir, soulTemplate, writeText } from "../services/files.js";
import { unregisterRoutine } from "../services/cron.js";

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
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { companyId: (req.params as Record<string, string>).cid },
  });
  res.json(emps);
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  role: z.string().min(1).max(80),
  defaultModelId: z.string().uuid().optional(),
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
    defaultModelId: body.defaultModelId ?? null,
  });
  await repo.save(emp);
  ensureDir(employeeDir(co.slug, slug));
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
  defaultModelId: z.string().uuid().nullable().optional(),
});

employeesRouter.patch("/:eid", validateBody(patchSchema), async (req, res) => {
  const body = req.body as z.infer<typeof patchSchema>;
  const repo = AppDataSource.getRepository(AIEmployee);
  const emp = await repo.findOneBy({ id: req.params.eid, companyId: (req.params as Record<string, string>).cid });
  if (!emp) return res.status(404).json({ error: "Not found" });
  if (body.name !== undefined) emp.name = body.name;
  if (body.role !== undefined) emp.role = body.role;
  if (body.defaultModelId !== undefined) emp.defaultModelId = body.defaultModelId;
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
