import { Router } from "express";
import { z } from "zod";
import { In, IsNull, Not } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Note } from "../db/entities/Note.js";
import { Notebook } from "../db/entities/Notebook.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { User } from "../db/entities/User.js";
import {
  EmployeeNoteGrant,
  NoteAccessLevel,
} from "../db/entities/EmployeeNoteGrant.js";
import { validateBody } from "../middleware/validate.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { ensureDefaultNotebook } from "../services/notebooks.js";
import {
  deleteGrantsForNote,
  listDirectGrants,
  listInheritedGrants,
  listNotebookInheritedGrants,
  upsertNoteGrant,
} from "../services/notes.js";

export const notesRouter = Router({ mergeParams: true });
notesRouter.use(requireAuth);
notesRouter.use(requireCompanyMember);

/**
 * Pick a slug that doesn't collide with anything in this company. We don't
 * reuse slugs from archived notes — Notion's behavior — to keep restoration
 * predictable.
 */
async function uniqueNoteSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(Note);
  let slug = base || "note";
  let n = 1;
  while (await repo.findOneBy({ companyId, slug })) {
    n += 1;
    slug = `${base}-${n}`;
  }
  return slug;
}

type AuthorRef =
  | { kind: "human"; id: string; name: string; email: string | null }
  | { kind: "ai"; id: string; name: string; slug: string; role: string }
  | null;

type HydratedNote = Note & {
  createdBy: AuthorRef;
  lastEditedBy: AuthorRef;
};

/**
 * Attach human/AI author info to a batch of notes in one round-trip per
 * actor kind, so the sidebar can render "edited by Ada · 2h ago" without
 * an N+1 fetch.
 */
async function hydrateNotes(companyId: string, notes: Note[]): Promise<HydratedNote[]> {
  const userIds = [
    ...new Set(
      notes
        .flatMap((n) => [n.createdById, n.lastEditedById])
        .filter((x): x is string => !!x),
    ),
  ];
  const empIds = [
    ...new Set(
      notes
        .flatMap((n) => [n.createdByEmployeeId, n.lastEditedByEmployeeId])
        .filter((x): x is string => !!x),
    ),
  ];
  const [users, emps] = await Promise.all([
    userIds.length
      ? AppDataSource.getRepository(User).find({ where: { id: In(userIds) } })
      : Promise.resolve([]),
    empIds.length
      ? AppDataSource.getRepository(AIEmployee).find({
          where: { id: In(empIds), companyId },
        })
      : Promise.resolve([]),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const empById = new Map(emps.map((e) => [e.id, e]));

  function refFor(userId: string | null, empId: string | null): AuthorRef {
    if (userId) {
      const u = userById.get(userId);
      if (u) return { kind: "human", id: u.id, name: u.name, email: u.email };
    }
    if (empId) {
      const e = empById.get(empId);
      if (e) return { kind: "ai", id: e.id, name: e.name, slug: e.slug, role: e.role };
    }
    return null;
  }

  return notes.map((n) => ({
    ...n,
    createdBy: refFor(n.createdById, n.createdByEmployeeId),
    lastEditedBy: refFor(n.lastEditedById, n.lastEditedByEmployeeId),
  }));
}

// ----- List & search -----

/**
 * Return every note in the company, ordered by sortOrder then updatedAt.
 * The client builds the tree from `parentId`. Archived notes are filtered
 * out unless `?archived=true` is passed (the trash view). Pass
 * `?notebookSlug=…` to scope to a single notebook.
 */
notesRouter.get("/notes", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const archived = req.query.archived === "true";
  const nbSlugParam = req.query.notebookSlug;
  const where: Record<string, unknown> = {
    companyId: cid,
    archivedAt: archived ? Not(IsNull()) : IsNull(),
  };
  if (typeof nbSlugParam === "string" && nbSlugParam.length > 0) {
    const nb = await AppDataSource.getRepository(Notebook).findOneBy({
      companyId: cid,
      slug: nbSlugParam,
    });
    if (!nb) return res.status(404).json({ error: "Notebook not found" });
    where.notebookId = nb.id;
  }
  const notes = await AppDataSource.getRepository(Note).find({
    where,
    order: { sortOrder: "ASC", updatedAt: "DESC" },
  });
  res.json(await hydrateNotes(cid, notes));
});

/**
 * Crude LIKE-based search across title and body. SQLite + a few thousand
 * notes is fine; if this ever feels slow we can wire FTS5 in.
 */
notesRouter.get("/notes/search", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const q = (req.query.q as string | undefined)?.trim() ?? "";
  if (!q) return res.json([]);
  const term = `%${q.replace(/[%_]/g, (c) => "\\" + c)}%`;
  const rows = await AppDataSource.getRepository(Note)
    .createQueryBuilder("n")
    .where("n.companyId = :cid", { cid })
    .andWhere("n.archivedAt IS NULL")
    .andWhere("(n.title LIKE :term ESCAPE '\\' OR n.body LIKE :term ESCAPE '\\')", { term })
    .orderBy("n.updatedAt", "DESC")
    .limit(50)
    .getMany();
  res.json(await hydrateNotes(cid, rows));
});

