import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { DocxEditError, editDocx, type DocxOperation } from "./docxEdit.js";
import { DocxError, DocxPackage, DOCUMENT_PART } from "./docxPackage.js";
import { readDocx } from "./docxRead.js";
import { descendantsNamed, parseXml } from "./docxXml.js";
import {
  checkboxControl,
  docxFixture,
  W_NAMESPACES,
  dropdownControl,
  legacyCheckbox,
  legacyDropdown,
  legacyTextField,
  para,
  splitPara,
  table,
  textControl,
} from "../test/docxFixtures.js";

/**
 * Writing into somebody else's Word document.
 *
 * The document under test is always one the company did not author — a
 * questionnaire a customer sent, a supplier's order form, a contract in the
 * other side's house style. That framing decides every rule checked here: an
 * answer must arrive in the document's own font rather than a default one, a
 * paragraph nobody mentioned must come back byte-identical, and a batch with
 * one bad id must change nothing at all, because a form that looks answered
 * and is not costs more to recover from than one that was refused.
 */

/** The document part's XML, for assertions about what survived a splice. */
async function bodyXml(bytes: Buffer): Promise<string> {
  const pkg = await DocxPackage.open(bytes);
  return pkg.requireText(DOCUMENT_PART);
}

/** Every paragraph's text in the body, in order. */
async function bodyText(bytes: Buffer): Promise<string[]> {
  const outline = await readDocx(bytes, { scope: "body" });
  return outline.parts[0].blocks.flatMap((block) =>
    block.kind === "paragraph" ? [block.text] : [],
  );
}

async function apply(bytes: Buffer, operations: DocxOperation[]): Promise<Buffer> {
  return (await editDocx(bytes, operations)).bytes;
}

describe("set_paragraph", () => {
  test("writes an answer onto a blank line", async () => {
    // The shape of a printed questionnaire: a question, then empty paragraphs
    // where the answer goes. There is no run to replace, so the edit has to
    // create one.
    const bytes = await docxFixture({
      body: para("1. Does the solution support SSO?") + para("") + para("Guidance"),
    });
    const out = await apply(bytes, [
      { op: "set_paragraph", id: "p2", text: "Answer: Yes, via SAML 2.0." },
    ]);
    assert.deepEqual(await bodyText(out), [
      "1. Does the solution support SSO?",
      "Answer: Yes, via SAML 2.0.",
      "Guidance",
    ]);
  });

  test("keeps the run formatting the paragraph already had", async () => {
    // An answer in a different font from the question is how a filled form
    // announces that a machine filled it.
    const bytes = await docxFixture({
      body:
        '<w:p><w:r><w:rPr><w:rFonts w:ascii="Garamond"/><w:sz w:val="24"/></w:rPr>' +
        "<w:t>placeholder</w:t></w:r></w:p>",
    });
    const out = await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "Ada Lovelace" }]);
    const xml = await bodyXml(out);
    assert.ok(xml.includes('<w:rFonts w:ascii="Garamond"/>'), "lost the font");
    assert.ok(xml.includes('<w:sz w:val="24"/>'), "lost the size");
    assert.ok(xml.includes("Ada Lovelace"));
    assert.ok(!xml.includes("placeholder"));
  });

  test("keeps the paragraph's own properties, so a bullet stays a bullet", async () => {
    const bytes = await docxFixture({
      body: para(
        "old point",
        '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="1"/>' +
          '<w:numId w:val="3"/></w:numPr></w:pPr>',
      ),
    });
    const out = await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "new point" }]);
    const outline = await readDocx(out, { scope: "body" });
    const block = outline.parts[0].blocks[0];
    assert.equal(block.kind, "paragraph");
    assert.equal(block.kind === "paragraph" && block.style, "ListParagraph");
    assert.equal(block.kind === "paragraph" && block.listLevel, 1);
  });

  test("replaces every run, not only the first", async () => {
    const bytes = await docxFixture({ body: splitPara(["Full", " nam", "e:"]) });
    const out = await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "Name: Ada" }]);
    assert.deepEqual(await bodyText(out), ["Name: Ada"]);
  });

  test("keeps bookmarks, which cross-references elsewhere point at", async () => {
    const bytes = await docxFixture({
      body:
        '<w:p><w:bookmarkStart w:id="1" w:name="_Ref12345"/><w:r><w:t>old</w:t></w:r>' +
        '<w:bookmarkEnd w:id="1"/></w:p>',
    });
    const xml = await bodyXml(await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "new" }]));
    assert.ok(xml.includes('w:name="_Ref12345"'), "dropped the bookmark");
    assert.ok(xml.includes('<w:bookmarkEnd w:id="1"/>'));
  });

  test("turns a newline into a line break and a tab into a tab", async () => {
    const bytes = await docxFixture({ body: para("x") });
    const xml = await bodyXml(
      await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "one\ntwo\tthree" }]),
    );
    assert.ok(xml.includes("<w:br/>"));
    assert.ok(xml.includes("<w:tab/>"));
    assert.deepEqual(await bodyText(await apply(bytes, [
      { op: "set_paragraph", id: "p1", text: "one\ntwo\tthree" },
    ])), ["one\ntwo\tthree"]);
  });

  test("escapes text that would otherwise end an element early", async () => {
    const bytes = await docxFixture({ body: para("x") });
    const out = await apply(bytes, [
      { op: "set_paragraph", id: "p1", text: 'Smith & Sons <Ltd> "quoted"' },
    ]);
    assert.deepEqual(await bodyText(out), ['Smith & Sons <Ltd> "quoted"']);
  });

  test("preserves leading and trailing spaces Word would otherwise collapse", async () => {
    const bytes = await docxFixture({ body: para("x") });
    const out = await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "  indented  " }]);
    assert.ok((await bodyXml(out)).includes('xml:space="preserve"'));
    assert.deepEqual(await bodyText(out), ["  indented  "]);
  });

  test("clearing a paragraph leaves it in place rather than deleting it", async () => {
    const bytes = await docxFixture({ body: para("a") + para("b") });
    const out = await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "" }]);
    assert.deepEqual(await bodyText(out), ["", "b"]);
  });

  test("refuses a paragraph holding a content control, and says what to use", async () => {
    // Replacing the paragraph would destroy the control and the template that
    // depends on it; `set_field` is the operation that means what the caller
    // meant.
    const bytes = await docxFixture({ body: textControl("Supplier", "supplier", "…") });
    await assert.rejects(
      () => apply(bytes, [{ op: "set_paragraph", id: "p1", text: "Acme Ltd" }]),
      /content control.*set_field/s,
    );
  });
});

