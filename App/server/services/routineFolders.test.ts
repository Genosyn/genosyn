import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { RoutineFolder } from "../db/entities/RoutineFolder.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import {
  createFolder,
  deleteFolder,
  folderPathFor,
  listFoldersWithMeta,
  MAX_FOLDER_DEPTH,
  resolveFolderForCompany,
  resolveFolderPath,
  RoutineFolderError,
  unfiledRoutineCount,
  updateFolder,
} from "./routineFolders.js";

/**
 * The folder tree's invariants, tested at the service rather than the HTTP
 * boundary: the router, the MCP tool handlers, and the routine write paths all
 * go through these functions, so this is the one place that guarantees a cycle
 * can't be created or a delete can't take routines with it.
 */

let companyId: string;
let employeeId: string;

before(initTestDb);
after(closeTestDb);

beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Ada",
    slug: "ada",
    role: "Analyst",
    soulBody: "",
  });
  employeeId = employee.id;
});

async function addRoutine(name: string, folderId: string | null): Promise<Routine> {
  return insert(Routine, {
    employeeId,
    name,
    slug: name.toLowerCase().replace(/\s+/g, "-"),
    cronExpr: "0 9 * * *",
    enabled: true,
    folderId,
    body: "",
  });
}

describe("createFolder", () => {
  test("nests under a parent and derives a unique company slug", async () => {
    const finance = await createFolder(companyId, { name: "Finance" });
    const nested = await createFolder(companyId, { name: "Weekly", parentId: finance.id });
    const elsewhere = await createFolder(companyId, { name: "Support" });
    const clash = await createFolder(companyId, { name: "Weekly", parentId: elsewhere.id });

    assert.equal(nested.parentId, finance.id);
    assert.equal(nested.slug, "weekly");
    // Slugs are unique per company, not per parent, so the second "Weekly"
    // gets a suffix and both stay addressable as `?folder=<slug>`.
    assert.equal(clash.slug, "weekly-2");
  });

  test("rejects a duplicate name among siblings but allows it elsewhere", async () => {
    const finance = await createFolder(companyId, { name: "Finance" });
    await assert.rejects(
      () => createFolder(companyId, { name: "finance" }),
      RoutineFolderError,
      "a case-insensitive duplicate at the same level is refused",
    );
    // The same name under a different parent is a different place entirely.
    await createFolder(companyId, { name: "Finance", parentId: finance.id });
  });

  test("refuses to nest past the depth limit", async () => {
    let parentId: string | null = null;
    for (let depth = 1; depth <= MAX_FOLDER_DEPTH; depth += 1) {
      const folder: RoutineFolder = await createFolder(companyId, {
        name: `Level ${depth}`,
        parentId,
      });
      parentId = folder.id;
    }
    await assert.rejects(
      () => createFolder(companyId, { name: "Too deep", parentId }),
      RoutineFolderError,
    );
  });

  test("never mints the reserved `unfiled` slug", async () => {
    // The Routines list spends `?folder=unfiled` on the "in no folder" view, so
    // a folder actually named "Unfiled" must not be able to claim that URL.
    const folder = await createFolder(companyId, { name: "Unfiled" });
    assert.equal(folder.name, "Unfiled");
    assert.notEqual(folder.slug, "unfiled");
  });

  test("strips the path separator out of a name", async () => {
    // "Ops/Support" would otherwise render a path that resolveFolderPath reads
    // back as two folders — the name and the tree would disagree.
    const folder = await createFolder(companyId, { name: "Ops/Support" });
    assert.equal(folder.name, "Ops Support");
    assert.equal(await folderPathFor(companyId, folder.id), "Ops Support");
  });

  test("rejects a parent from another company", async () => {
    const foreign = await createFolder(testCompanyId(), { name: "Theirs" });
    await assert.rejects(
      () => createFolder(companyId, { name: "Ours", parentId: foreign.id }),
      RoutineFolderError,
    );
  });
});

