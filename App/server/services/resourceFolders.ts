import { In, IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Resource } from "../db/entities/Resource.js";
import { ResourceFolder } from "../db/entities/ResourceFolder.js";
import { toSlug } from "../lib/slug.js";
import { UUID_RE } from "./bases.js";
import { emitResourceChange } from "./resourceEvents.js";
import { cleanFolderName, FOLDER_PATH_SEPARATOR, MAX_FOLDER_DEPTH } from "./routineFolders.js";

/**
 * Resource folders — the files-and-folders tree of the Resources library. The
 * HTTP routes, the MCP tools, and every Resource write path go through here, so
 * one set of rules holds wherever a folder is made or a Resource is filed.
 *
 * The rules are Routine folders' (`services/routineFolders.ts`), for the same
 * reasons: a cycle would make the tree recurse forever, an unbounded depth
 * makes it unreadable, two same-named siblings make a path ambiguous, and
 * deleting a folder must never delete what was filed in it.
 */

export const RESOURCE_FOLDER_MAX_DEPTH = MAX_FOLDER_DEPTH;

/**
 * Slugs a folder may never take, because the Resources page already spends
 * them on `?folder=` values that are not folders: `unfiled` is the view of
 * everything in no folder at all.
 */
const RESERVED_FOLDER_SLUGS = new Set(["unfiled"]);

export class ResourceFolderError extends Error {}

/** A folder plus what the sidebar and the folder page need to render it. */
export type ResourceFolderWithMeta = ResourceFolder & {
  /** Resources filed directly in this folder. */
  resourceCount: number;
  /** Resources in this folder and everything beneath it. */
  totalResourceCount: number;
  /** Slash-joined ancestor names, this folder last. */
  path: string;
  /** 1 for a top-level folder. */
  depth: number;
};

export async function listResourceFolders(companyId: string): Promise<ResourceFolder[]> {
  return AppDataSource.getRepository(ResourceFolder).find({
    where: { companyId },
    order: { sortOrder: "ASC", name: "ASC" },
  });
}

/** parentId → child ids. A parent that no longer resolves files its children at the top. */
function childIdsByParent(folders: ResourceFolder[]): Map<string | null, string[]> {
  const present = new Set(folders.map((folder) => folder.id));
  const out = new Map<string | null, string[]>();
  for (const folder of folders) {
    const parentId = folder.parentId && present.has(folder.parentId) ? folder.parentId : null;
    const siblings = out.get(parentId) ?? [];
    siblings.push(folder.id);
    out.set(parentId, siblings);
  }
  return out;
}

/** folderId → number of Resources filed directly in it. */
async function resourceCountsByFolder(companyId: string): Promise<Map<string, number>> {
  const rows = await AppDataSource.getRepository(Resource)
    .createQueryBuilder("r")
    .select("r.folderId", "folderId")
    .addSelect("COUNT(*)", "count")
    .where("r.companyId = :companyId", { companyId })
    .andWhere("r.folderId IS NOT NULL")
    .groupBy("r.folderId")
    .getRawMany<{ folderId: string; count: number | string }>();
  return new Map(rows.map((row) => [row.folderId, Number(row.count)]));
}

/**
 * Every folder in the company with its counts, path, and depth, flat and in
 * sibling order — the sidebar indents it and the folder page looks rows up by
 * id or slug, so neither has to re-flatten a nested payload.
 */
export async function listResourceFoldersWithMeta(
  companyId: string,
): Promise<ResourceFolderWithMeta[]> {
  const folders = await listResourceFolders(companyId);
  if (folders.length === 0) return [];
  const direct = await resourceCountsByFolder(companyId);
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const childIds = childIdsByParent(folders);
  const meta = new Map<string, ResourceFolderWithMeta>();
  const walk = (id: string, depth: number, prefix: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const folder = byId.get(id)!;
    const path = prefix ? `${prefix}${FOLDER_PATH_SEPARATOR}${folder.name}` : folder.name;
    const resourceCount = direct.get(id) ?? 0;
    let total = resourceCount;
    for (const childId of childIds.get(id) ?? []) total += walk(childId, depth + 1, path, seen);
    meta.set(id, Object.assign(folder, { resourceCount, totalResourceCount: total, path, depth }));
    return total;
  };
  const seen = new Set<string>();
  for (const rootId of childIds.get(null) ?? []) walk(rootId, 1, "", seen);
  return folders.map((folder) => meta.get(folder.id)).filter((row): row is ResourceFolderWithMeta => !!row);
}

/** How many Resources in this company are not filed in any folder. */
export async function unfiledResourceCount(companyId: string): Promise<number> {
  return AppDataSource.getRepository(Resource).countBy({ companyId, folderId: IsNull() });
}

/** folderId → its slash-joined path, for labelling Resources in a list. */
export async function resourceFolderPaths(companyId: string): Promise<Map<string, string>> {
  const folders = await listResourceFoldersWithMeta(companyId);
  return new Map(folders.map((folder) => [folder.id, folder.path]));
}

