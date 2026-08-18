import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CELL_ENVELOPE_CHARS,
  docxBufferToText,
  PARAGRAPH_ENVELOPE_CHARS,
  readDocx,
  type DocxOutline,
  type DocxParagraphBlock,
  type DocxPartView,
  type DocxTableBlock,
  type ReadDocxOptions,
} from "./docxRead.js";
import { symbolCharacter } from "./docxModel.js";
import {
  cell,
  checkboxControl,
  docxFixture,
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
 * Reading a Word document, from both ends: the addressable outline an employee
 * edits against, and the plain text every other surface gets.
 *
 * Two failures are worth more than the rest put together. The first is the one
 * that started this feature — a `.docx` arrives, the tool says "no readable
 * text", and the employee concludes an eight-page questionnaire is empty
 * because its answer boxes were content controls, or Word 97 form fields, or
 * sat in a header. The second is quieter and worse: ids are positional, so an
 * outline that drops an empty paragraph or emits a cell's paragraphs twice
 * hands back `p12` for what the caller will later edit as `p11`, and the answer
 * lands in the wrong line of a document nobody re-reads before sending.
 *
 * So most of what follows is about *which* text comes back and *what it is
 * called*, not about whether the parse succeeded.
 */

async function outlineOf(body: string, options?: ReadDocxOptions): Promise<DocxOutline> {
  return readDocx(await docxFixture({ body }), options);
}

function partOf(outline: DocxOutline, key = ""): DocxPartView {
  const part = outline.parts.find((candidate) => candidate.key === key);
  if (!part) throw new Error(`outline has no part keyed "${key}"`);
  return part;
}

function paragraphsIn(outline: DocxOutline, key = ""): DocxParagraphBlock[] {
  return partOf(outline, key).blocks.filter(
    (block): block is DocxParagraphBlock => block.kind === "paragraph",
  );
}

function tablesIn(outline: DocxOutline, key = ""): DocxTableBlock[] {
  return partOf(outline, key).blocks.filter(
    (block): block is DocxTableBlock => block.kind === "table",
  );
}

function onlyTable(outline: DocxOutline, key = ""): DocxTableBlock {
  const tables = tablesIn(outline, key);
  if (tables.length !== 1) throw new Error(`expected one top-level table, saw ${tables.length}`);
  return tables[0];
}

/** A paragraph whose run is written longhand, for the run-level cases. */
function runPara(inner: string): string {
  return `<w:p><w:r>${inner}</w:r></w:p>`;
}

/** A cell carrying extra `w:tcPr` — the spans and merges `cell()` does not do. */
function shapedCell(text: string, properties: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${properties}</w:tcPr>${para(text)}</w:tc>`;
}

/** A cell holding arbitrary block content: several paragraphs, a nested table. */
function blockCell(content: string): string {
  return `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${content}</w:tc>`;
}

function rowOf(cells: string[], properties = ""): string {
  return `<w:tr w:rsidR="00C78D90">${properties}${cells.join("")}</w:tr>`;
}

function tableOf(rows: string[]): string {
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    `<w:tblGrid><w:gridCol w:w="2400"/></w:tblGrid>${rows.join("")}</w:tbl>`
  );
}

describe("readDocx - paragraphs", () => {
  test("numbers paragraphs in document order and keeps the empty ones", async () => {
    // The blank line between two questions is where the answer gets written.
    // Dropping it would not just lose a target, it would renumber every id
    // after it, so a later edit aimed at `p3` would land on `p4`.
    const outline = await outlineOf([para("First"), para(""), para("Third")].join(""));
    const blocks = partOf(outline).blocks;
    assert.deepEqual(
      blocks.map((block) => block.id),
      ["p1", "p2", "p3"],
    );
    assert.deepEqual(
      paragraphsIn(outline).map((block) => block.text),
      ["First", "", "Third"],
    );
    assert.equal(outline.paragraphCount, 3);
  });

  test("reports the style and list level Word recorded, and nothing when it did not", async () => {
    const outline = await outlineOf(
      [
        para("Application form", '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
        para("Ordinary body text"),
        para(
          "Bring photo ID",
          '<w:pPr><w:pStyle w:val="ListParagraph"/>' +
            '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr>',
        ),
      ].join(""),
    );
    const [heading, plain, bullet] = paragraphsIn(outline);
    assert.equal(heading.style, "Heading1");
    assert.equal(heading.listLevel, undefined);
    assert.equal(plain.style, undefined);
    assert.equal(plain.listLevel, undefined);
    assert.equal(bullet.style, "ListParagraph");
    assert.equal(bullet.listLevel, 1);
  });

  test("a list paragraph with no explicit w:ilvl is the outermost level", async () => {
    const outline = await outlineOf(
      para("Top level bullet", '<w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>'),
    );
    assert.equal(paragraphsIn(outline)[0].listLevel, 0);
  });

  test("a sentence Word split across runs comes back as one string", async () => {
    // Word splits mid-word for a spell-check pause or a saved revision id, so
    // "Full name:" routinely lives in three `w:t` elements. A reader working
    // one element at a time would never find the label the employee searches for.
    const outline = await outlineOf(splitPara(["Full ", "name", ":"]));
    const blocks = paragraphsIn(outline);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, "Full name:");
  });

  test("tabs, breaks and non-breaking hyphens read as the characters a human sees", async () => {
    const outline = await outlineOf(
      runPara(
        "<w:t>Name</w:t><w:tab/><w:t>Ada</w:t><w:br/><w:t>Second</w:t><w:cr/>" +
          "<w:t>Third</w:t><w:noBreakHyphen/><w:t>Fourth</w:t><w:softHyphen/><w:t>Fifth</w:t>",
      ),
    );
    assert.equal(paragraphsIn(outline)[0].text, "Name\tAda\nSecond\nThird-FourthFifth");
  });

  test("a field instruction is machinery, not text", async () => {
    // ` FORMTEXT ` is an instruction to Word. Reporting it would put a word
    // the human cannot see into the middle of the answer.
    const outline = await outlineOf(legacyTextField("Applicant", "Ada Lovelace"));
    assert.equal(paragraphsIn(outline)[0].text, "Ada Lovelace");
  });

  test("a w:sym tick box renders as a box rather than vanishing", async () => {
    // Rendered as nothing, this paragraph reads "Yes  No" and the employee has
    // no way to tell which option is already ticked.
    const outline = await outlineOf(
      runPara(
        '<w:t xml:space="preserve">Yes </w:t><w:sym w:font="Wingdings" w:char="F0FE"/>' +
          '<w:t xml:space="preserve"> No </w:t><w:sym w:font="Wingdings" w:char="F0A8"/>',
      ),
    );
    assert.equal(paragraphsIn(outline)[0].text, "Yes ☑ No ☐");
  });
});

describe("symbolCharacter", () => {
  test("maps the Wingdings code points real questionnaires tick with", () => {
    assert.equal(symbolCharacter("Wingdings", "F0A8"), "☐");
    assert.equal(symbolCharacter("Wingdings", "F0FE"), "☑");
  });

  test("matches the font and code case-insensitively, and ignores stray spaces", () => {
    // Word writes `w:font="Wingdings"`, but documents that have been through a
    // converter arrive with any casing at all.
    assert.equal(symbolCharacter("WINGDINGS", " f0a8 "), "☐");
  });

  test("an unmapped font still yields a box when the code point is a box", () => {
    assert.equal(symbolCharacter("MS Gothic", "F0A8"), "☐");
    assert.equal(symbolCharacter("MS Gothic", "F0FD"), "☒");
  });

  test("an unmapped code point survives as its plain character", () => {
    // Symbol fonts sit at F000 + the ASCII code; stripping the offset keeps at
    // least the shape rather than dropping the character.
    assert.equal(symbolCharacter("Wingdings", "F041"), "A");
    assert.equal(symbolCharacter("Arial", "0041"), "A");
  });

  test("renders nothing for a control code or a code that is not hex", () => {
    assert.equal(symbolCharacter("Wingdings", "F001"), "");
    assert.equal(symbolCharacter("Wingdings", "zz"), "");
    assert.equal(symbolCharacter("", ""), "");
  });
});

describe("readDocx - tables", () => {
  test("gives the table and every cell an id, and flags the header row", async () => {
    const outline = await outlineOf(
      table([
        ["Question", "Answer"],
        ["Full name", "Ada Lovelace"],
      ]),
    );
    const found = onlyTable(outline);
    assert.equal(found.id, "t1");
    assert.equal(found.rows[0].header, true);
    // Only the header row carries the flag; a body row must not claim to be one.
    assert.equal(found.rows[1].header, undefined);
    assert.deepEqual(
      found.rows[0].cells.map((c) => c.id),
      ["t1r1c1", "t1r1c2"],
    );
    assert.deepEqual(
      found.rows[1].cells.map((c) => c.id),
      ["t1r2c1", "t1r2c2"],
    );
    assert.deepEqual(
      found.rows[1].cells.map((c) => c.text),
      ["Full name", "Ada Lovelace"],
    );
    assert.equal(outline.tableCount, 1);
  });

  test("a column span and a vertical merge come back as the cell's shape", async () => {
    // A merged continuation cell looks blank and is not a separate answer box;
    // writing into it puts the text somewhere the human never sees.
    const outline = await outlineOf(
      tableOf([
        rowOf([shapedCell("Section A", '<w:gridSpan w:val="3"/>')]),
        rowOf([shapedCell("Address", '<w:vMerge w:val="restart"/>'), cell("12 High Street")]),
        rowOf([shapedCell("", "<w:vMerge/>"), cell("Cambridge")]),
      ]),
    );
    const rows = onlyTable(outline).rows;
    assert.equal(rows[0].cells[0].colspan, 3);
    assert.equal(rows[0].cells[0].mergedUp, undefined);
    // The row that starts a merge is a real cell; only the continuation is not.
    assert.equal(rows[1].cells[0].colspan, undefined);
    assert.equal(rows[1].cells[0].mergedUp, undefined);
    assert.equal(rows[2].cells[0].mergedUp, true);
  });

  test("a cell lists its paragraph ids only when it holds more than one", async () => {
    // One paragraph means the cell id is address enough; listing it again is
    // noise in every outline of every table, which is most documents.
    const outline = await outlineOf(
      tableOf([rowOf([cell("Only line"), blockCell(para("First") + para("Second"))])]),
    );
    const cells = onlyTable(outline).rows[0].cells;
    assert.equal(cells[0].paragraphIds, undefined);
    assert.equal(cells[0].text, "Only line");
    assert.deepEqual(cells[1].paragraphIds, ["p2", "p3"]);
    assert.equal(cells[1].text, "First\nSecond");
  });

  test("cell paragraphs are not top-level blocks, but they do consume ids", async () => {
    // Emitting them twice would double the outline and, worse, make the id of
    // the paragraph after the table depend on how the reader counted.
    const outline = await outlineOf(
      [
        para("Intro"),
        table([
          ["a", "b"],
          ["c", "d"],
        ]),
        para("After"),
      ].join(""),
    );
    const blocks = partOf(outline).blocks;
    assert.deepEqual(
      blocks.map((block) => block.kind),
      ["paragraph", "table", "paragraph"],
    );
    assert.deepEqual(
      blocks.map((block) => block.id),
      ["p1", "t1", "p6"],
    );
    assert.equal(outline.paragraphCount, 6);
  });

  test("a table nested inside a cell hangs off that cell", async () => {
    const outline = await outlineOf(
      tableOf([rowOf([blockCell(para("Outer") + tableOf([rowOf([cell("Inner")])]))])]),
    );
    const outer = onlyTable(outline);
    assert.equal(outer.id, "t1");
    const host = outer.rows[0].cells[0];
    assert.equal(host.tables?.length, 1);
    assert.equal(host.tables?.[0].id, "t2");
    assert.equal(host.tables?.[0].rows[0].cells[0].id, "t2r1c1");
    assert.equal(host.tables?.[0].rows[0].cells[0].text, "Inner");
    // The nested table is one paragraph of the host cell's own text, so the
    // host is still a single-paragraph cell.
    assert.equal(host.paragraphIds, undefined);
    assert.equal(outline.tableCount, 2);
  });

  test("a paragraph wrapped in a block-level content control is still a paragraph", async () => {
    // Template authors wrap whole sections in an `w:sdt`. The human sees a
    // heading and a paragraph; an outline that saw neither would look empty.
    const outline = await outlineOf(
      '<w:sdt><w:sdtPr><w:tag w:val="section"/></w:sdtPr><w:sdtContent>' +
        `${para("Inside the control")}${table([["k", "v"]])}` +
        "</w:sdtContent></w:sdt>",
    );
    assert.deepEqual(
      paragraphsIn(outline).map((block) => ({ id: block.id, text: block.text })),
      [{ id: "p1", text: "Inside the control" }],
    );
    assert.equal(onlyTable(outline).id, "t1");
  });
});

describe("readDocx - form fields", () => {
  test("a plain-text content control reports its alias, tag and current value", async () => {
    const outline = await outlineOf(textControl("Full name", "fullName", "Ada Lovelace"));
    assert.deepEqual(outline.fields, [
      {
        id: "f1",
        flavour: "sdt",
        kind: "text",
        name: "Full name",
        tag: "fullName",
        value: "Ada Lovelace",
        at: "p1",
      },
    ]);
    assert.equal(outline.hasFormFields, true);
  });

  test("a checkbox content control reports whether it is ticked", async () => {
    const outline = await outlineOf(
      checkboxControl("Agree to terms", true) + checkboxControl("Subscribe", false),
    );
    assert.deepEqual(outline.fields, [
      {
        id: "f1",
        flavour: "sdt",
        kind: "checkbox",
        name: "Agree to terms",
        value: "☒",
        checked: true,
        at: "p1",
      },
      {
        id: "f2",
        flavour: "sdt",
        kind: "checkbox",
        name: "Subscribe",
        value: "☐",
        checked: false,
        at: "p2",
      },
    ]);
  });

  test("a dropdown content control reports its options and the chosen one", async () => {
    // Without the option list the employee has to guess the exact spelling
    // Word will accept, and a value outside the list is silently not a choice.
    const outline = await outlineOf(
      dropdownControl("Country", ["United Kingdom", "France", "Spain"], "France"),
    );
    assert.deepEqual(outline.fields, [
      {
        id: "f1",
        flavour: "sdt",
        kind: "dropdown",
        name: "Country",
        value: "France",
        options: ["United Kingdom", "France", "Spain"],
        at: "p1",
      },
    ]);
  });

  test("a Word 97 text field reports the runs between separate and end", async () => {
    const outline = await outlineOf(legacyTextField("Applicant", "Ada Lovelace"));
    assert.deepEqual(outline.fields, [
      {
        id: "f1",
        flavour: "legacy",
        kind: "text",
        name: "Applicant",
        value: "Ada Lovelace",
        at: "p1",
      },
    ]);
  });

  test("a Word 97 checkbox is ticked whenever w:checked is present at all", async () => {
    // Word writes a bare `<w:checked/>` for a ticked box and only adds
    // `w:val="0"` when turning one off, so presence is the signal.
    const outline = await outlineOf(
      legacyCheckbox("Agree", true) + legacyCheckbox("Subscribe", false),
    );
    assert.deepEqual(outline.fields, [
      {
        id: "f1",
        flavour: "legacy",
        kind: "checkbox",
        name: "Agree",
        value: "",
        checked: true,
        at: "p1",
      },
      {
        id: "f2",
        flavour: "legacy",
        kind: "checkbox",
        name: "Subscribe",
        value: "",
        checked: false,
        at: "p2",
      },
    ]);
  });

  test("a Word 97 dropdown resolves w:result to the entry it selects", async () => {
    const outline = await outlineOf(
      legacyDropdown("Country", ["United Kingdom", "France", "Spain"], 1),
    );
    assert.deepEqual(outline.fields, [
      {
        id: "f1",
        flavour: "legacy",
        kind: "dropdown",
        name: "Country",
        value: "France",
        options: ["United Kingdom", "France", "Spain"],
        at: "p1",
      },
    ]);
  });

  test("`at` names a paragraph the outline actually hands back", async () => {
    // The point of `at` is orientation: it has to be an id the caller can look
    // up, including when the field sits in a table cell.
    const outline = await outlineOf(
      para("Intro") +
        tableOf([rowOf([cell("Applicant"), blockCell(legacyTextField("name", "Ada"))])]),
    );
    assert.equal(outline.fields.length, 1);
    assert.equal(outline.fields[0].at, "p3");
    const cells = onlyTable(outline).rows[0].cells;
    assert.equal(cells[1].text, "Ada");
  });

  test("hasFormFields is false for a document that has none", async () => {
    const outline = await outlineOf(para("Just prose") + table([["a", "b"]]));
    assert.deepEqual(outline.fields, []);
    assert.equal(outline.hasFormFields, false);
  });
});

describe("readDocx - field ids", () => {
  test("no two fields ever answer to the same id", async () => {
    // A `w:sdt` with no `w:sdtPr` is schema-legal and routinely emitted by
    // non-Word generators. Reading one used to take an id, recurse into the
    // paragraphs it wrapped — handing that same id to a control inside — and
    // only then roll the counter back. Two different answer boxes then shared
    // an id, and `set_field` filled the wrong one while reporting success.
    const wrapper =
      "<w:sdt><w:sdtContent>" +
      textControl("Supplier", "supplier", "Acme") +
      "</w:sdtContent></w:sdt>";
    const outline = await readDocx(
      await docxFixture({ body: para("Details") + wrapper + textControl("Contact", "contact", "Jo") }),
    );
    const ids = outline.fields.map((field) => field.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate field ids: ${ids.join(", ")}`);
    assert.deepEqual(
      outline.fields.map((field) => field.name),
      ["Supplier", "Contact"],
    );
  });

  test("a content control wrapping paragraphs is a field in its own right", async () => {
    // A template built the block-level way is a very common Word shape; read
    // as "not a form", none of its answer boxes could be addressed at all.
    const wrapper =
      '<w:sdt><w:sdtPr><w:alias w:val="Answer"/><w:tag w:val="answer"/><w:text/></w:sdtPr>' +
      "<w:sdtContent>" +
      para("Ada Lovelace") +
      "</w:sdtContent></w:sdt>";
    const outline = await readDocx(await docxFixture({ body: para("Full name:") + wrapper }));
    assert.equal(outline.hasFormFields, true);
    assert.equal(outline.fields[0].name, "Answer");
    assert.equal(outline.fields[0].tag, "answer");
    assert.equal(outline.fields[0].value, "Ada Lovelace");
  });
});

