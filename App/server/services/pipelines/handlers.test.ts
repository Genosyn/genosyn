import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { Base } from "../../db/entities/Base.js";
import { BaseField } from "../../db/entities/BaseField.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import {
  closeTestDb,
  initTestDb,
  insert,
  resetTestDb,
  testCompanyId,
  testId,
} from "../../test/dbHarness.js";
import { HANDLERS } from "./handlers.js";
import { NodeOutputs, PipelineNode } from "./types.js";

/**
 * Covers the `action.createBaseRecord` node, whose `data` config names cells by
 * field name while storage stays keyed by field id. The id keys older Pipelines
 * were authored with are still accepted — there is no backfill — so the
 * fallback is the load-bearing case here.
 */

let cid: string;

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  cid = testCompanyId();
});
after(closeTestDb);

async function addRecord(
  data: unknown,
  opts: { tableSlug?: string } = {},
): Promise<{ outputs: NodeOutputs; lines: string[] }> {
  const handler = HANDLERS["action.createBaseRecord"];
  assert.ok(handler, "action.createBaseRecord handler is registered");
  const lines: string[] = [];
  const config = {
    baseSlug: "crm",
    tableSlug: opts.tableSlug ?? "leads",
    data,
  };
  const node: PipelineNode = { id: "n_row", type: "action.createBaseRecord", x: 0, y: 0, config };
  const result = await handler({
    companyId: cid,
    pipelineId: testId("pl"),
    pipelineName: "Test pipeline",
    runId: testId("run"),
    env: { trigger: { kind: "manual", payload: {} }, nodeOutputs: {} },
    log: (line) => lines.push(line),
    config,
    node,
  });
  return { outputs: result.outputs, lines };
}

async function storedCells(): Promise<Record<string, unknown>> {
  const rows = await AppDataSource.getRepository(BaseRecord).find();
  assert.equal(rows.length, 1, "exactly one record should have been appended");
  return JSON.parse(rows[0].dataJson) as Record<string, unknown>;
}

describe("action.createBaseRecord", () => {
  let nameFieldId: string;
  let emailFieldId: string;

  beforeEach(async () => {
    const base = await insert(Base, {
      companyId: cid,
      name: "CRM",
      slug: "crm",
      description: "",
      icon: "Database",
      color: "indigo",
      createdById: null,
    });
    const table = await insert(BaseTable, {
      baseId: base.id,
      name: "Leads",
      slug: "leads",
      sortOrder: 0,
      archivedAt: null,
    });
    const nameField = await insert(BaseField, {
      tableId: table.id,
      name: "Name",
      type: "text",
      configJson: "{}",
      isPrimary: true,
      sortOrder: 1,
    });
    const emailField = await insert(BaseField, {
      tableId: table.id,
      name: "Email",
      type: "email",
      configJson: "{}",
      isPrimary: false,
      sortOrder: 2,
    });
    nameFieldId = nameField.id;
    emailFieldId = emailField.id;
  });

  test("field names are stored as id-keyed cells", async () => {
    await addRecord('{"Name": "Ada", "Email": "ada@example.com"}');
    const data = await storedCells();
    assert.equal(data[nameFieldId], "Ada");
    assert.equal(data[emailFieldId], "ada@example.com");
  });

  test("field ids still work, so Pipelines saved before the change keep running", async () => {
    await addRecord(JSON.stringify({ [nameFieldId]: "Grace" }));
    assert.equal((await storedCells())[nameFieldId], "Grace");
  });

  test("one payload can mix a field name and a field id", async () => {
    await addRecord(JSON.stringify({ Name: "Ada", [emailFieldId]: "ada@example.com" }));
    const data = await storedCells();
    assert.equal(data[nameFieldId], "Ada");
    assert.equal(data[emailFieldId], "ada@example.com");
  });

  test("a field name matches without case", async () => {
    await addRecord('{"eMaIl": "ada@example.com"}');
    assert.equal((await storedCells())[emailFieldId], "ada@example.com");
  });

  test("an already-parsed object is accepted, not just a JSON string", async () => {
    await addRecord({ Name: "Ada" });
    assert.equal((await storedCells())[nameFieldId], "Ada");
  });

  test("an unknown field name fails the run and lists the available fields", async () => {
    await assert.rejects(
      () => addRecord('{"Emial": "ada@example.com"}'),
      /Unknown field "Emial".*Name.*Email/s,
    );
    assert.equal(await AppDataSource.getRepository(BaseRecord).count(), 0);
  });

  test("an unknown field id is skipped and logged, because the column was deleted", async () => {
    const stale = "11111111-2222-3333-4444-555555555555";
    const { lines } = await addRecord(JSON.stringify({ [stale]: "orphan", Name: "Ada" }));
    const data = await storedCells();
    assert.equal(data[nameFieldId], "Ada");
    assert.ok(!(stale in data), "the stale cell should not have been written");
    assert.ok(
      lines.some((line) => line.includes(stale) && line.includes("no such field")),
      lines.join(" | "),
    );
  });

  test("null and empty values clear rather than store, as everywhere else", async () => {
    await addRecord('{"Name": "Ada", "Email": ""}');
    const data = await storedCells();
    assert.equal(data[nameFieldId], "Ada");
    assert.ok(!(emailFieldId in data), "an empty string should not have been stored");
  });

  test("duplicate field names resolve to the first field on the table", async () => {
    const table = await AppDataSource.getRepository(BaseTable).findOneByOrFail({ slug: "leads" });
    const later = await insert(BaseField, {
      tableId: table.id,
      name: "Name",
      type: "text",
      configJson: "{}",
      isPrimary: false,
      sortOrder: 9,
    });
    await addRecord('{"Name": "Ada"}');
    const data = await storedCells();
    assert.equal(data[nameFieldId], "Ada");
    assert.ok(!(later.id in data), "the lower sortOrder field wins");
  });

  test("outputs echo the keys the author wrote", async () => {
    const { outputs } = await addRecord('{"Name": "Ada"}');
    assert.deepEqual(outputs.data, { Name: "Ada" });
    assert.equal(typeof outputs.recordId, "string");
  });

  test("a data blob that is not an object is refused", async () => {
    await assert.rejects(() => addRecord('["Ada"]'), /data must be a JSON object/);
  });

  test("an archived table is not writable", async () => {
    const base = await AppDataSource.getRepository(Base).findOneByOrFail({ slug: "crm" });
    await insert(BaseTable, {
      baseId: base.id,
      name: "Old leads",
      slug: "old-leads",
      sortOrder: 1,
      archivedAt: new Date(),
    });
    await assert.rejects(
      () => addRecord("{}", { tableSlug: "old-leads" }),
      /Table "old-leads" not found/,
    );
  });
});