/** The folder plus every folder beneath it, ids only. */
export async function resourceFolderSubtreeIds(
  companyId: string,
  folderId: string,
): Promise<string[]> {
  const childIds = childIdsByParent(await listResourceFolders(companyId));
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

async function uniqueFolderSlug(companyId: string, base: string): Promise<string> {
  const repo = AppDataSource.getRepository(ResourceFolder);
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
    if (seen.has(cursor)) throw new ResourceFolderError("That folder tree contains a cycle.");
    seen.add(cursor);
    const row = await AppDataSource.getRepository(ResourceFolder).findOneBy({
      id: cursor,
      companyId,
    });
    if (!row) throw new ResourceFolderError("Folder not found");
    depth += 1;
    cursor = row.parentId;
  }
  return depth;
}

/** How deep the subtree under `folderId` runs. 1 = no children. */
async function subtreeHeight(companyId: string, folderId: string): Promise<number> {
  const childIds = childIdsByParent(await listResourceFolders(companyId));
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
  const siblings = await AppDataSource.getRepository(ResourceFolder).find({
    where: { companyId, parentId: parentId === null ? IsNull() : parentId },
    order: { sortOrder: "DESC" },
    take: 1,
  });
  return siblings.length ? siblings[0].sortOrder + 1 : 0;
}

async function siblingNamed(
  companyId: string,
  parentId: string | null,
  name: string,
  exceptId?: string,
): Promise<ResourceFolder | null> {
  const qb = AppDataSource.getRepository(ResourceFolder)
    .createQueryBuilder("f")
    .where("f.companyId = :companyId", { companyId })
    .andWhere("LOWER(f.name) = LOWER(:name)", { name })
    .andWhere(parentId === null ? "f.parentId IS NULL" : "f.parentId = :parentId", { parentId });
  if (exceptId) qb.andWhere("f.id != :exceptId", { exceptId });
  return qb.getOne();
}