describe("readDocx - tracked changes", () => {
  test("inserted text is reported, deleted text is not", async () => {
    // A tracked deletion is a sentence the author already removed. Showing it
    // would have the employee answer a question that is no longer being asked.
    const outline = await outlineOf(
      '<w:p><w:ins w:id="1" w:author="Ada" w:date="2024-01-01T00:00:00Z">' +
        "<w:r><w:t>Please confirm</w:t></w:r></w:ins>" +
        '<w:del w:id="2" w:author="Ada" w:date="2024-01-01T00:00:00Z">' +
        "<w:r><w:delText> and countersign</w:delText></w:r></w:del>" +
        '<w:r><w:t xml:space="preserve"> below.</w:t></w:r></w:p>',
    );
    assert.equal(paragraphsIn(outline)[0].text, "Please confirm below.");
    assert.equal(outline.hasTrackedChanges, true);
  });

  test("hasTrackedChanges is false for a document nobody revised", async () => {
    const outline = await outlineOf(para("Clean copy"));
    assert.equal(outline.hasTrackedChanges, false);
  });

  test("a deletion-only revision still counts as tracked changes", async () => {
    const outline = await outlineOf(
      '<w:p><w:r><w:t>Kept.</w:t></w:r><w:del w:id="9" w:author="Ada" w:date="2024-01-01T00:00:00Z">' +
        "<w:r><w:delText>Removed.</w:delText></w:r></w:del></w:p>",
    );
    assert.equal(outline.hasTrackedChanges, true);
    assert.equal(paragraphsIn(outline)[0].text, "Kept.");
  });
});