// ----- Create -----

const createNoteSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(200_000).optional(),
  icon: z.string().max(40).optional(),
  notebookSlug: z.string().min(1).max(80).optional(),
  parentSlug: z.string().min(1).max(160).nullable().optional(),
});

notesRouter.post("/notes", validateBody(createNoteSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const body = req.body as z.infer<typeof createNoteSchema>;
  const repo = AppDataSource.getRepository(Note);
  const nbRepo = AppDataSource.getRepository(Notebook);

  // Resolve the parent first, because creating a sub-page implies the
  // notebook of the parent — the client doesn't have to repeat itself.
  let parentId: string | null = null;
  let parentNotebookId: string | null = null;
  if (body.parentSlug) {
    const parent = await repo.findOneBy({ companyId: cid, slug: body.parentSlug });
    if (!parent) return res.status(400).json({ error: "Unknown parent note" });
    parentId = parent.id;
    parentNotebookId = parent.notebookId;
  }

  let notebookId: string;
  if (body.notebookSlug) {
    const nb = await nbRepo.findOneBy({ companyId: cid, slug: body.notebookSlug });
    if (!nb) return res.status(400).json({ error: "Unknown notebook" });
    if (parentNotebookId && nb.id !== parentNotebookId) {
      return res
        .status(400)
        .json({ error: "Sub-pages must live in the same notebook as their parent" });
    }
    notebookId = nb.id;
  } else if (parentNotebookId) {
    notebookId = parentNotebookId;
  } else {
    // Fall back to the company's default notebook so the client can create a
    // top-level note without picking a notebook explicitly.
    const nb = await ensureDefaultNotebook(cid, req.userId ?? null);
    notebookId = nb.id;
  }

  const slug = await uniqueNoteSlug(cid, toSlug(body.title));
  // Place new note at the bottom of its sibling group so explicit reorders win.
  const siblings = await repo.find({
    where: {
      companyId: cid,
      notebookId,
      parentId: parentId ?? IsNull(),
    },
    order: { sortOrder: "DESC" },
    take: 1,
  });
  const sortOrder = (siblings[0]?.sortOrder ?? 0) + 1000;

  const note = repo.create({
    companyId: cid,
    notebookId,
    title: body.title,
    slug,
    body: body.body ?? "",
    icon: body.icon ?? "",
    parentId,
    sortOrder,
    createdById: req.userId ?? null,
    createdByEmployeeId: null,
    lastEditedById: req.userId ?? null,
    lastEditedByEmployeeId: null,
    archivedAt: null,
  });
  await repo.save(note);
  const [hydrated] = await hydrateNotes(cid, [note]);
  res.json(hydrated);
});

// ----- Single note -----

async function loadNoteBySlug(companyId: string, slug: string): Promise<Note | null> {
  return AppDataSource.getRepository(Note).findOneBy({ companyId, slug });
}

notesRouter.get("/notes/:noteSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  const [hydrated] = await hydrateNotes(cid, [note]);
  res.json(hydrated);
});

const patchNoteSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
  icon: z.string().max(40).optional(),
  parentSlug: z.string().min(1).max(160).nullable().optional(),
  notebookSlug: z.string().min(1).max(80).optional(),
  sortOrder: z.number().int().optional(),
  archived: z.boolean().optional(),
});

