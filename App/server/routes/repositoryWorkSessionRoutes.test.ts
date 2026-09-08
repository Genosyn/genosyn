import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { repositoryContentRouter } from "./repositoryContent.js";
import { recordAttachmentBytes, ATTACHMENTS_MAX_BYTES } from "../services/uploads.js";

/**
 * The HTTP surface an open work session is driven through.
 *
 * The service tests already cover what a revision *does*. What only shows up
 * here is the contract the page depends on: that the transcript comes back
 * with the session, that a follow-up answers before the turn has finished so
 * the composer can clear itself, and that the two operations which reach the
 * remote stay behind the admin gate while the collaborative ones do not.
 *
 * The model turn is never reached — every test drives a session whose row
 * already exists, so no chat runtime is needed.
 */

let server: Server;
let baseUrl = "";
let dataDir: string;
const originalDataDir = config.dataDir;
let actingUserId: string | null = null;
const codingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...codingTools };

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-session-routes-"));
  (config as { dataDir: string }).dataDir = dataDir;
  // The App-owned checkout runs Git through whatever execution mode boot
  // settled on, and no server boots here — so the shipped `bubblewrap` default
  // would send every Git child through a sandbox this host may not have. Pin
  // the mode `resolveCodingExecutionMode` resolves to wherever bubblewrap
  // cannot run (services/runtimeSecurity.ts), so these tests pin the route
  // contract rather than the host's user-namespace policy.
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0, authenticatedAt: Date.now() }
      : null;
    next();
  });
  app.use("/api/companies/:cid", repositoryContentRouter);
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
  (config as { dataDir: string }).dataDir = originalDataDir;
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let company: Company;
let owner: User;
let member: User;
let outsider: User;
let employee: AIEmployee;
let repository: Repository;
let session: RepositoryWorkSession;

