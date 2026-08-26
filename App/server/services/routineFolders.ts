import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineFolder } from "../db/entities/RoutineFolder.js";
import { toSlug } from "../lib/slug.js";
// The shared uuid-PK guard, not a second copy: Postgres raises 22P02 rather
// than missing when a uuid column meets arbitrary text, so a folder *path* must
// never reach an id lookup. SQLite returns no rows, which is why this only ever
// bites in production.
import { UUID_RE } from "./bases.js";
import { emitResourceChange } from "./resourceEvents.js";

/**
 * Routine folders — the tree rules live here so the HTTP router, the MCP tool
 * handlers, and the routine write paths all enforce the same ones.
 *
 * Every invariant this module protects exists because the alternative is a
 * folder tree that quietly stops rendering: a cycle makes the sidebar recurse
 * forever, an unbounded depth makes it unreadable, and a delete that took its
 * contents with it would lose routines a person only meant to unfile.
 */

/**
 * How deep the tree may go, counting the top level as 1. Five is past the
 * point where a sidebar stays readable and well short of anything that makes
 * the recursive walks below expensive; it exists to stop a client (or an AI
 * employee handed a `folder` path) from building a tree nobody can navigate.
 */
export const MAX_FOLDER_DEPTH = 5;

/** Separator for the `"Finance/Month-end"` folder paths the MCP tools accept. */
export const FOLDER_PATH_SEPARATOR = "/";

/**
 * Slugs a folder may never take, because the Routines list already spends them
 * on `?folder=` values that are not folders. `unfiled` is the "in no folder at
 * all" view; without this a folder literally named "Unfiled" would slug to
 * `unfiled` and the filter would have two meanings. Reserving it here — where
 * slugs are minted — is what keeps that URL unambiguous forever.
 */
const RESERVED_FOLDER_SLUGS = new Set(["unfiled"]);

export class RoutineFolderError extends Error {}

/** A folder plus what the sidebar needs to render it without a second query. */
export type RoutineFolderWithMeta = RoutineFolder & {
  /** Routines filed directly in this folder. */
  routineCount: number;
  /** Routines in this folder and everything beneath it. */
  totalRoutineCount: number;
  /** Slash-joined ancestor names, this folder last. */
  path: string;
  /** 1 for a top-level folder. */
  depth: number;
};

/**
 * The separator is stripped rather than rejected: a folder named "Ops/Support"
 * would otherwise render a path that {@link resolveFolderPath} reads back as
 * two folders, so the name and the path would disagree about the tree.
 */