notesRouter.patch(
  "/notes/:noteSlug",
  validateBody(patchNoteSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const note = await loadNoteBySlug(cid, req.params.noteSlug);
    if (!note) return res.status(404).json({ error: "Note not found" });
    const body = req.body as z.infer<typeof patchNoteSchema>;
    const repo = AppDataSource.getRepository(Note);

    // Moving to a different notebook detaches the note from its parent —
    // a sub-page can't survive a notebook move because parents are
    // notebook-local. The client has to opt into this explicitly via
    // notebookSlug; we don't infer it from a parent change.
    let nextNotebookId = note.notebookId;
    let movingNotebook = false;
    if (body.notebookSlug !== undefined) {
      const nb = await AppDataSource.getRepository(Notebook).findOneBy({
        companyId: cid,
        slug: body.notebookSlug,
      });
      if (!nb) return res.status(400).json({ error: "Unknown notebook" });
      if (nb.id !== note.notebookId) {
        nextNotebookId = nb.id;
        movingNotebook = true;
      }
    }

    if (body.parentSlug !== undefined) {
      if (body.parentSlug === null) {
        note.parentId = null;
      } else {
        const parent = await repo.findOneBy({ companyId: cid, slug: body.parentSlug });
        if (!parent) return res.status(400).json({ error: "Unknown parent note" });
        if (parent.id === note.id) {
          return res.status(400).json({ error: "A note cannot be its own parent" });
        }
        if (parent.notebookId !== nextNotebookId) {
          return res.status(400).json({
            error: "A note's parent must live in the same notebook",
          });
        }
        if (await isDescendant(cid, parent.id, note.id)) {
          return res
            .status(400)
            .json({ error: "Cannot move a note under one of its own descendants" });
        }
        note.parentId = parent.id;
      }
    } else if (movingNotebook) {
      // Notebook change without an explicit re-parent → drop to the
      // notebook's top level and pull every descendant along, so the
      // sub-tree stays intact in its new home.
      note.parentId = null;
    }

    if (movingNotebook) {
      note.notebookId = nextNotebookId;
      // Reassign every descendant of `note` to the new notebook so the tree
      // stays self-consistent (parent's notebook == child's notebook).
      const descendants = await collectDescendantIds(cid, note.id);
      if (descendants.length > 0) {
        await repo.update({ id: In(descendants) }, { notebookId: nextNotebookId });
      }
    }

    if (body.title !== undefined) note.title = body.title;
    if (body.body !== undefined) note.body = body.body;
    if (body.icon !== undefined) note.icon = body.icon;
    if (body.sortOrder !== undefined) note.sortOrder = body.sortOrder;
    if (body.archived !== undefined) {
      note.archivedAt = body.archived ? new Date() : null;
    }
    note.lastEditedById = req.userId ?? null;
    note.lastEditedByEmployeeId = null;
    await repo.save(note);
    const [hydrated] = await hydrateNotes(cid, [note]);
    res.json(hydrated);
  },
);

/**
 * BFS down the note tree from `rootId`, returning every descendant id
 * (excluding the root itself). Used when moving a note to a different
 * notebook so we can drag the whole sub-tree along.
 */
async function collectDescendantIds(
  companyId: string,
  rootId: string,
): Promise<string[]> {
  const repo = AppDataSource.getRepository(Note);
  const out: string[] = [];
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const children = await repo.find({
      where: { companyId, parentId: id },
      select: ["id"],
    });
    for (const c of children) {
      out.push(c.id);
      queue.push(c.id);
    }
  }
  return out;
}

/**
 * True if `descendantId` is found anywhere underneath `rootId` by walking
 * children. Used to reject parent-cycles when re-parenting a note.
 */
async function isDescendant(
  companyId: string,
  rootId: string,
  descendantId: string,
): Promise<boolean> {
  const repo = AppDataSource.getRepository(Note);
  const queue: string[] = [rootId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === descendantId) return true;
    const children = await repo.find({
      where: { companyId, parentId: id },
      select: ["id"],
    });
    for (const c of children) queue.push(c.id);
  }
  return false;
}

notesRouter.delete("/notes/:noteSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  const repo = AppDataSource.getRepository(Note);
  // Re-parent direct children up one level rather than orphaning them.
  await repo.update({ companyId: cid, parentId: note.id }, { parentId: note.parentId });
  await deleteGrantsForNote(note.id);
  await repo.delete({ id: note.id });
  res.json({ ok: true });
});

// ----- AI access grants -----

const ACCESS_LEVELS: [NoteAccessLevel, ...NoteAccessLevel[]] = ["read", "write"];

type GrantWithEmployee = EmployeeNoteGrant & {
  employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null } | null;
};

/**
 * Hydrate a batch of grants with the employee's display info so the access
 * bar can render avatars + names without an extra round-trip per grant.
 */
