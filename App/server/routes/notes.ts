import { createHash } from "node:crypto";
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
import { validateBody, validateQuery } from "../middleware/validate.js";
import { andWhereTokens, tokenizeQuery } from "../services/likeSearch.js";
import { requireAuth, requireCompanyMember } from "../middleware/auth.js";
import { toSlug } from "../lib/slug.js";
import { ensureDefaultNotebook } from "../services/notebooks.js";
import {
  archiveNoteTree,
  collectDescendantIds,
  deleteGrantsForNote,
  duplicateNote,
  isNoteDescendant,
  listDirectGrants,
  listInheritedGrants,
  listNotebookInheritedGrants,
  moveNote,
  NoteTreeError,
  outlineOf,
  restoreNoteTree,
  upsertNoteGrant,
} from "../services/notes.js";
import { noteSnippet } from "../../shared/notePreview.js";
import { deleteTagAssignments } from "../services/tags.js";
import { recordAudit } from "../services/audit.js";
import { recordCoalescedAudit } from "../services/auditCoalesce.js";

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

/**
 * A short token naming one exact state of a page's content. `updatedAt` alone
 * can't do it: SQLite keeps it to the second, and two saves inside one second
 * (an AI Employee's and a Member's) would look like one version.
 */
function noteVersion(note: Pick<Note, "updatedAt" | "title" | "body" | "icon">): string {
  return createHash("sha256")
    .update(`${new Date(note.updatedAt).getTime()}\u0000${note.title}\u0000${note.icon}\u0000${note.body}`)
    .digest("base64url")
    .slice(0, 22);
}

function withVersion<N extends Note>(note: N): N & { version: string } {
  return { ...note, version: noteVersion(note) };
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

const listNotesQuery = z.object({
  archived: z.enum(["true", "false"]).optional(),
  notebookSlug: z.string().max(80).optional(),
  /**
   * `outline` drops each body for a one-line `preview`: what the sidebar and
   * the notebook pages need. They refetch whenever any page saves, and
   * shipping every body on every keystroke-save was the bulk of the traffic.
   */
  view: z.enum(["full", "outline"]).optional(),
});

/**
 * Return every note in the company, ordered by sortOrder then updatedAt.
 * The client builds the tree from `parentId`. Archived notes are filtered
 * out unless `?archived=true` is passed (the trash view). Pass
 * `?notebookSlug=…` to scope to a single notebook.
 */
notesRouter.get("/notes", validateQuery(listNotesQuery), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const query = req.query as z.infer<typeof listNotesQuery>;
  const archived = query.archived === "true";
  const where: Record<string, unknown> = {
    companyId: cid,
    archivedAt: archived ? Not(IsNull()) : IsNull(),
  };
  if (query.notebookSlug) {
    const nb = await AppDataSource.getRepository(Notebook).findOneBy({
      companyId: cid,
      slug: query.notebookSlug,
    });
    if (!nb) return res.status(404).json({ error: "Notebook not found" });
    where.notebookId = nb.id;
  }
  const notes = await AppDataSource.getRepository(Note).find({
    where,
    order: { sortOrder: "ASC", updatedAt: "DESC" },
  });
  const hydrated = await hydrateNotes(cid, notes);
  res.json(query.view === "outline" ? hydrated.map(outlineOf) : hydrated);
});

const searchNotesQuery = z.object({
  q: z.string().max(200).optional(),
  notebookSlug: z.string().max(80).optional(),
  view: z.enum(["full", "outline"]).optional(),
});

/**
 * Tokenized LIKE search across title and body, sharing `services/likeSearch`
 * with the ⌘K palette and Resources. It used to be one `LIKE '%the whole
 * query%'`, which missed every page whose words appear in a different order —
 * and, because bare LIKE folds ASCII case on sqlite but not on postgres,
 * returned different rows on the two supported drivers. SQLite plus a few
 * thousand notes is still fine; if this ever feels slow we can wire FTS5 in.
 *
 * `?view=outline` answers with previews and a `snippet` of the matching text
 * instead of whole bodies; `?notebookSlug=` searches one notebook.
 */
