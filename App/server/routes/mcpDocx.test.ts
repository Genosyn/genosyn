import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Attachment } from "../db/entities/Attachment.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { DOCM_MIME, DOCX_MIME, DocxPackage } from "../services/docxPackage.js";
import { issueMcpToken, revokeMcpToken, tokenOwnsAttachment } from "../services/mcpTokens.js";
import { recordAttachmentBytes, resolveAttachmentFile } from "../services/uploads.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  docxFixture,
  legacyCheckbox,
  para,
  splitPara,
  table,
  textControl,
} from "../test/docxFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The Word tools as an employee meets them: over HTTP, with a token.
 *
 * Before these routes a `.docx` arrived as "Binary or unsupported type", so the
 * best an employee could do with a questionnaire was ask the human to re-send
 * it as a PDF. What the routes add on top of the services is the part that
 * cannot be tested anywhere else: the authority rule every attachment tool
 * answers to — an employee works with what the teammate in front of it
 * uploaded and what it produced this turn, and with nothing else in the
 * company's attachment table — and the promise that a refused edit leaves
 * nothing behind. A batch that half-applied would hand a human a questionnaire
 * that looks answered and is not, which is worse than a refusal, so the
 * atomicity case below is the one to keep alive.
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
    name: "Analytical Engines Ltd",
    slug: `engines-${randomUUID()}`,
    ownerId: "owner-1",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie Mallers",
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
    requesterUserId: membership.userId,
    requesterSessionVersion: requester.sessionVersion,
  });
});

type ParagraphBlock = { id: string; kind: "paragraph"; text: string; style?: string };
type TableBlock = {
  id: string;
  kind: "table";
  rows: { header?: boolean; cells: { id: string; text: string }[] }[];
};
type Block = ParagraphBlock | TableBlock;