beforeEach(async () => {
  await resetTestDb();
  owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  outsider = await insert(User, {
    email: "outsider@example.com",
    name: "Outsider",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Engineer",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-test",
    authMode: "apikey",
    configJson: '{"apiKeyEncrypted":"test-placeholder"}',
    isActive: true,
  });
  repository = await insert(Repository, {
    companyId: company.id,
    name: "Strategy",
    slug: "strategy",
    description: "",
    origin: "local",
    kind: "documents",
    gitUrl: "",
    defaultBranch: "main",
    authMode: "none",
    committerName: "Genosyn",
    committerEmail: "repositories@genosyn.local",
    lastSyncStatus: "unknown",
    lastSyncError: "",
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
  session = await insert(RepositoryWorkSession, {
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: employee.id,
    requestedByUserId: member.id,
    title: "Rewrite the plan",
    instruction: "Rewrite the plan",
    status: "ready",
    branch: "genosyn/ada/abcdef12",
    baseCommit: "aaaa",
    headCommit: "bbbb",
    reply: "Done.",
    turnCount: 1,
    filesChanged: 1,
    insertions: 2,
    deletions: 0,
  });
  await insert(RepositoryWorkSessionTurn, {
    companyId: company.id,
    sessionId: session.id,
    ordinal: 1,
    instruction: "Rewrite the plan",
    reply: "Done.",
    status: "ok",
    requestedByUserId: member.id,
    baseCommit: "aaaa",
    headCommit: "bbbb",
    filesChanged: 1,
    insertions: 2,
  });
  actingUserId = member.id;
});

const sessionsUrl = () => `${baseUrl}/api/companies/${company.id}/repositories/strategy/sessions`;
const attachmentsUrl = () =>
  `${baseUrl}/api/companies/${company.id}/repositories/strategy/session-attachments`;

describe("work-session AI Model endpoints", () => {
  const candidatesUrl = () => sessionsUrl().replace(/\/sessions$/, "/session-candidates");
  const startBody = (modelId?: unknown) => ({
    employeeId: employee.id,
    instruction: "Update the plan",
    ...(modelId === undefined ? {} : { modelId }),
  });
  const addModel = (overrides: Partial<AIModel> = {}) =>
    insert(AIModel, {
      employeeId: employee.id,
      provider: "openai",
      model: "gpt-second",
      authMode: "apikey",
      configJson: '{"apiKeyEncrypted":"second-placeholder"}',
      isActive: false,
      ...overrides,
    });

  test("lists all granted employee models with safe metadata, defaults and connection state", async () => {
    const active = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      employeeId: employee.id,
    });
    const disconnected = await addModel({ configJson: "{}" });
    const custom = await addModel({
      provider: "custom",
      model: "local-model",
      authMode: "customEndpoint",
      configJson: JSON.stringify({
        baseURLEncrypted: "sensitive-endpoint-ciphertext",
        baseURLPreview: "private-host.example",
        apiKeyEncrypted: "sensitive-key-ciphertext",
        apiKeyPreview: "secret-preview",
      }),
    });
    const result = await call("GET", candidatesUrl());
    assert.equal(result.status, 200);
    const employees = result.body.employees as Array<{
      id: string;
      models: Array<Record<string, unknown>>;
    }>;
    assert.equal(employees.length, 1);
    assert.equal(employees[0].id, employee.id);
    const models = employees[0].models;
    assert.equal(models.length, 3);
    for (const model of models) {
      assert.deepEqual(Object.keys(model).sort(), [
        "id",
        "isActive",
        "label",
        "model",
        "provider",
        "status",
      ]);
    }
    assert.deepEqual(
      models.find((model) => model.id === active.id),
      {
        id: active.id,
        provider: "anthropic",
        model: "claude-test",
        label: "Anthropic (Claude) · claude-test",
        status: "connected",
        isActive: true,
      },
    );
    assert.equal(models.find((model) => model.id === disconnected.id)?.status, "not_connected");
    assert.equal(models.find((model) => model.id === custom.id)?.status, "connected");
    const serialized = JSON.stringify(result.body);
    for (const secret of [
      "sensitive-endpoint-ciphertext",
      "sensitive-key-ciphertext",
      "private-host.example",
      "secret-preview",
      "configJson",
      "authMode",
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });

  test("does not expose ungranted employees or foreign-company models even with an invalid grant", async () => {
    const ungranted = await insert(AIEmployee, {
      companyId: company.id,
      name: "Grace",
      slug: "grace",
      role: "Engineer",
    });
    const foreign = await insert(AIEmployee, {
      companyId: "another-company",
      name: "Foreign",
      slug: "foreign",
      role: "Engineer",
    });
    await addModel({ employeeId: ungranted.id });
    await addModel({ employeeId: foreign.id });
    await insert(EmployeeRepositoryGrant, {
      employeeId: foreign.id,
      repositoryId: repository.id,
      accessLevel: "write",
    });
    const result = await call("GET", candidatesUrl());
    const employees = result.body.employees as Array<{ id: string; models: Array<{ id: string }> }>;
    assert.deepEqual(
      employees.map((entry) => entry.id),
      [employee.id],
    );
    assert.equal(employees[0].models.length, 1);
  });

  test("returns an empty model list for an employee without any models", async () => {
    await AppDataSource.getRepository(AIModel).delete({ employeeId: employee.id });
    const result = await call("GET", candidatesUrl());
    assert.equal(result.status, 200);
    const employees = result.body.employees as Array<{ models: unknown[] }>;
    assert.deepEqual(employees[0].models, []);
  });

  test("candidate models require an authenticated company Member", async () => {
    actingUserId = outsider.id;
    assert.equal((await call("GET", candidatesUrl())).status, 403);
    actingUserId = null;
    assert.equal((await call("GET", candidatesUrl())).status, 401);
  });

  for (const mode of ["explicit", "default"] as const) {
    test(`starts a work session with the ${mode} model id in the response and stored row`, async () => {
      const second = await addModel();
      const active = await AppDataSource.getRepository(AIModel).findOneByOrFail({
        employeeId: employee.id,
        isActive: true,
      });
      const expectedId = mode === "explicit" ? second.id : active.id;
      const result = await call(
        "POST",
        sessionsUrl(),
        startBody(mode === "explicit" ? second.id : undefined),
      );
      assert.equal(result.status, 200);
      assert.equal(result.body.modelId, expectedId);
      const stored = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
        id: String(result.body.id),
      });
      assert.equal(stored.modelId, expectedId);
      assert.equal(stored.employeeId, employee.id);
      // Placeholder ciphertext fails locally; no real provider request is made.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const current = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
          id: stored.id,
        });
        if (current.status !== "running") return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail("the locally rejected model turn did not settle");
    });
  }

  test("rejects missing, foreign-employee and foreign-company model ids without creating rows", async () => {
    const other = await insert(AIEmployee, {
      companyId: company.id,
      name: "Grace",
      slug: "grace",
      role: "Engineer",
    });
    const foreign = await insert(AIEmployee, {
      companyId: "foreign-company",
      name: "Foreign",
      slug: "foreign",
      role: "Engineer",
    });
    const otherModel = await addModel({ employeeId: other.id });
    const foreignModel = await addModel({ employeeId: foreign.id });
    for (const modelId of [owner.id, otherModel.id, foreignModel.id]) {
      const result = await call("POST", sessionsUrl(), startBody(modelId));
      assert.equal(result.status, 400);
      assert.match(String(result.body.error), /no longer available for this employee/);
    }
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 1);
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSessionTurn).count(), 1);
  });

  test("rejects a disconnected explicit or default model without creating rows", async () => {
    const active = await AppDataSource.getRepository(AIModel).findOneByOrFail({
      employeeId: employee.id,
    });
    await AppDataSource.getRepository(AIModel).update(active.id, { configJson: "{}" });
    for (const modelId of [undefined, active.id]) {
      const result = await call("POST", sessionsUrl(), startBody(modelId));
      assert.equal(result.status, 400);
      assert.match(String(result.body.error), /AI Model is not connected/);
    }
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 1);
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSessionTurn).count(), 1);
  });

  test("validates the model id type and UUID before starting a session", async () => {
    for (const modelId of [null, "", "not-a-uuid", 42, [employee.id], { id: employee.id }]) {
      const result = await call("POST", sessionsUrl(), startBody(modelId));
      assert.equal(result.status, 400);
      assert.equal(result.body.error, "ValidationError");
    }
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 1);
  });

  test("revision requests cannot silently override the session's chosen model", async () => {
    const model = await addModel();
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Another pass",
      modelId: model.id,
    });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "ValidationError");
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSessionTurn).count(), 1);
  });
});

