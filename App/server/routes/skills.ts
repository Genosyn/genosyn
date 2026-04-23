import { Router } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { Skill } from "../db/entities/Skill.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { skillTemplate } from "../services/files.js";

export const skillsRouter = Router({ mergeParams: true });
skillsRouter.use(requireAuth);
skillsRouter.use(requireCompanyMember);

async function loadEmp(cid: string, eid: string) {
  return AppDataSource.getRepository(AIEmployee).findOneBy({ id: eid, companyId: cid });
}
async function loadCo(cid: string) {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function uniqueSlug(employeeId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Skill);
  let slug = base || "skill";
  let n = 1;
  while (await repo.findOneBy({ employeeId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

async function findSkillByName(
  employeeId: string,
  name: string,
): Promise<Skill | null> {
  return AppDataSource.getRepository(Skill)
    .createQueryBuilder("s")
    .where("s.employeeId = :employeeId", { employeeId })
    .andWhere("LOWER(s.name) = LOWER(:name)", { name: name.trim() })
    .getOne();
}

skillsRouter.get("/employees/:eid/skills", async (req, res) => {
  const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  const skills = await AppDataSource.getRepository(Skill).find({
    where: { employeeId: emp.id },
  });
  res.json(skills);
});

const createSchema = z.object({ name: z.string().min(1).max(80) });

skillsRouter.post(
  "/employees/:eid/skills",
  validateBody(createSchema),
  async (req, res) => {
    const emp = await loadEmp((req.params as Record<string, string>).cid, req.params.eid);
    if (!emp) return res.status(404).json({ error: "Employee not found" });
    const co = await loadCo((req.params as Record<string, string>).cid);
    if (!co) return res.status(404).json({ error: "Company not found" });
    const { name } = req.body as z.infer<typeof createSchema>;
    if (await findSkillByName(emp.id, name)) {
      return res
        .status(409)
        .json({ error: "A skill with that name already exists" });
    }
    const slug = await uniqueSlug(emp.id, toSlug(name));
    const repo = AppDataSource.getRepository(Skill);
    const s = repo.create({
      employeeId: emp.id,
      name,
      slug,
      body: skillTemplate(name),
    });
    await repo.save(s);
    res.json(s);
  },
);

async function loadSkill(cid: string, sid: string) {
  const skill = await AppDataSource.getRepository(Skill).findOneBy({ id: sid });
  if (!skill) return null;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: skill.employeeId,
    companyId: cid,
  });
  if (!emp) return null;
  const co = await loadCo(cid);
  if (!co) return null;
  return { skill, emp, co };
}

skillsRouter.get("/skills/:sid/readme", async (req, res) => {
  const found = await loadSkill((req.params as Record<string, string>).cid, req.params.sid);
  if (!found) return res.status(404).json({ error: "Not found" });
  res.json({ content: found.skill.body });
});

const readmeSchema = z.object({ content: z.string() });

skillsRouter.put(
  "/skills/:sid/readme",
  validateBody(readmeSchema),
  async (req, res) => {
    const found = await loadSkill((req.params as Record<string, string>).cid, req.params.sid);
    if (!found) return res.status(404).json({ error: "Not found" });
    found.skill.body = (req.body as z.infer<typeof readmeSchema>).content;
    await AppDataSource.getRepository(Skill).save(found.skill);
    res.json({ ok: true });
  },
);

skillsRouter.delete("/skills/:sid", async (req, res) => {
  const found = await loadSkill((req.params as Record<string, string>).cid, req.params.sid);
  if (!found) return res.status(404).json({ error: "Not found" });
  await AppDataSource.getRepository(Skill).delete({ id: found.skill.id });
  res.json({ ok: true });
});
