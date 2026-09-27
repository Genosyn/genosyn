import assert from "node:assert/strict";
import { test } from "node:test";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { DOCX_TEXT_CHAR_CAP } from "../docxRead.js";
import { XLSX_MIME } from "../xlsxPackage.js";
import {
  MAIL_ATTACHMENT_TEXT_CAP,
  MAIL_ATTACHMENT_TEXT_JSON_CAP,
  mailAttachmentTextVersion,
  readMailAttachmentText,
} from "./attachmentRead.js";

test("the default page respects both the 20,000-character ceiling and the serialized result budget", async () => {
  const whole = "a".repeat(MAIL_ATTACHMENT_TEXT_CAP) + "the final procurement instructions";
  const page = await readMailAttachmentText(Buffer.from(whole), "text/html", "message.html");
  assert.equal(page.text, whole.slice(0, MAIL_ATTACHMENT_TEXT_JSON_CAP - 2));
  assert.equal(page.truncated, true);
  assert.deepEqual(page.textCoverage, {
    extractedChars: whole.length,
    returnedChars: MAIL_ATTACHMENT_TEXT_JSON_CAP - 2,
    offset: 0,
    nextOffset: MAIL_ATTACHMENT_TEXT_JSON_CAP - 2,
    hasMore: true,
    extractionAvailable: true,
    previewOnly: false,
    complete: false,
  });
});

test("a 57,166-byte HTML wrapper can be reconstructed exactly across bounded pages", async () => {
  const header = '<html><body><form action="https://example.invalid/protected">';
  const footer = '<input name="message" value="protected payload" /></form></body></html>';
  const whole = header + "x".repeat(57_166 - header.length - footer.length) + footer;
  const bytes = Buffer.from(whole);
  let offset: number | null = 0;
  const pages: string[] = [];
  const versions = new Set<string>();
  while (offset !== null) {
    const page = await readMailAttachmentText(bytes, "text/html", "protected.html", {
      textOffset: offset,
    });
    assert.ok(page.text.length <= MAIL_ATTACHMENT_TEXT_CAP);
    assert.equal(page.textCoverage.offset, offset);
    assert.equal(page.textCoverage.returnedChars, page.text.length);
    if (page.textCoverage.nextOffset !== null) assert.ok(page.textCoverage.nextOffset > offset);
    versions.add(page.textVersion);
    pages.push(page.text);
    offset = page.textCoverage.nextOffset;
  }
  assert.equal(bytes.length, 57_166);
  assert.equal(pages.length, Math.ceil(whole.length / (MAIL_ATTACHMENT_TEXT_JSON_CAP - 2)));
  assert.equal(pages.join(""), whole);
  assert.equal(versions.size, 1);
  assert.match(pages.at(-1)!, /protected payload/);
});

test("normalization is performed before offsets, preserving interior whitespace and removing NULs", async () => {
  const bytes = Buffer.from(" \r\n\u0000first\u0000\n\nsecond\u0000 \t");
  const first = await readMailAttachmentText(bytes, "text/plain", "notes.txt", { maxTextChars: 7 });
  const last = await readMailAttachmentText(bytes, "text/plain", "notes.txt", {
    textOffset: first.textCoverage.nextOffset!,
    maxTextChars: 7,
  });
  assert.equal(first.text, "first\n\n");
  assert.equal(last.text, "second");
  assert.equal(first.textCoverage.extractedChars, 13);
  assert.equal(last.textCoverage.nextOffset, null);
  assert.equal(first.textVersion, last.textVersion);
});

test("a page ending at the exact limit has no continuation", async () => {
  const page = await readMailAttachmentText(Buffer.from("abcd"), "text/plain", "n.txt", {
    maxTextChars: 4,
  });
  assert.equal(page.truncated, false);
  assert.equal(page.textCoverage.nextOffset, null);
  assert.equal(page.textCoverage.complete, true);
});

test("empty extracted text is distinguished from an unsupported or malformed file", async () => {
  const empty = await readMailAttachmentText(Buffer.from(" \u0000\n"), "text/plain", "empty.txt");
  assert.equal(empty.text, "");
  assert.equal(empty.textCoverage.extractionAvailable, true);
  assert.equal(empty.textCoverage.complete, true);
  for (const [mime, name] of [
    ["application/octet-stream", "binary.bin"],
    ["image/png", "scan.png"],
    ["application/pdf", "broken.pdf"],
  ]) {
    const page = await readMailAttachmentText(Buffer.from("not readable"), mime, name);
    assert.equal(page.text, "");
    assert.equal(page.textCoverage.extractionAvailable, false);
    assert.equal(page.textCoverage.complete, false);
    assert.equal(page.textCoverage.nextOffset, null);
  }
});

