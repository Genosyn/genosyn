import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";
import { PDFDocument } from "pdf-lib";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeResourceGrant } from "../db/entities/EmployeeResourceGrant.js";
import { EmployeeSigningGrant } from "../db/entities/EmployeeSigningGrant.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Resource } from "../db/entities/Resource.js";
import { errorHandler } from "../middleware/error.js";
import { resolveBrowserExecutable } from "../services/browserProfile.js";
import { DOCX_MIME } from "../services/docxPackage.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { companyDir } from "../services/paths.js";
import { resolveResourceFile } from "../services/resources.js";
import { recordAttachmentBytes } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { docxFixture, para, table } from "../test/docxFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The errand this feature exists for, end to end.
 *
 * A counterparty emails an NDA as a Word document. The employee could read it,
 * quote it and even edit it — and then had to stop, because signing takes a
 * PDF Resource and nothing else and filing a file as a Resource was a human's
 * job. So the answer to "prepare this for signature" was a request that a
 * human open Word, re-save as PDF, and upload it, which is the whole errand
 * minus the part the employee was hired for.
 *
 * What is asserted below is that chain — convert, file, draft — plus the
 * guards that must not move with it. Filing a Resource from bytes is a new
 * write for an AI Employee, so its tenancy, its authorship and its evidence
 * matter more than the happy path: a PDF an employee filed must be traceable
 * to that employee, because the next thing that happens to it is a human
 * being asked to send it to a customer for signature.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let otherCompany: Company;
let employee: AIEmployee;
let teammate: AIEmployee;

/** Chromium prints the PDF; where there is no browser there is nothing to assert. */
const browser = resolveBrowserExecutable();
const needsBrowser = browser
  ? {}
  : { skip: "no Chrome or Chromium on this host to render a PDF with" };

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
    name: "Analytical Engines Ltd",
    slug: `engines-${randomUUID()}`,
    ownerId: "owner-1",
  });
  otherCompany = await insert(Company, {
    name: "Somebody Else Ltd",
    slug: `others-${randomUUID()}`,
    ownerId: "owner-2",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "Contract coordinator",
    soulBody: "",
  });
  teammate = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada Reviewer",
    slug: "ada",
    role: "Legal review",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

