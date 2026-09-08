import assert from "node:assert/strict";
import { describe, test } from "node:test";
import JSZip from "jszip";

import { xlsxCell, xlsxFixture, XLSX_NS } from "../test/xlsxFixtures.js";
import { parseCellAddress, parseCellRange } from "./xlsxModel.js";
import { looksLikeSpreadsheet, XLSX_MAX_ARCHIVE_BYTES, XLSX_MIME, XlsxPackage } from "./xlsxPackage.js";
import { readXlsx, type XlsxOutline } from "./xlsxRead.js";

function values(outline: XlsxOutline, sheet = "Form") {
  const view = outline.sheets.find((entry) => entry.name === sheet);
  assert.ok(view, `Missing sheet ${sheet}`);
  return view.cells.map(({ cell, value, type }) => ({ cell, value, type }));
}

async function replacePart(bytes: Buffer, part: string, transform: (source: string) => string) {
  const zip = await JSZip.loadAsync(bytes);
  const source = await zip.file(part)?.async("string");
  assert.notEqual(source, undefined);
  zip.file(part, transform(source!), { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("readXlsx original form contents", () => {
  test("keeps typed values, leading zeros, blank answer cells and cached formula results distinct", async () => {
    const bytes = await xlsxFixture({ sheets: [{ name: "Form", rows: `<row r="1">
      ${xlsxCell("A1", "  00123456  ")}
      ${xlsxCell("B1", true)}${xlsxCell("C1", false)}
      <c r="D1"><v>-1.25e2</v></c>
      <c r="E1"><f>SUM(D1,5)</f><v>-120</v></c>
      <c r="F1" t="e"><v>#DIV/0!</v></c>
      <c r="G1" t="d"><v>2026-09-08T12:00:00Z</v></c>
      ${xlsxCell("H1", null, 0)}
      <c r="I1" t="str"><v>cached answer</v></c>
      </row>` }] });
    const out = await readXlsx(bytes);
    assert.deepEqual(values(out), [
      { cell: "A1", value: "  00123456  ", type: "string" },
      { cell: "B1", value: true, type: "boolean" },
      { cell: "C1", value: false, type: "boolean" },
      { cell: "D1", value: -125, type: "number" },
      { cell: "E1", value: -120, type: "number" },
      { cell: "F1", value: "#DIV/0!", type: "error" },
      { cell: "G1", value: "2026-09-08T12:00:00Z", type: "date" },
      { cell: "H1", value: null, type: "blank" },
      { cell: "I1", value: "cached answer", type: "string" },
    ]);
    assert.equal(out.sheets[0].cells[4].formula, "SUM(D1,5)");
    assert.equal(out.sheets[0].cellCount, 9);
    assert.equal(out.truncated, false);
    assert.match(out.warnings.join(" "), /saved caches.*stale/);
  });

  test("joins rich shared strings and inline runs without including phonetic annotations", async () => {
    const bytes = await xlsxFixture({
      sharedStrings: '<si><r><t>Supplier &amp; </t></r><r><rPr><b/></rPr><t>company</t></r><rPh sb="0" eb="8"><t>pronunciation</t></rPh></si>',
      sheets: [{ name: "Form", rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><r><t>名</t></r><r><t>前 🧪</t></r></is></c></row>' }],
    });
    assert.deepEqual(values(await readXlsx(bytes)), [
      { cell: "A1", value: "Supplier & company", type: "string" },
      { cell: "B1", value: "名前 🧪", type: "string" },
    ]);
  });

  test("decodes Excel string escapes once while preserving escaped literal escape text", async () => {
    const bytes = await xlsxFixture({
      sharedStrings: '<si><t>Line 1_x000D_\nLine 2</t></si><si><t>Literal _x005F_x0041_</t></si>',
      sheets: [{ name: "Form", rows: '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>_xD83E__xDDEA_</t></is></c><c r="D1" t="str"><v>_x0041_</v></c></row>' }],
    });
    assert.deepEqual(values(await readXlsx(bytes)).map((cell) => cell.value), [
      "Line 1\r\nLine 2", "Literal _x0041_", "🧪", "A",
    ]);
  });

  test("reports styles and number formats without mistaking date serials for text", async () => {
    const bytes = await xlsxFixture({
      styles: '<numFmts count="1"><numFmt numFmtId="164" formatCode="00000000"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>',
      sheets: [{ name: "Form", rows: `<row r="1">${xlsxCell("A1", 46273, 1)}${xlsxCell("B1", 1234, 2)}</row>` }],
    });
    const out = await readXlsx(bytes);
    assert.equal(out.sheets[0].cells[0].numberFormat, "mm-dd-yy");
    assert.equal(out.sheets[0].cells[0].value, 46273);
    assert.equal(out.sheets[0].cells[0].styleIndex, 1);
    assert.equal(out.sheets[0].cells[1].numberFormat, "00000000");
    assert.equal(out.dateSystem, "1900");
  });

  test("exposes hidden sheets, protection, merged answer ranges, defined names and date system", async () => {
    const bytes = await xlsxFixture({
      sheets: [
        { name: "Form", rows: `<row r="1">${xlsxCell("B1", null)}</row>`, afterData: '<sheetProtection sheet="1"/><mergeCells count="1"><mergeCell ref="B1:D1"/></mergeCells>' },
        { name: "Lookup", state: "hidden" },
        { name: "Internal", state: "veryHidden" },
      ],
      workbookProperties: '<workbookPr date1904="1"/>',
      definedNames: '<definedName name="CompanyName">Form!$B$1</definedName><definedName name="LocalInput" localSheetId="1">Lookup!$A$1</definedName>',
    });
    const out = await readXlsx(bytes);
    assert.deepEqual(out.sheets.map(({ name, state }) => ({ name, state })), [
      { name: "Form", state: "visible" },
      { name: "Lookup", state: "hidden" },
      { name: "Internal", state: "veryHidden" },
    ]);
    assert.equal(out.sheets[0].protected, true);
    assert.deepEqual(out.sheets[0].mergedRanges, ["B1:D1"]);
    assert.equal(out.dateSystem, "1904");
    assert.deepEqual(out.definedNames, [
      { name: "CompanyName", formula: "Form!$B$1" },
      { name: "LocalInput", formula: "Lookup!$A$1", sheet: "Lookup" },
    ]);
  });

  test("retains a shared formula marker even when its follower has no formula text", async () => {
    const bytes = await xlsxFixture({ sheets: [{ name: "Form", rows: '<row r="1"><c r="A1"><f t="shared" si="0" ref="A1:A2">B1*2</f><v>10</v></c></row><row r="2"><c r="A2"><f t="shared" si="0"/><v>12</v></c></row>' }] });
    const out = await readXlsx(bytes);
    assert.equal(out.sheets[0].cells[0].formula, "B1*2");
    assert.equal(out.sheets[0].cells[1].formula, "");
    assert.equal(out.sheets[0].cells[1].value, 12);
  });

  test("reads namespace-prefixed worksheet XML and cells with implicit addresses", async () => {
    const bytes = await xlsxFixture({ sheets: [{ name: "Form", xml: `<s:worksheet xmlns:s="${XLSX_NS}"><s:sheetData><s:row><s:c t="inlineStr"><s:is><s:t>First</s:t></s:is></s:c><s:c><s:v>2</s:v></s:c></s:row><s:row><s:c/></s:row></s:sheetData></s:worksheet>` }] });
    assert.deepEqual(values(await readXlsx(bytes)), [
      { cell: "A1", value: "First", type: "string" },
      { cell: "B1", value: 2, type: "number" },
      { cell: "A2", value: null, type: "blank" },
    ]);
  });

  test("a workbook external link remains cached data and produces an explicit warning", async () => {
    const bytes = await xlsxFixture({ parts: { "xl/externalLinks/externalLink1.xml": "external link metadata" } });
    const out = await readXlsx(bytes);
    assert.match(out.warnings.join(" "), /External links.*not been refreshed/);
    assert.deepEqual(values(out).map((cell) => cell.value), ["Name", null]);
  });
});

describe("readXlsx bounded inspection", () => {
  test("selecting a late sheet under a small budget still reads that exact sheet", async () => {
    const bytes = await xlsxFixture({
      sheets: Array.from({ length: 24 }, (_, index) => ({ name: `Sheet ${index + 1}`, rows: `<row r="1">${xlsxCell("A1", `Answer ${index + 1}`)}</row>` })),
      definedNames: Array.from({ length: 30 }, (_, index) => `<definedName name="LongInputName${index}">Sheet1!$A$1</definedName>`).join(""),
    });
    const out = await readXlsx(bytes, { sheet: "Sheet 24", range: "A1", maxChars: 1000 });
    assert.equal(out.sheetCount, 24);
    assert.deepEqual(values(out, "Sheet 24"), [{ cell: "A1", value: "Answer 24", type: "string" }]);
    assert.ok(JSON.stringify(out).length <= 1000);
  });

  test("range filtering returns only requested cells and overlapping merged ranges", async () => {
    const bytes = await xlsxFixture({ sheets: [{ name: "Form", rows: `<row r="1">${xlsxCell("A1", "Outside")}${xlsxCell("B1", "Inside")}</row><row r="2">${xlsxCell("B2", true)}</row><row r="3">${xlsxCell("B3", "Outside")}</row>`, afterData: '<mergeCells count="2"><mergeCell ref="B1:D1"/><mergeCell ref="E4:F5"/></mergeCells>' }] });
    const out = await readXlsx(bytes, { sheet: "Form", range: "$B$1:$C$2" });
    assert.deepEqual(values(out).map((cell) => cell.cell), ["B1", "B2"]);
    assert.deepEqual(out.sheets[0].mergedRanges, ["B1:D1"]);
    assert.equal(out.truncated, false);
    assert.deepEqual(values(await readXlsx(bytes, { sheet: "Form", range: "Z99" })), []);
  });

  test("a sparse sheet with a full-grid dimension does not invent millions of empty cells", async () => {
    const bytes = await xlsxFixture({ sheets: [{ name: "Form", beforeData: '<dimension ref="A1:XFD1048576"/>', rows: `<row r="1048576">${xlsxCell("XFD1048576", "Last cell")}</row>` }] });
    const out = await readXlsx(bytes);
    assert.equal(out.sheets[0].dimension, "A1:XFD1048576");
    assert.deepEqual(values(out), [{ cell: "XFD1048576", value: "Last cell", type: "string" }]);
    assert.equal(out.truncated, false);
  });

  test("cell limits are shared across sheets and a later range can read the omitted cells", async () => {
    const bytes = await xlsxFixture({ sheets: [
      { name: "Form", rows: `<row r="1">${xlsxCell("A1", 1)}${xlsxCell("B1", 2)}</row>` },
      { name: "Second", rows: `<row r="1">${xlsxCell("A1", 3)}${xlsxCell("B1", 4)}</row>` },
    ] });
    const out = await readXlsx(bytes, { maxCells: 3 });
    assert.equal(out.sheets.flatMap((sheet) => sheet.cells).length, 3);
    assert.equal(out.truncated, true);
    const remaining = await readXlsx(bytes, { sheet: "Second", range: "B1", maxCells: 1 });
    assert.deepEqual(values(remaining, "Second"), [{ cell: "B1", value: 4, type: "number" }]);
    assert.equal(remaining.truncated, false);
  });

  test("a long answer is explicitly clipped, retains its address and respects maxChars", async () => {
    const text = 'Company "details" and 🧪\n'.repeat(150);
    const bytes = await xlsxFixture({ sheets: [{ name: "Form", rows: `<row r="1">${xlsxCell("A1", text)}</row>` }] });
    const out = await readXlsx(bytes, { maxChars: 1000 });
    const cell = out.sheets[0].cells[0];
    assert.equal(out.truncated, true);
    assert.equal(cell.cell, "A1");
    assert.equal(cell.valueTruncated, true);
    assert.equal(typeof cell.value, "string");
    assert.ok(text.startsWith(cell.value as string));
    assert.ok(JSON.stringify(out).length <= 1000);
    assert.equal((await readXlsx(bytes)).sheets[0].cells[0].value, text);
  });

  test("a long formula is marked as clipped instead of silently disappearing", async () => {
    const bytes = await xlsxFixture({ sheets: [{ name: "Form", rows: `<row r="1"><c r="A1"><f>${"A2+".repeat(600)}0</f><v>5</v></c></row>` }] });
    const out = await readXlsx(bytes, { maxChars: 1000 });
    assert.equal(out.sheets[0].cells[0].formulaTruncated, true);
    assert.equal(out.sheets[0].cells[0].value, 5);
    assert.equal(out.truncated, true);
    assert.ok(JSON.stringify(out).length <= 1000);
  });

  test("unknown sheet names and ranges without sheet names give actionable errors", async () => {
    const bytes = await xlsxFixture();
    await assert.rejects(readXlsx(bytes, { sheet: "Missing" }), /No sheet named/);
    await assert.rejects(readXlsx(bytes, { range: "A1:B5" }), /Choose a sheet name/);
  });

  for (const maxCells of [0, -1, 1.5, 1001, NaN, Infinity]) {
    test(`rejects invalid maxCells ${maxCells}`, async () => {
      await assert.rejects(readXlsx(Buffer.alloc(0), { maxCells }), /maxCells must be between 1 and 1000/);
    });
  }
  for (const maxChars of [0, 999, 50001, 1000.5, NaN, Infinity]) {
    test(`rejects invalid maxChars ${maxChars}`, async () => {
      await assert.rejects(readXlsx(Buffer.alloc(0), { maxChars }), /maxChars must be between 1000 and 50000/);
    });
  }
});

describe("Excel addresses and malformed worksheet data", () => {
  test("normalizes absolute lowercase addresses and accepts both grid boundaries", () => {
    assert.deepEqual(parseCellAddress("$a$1"), { cell: "A1", row: 1, column: 1 });
    assert.deepEqual(parseCellAddress("XFD1048576"), { cell: "XFD1048576", row: 1048576, column: 16384 });
    assert.equal(parseCellRange("$b$2:$D$5").ref, "B2:D5");
  });
  for (const address of ["A0", "A01", "XFE1", "A1048577", "AAAA1", "Sheet!A1", "A1:B2", " A1"]) {
    test(`refuses invalid cell address ${address}`, () => {
      assert.throws(() => parseCellAddress(address), /Invalid cell address|outside Excel/);
    });
  }
  for (const range of ["B2:A1", "A1:B2:C3", "A0:B2"]) {
    test(`refuses invalid range ${range}`, () => {
      assert.throws(() => parseCellRange(range), /Invalid|reversed/);
    });
  }
  for (const [label, rows, error] of [
    ["duplicate cells", '<row r="1"><c r="A1"/><c r="A1"/></row>', /duplicate/],
    ["unordered cells", '<row r="1"><c r="B1"/><c r="A1"/></row>', /unordered/],
    ["misplaced cells", '<row r="1"><c r="A2"/></row>', /misplaced/],
    ["unordered rows", '<row r="2"/><row r="1"/>', /unordered row/],
    ["invalid shared string index", '<row r="1"><c r="A1" t="s"><v>99</v></c></row>', /shared-string reference/],
    ["invalid boolean", '<row r="1"><c r="A1" t="b"><v>true</v></c></row>', /invalid boolean/],
    ["invalid number", '<row r="1"><c r="A1"><v>NaN</v></c></row>', /invalid number/],
    ["unsupported cell type", '<row r="1"><c r="A1" t="unknown"/></row>', /unsupported value type/],
  ] as const) {
    test(`refuses ${label} instead of misidentifying answer cells`, async () => {
      await assert.rejects(readXlsx(await xlsxFixture({ sheets: [{ name: "Form", rows }] })), error);
    });
  }
});

describe("XLSX package format handling", () => {
  test("recognizes Excel formats without misrouting CSV files reported with an Excel MIME type", () => {
    for (const name of ["Form.XLSX", "old.xls", "macro.xlsm", "binary.xlsb", "template.xltx"]) {
      assert.equal(looksLikeSpreadsheet("application/octet-stream", name), true);
    }
    assert.equal(looksLikeSpreadsheet(`${XLSX_MIME}; charset=binary`, "download"), true);
    assert.equal(looksLikeSpreadsheet("application/vnd.ms-excel", "export.csv"), false);
    assert.equal(looksLikeSpreadsheet("text/tab-separated-values", "export"), false);
    assert.equal(looksLikeSpreadsheet("application/pdf", "original.pdf"), false);
  });

  test("rejects empty, non-workbook, encrypted/binary and over-limit bytes with format guidance", async () => {
    await assert.rejects(readXlsx(Buffer.alloc(0)), /empty/);
    await assert.rejects(readXlsx(Buffer.from("%PDF-1.7")), /not an .xlsx workbook/);
    await assert.rejects(readXlsx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), /legacy .xls.*encrypted/);
    await assert.rejects(readXlsx(Buffer.alloc(XLSX_MAX_ARCHIVE_BYTES + 1)), /25 MB/);
    await assert.rejects(readXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])), /unreadable or encrypted/);
  });

  test("rejects binary XLSB packages, macro-enabled content types and embedded VBA", async () => {
    const binary = new JSZip();
    binary.file("xl/workbook.bin", "binary workbook");
    await assert.rejects(readXlsx(await binary.generateAsync({ type: "nodebuffer" })), /Binary .xlsb/);
    await assert.rejects(readXlsx(await xlsxFixture({ mainType: "application/vnd.ms-excel.sheet.macroEnabled.main+xml" })), /Only ordinary .xlsx/);
    await assert.rejects(readXlsx(await xlsxFixture({ parts: { "xl/vbaProject.bin": "macro bytes" } })), /Only ordinary .xlsx/);
  });

  test("refuses missing or duplicate sheet identities", async () => {
    await assert.rejects(readXlsx(await xlsxFixture({ sheets: [] })), /no sheets/);
    await assert.rejects(readXlsx(await xlsxFixture({ sheets: [{ name: "Form" }, { name: "form" }] })), /duplicate sheet names/);
    await assert.rejects(readXlsx(await xlsxFixture({ sheets: [{ name: "Form", target: "worksheets/missing.xml" }] })), /missing.*worksheet part/);
    await assert.rejects(readXlsx(await xlsxFixture({ sheets: [{ name: "Form" }, { name: "Other", target: "worksheets/sheet1.xml" }] })), /duplicate.*worksheet part/);
  });

  test("limits worksheet inventory and rejects invalid visibility", async () => {
    await assert.rejects(readXlsx(await xlsxFixture({ sheets: Array.from({ length: 257 }, (_, i) => ({ name: `Sheet${i}` })) })), /more than 256 sheets/);
    await assert.rejects(readXlsx(await xlsxFixture({ sheets: [{ name: "Form", state: "invisible" }] })), /invalid visibility state/);
  });

  test("refuses malformed XML, unsupported namespaces and document declarations", async () => {
    for (const [xml, error] of [
      [`<worksheet xmlns="${XLSX_NS}"><sheetData></worksheet>`, /malformed XML/],
      ['<worksheet xmlns="urn:unknown"><sheetData/></worksheet>', /unsupported spreadsheet XML namespace/],
      [`<!DOCTYPE worksheet><worksheet xmlns="${XLSX_NS}"><sheetData/></worksheet>`, /unsupported XML declarations/],
    ] as const) {
      await assert.rejects(readXlsx(await xlsxFixture({ sheets: [{ name: "Form", xml }] })), error);
    }
    await assert.rejects(readXlsx(await xlsxFixture({ parts: { "xl/worksheets/sheet1.xml": Buffer.from([0xff, 0xfe, 0xff]) } })), /not UTF-8 XML/);
  });

  test("preserves non-grid sheets in the outline without parsing them as worksheets", async () => {
    const original = await xlsxFixture({ sheets: [{ name: "Chart", xml: `<chartsheet xmlns="${XLSX_NS}"/>` }] });
    const bytes = await replacePart(original, "xl/_rels/workbook.xml.rels", (xml) => xml.replace('/worksheet"', '/chartsheet"'));
    const out = await readXlsx(bytes);
    assert.equal(out.sheets[0].kind, "other");
    assert.deepEqual(out.sheets[0].cells, []);
  });

  test("rejects paths outside the package and external worksheet targets", async () => {
    await assert.rejects(readXlsx(await xlsxFixture({ parts: { "../notes.xml": "unrelated" } })), /invalid package part path/);
    await assert.rejects(readXlsx(await xlsxFixture({ sheets: [{ name: "Form", target: "https://example.com/sheet.xml" }] })), /local package part/);
    const bytes = await replacePart(await xlsxFixture(), "xl/_rels/workbook.xml.rels", (xml) => xml.replace('Target="worksheets/sheet1.xml"', 'Target="worksheets/sheet1.xml" TargetMode="External"'));
    await assert.rejects(readXlsx(bytes), /external worksheet part/);
  });

  test("reading leaves the original package bytes and unrelated parts untouched", async () => {
    const bytes = await xlsxFixture({ parts: { "xl/media/logo.png": Buffer.from([1, 2, 3]), "docProps/custom.xml": "custom properties" } });
    const original = Buffer.from(bytes);
    await readXlsx(bytes);
    assert.deepEqual(bytes, original);
    const pkg = await XlsxPackage.open(bytes);
    assert.equal(await pkg.text("missing.xml"), null);
    assert.equal(await pkg.text("docProps/custom.xml"), "custom properties");
    await assert.rejects(pkg.requireText("missing.xml"), /missing missing.xml/);
  });
});