test("an exact-end cursor terminates, while a cursor beyond the source is refused", async () => {
  const page = await readMailAttachmentText(Buffer.from("abcd"), "text/plain", "n.txt", {
    textOffset: 4,
  });
  assert.equal(page.text, "");
  assert.equal(page.truncated, false);
  assert.equal(page.textCoverage.offset, 4);
  assert.equal(page.textCoverage.nextOffset, null);
  assert.equal(page.textCoverage.complete, false);
  for (const textOffset of [5, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(
      readMailAttachmentText(Buffer.from("abcd"), "text/plain", "n.txt", { textOffset }),
      /exceeds the 4 extracted characters/,
    );
  }
});

test("Unicode characters never split across pages, even with the minimum page size", async () => {
  const whole = "a😀b𐐷c🧪漢字";
  const bytes = Buffer.from(whole);
  for (const maxTextChars of [2, 3, 4, 5]) {
    let textOffset: number | null = 0;
    const pages: string[] = [];
    while (textOffset !== null) {
      const page = await readMailAttachmentText(bytes, "text/plain", "n.txt", {
        textOffset,
        maxTextChars,
      });
      assert.ok(page.text.length <= maxTextChars);
      assert.ok(page.text.length > 0);
      assert.equal(Buffer.from(page.text).toString("utf8"), page.text);
      pages.push(page.text);
      textOffset = page.textCoverage.nextOffset;
    }
    assert.equal(pages.join(""), whole);
  }
  await assert.rejects(
    readMailAttachmentText(bytes, "text/plain", "n.txt", { textOffset: 2 }),
    /splits a Unicode character/,
  );
});

test("JSON-escaped text stays below the outer tool-result budget without losing continuation", async () => {
  const whole = '\u0001\t\\"'.repeat(12_000) + "last section";
  const bytes = Buffer.from(whole);
  const pages: string[] = [];
  let textOffset: number | null = 0;
  while (textOffset !== null) {
    const page = await readMailAttachmentText(bytes, "text/plain", "control.txt", { textOffset });
    assert.ok(JSON.stringify(page.text).length <= MAIL_ATTACHMENT_TEXT_JSON_CAP);
    assert.ok(JSON.stringify(page, null, 2).length < 8_000);
    assert.ok(
      JSON.stringify(page).indexOf('"textCoverage"') < JSON.stringify(page).indexOf('"text":'),
    );
    pages.push(page.text);
    textOffset = page.textCoverage.nextOffset;
  }
  assert.equal(pages.join(""), whole);
});

test("internal callers cannot bypass safe offset and response-size bounds", async () => {
  const bytes = Buffer.from("text");
  for (const textOffset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      readMailAttachmentText(bytes, "text/plain", "n.txt", { textOffset }),
      /textOffset/,
    );
  }
  for (const maxTextChars of [-1, 0, 1, 2.5, NaN, Infinity, MAIL_ATTACHMENT_TEXT_CAP + 1]) {
    await assert.rejects(
      readMailAttachmentText(bytes, "text/plain", "n.txt", { maxTextChars }),
      /maxTextChars/,
    );
  }
});

test("version identity includes every source byte and the metadata that selects its parser", async () => {
  const bytes = Buffer.from("a".repeat(20_000) + "b");
  const version = mailAttachmentTextVersion(bytes, "text/plain", "notes.txt");
  assert.match(version, /^[a-f0-9]{64}$/);
  assert.equal(version, mailAttachmentTextVersion(Buffer.from(bytes), "text/plain", "notes.txt"));
  for (const [changed, mime, name] of [
    [Buffer.from("a".repeat(20_000) + "c"), "text/plain", "notes.txt"],
    [Buffer.concat([bytes, Buffer.from("\u0000")]), "text/plain", "notes.txt"],
    [bytes, "text/html", "notes.txt"],
    [bytes, "text/plain", "notes.pdf"],
  ] as const) {
    assert.notEqual(version, mailAttachmentTextVersion(changed, mime, name));
  }
});

test("filename-based text extraction still works for generic mailbox MIME types", async () => {
  for (const filename of ["message.HTML", "notes.md", "records.csv", "config.json", "fields.xml"]) {
    const page = await readMailAttachmentText(
      Buffer.from("first second"),
      "application/octet-stream",
      filename,
      {
        textOffset: 6,
        maxTextChars: 6,
      },
    );
    assert.equal(page.text, "second");
    assert.equal(page.textCoverage.extractionAvailable, true);
  }
});

test("PDF text is extracted before pagination rather than treating binary offsets as text", async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText("Supplier payment instructions", { x: 30, y: 700, font });
  const bytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  const first = await readMailAttachmentText(bytes, "application/pdf", "supplier.pdf", {
    maxTextChars: 9,
  });
  const last = await readMailAttachmentText(bytes, "application/pdf", "supplier.pdf", {
    textOffset: first.textCoverage.nextOffset!,
  });
  assert.equal(first.text + last.text, "Supplier payment instructions");
  assert.equal(first.textCoverage.extractionAvailable, true);
  assert.equal(first.textCoverage.previewOnly, false);
  assert.equal(last.textCoverage.nextOffset, null);
});

async function wordBytes(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

test("Word text pages remain readable and a capped Word extraction is never complete coverage", async () => {
  const small = await readMailAttachmentText(
    await wordBytes("supplier details"),
    "application/octet-stream",
    "form.docx",
  );
  assert.equal(small.text, "supplier details");
  assert.equal(small.textCoverage.complete, true);
  assert.equal(small.textCoverage.previewOnly, false);
  const capped = await readMailAttachmentText(
    await wordBytes("x".repeat(DOCX_TEXT_CHAR_CAP + 10)),
    "application/octet-stream",
    "large.docx",
    {
      textOffset: DOCX_TEXT_CHAR_CAP - 10,
    },
  );
  assert.equal(capped.textCoverage.extractedChars, DOCX_TEXT_CHAR_CAP);
  assert.equal(capped.textCoverage.nextOffset, null);
  assert.equal(capped.textCoverage.previewOnly, true);
  assert.equal(capped.textCoverage.complete, false);
});

test("Excel fallback guidance remains a preview even when its extracted text fits on one page", async () => {
  const page = await readMailAttachmentText(
    Buffer.from("invalid workbook"),
    XLSX_MIME,
    "form.xlsx",
  );
  assert.match(page.text, /read_xlsx/);
  assert.equal(page.textCoverage.nextOffset, null);
  assert.equal(page.textCoverage.previewOnly, true);
  assert.equal(page.textCoverage.complete, false);
});