describe("readDocx - parts and scope", () => {
  test("reads headers by default, prefixing their ids with the part key", async () => {
    // A questionnaire whose answer boxes live in a header reads as an empty
    // document without this, which is the failure the whole feature exists for.
    const bytes = await docxFixture({
      body: para("Body text"),
      parts: { header1: para("ACME Ltd") },
    });
    const outline = await readDocx(bytes);
    assert.deepEqual(
      outline.parts.map((part) => [part.key, part.path]),
      [
        ["", "word/document.xml"],
        ["header1", "word/header1.xml"],
      ],
    );
    assert.deepEqual(
      paragraphsIn(outline, "header1").map((block) => ({ id: block.id, text: block.text })),
      [{ id: "header1:p1", text: "ACME Ltd" }],
    );
    // Body ids stay bare, so an id from a body-only read still resolves.
    assert.equal(paragraphsIn(outline)[0].id, "p1");
    assert.equal(outline.paragraphCount, 2);
  });

  test("scope body reads word/document.xml and nothing else", async () => {
    const bytes = await docxFixture({
      body: para("Body text"),
      parts: { header1: para("ACME Ltd"), footer1: para("Page 1") },
    });
    const outline = await readDocx(bytes, { scope: "body" });
    assert.deepEqual(
      outline.parts.map((part) => part.path),
      ["word/document.xml"],
    );
    assert.equal(outline.paragraphCount, 1);
  });

  test("a field in a header is addressed within that header", async () => {
    const bytes = await docxFixture({
      body: para("Body text"),
      parts: { header1: textControl("Reference", "ref", "ABC-123") },
    });
    const outline = await readDocx(bytes);
    assert.equal(outline.hasFormFields, true);
    assert.equal(outline.fields[0].id, "header1:f1");
    assert.equal(outline.fields[0].at, "header1:p1");
    assert.equal(outline.fields[0].value, "ABC-123");
  });
});