async function hydrateGrants(
  companyId: string,
  grants: EmployeeNoteGrant[],
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

/**
 * Return the access surface for one note: direct grants on this note, plus
 * inherited grants from any ancestor with a `source` pointer back to the
 * granting note so the UI can render "inherited from <title>" with a
 * deep-link.
 */
notesRouter.get("/notes/:noteSlug/grants", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  const [direct, inherited, notebookInherited] = await Promise.all([
    listDirectGrants(note.id),
    listInheritedGrants(note.id),
    listNotebookInheritedGrants(note.id),
  ]);
  // Build lookups of source titles so the UI can show "inherited from
  // <title>" without an N+1 fetch.
  const sourceIds = [...new Set(inherited.map((g) => g.sourceNoteId))];
  const sources = sourceIds.length
    ? await AppDataSource.getRepository(Note).find({
        where: { id: In(sourceIds), companyId: cid },
        select: ["id", "slug", "title"],
      })
    : [];
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const notebook = await AppDataSource.getRepository(Notebook).findOne({
    where: { id: note.notebookId, companyId: cid },
    select: ["id", "slug", "title"],
  });
  const [hydratedDirect, hydratedInherited, hydratedNotebookInherited] =
    await Promise.all([
      hydrateGrants(cid, direct),
      hydrateGrants(cid, inherited),
      hydrateNotebookGrants(cid, notebookInherited),
    ]);
  res.json({
    direct: hydratedDirect,
    inherited: hydratedInherited.map((g) => {
      const source = sourceById.get(g.noteId);
      return {
        ...g,
        source: source
          ? { id: source.id, slug: source.slug, title: source.title }
          : null,
      };
    }),
    notebookInherited: hydratedNotebookInherited.map((g) => ({
      ...g,
      source: notebook
        ? { id: notebook.id, slug: notebook.slug, title: notebook.title }
        : null,
    })),
  });
});

type NotebookGrantWithEmployee = {
  id: string;
  employeeId: string;
  notebookId: string;
  accessLevel: NoteAccessLevel;
  createdAt: Date;
  employee: { id: string; name: string; slug: string; role: string; avatarKey: string | null } | null;
};

async function hydrateNotebookGrants(
  companyId: string,
  grants: Array<{
    id: string;
    employeeId: string;
    notebookId: string;
    accessLevel: NoteAccessLevel;
    createdAt: Date;
  }>,
): Promise<NotebookGrantWithEmployee[]> {
  if (grants.length === 0) return [];
  const empIds = [...new Set(grants.map((g) => g.employeeId))];
  const emps = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(empIds), companyId },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  return grants.map((g) => {
    const e = byId.get(g.employeeId);
    return {
      id: g.id,
      employeeId: g.employeeId,
      notebookId: g.notebookId,
      accessLevel: g.accessLevel,
      createdAt: g.createdAt,
      employee: e
        ? {
            id: e.id,
            name: e.name,
            slug: e.slug,
            role: e.role,
            avatarKey: e.avatarKey ?? null,
          }
        : null,
    };
  });
}

const createGrantSchema = z.object({
  employeeId: z.string().uuid(),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
});

notesRouter.post(
  "/notes/:noteSlug/grants",
  validateBody(createGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const note = await loadNoteBySlug(cid, req.params.noteSlug);
    if (!note) return res.status(404).json({ error: "Note not found" });
    const body = req.body as z.infer<typeof createGrantSchema>;
    const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
      id: body.employeeId,
      companyId: cid,
    });
    if (!emp) return res.status(400).json({ error: "Unknown employee" });
    const grant = await upsertNoteGrant(
      emp.id,
      note.id,
      body.accessLevel ?? "write",
    );
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

const patchGrantSchema = z.object({
  accessLevel: z.enum(ACCESS_LEVELS),
});

notesRouter.patch(
  "/notes/:noteSlug/grants/:grantId",
  validateBody(patchGrantSchema),
  async (req, res) => {
    const cid = (req.params as Record<string, string>).cid;
    const note = await loadNoteBySlug(cid, req.params.noteSlug);
    if (!note) return res.status(404).json({ error: "Note not found" });
    const repo = AppDataSource.getRepository(EmployeeNoteGrant);
    const grant = await repo.findOneBy({ id: req.params.grantId, noteId: note.id });
    if (!grant) return res.status(404).json({ error: "Grant not found" });
    const body = req.body as z.infer<typeof patchGrantSchema>;
    grant.accessLevel = body.accessLevel;
    await repo.save(grant);
    const [hydrated] = await hydrateGrants(cid, [grant]);
    res.json(hydrated);
  },
);

notesRouter.delete("/notes/:noteSlug/grants/:grantId", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  const repo = AppDataSource.getRepository(EmployeeNoteGrant);
  const grant = await repo.findOneBy({ id: req.params.grantId, noteId: note.id });
  if (!grant) return res.status(404).json({ error: "Grant not found" });
  await repo.delete({ id: grant.id });
  res.json({ ok: true });
});

/**
 * Helper for the "+ add access" modal: list AI employees in this company
 * with a flag for which already have a direct grant on the note. Saves the
 * client a separate /employees fetch.
 */
notesRouter.get("/notes/:noteSlug/grant-candidates", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  const [emps, direct] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: cid },
      order: { createdAt: "ASC" },
    }),
    listDirectGrants(note.id),
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