notesRouter.get("/notes/search", validateQuery(searchNotesQuery), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const query = req.query as z.infer<typeof searchNotesQuery>;
  const q = query.q?.trim() ?? "";
  if (!q) return res.json([]);
  const tokens = tokenizeQuery(q);
  if (tokens.length === 0) return res.json([]);
  let builder = AppDataSource.getRepository(Note)
    .createQueryBuilder("n")
    .where("n.companyId = :cid", { cid })
    .andWhere("n.archivedAt IS NULL");
  if (query.notebookSlug) {
    const nb = await AppDataSource.getRepository(Notebook).findOneBy({
      companyId: cid,
      slug: query.notebookSlug,
    });
    if (!nb) return res.status(404).json({ error: "Notebook not found" });
    builder = builder.andWhere("n.notebookId = :nbId", { nbId: nb.id });
  }
  const rows = await andWhereTokens(builder, ["n.title", "n.body"], tokens)
    .orderBy("n.updatedAt", "DESC")
    .limit(50)
    .getMany();
  const hydrated = await hydrateNotes(cid, rows);
  if (query.view !== "outline") return res.json(hydrated);
  res.json(hydrated.map((n) => ({ ...outlineOf(n), snippet: noteSnippet(n.body, q) })));
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
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "note.create",
    targetType: "note",
    targetId: note.id,
    targetLabel: note.title,
    metadata: parentId ? { parentId } : undefined,
  });
  const [hydrated] = await hydrateNotes(cid, [note]);
  res.json(withVersion(hydrated));
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
  res.json(withVersion(hydrated));
});

const patchNoteSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().max(200_000).optional(),
  icon: z.string().max(40).optional(),
  parentSlug: z.string().min(1).max(160).nullable().optional(),
  notebookSlug: z.string().min(1).max(80).optional(),
  sortOrder: z.number().int().optional(),
  archived: z.boolean().optional(),
  /**
   * The `version` of the page these edits were made from. When the page has
   * been saved since (an AI Employee wrote to it while a Member typed), the
   * edit is refused with 409 and the current page, so the editor merges
   * instead of silently overwriting the other side's work.
   */
  baseVersion: z.string().min(1).max(64).optional(),
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

    const editsContent = body.title !== undefined || body.body !== undefined || body.icon !== undefined;
    if (editsContent && body.baseVersion !== undefined && body.baseVersion !== noteVersion(note)) {
      const [current] = await hydrateNotes(cid, [note]);
      return res
        .status(409)
        .json({ error: "This page changed since you opened it", note: withVersion(current) });
    }
    const originalParentId = note.parentId;

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
        // The cycle to refuse is the new parent sitting under this page. (This
        // used to ask the opposite question, so moving a page up beside its
        // parent was refused while moving it under its own child went through.)
        if (await isNoteDescendant(cid, note.id, parent.id)) {
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
        await repo.update({ id: In(descendants), companyId: cid }, { notebookId: nextNotebookId });
      }
    }

    const wasArchived = note.archivedAt !== null;
    const editedFields: string[] = [];
    if (body.title !== undefined && body.title !== note.title) editedFields.push("title");
    if (body.body !== undefined && body.body !== note.body) editedFields.push("body");
    if (body.icon !== undefined && body.icon !== note.icon) editedFields.push("icon");
    if (body.title !== undefined) note.title = body.title;
    if (body.body !== undefined) note.body = body.body;
    if (body.icon !== undefined) note.icon = body.icon;
    if (body.sortOrder !== undefined) note.sortOrder = body.sortOrder;
    // Only an actual edit moves "last edited by": trashing or moving a page
    // isn't writing it.
    if (editedFields.length > 0) {
      note.lastEditedById = req.userId ?? null;
      note.lastEditedByEmployeeId = null;
    }
    await repo.save(note);
    // Trashing takes the sub-pages along; restoring brings back those that went with it.
    let cascaded = 0;
    if (body.archived === true && !wasArchived) cascaded = await archiveNoteTree(cid, note);
    if (body.archived === false && wasArchived) cascaded = await restoreNoteTree(cid, note);
    const audit = {
      companyId: cid,
      actorUserId: req.userId ?? null,
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
    };
    if (body.archived !== undefined && body.archived !== wasArchived) {
      await recordAudit({
        ...audit,
        action: body.archived ? "note.archive" : "note.restore",
        metadata: cascaded > 0 ? { subPages: cascaded } : undefined,
      });
    }
    if (movingNotebook || note.parentId !== originalParentId) {
      await recordAudit({ ...audit, action: "note.move" });
    }
    if (editedFields.length > 0) {
      // The editor autosaves while someone types: one entry per editing
      // stretch, not one per save.
      await recordCoalescedAudit({
        ...audit,
        action: "note.update",
        metadata: { fields: editedFields },
      });
    }
    const [hydrated] = await hydrateNotes(cid, [note]);
    res.json(withVersion(hydrated));
  },
);

