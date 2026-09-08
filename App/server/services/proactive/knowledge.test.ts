import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Base } from "../../db/entities/Base.js";
import { BaseRecord } from "../../db/entities/BaseRecord.js";
import { BaseTable } from "../../db/entities/BaseTable.js";
import { Chart } from "../../db/entities/Chart.js";
import { EmployeeBaseGrant } from "../../db/entities/EmployeeBaseGrant.js";
import { EmployeeChartGrant } from "../../db/entities/EmployeeChartGrant.js";
import { EmployeeNoteGrant } from "../../db/entities/EmployeeNoteGrant.js";
import { EmployeeNotebookGrant } from "../../db/entities/EmployeeNotebookGrant.js";
import { EmployeeResourceGrant } from "../../db/entities/EmployeeResourceGrant.js";
import { Note } from "../../db/entities/Note.js";
import { Notebook } from "../../db/entities/Notebook.js";
import { Resource } from "../../db/entities/Resource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { getKnowledgeOpportunities } from "./knowledge.js";

const now = new Date("2026-09-08T12:00:00.000Z");
const at = (days: number) => new Date(now.getTime() + days * 86_400_000);
let companyId: string;
let employee: AIEmployee;
let notebook: Notebook;
before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = randomUUID();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Maya",
    role: "Operations",
    slug: "maya",
  });
  notebook = await insert(Notebook, { companyId, title: "Handbook", slug: "handbook" });
});
const opportunities = () => getKnowledgeOpportunities(companyId, employee.id, now);
const addNote = (patch: Partial<Note> = {}) =>
  insert(Note, {
    companyId,
    notebookId: notebook.id,
    title: "Handbook section",
    slug: randomUUID(),
    body: "PRIVATE NOTE BODY",
    updatedAt: at(-1),
    ...patch,
  });
const addChart = (patch: Partial<Chart> = {}) =>
  insert(Chart, {
    companyId,
    title: "Operating metric",
    slug: randomUUID(),
    connectionId: randomUUID(),
    sql: "PRIVATE QUERY",
    description: "PRIVATE DESCRIPTION",
    updatedAt: at(-1),
    ...patch,
  });
const addResource = (patch: Partial<Resource> = {}) =>
  insert(Resource, {
    companyId,
    title: "Reference",
    slug: randomUUID(),
    status: "ready",
    bodyText: "PRIVATE RESOURCE BODY",
    errorMessage: "PRIVATE ERROR",
    updatedAt: at(-1),
    ...patch,
  });

test("empty knowledge cues expose no hidden counts and reject stale or cross-company employees", async () => {
  const result = await opportunities();
  assert.deepEqual(Object.keys(result), ["notes", "bases", "charts", "resources"]);
  for (const section of Object.values(result))
    assert.deepEqual(section, { items: [], truncated: false });
  await assert.rejects(getKnowledgeOpportunities(randomUUID(), employee.id, now), /not found/);
  await assert.rejects(getKnowledgeOpportunities(companyId, "invalid", now), /not found/);
  await assert.rejects(
    getKnowledgeOpportunities(companyId, employee.id, new Date("invalid")),
    /Invalid opportunity time/,
  );
});

test("Notes inherit current ancestor and Notebook Grants before limiting and never infer age means an edit", async () => {
  for (let i = 0; i < 8; i++) await addNote({ updatedAt: now });
  const parent = await addNote({ updatedAt: at(-20) });
  const child = await addNote({ parentId: parent.id });
  const direct = await addNote();
  await insert(EmployeeNoteGrant, {
    employeeId: employee.id,
    noteId: parent.id,
    accessLevel: "read",
  });
  const directGrant = await insert(EmployeeNoteGrant, {
    employeeId: employee.id,
    noteId: direct.id,
    accessLevel: "write",
  });
  await addNote({ parentId: parent.id, archivedAt: at(-1) });
  await addNote({ parentId: parent.id, updatedAt: at(-8) });
  await addNote({ parentId: parent.id, updatedAt: at(1) });
  const foreign = await addNote({ companyId: randomUUID() });
  await insert(EmployeeNoteGrant, {
    employeeId: employee.id,
    noteId: foreign.id,
    accessLevel: "read",
  });
  let result = await opportunities();
  assert.deepEqual(
    new Set(result.notes.items.map((row) => row.id)),
    new Set([child.id, direct.id]),
  );
  assert.equal(result.notes.truncated, false);
  assert.ok(result.notes.items.every((row) => /not evidence it needs rewriting/.test(row.reason)));
  assert.equal(result.notes.items.find((row) => row.id === child.id)!.locator, child.slug);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await AppDataSource.getRepository(EmployeeNoteGrant).delete(directGrant.id);
  assert.deepEqual(
    (await opportunities()).notes.items.map((row) => row.id),
    [child.id],
  );
  const notebookGrant = await insert(EmployeeNotebookGrant, {
    employeeId: employee.id,
    notebookId: notebook.id,
    accessLevel: "read",
  });
  result = await opportunities();
  assert.equal(result.notes.items.length, 5);
  assert.equal(result.notes.truncated, true);
  await AppDataSource.getRepository(EmployeeNotebookGrant).delete(notebookGrant.id);
  assert.deepEqual(
    (await opportunities()).notes.items.map((row) => row.id),
    [child.id],
  );
});