describe("work-session attachment endpoints", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
    "base64",
  );
  async function upload(bytes: Uint8Array = png, filename = "pasted.png", mime = "image/png") {
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    return fetch(attachmentsUrl(), { method: "POST", body: form });
  }
  async function storedUpload(
    overrides: Partial<Parameters<typeof recordAttachmentBytes>[0]> = {},
  ) {
    return recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      uploadedByUserId: member.id,
      filename: "screenshot.png",
      mimeType: "image/png",
      bytes: png,
      ...overrides,
    });
  }

  test("accepts multipart image uploads and serves the owner's draft preview", async () => {
    const response = await upload();
    assert.equal(response.status, 201);
    const metadata = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(metadata).sort(), [
      "filename",
      "id",
      "isImage",
      "mimeType",
      "sizeBytes",
    ]);
    assert.equal(metadata.filename, "pasted.png");
    assert.equal(metadata.isImage, true);
    assert.equal(metadata.sizeBytes, png.length);
    const preview = await fetch(`${attachmentsUrl()}/${metadata.id}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.match(preview.headers.get("content-disposition") ?? "", /^inline/);
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), png);
  });

  test("download names are encoded and active image formats download as files", async () => {
    const attachment = await storedUpload({
      filename: "diagram.svg",
      mimeType: "image/svg+xml",
      bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    const response = await fetch(`${attachmentsUrl()}/${attachment.id}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition") ?? "", /^attachment/);
  });

  test("requires a file and enforces the existing upload size cap", async () => {
    const missing = await fetch(attachmentsUrl(), { method: "POST", body: new FormData() });
    assert.equal(missing.status, 400);
    const empty = await upload(new Uint8Array());
    assert.equal(empty.status, 400);
    const oversized = await upload(new Uint8Array(ATTACHMENTS_MAX_BYTES + 1));
    assert.equal(oversized.status, 400);
    assert.match(((await oversized.json()) as { error: string }).error, /File too large/);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 0);
  });

  test("requires a company Member for both upload and preview", async () => {
    const attachment = await storedUpload();
    actingUserId = outsider.id;
    assert.equal((await upload()).status, 403);
    assert.equal((await fetch(`${attachmentsUrl()}/${attachment.id}`)).status, 403);
    actingUserId = null;
    assert.equal((await upload()).status, 401);
    assert.equal((await fetch(`${attachmentsUrl()}/${attachment.id}`)).status, 401);
  });

  test("a draft preview is private to the uploader", async () => {
    const attachment = await storedUpload();
    actingUserId = owner.id;
    assert.equal((await fetch(`${attachmentsUrl()}/${attachment.id}`)).status, 404);
  });

  test("a bound repository image is readable by another company Member", async () => {
    const attachment = await storedUpload();
    const turn = await AppDataSource.getRepository(RepositoryWorkSessionTurn).findOneByOrFail({
      sessionId: session.id,
    });
    await AppDataSource.getRepository(Attachment).update(
      { id: attachment.id },
      { messageId: turn.id },
    );
    actingUserId = owner.id;
    assert.equal((await fetch(`${attachmentsUrl()}/${attachment.id}`)).status, 200);
    const detail = await call("GET", `${sessionsUrl()}/${session.id}`);
    const turns = detail.body.turns as Array<{ attachments: Array<Record<string, unknown>> }>;
    assert.equal(turns[0].attachments[0].id, attachment.id);
    assert.equal("storageKey" in turns[0].attachments[0], false);
  });

  test("hides attachments bound outside this repository or to another chat surface", async () => {
    const attachment = await storedUpload();
    const turn = await AppDataSource.getRepository(RepositoryWorkSessionTurn).findOneByOrFail({
      sessionId: session.id,
    });
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { repositoryId: "other-repository" },
    );
    await AppDataSource.getRepository(Attachment).update(
      { id: attachment.id },
      { messageId: turn.id },
    );
    assert.equal((await fetch(`${attachmentsUrl()}/${attachment.id}`)).status, 404);
    await AppDataSource.getRepository(Attachment).update(
      { id: attachment.id },
      { messageId: "some-chat-message" },
    );
    assert.equal((await fetch(`${attachmentsUrl()}/${attachment.id}`)).status, 404);
  });

  test("hides foreign-company images even if their uploader matches", async () => {
    const attachment = await storedUpload({ companyId: "other-company" });
    assert.equal((await fetch(`${attachmentsUrl()}/${attachment.id}`)).status, 404);
  });

  test("validates attachment IDs and requires an existing repository", async () => {
    assert.equal((await fetch(`${attachmentsUrl()}/not-a-uuid`)).status, 400);
    const form = new FormData();
    form.set("file", new Blob([png], { type: "image/png" }), "pasted.png");
    const absent = await fetch(attachmentsUrl().replace("/strategy/", "/absent/"), {
      method: "POST",
      body: form,
    });
    assert.equal(absent.status, 404);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 0);
  });

  test("initial and revision requests validate attachment count, IDs and empty content", async () => {
    for (const url of [sessionsUrl(), `${sessionsUrl()}/${session.id}/revise`]) {
      const base = url === sessionsUrl() ? { employeeId: employee.id } : {};
      for (const fields of [
        { instruction: " \n", attachmentIds: [] },
        { instruction: "Do this", attachmentIds: ["invalid"] },
        { instruction: "Do this", attachmentIds: Array(11).fill(member.id) },
      ]) {
        assert.equal((await call("POST", url, { ...base, ...fields })).status, 400);
      }
    }
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 1);
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSessionTurn).count(), 1);
  });

  test("a Member cannot submit another Member's draft in either instruction endpoint", async () => {
    const attachment = await storedUpload({ uploadedByUserId: owner.id });
    const initial = await call("POST", sessionsUrl(), {
      employeeId: employee.id,
      instruction: "Use this",
      attachmentIds: [attachment.id],
    });
    assert.equal(initial.status, 400);
    const revised = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Use this",
      attachmentIds: [attachment.id],
    });
    assert.equal(revised.status, 400);
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 1);
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSessionTurn).count(), 1);
  });

  test("an image-only initial request persists its uploaded image", async () => {
    const attachment = await storedUpload();
    const initial = await call("POST", sessionsUrl(), {
      employeeId: employee.id,
      instruction: "",
      attachmentIds: [attachment.id],
    });
    assert.equal(initial.status, 200);
    const detail = await call("GET", `${sessionsUrl()}/${initial.body.id}`);
    const turns = detail.body.turns as Array<{
      instruction: string;
      attachments: Array<{ id: string }>;
    }>;
    assert.equal(turns[0].instruction, "");
    assert.equal(turns[0].attachments[0].id, attachment.id);
  });

  test("an image-only revision returns the new attachment on its own turn", async () => {
    const attachment = await storedUpload();
    const response = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "",
      attachmentIds: [attachment.id],
    });
    assert.equal(response.status, 200);
    const turns = response.body.turns as Array<{ attachments: Array<{ id: string }> }>;
    assert.deepEqual(
      turns.map((turn) => turn.attachments.map((a) => a.id)),
      [[], [attachment.id]],
    );
  });
});