function cleanFolderName(value: string): string {
  return value
    .replace(new RegExp(FOLDER_PATH_SEPARATOR, "g"), " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
}

export async function listFolders(companyId: string): Promise<RoutineFolder[]> {
  return AppDataSource.getRepository(RoutineFolder).find({
    where: { companyId },
    order: { sortOrder: "ASC", name: "ASC" },
  });
}

/**
 * Every folder in the company with its counts, path, and depth resolved.
 *
 * Counts come from one grouped query over the routines the company's employees
 * own — a routine has no `companyId` of its own, so ownership is always a hop
 * through {@link AIEmployee}. Rolling the subtree totals up is done in memory
 * because the tree is bounded by {@link MAX_FOLDER_DEPTH} and a company's
 * folder count is small.
 */
export async function listFoldersWithMeta(companyId: string): Promise<RoutineFolderWithMeta[]> {
  const folders = await listFolders(companyId);
  if (folders.length === 0) return [];

  const direct = await routineCountsByFolder(companyId);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const childIds = new Map<string | null, string[]>();
  for (const folder of folders) {
    // A parent that no longer resolves (a partially-applied delete, a row
    // hand-edited in the database) would otherwise strand its subtree out of
    // every listing. Treat it as top-level so the folder stays reachable.
    const parentId = folder.parentId && byId.has(folder.parentId) ? folder.parentId : null;
    const siblings = childIds.get(parentId) ?? [];
    siblings.push(folder.id);
    childIds.set(parentId, siblings);
  }

  const meta = new Map<string, RoutineFolderWithMeta>();
  const walk = (id: string, depth: number, prefix: string): number => {
    const folder = byId.get(id)!;
    const path = prefix ? `${prefix}${FOLDER_PATH_SEPARATOR}${folder.name}` : folder.name;
    const routineCount = direct.get(id) ?? 0;
    let total = routineCount;
    for (const childId of childIds.get(id) ?? []) total += walk(childId, depth + 1, path);
    meta.set(id, Object.assign(folder, { routineCount, totalRoutineCount: total, path, depth }));
    return total;
  };
  for (const rootId of childIds.get(null) ?? []) walk(rootId, 1, "");

  // Preserve the sorted order the query returned rather than the walk order,
  // so siblings still come back by sortOrder then name.
  return folders.map((f) => meta.get(f.id)!).filter(Boolean);
}

/** folderId → number of routines filed directly in it, for one company. */
async function routineCountsByFolder(companyId: string): Promise<Map<string, number>> {
  const rows = await AppDataSource.getRepository(Routine)
    .createQueryBuilder("r")
    .select("r.folderId", "folderId")
    .addSelect("COUNT(*)", "count")
    .innerJoin(AIEmployee, "e", "e.id = r.employeeId")
    .where("e.companyId = :companyId", { companyId })
    .andWhere("r.folderId IS NOT NULL")
    .groupBy("r.folderId")
    .getRawMany<{ folderId: string; count: number | string }>();
  return new Map(rows.map((row) => [row.folderId, Number(row.count)]));
}

/** How many routines in this company are not filed in any folder. */
export async function unfiledRoutineCount(companyId: string): Promise<number> {
  return AppDataSource.getRepository(Routine)
    .createQueryBuilder("r")
    .innerJoin(AIEmployee, "e", "e.id = r.employeeId")
    .where("e.companyId = :companyId", { companyId })
    .andWhere("r.folderId IS NULL")
    .getCount();
}

async function uniqueFolderSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(RoutineFolder);
  const root = base || "folder";
  let slug = root;
  let n = 1;
  while (RESERVED_FOLDER_SLUGS.has(slug) || (await repo.findOneBy({ companyId, slug }))) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

/** 1 for a top-level folder. Throws if the chain is broken or cyclic. */
async function depthOf(companyId: string, folderId: string | null): Promise<number> {
  let depth = 0;
  let cursor = folderId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new RoutineFolderError("That folder tree contains a cycle.");
    seen.add(cursor);
    const row = await AppDataSource.getRepository(RoutineFolder).findOneBy({
      id: cursor,
      companyId,
    });
    if (!row) throw new RoutineFolderError("Folder not found");
    depth += 1;
    cursor = row.parentId;
  }
  return depth;
}

/** The folder plus every folder beneath it, ids only. */
export async function folderSubtreeIds(companyId: string, folderId: string): Promise<string[]> {
  const folders = await listFolders(companyId);
  const childIds = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const siblings = childIds.get(folder.parentId) ?? [];
    siblings.push(folder.id);
    childIds.set(folder.parentId, siblings);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [folderId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(childIds.get(id) ?? []));
  }
  return out;
}

/** How deep the subtree under `folderId` runs. 1 = no children. */
async function subtreeHeight(companyId: string, folderId: string): Promise<number> {
  const folders = await listFolders(companyId);
  const childIds = new Map<string, string[]>();
  for (const folder of folders) {
    if (!folder.parentId) continue;
    const siblings = childIds.get(folder.parentId) ?? [];
    siblings.push(folder.id);
    childIds.set(folder.parentId, siblings);
  }
  const height = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 1;
    seen.add(id);
    let tallest = 1;
    for (const childId of childIds.get(id) ?? []) {
      tallest = Math.max(tallest, 1 + height(childId, seen));
    }
    return tallest;
  };
  return height(folderId, new Set());
}

async function nextSortOrder(companyId: string, parentId: string | null): Promise<number> {
  const siblings = await AppDataSource.getRepository(RoutineFolder).find({
    where: { companyId, parentId: parentId === null ? IsNull() : parentId },
    order: { sortOrder: "DESC" },
    take: 1,
  });
  return siblings.length ? siblings[0].sortOrder + 1 : 0;
}

