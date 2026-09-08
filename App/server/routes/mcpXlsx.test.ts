import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";

import express from "express";
import JSZip from "jszip";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { Conversation } from "../db/entities/Conversation.js";
import { ConversationMessage } from "../db/entities/ConversationMessage.js";
import { EmployeeMailAccountGrant } from "../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailChatMessage } from "../db/entities/MailChatMessage.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { GmailMailbox } from "../services/mail/mailbox/gmail.js";
import type { MimeFields } from "../services/mail/mime.js";
import {
  drainAttachmentsForToken,
  issueMcpToken,
  noteAttachmentForToken,
  revokeMcpToken,
  tokenOwnsAttachment,
} from "../services/mcpTokens.js";
import { companyDir } from "../services/paths.js";
import { recordAttachmentBytes, resolveAttachmentFile } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { FakeMailbox } from "../test/fakeMailbox.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * Exercise the actual employee-facing HTTP flow with a real Excel package:
 * open the supplier's original, fill a copy, read it back and attach that same
 * copy to a reply draft. Only the external mailbox transport is replaced.
 * Attachment authority, persistence, staging, audit and all workbook code run
 * unchanged, so these tests cover the seams the pure workbook tests cannot.
 */
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const spreadsheetNs = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const relationshipNs = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationshipNs = "http://schemas.openxmlformats.org/package/2006/relationships";

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let requester: User;
let membership: Membership;
let mailbox: FakeMailbox;
let workbookBytes: Buffer;
const cleanupSlugs = new Set<string>();

type Cell = {
  cell: string;
  value: string | number | boolean | null;
  type: string;
  formula?: string;
  styleIndex?: number;
};
type ToolBody = {
  error?: string;
  issues?: unknown[];
  filename?: string;
  sheets?: {
    name: string;
    state: string;
    dimension: string;
    cells: Cell[];
    mergedRanges: string[];
  }[];
  definedNames?: { name: string; value?: string; formula?: string }[];
  warnings?: string[];
  truncated?: boolean;
  applied?: unknown[];
  attachment?: { id: string; filename: string; mimeType: string; sizeBytes: number };
};

