import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseRecordAttachment } from "../db/entities/BaseRecordAttachment.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseView } from "../db/entities/BaseView.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeBaseGrant } from "../db/entities/EmployeeBaseGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { makeCodeSdk } from "../services/pipelines/codeSdk.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { basesRouter } from "./bases.js";
import { mcpInternalRouter } from "./mcpInternal.js";

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let tempDir = "";
let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;
let base: Base;
let table: BaseTable;
let field: BaseField;
let record: BaseRecord;
let token = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-bases-routes-"));
  mutableConfig.dataDir = tempDir;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", basesRouter);
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  mutableConfig.dataDir = originalDataDir;
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
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
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Analyst",
    slug: "analyst",
    role: "Operations analyst",
    soulBody: "",
  });
  base = await insert(Base, {
    companyId: company.id,
    name: "CRM",
    slug: "crm",
    createdById: owner.id,
  });
  table = await insert(BaseTable, {
    baseId: base.id,
    name: "Contacts",
    slug: "contacts",
    sortOrder: 1000,
    archivedAt: null,
  });
  field = await insert(BaseField, {
    tableId: table.id,
    name: "Name",
    type: "text",
    configJson: "{}",
    isPrimary: true,
    sortOrder: 1000,
  });
  record = await insert(BaseRecord, {
    tableId: table.id,
    dataJson: JSON.stringify({ [field.id]: "Ada Lovelace" }),
    sortOrder: 1000,
  });
  await insert(EmployeeBaseGrant, {
    employeeId: employee.id,
    baseId: base.id,
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function humanCall<T = Record<string, unknown>>(
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
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

async function aiCall<T = Record<string, unknown>>(
  tool: string,
  body: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
  };
}

describe("Base table archive access", () => {
  test("archive hides every AI read and restore makes the table readable again", async () => {
    const archived = await humanCall<{ archivedAt: string | null }>(
      "PATCH",
      `/bases/${base.slug}/tables/${table.id}`,
      { archived: true },
    );
    assert.equal(archived.status, 200);
    assert.notEqual(archived.body.archivedAt, null);

    const detail = await humanCall<{ tables: Array<{ id: string; archivedAt: string | null }> }>(
      "GET",
      `/bases/${base.slug}`,
    );
    assert.equal(detail.status, 200);
    assert.equal(detail.body.tables[0].id, table.id);
    assert.notEqual(detail.body.tables[0].archivedAt, null);

    const list = await humanCall<Array<{ tableCount: number }>>("GET", "/bases");
    assert.equal(list.body[0].tableCount, 0);

    const schema = await aiCall<{ tables: unknown[] }>("get_base", {
      baseSlug: base.slug,
    });
    assert.equal(schema.status, 200);
    assert.deepEqual(schema.body.tables, []);

    const rows = await aiCall("list_base_rows", {
      baseSlug: base.slug,
      tableSlug: table.slug,
    });
    assert.equal(rows.status, 404);
    assert.equal(rows.body.error, "Table not found");

    const recordDetail = await aiCall("get_base_record", {
      recordId: record.id,
    });
    assert.equal(recordDetail.status, 404);
    assert.equal(recordDetail.body.error, "Table not found");

    const restored = await humanCall<{ archivedAt: string | null }>(
      "PATCH",
      `/bases/${base.slug}/tables/${table.id}`,
      { archived: false },
    );
    assert.equal(restored.status, 200);
    assert.equal(restored.body.archivedAt, null);

    const restoredRows = await aiCall<{ records: Array<{ id: string }> }>("list_base_rows", {
      baseSlug: base.slug,
      tableSlug: table.slug,
    });
    assert.equal(restoredRows.status, 200);
    assert.deepEqual(
      restoredRows.body.records.map((row) => row.id),
      [record.id],
    );

    const actions = await AppDataSource.getRepository(AuditEvent).find({
      where: { companyId: company.id },
      order: { createdAt: "ASC" },
    });
    assert.deepEqual(
      actions.map((event) => event.action),
      ["base_table.archive", "base_table.restore"],
    );
  });

  test("AI cannot delete an archived table, but a Member can delete it permanently", async () => {
    await insert(BaseView, {
      tableId: table.id,
      name: "Grid",
      slug: "grid",
      sortOrder: 1000,
    });
    await insert(BaseRecordComment, {
      recordId: record.id,
      authorUserId: actingUserId,
      authorEmployeeId: null,
      body: "Keep this with the record.",
    });
    await humanCall("PATCH", `/bases/${base.slug}/tables/${table.id}`, {
      archived: true,
    });

    const denied = await aiCall("delete_base_table", {
      baseSlug: base.slug,
      tableSlug: table.slug,
    });
    assert.equal(denied.status, 404);
    assert.ok(await AppDataSource.getRepository(BaseTable).findOneBy({ id: table.id }));

    const deleted = await humanCall("DELETE", `/bases/${base.slug}/tables/${table.id}`);
    assert.equal(deleted.status, 200);
    assert.equal(await AppDataSource.getRepository(BaseTable).countBy({ id: table.id }), 0);
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 0);
    assert.equal(await AppDataSource.getRepository(BaseField).countBy({ tableId: table.id }), 0);
    assert.equal(await AppDataSource.getRepository(BaseView).countBy({ tableId: table.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(BaseRecordComment).countBy({
        recordId: record.id,
      }),
      0,
    );
  });
});

describe("Base row delete cleanup", () => {
  /** Give the current record a comment and an attachment with real bytes. */
  async function seedRowContents(): Promise<string> {
    await insert(BaseRecordComment, {
      recordId: record.id,
      authorUserId: actingUserId,
      authorEmployeeId: null,
      body: "Goes with the row.",
    });
    const dir = path.join(config.dataDir, "companies", company.slug, "base-attachments");
    fsSync.mkdirSync(dir, { recursive: true });
    const storageKey = `${randomUUID()}.txt`;
    const bytesPath = path.join(dir, storageKey);
    fsSync.writeFileSync(bytesPath, "bytes");
    await insert(BaseRecordAttachment, {
      recordId: record.id,
      companyId: company.id,
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      storageKey,
      uploadedByUserId: actingUserId,
      uploadedByEmployeeId: null,
    });
    return bytesPath;
  }

  async function assertRowFullyGone(bytesPath: string): Promise<void> {
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ id: record.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(BaseRecordComment).countBy({ recordId: record.id }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseRecordAttachment).countBy({ recordId: record.id }),
      0,
    );
    assert.equal(fsSync.existsSync(bytesPath), false);
  }

  test("Member HTTP delete removes comments, attachment rows, and bytes", async () => {
    const bytesPath = await seedRowContents();
    const deleted = await humanCall(
      "DELETE",
      `/bases/${base.slug}/tables/${table.id}/rows/${record.id}`,
    );
    assert.equal(deleted.status, 200);
    await assertRowFullyGone(bytesPath);
  });

  test("MCP delete_base_row cleans up exactly like the HTTP route", async () => {
    const bytesPath = await seedRowContents();
    const deleted = await aiCall("delete_base_row", {
      baseSlug: base.slug,
      tableSlug: table.slug,
      rowId: record.id,
    });
    assert.equal(deleted.status, 200);
    await assertRowFullyGone(bytesPath);
  });

  test("code SDK deleteRecord cleans up exactly like the HTTP route", async () => {
    const bytesPath = await seedRowContents();
    const sdk = makeCodeSdk({
      companyId: company.id,
      deadlineAt: Date.now() + 5_000,
      log: () => {},
    });
    assert.equal(await sdk.base.deleteRecord(base.slug, table.slug, record.id), true);
    await assertRowFullyGone(bytesPath);
  });
});

describe("Base row id guards", () => {
  /**
   * SQLite cannot reproduce the failure the UUID_RE guard exists for: on
   * Postgres, comparing the uuid PK to a non-uuid string is a 22P02 type
   * error, while SQLite just returns no rows — so a plain 404 assertion
   * passes even with the guard deleted. Spy on the BaseRecord repository and
   * additionally require that the junk id never reaches findOneBy at all,
   * which pins the short-circuit the guard provides.
   */
  async function withJunkIdLookupSpy<T>(
    run: () => Promise<T>,
  ): Promise<{ result: T; junkLookups: number }> {
    const repo = AppDataSource.getRepository(BaseRecord);
    const original = repo.findOneBy;
    let junkLookups = 0;
    const mutable = repo as unknown as { findOneBy: typeof repo.findOneBy };
    mutable.findOneBy = ((where: unknown) => {
      const first = (Array.isArray(where) ? where[0] : where) as { id?: unknown } | undefined;
      if (first?.id === "not-a-uuid") junkLookups += 1;
      return original.call(repo, where as Parameters<typeof repo.findOneBy>[0]);
    }) as typeof repo.findOneBy;
    try {
      return { result: await run(), junkLookups };
    } finally {
      mutable.findOneBy = original;
    }
  }

  test("PATCH with a non-uuid row id is a 404 that never queries the uuid PK", async () => {
    const { result, junkLookups } = await withJunkIdLookupSpy(() =>
      humanCall("PATCH", `/bases/${base.slug}/tables/${table.id}/rows/not-a-uuid`, { data: {} }),
    );
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Row not found");
    assert.equal(junkLookups, 0);
  });

  test("DELETE with a non-uuid row id is a 404 that never queries the uuid PK", async () => {
    const { result, junkLookups } = await withJunkIdLookupSpy(() =>
      humanCall("DELETE", `/bases/${base.slug}/tables/${table.id}/rows/not-a-uuid`),
    );
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Row not found");
    assert.equal(junkLookups, 0);
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ id: record.id }), 1);
  });
});