test("Base cues use real active-table and record timestamps, exclude hidden/archived data, and remain metadata-only", async () => {
  const base = await insert(Base, {
    companyId,
    name: "Operations",
    slug: "operations",
    createdAt: at(-30),
  });
  const grant = await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: base.id });
  const changed = await insert(BaseTable, {
    baseId: base.id,
    name: "Customers",
    slug: "customers",
    createdAt: at(-30),
  });
  const record = await insert(BaseRecord, {
    tableId: changed.id,
    dataJson: "PRIVATE BASE DATA",
    updatedAt: at(-0.5),
  });
  const fresh = await insert(BaseTable, {
    baseId: base.id,
    name: "Intake",
    slug: "intake",
    createdAt: at(-1),
  });
  await insert(BaseTable, {
    baseId: base.id,
    name: "Old empty table",
    slug: "old",
    createdAt: at(-30),
  });
  const archived = await insert(BaseTable, {
    baseId: base.id,
    name: "Archived",
    slug: "archived",
    createdAt: at(-1),
    archivedAt: now,
  });
  await insert(BaseRecord, {
    tableId: archived.id,
    dataJson: "PRIVATE ARCHIVED DATA",
    updatedAt: now,
  });
  for (const foreign of [false, true]) {
    const hidden = await insert(Base, {
      companyId: foreign ? randomUUID() : companyId,
      name: "Hidden",
      slug: randomUUID(),
    });
    if (foreign) await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: hidden.id });
    for (let i = 0; i < 8; i++)
      await insert(BaseTable, {
        baseId: hidden.id,
        name: "Hidden table",
        slug: randomUUID(),
        createdAt: now,
      });
  }
  const result = await opportunities();
  assert.deepEqual(
    result.bases.items.map((row) => row.id),
    [changed.id, fresh.id],
  );
  assert.equal(result.bases.truncated, false);
  assert.equal(result.bases.items[0].updatedAt, record.updatedAt.toISOString());
  assert.equal(result.bases.items[0].locator, base.slug);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await AppDataSource.getRepository(EmployeeBaseGrant).delete(grant.id);
  assert.deepEqual((await opportunities()).bases, { items: [], truncated: false });
});

test("Charts are recent-definition review cues, never invented data freshness or query-failure claims", async () => {
  const visible = await addChart();
  const grant = await insert(EmployeeChartGrant, {
    employeeId: employee.id,
    chartId: visible.id,
    accessLevel: "read",
  });
  for (let i = 0; i < 8; i++) await addChart({ updatedAt: now });
  for (const patch of [{ companyId: randomUUID() }, { updatedAt: at(-8) }, { updatedAt: at(1) }]) {
    const excluded = await addChart(patch);
    await insert(EmployeeChartGrant, {
      employeeId: employee.id,
      chartId: excluded.id,
      accessLevel: "write",
    });
  }
  const result = await opportunities();
  assert.deepEqual(
    result.charts.items.map((row) => row.id),
    [visible.id],
  );
  assert.equal(result.charts.truncated, false);
  assert.match(
    result.charts.items[0].reason,
    /does not assert that its data changed or its query failed/,
  );
  assert.equal(result.charts.items[0].locator, visible.slug);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.equal(
    (await AppDataSource.getRepository(Chart).findOneByOrFail({ id: visible.id })).sql,
    "PRIVATE QUERY",
  );
  await AppDataSource.getRepository(EmployeeChartGrant).delete(grant.id);
  assert.deepEqual((await opportunities()).charts, { items: [], truncated: false });
});

test("Resources prioritize recorded ingestion failures, with current Grants and no raw source content", async () => {
  const failed = await addResource({ status: "failed", updatedAt: at(-30) });
  const ready = await addResource();
  const grants = [];
  for (const resource of [failed, ready])
    grants.push(
      await insert(EmployeeResourceGrant, {
        employeeId: employee.id,
        resourceId: resource.id,
        accessLevel: "read",
      }),
    );
  for (let i = 0; i < 8; i++) await addResource({ status: "failed", updatedAt: now });
  for (const patch of [
    { companyId: randomUUID() },
    { updatedAt: at(-8) },
    { status: "pending" as const },
    { updatedAt: at(1) },
  ]) {
    const excluded = await addResource(patch);
    await insert(EmployeeResourceGrant, {
      employeeId: employee.id,
      resourceId: excluded.id,
      accessLevel: "edit",
    });
  }
  const result = await opportunities();
  assert.deepEqual(
    result.resources.items.map((row) => row.id),
    [failed.id, ready.id],
  );
  assert.match(result.resources.items[0].reason, /recorded ingestion failure/);
  assert.equal(result.resources.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await AppDataSource.getRepository(EmployeeResourceGrant).delete(grants.map((grant) => grant.id));
  assert.deepEqual((await opportunities()).resources, { items: [], truncated: false });
});

test("each knowledge source caps its visible rows and reports truncation accurately", async () => {
  await insert(EmployeeNotebookGrant, {
    employeeId: employee.id,
    notebookId: notebook.id,
    accessLevel: "read",
  });
  const base = await insert(Base, {
    companyId,
    name: "Operations",
    slug: "operations",
    createdAt: at(-1),
  });
  await insert(EmployeeBaseGrant, { employeeId: employee.id, baseId: base.id });
  for (let i = 0; i < 6; i++) {
    await addNote();
    await insert(BaseTable, {
      baseId: base.id,
      name: `Table ${i}`,
      slug: `table-${i}`,
      createdAt: at(-1),
    });
    const chart = await addChart();
    await insert(EmployeeChartGrant, {
      employeeId: employee.id,
      chartId: chart.id,
      accessLevel: "read",
    });
    const resource = await addResource();
    await insert(EmployeeResourceGrant, {
      employeeId: employee.id,
      resourceId: resource.id,
      accessLevel: "read",
    });
  }
  for (const section of Object.values(await opportunities())) {
    assert.equal(section.items.length, 5);
    assert.equal(section.truncated, true);
  }
});