describe("updateFolder", () => {
  test("rename keeps the slug so existing links resolve", async () => {
    const folder = await createFolder(companyId, { name: "Finance" });
    const renamed = await updateFolder(companyId, folder.id, { name: "Money" });
    assert.equal(renamed?.name, "Money");
    assert.equal(renamed?.slug, "finance");
  });

  test("refuses to move a folder into itself or its own descendant", async () => {
    const root = await createFolder(companyId, { name: "Root" });
    const child = await createFolder(companyId, { name: "Child", parentId: root.id });
    const grandchild = await createFolder(companyId, { name: "Grandchild", parentId: child.id });

    await assert.rejects(
      () => updateFolder(companyId, root.id, { parentId: root.id }),
      RoutineFolderError,
    );
    await assert.rejects(
      () => updateFolder(companyId, root.id, { parentId: grandchild.id }),
      RoutineFolderError,
      "moving a folder under its own descendant would orphan the subtree",
    );
  });

  test("refuses a move that would push the subtree past the depth limit", async () => {
    // A two-tall subtree cannot go under a parent already at the floor.
    let parentId: string | null = null;
    for (let depth = 1; depth < MAX_FOLDER_DEPTH; depth += 1) {
      const folder: RoutineFolder = await createFolder(companyId, {
        name: `Level ${depth}`,
        parentId,
      });
      parentId = folder.id;
    }
    const tall = await createFolder(companyId, { name: "Tall" });
    await createFolder(companyId, { name: "Taller", parentId: tall.id });

    await assert.rejects(
      () => updateFolder(companyId, tall.id, { parentId }),
      RoutineFolderError,
    );
  });

  test("a plain move cannot land beside a same-named sibling", async () => {
    // The create path refuses a duplicate at one level; a move that dodged the
    // same check produced two "Reports" under one parent.
    const finance = await createFolder(companyId, { name: "Finance" });
    await createFolder(companyId, { name: "Reports", parentId: finance.id });
    const loose = await createFolder(companyId, { name: "Reports" });

    await assert.rejects(
      () => updateFolder(companyId, loose.id, { parentId: finance.id }),
      RoutineFolderError,
    );
  });

  test("returns null for a folder in another company", async () => {
    const foreign = await createFolder(testCompanyId(), { name: "Theirs" });
    assert.equal(await updateFolder(companyId, foreign.id, { name: "Mine" }), null);
  });
});

describe("deleteFolder", () => {
  test("promotes routines and subfolders to the parent instead of deleting them", async () => {
    const root = await createFolder(companyId, { name: "Root" });
    const middle = await createFolder(companyId, { name: "Middle", parentId: root.id });
    const leaf = await createFolder(companyId, { name: "Leaf", parentId: middle.id });
    const routine = await addRoutine("Weekly report", middle.id);

    const result = await deleteFolder(companyId, middle.id);
    assert.deepEqual(
      { moved: result?.movedRoutines, folders: result?.movedFolders },
      { moved: 1, folders: 1 },
    );

    const reloadedLeaf = await AppDataSource.getRepository(RoutineFolder).findOneBy({
      id: leaf.id,
    });
    const reloadedRoutine = await AppDataSource.getRepository(Routine).findOneBy({
      id: routine.id,
    });
    assert.equal(reloadedLeaf?.parentId, root.id);
    assert.equal(reloadedRoutine?.folderId, root.id);
  });

  test("deleting a top-level folder unfiles its routines rather than losing them", async () => {
    const folder = await createFolder(companyId, { name: "Finance" });
    const routine = await addRoutine("Month end", folder.id);

    await deleteFolder(companyId, folder.id);

    const reloaded = await AppDataSource.getRepository(Routine).findOneBy({ id: routine.id });
    assert.equal(reloaded?.folderId, null, "the routine survives, just unfiled");
    assert.equal(await unfiledRoutineCount(companyId), 1);
  });

  test("a promoted child is renamed rather than colliding with a sibling", async () => {
    // Deleting "Root/Child" while both "Root/Child/Reports" and "Root/Reports"
    // exist would otherwise land two "Reports" side by side — the exact state
    // createFolder and updateFolder both refuse.
    const root = await createFolder(companyId, { name: "Root" });
    const child = await createFolder(companyId, { name: "Child", parentId: root.id });
    const nested = await createFolder(companyId, { name: "Reports", parentId: child.id });
    await createFolder(companyId, { name: "Reports", parentId: root.id });

    await deleteFolder(companyId, child.id);

    const meta = await listFoldersWithMeta(companyId);
    const promoted = meta.find((f) => f.id === nested.id);
    assert.equal(promoted?.parentId, root.id);
    assert.equal(promoted?.name, "Reports (2)");
    const underRoot = meta
      .filter((f) => f.parentId === root.id)
      .map((f) => f.name.toLowerCase());
    assert.equal(new Set(underRoot).size, underRoot.length, "sibling names stay unique");
  });

  test("returns null for a folder in another company", async () => {
    const foreign = await createFolder(testCompanyId(), { name: "Theirs" });
    assert.equal(await deleteFolder(companyId, foreign.id), null);
  });
});

