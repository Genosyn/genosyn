import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Tag } from "../db/entities/Tag.js";
import { TagAssignment } from "../db/entities/TagAssignment.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { tagsRouter } from "./tags.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;
let tag: Tag;
let unusedTag: Tag;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", tagsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  tag = await insert(Tag, {
    companyId: company.id,
    name: "Marketing",
    normalizedName: "marketing",
    color: "indigo",
  });
  unusedTag = await insert(Tag, {
    companyId: company.id,
    name: "Archive",
    normalizedName: "archive",
    color: "slate",
  });
  // Three assignments across two resource types: the count is over the whole
  // catalog, not one surface.
  await insert(TagAssignment, {
    tagId: tag.id,
    resourceType: "note",
    resourceId: testId("note"),
  });
  await insert(TagAssignment, {
    tagId: tag.id,
    resourceType: "note",
    resourceId: testId("note"),
  });
  await insert(TagAssignment, {
    tagId: tag.id,
    resourceType: "project",
    resourceId: testId("project"),
  });
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

type TagBody = {
  id: string;
  name: string;
  color: string | null;
  normalizedName: string;
  usageCount?: number;
};

describe("PATCH /api/companies/:cid/tags/:tagId", () => {
  test("carries the usage count so the renamed row stays complete", async () => {
    const res = await call<TagBody>("PATCH", `/tags/${tag.id}`, { name: "Growth" });

    assert.equal(res.status, 200);
    assert.equal(res.body.name, "Growth");
    // The settings list writes this row straight back over the one it just
    // edited. A response without the key rendered "0 resources" for a tag with
    // three, because the client's `?? 0` fallback turns the gap into a number.
    assert.ok(
      Object.hasOwn(res.body, "usageCount"),
      "PATCH must return usageCount, not a bare Tag row",
    );
    assert.equal(res.body.usageCount, 3);
  });

  test("carries the usage count on a color-only edit", async () => {
    const res = await call<TagBody>("PATCH", `/tags/${tag.id}`, { color: "violet" });

    assert.equal(res.status, 200);
    assert.equal(res.body.color, "violet");
    assert.equal(res.body.name, "Marketing");
    assert.equal(res.body.usageCount, 3);
  });

  test("reports zero for a tag nothing is attached to", async () => {
    const res = await call<TagBody>("PATCH", `/tags/${unusedTag.id}`, { name: "Retired" });

    assert.equal(res.status, 200);
    assert.equal(res.body.usageCount, 0);
  });

  test("returns the same shape the list endpoint does", async () => {
    const patched = await call<TagBody>("PATCH", `/tags/${tag.id}`, { name: "Growth" });
    const listed = await call<TagBody[]>("GET", "/tags");
    const row = listed.body.find((item) => item.id === tag.id);

    assert.ok(row, "renamed tag should still be listed");
    assert.deepEqual(Object.keys(patched.body).sort(), Object.keys(row).sort());
    assert.deepEqual(patched.body, row);
  });

  test("404s for a tag in another company without touching the response shape", async () => {
    const other = await insert(Tag, {
      companyId: testId("co"),
      name: "Theirs",
      normalizedName: "theirs",
      color: "pink",
    });

    const res = await call("PATCH", `/tags/${other.id}`, { name: "Mine" });

    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "Tag not found" });
  });

  test("409s when the new name collides with an existing tag", async () => {
    const res = await call("PATCH", `/tags/${tag.id}`, { name: "archive" });

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'The tag "Archive" already exists.');
  });
});