afterEach(async () => {
  for (const slug of [company?.slug, otherCompany?.slug]) {
    if (slug) await fs.promises.rm(companyDir(slug), { recursive: true, force: true });
  }
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

type ToolBody = {
  error?: string;
  attachment?: { id: string; filename: string; mimeType: string; sizeBytes: number };
  warnings?: string[];
  note?: string;
  resource?: {
    id: string;
    slug: string;
    title: string;
    sourceKind: string;
    sourceFilename: string | null;
    status: string;
    bytes: number;
    bodyText?: string;
  };
  envelope?: { id: string; title: string; status: string };
};

async function call(tool: string, body: unknown = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as ToolBody };
}

/** The NDA as it arrives: a Word document, with the parts a contract has. */
async function ndaBytes(): Promise<Buffer> {
  return docxFixture({
    body: [
      para("Mutual Non-Disclosure Agreement", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      para("Each party may disclose Confidential Information to the other."),
      table([
        ["Party", "Signatory"],
        ["Analytical Engines Ltd", ""],
        ["Nawaz Dhandala", ""],
      ]),
    ].join(""),
  });
}

async function storeAttachment(params: {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  companyId?: string;
  companySlug?: string;
}): Promise<Attachment> {
  return recordAttachmentBytes({
    companyId: params.companyId ?? company.id,
    companySlug: params.companySlug ?? company.slug,
    filename: params.filename,
    mimeType: params.mimeType,
    bytes: params.bytes,
    uploadedByUserId: null,
  });
}

async function realPdfBytes(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  page.drawText("Mutual non-disclosure agreement", { x: 48, y: 730, size: 18 });
  return Buffer.from(await pdf.save());
}

async function grantSigning(accessLevel: "read" | "draft" | "send") {
  return insert(EmployeeSigningGrant, {
    companyId: company.id,
    employeeId: employee.id,
    accessLevel,
  });
}

describe("convert_to_pdf", () => {
  test("turns an emailed Word contract into a PDF attachment", needsBrowser, async () => {
    const source = await storeAttachment({
      filename: "mutual-nda.docx",
      mimeType: DOCX_MIME,
      bytes: await ndaBytes(),
    });

    const result = await call("convert_to_pdf", { attachmentId: source.id });
    assert.equal(result.status, 200, result.body.error);
    assert.equal(result.body.attachment?.filename, "mutual-nda.pdf");
    assert.equal(result.body.attachment?.mimeType, "application/pdf");

    // Not "a file was written" — a file a PDF reader will open. Anything else
    // fails later, at the signer, which is the worst place to find out.
    const row = await AppDataSource.getRepository(Attachment).findOneByOrFail({
      id: result.body.attachment!.id,
    });
    const abs = `${companyDir(company.slug)}/attachments/${row.storageKey}`;
    const written = await fs.promises.readFile(abs);
    assert.equal(written.subarray(0, 5).toString("latin1"), "%PDF-");
    const parsed = await PDFDocument.load(written);
    assert.ok(parsed.getPageCount() >= 1);
  });

  test("a clean document reports no warnings to hedge with", needsBrowser, async () => {
    const source = await storeAttachment({
      filename: "mutual-nda.docx",
      mimeType: DOCX_MIME,
      bytes: await ndaBytes(),
    });
    const result = await call("convert_to_pdf", { attachmentId: source.id });
    assert.deepEqual(result.body.warnings, []);
  });

  test(
    "a document with a running footer says the footer did not come across",
    needsBrowser,
    async () => {
      const source = await storeAttachment({
        filename: "nda-with-footer.docx",
        mimeType: DOCX_MIME,
        bytes: await docxFixture({
          body: para("Each party may disclose Confidential Information."),
          parts: { footer1: para("Commercial in confidence") },
        }),
      });
      const result = await call("convert_to_pdf", { attachmentId: source.id });
      assert.equal(result.status, 200, result.body.error);
      assert.ok(
        (result.body.warnings ?? []).some((w) => /headers or footers/i.test(w)),
        `expected a footer warning, got ${JSON.stringify(result.body.warnings)}`,
      );
    },
  );

  test("refuses a PDF instead of quietly re-rendering one", async () => {
    const source = await storeAttachment({
      filename: "already.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
    });
    const result = await call("convert_to_pdf", { attachmentId: source.id });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /already a PDF/i);
  });

  test("refuses a file that is not a Word document, with a message a model can act on", async () => {
    const source = await storeAttachment({
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("just some notes"),
    });
    const result = await call("convert_to_pdf", { attachmentId: source.id });
    assert.equal(result.status, 400);
    assert.ok((result.body.error ?? "").length > 0);
  });

  test("cannot reach another company's attachment", async () => {
    const foreign = await storeAttachment({
      filename: "theirs.docx",
      mimeType: DOCX_MIME,
      bytes: await ndaBytes(),
      companyId: otherCompany.id,
      companySlug: otherCompany.slug,
    });
    const result = await call("convert_to_pdf", { attachmentId: foreign.id });
    assert.equal(result.status, 404);
  });

  test("validates its arguments", async () => {
    assert.equal((await call("convert_to_pdf", {})).status, 400);
    assert.equal((await call("convert_to_pdf", { attachmentId: "not-a-uuid" })).status, 400);
    assert.equal(
      (await call("convert_to_pdf", { attachmentId: randomUUID(), nonsense: true })).status,
      400,
    );
  });
});

describe("create_resource — filing a file", () => {
  test("files a PDF attachment as a PDF Resource with its bytes on disk", async () => {
    const source = await storeAttachment({
      filename: "mutual-nda.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
    });

    const result = await call("create_resource", {
      sourceKind: "file",
      attachmentId: source.id,
      tags: "legal, nda",
    });
    assert.equal(result.status, 200, result.body.error);
    assert.equal(result.body.resource?.sourceKind, "pdf");
    assert.equal(result.body.resource?.sourceFilename, "mutual-nda.pdf");
    // The title falls back to a readable version of the filename.
    assert.equal(result.body.resource?.title, "mutual nda");

    const row = await AppDataSource.getRepository(Resource).findOneByOrFail({
      id: result.body.resource!.id,
    });
    assert.ok(row.storageKey, "the Resource has no bytes behind it");
    assert.ok(resolveResourceFile(company.slug, row.storageKey!), "the bytes are not on disk");
  });

  test("a file whose text will not come out is still filed, and says it is not searchable", async () => {
    // A silent success is worst here: signing reads the bytes and works, so the
    // employee would report the document as filed and indexed while nobody can
    // ever find it by searching. Bytes that are not a PDF at all stand in for
    // the ordinary version of this — a scan with no text layer — because they
    // fail extraction the same way and, unlike a scan, they fail it every time.
    const source = await storeAttachment({
      filename: "scanned-nda.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("this was a fax once"),
    });
    const result = await call("create_resource", { sourceKind: "file", attachmentId: source.id });
    assert.equal(result.status, 200, result.body.error);
    assert.equal(result.body.resource?.status, "failed");
    assert.match(result.body.note ?? "", /can be used for signing/i);
    assert.match(result.body.note ?? "", /no text could be extracted/i);

    const row = await AppDataSource.getRepository(Resource).findOneByOrFail({
      id: result.body.resource!.id,
    });
    assert.ok(resolveResourceFile(company.slug, row.storageKey!), "the bytes were not kept");
  });

  test("records the employee as the author, not a phantom human", async () => {
    const source = await storeAttachment({
      filename: "mutual-nda.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
    });
    const result = await call("create_resource", { sourceKind: "file", attachmentId: source.id });
    const row = await AppDataSource.getRepository(Resource).findOneByOrFail({
      id: result.body.resource!.id,
    });
    assert.equal(row.createdByEmployeeId, employee.id);
    assert.equal(row.createdById, null);
  });

  test("writes the evidence a human will want when asked to send it", async () => {
    const source = await storeAttachment({
      filename: "mutual-nda.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
    });
    const result = await call("create_resource", { sourceKind: "file", attachmentId: source.id });

    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      targetId: result.body.resource!.id,
      action: "resource.create",
    });
    assert.equal(audit.actorEmployeeId, employee.id);
    const metadata = JSON.parse(audit.metadataJson || "{}") as Record<string, unknown>;
    assert.equal(metadata.fromAttachmentId, source.id);
    assert.equal(metadata.sourceFilename, "mutual-nda.pdf");

    const journalEntries = await AppDataSource.getRepository(JournalEntry).findBy({
      employeeId: employee.id,
    });
    assert.ok(
      journalEntries.some((entry) => /Filed from the file "mutual-nda\.pdf"/.test(entry.body)),
      "the journal does not say the Resource came from a file",
    );
  });

  test("the author keeps full control and teammates start at read", async () => {
    const source = await storeAttachment({
      filename: "mutual-nda.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
    });
    const result = await call("create_resource", { sourceKind: "file", attachmentId: source.id });
    const grants = await AppDataSource.getRepository(EmployeeResourceGrant).findBy({
      resourceId: result.body.resource!.id,
    });
    const byEmployee = new Map(grants.map((g) => [g.employeeId, g.accessLevel]));
    assert.equal(byEmployee.get(employee.id), "delete");
    assert.equal(byEmployee.get(teammate.id), "read");
  });

  test("a Word document files as a text Resource with its prose extracted", async () => {
    const source = await storeAttachment({
      filename: "mutual-nda.docx",
      mimeType: DOCX_MIME,
      bytes: await ndaBytes(),
    });
    const result = await call("create_resource", {
      sourceKind: "file",
      attachmentId: source.id,
      title: "Mutual NDA (Word)",
    });
    assert.equal(result.status, 200, result.body.error);
    assert.equal(result.body.resource?.title, "Mutual NDA (Word)");
    // Decoding a zip as UTF-8 would fill the body with mojibake that search
    // then matches against, which is worse than an empty body.
    assert.match(result.body.resource?.bodyText ?? "", /Confidential Information/);
  });

  test("cannot file another company's attachment", async () => {
    const foreign = await storeAttachment({
      filename: "theirs.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
      companyId: otherCompany.id,
      companySlug: otherCompany.slug,
    });
    const result = await call("create_resource", {
      sourceKind: "file",
      attachmentId: foreign.id,
    });
    assert.equal(result.status, 404);
    assert.equal(await AppDataSource.getRepository(Resource).count(), 0);
  });

  test("a video file is still a human's upload", async () => {
    const source = await storeAttachment({
      filename: "walkthrough.mp4",
      mimeType: "video/mp4",
      bytes: Buffer.from("not really a video"),
    });
    const result = await call("create_resource", { sourceKind: "file", attachmentId: source.id });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /transcript/i);
    assert.equal(await AppDataSource.getRepository(Resource).count(), 0);
  });

  test("validates its arguments", async () => {
    assert.equal((await call("create_resource", { sourceKind: "file" })).status, 400);
    assert.equal(
      (await call("create_resource", { sourceKind: "file", attachmentId: "nope" })).status,
      400,
    );
    // The text and url forms still validate the way they always did.
    assert.equal((await call("create_resource", { sourceKind: "text" })).status, 400);
    assert.equal((await call("create_resource", { sourceKind: "url" })).status, 400);
  });
});

