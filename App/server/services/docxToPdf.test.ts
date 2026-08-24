import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { docxToHtml, DocxRenderError } from "./docxToPdf.js";
import { docxFixture, para, run, table, W_NAMESPACES } from "../test/docxFixtures.js";

/**
 * Converting a Word document to PDF.
 *
 * The assertions live on the HTML rather than the PDF bytes on purpose: this
 * module's whole job is deciding what a paragraph, a list, a table or a page
 * margin *becomes*, and that decision is legible in the HTML and invisible in
 * a printed page. Chromium's own rendering is not ours to test.
 *
 * The failure this file exists to catch is a quiet one. Someone is about to
 * sign the document that comes out of here, so a table that loses a column, a
 * clause numbered 1. that comes back as a bullet, or a footer that vanishes
 * without a word are all worse than a conversion that refuses outright.
 */

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function stylesPart(): string {
  return (
    XML_HEADER +
    `<w:styles ${W_NAMESPACES}>` +
    "<w:docDefaults><w:rPrDefault><w:rPr>" +
    '<w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/>' +
    "</w:rPr></w:rPrDefault></w:docDefaults>" +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>' +
    "</w:styles>"
  );
}

/** `numId` 1 is a bullet list; `numId` 2 is decimal at both levels. */
function numberingPart(): string {
  return (
    XML_HEADER +
    `<w:numbering ${W_NAMESPACES}>` +
    '<w:abstractNum w:abstractNumId="0">' +
    '<w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>' +
    "</w:abstractNum>" +
    '<w:abstractNum w:abstractNumId="1">' +
    '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl>' +
    "</w:abstractNum>" +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>' +
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>' +
    "</w:numbering>"
  );
}

function listItem(text: string, numId: number, level = 0): string {
  return para(
    text,
    `<w:pPr><w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>`,
  );
}

async function render(body: string, extra: Record<string, string> = {}) {
  const bytes = await docxFixture({
    body,
    extraFiles: {
      "word/styles.xml": stylesPart(),
      "word/numbering.xml": numberingPart(),
      ...extra,
    },
  });
  return docxToHtml(bytes, { title: "Mutual NDA" });
}