async function call(
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}

describe("reading a session", () => {
  test("returns the session with its whole transcript", async () => {
    const result = await call("GET", `${sessionsUrl()}/${session.id}`);
    assert.equal(result.status, 200);
    const detail = result.body as {
      session: { id: string; title: string; turnCount: number; employee: { name: string } | null };
      turns: Array<{ ordinal: number; instruction: string; status: string }>;
    };
    assert.equal(detail.session.id, session.id);
    assert.equal(detail.session.title, "Rewrite the plan");
    assert.equal(detail.session.turnCount, 1);
    assert.equal(detail.session.employee?.name, "Ada");
    assert.deepEqual(
      detail.turns.map((turn) => turn.ordinal),
      [1],
    );
    assert.equal(detail.turns[0].status, "ok");
  });

  test("the list stays light — no transcripts in it", async () => {
    const result = await call("GET", sessionsUrl());
    assert.equal(result.status, 200);
    const rows = (result.body as { sessions: Array<Record<string, unknown>> }).sessions;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Rewrite the plan");
    assert.equal("turns" in rows[0], false);
  });

  test("a session from another repository is not found", async () => {
    const other = await insert(Repository, {
      companyId: company.id,
      name: "Other",
      slug: "other",
      description: "",
      origin: "local",
      kind: "code",
      gitUrl: "",
      defaultBranch: "main",
      authMode: "none",
      lastSyncStatus: "unknown",
      lastSyncError: "",
    });
    const result = await call(
      "GET",
      `${baseUrl}/api/companies/${company.id}/repositories/${other.slug}/sessions/${session.id}`,
    );
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /not found/);
  });

  test("a non-member gets nothing", async () => {
    actingUserId = outsider.id;
    const result = await call("GET", `${sessionsUrl()}/${session.id}`);
    assert.equal(result.status, 403);
  });
});

