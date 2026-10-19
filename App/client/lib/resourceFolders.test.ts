import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Resource, ResourceFolder } from "./api.js";
import {
  deleteFolderMessage,
  folderOptions,
  folderTrail,
  RESOURCE_DRAG_TYPE,
  readResourceDrag,
  resourceFolderHref,
  resourceFolderView,
  resourcesInView,
  subfoldersInView,
  UNFILED_FOLDER_PARAM,
} from "./resourceFolders.js";

function folder(
  id: string,
  name: string,
  parentId: string | null,
  extra: Partial<ResourceFolder> = {},
): ResourceFolder {
  return {
    id,
    companyId: "acme",
    name,
    slug: name.toLowerCase(),
    parentId,
    sortOrder: 0,
    path: name,
    depth: 1,
    resourceCount: 0,
    totalResourceCount: 0,
    createdAt: "2026-10-19T00:00:00.000Z",
    updatedAt: "2026-10-19T00:00:00.000Z",
    ...extra,
  };
}

/** Research › Competitors › Pricing, plus Playbooks. */
const research = folder("r", "Research", null, { path: "Research" });
const competitors = folder("c", "Competitors", "r", { path: "Research/Competitors", depth: 2 });
const pricing = folder("p", "Pricing", "c", { path: "Research/Competitors/Pricing", depth: 3 });
const playbooks = folder("b", "Playbooks", null, { path: "Playbooks" });
const FOLDERS = [research, competitors, pricing, playbooks];

function resource(slug: string, folderId: string | null): Resource {
  return { id: slug, slug, title: slug, folderId } as Resource;
}

const ITEMS = [
  resource("in-research", "r"),
  resource("in-competitors", "c"),
  resource("in-pricing", "p"),
  resource("in-playbooks", "b"),
  resource("unfiled", null),
];

const slugs = (rows: Resource[]) => rows.map((row) => row.slug);

describe("resourceFolderView", () => {
  test("reads everything, the Unfiled pile, a folder by slug, or a stale link", () => {
    assert.deepEqual(resourceFolderView(null, FOLDERS), { kind: "all" });
    assert.deepEqual(resourceFolderView("", FOLDERS), { kind: "all" });
    assert.deepEqual(resourceFolderView(UNFILED_FOLDER_PARAM, FOLDERS), { kind: "unfiled" });
    assert.deepEqual(resourceFolderView("competitors", FOLDERS), {
      kind: "folder",
      folder: competitors,
    });
    assert.deepEqual(resourceFolderView("gone", FOLDERS), { kind: "missing", slug: "gone" });
  });
});

describe("resourceFolderHref", () => {
  test("addresses a folder by its slug, and Unfiled by its own word", () => {
    assert.equal(resourceFolderHref("acme", null), "/c/acme/resources");
    assert.equal(resourceFolderHref("acme", "unfiled"), "/c/acme/resources?folder=unfiled");
    assert.equal(
      resourceFolderHref("acme", { slug: "q3 & q4" }),
      "/c/acme/resources?folder=q3%20%26%20q4",
    );
  });
});

describe("resourcesInView", () => {
  test("All resources lists everything, filed or not", () => {
    assert.deepEqual(
      slugs(resourcesInView(ITEMS, FOLDERS, { kind: "all" }, { searching: false })),
      slugs(ITEMS),
    );
  });

  test("a folder lists only what is filed directly in it, like a directory", () => {
    const view = resourceFolderView("research", FOLDERS);
    assert.deepEqual(slugs(resourcesInView(ITEMS, FOLDERS, view, { searching: false })), [
      "in-research",
    ]);
  });

  test("searching a folder reaches everything beneath it, and nothing beside it", () => {
    const view = resourceFolderView("research", FOLDERS);
    assert.deepEqual(slugs(resourcesInView(ITEMS, FOLDERS, view, { searching: true })), [
      "in-research",
      "in-competitors",
      "in-pricing",
    ]);
  });

  test("Unfiled lists what is in no folder, and a stale link lists nothing", () => {
    assert.deepEqual(
      slugs(resourcesInView(ITEMS, FOLDERS, { kind: "unfiled" }, { searching: true })),
      ["unfiled"],
    );
    assert.deepEqual(
      resourcesInView(ITEMS, FOLDERS, { kind: "missing", slug: "gone" }, { searching: false }),
      [],
    );
  });
});

describe("subfoldersInView", () => {
  test("shows the top level on All resources and a folder's children inside it", () => {
    assert.deepEqual(
      subfoldersInView(FOLDERS, { kind: "all" }).map((f) => f.name),
      ["Research", "Playbooks"],
    );
    assert.deepEqual(
      subfoldersInView(FOLDERS, resourceFolderView("research", FOLDERS)).map((f) => f.name),
      ["Competitors"],
    );
    assert.deepEqual(subfoldersInView(FOLDERS, resourceFolderView("pricing", FOLDERS)), []);
    assert.deepEqual(subfoldersInView(FOLDERS, { kind: "unfiled" }), []);
  });
});

describe("folderTrail", () => {
  test("walks from the top down to the folder itself", () => {
    assert.deepEqual(
      folderTrail(FOLDERS, "p").map((f) => f.name),
      ["Research", "Competitors", "Pricing"],
    );
    assert.deepEqual(folderTrail(FOLDERS, "missing"), []);
  });

  test("stops at a cycle in a malformed tree instead of looping", () => {
    const a = folder("a", "A", "b");
    const b = folder("b", "B", "a");
    assert.deepEqual(
      folderTrail([a, b], "a").map((f) => f.name),
      ["B", "A"],
    );
  });
});

describe("folderOptions", () => {
  test("lists folders in tree order with their full paths", () => {
    assert.deepEqual(folderOptions(FOLDERS), [
      { id: "r", label: "Research" },
      { id: "c", label: "Research/Competitors" },
      { id: "p", label: "Research/Competitors/Pricing" },
      { id: "b", label: "Playbooks" },
    ]);
  });
});

describe("readResourceDrag", () => {
  const transfer = (payload: string) => ({
    getData: (type: string) => (type === RESOURCE_DRAG_TYPE ? payload : ""),
  });

  test("reads what a Resource card carries", () => {
    assert.deepEqual(readResourceDrag(transfer(JSON.stringify({ slug: "guide", folderId: "r" }))), {
      slug: "guide",
      folderId: "r",
    });
    assert.deepEqual(readResourceDrag(transfer(JSON.stringify({ slug: "guide", folderId: null }))), {
      slug: "guide",
      folderId: null,
    });
  });

  test("ignores any other drag — a file, text, or something malformed", () => {
    for (const payload of ["", "not json", "null", "[]", JSON.stringify({ folderId: "r" })]) {
      assert.equal(readResourceDrag(transfer(payload)), null, payload);
    }
  });
});

describe("deleteFolderMessage", () => {
  test("says where the contents go, and that nothing is deleted", () => {
    assert.equal(
      deleteFolderMessage({ ...research, resourceCount: 2 }, FOLDERS),
      "2 resources and 1 subfolder will move to Unfiled. Nothing is deleted.",
    );
    assert.equal(
      deleteFolderMessage({ ...competitors, resourceCount: 1 }, FOLDERS),
      "1 resource and 1 subfolder will move to “Research”. Nothing is deleted.",
    );
  });

  test("an empty folder needs no confirmation", () => {
    assert.equal(deleteFolderMessage(playbooks, FOLDERS), null);
  });
});
