import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";
import { PDFDocument } from "pdf-lib";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import {
  EmployeeResourceGrant,
  type ResourceAccessLevel,
} from "../db/entities/EmployeeResourceGrant.js";
import { EmployeeResourceLibraryGrant } from "../db/entities/EmployeeResourceLibraryGrant.js";
import { EmployeeSigningGrant } from "../db/entities/EmployeeSigningGrant.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { Resource } from "../db/entities/Resource.js";
import { TagAssignment } from "../db/entities/TagAssignment.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { deadToolNames } from "../services/agent/tools/grantDead.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { companyDir, ensureDir } from "../services/paths.js";
import {
  RESOURCE_READ_ONLY_ERROR,
  RESOURCE_WRITE_TOOLS,
  setResourceLibraryAccess,
} from "../services/resourceLibraryAccess.js";
import {
  overrideRuntimeSettingsForTests,
  resetRuntimeSettingsCacheForTests,
} from "../services/runtimeSettings.js";
import { replaceResourceTagNames } from "../services/tags.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Resources → AI access at the seam that enforces it.
 *
 * The setting is a ceiling: `read` (read only) refuses every Resource write
 * whatever the per-Resource Share settings say, and `write` (read + write, the
 * default) leaves those Share settings in charge exactly as before. This file
 * proves both halves for every Resource tool, and that a refusal happens before
 * any side effect — no fetch, no bytes on disk, no row, no audit, no Journal.
 */

const READ_TOOLS = ["list_resources", "search_resources", "get_resource", "export_resource"];

/** What a library level is set to in a test. `null` = no row (never touched). */
type LibraryState = "read" | "write" | null | "superuser";

let server: Server;
let baseUrl = "";
let token = "";
let bobToken = "";
let company: Company;
let ada: AIEmployee;
let bob: AIEmployee;

/** A tiny page server so a `url` Resource has something real to fetch. */
let pageServer: http.Server;
let pageUrl = "";
let pageHits = 0;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  pageServer = http.createServer((_req, res) => {
    pageHits += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<html><head><title>Pricing primer</title></head><body><p>Our pricing has three tiers.</p></body></html>",
    );
  });
  await new Promise<void>((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  pageUrl = `http://127.0.0.1:${(pageServer.address() as AddressInfo).port}/primer`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  if (bobToken) revokeMcpToken(bobToken);
  await resetTestDb();
  pageHits = 0;
  // Loopback is a private host; the operator allowlist is the supported way in.
  overrideRuntimeSettingsForTests({ network: { privateHostAllowlist: ["127.0.0.1"] } });
  company = await insert(Company, {
    name: "Acme Library",
    slug: `resource-ai-access-${randomUUID()}`,
    ownerId: "owner-1",
  });
  ada = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Researcher",
    soulBody: "",
  });
  bob = await insert(AIEmployee, {
    companyId: company.id,
    name: "Bob",
    slug: "bob",
    role: "Writer",
    soulBody: "",
  });
  token = issueMcpToken(ada.id, company.id, { authority: "employee" });
  bobToken = issueMcpToken(bob.id, company.id, { authority: "employee" });
});

afterEach(async () => {
  overrideRuntimeSettingsForTests(null);
  resetRuntimeSettingsCacheForTests();
  if (company?.slug) {
    await fs.promises.rm(companyDir(company.slug), { recursive: true, force: true });
  }
});

after(async () => {
  if (token) revokeMcpToken(token);
  if (bobToken) revokeMcpToken(bobToken);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve) => pageServer.close(() => resolve()));
  await closeTestDb();
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T & { error?: string } };

async function aiCall<T = Record<string, unknown>>(
  tool: string,
  body: unknown = {},
  bearer = token,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T & { error?: string },
  };
}

/** Put an employee's library level into a state directly, bypassing the HTTP route. */
async function setLibrary(state: LibraryState, employee: AIEmployee = ada): Promise<void> {
  const repo = AppDataSource.getRepository(EmployeeResourceLibraryGrant);
  await repo.delete({ employeeId: employee.id });
  if (state === null) return;
  await repo.save(
    repo.create({
      companyId: company.id,
      employeeId: employee.id,
      accessLevel: state as "read" | "write",
    }),
  );
}