describe("renaming a session", () => {
  test("an ordinary Member may rename one", async () => {
    const result = await call("PATCH", `${sessionsUrl()}/${session.id}`, { title: "The plan" });
    assert.equal(result.status, 200);
    assert.equal(result.body.title, "The plan");
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.title, "The plan");
  });

  test("refuses an empty name", async () => {
    const result = await call("PATCH", `${sessionsUrl()}/${session.id}`, { title: "" });
    assert.equal(result.status, 400);
  });
});

describe("archiving a session", () => {
  async function listed(archived: boolean): Promise<string[]> {
    const result = await call("GET", `${sessionsUrl()}${archived ? "?archived=1" : ""}`);
    assert.equal(result.status, 200);
    return (result.body as { sessions: Array<{ id: string }> }).sessions.map((row) => row.id);
  }

  test("moves the session between the two lists without touching the work", async () => {
    assert.deepEqual(await listed(false), [session.id]);
    assert.deepEqual(await listed(true), []);

    const archived = await call("POST", `${sessionsUrl()}/${session.id}/archive`, {
      archived: true,
    });
    assert.equal(archived.status, 200);
    assert.notEqual(archived.body.archivedAt, null);
    // The status is what happened to the work; archiving says nothing about it.
    assert.equal(archived.body.status, "ready");
    assert.equal(archived.body.branch, "genosyn/ada/abcdef12");

    assert.deepEqual(await listed(false), []);
    assert.deepEqual(await listed(true), [session.id]);
  });

  test("restoring puts it back where it was", async () => {
    await call("POST", `${sessionsUrl()}/${session.id}/archive`, { archived: true });
    const restored = await call("POST", `${sessionsUrl()}/${session.id}/archive`, {
      archived: false,
    });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.archivedAt, null);
    assert.equal(restored.body.status, "ready");
    assert.deepEqual(await listed(false), [session.id]);
    assert.deepEqual(await listed(true), []);
  });

  test("an archived session is still readable by its own URL", async () => {
    await call("POST", `${sessionsUrl()}/${session.id}/archive`, { archived: true });
    const result = await call("GET", `${sessionsUrl()}/${session.id}`);
    assert.equal(result.status, 200);
    const detail = result.body as { session: { id: string; archivedAt: string | null } };
    assert.equal(detail.session.id, session.id);
    assert.notEqual(detail.session.archivedAt, null);
  });

  test("an ordinary Member may archive — it is not an admin action", async () => {
    actingUserId = member.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/archive`, { archived: true });
    assert.equal(result.status, 200);
  });

  test("refuses to file away a turn that is still in flight", async () => {
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { status: "running" },
    );
    const result = await call("POST", `${sessionsUrl()}/${session.id}/archive`, { archived: true });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /still working/);
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.archivedAt, null);
  });

  test("asking for changes brings an archived session back into the inbox", async () => {
    await call("POST", `${sessionsUrl()}/${session.id}/archive`, { archived: true });
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "One more pass",
    });
    assert.equal(result.status, 200);
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.archivedAt, null);
  });

  test("refuses a body that does not say which way", async () => {
    const result = await call("POST", `${sessionsUrl()}/${session.id}/archive`, {});
    assert.equal(result.status, 400);
  });

  test("a non-member cannot file away someone else's session", async () => {
    actingUserId = outsider.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/archive`, { archived: true });
    assert.equal(result.status, 403);
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.archivedAt, null);
  });

  test("rejects a query it does not understand rather than guessing", async () => {
    const result = await call("GET", `${sessionsUrl()}?archived=maybe`);
    assert.equal(result.status, 400);
  });
});