describe("insert_paragraph and append_paragraph", () => {
  test("inserts after a paragraph, matching its formatting", async () => {
    const bytes = await docxFixture({
      body: para("Answer: Yes.") + para("Guidance"),
    });
    const out = await apply(bytes, [
      { op: "insert_paragraph", after: "p1", text: "• SAML 2.0 is enforced." },
    ]);
    assert.deepEqual(await bodyText(out), [
      "Answer: Yes.",
      "• SAML 2.0 is enforced.",
      "Guidance",
    ]);
  });

  test("copies the reference paragraph's properties so a new bullet is a bullet", async () => {
    const bytes = await docxFixture({
      body: para(
        "first point",
        '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/>' +
          '<w:numId w:val="2"/></w:numPr></w:pPr>',
      ),
    });
    const out = await apply(bytes, [
      { op: "insert_paragraph", after: "p1", text: "second point" },
    ]);
    const outline = await readDocx(out, { scope: "body" });
    const inserted = outline.parts[0].blocks[1];
    assert.equal(inserted.kind === "paragraph" && inserted.style, "ListParagraph");
    assert.equal(inserted.kind === "paragraph" && inserted.listLevel, 0);
  });

  test("an explicit style overrides the inherited one", async () => {
    const bytes = await docxFixture({ body: para("body text") });
    const out = await apply(bytes, [
      { op: "insert_paragraph", after: "p1", text: "Appendix", style: "Heading2" },
    ]);
    const outline = await readDocx(out, { scope: "body" });
    assert.equal(
      outline.parts[0].blocks[1].kind === "paragraph" &&
        outline.parts[0].blocks[1].style,
      "Heading2",
    );
  });

  test("an array of lines becomes several paragraphs, in order", async () => {
    const bytes = await docxFixture({ body: para("Answer: Yes.") + para("end") });
    const out = await apply(bytes, [
      { op: "insert_paragraph", after: "p1", text: ["• one", "• two", "• three"] },
    ]);
    assert.deepEqual(await bodyText(out), [
      "Answer: Yes.",
      "• one",
      "• two",
      "• three",
      "end",
    ]);
  });

  test("two separate operations after the same paragraph keep their order", async () => {
    // Ids are resolved against the document as it was read, so neither
    // operation has to reason about what the other did to the numbering.
    const bytes = await docxFixture({ body: para("anchor") + para("tail") });
    const out = await apply(bytes, [
      { op: "insert_paragraph", after: "p1", text: "first" },
      { op: "insert_paragraph", after: "p1", text: "second" },
    ]);
    assert.deepEqual(await bodyText(out), ["anchor", "first", "second", "tail"]);
  });

  test("inserts before a paragraph", async () => {
    const bytes = await docxFixture({ body: para("body") });
    const out = await apply(bytes, [
      { op: "insert_paragraph", before: "p1", text: "preamble" },
    ]);
    assert.deepEqual(await bodyText(out), ["preamble", "body"]);
  });

  test("needs exactly one of after and before", async () => {
    const bytes = await docxFixture({ body: para("body") });
    await assert.rejects(
      () => apply(bytes, [{ op: "insert_paragraph", text: "x" } as DocxOperation]),
      /needs `after` or `before`/,
    );
    await assert.rejects(
      () => apply(bytes, [{ op: "insert_paragraph", after: "p1", before: "p1", text: "x" }]),
      /not both/,
    );
  });

  test("append lands before the section properties, not after them", async () => {
    // `w:sectPr` must stay the last child of `w:body`. A paragraph written
    // after it is a document Word declares corrupt.
    const bytes = await docxFixture({ body: para("first") });
    const out = await apply(bytes, [{ op: "append_paragraph", text: "Prepared by Jamie." }]);
    const xml = await bodyXml(out);
    assert.ok(
      xml.indexOf("Prepared by Jamie.") < xml.indexOf("<w:sectPr"),
      "appended paragraph escaped past the section properties",
    );
    assert.deepEqual(await bodyText(out), ["first", "Prepared by Jamie."]);
  });

  test("append gives an empty body an inside to append into", async () => {
    // `<w:body/>` has no inside. Writing past its closing bracket made the
    // paragraph a sibling of the body rather than content of it, and the tool
    // reported success on a document Word shows as empty.
    const bytes = await docxFixture({
      body: "",
      rawDocument:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<w:document ${W_NAMESPACES}><w:body/></w:document>`,
    });
    const out = await apply(bytes, [{ op: "append_paragraph", text: "First line" }]);
    const xml = await bodyXml(out);
    assert.ok(
      xml.includes("<w:body><w:p>"),
      `the paragraph landed outside the body: ${xml}`,
    );
    assert.deepEqual(await bodyText(out), ["First line"]);
  });

  test("append accepts an array too", async () => {
    const bytes = await docxFixture({ body: para("first") });
    const out = await apply(bytes, [{ op: "append_paragraph", text: ["a", "b"] }]);
    assert.deepEqual(await bodyText(out), ["first", "a", "b"]);
  });
});

describe("delete_paragraph", () => {
  test("removes the paragraph", async () => {
    const bytes = await docxFixture({ body: para("keep") + para("drop") + para("keep too") });
    const out = await apply(bytes, [{ op: "delete_paragraph", id: "p2" }]);
    assert.deepEqual(await bodyText(out), ["keep", "keep too"]);
  });

  test("refuses to empty a table cell of its last paragraph", async () => {
    // Word reports a `w:tc` with no `w:p` as a corrupt file, so the refusal
    // names the operation that does what the caller wanted.
    const bytes = await docxFixture({ body: table([["Question", "Answer"]]) });
    await assert.rejects(
      () => apply(bytes, [{ op: "delete_paragraph", id: "p2" }]),
      /only paragraph in its table cell.*set_table_cell/s,
    );
  });

  test("sees through a content control to the cell it must not empty", async () => {
    // A cell-level control stands between the cell and its paragraph, so a
    // guard that looked only at the direct parent let the last paragraph be
    // deleted out of the cell — leaving a `w:tc` with no block content, which
    // Word reports as a corrupt file.
    const bytes = await docxFixture({
      body:
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc>' +
        '<w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>' +
        '<w:sdt><w:sdtPr><w:alias w:val="Answer"/><w:text/></w:sdtPr><w:sdtContent>' +
        para("only paragraph") +
        "</w:sdtContent></w:sdt></w:tc></w:tr></w:tbl>" +
        para("after"),
    });
    await assert.rejects(
      () => apply(bytes, [{ op: "delete_paragraph", id: "p1" }]),
      /only paragraph in its table cell/,
    );
  });

  test("refuses to leave the document with no paragraph at all", async () => {
    const bytes = await docxFixture({ body: para("the only one") });
    await assert.rejects(
      () => apply(bytes, [{ op: "delete_paragraph", id: "p1" }]),
      /only paragraph/,
    );
  });
});

describe("set_table_cell", () => {
  test("writes an answer into the cell beside a question", async () => {
    const bytes = await docxFixture({
      body: table([
        ["Control", "Status"],
        ["Encryption at rest", ""],
      ]),
    });
    const out = await apply(bytes, [{ op: "set_table_cell", id: "t1r2c2", text: "Implemented" }]);
    const outline = await readDocx(out, { scope: "body" });
    const grid = outline.parts[0].blocks[0];
    assert.equal(grid.kind, "table");
    assert.equal(grid.kind === "table" && grid.rows[1].cells[1].text, "Implemented");
    assert.equal(grid.kind === "table" && grid.rows[1].cells[0].text, "Encryption at rest");
  });

  test("a newline makes a second paragraph inside the cell", async () => {
    const bytes = await docxFixture({ body: table([["a", "b"]]) });
    const out = await apply(bytes, [
      { op: "set_table_cell", id: "t1r1c2", text: "line one\nline two" },
    ]);
    const outline = await readDocx(out, { scope: "body" });
    const grid = outline.parts[0].blocks[0];
    assert.equal(grid.kind === "table" && grid.rows[0].cells[1].text, "line one\nline two");
    assert.equal(
      grid.kind === "table" && grid.rows[0].cells[1].paragraphIds?.length,
      2,
      "each paragraph in the cell should be separately addressable",
    );
  });

  test("replacing a multi-paragraph cell drops the paragraphs it replaced", async () => {
    const bytes = await docxFixture({
      body:
        '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>' +
        '<w:gridCol w:w="2400"/></w:tblGrid><w:tr><w:tc><w:tcPr>' +
        '<w:tcW w:w="2400" w:type="dxa"/></w:tcPr>' +
        para("first") +
        para("second") +
        para("third") +
        "</w:tc></w:tr></w:tbl>" +
        para("after"),
    });
    const out = await apply(bytes, [{ op: "set_table_cell", id: "t1r1c1", text: "only" }]);
    const outline = await readDocx(out, { scope: "body" });
    const grid = outline.parts[0].blocks[0];
    assert.equal(grid.kind === "table" && grid.rows[0].cells[0].text, "only");
    assert.equal(outline.paragraphCount, 2, "one cell paragraph plus the trailing one");
  });

  test("refuses an id that is not a cell", async () => {
    const bytes = await docxFixture({ body: para("x") + table([["a"]]) });
    await assert.rejects(
      () => apply(bytes, [{ op: "set_table_cell", id: "p1", text: "y" }]),
      /not a table cell/,
    );
    await assert.rejects(
      () => apply(bytes, [{ op: "set_table_cell", id: "t1r9c9", text: "y" }]),
      /No table cell called "t1r9c9"/,
    );
  });
});

describe("set_field — modern content controls", () => {
  test("sets a plain-text control and clears its placeholder styling", async () => {
    // `w:showingPlcHdr` renders the content in grey placeholder style, so a
    // real answer left under that flag still looks unfilled to a human.
    const bytes = await docxFixture({
      body: textControl("Supplier name", "supplier", "Click to enter"),
    });
    const out = await apply(bytes, [
      { op: "set_field", id: "f1", value: "Acme Industrial Ltd" },
    ]);
    assert.ok(!(await bodyXml(out)).includes("showingPlcHdr"));
    const outline = await readDocx(out, { scope: "body" });
    assert.equal(outline.fields[0].value, "Acme Industrial Ltd");
  });

  test("keeps the control's run formatting", async () => {
    const bytes = await docxFixture({ body: textControl("Name", "name", "x") });
    const xml = await bodyXml(await apply(bytes, [{ op: "set_field", id: "f1", value: "Ada" }]));
    assert.ok(xml.includes("<w:b/>"), "lost the bold the template asked for");
  });

  test("ticks a checkbox and writes the glyph the template declared", async () => {
    const bytes = await docxFixture({ body: checkboxControl("Agreed", false) });
    const out = await apply(bytes, [{ op: "set_field", id: "f1", checked: true }]);
    const xml = await bodyXml(out);
    assert.ok(xml.includes('<w14:checked w14:val="1"/>'));
    // 2612 is the code point the fixture's `w14:checkedState` names.
    assert.ok(xml.includes("☒"), "did not draw the ticked glyph");
    const outline = await readDocx(out, { scope: "body" });
    assert.equal(outline.fields[0].checked, true);
  });

  test("unticks a checkbox back to its unchecked glyph", async () => {
    const bytes = await docxFixture({ body: checkboxControl("Agreed", true) });
    const out = await apply(bytes, [{ op: "set_field", id: "f1", checked: false }]);
    const xml = await bodyXml(out);
    assert.ok(xml.includes('<w14:checked w14:val="0"/>'));
    assert.ok(xml.includes("☐"));
  });

  test("a checkbox refuses a value and says to pass checked", async () => {
    const bytes = await docxFixture({ body: checkboxControl("Agreed", false) });
    await assert.rejects(
      () => apply(bytes, [{ op: "set_field", id: "f1", value: "yes" }]),
      /checkbox.*`checked`/s,
    );
  });

  test("a dropdown accepts a declared option, case-insensitively", async () => {
    const bytes = await docxFixture({
      body: dropdownControl("Region", ["EMEA", "AMER", "APAC"], "EMEA"),
    });
    const out = await apply(bytes, [{ op: "set_field", id: "f1", value: "apac" }]);
    const outline = await readDocx(out, { scope: "body" });
    assert.equal(outline.fields[0].value, "APAC", "should normalise to the declared spelling");
  });

  test("a dropdown refuses a value outside its option set, and lists them", async () => {
    const bytes = await docxFixture({
      body: dropdownControl("Region", ["EMEA", "AMER"], "EMEA"),
    });
    await assert.rejects(
      () => apply(bytes, [{ op: "set_field", id: "f1", value: "Antarctica" }]),
      /not one of f1's options \(EMEA, AMER\)/,
    );
  });
});

describe("set_field — Word 97 form fields", () => {
  test("sets a FORMTEXT field's displayed result", async () => {
    const bytes = await docxFixture({ body: legacyTextField("CompanyName", "") });
    const out = await apply(bytes, [{ op: "set_field", id: "f1", value: "Acme Ltd" }]);
    const outline = await readDocx(out, { scope: "body" });
    assert.equal(outline.fields[0].flavour, "legacy");
    assert.equal(outline.fields[0].value, "Acme Ltd");
  });

  test("replacing a FORMTEXT result keeps the field machinery intact", async () => {
    const bytes = await docxFixture({ body: legacyTextField("CompanyName", "old") });
    const xml = await bodyXml(await apply(bytes, [{ op: "set_field", id: "f1", value: "new" }]));
    assert.ok(xml.includes('w:fldCharType="begin"'));
    assert.ok(xml.includes('w:fldCharType="separate"'));
    assert.ok(xml.includes('w:fldCharType="end"'));
    assert.ok(xml.includes("FORMTEXT"));
    assert.ok(!xml.includes(">old<"));
  });

  test("ticks a FORMCHECKBOX", async () => {
    const bytes = await docxFixture({ body: legacyCheckbox("Accepted", false) });
    const out = await apply(bytes, [{ op: "set_field", id: "f1", checked: true }]);
    assert.ok((await bodyXml(out)).includes('<w:checked w:val="1"/>'));
    assert.equal((await readDocx(out, { scope: "body" })).fields[0].checked, true);
  });

  test("unticks a FORMCHECKBOX that Word left with a bare <w:checked/>", async () => {
    const bytes = await docxFixture({ body: legacyCheckbox("Accepted", true) });
    const out = await apply(bytes, [{ op: "set_field", id: "f1", checked: false }]);
    assert.equal((await readDocx(out, { scope: "body" })).fields[0].checked, false);
  });

  test("a new dropdown result leads the list, where the schema declares it", async () => {
    // `CT_FFDDList` is `result?, default?, listEntry*`. Appended after the
    // entries the element is out of sequence, which Word offers to repair
    // rather than open — and the tool's own read-back cannot see the
    // difference, so nothing else would catch it.
    const bytes = await docxFixture({
      body:
        '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData>' +
        '<w:name w:val="Country"/><w:enabled/>' +
        '<w:ddList><w:listEntry w:val="UK"/><w:listEntry w:val="France"/></w:ddList>' +
        "</w:ffData></w:fldChar></w:r>" +
        '<w:r><w:instrText xml:space="preserve"> FORMDROPDOWN </w:instrText></w:r>' +
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
        "<w:r><w:t>UK</w:t></w:r>" +
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
    });
    const xml = await bodyXml(
      await apply(bytes, [{ op: "set_field", name: "Country", value: "France" }]),
    );
    assert.match(xml, /<w:ddList><w:result w:val="1"\/><w:listEntry/);
  });

  test("a legacy dropdown records the option's index, which is what Word reads", async () => {
    const bytes = await docxFixture({
      body: legacyDropdown("Term", ["Annual", "Monthly", "Quarterly"], 0),
    });
    const out = await apply(bytes, [{ op: "set_field", id: "f1", value: "Quarterly" }]);
    assert.ok((await bodyXml(out)).includes('<w:result w:val="2"/>'));
    assert.equal((await readDocx(out, { scope: "body" })).fields[0].value, "Quarterly");
  });
});

describe("set_field — addressing", () => {
  test("finds a field by the name a human sees in Word", async () => {
    const bytes = await docxFixture({
      body: textControl("Supplier name", "supplier", "…") + textControl("Contact", "contact", "…"),
    });
    const out = await apply(bytes, [{ op: "set_field", name: "Contact", value: "Ada" }]);
    const outline = await readDocx(out, { scope: "body" });
    assert.equal(outline.fields[1].value, "Ada");
    assert.equal(outline.fields[0].value, "…", "wrote into the wrong field");
  });

  test("finds a field by its tag, which is what a template author scripts against", async () => {
    const bytes = await docxFixture({ body: textControl("Supplier name", "supplier_id", "…") });
    const out = await apply(bytes, [{ op: "set_field", name: "supplier_id", value: "A-1" }]);
    assert.equal((await readDocx(out, { scope: "body" })).fields[0].value, "A-1");
  });

  test("refuses an ambiguous name rather than guessing which one was meant", async () => {
    const bytes = await docxFixture({
      body: textControl("Date", "d1", "…") + textControl("Date", "d2", "…"),
    });
    await assert.rejects(
      () => apply(bytes, [{ op: "set_field", name: "Date", value: "2026-01-01" }]),
      /matches 2 fields \(f1, f2\).*address one by id/s,
    );
  });

  test("reports an unknown field by the name that was asked for", async () => {
    const bytes = await docxFixture({ body: textControl("Supplier", "s", "…") });
    await assert.rejects(
      () => apply(bytes, [{ op: "set_field", id: "f9", value: "x" }]),
      /No form field called "f9"/,
    );
    await assert.rejects(
      () => apply(bytes, [{ op: "set_field", name: "Invoice number", value: "x" }]),
      /No form field named "Invoice number"/,
    );
  });
});

describe("replace_text", () => {
  test("finds a phrase Word split across runs", async () => {
    // The case a per-element search silently misses: nothing in the markup
    // says these three runs are one phrase.
    const bytes = await docxFixture({ body: splitPara(["Full", " nam", "e: ______"]) });
    const out = await apply(bytes, [
      { op: "replace_text", find: "Full name: ______", replace: "Full name: Ada Lovelace" },
    ]);
    assert.deepEqual(await bodyText(out), ["Full name: Ada Lovelace"]);
  });

  test("replaces several occurrences inside one run without tripping over itself", async () => {
    // Both matches live in the same `w:t`, so the two splices would collide if
    // they were emitted independently.
    const bytes = await docxFixture({ body: para("☐ Yes  ☐ No  ☐ N/A") });
    const out = await apply(bytes, [{ op: "replace_text", find: "☐", replace: "☒" }]);
    assert.deepEqual(await bodyText(out), ["☒ Yes  ☒ No  ☒ N/A"]);
  });

  test("`within` confines the change to one paragraph", async () => {
    // Every question on a questionnaire has its own ☐ Yes; ticking question
    // three must not tick the rest.
    const bytes = await docxFixture({
      body: para("Q1 ☐ Yes ☐ No") + para("Q2 ☐ Yes ☐ No") + para("Q3 ☐ Yes ☐ No"),
    });
    const out = await apply(bytes, [
      { op: "replace_text", find: "☐ Yes", replace: "☒ Yes", within: "p2" },
    ]);
    assert.deepEqual(await bodyText(out), [
      "Q1 ☐ Yes ☐ No",
      "Q2 ☒ Yes ☐ No",
      "Q3 ☐ Yes ☐ No",
    ]);
  });

  test("`within` accepts a table cell and a whole table", async () => {
    const bytes = await docxFixture({
      body: para("outside TBC") + table([["TBC", "TBC"]]),
    });
    const cellOnly = await apply(bytes, [
      { op: "replace_text", find: "TBC", replace: "Done", within: "t1r1c1" },
    ]);
    let outline = await readDocx(cellOnly, { scope: "body" });
    let grid = outline.parts[0].blocks[1];
    assert.equal(grid.kind === "table" && grid.rows[0].cells[0].text, "Done");
    assert.equal(grid.kind === "table" && grid.rows[0].cells[1].text, "TBC");

    const wholeTable = await apply(bytes, [
      { op: "replace_text", find: "TBC", replace: "Done", within: "t1" },
    ]);
    outline = await readDocx(wholeTable, { scope: "body" });
    grid = outline.parts[0].blocks[1];
    assert.equal(grid.kind === "table" && grid.rows[0].cells[1].text, "Done");
    assert.equal(
      outline.parts[0].blocks[0].kind === "paragraph" && outline.parts[0].blocks[0].text,
      "outside TBC",
      "a table scope must not reach the body paragraph",
    );
  });

  test("all: false stops after the first occurrence in the document", async () => {
    const bytes = await docxFixture({ body: para("TBC") + para("TBC") });
    const out = await apply(bytes, [
      { op: "replace_text", find: "TBC", replace: "Done", all: false },
    ]);
    assert.deepEqual(await bodyText(out), ["Done", "TBC"]);
  });

  test("matching ignores case by default and can be made exact", async () => {
    const bytes = await docxFixture({ body: para("Draft and DRAFT") });
    assert.deepEqual(
      await bodyText(await apply(bytes, [{ op: "replace_text", find: "draft", replace: "Final" }])),
      ["Final and Final"],
    );
    assert.deepEqual(
      await bodyText(
        await apply(bytes, [
          { op: "replace_text", find: "DRAFT", replace: "Final", matchCase: true },
        ]),
      ),
      ["Draft and Final"],
    );
  });

  test("an empty replacement deletes the text", async () => {
    const bytes = await docxFixture({ body: para("Confidential — do not circulate") });
    const out = await apply(bytes, [
      { op: "replace_text", find: " — do not circulate", replace: "" },
    ]);
    assert.deepEqual(await bodyText(out), ["Confidential"]);
  });

  test("a miss is an error, not a silent success", async () => {
    // Reporting "done" for a replacement that changed nothing is how a
    // half-finished document gets handed to a human as a finished one.
    const bytes = await docxFixture({ body: para("nothing to find here") });
    await assert.rejects(
      () => apply(bytes, [{ op: "replace_text", find: "Signature:", replace: "Ada" }]),
      /Found no "Signature:"/,
    );
  });

  test("a miss inside a scope names the scope", async () => {
    const bytes = await docxFixture({ body: para("alpha") + para("beta") });
    await assert.rejects(
      () => apply(bytes, [{ op: "replace_text", find: "alpha", replace: "x", within: "p2" }]),
      /Found no "alpha" in p2/,
    );
  });

  test("an unknown scope is refused by name", async () => {
    const bytes = await docxFixture({ body: para("alpha") });
    await assert.rejects(
      () => apply(bytes, [{ op: "replace_text", find: "alpha", replace: "x", within: "p99" }]),
      /No paragraph, cell, table or part called "p99"/,
    );
  });

  test("refuses an empty search string", async () => {
    const bytes = await docxFixture({ body: para("alpha") });
    await assert.rejects(
      () => apply(bytes, [{ op: "replace_text", find: "", replace: "x" }]),
      /non-empty `find`/,
    );
  });

  test("keeps the formatting of the run the match started in", async () => {
    const bytes = await docxFixture({
      body:
        '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Status: </w:t></w:r>' +
        "<w:r><w:t>TBC</w:t></w:r></w:p>",
    });
    const xml = await bodyXml(
      await apply(bytes, [{ op: "replace_text", find: "Status: TBC", replace: "Status: Done" }]),
    );
    assert.ok(xml.includes("<w:b/>"), "lost the bold on the label run");
  });

  test("adds xml:space when the replacement gains an edge space", async () => {
    const bytes = await docxFixture({ body: para("[X]") });
    const out = await apply(bytes, [{ op: "replace_text", find: "[X]", replace: " Ada " }]);
    assert.ok((await bodyXml(out)).includes('xml:space="preserve"'));
    assert.deepEqual(await bodyText(out), [" Ada "]);
  });
});

describe("other parts of the package", () => {
  test("edits a header, whose answer boxes a body-only reader would miss", async () => {
    const bytes = await docxFixture({
      body: para("body text"),
      parts: { header1: para("Reference: TBC") },
    });
    const out = await apply(bytes, [
      { op: "set_paragraph", id: "header1:p1", text: "Reference: MH-2026-014" },
    ]);
    const outline = await readDocx(out);
    const header = outline.parts.find((part) => part.key === "header1");
    assert.equal(
      header?.blocks[0].kind === "paragraph" && header.blocks[0].text,
      "Reference: MH-2026-014",
    );
  });

  test("a part nobody edited comes back byte-identical", async () => {
    // The promise the whole splice design exists to keep.
    const bytes = await docxFixture({
      body: para("body text"),
      parts: { header1: para("Letterhead"), footer1: para("Page footer") },
    });
    const before = await DocxPackage.open(bytes);
    const headerBefore = await before.requireText("word/header1.xml");
    const footerBefore = await before.requireText("word/footer1.xml");

    const out = await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "changed" }]);
    const after = await DocxPackage.open(out);
    assert.equal(await after.requireText("word/header1.xml"), headerBefore);
    assert.equal(await after.requireText("word/footer1.xml"), footerBefore);
  });

  test("an edit changes only the region it named", async () => {
    // The paragraph that was addressed is rewritten; everything on either side
    // of it — including the section properties and the revision ids Word hangs
    // off each element — must come through as the same characters.
    const bytes = await docxFixture({ body: para("first") + para("second") + para("third") });
    const before = await bodyXml(bytes);
    const after = await bodyXml(
      await apply(bytes, [{ op: "set_paragraph", id: "p2", text: "SECOND" }]),
    );

    const paragraphsOf = (xml: string) =>
      descendantsNamed(parseXml(xml), "w:p").map((node) => ({ ...node }));
    const beforeParagraphs = paragraphsOf(before);
    const afterParagraphs = paragraphsOf(after);

    assert.equal(
      before.slice(0, beforeParagraphs[1].start),
      after.slice(0, afterParagraphs[1].start),
      "the text before the edited paragraph moved",
    );
    assert.equal(
      before.slice(beforeParagraphs[1].end),
      after.slice(afterParagraphs[1].end),
      "the text after the edited paragraph changed",
    );
    assert.ok(after.includes(">SECOND<"));
    assert.ok(!after.includes(">second<"));
  });
});

describe("the batch is all or nothing", () => {
  test("one bad id abandons every operation in the batch", async () => {
    // A run of eight answers that quietly skipped the two with wrong ids
    // produces a questionnaire that looks complete and is not.
    const bytes = await docxFixture({ body: para("a") + para("b") });
    await assert.rejects(
      () =>
        apply(bytes, [
          { op: "set_paragraph", id: "p1", text: "written" },
          { op: "set_paragraph", id: "p94", text: "impossible" },
        ]),
      /No paragraph called "p94"/,
    );
    // And the source is untouched: `editDocx` never mutates its input.
    assert.deepEqual(await bodyText(bytes), ["a", "b"]);
  });

  test("every problem is reported together, so one round trip fixes them all", async () => {
    const bytes = await docxFixture({ body: para("a") });
    try {
      await apply(bytes, [
        { op: "set_paragraph", id: "p50", text: "x" },
        { op: "set_table_cell", id: "t9r1c1", text: "y" },
        { op: "set_field", id: "f7", value: "z" },
      ]);
      assert.fail("expected a rejection");
    } catch (error) {
      assert.ok(error instanceof DocxEditError);
      assert.equal(error.status, 400);
      assert.equal(error.problems.length, 3);
      assert.match(error.message, /p50/);
      assert.match(error.message, /t9r1c1/);
      assert.match(error.message, /f7/);
    }
  });

  test("two operations claiming the same run are refused, not merged", async () => {
    const bytes = await docxFixture({ body: para("alpha beta") });
    await assert.rejects(
      () =>
        apply(bytes, [
          { op: "set_paragraph", id: "p1", text: "one" },
          { op: "set_paragraph", id: "p1", text: "two" },
        ]),
      /changed the same part of/,
    );
  });

  test("an empty operation list is refused rather than producing a pointless copy", async () => {
    const bytes = await docxFixture({ body: para("a") });
    await assert.rejects(() => editDocx(bytes, []), /nothing to change/);
  });

  test("a file that is not a Word document is refused before any parsing", async () => {
    await assert.rejects(
      () => editDocx(Buffer.from("%PDF-1.7 not a word document"), [
        { op: "append_paragraph", text: "x" },
      ]),
      (error: unknown) => error instanceof DocxError && /PDF/.test(error.message),
    );
  });
});

describe("the result it reports", () => {
  test("lists what it applied, in the order given", async () => {
    const bytes = await docxFixture({ body: para("Answer here") + para("end") });
    const result = await editDocx(bytes, [
      { op: "set_paragraph", id: "p1", text: "Answer: yes" },
      { op: "insert_paragraph", after: "p1", text: ["• one", "• two"] },
      { op: "replace_text", find: "end", replace: "fin" },
      { op: "append_paragraph", text: "Prepared by Jamie." },
    ]);
    assert.deepEqual(result.applied, [
      "set_paragraph p1",
      "insert_paragraph 2 after p1",
      'replace_text 1x "end"',
      "append_paragraph 1",
    ]);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(await bodyText(result.bytes), [
      "Answer: yes",
      "• one",
      "• two",
      "fin",
      "Prepared by Jamie.",
    ]);
  });

  test("the produced bytes are a document the rest of the system can open", async () => {
    const bytes = await docxFixture({ body: para("before") });
    const out = await apply(bytes, [{ op: "set_paragraph", id: "p1", text: "after" }]);
    const pkg = await DocxPackage.open(out);
    assert.ok(pkg.has(DOCUMENT_PART));
    assert.ok((await readDocx(out)).paragraphCount >= 1);
  });
});
