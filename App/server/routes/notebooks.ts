import { Router } from "express";
import { z } from "zod";
import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Note } from "../db/entities/Note.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  EmployeeNotebookGrant,
} from "../db/entities/EmployeeNotebookGrant.js";
import type { NoteAccessLevel } from "../db/entities/EmployeeNoteGrant.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import {
  ensureDefaultNotebook,
  uniqueNotebookSlug,
} from "../services/notebooks.js";
import {
  deleteGrantsForNotebook,
  listDirectNotebookGrants,
  upsertNotebookGrant,
} from "../services/notes.js";

/**
 * Notebooks — the top-level grouping shown in the Notes sidebar. Every
 * Note belongs to one Notebook; notebooks themselves do not nest. We
 * always keep at least one notebook per company so the create-note flow
 * has a default home.
 */
export const notebooksRouter = Router({ mergeParams: true });
notebooksRouter.use(requireAuth);
notebooksRouter.use(requireCompanyMember);

type NotebookWithCounts = Notebook & {
  noteCount: number;
  archivedCount: number;
};

async function withCounts(
  companyId: string,
  notebooks: Notebook[],
): Promise<NotebookWithCounts[]> {
  if (notebooks.length === 0) return [];
  // Two grouped queries instead of one row-per-notebook query — cheap on
  // SQLite and keeps the response shape obvious.
  const liveRows: Array<{ notebookId: string; c: number }> = await AppDataSource
    .getRepository(Note)
    .createQueryBuilder("n")
    .select("n.notebookId", "notebookId")
    .addSelect("COUNT(*)", "c")
    .where("n.companyId = :cid", { cid: companyId })
    .andWhere("n.archivedAt IS NULL")
    .groupBy("n.notebookId")
    .getRawMany();
  const archivedRows: Array<{ notebookId: string; c: number }> = await AppDataSource
    .getRepository(Note)
    .createQueryBuilder("n")
    .select("n.notebookId", "notebookId")
    .addSelect("COUNT(*)", "c")
    .where("n.companyId = :cid", { cid: companyId })
    .andWhere("n.archivedAt IS NOT NULL")
    .groupBy("n.notebookId")
    .getRawMany();
  const liveByNb = new Map(liveRows.map((r) => [r.notebookId, Number(r.c)]));
  const archivedByNb = new Map(
    archivedRows.map((r) => [r.notebookId, Number(r.c)]),
  );
  return notebooks.map((nb) => ({
    ...nb,
    noteCount: liveByNb.get(nb.id) ?? 0,
    archivedCount: archivedByNb.get(nb.id) ?? 0,
  }));
}

notebooksRouter.get("/notebooks", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  // Seed a default notebook on first read for older companies whose row
  // predates this feature and somehow missed the migration backfill.
  const repo = AppDataSource.getRepository(Notebook);
  let rows = await repo.find({
    where: { companyId: cid },
    order: { sortOrder: "ASC", createdAt: "ASC" },
  });
  if (rows.length === 0) {
    await ensureDefaultNotebook(cid, req.userId ?? null);
    rows = await repo.find({
      where: { companyId: cid },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
  }
  res.json(await withCounts(cid, rows));
});

const createNotebookSchema = z.object({
  title: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
});

notebooksRouter.post(
  "/notebooks",
  validateBody(createNotebookSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const body = req.body as z.infer<typeof createNotebookSchema>;
    const repo = AppDataSource.getRepository(Notebook);
    const slug = await uniqueNotebookSlug(cid, toSlug(body.title));
    // Place new notebook at the bottom so explicit reorders win.
    const last = await repo.find({
      where: { companyId: cid },
      order: { sortOrder: "DESC" },
      take: 1,
    });
    const sortOrder = (last[0]?.sortOrder ?? 0) + 1000;
    const nb = repo.create({
      companyId: cid,
      title: body.title,
      slug,
      icon: body.icon ?? "",
      sortOrder,
      createdById: req.userId ?? null,
      createdByEmployeeId: null,
    });
    await repo.save(nb);
    const [hydrated] = await withCounts(cid, [nb]);
    res.json(hydrated);
  },
);

async function loadNotebook(companyId: string, slug: string): Promise<Notebook | null> {
  return AppDataSource.getRepository(Notebook).findOneBy({ companyId, slug });
}

notebooksRouter.get("/notebooks/:nbSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const nb = await loadNotebook(cid, req.params.nbSlug);
  if (!nb) return res.status(404).json({ error: "Notebook not found" });
  const [hydrated] = await withCounts(cid, [nb]);
  res.json(hydrated);
});

const patchNotebookSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  icon: z.string().max(40).optional(),
  sortOrder: z.number().int().optional(),
});

notebooksRouter.patch(
  "/notebooks/:nbSlug",
  validateBody(patchNotebookSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const nb = await loadNotebook(cid, req.params.nbSlug);
    if (!nb) return res.status(404).json({ error: "Notebook not found" });
    const body = req.body as z.infer<typeof patchNotebookSchema>;
    if (body.title !== undefined) nb.title = body.title;
    if (body.icon !== undefined) nb.icon = body.icon;
    if (body.sortOrder !== undefined) nb.sortOrder = body.sortOrder;
    await AppDataSource.getRepository(Notebook).save(nb);
    const [hydrated] = await withCounts(cid, [nb]);
    res.json(hydrated);
  },
);

