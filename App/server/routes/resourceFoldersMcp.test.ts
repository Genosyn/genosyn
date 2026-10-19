import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import { Resource } from "../db/entities/Resource.js";
import { ResourceFolder } from "../db/entities/ResourceFolder.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { companyDir } from "../services/paths.js";
import { createResourceFolder } from "../services/resourceFolders.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Resource folders through an AI Employee's tools: `list_resources` browses a
 * folder, `create_resource` and `update_resource` file by path (making missing
 * folders on the way, as Routine folders do), and every Resource an employee
 * reads says which folder it is in. Markdown bodies get plain-text previews.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let ada: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  company = await insert(Company, {
    name: "Acme Library",
    slug: `resource-folders-mcp-${randomUUID()}`,
    ownerId: "owner-1",
  });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Researcher",
    soulBody: "",
  });
  token = issueMcpToken(ada.id, company.id, { authority: "employee" });
});

afterEach(async () => {
  if (company?.slug) {
    await fs.promises.rm(companyDir(company.slug), { recursive: true, force: true });
  }
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

type ToolResource = { slug: string; folder: string | null; summary: string; title: string };

async function tool<T = Record<string, unknown>>(
  name: string,
  body: unknown = {},
): Promise<{ status: number; body: T & { error?: string } }> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${name}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T & { error?: string } };
}

let counter = 0;
async function seed(folderId: string | null): Promise<Resource> {
  counter += 1;
  const resource = await insert(Resource, {
    companyId: company.id,
    title: `Guide ${counter}`,
    slug: `guide-${counter}`,
    sourceKind: "text",
    summary: "",
    bodyText: "The refund policy.",
    tags: "",
    bytes: 18,
    status: "ready",
    errorMessage: "",
    createdById: "owner-1",
    createdByEmployeeId: null,
    folderId,
  });
  await insert(EmployeeResourceGrant, {
    employeeId: ada.id,
    resourceId: resource.id,
    accessLevel: "edit",
  });
  return resource;
}

describe("Resource folders through AI Employee tools", () => {
  test("files a new Markdown Resource by path, making the missing folders", async () => {
    const created = await tool<{ resource: ToolResource }>("create_resource", {
      sourceKind: "text",
      title: "Battlecard",
      body: "# Acme\n\n**Wins** on price.",
      folder: "Research/Competitors",
    });
    assert.equal(created.status, 200, created.body.error);
    assert.equal(created.body.resource.folder, "Research/Competitors");
    assert.equal(created.body.resource.summary, "Acme Wins on price.");
    const folders = await AppDataSource.getRepository(ResourceFolder).find({
      where: { companyId: company.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      folders.map((f) => f.name),
      ["Research", "Competitors"],
    );
    assert.equal(folders[1].parentId, folders[0].id);

    // A second Resource on the same path reuses the folders, whatever the case.
    const again = await tool<{ resource: ToolResource }>("create_resource", {
      sourceKind: "text",
      title: "Pricing page",
      body: "Notes.",
      folder: "research/competitors",
    });
    assert.equal(again.body.resource.folder, "Research/Competitors");
    assert.equal(await AppDataSource.getRepository(ResourceFolder).count(), 2);
  });

  test("lists one folder and its subfolders, and names every Resource's folder", async () => {
    const research = await createResourceFolder(company.id, { name: "Research" });
    const competitors = await createResourceFolder(company.id, {
      name: "Competitors",
      parentId: research.id,
    });
    const playbooks = await createResourceFolder(company.id, { name: "Playbooks" });
    const top = await seed(research.id);
    const nested = await seed(competitors.id);
    await seed(playbooks.id);
    await seed(null);

    const all = await tool<{ resources: ToolResource[]; total: number }>("list_resources");
    assert.equal(all.body.total, 4);
    const folderOf = new Map(all.body.resources.map((r) => [r.slug, r.folder]));
    assert.equal(folderOf.get(nested.slug), "Research/Competitors");

    const inResearch = await tool<{ resources: ToolResource[]; total: number }>("list_resources", {
      folder: "Research",
    });
    assert.equal(inResearch.body.total, 2);
    assert.deepEqual(
      inResearch.body.resources.map((r) => r.slug).sort(),
      [top.slug, nested.slug].sort(),
    );

    const unknown = await tool("list_resources", { folder: "Nowhere" });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error ?? "", /No folder named "Nowhere"/);

    const read = await tool<{ resource: ToolResource }>("get_resource", {
      resourceSlug: nested.slug,
    });
    assert.equal(read.body.resource.folder, "Research/Competitors");
    const found = await tool<{ resources: ToolResource[] }>("search_resources", {
      query: "refund",
    });
    assert.ok(found.body.resources.some((r) => r.folder === "Research/Competitors"));
  });

  test("moves a Resource by path and unfiles it with an empty path", async () => {
    const resource = await seed(null);
    const moved = await tool<{ resource: ToolResource }>("update_resource", {
      resourceSlug: resource.slug,
      folder: "Archive/2026",
    });
    assert.equal(moved.status, 200, moved.body.error);
    assert.equal(moved.body.resource.folder, "Archive/2026");

    const unfiled = await tool<{ resource: ToolResource }>("update_resource", {
      resourceSlug: resource.slug,
      folder: "",
    });
    assert.equal(unfiled.body.resource.folder, null);
    assert.equal(
      (await AppDataSource.getRepository(Resource).findOneByOrFail({ id: resource.id })).folderId,
      null,
    );
  });

  test("refuses an ambiguous bare folder name rather than guessing", async () => {
    const a = await createResourceFolder(company.id, { name: "Team A" });
    const b = await createResourceFolder(company.id, { name: "Team B" });
    await createResourceFolder(company.id, { name: "Reports", parentId: a.id });
    await createResourceFolder(company.id, { name: "Reports", parentId: b.id });
    const resource = await seed(null);
    const refused = await tool("update_resource", {
      resourceSlug: resource.slug,
      folder: "Reports",
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? "", /matches 2 folders .*Give the full path/);
    const filed = await tool<{ resource: ToolResource }>("update_resource", {
      resourceSlug: resource.slug,
      folder: "Team B/Reports",
    });
    assert.equal(filed.body.resource.folder, "Team B/Reports");
  });

  test("refuses a path deeper than folders may nest, before anything is created", async () => {
    const refused = await tool("create_resource", {
      sourceKind: "text",
      title: "Deep",
      body: "x",
      folder: "a/b/c/d/e/f",
    });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error ?? "", /nest 5 levels/);
    assert.equal(await AppDataSource.getRepository(Resource).count(), 0);
    assert.equal(await AppDataSource.getRepository(ResourceFolder).count(), 0);
  });
});