describe("docxToHtml — structure", () => {
  test("styled headings become heading elements, not bold paragraphs", async () => {
    const result = await render(
      para("Mutual Non-Disclosure Agreement", '<w:pPr><w:pStyle w:val="Title"/></w:pPr>') +
        para("1. Confidential Information", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>') +
        para("1.1 Definition", '<w:pPr><w:pStyle w:val="Heading2"/></w:pPr>') +
        para("Each party may disclose information."),
    );

    assert.match(result.html, /<h1 class="doc-title"[^>]*>Mutual Non-Disclosure Agreement<\/h1>/);
    assert.match(result.html, /<h1[^>]*>1\. Confidential Information<\/h1>/);
    assert.match(result.html, /<h2[^>]*>1\.1 Definition<\/h2>/);
    assert.match(result.html, /<p[^>]*>Each party may disclose information\.<\/p>/);
    assert.equal(result.paragraphCount, 4);
  });

  test("a sentence Word split across runs comes back as one sentence", async () => {
    const result = await render(
      `<w:p>${run("The ")}${run("Receiving ")}${run("Party")}${run(" shall not disclose.")}</w:p>`,
    );
    assert.match(result.html, />The Receiving Party shall not disclose\.</);
  });

  test("run formatting survives", async () => {
    const result = await render(
      `<w:p>${run("Confidential", "<w:rPr><w:b/></w:rPr>")}${run(
        " and proprietary",
        "<w:rPr><w:i/></w:rPr>",
      )}${run(" information", '<w:rPr><w:u w:val="single"/></w:rPr>')}</w:p>`,
    );
    assert.match(result.html, /font-weight:700[^>]*>Confidential</);
    assert.match(result.html, /font-style:italic[^>]*> and proprietary</);
    assert.match(result.html, /text-decoration:underline[^>]*> information</);
  });

  test("a bold toggle explicitly switched off stays off", async () => {
    const result = await render(`<w:p>${run("plain", '<w:rPr><w:b w:val="0"/></w:rPr>')}</w:p>`);
    assert.doesNotMatch(result.html, /font-weight:700/);
  });

  test("the spaces on a form's blanks are preserved, not collapsed", async () => {
    const result = await render(`<w:p>${run("Name:        ")}${run("Date:")}</w:p>`);
    assert.match(result.html, /Name: {8}Date:/);
    // Collapsing is what HTML does by default, so the stylesheet has to say
    // otherwise or every ruled blank on a signature page closes up.
    assert.match(result.html, /white-space: pre-wrap/);
  });
});

describe("docxToHtml — lists", () => {
  test("a numbered clause list becomes an ordered list", async () => {
    const result = await render(
      listItem("Definitions", 2) + listItem("Obligations", 2) + listItem("Term", 2),
    );
    const ordered = result.html.match(/<ol[ >]/g) ?? [];
    assert.equal(ordered.length, 1);
    assert.equal((result.html.match(/<li/g) ?? []).length, 3);
    assert.doesNotMatch(result.html, /<ul>/);
    assert.match(result.html, /list-style-type:decimal/);
  });

  test("a bulleted list stays bulleted", async () => {
    const result = await render(listItem("First", 1) + listItem("Second", 1));
    assert.match(result.html, /<ul>/);
    assert.doesNotMatch(result.html, /<ol[ >]/);
  });

  test("sub-clauses nest instead of flattening", async () => {
    const result = await render(
      listItem("Obligations", 2) +
        listItem("keep it secret", 2, 1) +
        listItem("keep it safe", 2, 1) +
        listItem("Term", 2),
    );
    assert.equal((result.html.match(/<ol[ >]/g) ?? []).length, 2);
    assert.equal((result.html.match(/<\/ol>/g) ?? []).length, 2);
    // Sub-clauses are lettered in the original, so they are lettered here.
    assert.match(result.html, /list-style-type:lower-alpha/);
    // The nested list has to close before the final top-level clause, or
    // "Term" is numbered as a sub-clause of "Obligations".
    assert.match(result.html, /keep it safe<\/li>\s*<\/ol>\s*<li[^>]*>Term<\/li>\s*<\/ol>/);
  });

  test("a list ends when ordinary prose resumes", async () => {
    const result = await render(listItem("First", 1) + para("Signed:"));
    assert.match(result.html, /<\/ul>\s*<p[^>]*>Signed:<\/p>/);
  });
});

describe("docxToHtml — tables", () => {
  test("a table keeps its rows, columns and header", async () => {
    const result = await render(
      table([
        ["Party", "Signature"],
        ["Genosyn", ""],
      ]),
    );
    assert.equal((result.html.match(/<tr>/g) ?? []).length, 2);
    assert.equal((result.html.match(/<th/g) ?? []).length, 2);
    assert.equal((result.html.match(/<td/g) ?? []).length, 2);
    assert.equal(result.tableCount, 1);
  });

  test("a merged cell keeps the columns after it aligned", async () => {
    const merged =
      "<w:tbl><w:tr>" +
      '<w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' +
      para("Schedule A") +
      "</w:tc>" +
      "</w:tr><w:tr>" +
      `<w:tc>${para("Item")}</w:tc><w:tc>${para("Fee")}</w:tc>` +
      "</w:tr></w:tbl>";
    const result = await render(merged);
    assert.match(result.html, /colspan="2"/);
  });

  test("a Table Grid style is drawn with borders", async () => {
    const gridded =
      '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>' +
      `<w:tr><w:tc>${para("A")}</w:tc></w:tr></w:tbl>`;
    const result = await render(gridded);
    assert.match(result.html, /<table class="bordered">/);
  });

  test("a borderless layout table is not given borders it never had", async () => {
    const plain = `<w:tbl><w:tr><w:tc>${para("A")}</w:tc></w:tr></w:tbl>`;
    const result = await render(plain);
    assert.match(result.html, /<table>/);
  });
});

describe("docxToHtml — page geometry", () => {
  test("page size and margins come from the document's own section", async () => {
    const result = await render(para("Body"));
    // The fixture's A4 page with 1134-twip (2cm) margins.
    assert.equal(result.page.width, "8.268in");
    assert.equal(result.page.height, "11.693in");
    assert.equal(result.page.margin.top, "0.787in");
    assert.match(result.html, /@page\s*\{\s*size: 8\.268in 11\.693in;/);
  });

  test("a page break in the body becomes a page break in the print", async () => {
    const result = await render(`<w:p><w:r><w:br w:type="page"/></w:r></w:p>` + para("Schedule A"));
    assert.match(result.html, /break-after:page/);
  });
});

describe("docxToHtml — what it says it could not carry", () => {
  test("a running footer is reported rather than silently dropped", async () => {
    const bytes = await docxFixture({
      body: para("Body"),
      parts: { footer1: para("Confidential — do not distribute") },
      extraFiles: { "word/styles.xml": stylesPart() },
    });
    const result = await docxToHtml(bytes);
    assert.ok(
      result.warnings.some((w) => /headers or footers/i.test(w)),
      `expected a header/footer warning, got ${JSON.stringify(result.warnings)}`,
    );
  });

  test("an empty header raises no warning", async () => {
    const bytes = await docxFixture({
      body: para("Body"),
      parts: { header1: "<w:p/>" },
      extraFiles: { "word/styles.xml": stylesPart() },
    });
    const result = await docxToHtml(bytes);
    assert.deepEqual(result.warnings, []);
  });

  test("tracked changes render as accepted, and say so", async () => {
    const result = await render(
      `<w:p>${run("The term is ")}` +
        `<w:ins w:id="1" w:author="A">${run("three")}</w:ins>` +
        `<w:del w:id="2" w:author="A"><w:r><w:delText>five</w:delText></w:r></w:del>` +
        `${run(" years.")}</w:p>`,
    );
    assert.match(result.html, />The term is three years\.</);
    assert.doesNotMatch(result.html, /five/);
    assert.ok(result.warnings.some((w) => /tracked changes/i.test(w)));
  });
});

describe("docxToHtml — refusals", () => {
  test("a document with nothing in it is refused, not rendered blank", async () => {
    const bytes = await docxFixture({ body: "" });
    await assert.rejects(
      () => docxToHtml(bytes),
      (error: unknown) =>
        error instanceof DocxRenderError && /no readable content/i.test(error.message),
    );
  });

  test("a PDF handed to the Word converter is refused with a usable message", async () => {
    await assert.rejects(
      () => docxToHtml(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")),
      (error: unknown) => error instanceof DocxRenderError && error.status === 400,
    );
  });
});

describe("docxToHtml — content controls", () => {
  test("a paragraph wrapped in a content control is still rendered", async () => {
    const wrapped =
      '<w:sdt><w:sdtPr><w:alias w:val="Party"/></w:sdtPr><w:sdtContent>' +
      para("Genosyn Ltd") +
      "</w:sdtContent></w:sdt>";
    const result = await render(wrapped);
    assert.match(result.html, />Genosyn Ltd</);
  });
});