type ToolBody = {
  error?: string;
  issues?: unknown[];
  filename?: string;
  parts?: { key: string; path: string; blocks: Block[] }[];
  fields?: {
    id: string;
    flavour: string;
    kind: string;
    name: string;
    value: string;
    checked?: boolean;
    at?: string;
  }[];
  hasFormFields?: boolean;
  truncated?: boolean;
  paragraphCount?: number;
  tableCount?: number;
  attachment?: { id: string; filename: string; mimeType: string; sizeBytes: number };
  applied?: string[];
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

/**
 * A questionnaire of the shape these tools exist for.
 *
 * The label is deliberately split mid-word across runs, because that is what
 * Word writes after a spell-check pause, and a reader that looked at one `w:t`
 * at a time would report the document as gibberish.
 */
async function questionnaireBytes(): Promise<Buffer> {
  return docxFixture({
    body: [
      para("Supplier onboarding", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
      splitPara(["Full ", "nam", "e: Ada Love", "lace"]),
      table([
        ["Question", "Answer"],
        ["Registered company", ""],
        ["VAT number", ""],
      ]),
      textControl("Contact email", "contact", "Click to enter text"),
      legacyCheckbox("Terms accepted", false),
    ].join(""),
    parts: { header1: para("Commercial in confidence") },
  });
}

/** Long enough that a character budget has something to cut. */
async function longDocxBytes(): Promise<Buffer> {
  const clauses: string[] = [];
  for (let index = 0; index < 40; index += 1) {
    clauses.push(para(`Clause ${index + 1}. ${"terms and conditions apply ".repeat(3)}`));
  }
  return docxFixture({ body: clauses.join("") });
}

async function store(params: {
  filename: string;
  mimeType: string;
  bytes: Buffer;
  uploadedByUserId?: string | null;
}): Promise<Attachment> {
  return recordAttachmentBytes({
    companyId: company.id,
    companySlug: company.slug,
    filename: params.filename,
    mimeType: params.mimeType,
    bytes: params.bytes,
    uploadedByUserId: params.uploadedByUserId ?? null,
  });
}

async function storeQuestionnaire(uploadedByUserId: string | null = null): Promise<Attachment> {
  return store({
    filename: "supplier-questionnaire.docx",
    mimeType: DOCX_MIME,
    bytes: await questionnaireBytes(),
    uploadedByUserId,
  });
}

/** Read back what a tool wrote, through the same resolver the routes use. */
async function bytesOnDisk(attachmentId: string): Promise<Buffer> {
  const resolved = await resolveAttachmentFile(attachmentId, company.id);
  assert.ok(resolved, "the attachment was not stored");
  return fs.promises.readFile(resolved.absPath);
}

function blocksOf(body: ToolBody): Block[] {
  return (body.parts ?? []).flatMap((part) => part.blocks);
}

function paragraphsOf(body: ToolBody): ParagraphBlock[] {
  return blocksOf(body).filter((block): block is ParagraphBlock => block.kind === "paragraph");
}

function tablesOf(body: ToolBody): TableBlock[] {
  return blocksOf(body).filter((block): block is TableBlock => block.kind === "table");
}

function allText(body: ToolBody): string {
  const pieces: string[] = [];
  for (const block of blocksOf(body)) {
    if (block.kind === "paragraph") pieces.push(block.text);
    else for (const row of block.rows) for (const cell of row.cells) pieces.push(cell.text);
  }
  return pieces.join("\n");
}

/** The answer cell sitting beside a question, addressed the way a model would. */
function answerCell(body: ToolBody, question: string): { id: string; text: string } {
  for (const table_ of tablesOf(body)) {
    for (const row of table_.rows) {
      if (row.cells[0]?.text === question) {
        const answer = row.cells[1];
        assert.ok(answer, `row "${question}" has no answer cell`);
        return answer;
      }
    }
  }
  return assert.fail(`no table row asking "${question}"`);
}

describe("attachment authority", () => {
  test("read_docx refuses a document this Member cannot reach", async () => {
    // Uploaded by nobody and bound to no message: not this Member's to open,
    // even though it sits in the same company.
    const stranger = await storeQuestionnaire(null);
    const result = await call("read_docx", { attachmentId: stranger.id });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Attachment not found");
  });

  test("edit_docx refuses a document this Member cannot reach", async () => {
    const stranger = await storeQuestionnaire(null);
    const result = await call("edit_docx", {
      attachmentId: stranger.id,
      operations: [{ op: "append_paragraph", text: "Signed" }],
    });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Attachment not found");
  });

  test("edit_docx writes nothing for a document it may not reach", async () => {
    const stranger = await storeQuestionnaire(null);
    const before = await bytesOnDisk(stranger.id);
    const rows = AppDataSource.getRepository(Attachment);
    const countBefore = await rows.count();
    await call("edit_docx", {
      attachmentId: stranger.id,
      operations: [{ op: "append_paragraph", text: "Signed" }],
    });
    assert.equal(await rows.count(), countBefore);
    assert.deepEqual(await bytesOnDisk(stranger.id), before);
  });

  test("opens a document the requesting Member uploaded", async () => {
    const mine = await storeQuestionnaire(requester.id);
    const result = await call("read_docx", { attachmentId: mine.id });
    assert.equal(result.status, 200);
    assert.equal(result.body.filename, "supplier-questionnaire.docx");
  });

  test("a document this turn produced is reachable on the next call", async () => {
    // create_docx records the file with no uploader and no message, so the
    // authority rule would deny it one call later; staging on the token is
    // what stops an employee being told its own document does not exist.
    const created = await call("create_docx", {
      filename: "cover-note.docx",
      markdown: "# Cover note\n\nPlease find the completed questionnaire attached.\n",
    });
    assert.equal(created.status, 200);
    const id = created.body.attachment!.id;
    assert.ok(tokenOwnsAttachment(token, id));

    const read = await call("read_docx", { attachmentId: id });
    assert.equal(read.status, 200);
    assert.equal(read.body.filename, "cover-note.docx");

    const edited = await call("edit_docx", {
      attachmentId: id,
      operations: [{ op: "append_paragraph", text: "Jamie Mallers" }],
    });
    assert.equal(edited.status, 200);
  });
});

describe("read_docx", () => {
  test("returns an outline every part of which an edit can address", async () => {
    const doc = await storeQuestionnaire(requester.id);
    const result = await call("read_docx", { attachmentId: doc.id });
    assert.equal(result.status, 200);
    assert.equal(result.body.filename, "supplier-questionnaire.docx");

    const paragraphs = paragraphsOf(result.body);
    const heading = paragraphs.find((block) => block.text === "Supplier onboarding");
    assert.equal(heading?.style, "Heading1");
    // Word split this label across four runs; an outline that reported them
    // separately would be unsearchable and unanswerable.
    assert.ok(
      paragraphs.some((block) => block.text === "Full name: Ada Lovelace"),
      JSON.stringify(paragraphs.map((block) => block.text)),
    );
    assert.ok(paragraphs.every((block) => block.id.length > 0));

    const tables = tablesOf(result.body);
    assert.equal(tables.length, 1);
    assert.equal(tables[0].rows.length, 3);
    assert.equal(tables[0].rows[0].header, true);
    assert.equal(answerCell(result.body, "VAT number").text, "");
    assert.equal(result.body.tableCount, 1);
  });

  test("reports both flavours of answer box with their current values", async () => {
    // A modern content control and a Word 97 form field look nothing alike in
    // the XML; an employee asked to fill a form should not have to care which.
    const doc = await storeQuestionnaire(requester.id);
    const result = await call("read_docx", { attachmentId: doc.id });
    assert.equal(result.body.hasFormFields, true);
    const byName = new Map((result.body.fields ?? []).map((field) => [field.name, field]));
    assert.equal(byName.get("Contact email")?.flavour, "sdt");
    assert.equal(byName.get("Contact email")?.value, "Click to enter text");
    assert.equal(byName.get("Terms accepted")?.flavour, "legacy");
    assert.equal(byName.get("Terms accepted")?.kind, "checkbox");
    assert.equal(byName.get("Terms accepted")?.checked, false);
    // Every field says which paragraph it sits in, so the model can quote it.
    assert.ok(byName.get("Terms accepted")?.at);
  });

  test("scope decides whether the header is read", async () => {
    // Questionnaires routinely put the reference number in the header, so the
    // default has to include it; `body` is for when the letterhead is noise.
    const doc = await storeQuestionnaire(requester.id);
    const all = await call("read_docx", { attachmentId: doc.id });
    assert.ok(allText(all.body).includes("Commercial in confidence"));
    assert.ok((all.body.parts ?? []).some((part) => part.path === "word/header1.xml"));

    const bodyOnly = await call("read_docx", { attachmentId: doc.id, scope: "body" });
    assert.equal(bodyOnly.status, 200);
    assert.deepEqual(
      (bodyOnly.body.parts ?? []).map((part) => part.path),
      ["word/document.xml"],
    );
    assert.ok(!allText(bodyOnly.body).includes("Commercial in confidence"));
  });

  test("maxChars caps the text and says so", async () => {
    // The outline goes into a model's context; an uncapped 200-page contract
    // would evict the instruction that asked for it.
    const doc = await store({
      filename: "terms.docx",
      mimeType: DOCX_MIME,
      bytes: await longDocxBytes(),
      uploadedByUserId: requester.id,
    });
    const capped = await call("read_docx", { attachmentId: doc.id, maxChars: 1000 });
    assert.equal(capped.status, 200);
    assert.equal(capped.body.truncated, true);
    assert.ok(allText(capped.body).replace(/\n/g, "").length <= 1000);
    // Blocks are still all there — only their text was clipped, so the ids the
    // caller is about to send back in an edit still line up.
    assert.equal(capped.body.paragraphCount, 40);

    const full = await call("read_docx", { attachmentId: doc.id });
    assert.equal(full.body.truncated, false);
    assert.ok(allText(full.body).length > 1000);
  });

  test("refuses a file that is not a Word document, and says what it is", async () => {
    const pdf = await store({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"),
      uploadedByUserId: requester.id,
    });
    const onPdf = await call("read_docx", { attachmentId: pdf.id });
    assert.equal(onPdf.status, 400);
    assert.match(onPdf.body.error ?? "", /PDF/);

    const notes = await store({
      filename: "notes.txt",
      mimeType: "text/plain",
      bytes: Buffer.from("Registered company: Analytical Engines Ltd"),
      uploadedByUserId: requester.id,
    });
    const onText = await call("read_docx", { attachmentId: notes.id });
    assert.equal(onText.status, 400);
    assert.match(onText.body.error ?? "", /not a Word document/);
  });

  test("an attachment id that names nothing is a 404, not a crash", async () => {
    const result = await call("read_docx", { attachmentId: randomUUID() });
    assert.equal(result.status, 404);
    assert.equal(result.body.error, "Attachment not found");
  });

  test("validates its arguments", async () => {
    const doc = await storeQuestionnaire(requester.id);
    assert.equal((await call("read_docx", {})).status, 400);
    assert.equal((await call("read_docx", { attachmentId: "nope" })).status, 400);
    assert.equal(
      (await call("read_docx", { attachmentId: doc.id, nonsense: 1 })).status,
      400,
    );
    assert.equal(
      (await call("read_docx", { attachmentId: doc.id, scope: "headers" })).status,
      400,
    );
    assert.equal((await call("read_docx", { attachmentId: doc.id, maxChars: 5 })).status, 400);
  });
});

describe("edit_docx", () => {
  test("answers the questionnaire into a new file and leaves the original alone", async () => {
    const doc = await storeQuestionnaire(requester.id);
    const original = await bytesOnDisk(doc.id);
    const outline = await call("read_docx", { attachmentId: doc.id });
    const vat = answerCell(outline.body, "VAT number").id;

    const result = await call("edit_docx", {
      attachmentId: doc.id,
      operations: [
        { op: "set_table_cell", id: vat, text: "GB123456789" },
        { op: "set_field", name: "Contact email", value: "ada@example.com" },
        { op: "set_field", name: "Terms accepted", checked: true },
        // The name is split across runs in the source, so this only works if
        // the finder stitched the paragraph before searching it.
        { op: "replace_text", find: "Ada Lovelace", replace: "Ada Byron" },
      ],
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.applied?.length, 4);

    // A new file, not a mutation: the uploaded original is the only copy the
    // teammate has, and the employee's answers are a draft until a human says
    // otherwise.
    assert.notEqual(result.body.attachment?.id, doc.id);
    assert.equal(result.body.attachment?.mimeType, DOCX_MIME);
    assert.ok((result.body.attachment?.sizeBytes ?? 0) > 0);
    assert.ok(tokenOwnsAttachment(token, result.body.attachment!.id));
    assert.deepEqual(await bytesOnDisk(doc.id), original);

    const reread = await call("read_docx", { attachmentId: result.body.attachment!.id });
    assert.equal(reread.status, 200);
    assert.equal(answerCell(reread.body, "VAT number").text, "GB123456789");
    const fields = new Map((reread.body.fields ?? []).map((field) => [field.name, field]));
    assert.equal(fields.get("Contact email")?.value, "ada@example.com");
    assert.equal(fields.get("Terms accepted")?.checked, true);
    assert.ok(allText(reread.body).includes("Full name: Ada Byron"));
    // Untouched content survives the round trip through the zip.
    assert.equal(answerCell(reread.body, "Registered company").text, "");
    assert.ok(allText(reread.body).includes("Supplier onboarding"));
  });

  test("names the copy after the original, keeping the extension", async () => {
    const doc = await storeQuestionnaire(requester.id);
    const result = await call("edit_docx", {
      attachmentId: doc.id,
      operations: [{ op: "append_paragraph", text: "Signed: Jamie Mallers" }],
    });
    assert.equal(result.body.attachment?.filename, "supplier-questionnaire-edited.docx");
  });

  test("a macro-enabled document keeps its own content type, not just its name", async () => {
    // The filename, the declared mime type and the package's own
    // `[Content_Types].xml` all have to agree, or a mail gateway rejects the
    // attachment on the mismatch.
    const doc = await store({
      filename: "supplier-questionnaire.docm",
      mimeType: DOCM_MIME,
      bytes: await questionnaireBytes(),
      uploadedByUserId: requester.id,
    });
    const result = await call("edit_docx", {
      attachmentId: doc.id,
      operations: [{ op: "append_paragraph", text: "Signed" }],
    });
    assert.equal(result.body.attachment?.filename, "supplier-questionnaire-edited.docm");
    assert.equal(result.body.attachment?.mimeType, DOCM_MIME);
  });

  test("an operation missing its text is refused, not read as an instruction to clear", async () => {
    // With every field optional this parsed cleanly and the missing text
    // became an empty string — so a malformed call wiped an answer and
    // reported success. What an operation needs is part of what it is.
    const doc = await storeQuestionnaire(requester.id);
    const before = await bytesOnDisk(doc.id);
    for (const operation of [
      { op: "set_paragraph", id: "p1" },
      { op: "set_table_cell", id: "t1r1c1" },
      { op: "insert_paragraph", after: "p1" },
      { op: "append_paragraph" },
      { op: "delete_paragraph" },
      { op: "replace_text", find: "x" },
      { op: "replace_text", replace: "y" },
    ]) {
      const result = await call("edit_docx", { attachmentId: doc.id, operations: [operation] });
      assert.equal(result.status, 400, `${JSON.stringify(operation)} should be refused`);
    }
    assert.deepEqual(await bytesOnDisk(doc.id), before, "the source was changed by a refused call");
  });

  test("honours an explicit output filename", async () => {
    const doc = await storeQuestionnaire(requester.id);
    const result = await call("edit_docx", {
      attachmentId: doc.id,
      operations: [{ op: "append_paragraph", text: "Signed: Jamie Mallers" }],
      outputFilename: "supplier-questionnaire-completed.docx",
    });
    assert.equal(result.body.attachment?.filename, "supplier-questionnaire-completed.docx");
  });

  test("refuses the whole batch when one operation names nothing, and records no file", async () => {
    // The failure this prevents: seven answers land, the eighth id is wrong,
    // and a human is handed a questionnaire that looks finished and is not.
    const doc = await storeQuestionnaire(requester.id);
    const outline = await call("read_docx", { attachmentId: doc.id });
    const vat = answerCell(outline.body, "VAT number").id;
    const rows = AppDataSource.getRepository(Attachment);
    const countBefore = await rows.count();

    const result = await call("edit_docx", {
      attachmentId: doc.id,
      operations: [
        { op: "set_table_cell", id: vat, text: "GB123456789" },
        { op: "set_paragraph", id: "p9001", text: "Signed" },
      ],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /p9001/);
    assert.equal(await rows.count(), countBefore);

    // And the accepted half of the batch was not applied to the source either.
    const after = await call("read_docx", { attachmentId: doc.id });
    assert.equal(answerCell(after.body, "VAT number").text, "");
  });

  test("reports every bad operation at once, so one round trip fixes them", async () => {
    const doc = await storeQuestionnaire(requester.id);
    const result = await call("edit_docx", {
      attachmentId: doc.id,
      operations: [
        { op: "set_paragraph", id: "p9001", text: "Signed" },
        { op: "set_field", name: "Bank sort code", value: "00-00-00" },
      ],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /p9001/);
    assert.match(result.body.error ?? "", /Bank sort code/);
  });

  test("refuses a source that is not a Word document", async () => {
    const pdf = await store({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"),
      uploadedByUserId: requester.id,
    });
    const result = await call("edit_docx", {
      attachmentId: pdf.id,
      operations: [{ op: "append_paragraph", text: "Signed" }],
    });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /PDF/);
  });

  test("validates its arguments", async () => {
    const id = randomUUID();
    assert.equal((await call("edit_docx", {})).status, 400);
    assert.equal((await call("edit_docx", { attachmentId: id, operations: [] })).status, 400);
    assert.equal(
      (
        await call("edit_docx", {
          attachmentId: id,
          operations: [{ op: "rewrite_everything", text: "no" }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("edit_docx", {
          attachmentId: id,
          operations: [{ op: "append_paragraph", text: "ok", surprise: true }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call("edit_docx", {
          attachmentId: id,
          operations: [{ op: "append_paragraph", text: "ok" }],
          nonsense: 1,
        })
      ).status,
      400,
    );
  });
});

describe("create_docx", () => {
  test("produces a file Word will open, labelled as a Word document", async () => {
    const result = await call("create_docx", {
      filename: "Q3 supplier review.docx",
      markdown: "# Q3 supplier review\n\nAll five suppliers responded.\n",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.attachment?.filename, "Q3 supplier review.docx");
    assert.equal(result.body.attachment?.mimeType, DOCX_MIME);
    assert.ok((result.body.attachment?.sizeBytes ?? 0) > 0);
    assert.ok(tokenOwnsAttachment(token, result.body.attachment!.id));

    // DocxPackage.open throws unless the bytes really are a Word package.
    const pkg = await DocxPackage.open(await bytesOnDisk(result.body.attachment!.id));
    assert.ok(pkg.has("word/document.xml"));
    assert.ok(pkg.has("word/styles.xml"));
  });

  test("gives the file the extension its bytes actually have", async () => {
    // A model asked for "the Q3 review" names the file the way a human would,
    // and a `.docx` delivered as `.md` will not open on the recipient's laptop.
    const named = await call("create_docx", {
      filename: "Q3 supplier review",
      markdown: "Body text.\n",
    });
    assert.equal(named.body.attachment?.filename, "Q3 supplier review.docx");

    const wrong = await call("create_docx", { filename: "notes.md", markdown: "Body text.\n" });
    assert.equal(wrong.body.attachment?.filename, "notes.docx");
  });

  test("signs the document with the employee's own name by default", async () => {
    // The recipient sees the author in Word's File → Info panel; attributing
    // every document to the vendor would misreport who wrote it.
    const result = await call("create_docx", {
      filename: "memo.docx",
      markdown: "Body text.\n",
    });
    const pkg = await DocxPackage.open(await bytesOnDisk(result.body.attachment!.id));
    const core = (await pkg.text("docProps/core.xml")) ?? "";
    assert.match(core, /<dc:creator>Jamie Mallers<\/dc:creator>/);
    assert.match(core, /<dc:title>memo<\/dc:title>/);
  });

  test("an explicit author and title win over the defaults", async () => {
    const result = await call("create_docx", {
      filename: "memo.docx",
      markdown: "Body text.\n",
      title: "Rate rise response",
      author: "Analytical Engines Ltd",
    });
    const pkg = await DocxPackage.open(await bytesOnDisk(result.body.attachment!.id));
    const core = (await pkg.text("docProps/core.xml")) ?? "";
    assert.match(core, /<dc:creator>Analytical Engines Ltd<\/dc:creator>/);
    assert.match(core, /<dc:title>Rate rise response<\/dc:title>/);
  });

  test("markdown becomes real Word constructs, not text that looks like them", async () => {
    // Read back through read_docx, because that is the only proof that what
    // the recipient opens is an editable heading and table rather than a
    // transcript with hashes and pipes in it.
    const created = await call("create_docx", {
      filename: "review.docx",
      markdown:
        "# Q3 supplier review\n\nAll five suppliers responded.\n\n" +
        "| Supplier | Status |\n| --- | --- |\n| Babbage | Approved |\n",
    });
    assert.equal(created.status, 200);
    const outline = await call("read_docx", { attachmentId: created.body.attachment!.id });
    assert.equal(outline.status, 200);

    const heading = paragraphsOf(outline.body).find(
      (block) => block.text === "Q3 supplier review",
    );
    assert.equal(heading?.style, "Heading1");
    assert.equal(answerCell(outline.body, "Babbage").text, "Approved");
    assert.ok(!allText(outline.body).includes("#"));
    assert.ok(!allText(outline.body).includes("|"));
  });

  test("validates its arguments", async () => {
    assert.equal((await call("create_docx", {})).status, 400);
    assert.equal((await call("create_docx", { filename: "a.docx" })).status, 400);
    assert.equal((await call("create_docx", { markdown: "hello" })).status, 400);
    assert.equal((await call("create_docx", { filename: "a.docx", markdown: "" })).status, 400);
    assert.equal(
      (await call("create_docx", { filename: "a.docx", markdown: "hi", pageSize: "a3" })).status,
      400,
    );
    assert.equal(
      (await call("create_docx", { filename: "a.docx", markdown: "hi", nonsense: 1 })).status,
      400,
    );
  });
});