describe("the whole errand", () => {
  test("a filed PDF Resource is one a signing request can be drafted from", async () => {
    await grantSigning("draft");
    const source = await storeAttachment({
      filename: "mutual-nda.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
    });
    const filed = await call("create_resource", { sourceKind: "file", attachmentId: source.id });
    assert.equal(filed.status, 200, filed.body.error);

    const draft = await call("draft_signature_envelope", {
      resourceSlug: filed.body.resource!.slug,
      title: "Mutual NDA — signature",
      message: "Please review and sign.",
      routingMode: "parallel",
      recipients: [
        {
          name: "Nawaz Dhandala",
          email: "nawaz@example.test",
          role: "signer",
          fields: [
            {
              type: "signature",
              label: "Signature",
              pageNumber: 1,
              x: 0.1,
              y: 0.75,
              width: 0.3,
              height: 0.08,
            },
            {
              type: "date",
              label: "Date",
              pageNumber: 1,
              x: 0.5,
              y: 0.75,
              width: 0.2,
              height: 0.05,
            },
          ],
        },
      ],
    });
    assert.equal(draft.status, 200, draft.body.error);
    // Drafting is where the employee's authority stops: nothing was emailed,
    // and sending needs a grant this employee does not hold.
    assert.equal(draft.body.envelope?.status, "draft");
  });

  test("filing a Resource does not hand the employee the authority to send it", async () => {
    await grantSigning("draft");
    const source = await storeAttachment({
      filename: "mutual-nda.pdf",
      mimeType: "application/pdf",
      bytes: await realPdfBytes(),
    });
    const filed = await call("create_resource", { sourceKind: "file", attachmentId: source.id });
    const draft = await call("draft_signature_envelope", {
      resourceSlug: filed.body.resource!.slug,
      title: "Mutual NDA — signature",
      routingMode: "parallel",
      recipients: [
        {
          name: "Nawaz Dhandala",
          email: "nawaz@example.test",
          role: "signer",
          fields: [
            {
              type: "signature",
              label: "Signature",
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

    const sent = await call("send_signature_envelope", {
      envelopeId: draft.body.envelope!.id,
      expectedUpdatedAt: new Date().toISOString(),
    });
    assert.equal(sent.status, 403);
  });

  test(
    "from a Word attachment to a signing draft without a human touching a file",
    needsBrowser,
    async () => {
      await grantSigning("draft");
      const emailed = await storeAttachment({
        filename: "mutual-nda.docx",
        mimeType: DOCX_MIME,
        bytes: await ndaBytes(),
      });

      const converted = await call("convert_to_pdf", { attachmentId: emailed.id });
      assert.equal(converted.status, 200, converted.body.error);

      const filed = await call("create_resource", {
        sourceKind: "file",
        attachmentId: converted.body.attachment!.id,
        title: "Mutual NDA",
        tags: "legal",
      });
      assert.equal(filed.status, 200, filed.body.error);
      assert.equal(filed.body.resource?.sourceKind, "pdf");
      // A real converted contract does index — this is the assertion that would
      // catch a conversion producing pages of image with no text layer.
      assert.equal(filed.body.resource?.status, "ready");
      assert.match(filed.body.resource?.bodyText ?? "", /Confidential Information/);

      const draft = await call("draft_signature_envelope", {
        resourceSlug: filed.body.resource!.slug,
        title: "Mutual NDA — signature",
        routingMode: "parallel",
        recipients: [
          {
            name: "Nawaz Dhandala",
            email: "nawaz@example.test",
            role: "signer",
            fields: [
              {
                type: "signature",
                label: "Signature",
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
      assert.equal(draft.body.envelope?.status, "draft");
    },
  );
});
