import { In } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Note } from "../db/entities/Note.js";
import {
  EmployeeNoteGrant,
  NoteAccessLevel,
} from "../db/entities/EmployeeNoteGrant.js";

/**
 * Note-access policy lives here so both the human-facing routes and the AI
 * MCP surface answer the same question the same way: *does this AI employee
 * have read or write on this note?*
 *
 * Cascade rule: a grant on a note authorizes every descendant. Resolved at
 * request time (we walk parents) instead of duplicating rows on create —
 * that way reparenting and revocation behave like Notion's share model and
 * a grant change takes immediate effect on every page below.
 *
 * Humans (members) bypass this entirely. Membership in the company is the
 * only check the human routes apply.
 */

const ACCESS_RANK: Record<NoteAccessLevel, number> = { read: 1, write: 2 };

/** Highest of two access levels — used when comparing self vs ancestor. */
function maxLevel(
  a: NoteAccessLevel | null,
  b: NoteAccessLevel | null,
): NoteAccessLevel | null {
  if (!a) return b;
  if (!b) return a;
  return ACCESS_RANK[a] >= ACCESS_RANK[b] ? a : b;
}

/**
 * Walk up from `noteId` returning every note id in the chain (the note
 * itself first, then parent, grandparent, …). Used both for effective-grant
 * resolution and for building the full set of accessible note ids.
 */
async function ancestorChain(noteId: string): Promise<string[]> {
  const repo = AppDataSource.getRepository(Note);
  const chain: string[] = [];
  let cursor: string | null = noteId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    chain.push(cursor);
    const row = await repo.findOne({
      where: { id: cursor },
      select: ["id", "parentId"],
    });
    cursor = row?.parentId ?? null;
  }
  return chain;
}

/**
 * Resolve the highest grant level the employee has on `noteId`, taking
 * inheritance from ancestors into account. Returns `null` when the
 * employee has no access in the chain.
 */
export async function findEffectiveGrant(
  employeeId: string,
  noteId: string,
): Promise<NoteAccessLevel | null> {
  const chain = await ancestorChain(noteId);
  if (chain.length === 0) return null;
  const grants = await AppDataSource.getRepository(EmployeeNoteGrant).find({
    where: { employeeId, noteId: In(chain) },
  });
  let level: NoteAccessLevel | null = null;
  for (const g of grants) level = maxLevel(level, g.accessLevel);
  return level;
}

/**
 * True iff the employee has at least the requested level on `noteId`,
 * inheritance applied.
 */
export async function hasNoteAccess(
  employeeId: string,
  noteId: string,
  required: NoteAccessLevel,
): Promise<boolean> {
  const level = await findEffectiveGrant(employeeId, noteId);
  if (!level) return false;
  return ACCESS_RANK[level] >= ACCESS_RANK[required];
}

/**
 * Return the full set of note ids the employee can see in this company —
 * directly granted notes plus every descendant of any granted note.
 *
 * Used by `list_notes` / `search_notes` to filter results without doing
 * one access check per row.
 */
export async function listAccessibleNoteIds(
  companyId: string,
  employeeId: string,
): Promise<Set<string>> {
  const grants = await AppDataSource.getRepository(EmployeeNoteGrant).find({
    where: { employeeId },
  });
  if (grants.length === 0) return new Set();
  const grantedIds = new Set(grants.map((g) => g.noteId));

  // BFS down from each granted root. We only need ids, so a single SELECT
  // of the company's full (id, parentId) graph is cheaper than walking N
  // separate queries when an employee has many grants.
  const all = await AppDataSource.getRepository(Note).find({
    where: { companyId },
    select: ["id", "parentId"],
  });
  const childrenByParent = new Map<string, string[]>();
  for (const n of all) {
    if (!n.parentId) continue;
    const list = childrenByParent.get(n.parentId);
    if (list) list.push(n.id);
    else childrenByParent.set(n.parentId, [n.id]);
  }

  const accessible = new Set<string>();
  const queue: string[] = [];
  for (const id of grantedIds) {
    if (!accessible.has(id)) {
      accessible.add(id);
      queue.push(id);
    }
  }
  while (queue.length) {
    const id = queue.shift()!;
    const kids = childrenByParent.get(id);
    if (!kids) continue;
    for (const k of kids) {
      if (!accessible.has(k)) {
        accessible.add(k);
        queue.push(k);
      }
    }
  }
  return accessible;
}