const moveNoteSchema = z.object({
  /** Destination notebook; defaults to the page's own. */
  notebookSlug: z.string().min(1).max(80).optional(),
  /** New parent page, or null for the notebook's top level. Defaults to the current parent. */
  parentSlug: z.string().min(1).max(160).nullable().optional(),
  /** Position among the new siblings; omitted means last. */
  index: z.number().int().min(0).max(100_000).optional(),
});

/**
 * Put a page somewhere in the tree — what dragging it in the sidebar and
 * "Move to…" do. Sub-pages travel with it; siblings are renumbered on the
 * server so positions never collide; nobody's "last edited" moves.
 */
notesRouter.post("/notes/:noteSlug/move", validateBody(moveNoteSchema), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  if (note.archivedAt) return res.status(400).json({ error: "Restore the page before moving it" });
  const body = req.body as z.infer<typeof moveNoteSchema>;
  let notebookId = note.notebookId;
  if (body.notebookSlug !== undefined) {
    const nb = await AppDataSource.getRepository(Notebook).findOneBy({ companyId: cid, slug: body.notebookSlug });
    if (!nb) return res.status(400).json({ error: "Unknown notebook" });
    notebookId = nb.id;
  }
  let parentId: string | null =
    body.parentSlug === undefined ? (notebookId === note.notebookId ? note.parentId : null) : null;
  if (body.parentSlug) {
    const parent = await loadNoteBySlug(cid, body.parentSlug);
    if (!parent) return res.status(400).json({ error: "Unknown parent page" });
    parentId = parent.id;
  }
  try {
    const relocated = await moveNote(cid, note, { notebookId, parentId, index: body.index });
    if (relocated) {
      await recordAudit({
        companyId: cid,
        actorUserId: req.userId ?? null,
        action: "note.move",
        targetType: "note",
        targetId: note.id,
        targetLabel: note.title,
      });
    }
  } catch (err) {
    if (err instanceof NoteTreeError) return res.status(400).json({ error: err.message });
    throw err;
  }
  const fresh = await loadNoteBySlug(cid, note.slug);
  const [hydrated] = await hydrateNotes(cid, [fresh ?? note]);
  res.json(withVersion(hydrated));
});

/** A copy of the page right after it: its title, body and icon, not its sub-pages or Grants. */
notesRouter.post("/notes/:noteSlug/duplicate", validateBody(z.object({}).strict()), async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  if (note.archivedAt) return res.status(400).json({ error: "Restore the page before duplicating it" });
  const copy = await duplicateNote(cid, note, req.userId ?? null, (base) => uniqueNoteSlug(cid, base));
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "note.create",
    targetType: "note",
    targetId: copy.id,
    targetLabel: copy.title,
    metadata: { duplicateOf: note.id },
  });
  const [hydrated] = await hydrateNotes(cid, [copy]);
  res.json(withVersion(hydrated));
});

notesRouter.delete("/notes/:noteSlug", async (req, res) => {
  const cid = (req.params as Record<string, string>).cid;
  const note = await loadNoteBySlug(cid, req.params.noteSlug);
  if (!note) return res.status(404).json({ error: "Note not found" });
  const repo = AppDataSource.getRepository(Note);
  // Re-parent direct children up one level rather than orphaning them.
  await repo.update({ companyId: cid, parentId: note.id }, { parentId: note.parentId });
  await deleteGrantsForNote(note.id);
  await deleteTagAssignments("note", note.id);
  await repo.delete({ id: note.id });
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "note.delete",
    targetType: "note",
    targetId: note.id,
    targetLabel: note.title,
  });
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
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "note.grant",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: { employee: emp.name, accessLevel: grant.accessLevel },
    });
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
    await recordAudit({
      companyId: cid,
      actorUserId: req.userId ?? null,
      action: "note.access.update",
      targetType: "note",
      targetId: note.id,
      targetLabel: note.title,
      metadata: { employee: hydrated?.employee?.name ?? null, accessLevel: grant.accessLevel },
    });
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
  const [revoked] = await hydrateGrants(cid, [grant]);
  await recordAudit({
    companyId: cid,
    actorUserId: req.userId ?? null,
    action: "note.revoke",
    targetType: "note",
    targetId: note.id,
    targetLabel: note.title,
    metadata: { employee: revoked?.employee?.name ?? null },
  });
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