describe("asking for changes", () => {
  test("answers with the session and its transcript before the turn finishes", async () => {
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Also mention the risks",
    });
    assert.equal(result.status, 200);
    const detail = result.body as {
      session: { status: string; turnCount: number };
      turns: Array<{ ordinal: number; instruction: string }>;
    };
    // The turn itself cannot complete here — there is no model — but the row
    // the page renders must already be there, which is the contract.
    assert.equal(detail.session.turnCount, 2);
    assert.equal(detail.turns.length, 2);
    assert.equal(detail.turns[1].instruction, "Also mention the risks");
  });

  test("an ordinary Member may ask — it is not an admin action", async () => {
    actingUserId = member.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Tighten it",
    });
    assert.equal(result.status, 200);
  });

  test("refuses an empty instruction", async () => {
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, { instruction: "" });
    assert.equal(result.status, 400);
  });

  test("refuses a session that has already been accepted", async () => {
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { status: "published" },
    );
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "One more thing",
    });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /already been accepted/);
  });

  test("refuses while a turn is in flight", async () => {
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { status: "running" },
    );
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Hurry up",
    });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /still working/);
  });

  test("a Member who has never changed their password may still ask", async () => {
    // `sessionVersion` is 0 until a password reset moves it, and a truthiness
    // check on it used to refuse exactly those Members — which is most of them.
    const row = await AppDataSource.getRepository(User).findOneByOrFail({ id: member.id });
    assert.equal(row.sessionVersion, 0);
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Carry on",
    });
    assert.notEqual(result.status, 400);
    assert.equal(result.status, 200);
  });

  test("a non-member cannot drive someone else's session", async () => {
    actingUserId = outsider.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/revise`, {
      instruction: "Mine now",
    });
    assert.equal(result.status, 403);
    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(row.turnCount, 1);
  });
});

describe("proposing the work to GitHub", () => {
  test("an ordinary Member cannot reach the remote", async () => {
    actingUserId = member.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/pull-request`, {});
    assert.equal(result.status, 403);
    assert.match(String(result.body.error), /admin company role required/);
  });

  test("an admin gets as far as the repository's own refusal", async () => {
    actingUserId = owner.id;
    const result = await call("POST", `${sessionsUrl()}/${session.id}/pull-request`, {});
    // This repository is local, so there is nowhere to propose anything — the
    // point is that the request was allowed through to the service.
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /nowhere to open a pull request/);
  });
});