notebooksRouter.delete("/notebooks/:nbSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const nb = await loadNotebook(cid, req.params.nbSlug);
  if (!nb) return res.status(404).json({ error: "Notebook not found" });

  // Refuse to delete a notebook that still has any notes (live or trashed).
  // Forces the caller to either move the pages first or empty the trash —
  // we never silently orphan notes.
  const notesRepo = AppDataSource.getRepository(Note);
  const noteCount = await notesRepo.count({ where: { notebookId: nb.id } });
  if (noteCount > 0) {
    return res.status(400).json({
      error: "Move or delete the notes inside this notebook first.",
    });
  }

  // Don't let the company end up with zero notebooks — the create-note flow
  // assumes there's always at least one home.
  const total = await AppDataSource.getRepository(Notebook).count({
    where: { companyId: cid },
  });
  if (total <= 1) {
    return res.status(400).json({
      error: "A company must keep at least one notebook.",
    });
  }

  await deleteGrantsForNotebook(nb.id);
  await AppDataSource.getRepository(Notebook).delete({ id: nb.id });
  res.json({ ok: true });
});

// ----- AI access grants on the notebook itself -----

const ACCESS_LEVELS: [NoteAccessLevel, ...NoteAccessLevel[]] = ["read", "write"];

type GrantWithEmployee = EmployeeNotebookGrant & {
  employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null } | null;
};

async function hydrateGrants(
  companyId: string,
  grants: EmployeeNotebookGrant[],
): Promise<GrantWithEmployee[]> {
  if (grants.length === 0) return [];
  const empIds = [...new Set(grants.map((g) => g.employeeId))];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(empIds), companyId },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  return grants.map((g) => {
    const e = byId.get(g.employeeId);
    return Object.assign(g, {
      employee: e
        ? {
            id: e.id,
            name: e.name,
            slug: e.slug,
            role: e.role,
            avatarKey: e.avatarKey ?? null,
          }
        : null,
    });
  });
}

notebooksRouter.get("/notebooks/:nbSlug/grants", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const nb = await loadNotebook(cid, req.params.nbSlug);
  if (!nb) return res.status(404).json({ error: "Notebook not found" });
  const direct = await listDirectNotebookGrants(nb.id);
  res.json({ direct: await hydrateGrants(cid, direct) });
});

const createGrantSchema = z.object({
  employeeId: z.string().uuid(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
});

notebooksRouter.post(
  "/notebooks/:nbSlug/grants",
  validateBody(createGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const nb = await loadNotebook(cid, req.params.nbSlug);
    if (!nb) return res.status(404).json({ error: "Notebook not found" });
    const body = req.body as z.infer<typeof createGrantSchema>;
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(400).json({ error: "Unknown employee" });
    const grant = await upsertNotebookGrant(
      emp.id,
      nb.id,
      body.accessLevel ?? "write",
    );
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

const patchGrantSchema = z.object({
  accessLevel: z.enum(ACCESS_LEVELS),
});

notebooksRouter.patch(
  "/notebooks/:nbSlug/grants/:grantId",
  validateBody(patchGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const nb = await loadNotebook(cid, req.params.nbSlug);
    if (!nb) return res.status(404).json({ error: "Notebook not found" });
    const repo = AppDataSource.getRepository(EmployeeNotebookGrant);
    const grant = await repo.findOneBy({ id: req.params.grantId, notebookId: nb.id });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    const body = req.body as z.infer<typeof patchGrantSchema>;
    grant.accessLevel = body.accessLevel;
    await repo.save(grant);
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

notebooksRouter.delete(
  "/notebooks/:nbSlug/grants/:grantId",
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const nb = await loadNotebook(cid, req.params.nbSlug);
    if (!nb) return res.status(404).json({ error: "Notebook not found" });
    const repo = AppDataSource.getRepository(EmployeeNotebookGrant);
    const grant = await repo.findOneBy({
      id: req.params.grantId,
      notebookId: nb.id,
    });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    await repo.delete({ id: grant.id });
    res.json({ ok: true });
  },
);

/** Helper for the "+ add access" modal — list every employee with a flag
 * for whether they already have a direct grant on this notebook. */
notebooksRouter.get("/notebooks/:nbSlug/grant-candidates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const nb = await loadNotebook(cid, req.params.nbSlug);
  if (!nb) return res.status(404).json({ error: "Notebook not found" });
  const [emps, direct] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: cid },
      order: { createdAt: "ASC" },
    }),
    listDirectNotebookGrants(nb.id),
  ]);
  const grantedSet = new Set(direct.map((g) => g.employeeId));
  res.json(
    emps.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      role: e.role,
      avatarKey: e.avatarKey ?? null,
      alreadyGranted: grantedSet.has(e.id),
    })),
  );
});