export async function createFolder(
  companyId: string,
  input: { name: string; parentId?: string | null },
): Promise<RoutineFolder> {
  const name = cleanFolderName(input.name);
  if (!name) throw new RoutineFolderError("A folder needs a name.");
  const parentId = input.parentId ?? null;
  if (parentId !== null) {
    const parentDepth = await depthOf(companyId, parentId);
    if (parentDepth >= MAX_FOLDER_DEPTH) {
      throw new RoutineFolderError(`Folders can only nest ${MAX_FOLDER_DEPTH} levels deep.`);
    }
  }
  const repo = AppDataSource.getRepository(RoutineFolder);
  const duplicate = await repo
    .createQueryBuilder("f")
    .where("f.companyId = :companyId", { companyId })
    .andWhere("LOWER(f.name) = LOWER(:name)", { name })
    .andWhere(parentId === null ? "f.parentId IS NULL" : "f.parentId = :parentId", { parentId })
    .getOne();
  if (duplicate) throw new RoutineFolderError(`A folder named "${name}" is already here.`);

  return repo.save(
    repo.create({
      companyId,
      name,
      slug: await uniqueFolderSlug(companyId, toSlug(name)),
      parentId,
      sortOrder: await nextSortOrder(companyId, parentId),
    }),
  );
}

export async function updateFolder(
  companyId: string,
  folderId: string,
  updates: { name?: string; parentId?: string | null; sortOrder?: number },
): Promise<RoutineFolder | null> {
  const repo = AppDataSource.getRepository(RoutineFolder);
  const folder = await repo.findOneBy({ id: folderId, companyId });
  if (!folder) return null;

  /** The requested destination, or undefined when this edit is not a move. */
  let movedTo: string | null | undefined;

  if (updates.parentId !== undefined) {
    const parentId = updates.parentId;
    if (parentId === folder.id) {
      throw new RoutineFolderError("A folder cannot be inside itself.");
    }
    if (parentId !== null) {
      // Moving a folder under its own descendant would orphan the whole
      // subtree from the root — the classic tree-move cycle.
      const subtree = await folderSubtreeIds(companyId, folder.id);
      if (subtree.includes(parentId)) {
        throw new RoutineFolderError("A folder cannot be moved inside itself.");
      }
      const parentDepth = await depthOf(companyId, parentId);
      const height = await subtreeHeight(companyId, folder.id);
      if (parentDepth + height > MAX_FOLDER_DEPTH) {
        throw new RoutineFolderError(`Folders can only nest ${MAX_FOLDER_DEPTH} levels deep.`);
      }
    }
    movedTo = parentId;
  }

  let nextName = folder.name;
  if (updates.name !== undefined) {
    nextName = cleanFolderName(updates.name);
    if (!nextName) throw new RoutineFolderError("A folder needs a name.");
  }

  // One clash check against the *destination*, covering a rename, a move, and a
  // rename-while-moving alike. Checking it inside the rename branch alone let a
  // plain move land a folder beside a same-named sibling — the create path
  // refuses that, so the edit path must too.
  const destinationParentId = movedTo === undefined ? folder.parentId : movedTo;
  if (updates.name !== undefined || movedTo !== undefined) {
    const duplicate = await repo
      .createQueryBuilder("f")
      .where("f.companyId = :companyId", { companyId })
      .andWhere("LOWER(f.name) = LOWER(:name)", { name: nextName })
      .andWhere("f.id != :id", { id: folder.id })
      .andWhere(
        destinationParentId === null ? "f.parentId IS NULL" : "f.parentId = :destinationParentId",
        { destinationParentId },
      )
      .getOne();
    if (duplicate) throw new RoutineFolderError(`A folder named "${nextName}" is already here.`);
  }

  if (movedTo !== undefined && movedTo !== folder.parentId) {
    folder.parentId = movedTo;
    folder.sortOrder = await nextSortOrder(companyId, movedTo);
  }
  // The slug is deliberately left alone on rename, like every other slug in
  // this codebase — a bookmarked `?folder=<slug>` keeps working.
  folder.name = nextName;

  if (updates.sortOrder !== undefined) folder.sortOrder = updates.sortOrder;

  if (movedTo === undefined) return repo.save(folder);

  // Every check above read the tree before this write, so two moves racing each
  // other can each validate against a pre-move shape and still combine into a
  // cycle — A under B while B goes under A. Both folders then vanish from
  // `listFoldersWithMeta`, which only walks down from the roots, and the UI
  // offers no way back. Re-walking the ancestor chain *after* the write, inside
  // the transaction, turns that race into a rolled-back 400 for whichever move
  // lost. Portable across sqlite and Postgres, unlike a row lock.
  return AppDataSource.transaction(async (manager) => {
    const scoped = manager.getRepository(RoutineFolder);
    const saved = await scoped.save(folder);
    const seen = new Set<string>([saved.id]);
    let cursor = saved.parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new RoutineFolderError(
          "Another change moved that folder at the same time. Try again.",
        );
      }
      seen.add(cursor);
      const parent = await scoped.findOneBy({ id: cursor, companyId });
      if (!parent) break;
      cursor = parent.parentId;
    }
    return saved;
  });
}