let resourceCounter = 0;

/** A text Resource, optionally shared with Ada at a given level and Bob at read. */
async function seedResource(
  options: {
    grant?: ResourceAccessLevel | null;
    title?: string;
    bodyText?: string;
    createdByEmployeeId?: string | null;
  } = {},
): Promise<Resource> {
  resourceCounter += 1;
  const title = options.title ?? `Field guide ${resourceCounter}`;
  const resource = await insert(Resource, {
    companyId: company.id,
    title,
    slug: `field-guide-${resourceCounter}`,
    sourceKind: "text",
    summary: "A guide.",
    bodyText: options.bodyText ?? "The refund policy: refunds are granted within thirty days.",
    tags: "",
    bytes: 60,
    status: "ready",
    errorMessage: "",
    createdById: options.createdByEmployeeId ? null : "owner-1",
    createdByEmployeeId: options.createdByEmployeeId ?? null,
  });
  const grant = options.grant === undefined ? "read" : options.grant;
  if (grant !== null) {
    await insert(EmployeeResourceGrant, {
      employeeId: ada.id,
      resourceId: resource.id,
      accessLevel: grant,
    });
  }
  await insert(EmployeeResourceGrant, {
    employeeId: bob.id,
    resourceId: resource.id,
    accessLevel: "read",
  });
  return resource;
}

async function sideEffectCounts() {
  return {
    resources: await AppDataSource.getRepository(Resource).count(),
    grants: await AppDataSource.getRepository(EmployeeResourceGrant).count(),
    audits: await AppDataSource.getRepository(AuditEvent).count({
      where: { actorEmployeeId: ada.id },
    }),
    journal: await AppDataSource.getRepository(JournalEntry).count({
      where: { employeeId: ada.id },
    }),
    tags: await AppDataSource.getRepository(TagAssignment).count(),
  };
}

