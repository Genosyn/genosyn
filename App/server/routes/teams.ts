import { Router } from "express";
import { z } from "zod";
import { IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Team } from "../db/entities/Team.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";

export const teamsRouter = Router({ mergeParams: true });
teamsRouter.use(requireAuth);
teamsRouter.use(requireCompanyMember);

async function loadCompany(cid: string) {
  return AppDataSource.getRepository(Company).findOneBy({ id: cid });
}

async function uniqueTeamSlug(
  companyId: string,
  base: string,
  excludingId?: string,
): Promise<string> {
  const repo = AppDataSource.getRepository(Team);
  let slug = base || "team";
  let n = 1;
  for (;;) {
    const existing = await repo.findOneBy({ companyId, slug });
    if (!existing) return slug;
    if (excludingId && existing.id === excludingId) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

teamsRouter.get("/teams", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await loadCompany(cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const includeArchived = req.query.includeArchived === "true";
  const teams = await AppDataSource.getRepository(Team).find({
    where: includeArchived
      ? { companyId: cid }
      : { companyId: cid, archivedAt: IsNull() },
    order: { name: "ASC" },
  });
  // Lightweight member-count rollup for the list view.
  const empRepo = AppDataSource.getRepository(AIEmployee);
  const counts = new Map<string, number>();
  for (const t of teams) {
    counts.set(t.id, await empRepo.count({ where: { teamId: t.id } }));
  }
  res.json(
    teams.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      archivedAt: t.archivedAt?.toISOString() ?? null,
      memberCount: counts.get(t.id) ?? 0,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    })),
  );
});

const createSchema = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(2_000).optional(),
  })
  .strict();

teamsRouter.post("/teams", validateBody(createSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const co = await loadCompany(cid);
  if (!co) return res.status(404).json({ error: "Company not found" });
  const body = req.body as z.infer<typeof createSchema>;
  const slug = await uniqueTeamSlug(cid, toSlug(body.name));
  const repo = AppDataSource.getRepository(Team);
  const t = repo.create({
    companyId: cid,
    name: body.name.trim(),
    slug,
    description: body.description ?? "",
    archivedAt: null,
  });
  await repo.save(t);
  res.status(201).json({
    id: t.id,
    name: t.name,
    slug: t.slug,
    description: t.description,
    archivedAt: null,
    memberCount: 0,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  });
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(2_000).optional(),
    archived: z.boolean().optional(),
  })
  .strict();

teamsRouter.patch(
  "/teams/:tid",
  validateBody(updateSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const repo = AppDataSource.getRepository(Team);
    const t = await repo.findOneBy({ id: req.params.tid, companyId: cid });
    if (!t) return res.status(404).json({ error: "Team not found" });
    const body = req.body as z.infer<typeof updateSchema>;
    if (body.name !== undefined) {
      t.name = body.name.trim();
      const nextSlug = toSlug(body.name);
      if (nextSlug && nextSlug !== t.slug) {
        t.slug = await uniqueTeamSlug(cid, nextSlug, t.id);
      }
    }
    if (body.description !== undefined) t.description = body.description;
    if (body.archived !== undefined) {
      t.archivedAt = body.archived ? new Date() : null;
    }
    await repo.save(t);
    const memberCount = await AppDataSource.getRepository(AIEmployee).count({
      where: { teamId: t.id },
    });
    res.json({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      archivedAt: t.archivedAt?.toISOString() ?? null,
      memberCount,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    });
  },
);

teamsRouter.delete("/teams/:tid", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const repo = AppDataSource.getRepository(Team);
  const t = await repo.findOneBy({ id: req.params.tid, companyId: cid });
  if (!t) return res.status(404).json({ error: "Team not found" });
  // Detach members so we don't leave dangling teamIds.
  await AppDataSource.getRepository(AIEmployee).update(
    { teamId: t.id },
    { teamId: null },
  );
  await repo.delete({ id: t.id });
  res.json({ ok: true });
});

// Tiny convenience endpoint for the org chart: all employees scoped to one
// team, lightweight payload.
teamsRouter.get("/teams/:tid/members", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const t = await AppDataSource.getRepository(Team).findOneBy({
    id: req.params.tid,
    companyId: cid,
  });
  if (!t) return res.status(404).json({ error: "Team not found" });
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { teamId: t.id, companyId: cid },
    order: { name: "ASC" },
  });
  res.json(
    emps.map((e) => ({
      id: e.id,
      slug: e.slug,
      name: e.name,
      role: e.role,
      reportsToEmployeeId: e.reportsToEmployeeId,
    })),
  );
});