/**
 * Delete one folder, promoting everything inside it to the folder's own
 * parent. Deleting a top-level folder therefore unfiles its routines rather
 * than deleting them — the one behaviour a person emptying a filing cabinet
 * would never expect is for the paperwork to go in the bin with it.
 */
export async function deleteFolder(
  companyId: string,
  folderId: string,
): Promise<{ folder: RoutineFolder; movedRoutines: number; movedFolders: number } | null> {
  const repo = AppDataSource.getRepository(RoutineFolder);
  const folder = await repo.findOneBy({ id: folderId, companyId });
  if (!folder) return null;

  const snapshot = { ...folder };
  let movedRoutines = 0;
  let movedFolders = 0;

  await AppDataSource.transaction(async (manager) => {
    const folderRepo = manager.getRepository(RoutineFolder);
    // Read inside the transaction, not before it: a routine filed into this
    // folder between the read and the write would keep a `folderId` pointing at
    // a row that no longer exists, and would vanish from every folder view.
    const children = await folderRepo.findBy({ companyId, parentId: snapshot.id });
    const routines = await manager.getRepository(Routine).findBy({ folderId: snapshot.id });

    // Promoting a child can collide with a folder already sitting at the
    // destination — delete "Root/Child" while both "Root/Child/Reports" and
    // "Root/Reports" exist and two "Reports" land side by side, the exact state
    // createFolder and updateFolder both refuse. Suffix the newcomer instead of
    // failing the delete: losing the folder you asked to delete because of a
    // name two levels down would be the more surprising outcome.
    const taken = new Set(
      (await folderRepo.findBy({ companyId, parentId: destinationOf(snapshot.parentId) }))
        .filter((f) => f.id !== snapshot.id)
        .map((f) => f.name.toLocaleLowerCase("en-US")),
    );
    for (const child of children) {
      let name = child.name;
      let n = 1;
      while (taken.has(name.toLocaleLowerCase("en-US"))) {
        n += 1;
        name = `${child.name} (${n})`;
      }
      taken.add(name.toLocaleLowerCase("en-US"));
      child.name = name;
      child.parentId = snapshot.parentId;
    }
    if (children.length) await folderRepo.save(children);

    // A targeted column update for the routines rather than `save()` on the
    // loaded rows: saving would write back every column that differs at save
    // time, reverting a `nextRunAt` the cron heartbeat advanced in between.
    if (routines.length) {
      await manager
        .getRepository(Routine)
        .update({ id: In(routines.map((r) => r.id)) }, { folderId: snapshot.parentId });
    }
    await folderRepo.delete({ id: snapshot.id, companyId });

    movedRoutines = routines.length;
    movedFolders = children.length;
  });

  // Explicitly, because neither a criteria `update()` nor a criteria `delete()`
  // hands the live-sync subscriber an entity it can resolve a company from —
  // so without this, deleting a folder changed nothing on anybody else's
  // screen until the next unrelated write. See ROADMAP M31.
  emitResourceChange(companyId, "routine");

  return { folder: snapshot, movedRoutines, movedFolders };
}