function resourcesDirFiles(): string[] {
  const dir = path.join(companyDir(company.slug), "resources");
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function assertReadOnlyRefusal(response: ApiResponse, label: string): void {
  assert.equal(response.status, 403, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.error, RESOURCE_READ_ONLY_ERROR, label);
}

describe("reads never answer to the library setting", () => {
  for (const state of [null, "write", "read", "superuser"] as LibraryState[]) {
    test(`every read tool works for an employee whose library access is ${String(state)}`, async () => {
      await setLibrary(state);
      const resource = await seedResource({ title: "Refund handbook" });

      const listed = await aiCall<{ resources: Array<{ slug: string }>; total: number }>(
        "list_resources",
      );
      assert.equal(listed.status, 200, listed.body.error);
      assert.equal(listed.body.total, 1);
      assert.deepEqual(
        listed.body.resources.map((row) => row.slug),
        [resource.slug],
      );

      const searched = await aiCall<{ resources: Array<{ slug: string; snippet: string }> }>(
        "search_resources",
        { query: "refund policy" },
      );
      assert.equal(searched.status, 200, searched.body.error);
      assert.deepEqual(
        searched.body.resources.map((row) => row.slug),
        [resource.slug],
      );

      const read = await aiCall<{ resource: { bodyText: string } }>("get_resource", {
        resourceSlug: resource.slug,
      });
      assert.equal(read.status, 200, read.body.error);
      assert.match(read.body.resource.bodyText, /refunds are granted/);

      const exported = await aiCall<{ attachmentId: string; format: string }>("export_resource", {
        resourceSlug: resource.slug,
        format: "md",
      });
      assert.equal(exported.status, 200, exported.body.error);
      assert.equal(exported.body.format, "md");
      assert.ok(exported.body.attachmentId);
    });
  }

  test("reads still answer to the per-Resource Share grant, whatever the library level", async () => {
    const unshared = await seedResource({ grant: null });
    for (const state of [null, "write", "read"] as LibraryState[]) {
      await setLibrary(state);
      const read = await aiCall("get_resource", { resourceSlug: unshared.slug });
      assert.equal(read.status, 403, String(state));
      assert.equal(read.body.error, "No access to that resource");
      const exported = await aiCall("export_resource", {
        resourceSlug: unshared.slug,
        format: "md",
      });
      assert.equal(exported.status, 403, String(state));
      const listed = await aiCall<{ total: number; note?: string }>("list_resources");
      assert.equal(listed.body.total, 0);
      assert.match(listed.body.note ?? "", /not been granted access/);
    }
  });
});

describe("a read-only employee is refused every write", () => {
  test("create_resource refuses each source kind before doing any work", async () => {
    await setLibrary("read");
    const attachment = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "contract.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("A contract the employee was asked to file."),
    });
    const before = await sideEffectCounts();

    assertReadOnlyRefusal(
      await aiCall("create_resource", { sourceKind: "text", title: "Notes", body: "Some text." }),
      "text",
    );
    assertReadOnlyRefusal(
      await aiCall("create_resource", { sourceKind: "url", url: pageUrl }),
      "url",
    );
    assertReadOnlyRefusal(
      await aiCall("create_resource", {
        sourceKind: "file",
        attachmentId: attachment.id,
        tags: "legal, contracts",
      }),
      "file",
    );

    assert.equal(pageHits, 0, "the URL must never be fetched");
    assert.deepEqual(resourcesDirFiles(), [], "no bytes may reach the resources store");
    assert.deepEqual(await sideEffectCounts(), before);
  });

  test("the same URL is fetched and filed with read + write, so the zero above is meaningful", async () => {
    const created = await aiCall<{ resource: { slug: string; title: string; status: string } }>(
      "create_resource",
      { sourceKind: "url", url: pageUrl },
    );
    assert.equal(created.status, 200, created.body.error);
    assert.equal(pageHits, 1);
    assert.equal(created.body.resource.title, "Pricing primer");
    assert.equal(created.body.resource.status, "ready");
  });

  test("update_resource is refused even on a Resource the employee filed itself", async () => {
    const own = await seedResource({ grant: "delete", createdByEmployeeId: ada.id, title: "Mine" });
    await replaceResourceTagNames(company.id, "resource", own.id, "draft");
    await setLibrary("read");
    const before = await sideEffectCounts();

    for (const patch of [
      { title: "Renamed" },
      { summary: "New summary" },
      { tags: "final" },
      { body: "Rewritten body" },
      { title: "All", summary: "of", tags: "them", body: "at once" },
    ]) {
      assertReadOnlyRefusal(
        await aiCall("update_resource", { resourceSlug: own.slug, ...patch }),
        JSON.stringify(patch),
      );
    }

    const after = await AppDataSource.getRepository(Resource).findOneByOrFail({ id: own.id });
    assert.equal(after.title, "Mine");
    assert.equal(after.summary, "A guide.");
    assert.equal(after.bodyText, own.bodyText);
    assert.equal(
      await AppDataSource.getRepository(TagAssignment).count({
        where: { resourceType: "resource", resourceId: own.id },
      }),
      1,
    );
    assert.deepEqual(await sideEffectCounts(), before);
  });

  test("delete_resource is refused even on its own Resource, and nothing is removed", async () => {
    const storageKey = `${randomUUID()}.txt`;
    const dir = path.join(companyDir(company.slug), "resources");
    ensureDir(dir);
    await fs.promises.writeFile(path.join(dir, storageKey), "original bytes");
    const own = await seedResource({ grant: "delete", createdByEmployeeId: ada.id });
    await AppDataSource.getRepository(Resource).update(own.id, { storageKey });
    await setLibrary("read");
    const before = await sideEffectCounts();

    assertReadOnlyRefusal(await aiCall("delete_resource", { resourceSlug: own.slug }), "delete");

    assert.ok(await AppDataSource.getRepository(Resource).findOneBy({ id: own.id }));
    assert.ok(fs.existsSync(path.join(dir, storageKey)), "the stored file must survive");
    const grants = await AppDataSource.getRepository(EmployeeResourceGrant).find({
      where: { resourceId: own.id },
    });
    assert.deepEqual(grants.map((grant) => grant.accessLevel).sort(), ["delete", "read"]);
    assert.deepEqual(await sideEffectCounts(), before);
  });

  test("the ceiling is checked before the Resource is looked up", async () => {
    await setLibrary("read");
    assertReadOnlyRefusal(
      await aiCall("update_resource", { resourceSlug: "no-such-resource", title: "x" }),
      "update",
    );
    assertReadOnlyRefusal(
      await aiCall("delete_resource", { resourceSlug: "no-such-resource" }),
      "delete",
    );
  });

  test("schema validation still runs first, so a malformed call says what is malformed", async () => {
    await setLibrary("read");
    const response = await aiCall("create_resource", { sourceKind: "video" });
    assert.equal(response.status, 400);
  });

  test("an unrecognized stored level is refused exactly like read only", async () => {
    const own = await seedResource({ grant: "delete", createdByEmployeeId: ada.id });
    await setLibrary("superuser");
    assertReadOnlyRefusal(
      await aiCall("create_resource", { sourceKind: "text", title: "Notes", body: "Text." }),
      "create",
    );
    assertReadOnlyRefusal(
      await aiCall("update_resource", { resourceSlug: own.slug, title: "x" }),
      "update",
    );
    assertReadOnlyRefusal(await aiCall("delete_resource", { resourceSlug: own.slug }), "delete");
  });

  test("the setting is per employee: a read + write teammate is unaffected", async () => {
    await setLibrary("read", ada);
    const created = await aiCall(
      "create_resource",
      { sourceKind: "text", title: "Bob's notes", body: "Filed by Bob." },
      bobToken,
    );
    assert.equal(created.status, 200, created.body.error);
    assertReadOnlyRefusal(
      await aiCall("create_resource", { sourceKind: "text", title: "Ada's notes", body: "No." }),
      "ada",
    );
  });
});