describe("readDocx - counts and the character budget", () => {
  test("counts paragraphs, tables and words including the ones inside cells", async () => {
    const outline = await outlineOf(
      [para("The quick brown fox"), para(""), table([["one two", "three"]])].join(""),
    );
    assert.equal(outline.paragraphCount, 4);
    assert.equal(outline.tableCount, 1);
    assert.equal(outline.wordCount, 7);
  });

  test("maxChars clips the text it hands back and says that it did", async () => {
    const outline = await outlineOf(para("HelloWorld") + para("Second"), {
      maxChars: PARAGRAPH_ENVELOPE_CHARS + 5,
    });
    const blocks = paragraphsIn(outline);
    assert.equal(blocks[0].text, "Hello");
    assert.equal(outline.truncated, true);
  });

  test("blocks past the budget are dropped, not listed with their text removed", async () => {
    // An id with no text reads as a blank paragraph, and on a long document
    // those bare ids are most of the result — the caller would pay for the
    // whole structure of a document whose words it cannot see. The result also
    // has to stay inside the loop's tool-result cap, which counts ids too.
    const outline = await outlineOf(para("HelloWorld") + para("Second"), {
      maxChars: PARAGRAPH_ENVELOPE_CHARS + 5,
    });
    assert.deepEqual(
      paragraphsIn(outline).map((block) => block.id),
      ["p1"],
    );
  });

  test("a document inside the budget is not reported as truncated", async () => {
    const outline = await outlineOf(para("Short enough"), { maxChars: 1_000 });
    assert.equal(outline.truncated, false);
    assert.equal(paragraphsIn(outline)[0].text, "Short enough");
  });

  test("the budget is shared with table cells", async () => {
    const outline = await outlineOf(table([["Question", "Answer"]]), {
      maxChars: CELL_ENVELOPE_CHARS + "Question".length,
    });
    const cells = onlyTable(outline).rows[0].cells;
    assert.equal(cells[0].text, "Question");
    assert.equal(cells[1].text, "");
    assert.equal(outline.truncated, true);
  });

  test("a wide table stops emitting rows rather than blowing the budget on ids", async () => {
    // One table can carry hundreds of cells; without this, its ids alone
    // overrun the budget the caller set.
    const rows = Array.from({ length: 40 }, (_, index) => [`Q${index}`, "Answer"]);
    const outline = await outlineOf(table(rows), { maxChars: CELL_ENVELOPE_CHARS * 6 });
    assert.ok(onlyTable(outline).rows.length < rows.length, "every row was still emitted");
    assert.equal(outline.truncated, true);
  });
});