describe("listFoldersWithMeta", () => {
  test("resolves path and depth, and rolls subtree counts upward", async () => {
    const finance = await createFolder(companyId, { name: "Finance" });
    const monthEnd = await createFolder(companyId, { name: "Month-end", parentId: finance.id });
    await addRoutine("Close the books", monthEnd.id);
    await addRoutine("Reconcile", monthEnd.id);
    await addRoutine("Daily cash", finance.id);
    await addRoutine("Nothing filed", null);

    const meta = await listFoldersWithMeta(companyId);
    const financeMeta = meta.find((f) => f.id === finance.id)!;
    const monthEndMeta = meta.find((f) => f.id === monthEnd.id)!;

    assert.deepEqual(
      {
        path: financeMeta.path,
        depth: financeMeta.depth,
        direct: financeMeta.routineCount,
        total: financeMeta.totalRoutineCount,
      },
      { path: "Finance", depth: 1, direct: 1, total: 3 },
    );
    assert.deepEqual(
      {
        path: monthEndMeta.path,
        depth: monthEndMeta.depth,
        direct: monthEndMeta.routineCount,
        total: monthEndMeta.totalRoutineCount,
      },
      { path: "Finance/Month-end", depth: 2, direct: 2, total: 2 },
    );
    assert.equal(await unfiledRoutineCount(companyId), 1);
  });

  test("counts only routines whose employee is in this company", async () => {
    const folder = await createFolder(companyId, { name: "Shared name" });
    const otherCompanyId = testCompanyId();
    const stranger = await insert(AIEmployee, {
      companyId: otherCompanyId,
      name: "Grace",
      slug: "grace",
      role: "Analyst",
      soulBody: "",
    });
    // A routine owned by another company's employee that (impossibly, via the
    // API) points at this folder must not inflate its count.
    await insert(Routine, {
      employeeId: stranger.id,
      name: "Theirs",
      slug: "theirs",
      cronExpr: "0 9 * * *",
      enabled: true,
      folderId: folder.id,
      body: "",
    });
    await addRoutine("Ours", folder.id);

    const meta = await listFoldersWithMeta(companyId);
    assert.equal(meta.find((f) => f.id === folder.id)?.totalRoutineCount, 1);
  });

  test("lists nothing for a company with no folders", async () => {
    assert.deepEqual(await listFoldersWithMeta(companyId), []);
  });
});

describe("resolveFolderForCompany", () => {
  test("accepts null, accepts an own folder, rejects a foreign one", async () => {
    const own = await createFolder(companyId, { name: "Ours" });
    const foreign = await createFolder(testCompanyId(), { name: "Theirs" });

    assert.equal(await resolveFolderForCompany(companyId, null), null);
    assert.equal((await resolveFolderForCompany(companyId, own.id))?.id, own.id);
    await assert.rejects(
      () => resolveFolderForCompany(companyId, foreign.id),
      RoutineFolderError,
    );
  });
});

describe("resolveFolderPath", () => {
  test("creates every missing segment of a path", async () => {
    const folder = await resolveFolderPath(companyId, "Finance/Month-end", { create: true });
    assert.equal(await folderPathFor(companyId, folder!.id), "Finance/Month-end");
    assert.equal((await listFoldersWithMeta(companyId)).length, 2);
  });

  test("reuses an existing path instead of creating a duplicate", async () => {
    const first = await resolveFolderPath(companyId, "Finance/Month-end", { create: true });
    const second = await resolveFolderPath(companyId, "finance/month-end", { create: true });
    assert.equal(first!.id, second!.id);
    assert.equal((await listFoldersWithMeta(companyId)).length, 2);
  });

  test("matches a bare name anywhere in the tree", async () => {
    const nested = await resolveFolderPath(companyId, "Finance/Month-end", { create: true });
    const found = await resolveFolderPath(companyId, "Month-end");
    assert.equal(found?.id, nested!.id);
  });

  test("an ambiguous bare name is reported, not guessed", async () => {
    // sortOrder is unique only among siblings, so picking the first row filed
    // the routine in whichever "Reports" the database happened to return.
    await resolveFolderPath(companyId, "Finance/Reports", { create: true });
    await resolveFolderPath(companyId, "Support/Reports", { create: true });

    await assert.rejects(
      () => resolveFolderPath(companyId, "Reports"),
      (err: Error) => {
        assert.ok(err instanceof RoutineFolderError);
        assert.match(err.message, /matches 2 folders/);
        assert.match(err.message, /Finance\/Reports/);
        return true;
      },
    );
  });

  test("resolves a folder id directly", async () => {
    const folder = await createFolder(companyId, { name: "Finance" });
    assert.equal((await resolveFolderPath(companyId, folder.id))?.id, folder.id);
  });

  test("a non-uuid path never reaches the primary-key lookup", async () => {
    // Postgres types `id` as uuid and raises 22P02 — a 500 — when a query
    // compares it to arbitrary text. This must be a clean miss, not a crash.
    await assert.rejects(
      () => resolveFolderPath(companyId, "Finance/Month-end"),
      RoutineFolderError,
    );
    await assert.rejects(() => resolveFolderPath(companyId, "not a uuid"), RoutineFolderError);
  });

  test("refuses to invent a folder when create is not set", async () => {
    await assert.rejects(() => resolveFolderPath(companyId, "Nowhere"), RoutineFolderError);
  });

  test("refuses a path deeper than the limit", async () => {
    const tooDeep = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `L${i}`).join("/");
    await assert.rejects(
      () => resolveFolderPath(companyId, tooDeep, { create: true }),
      RoutineFolderError,
    );
  });

  test("treats an empty string as no folder", async () => {
    assert.equal(await resolveFolderPath(companyId, "   "), null);
  });
});