describe("read + write leaves the per-Resource Share settings in charge", () => {
  const UPDATE_EXPECTED: Record<string, { status: number; error?: string }> = {
    none: { status: 403, error: "No edit permission on that resource" },
    read: { status: 403, error: "No edit permission on that resource" },
    edit: { status: 200 },
    delete: { status: 200 },
  };
  const DELETE_EXPECTED: Record<string, { status: number; error?: string }> = {
    none: { status: 403, error: "No delete permission on that resource" },
    read: { status: 403, error: "No delete permission on that resource" },
    edit: { status: 403, error: "No delete permission on that resource" },
    delete: { status: 200 },
  };

  for (const state of [null, "write"] as LibraryState[]) {
    test(`with library access ${String(state)}, update and delete follow the Share grant`, async () => {
      await setLibrary(state);
      for (const level of ["none", "read", "edit", "delete"] as const) {
        const grant = level === "none" ? null : level;
        const forUpdate = await seedResource({ grant });
        const update = await aiCall("update_resource", {
          resourceSlug: forUpdate.slug,
          summary: "Tidied",
        });
        assert.equal(update.status, UPDATE_EXPECTED[level].status, `update with ${level}`);
        assert.equal(update.body.error, UPDATE_EXPECTED[level].error, `update with ${level}`);

        const forDelete = await seedResource({ grant });
        const removed = await aiCall("delete_resource", { resourceSlug: forDelete.slug });
        assert.equal(removed.status, DELETE_EXPECTED[level].status, `delete with ${level}`);
        assert.equal(removed.body.error, DELETE_EXPECTED[level].error, `delete with ${level}`);
        const survives = await AppDataSource.getRepository(Resource).findOneBy({
          id: forDelete.id,
        });
        assert.equal(Boolean(survives), DELETE_EXPECTED[level].status !== 200, `row with ${level}`);
      }
    });
  }

  test("under read only, no Share grant is high enough", async () => {
    await setLibrary("read");
    for (const level of ["none", "read", "edit", "delete"] as const) {
      const resource = await seedResource({ grant: level === "none" ? null : level });
      assertReadOnlyRefusal(
        await aiCall("update_resource", { resourceSlug: resource.slug, summary: "Tidied" }),
        `update with ${level}`,
      );
      assertReadOnlyRefusal(
        await aiCall("delete_resource", { resourceSlug: resource.slug }),
        `delete with ${level}`,
      );
    }
  });

  test("filing by default works as before: the author owns its row, teammates read it", async () => {
    // Bob is read only; a teammate filing a Resource still shares it with him.
    await setLibrary("read", bob);
    const created = await aiCall<{ resource: { id: string; slug: string } }>("create_resource", {
      sourceKind: "text",
      title: "Market notes",
      body: "What we learned this week.",
      tags: "research",
    });
    assert.equal(created.status, 200, created.body.error);
    const grants = await AppDataSource.getRepository(EmployeeResourceGrant).find({
      where: { resourceId: created.body.resource.id },
    });
    assert.deepEqual(
      Object.fromEntries(grants.map((grant) => [grant.employeeId, grant.accessLevel])),
      { [ada.id]: "delete", [bob.id]: "read" },
    );
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "resource.create",
    });
    assert.equal(audit.actorEmployeeId, ada.id);
    assert.equal(
      await AppDataSource.getRepository(JournalEntry).count({ where: { employeeId: ada.id } }),
      1,
    );
    const bobReads = await aiCall(
      "get_resource",
      { resourceSlug: created.body.resource.slug },
      bobToken,
    );
    assert.equal(bobReads.status, 200, bobReads.body.error);
    assertReadOnlyRefusal(
      await aiCall(
        "update_resource",
        { resourceSlug: created.body.resource.slug, title: "x" },
        bobToken,
      ),
      "bob update",
    );
  });
});

