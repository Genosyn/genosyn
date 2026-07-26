import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseRecordComment } from "../db/entities/BaseRecordComment.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { BaseView } from "../db/entities/BaseView.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeBaseGrant } from "../db/entities/EmployeeBaseGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { basesRouter } from "./bases.js";
import { mcpInternalRouter } from "./mcpInternal.js";

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
  token = issueMcpToken(employee.id, company.id);
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