export async function createResourceFolder(
  companyId: string,
  input: { name: string; parentId?: string | null },
): Promise<ResourceFolder> {
  const name = cleanFolderName(input.name);
  if (!name) throw new ResourceFolderError("A folder needs a name.");
  const parentId = input.parentId ?? null;
  if (parentId !== null && (await depthOf(companyId, parentId)) >= RESOURCE_FOLDER_MAX_DEPTH) {
    throw new ResourceFolderError(
      `Folders can only nest ${RESOURCE_FOLDER_MAX_DEPTH} levels deep.`,
    );
  }
  if (await siblingNamed(companyId, parentId, name)) {
    throw new ResourceFolderError(`A folder named "${name}" is already here.`);
  }
  const repo = AppDataSource.getRepository(ResourceFolder);
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

export async function updateResourceFolder(
  companyId: string,
  folderId: string,
  updates: { name?: string; parentId?: string | null; sortOrder?: number },
): Promise<ResourceFolder | null> {
  const repo = AppDataSource.getRepository(ResourceFolder);
  const folder = await repo.findOneBy({ id: folderId, companyId });
  if (!folder) return null;

  /** The requested destination, or undefined when this edit is not a move. */
  let movedTo: string | null | undefined;
  if (updates.parentId !== undefined) {
    const parentId = updates.parentId;
    if (parentId === folder.id) throw new ResourceFolderError("A folder cannot be inside itself.");
    if (parentId !== null) {
      // Moving a folder under its own descendant would cut the whole subtree
      // off from the root — the classic tree-move cycle.
      if ((await resourceFolderSubtreeIds(companyId, folder.id)).includes(parentId)) {
        throw new ResourceFolderError("A folder cannot be moved inside itself.");
      }
      const parentDepth = await depthOf(companyId, parentId);
      if (parentDepth + (await subtreeHeight(companyId, folder.id)) > RESOURCE_FOLDER_MAX_DEPTH) {
        throw new ResourceFolderError(
          `Folders can only nest ${RESOURCE_FOLDER_MAX_DEPTH} levels deep.`,
        );
      }
    }
    movedTo = parentId;
  }

  let nextName = folder.name;
  if (updates.name !== undefined) {
    nextName = cleanFolderName(updates.name);
    if (!nextName) throw new ResourceFolderError("A folder needs a name.");
  }
  // One clash check against the destination covers a rename, a move, and both.
  const destinationParentId = movedTo === undefined ? folder.parentId : movedTo;
  if (
    (updates.name !== undefined || movedTo !== undefined) &&
    (await siblingNamed(companyId, destinationParentId, nextName, folder.id))
  ) {
    throw new ResourceFolderError(`A folder named "${nextName}" is already here.`);
  }

  if (movedTo !== undefined && movedTo !== folder.parentId) {
    folder.parentId = movedTo;
    folder.sortOrder = await nextSortOrder(companyId, movedTo);
  }
  // The slug stays on rename, so a bookmarked `?folder=<slug>` keeps working.
  folder.name = nextName;
  if (updates.sortOrder !== undefined) folder.sortOrder = updates.sortOrder;
  if (movedTo === undefined) return repo.save(folder);

  // Two moves racing each other can each validate against the pre-move tree
  // and still combine into a cycle. Re-walking the ancestors after the write,
  // inside the transaction, turns that race into a rolled-back refusal.
  return AppDataSource.transaction(async (manager) => {
    const scoped = manager.getRepository(ResourceFolder);
    const saved = await scoped.save(folder);
    const seen = new Set<string>([saved.id]);
    let cursor = saved.parentId;
    while (cursor) {
      if (seen.has(cursor)) {
        throw new ResourceFolderError("Another change moved that folder at the same time. Try again.");
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
 * Delete one folder, moving everything inside it — Resources and subfolders —
 * up to the folder's own parent (Unfiled for a top-level folder). Nothing
 * filed is ever deleted with its folder.
 */
export async function deleteResourceFolder(
  companyId: string,
  folderId: string,
): Promise<{ folder: ResourceFolder; movedResources: number; movedFolders: number } | null> {
  const repo = AppDataSource.getRepository(ResourceFolder);
  const folder = await repo.findOneBy({ id: folderId, companyId });
  if (!folder) return null;
  const snapshot = { ...folder };
  let movedResources = 0;
  let movedFolders = 0;

  await AppDataSource.transaction(async (manager) => {
    const folders = manager.getRepository(ResourceFolder);
    // Read inside the transaction: a Resource filed here between a read and
    // the delete would otherwise point at a folder that no longer exists.
    const children = await folders.findBy({ companyId, parentId: snapshot.id });
    const resources = await manager
      .getRepository(Resource)
      .find({ where: { companyId, folderId: snapshot.id }, select: { id: true } });

    // A promoted child can collide with a folder already at the destination.
    // Suffix the newcomer rather than refuse the delete.
    const taken = new Set(
      (
        await folders.findBy({
          companyId,
          parentId: snapshot.parentId === null ? IsNull() : snapshot.parentId,
        })
      )
        .filter((row) => row.id !== snapshot.id)
        .map((row) => row.name.toLocaleLowerCase("en-US")),
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
    if (children.length) await folders.save(children);
    // A targeted column update, so a body saved meanwhile is never written back.
    if (resources.length) {
      await manager
        .getRepository(Resource)
        .update({ id: In(resources.map((row) => row.id)) }, { folderId: snapshot.parentId });
    }
    await folders.delete({ id: snapshot.id, companyId });
    movedResources = resources.length;
    movedFolders = children.length;
  });

  // Criteria updates and deletes give the live-sync subscriber no entity to
  // resolve a company from, so announce the change here.
  emitResourceChange(companyId, "resource");
  return { folder: snapshot, movedResources, movedFolders };
}

/**
 * Check a folder id supplied for a Resource. Null means unfiled. A folder in
 * another company is refused rather than ignored, so a shared install can never
 * file one company's Resource into another's tree.
 */
export async function resolveResourceFolderForCompany(
  companyId: string,
  folderId: string | null,
): Promise<ResourceFolder | null> {
  if (folderId === null) return null;
  const folder = await AppDataSource.getRepository(ResourceFolder).findOneBy({
    id: folderId,
    companyId,
  });
  if (!folder) throw new ResourceFolderError("That folder does not belong to this company");
  return folder;
}

/**
 * Resolve a `"Research/Competitors"` path, a bare folder name, or a folder id
 * to one folder — what the MCP tools accept, so an AI Employee files a Resource
 * the way a person would describe the place. With `create`, missing segments
 * are made on the way down.
 */
export async function resolveResourceFolderPath(
  companyId: string,
  raw: string,
  options: { create?: boolean } = {},
): Promise<ResourceFolder | null> {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (UUID_RE.test(trimmed)) {
    const byId = await AppDataSource.getRepository(ResourceFolder).findOneBy({
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
  if (segments.length > RESOURCE_FOLDER_MAX_DEPTH) {
    throw new ResourceFolderError(
      `Folders can only nest ${RESOURCE_FOLDER_MAX_DEPTH} levels deep.`,
    );
  }

  const repo = AppDataSource.getRepository(ResourceFolder);
  let parentId: string | null = null;
  let current: ResourceFolder | null = null;
  for (const segment of segments) {
    let match: ResourceFolder | null = await siblingNamed(companyId, parentId, segment);
    // A single bare name may match a folder anywhere in the tree. Ambiguity is
    // reported, never resolved by whichever row the database returns first.
    if (!match && parentId === null && segments.length === 1) {
      const anywhere = await repo
        .createQueryBuilder("f")
        .where("f.companyId = :companyId", { companyId })
        .andWhere("LOWER(f.name) = LOWER(:name)", { name: segment })
        .getMany();
      if (anywhere.length > 1) {
        const paths = await resourceFolderPaths(companyId);
        throw new ResourceFolderError(
          `"${segment}" matches ${anywhere.length} folders (${anywhere
            .map((candidate) => paths.get(candidate.id))
            .filter(Boolean)
            .join(", ")}). Give the full path.`,
        );
      }
      match = anywhere[0] ?? null;
    }
    if (!match) {
      if (!options.create) throw new ResourceFolderError(`No folder named "${segment}".`);
      match = await createResourceFolder(companyId, { name: segment, parentId });
    }
    current = match;
    parentId = match.id;
  }
  return current;
}