async function supplierWorkbook(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="${packageRelationshipNs}"><Relationship Id="rId1" Type="${relationshipNs}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="${spreadsheetNs}" xmlns:r="${relationshipNs}"><sheets><sheet name="Supplier" sheetId="1" r:id="rId1"/><sheet name="Rates" sheetId="2" state="hidden" r:id="rId2"/></sheets><definedNames><definedName name="CompanyName">Supplier!$B$2</definedName></definedNames><calcPr calcId="191029"/></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships xmlns="${packageRelationshipNs}"><Relationship Id="rId1" Type="${relationshipNs}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${relationshipNs}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${relationshipNs}/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file(
    "xl/styles.xml",
    `<styleSheet xmlns="${spreadsheetNs}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1"/></xf></cellXfs></styleSheet>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<worksheet xmlns="${spreadsheetNs}"><dimension ref="A1:D6"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="40" customWidth="1"/></cols><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Supplier onboarding</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Registered company</t></is></c><c r="B2" s="1"/></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Employee count</t></is></c><c r="B3"><v>3</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>Terms accepted</t></is></c><c r="B4" t="b"><v>0</v></c></row>
<row r="5"><c r="A5" t="inlineStr"><is><t>Notes</t></is></c><c r="B5" t="inlineStr"><is><t>Old answer</t></is></c></row>
<row r="6"><c r="A6" t="inlineStr"><is><t>Annual count</t></is></c><c r="B6"><f>B3*12</f><v>36</v></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<worksheet xmlns="${spreadsheetNs}"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Reference rate</t></is></c><c r="B1"><v>1.25</v></c></row></sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

before(async () => {
  await initTestDb();
  workbookBytes = await supplierWorkbook();
  mock.method(
    GmailMailbox.prototype,
    "createDraft",
    (args: Parameters<FakeMailbox["createDraft"]>[0]) => mailbox.createDraft(args),
  );
  mock.method(GmailMailbox.prototype, "getMessage", (ref: string) => mailbox.getMessage(ref));
  mock.method(
    GmailMailbox.prototype,
    "getAttachmentBytes",
    (...args: Parameters<FakeMailbox["getAttachmentBytes"]>) => mailbox.getAttachmentBytes(...args),
  );
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
  mailbox = new FakeMailbox();
  company = await insert(Company, {
    name: "Supplier Forms Co",
    slug: `xlsx-${randomUUID()}`,
    ownerId: "owner",
  });
  cleanupSlugs.add(company.slug);
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Supplier onboarding",
    soulBody: "",
  });
  requester = await insert(User, {
    email: `member-${randomUUID()}@example.com`,
    passwordHash: "hash",
    name: "Delegating Member",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  membership = await insert(Membership, {
    companyId: company.id,
    userId: requester.id,
    role: "member",
    financeAccess: "none",
  });
  token = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: requester.id,
    requesterSessionVersion: requester.sessionVersion,
  });
});

afterEach(() => {
  for (const slug of cleanupSlugs) fs.rmSync(companyDir(slug), { recursive: true, force: true });
  cleanupSlugs.clear();
});

after(async () => {
  if (token) revokeMcpToken(token);
  mock.restoreAll();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function call(tool: string, body: unknown = {}, bearer: string | null = token) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as ToolBody };
}

async function store(
  overrides: Partial<{
    filename: string;
    mimeType: string;
    bytes: Buffer;
    uploadedByUserId: string | null;
    companyId: string;
    companySlug: string;
  }> = {},
): Promise<Attachment> {
  return recordAttachmentBytes({
    companyId: company.id,
    companySlug: company.slug,
    filename: "supplier.xlsx",
    mimeType: XLSX_MIME,
    bytes: workbookBytes,
    uploadedByUserId: requester.id,
    ...overrides,
  });
}

async function bytesOnDisk(attachmentId: string): Promise<Buffer> {
  const resolved = await resolveAttachmentFile(attachmentId, company.id);
  assert.ok(resolved, "the attachment must resolve to its stored workbook");
  return fs.promises.readFile(resolved.absPath);
}

function edits(attachmentId: string) {
  return {
    attachmentId,
    edits: [{ sheet: "Supplier", cell: "B2", value: "Analytical Engines Ltd" }],
  };
}

function cell(body: ToolBody, address: string, sheet = "Supplier"): Cell | undefined {
  return body.sheets
    ?.find((entry) => entry.name === sheet)
    ?.cells.find((entry) => entry.cell === address);
}

async function assertNoOutput(sourceId?: string): Promise<void> {
  assert.equal(await AppDataSource.getRepository(Attachment).count(), sourceId ? 1 : 0);
  assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ action: "xlsx.edit" }), 0);
  assert.deepEqual(drainAttachmentsForToken(token), []);
  if (sourceId) assert.deepEqual(await bytesOnDisk(sourceId), workbookBytes);
}

describe("Excel attachment authority", () => {
  test("requires a live authenticated employee turn", async () => {
    const source = await store();
    for (const bearer of [null, "unknown-token"]) {
      assert.equal((await call("read_xlsx", { attachmentId: source.id }, bearer)).status, 401);
      assert.equal((await call("edit_xlsx", edits(source.id), bearer)).status, 401);
    }
    await assertNoOutput(source.id);
  });

  test("the delegating Member can read and edit their own upload", async () => {
    const source = await store();
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 200);
    const edited = await call("edit_xlsx", edits(source.id));
    assert.equal(edited.status, 200, edited.body.error);
    assert.ok(edited.body.attachment);
  });

  test("a file imported from mail this turn is reachable without an uploader", async () => {
    const source = await store({ uploadedByUserId: null });
    noteAttachmentForToken(token, source.id);
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 200);
    assert.deepEqual(
      drainAttachmentsForToken(token),
      [],
      "reading an original does not offer it as output",
    );
    assert.equal((await call("edit_xlsx", edits(source.id))).status, 200);
  });

  test("another Member's unshared upload is indistinguishable from a missing attachment", async () => {
    const source = await store({ uploadedByUserId: randomUUID() });
    for (const tool of ["read_xlsx", "edit_xlsx"]) {
      const body = tool === "read_xlsx" ? { attachmentId: source.id } : edits(source.id);
      const denied = await call(tool, body);
      const missing = await call(tool, { ...body, attachmentId: randomUUID() });
      assert.equal(denied.status, 404);
      assert.deepEqual(denied, missing);
    }
    await assertNoOutput(source.id);
  });

  test("a shared mail conversation upload can be edited by the Member working with it", async () => {
    const message = await insert(MailChatMessage, {
      companyId: company.id,
      accountId: randomUUID(),
      threadId: randomUUID(),
      role: "user",
      content: "Fill the original Excel form",
      createdByUserId: "colleague",
    });
    const source = await store({ uploadedByUserId: "colleague" });
    await AppDataSource.getRepository(Attachment).update(
      { id: source.id },
      { messageId: message.id },
    );
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 200);
    assert.equal((await call("edit_xlsx", edits(source.id))).status, 200);
  });

  test("an assistant-produced file in the Member's own conversation stays reachable", async () => {
    const conversation = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: requester.id,
    });
    const message = await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Here is the form",
    });
    const source = await store({ uploadedByUserId: null });
    await AppDataSource.getRepository(Attachment).update(
      { id: source.id },
      { messageId: message.id },
    );
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 200);
    assert.equal((await call("edit_xlsx", edits(source.id))).status, 200);
  });

  test("another Member's private conversation remains private", async () => {
    const conversation = await insert(Conversation, {
      employeeId: employee.id,
      ownerUserId: "colleague",
    });
    const message = await insert(ConversationMessage, {
      conversationId: conversation.id,
      role: "assistant",
      content: "Private form",
    });
    const source = await store({ uploadedByUserId: null });
    await AppDataSource.getRepository(Attachment).update(
      { id: source.id },
      { messageId: message.id },
    );
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 404);
    assert.equal((await call("edit_xlsx", edits(source.id))).status, 404);
    await assertNoOutput(source.id);
  });

  test("a foreign company workbook is unavailable even if the current token names it", async () => {
    const foreignCompany = await insert(Company, {
      name: "Foreign",
      slug: `foreign-xlsx-${randomUUID()}`,
      ownerId: "other",
    });
    cleanupSlugs.add(foreignCompany.slug);
    const source = await store({ companyId: foreignCompany.id, companySlug: foreignCompany.slug });
    noteAttachmentForToken(token, source.id);
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 404);
    assert.equal((await call("edit_xlsx", edits(source.id))).status, 404);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
    assert.deepEqual(drainAttachmentsForToken(token), []);
  });

  test("revoked Member authority cannot continue reading or editing a staged source", async () => {
    const source = await store();
    noteAttachmentForToken(token, source.id);
    await AppDataSource.getRepository(Membership).delete({ id: membership.id });
    for (const [tool, body] of [
      ["read_xlsx", { attachmentId: source.id }],
      ["edit_xlsx", edits(source.id)],
    ] as const) {
      const response = await call(tool, body);
      assert.ok(response.status === 401 || response.status === 403);
    }
    await assertNoOutput(source.id);
  });

  test("Repository work sessions cannot reach company workbook tools", async () => {
    const source = await store();
    revokeMcpToken(token);
    token = issueMcpToken(employee.id, company.id, {
      authority: "member",
      requesterUserId: requester.id,
      requesterSessionVersion: 0,
      repositoryWorkSessionId: randomUUID(),
    });
    noteAttachmentForToken(token, source.id);
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 403);
    assert.equal((await call("edit_xlsx", edits(source.id))).status, 403);
    await assertNoOutput(source.id);
  });
});

describe("reading the original Excel form", () => {
  test("reports addressable cells, sheet visibility, merges, names and cached formulas", async () => {
    const source = await store();
    const read = await call("read_xlsx", { attachmentId: source.id });
    assert.equal(read.status, 200, read.body.error);
    assert.equal(read.body.filename, "supplier.xlsx");
    assert.deepEqual(
      read.body.sheets?.map((sheet) => sheet.name),
      ["Supplier", "Rates"],
    );
    assert.equal(read.body.sheets?.[1].state, "hidden");
    assert.deepEqual(read.body.sheets?.[0].mergedRanges, ["A1:D1"]);
    assert.equal(cell(read.body, "A2")?.value, "Registered company");
    assert.equal(cell(read.body, "B3")?.value, 3);
    assert.equal(cell(read.body, "B4")?.value, false);
    assert.equal(cell(read.body, "B6")?.formula, "B3*12");
    assert.equal(cell(read.body, "B6")?.value, 36);
    assert.equal(read.body.definedNames?.[0].name, "CompanyName");
    assert.ok(Array.isArray(read.body.warnings));
    assert.equal(read.body.truncated, false);
    await assertNoOutput(source.id);
  });

  test("accepts a correctly named workbook with a generic mail MIME type", async () => {
    const source = await store({ filename: "SUPPLIER.XLSX", mimeType: "application/octet-stream" });
    const read = await call("read_xlsx", { attachmentId: source.id });
    assert.equal(read.status, 200, read.body.error);
    assert.equal(cell(read.body, "A1")?.value, "Supplier onboarding");
  });

  test("sheet and range selection returns just the requested cells", async () => {
    const source = await store();
    const read = await call("read_xlsx", {
      attachmentId: source.id,
      sheet: "Supplier",
      range: "A3:B4",
    });
    assert.equal(read.status, 200, read.body.error);
    assert.deepEqual(read.body.sheets?.map((sheet) => sheet.name), ["Supplier"]);
    assert.deepEqual(
      read.body.sheets?.[0].cells.map((entry) => entry.cell),
      ["A3", "B3", "A4", "B4"],
    );
  });

  test("a cell budget signals truncation without losing the complete workbook on disk", async () => {
    const source = await store();
    const read = await call("read_xlsx", { attachmentId: source.id, maxCells: 2 });
    assert.equal(read.status, 200, read.body.error);
    assert.equal(read.body.truncated, true);
    assert.ok((read.body.sheets?.flatMap((sheet) => sheet.cells).length ?? 0) <= 2);
    await assertNoOutput(source.id);
  });

  test("a character budget bounds long cell values and reports the clipped preview", async () => {
    const zip = await JSZip.loadAsync(workbookBytes);
    const worksheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    zip.file(
      "xl/worksheets/sheet1.xml",
      worksheet.replace("Supplier onboarding", "Supplier information ".repeat(400)),
    );
    const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const source = await store({ bytes });
    const read = await call("read_xlsx", {
      attachmentId: source.id,
      sheet: "Supplier",
      maxChars: 1000,
    });
    assert.equal(read.status, 200, read.body.error);
    assert.equal(read.body.truncated, true);
    assert.ok(
      JSON.stringify(read.body).length <= 1100,
      "the filename adds only a small amount to the workbook preview budget",
    );
    assert.deepEqual(await bytesOnDisk(source.id), bytes);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
    assert.deepEqual(drainAttachmentsForToken(token), []);
  });
});

describe("editing and delivering a real Excel copy", () => {
  test("fills typed values atomically, preserves the original and stages an editable workbook", async () => {
    const source = await store();
    const edited = await call("edit_xlsx", {
      attachmentId: source.id,
      edits: [
        { sheet: "Supplier", cell: "$B$2", value: "Analytical Engines & Sons <UK>" },
        { sheet: "Supplier", cell: "b3", value: 12 },
        { sheet: "Supplier", cell: "B4", value: true },
        { sheet: "Supplier", cell: "B5", value: null },
      ],
    });
    assert.equal(edited.status, 200, edited.body.error);
    const output = edited.body.attachment;
    assert.ok(output);
    assert.notEqual(output.id, source.id);
    assert.equal(output.filename, "supplier-edited.xlsx");
    assert.equal(output.mimeType, XLSX_MIME);
    assert.equal(output.sizeBytes, (await bytesOnDisk(output.id)).length);
    assert.equal(edited.body.applied?.length, 4);
    assert.ok(Array.isArray(edited.body.warnings));
    assert.ok(tokenOwnsAttachment(token, output.id));
    assert.deepEqual(drainAttachmentsForToken(token), [output.id]);
    assert.deepEqual(drainAttachmentsForToken(token), []);
    assert.deepEqual(await bytesOnDisk(source.id), workbookBytes);
    const stored = await AppDataSource.getRepository(Attachment).findOneByOrFail({ id: output.id });
    assert.equal(stored.companyId, company.id);
    assert.equal(stored.uploadedByUserId, null);
    assert.equal(stored.messageId, null);

    const read = await call("read_xlsx", { attachmentId: output.id });
    assert.equal(read.status, 200, read.body.error);
    assert.equal(cell(read.body, "B2")?.value, "Analytical Engines & Sons <UK>");
    assert.equal(cell(read.body, "B2")?.styleIndex, 1);
    assert.equal(cell(read.body, "B3")?.value, 12);
    assert.equal(cell(read.body, "B4")?.value, true);
    assert.ok(cell(read.body, "B5") == null || cell(read.body, "B5")?.value === null);
    assert.equal(cell(read.body, "B6")?.formula, "B3*12");
    const originalZip = await JSZip.loadAsync(workbookBytes);
    const editedZip = await JSZip.loadAsync(await bytesOnDisk(output.id));
    for (const name of ["xl/styles.xml", "xl/worksheets/sheet2.xml"]) {
      assert.equal(
        await editedZip.file(name)?.async("string"),
        await originalZip.file(name)?.async("string"),
      );
    }
    assert.match(
      await editedZip.file("xl/worksheets/sheet1.xml")!.async("string"),
      /mergeCell ref="A1:D1"/,
    );
  });

  test("literal text beginning with equals stays text rather than becoming a formula", async () => {
    const source = await store();
    const edited = await call("edit_xlsx", {
      attachmentId: source.id,
      edits: [{ sheet: "Supplier", cell: "B2", value: "=This is a supplied label" }],
    });
    assert.equal(edited.status, 200, edited.body.error);
    const read = await call("read_xlsx", { attachmentId: edited.body.attachment!.id });
    assert.equal(cell(read.body, "B2")?.value, "=This is a supplied label");
    assert.equal(cell(read.body, "B2")?.formula, undefined);
  });

  test("normalizes output names to a simple Excel filename", async () => {
    const source = await store();
    for (const [requested, expected] of [
      ["completed.pdf", "completed.xlsx"],
      ["Filled form", "Filled form.xlsx"],
      ["folder\\result.xlsm", "result.xlsx"],
      ["/folder/answer.xlsx", "answer.xlsx"],
    ]) {
      const edited = await call("edit_xlsx", { ...edits(source.id), outputFilename: requested });
      assert.equal(edited.status, 200, edited.body.error);
      assert.equal(edited.body.attachment?.filename, expected);
      assert.equal(edited.body.attachment?.mimeType, XLSX_MIME);
    }
  });

  test("audit records attachment provenance and cell count without copying answer values", async () => {
    const source = await store();
    const edited = await call("edit_xlsx", edits(source.id));
    assert.equal(edited.status, 200, edited.body.error);
    const events = await AppDataSource.getRepository(AuditEvent).findBy({ action: "xlsx.edit" });
    assert.equal(events.length, 1);
    assert.equal(events[0].companyId, company.id);
    assert.equal(events[0].actorKind, "ai");
    assert.equal(events[0].actorEmployeeId, employee.id);
    assert.equal(events[0].targetId, edited.body.attachment!.id);
    assert.deepEqual(JSON.parse(events[0].metadataJson), {
      via: "mcp",
      sourceAttachmentId: source.id,
      cells: 1,
    });
    assert.doesNotMatch(events[0].metadataJson, /Analytical Engines/);
  });

  test("the filled workbook can be attached to a reply draft as the original Excel format", async () => {
    const account = await insert(MailAccount, {
      companyId: company.id,
      connectionId: randomUUID(),
      address: "ap@example.com",
    });
    const thread = await insert(MailThread, {
      companyId: company.id,
      accountId: account.id,
      gmailThreadId: "supplier-form",
      subject: "Supplier form",
    });
    const metadata = {
      partId: "1.1",
      attachmentId: "supplier-workbook",
      filename: "supplier.xlsx",
      mimeType: XLSX_MIME,
      size: workbookBytes.length,
    };
    const message = await insert(MailMessage, {
      companyId: company.id,
      accountId: account.id,
      threadId: thread.id,
      gmailMessageId: "supplier-original",
      gmailThreadId: thread.gmailThreadId,
      fromEmail: "supplier@example.com",
      toEmails: account.address,
      subject: thread.subject,
      sentAt: new Date(),
      attachmentsJson: JSON.stringify([metadata]),
    });
    await insert(EmployeeMailAccountGrant, {
      employeeId: employee.id,
      accountId: account.id,
      accessLevel: "draft",
    });
    mailbox.seed({
      ref: message.gmailMessageId,
      threadRef: thread.gmailThreadId,
      attachments: [metadata],
    });
    mailbox.attachments.set(metadata.attachmentId, workbookBytes);
    const imported = await call("read_mail_attachment", { messageId: message.id, index: 0 });
    assert.equal(imported.status, 200, imported.body.error);
    assert.ok(tokenOwnsAttachment(token, imported.body.attachment!.id));
    assert.deepEqual(drainAttachmentsForToken(token), []);
    const originalRead = await call("read_xlsx", { attachmentId: imported.body.attachment!.id });
    assert.equal(originalRead.status, 200, originalRead.body.error);
    assert.equal(cell(originalRead.body, "A2")?.value, "Registered company");
    const edited = await call("edit_xlsx", edits(imported.body.attachment!.id));
    assert.equal(edited.status, 200, edited.body.error);
    const draft = await call("create_mail_draft", {
      threadId: thread.id,
      bodyText: "The completed Excel form is attached.",
      attachments: [{ attachmentId: edited.body.attachment!.id }],
    });
    assert.equal(draft.status, 200, draft.body.error);
    const invocation = mailbox.calls.find((entry) => entry.method === "createDraft");
    assert.ok(invocation);
    const mime = invocation.args[0] as MimeFields;
    assert.equal(mime.to, "supplier@example.com");
    assert.equal(mime.attachments?.[0].filename, "supplier-edited.xlsx");
    assert.equal(mime.attachments?.[0].mimeType, XLSX_MIME);
    assert.deepEqual(mime.attachments?.[0].content, await bytesOnDisk(edited.body.attachment!.id));
    assert.equal(
      mailbox.calls.some((entry) => entry.method.startsWith("send")),
      false,
    );
  });

  test("Routine turns can fill their workbook and retain Run provenance", async () => {
    const source = await store({ uploadedByUserId: null });
    revokeMcpToken(token);
    const runId = randomUUID();
    token = issueMcpToken(employee.id, company.id, {
      authority: "employee",
      runId,
      routineId: randomUUID(),
    });
    noteAttachmentForToken(token, source.id);
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 200);
    const edited = await call("edit_xlsx", edits(source.id));
    assert.equal(edited.status, 200, edited.body.error);
    assert.ok(tokenOwnsAttachment(token, edited.body.attachment!.id));
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "xlsx.edit",
    });
    assert.equal(audit.runId, runId);
    assert.equal(audit.actorEmployeeId, employee.id);
  });
});

describe("Excel refusals leave no partial result", () => {
  test("an invalid later edit leaves the source, attachment table and staging untouched", async () => {
    const source = await store();
    const edited = await call("edit_xlsx", {
      attachmentId: source.id,
      edits: [
        ...edits(source.id).edits,
        { sheet: "Missing worksheet", cell: "B2", value: "Must not partially apply" },
      ],
    });
    assert.equal(edited.status, 400);
    assert.match(edited.body.error ?? "", /sheet/i);
    await assertNoOutput(source.id);
  });

  test("out-of-range cells, merged children and formula destinations are refused", async () => {
    const source = await store();
    for (const address of ["XFE1", "A1048577", "B1", "B6"]) {
      const edited = await call("edit_xlsx", {
        attachmentId: source.id,
        edits: [{ sheet: "Supplier", cell: address, value: "Answer" }],
      });
      assert.equal(edited.status, 400, `${address}: ${edited.body.error}`);
      await assertNoOutput(source.id);
    }
  });

  test("invalid sheet and range selections return caller-fixable failures", async () => {
    const source = await store();
    for (const options of [
      { range: "A1:B2" },
      { sheet: "Missing" },
      { sheet: "Supplier", range: "B4:A1" },
      { sheet: "Supplier", range: "A0" },
      { sheet: "Supplier", range: "XFE1" },
    ]) {
      const read = await call("read_xlsx", { attachmentId: source.id, ...options });
      assert.equal(read.status, 400, read.body.error);
    }
    await assertNoOutput(source.id);
  });

  test("corrupt or non-workbook uploads return a readable error without producing a file", async () => {
    for (const [filename, bytes] of [
      ["broken.xlsx", Buffer.from("not an Excel package")],
      ["notes.txt", Buffer.from("plain text")],
    ] as const) {
      const source = await store({ filename, bytes });
      const beforeCount = await AppDataSource.getRepository(Attachment).count();
      for (const tool of ["read_xlsx", "edit_xlsx"]) {
        const read = await call(
          tool,
          tool === "read_xlsx" ? { attachmentId: source.id } : edits(source.id),
        );
        assert.equal(read.status, 400);
        assert.ok(read.body.error);
      }
      assert.equal(await AppDataSource.getRepository(Attachment).count(), beforeCount);
      assert.deepEqual(await bytesOnDisk(source.id), bytes);
      assert.deepEqual(drainAttachmentsForToken(token), []);
    }
    assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({ action: "xlsx.edit" }), 0);
  });

  test("missing stored bytes are reported as missing for reads and edits", async () => {
    const source = await store();
    const resolved = await resolveAttachmentFile(source.id, company.id);
    assert.ok(resolved);
    await fs.promises.unlink(resolved.absPath);
    assert.equal((await call("read_xlsx", { attachmentId: source.id })).status, 404);
    assert.equal((await call("edit_xlsx", edits(source.id))).status, 404);
    assert.equal(await AppDataSource.getRepository(Attachment).count(), 1);
    assert.deepEqual(drainAttachmentsForToken(token), []);
  });

  test("read schema refuses missing, unknown, oversized and wrongly typed parameters", async () => {
    const source = await store();
    const invalid = [
      {},
      { attachmentId: "not-a-uuid" },
      { attachmentId: source.id, sheet: "" },
      { attachmentId: source.id, sheet: "x".repeat(32) },
      { attachmentId: source.id, maxCells: 0 },
      { attachmentId: source.id, maxCells: 1001 },
      { attachmentId: source.id, maxCells: 1.5 },
      { attachmentId: source.id, maxCells: "2" },
      { attachmentId: source.id, maxChars: 999 },
      { attachmentId: source.id, maxChars: 50001 },
      { attachmentId: source.id, unknown: true },
    ];
    for (const request of invalid)
      assert.equal((await call("read_xlsx", request)).status, 400, JSON.stringify(request));
    await assertNoOutput(source.id);
  });

  test("edit schema requires a bounded batch of explicit, typed cell values", async () => {
    const source = await store();
    const base = edits(source.id);
    const invalid = [
      {},
      { ...base, attachmentId: "not-a-uuid" },
      { ...base, edits: [] },
      { ...base, edits: Array.from({ length: 401 }, () => base.edits[0]) },
      { ...base, edits: [{ sheet: "Supplier", cell: "B2" }] },
      { ...base, edits: [{ sheet: "Supplier", cell: "B2", value: {} }] },
      { ...base, edits: [{ sheet: "Supplier", cell: "B2", value: [] }] },
      { ...base, edits: [{ sheet: "Supplier", cell: "B2", value: "x".repeat(32768) }] },
      { ...base, edits: [{ sheet: "", cell: "B2", value: "answer" }] },
      { ...base, edits: [{ sheet: "Supplier", cell: "B0", value: "answer" }] },
      { ...base, edits: [{ sheet: "Supplier", cell: "A1:B2", value: "answer" }] },
      { ...base, edits: [{ ...base.edits[0], formula: "1+1" }] },
      { ...base, outputFilename: "" },
      { ...base, outputFilename: "x".repeat(201) },
      { ...base, unknown: true },
    ];
    for (const request of invalid) assert.equal((await call("edit_xlsx", request)).status, 400);
    await assertNoOutput(source.id);
  });
});