describe("docxBufferToText", () => {
  test("body text comes out readable and tables come out as rows", async () => {
    // A questionnaire is nearly always a table, and "question | answer" is the
    // pairing that makes it answerable; flattened into a sentence it is not.
    const bytes = await docxFixture({
      body: [
        para("Supplier questionnaire"),
        table([
          ["Question", "Answer"],
          ["Full name", "Ada Lovelace"],
        ]),
      ].join(""),
    });
    const lines = (await docxBufferToText(bytes)).split("\n");
    assert.ok(lines.includes("Supplier questionnaire"), lines.join(" / "));
    assert.ok(lines.includes("| Question | Answer |"), lines.join(" / "));
    assert.ok(lines.includes("| Full name | Ada Lovelace |"), lines.join(" / "));
  });

  test("an unanswered cell keeps its column so the pairing survives", async () => {
    // The blank column is the whole signal that this question is unanswered.
    // Collapsing it renders "| Full name |", which reads as a one-column table.
    const bytes = await docxFixture({ body: table([["Full name", ""]]) });
    assert.equal(await docxBufferToText(bytes), "| Full name |  |");
  });

  test("identical header parts are included once", async () => {
    // Word writes header1/2/3 for the first, even and odd pages of a section.
    // Repeating the letterhead three times spends the context the body needs.
    const letterhead = para("ACME Ltd — Confidential");
    const bytes = await docxFixture({
      body: para("Body text"),
      parts: { header1: letterhead, header2: letterhead, header3: letterhead },
    });
    const text = await docxBufferToText(bytes);
    assert.equal(text.split("ACME Ltd").length - 1, 1);
    assert.ok(text.includes("[header]"), text);
  });

  test("headers that differ are all kept", async () => {
    const bytes = await docxFixture({
      body: para("Body text"),
      parts: { header1: para("ACME Ltd"), header2: para("Continued overleaf") },
    });
    const text = await docxBufferToText(bytes);
    assert.ok(text.includes("ACME Ltd"), text);
    assert.ok(text.includes("Continued overleaf"), text);
  });

  test("a document whose only content is in a header still produces text", async () => {
    // The empty-body case is exactly the document that used to come back as
    // "no readable text" and get sent away for a PDF.
    const bytes = await docxFixture({
      body: "",
      parts: { header1: para("Complete and return by 1 March") },
    });
    const text = await docxBufferToText(bytes);
    assert.ok(text.includes("Complete and return by 1 March"), text);
  });

  test("maxChars clips the extraction", async () => {
    const bytes = await docxFixture({ body: para("A".repeat(500)) });
    const text = await docxBufferToText(bytes, { maxChars: 10 });
    assert.equal(text.length, 10);
    assert.equal(text, "AAAAAAAAAA");
  });

  test("deleted text does not reach the plain-text extraction either", async () => {
    const bytes = await docxFixture({
      body:
        "<w:p><w:r><w:t>Keep this.</w:t></w:r>" +
        '<w:del w:id="3" w:author="Ada" w:date="2024-01-01T00:00:00Z">' +
        "<w:r><w:delText>Drop this.</w:delText></w:r></w:del></w:p>",
    });
    const text = await docxBufferToText(bytes);
    assert.equal(text, "Keep this.");
  });
});