/** `null` reads as "no parent" in a `findBy`, which is what IsNull() expresses. */
function destinationOf(parentId: string | null) {
  return parentId === null ? IsNull() : parentId;
}

/**
 * Check a folder id supplied for a routine. Returns the folder, or null when
 * `folderId` is null (unfiled). Throws when the id names a folder in another
 * company — the guard that keeps company-scoped folders from leaking across a
 * shared SaaS install.
 */
export async function resolveFolderForCompany(
  companyId: string,
  folderId: string | null,
): Promise<RoutineFolder | null> {
  if (folderId === null) return null;
  const folder = await AppDataSource.getRepository(RoutineFolder).findOneBy({
    id: folderId,
    companyId,
  });
  if (!folder) throw new RoutineFolderError("That folder does not belong to this company");
  return folder;
}

/**
 * Resolve a `"Finance/Month-end"` path, a bare folder name, or a folder id to
 * one folder, creating any segment that doesn't exist yet when `create` is
 * set. This is what the MCP tools accept, so an AI employee can file a routine
 * the way a person would describe it rather than by hunting for a UUID.
 */
export async function resolveFolderPath(
  companyId: string,
  raw: string,
  options: { create?: boolean } = {},
): Promise<RoutineFolder | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (UUID_RE.test(trimmed)) {
    const byId = await AppDataSource.getRepository(RoutineFolder).findOneBy({
      id: trimmed,
      companyId,
    });
    if (byId) return byId;
  }

  const segments = trimmed
    .split(FOLDER_PATH_SEPARATOR)
    .map((segment) => cleanFolderName(segment))
    .filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new RoutineFolderError(`Folders can only nest ${MAX_FOLDER_DEPTH} levels deep.`);
  }

  const repo = AppDataSource.getRepository(RoutineFolder);
  let parentId: string | null = null;
  let current: RoutineFolder | null = null;
  for (const segment of segments) {
    const qb = repo
      .createQueryBuilder("f")
      .where("f.companyId = :companyId", { companyId })
      .andWhere("LOWER(f.name) = LOWER(:name)", { name: segment })
      .andWhere(parentId === null ? "f.parentId IS NULL" : "f.parentId = :parentId", { parentId });
    let match: RoutineFolder | null = await qb.getOne();
    // A single bare segment is also allowed to match a folder anywhere in the
    // tree, so `folder: "Month-end"` works without spelling out its ancestors.
    // Ambiguity is reported rather than resolved: `sortOrder` is only unique
    // among siblings, so picking the first row would have filed the routine in
    // whichever "Reports" the database happened to return — silently, and
    // differently on Postgres than on sqlite.
    if (!match && parentId === null && segments.length === 1) {
      const anywhere = await repo
        .createQueryBuilder("f")
        .where("f.companyId = :companyId", { companyId })
        .andWhere("LOWER(f.name) = LOWER(:name)", { name: segment })
        .getMany();
      if (anywhere.length > 1) {
        const paths = await Promise.all(
          anywhere.map((candidate) => folderPathFor(companyId, candidate.id)),
        );
        throw new RoutineFolderError(
          `"${segment}" matches ${anywhere.length} folders (${paths
            .filter(Boolean)
            .join(", ")}). Give the full path.`,
        );
      }
      match = anywhere[0] ?? null;
    }
    if (!match) {
      if (!options.create) throw new RoutineFolderError(`No folder named "${segment}".`);
      match = await createFolder(companyId, { name: segment, parentId });
    }
    current = match;
    parentId = match.id;
  }
  return current;
}

/** Slash-joined ancestor names, this folder last. Used in MCP responses. */
export async function folderPathFor(
  companyId: string,
  folderId: string | null,
): Promise<string | null> {
  if (!folderId) return null;
  const meta = await listFoldersWithMeta(companyId);
  return meta.find((folder) => folder.id === folderId)?.path ?? null;
}