/**
 * Bulk version of `findEffectiveGrant` — for one employee plus a batch of
 * note ids. Builds the parent map once instead of N walks.
 */
export async function findEffectiveGrants(
  companyId: string,
  employeeId: string,
  noteIds: string[],
): Promise<Map<string, NoteAccessLevel>> {
  const out = new Map<string, NoteAccessLevel>();
  if (noteIds.length === 0) return out;

  const grants = await AppDataSource.getRepository(EmployeeNoteGrant).find({
    where: { employeeId },
  });
  if (grants.length === 0) return out;
  const grantByNote = new Map(grants.map((g) => [g.noteId, g.accessLevel]));

  const all = await AppDataSource.getRepository(Note).find({
    where: { companyId },
    select: ["id", "parentId"],
  });
  const parentOf = new Map(all.map((n) => [n.id, n.parentId]));

  for (const id of noteIds) {
    let level: NoteAccessLevel | null = null;
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const g = grantByNote.get(cursor);
      if (g) level = maxLevel(level, g);
      cursor = parentOf.get(cursor) ?? null;
    }
    if (level) out.set(id, level);
  }
  return out;
}

/**
 * Idempotent grant create. If a grant already exists, the existing row is
 * returned with its level updated to `accessLevel`. Returns the persisted
 * grant.
 */
export async function upsertNoteGrant(
  employeeId: string,
  noteId: string,
  accessLevel: NoteAccessLevel,
): Promise<EmployeeNoteGrant> {
  const repo = AppDataSource.getRepository(EmployeeNoteGrant);
  const existing = await repo.findOneBy({ employeeId, noteId });
  if (existing) {
    if (existing.accessLevel !== accessLevel) {
      existing.accessLevel = accessLevel;
      await repo.save(existing);
    }
    return existing;
  }
  const row = repo.create({ employeeId, noteId, accessLevel });
  await repo.save(row);
  return row;
}

/**
 * Direct-grant lookup for the UI's "Shared with" bar — caller decides how
 * to merge with inherited grants.
 */
export async function listDirectGrants(
  noteId: string,
): Promise<EmployeeNoteGrant[]> {
  return AppDataSource.getRepository(EmployeeNoteGrant).find({
    where: { noteId },
    order: { createdAt: "ASC" },
  });
}

/**
 * Walk up parents and return every grant from any ancestor of `noteId`,
 * keyed by the ancestor's id so the caller can show "inherited from
 * <ancestor title>". Excludes direct grants on the note itself.
 */
export async function listInheritedGrants(
  noteId: string,
): Promise<Array<EmployeeNoteGrant & { sourceNoteId: string }>> {
  const chain = await ancestorChain(noteId);
  if (chain.length <= 1) return [];
  const ancestorIds = chain.slice(1);
  const rows = await AppDataSource.getRepository(EmployeeNoteGrant).find({
    where: { noteId: In(ancestorIds) },
    order: { createdAt: "ASC" },
  });
  return rows.map((g) => Object.assign(g, { sourceNoteId: g.noteId }));
}

/**
 * Drop every grant pointing at `noteId`. Called from the hard-delete path
 * so the join table doesn't accumulate orphan rows.
 */
export async function deleteGrantsForNote(noteId: string): Promise<void> {
  await AppDataSource.getRepository(EmployeeNoteGrant).delete({ noteId });
}