describe("the ceiling suspends Share grants rather than deleting them", () => {
  test("an edit grant stops working under read only and works again once restored", async () => {
    const resource = await seedResource({ grant: "edit" });
    const before = await aiCall("update_resource", { resourceSlug: resource.slug, summary: "One" });
    assert.equal(before.status, 200, before.body.error);

    await setResourceLibraryAccess(company.id, ada.id, "read");
    assertReadOnlyRefusal(
      await aiCall("update_resource", { resourceSlug: resource.slug, summary: "Two" }),
      "suspended",
    );
    const grant = await AppDataSource.getRepository(EmployeeResourceGrant).findOneByOrFail({
      employeeId: ada.id,
      resourceId: resource.id,
    });
    assert.equal(grant.accessLevel, "edit", "the Share grant itself is untouched");

    await setResourceLibraryAccess(company.id, ada.id, "write");
    const restored = await aiCall<{ resource: { summary: string } }>("update_resource", {
      resourceSlug: resource.slug,
      summary: "Three",
    });
    assert.equal(restored.status, 200, restored.body.error);
    assert.equal(restored.body.resource.summary, "Three");
  });
});

describe("a Member driving the turn cannot lend write access", () => {
  async function ownerToken(): Promise<string> {
    const owner = await insert(User, {
      email: `owner-${randomUUID()}@example.test`,
      passwordHash: "hash",
      name: "Owner",
      emailVerifiedAt: new Date(),
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: company.id,
      userId: owner.id,
      role: "owner",
      financeAccess: "full",
    });
    return issueMcpToken(ada.id, company.id, {
      authority: "member",
      requesterUserId: owner.id,
      requesterSessionVersion: 0,
    });
  }

  test("an owner's chat with a read-only employee is still refused every write", async () => {
    const own = await seedResource({ grant: "delete", createdByEmployeeId: ada.id });
    await setLibrary("read");
    const delegated = await ownerToken();
    try {
      assertReadOnlyRefusal(
        await aiCall("create_resource", { sourceKind: "text", title: "N", body: "B" }, delegated),
        "create",
      );
      assertReadOnlyRefusal(
        await aiCall("update_resource", { resourceSlug: own.slug, title: "x" }, delegated),
        "update",
      );
      assertReadOnlyRefusal(
        await aiCall("delete_resource", { resourceSlug: own.slug }, delegated),
        "delete",
      );
      const read = await aiCall("get_resource", { resourceSlug: own.slug }, delegated);
      assert.equal(read.status, 200, read.body.error);
    } finally {
      revokeMcpToken(delegated);
    }
  });

  test("the same owner's chat may write when the employee holds read + write", async () => {
    const delegated = await ownerToken();
    try {
      const created = await aiCall(
        "create_resource",
        { sourceKind: "text", title: "Delegated", body: "Filed in chat." },
        delegated,
      );
      assert.equal(created.status, 200, created.body.error);
    } finally {
      revokeMcpToken(delegated);
    }
  });
});

