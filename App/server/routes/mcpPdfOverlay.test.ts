import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken, tokenOwnsAttachment } from "../services/mcpTokens.js";
import { readPdfLayout } from "../services/pdfLayout.js";
import { recordAttachmentBytes, resolveAttachmentFile } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The tools for a form nobody made fillable.
 *
 * `read_pdf_fields` answers "nothing" on these documents, so the pair under
 * test is the replacement: read where the printed labels sit, then draw the
 * answers over them. The authority rule is the same one the other attachment
 * tools answer to — an employee works with what it produced or opened this
 * turn and what the teammate in front of it uploaded, and nothing else in the
 * company's attachment table.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;
let requester: User;
let membership: Membership;

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
  company = await insert(Company, {
    name: "Paper Forms Co",
    slug: `paper-forms-${randomUUID()}`,
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "Accounts payable",
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
    requesterUserId: membership.userId,
    requesterSessionVersion: requester.sessionVersion,
  });
});

async function call(tool: string, body: unknown = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, never> & {
      error?: string;
      warnings?: string[];
      attachment?: { id: string; filename: string; sizeBytes: number };
      pages?: { width: number; height: number; texts: { text: string; baselineY: number }[] }[];
      hasFormFields?: boolean;
      filename?: string;
    },
  };
}

/** A printed form: labels, ruled gaps, and not one interactive field. */
async function printedFormBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Full name:", { x: 72, y: 700, size: 12, font });
  page.drawText("Company:", { x: 72, y: 660, size: 12, font });
  return Buffer.from(await doc.save());
}

async function storeForm(uploadedByUserId: string | null = null): Promise<Attachment> {
  return recordAttachmentBytes({
    companyId: company.id,
    companySlug: company.slug,
    filename: "supplier-form.pdf",
    mimeType: "application/pdf",
    bytes: await printedFormBytes(),
    uploadedByUserId,
  });
}

describe("read_pdf_layout", () => {
  test("reports page geometry and the printed labels", async () => {
    const form = await storeForm(requester.id);
    const result = await call("read_pdf_layout", { attachmentId: form.id });
    assert.equal(result.status, 200);
    assert.equal(result.body.filename, "supplier-form.pdf");
    assert.equal(result.body.hasFormFields, false);
    assert.equal(result.body.pages?.length, 1);
    assert.equal(result.body.pages?.[0].width, 612);
    const labels = result.body.pages?.[0].texts.map((entry) => entry.text) ?? [];
    assert.ok(labels.includes("Full name:"), JSON.stringify(labels));
  });

  test("refuses an attachment this Member cannot reach", async () => {
    // Uploaded by nobody and bound to no message: not the employee's to open.
    const stranger = await storeForm(null);
    const result = await call("read_pdf_layout", { attachmentId: stranger.id });
    assert.equal(result.status, 404);
  });

  test("refuses a file that is not a PDF", async () => {
    const notPdf = await recordAttachmentBytes({
      companyId: company.id,
      companySlug: company.slug,
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("hello"),
      uploadedByUserId: requester.id,
    });
    const result = await call("read_pdf_layout", { attachmentId: notPdf.id });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /not a PDF/);
  });

  test("validates its arguments", async () => {
    assert.equal((await call("read_pdf_layout", {})).status, 400);
    assert.equal((await call("read_pdf_layout", { attachmentId: "nope" })).status, 400);
    const form = await storeForm(requester.id);
    assert.equal(
      (await call("read_pdf_layout", { attachmentId: form.id, nonsense: 1 })).status,
      400,
    );
  });
});

describe("overlay_pdf_text", () => {
  test("writes onto the form and stages the result for this turn", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [
        { page: 1, x: 200, y: 92, text: "Ada Lovelace" },
        { page: 1, x: 200, y: 132, text: "Analytical Engines Ltd" },
      ],
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.attachment?.filename, "supplier-form-completed.pdf");
    assert.ok((result.body.attachment?.sizeBytes ?? 0) > 0);
    assert.deepEqual(result.body.warnings, []);
    // Staged on the token, so the next call in the same turn can attach it to
    // a reply without the file appearing to belong to nobody.
    assert.ok(tokenOwnsAttachment(token, result.body.attachment!.id));
  });

  test("the produced PDF keeps the original labels and carries the answers", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [{ page: 1, x: 200, y: 92, text: "Ada Lovelace" }],
    });
    assert.equal(result.status, 200);
    const stored = await recordedBytes(result.body.attachment!.id);
    const layout = await readPdfLayout(stored);
    const texts = layout.pages[0].texts.map((entry) => entry.text);
    assert.ok(
      texts.some((entry) => entry.includes("Full name:")),
      `original labels lost: ${JSON.stringify(texts)}`,
    );
    assert.ok(texts.some((entry) => entry.includes("Ada Lovelace")));
  });

  test("honours an explicit output filename", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [{ page: 1, x: 200, y: 92, text: "Ada" }],
      outputFilename: "supplier-form-signed.pdf",
    });
    assert.equal(result.body.attachment?.filename, "supplier-form-signed.pdf");
  });

  test("draws tick marks", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [{ page: 1, x: 90, y: 300, type: "check", size: 10 }],
    });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.warnings, []);
  });

  test("reports a placement that runs off the page without refusing it", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [{ page: 1, x: 600, y: 92, text: "Overflowing answer" }],
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.warnings?.length, 1);
    assert.match(result.body.warnings![0], /outside page/);
  });

  test("refuses a page the document does not have", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [{ page: 4, x: 200, y: 92, text: "Ada" }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /1 page\(s\)/);
  });

  test("refuses a character no shipped font can draw", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [{ page: 1, x: 200, y: 92, text: "Signed 😀" }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /U\+1F600/);
  });

  test("refuses a colour it cannot read", async () => {
    const form = await storeForm(requester.id);
    const result = await call("overlay_pdf_text", {
      attachmentId: form.id,
      items: [{ page: 1, x: 200, y: 92, text: "Ada", color: "chartreuse" }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /#rrggbb/);
  });

  test("refuses an attachment this Member cannot reach", async () => {
    const stranger = await storeForm(null);
    const result = await call("overlay_pdf_text", {
      attachmentId: stranger.id,
      items: [{ page: 1, x: 200, y: 92, text: "Ada" }],
    });
    assert.equal(result.status, 404);
  });

  test("validates its arguments", async () => {
    const form = await storeForm(requester.id);
    assert.equal((await call("overlay_pdf_text", { attachmentId: form.id })).status, 400);
    assert.equal(
      (await call("overlay_pdf_text", { attachmentId: form.id, items: [] })).status,
      400,
    );
    assert.equal(
      (
        await call("overlay_pdf_text", {
          attachmentId: form.id,
          items: [{ page: 1, x: 1, y: 1, text: "Ada", surprise: true }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("overlay_pdf_text", {
          attachmentId: form.id,
          items: [{ page: 1, x: 1, y: 1, align: "middle", text: "Ada" }],
        })
      ).status,
      400,
    );
  });
});

/** Read back what the tool wrote, through the same resolver the routes use. */
async function recordedBytes(attachmentId: string): Promise<Buffer> {
  const resolved = await resolveAttachmentFile(attachmentId, company.id);
  assert.ok(resolved, "the produced attachment was not stored");
  return fs.promises.readFile(resolved.absPath);
}