describe("find_tools sees the ceiling", () => {
  const ALL_RESOURCE_TOOLS = [...READ_TOOLS, ...RESOURCE_WRITE_TOOLS];

  for (const [state, expectedDead] of [
    [null, []],
    ["write", []],
    ["read", [...RESOURCE_WRITE_TOOLS]],
    // An unknown level stays live as a ranking hint; the route refuses it anyway.
    ["superuser", []],
  ] as Array<[LibraryState, string[]]>) {
    test(`library access ${String(state)} marks exactly ${JSON.stringify(expectedDead)} dead`, async () => {
      await setLibrary(state);
      for (const strict of [false, true]) {
        const dead = await deadToolNames(ada.id, strict);
        assert.deepEqual(
          ALL_RESOURCE_TOOLS.filter((tool) => dead.has(tool)),
          expectedDead,
          `strict=${strict}`,
        );
      }
      const bobDead = await deadToolNames(bob.id);
      assert.deepEqual(
        ALL_RESOURCE_TOOLS.filter((tool) => bobDead.has(tool)),
        [],
        "a teammate is never affected",
      );
    });
  }
});

describe("a read-only employee can still use what it reads", () => {
  test("a PDF Resource it can read still becomes a signing draft", async () => {
    const pdf = await PDFDocument.create();
    pdf
      .addPage([612, 792])
      .drawText("Mutual non-disclosure agreement", { x: 48, y: 730, size: 18 });
    const bytes = Buffer.from(await pdf.save());
    const storageKey = `${randomUUID()}.pdf`;
    const dir = path.join(companyDir(company.slug), "resources");
    ensureDir(dir);
    await fs.promises.writeFile(path.join(dir, storageKey), bytes);
    const resource = await insert(Resource, {
      companyId: company.id,
      title: "Mutual NDA",
      slug: "mutual-nda",
      sourceKind: "pdf",
      sourceFilename: "mutual-nda.pdf",
      storageKey,
      summary: "A mutual NDA.",
      bodyText: "Mutual non-disclosure agreement",
      tags: "",
      bytes: bytes.length,
      status: "ready",
      errorMessage: "",
      createdById: "owner-1",
      createdByEmployeeId: null,
    });
    await insert(EmployeeResourceGrant, {
      employeeId: ada.id,
      resourceId: resource.id,
      accessLevel: "read",
    });
    await insert(EmployeeSigningGrant, {
      companyId: company.id,
      employeeId: ada.id,
      accessLevel: "draft",
    });
    await setLibrary("read");

    const draft = await aiCall<{ envelope: { status: string } }>("draft_signature_envelope", {
      resourceSlug: resource.slug,
      title: "Mutual NDA — signature",
      message: "Please review and sign.",
      routingMode: "parallel",
      recipients: [
        {
          name: "Ada Customer",
          email: "ada@example.test",
          role: "signer",
          fields: [
            {
              type: "signature",
              label: "Customer signature",
              pageNumber: 1,
              x: 0.1,
              y: 0.75,
              width: 0.3,
              height: 0.08,
            },
          ],
        },
      ],
    });
    assert.equal(draft.status, 200, draft.body.error);
    assert.equal(draft.body.envelope.status, "draft");
    assert.equal(await AppDataSource.getRepository(Resource).count(), 1, "no Resource was written");
  });
});
