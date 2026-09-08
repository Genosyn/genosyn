import assert from "node:assert/strict";
import { describe, test } from "node:test";
import JSZip from "jszip";
import { parseXml } from "./docxXml.js";
import { editXlsx, type XlsxCellEdit } from "./xlsxEdit.js";
import { columnName } from "./xlsxModel.js";
import { XlsxError } from "./xlsxPackage.js";
import { readXlsx } from "./xlsxRead.js";
import { XLSX_NS, xlsxCell, xlsxFixture } from "../test/xlsxFixtures.js";

async function xml(bytes: Buffer, part = "xl/worksheets/sheet1.xml"): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file(part)!.async("string");
}

async function values(bytes: Buffer, sheet = "Form"): Promise<Record<string, unknown>> {
  const outline = await readXlsx(bytes, { sheet });
  return Object.fromEntries(outline.sheets[0].cells.map((cell) => [cell.cell, cell.value]));
}

function fill(cell: string, value: XlsxCellEdit["value"], sheet = "Form"): XlsxCellEdit {
  return { sheet, cell, value };
}

describe("editXlsx fills the original Excel form", () => {
  test("writes typed answers and returns stable sheet/cell addresses", async () => {
    const source = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          rows: '<row r="1">' + xlsxCell("A1", "Name") + xlsxCell("B1", null, 1) + "</row>",
        },
      ],
    });
    const output = await editXlsx(source, [
      fill("B1", "Ada"),
      fill("B2", 42.5),
      fill("B3", true),
      fill("B4", false),
    ]);
    assert.deepEqual(output.applied, ["Form!B1", "Form!B2", "Form!B3", "Form!B4"]);
    assert.deepEqual(await values(output.bytes), {
      A1: "Name",
      B1: "Ada",
      B2: 42.5,
      B3: true,
      B4: false,
    });
    assert.equal(
      (await readXlsx(output.bytes)).sheets[0].cells.find((cell) => cell.cell === "B1")?.styleIndex,
      1,
    );
  });

  test("keeps unrelated ZIP parts and original attachment bytes intact", async () => {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const source = await xlsxFixture({
      sheets: [
        { name: "Form", rows: '<row r="1"><c r="A1" s="2" t="s"><v>0</v></c></row>' },
        { name: "Instructions", rows: `<row r="1">${xlsxCell("A1", "Keep original form")}</row>` },
      ],
      sharedStrings: "<si><r><rPr><b/></rPr><t>Replace me</t></r></si>",
      styles: '<cellXfs count="3"><xf/><xf/><xf numFmtId="49"/></cellXfs>',
      parts: {
        "xl/media/logo.png": image,
        "customXml/item1.xml": '<custom answer="untouched"/>',
        "xl/worksheets/_rels/sheet1.xml.rels":
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
        "xl/drawings/drawing1.xml": "<drawing>untouched</drawing>",
      },
    });
    const original = Buffer.from(source);
    const output = await editXlsx(source, [fill("A1", "Answer")]);
    assert.deepEqual(source, original);
    const before = await JSZip.loadAsync(source);
    const after = await JSZip.loadAsync(output.bytes);
    assert.deepEqual(Object.keys(after.files), Object.keys(before.files));
    for (const part of Object.keys(before.files)) {
      if (["xl/workbook.xml", "xl/worksheets/sheet1.xml"].includes(part)) continue;
      assert.deepEqual(
        await after.file(part)!.async("nodebuffer"),
        await before.file(part)!.async("nodebuffer"),
        part,
      );
    }
    assert.equal((await values(output.bytes)).A1, "Answer");
  });

  test("retains styles, cell metadata, widths, validations, print setup and untouched cells", async () => {
    const untouched =
      '<c r="C1" s="1" t="inlineStr"><is><r><rPr><b/></rPr><t>Instructions</t></r></is></c>';
    const row =
      '<row r="1" ht="25" customHeight="1"><c r="A1" s="2" cm="4" vm="6" ph="1" t="s"><v>0</v><extLst><ext uri="keep"/></extLst></c>' +
      untouched +
      "</row>";
    const afterData =
      '<mergeCells count="1"><mergeCell ref="A2:C2"/></mergeCells><dataValidations count="1"><dataValidation type="list" sqref="A1"><formula1>"Yes,No"</formula1></dataValidation></dataValidations><pageMargins left="0.1" right="0.1" top="0.2" bottom="0.2" header="0" footer="0"/><pageSetup paperSize="9"/>';
    const source = await xlsxFixture({
      sharedStrings: "<si><t>Old</t></si>",
      sheets: [
        {
          name: "Form",
          rows: row,
          beforeData:
            '<dimension ref="A1:C2"/><cols><col min="1" max="3" width="22" customWidth="1"/></cols>',
          afterData,
        },
      ],
    });
    const result = await xml((await editXlsx(source, [fill("A1", "Yes")])).bytes);
    assert.ok(result.includes('s="2" cm="4" vm="6" ph="1" t="inlineStr"'));
    assert.ok(result.includes('<extLst><ext uri="keep"/></extLst>'));
    assert.ok(result.includes(untouched));
    assert.ok(result.includes(afterData));
    assert.ok(result.includes('<col min="1" max="3" width="22" customWidth="1"/>'));
  });

  test("clear removes a value while keeping styling and cell extensions", async () => {
    const source = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          rows: '<row r="1"><c r="A1" s="3" t="inlineStr"><is><t>clear me</t></is><extLst><ext uri="keep"/></extLst></c></row>',
        },
      ],
    });
    const output = await editXlsx(source, [fill("A1", null), fill("B99", null)]);
    assert.deepEqual(await values(output.bytes), { A1: null });
    const result = await xml(output.bytes);
    assert.ok(result.includes('s="3"'));
    assert.ok(result.includes('<extLst><ext uri="keep"/></extLst>'));
    assert.ok(!result.includes('t="inlineStr"'));
    assert.ok(!result.includes('r="99"'));
  });

  test("attribute-looking text inside vendor metadata stays byte-identical", async () => {
    const metadata = `xmlns:x="urn:vendor" x:note="literal t='keep' and r='keep'"`;
    const source = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          rows: `<row r="1"><c r="A1" ${metadata} t="inlineStr"><is><t>old</t></is></c></row>`,
        },
      ],
    });
    for (const value of [null, true, "answer"]) {
      const output = await editXlsx(source, [fill("A1", value)]);
      assert.ok((await xml(output.bytes)).includes(metadata));
      assert.equal((await values(output.bytes)).A1, value);
    }
  });

  test("preserves a UTF-8 byte-order mark in edited XML parts", async () => {
    const pkg = await JSZip.loadAsync(await xlsxFixture());
    for (const part of ["xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
      pkg.file(part, `\uFEFF${await pkg.file(part)!.async("string")}`);
    }
    const output = await editXlsx(await pkg.generateAsync({ type: "nodebuffer" }), [
      fill("B1", "answer"),
    ]);
    const result = await JSZip.loadAsync(output.bytes);
    for (const part of ["xl/workbook.xml", "xl/worksheets/sheet1.xml"]) {
      assert.deepEqual(
        (await result.file(part)!.async("nodebuffer")).subarray(0, 3),
        Buffer.from([0xef, 0xbb, 0xbf]),
      );
    }
    assert.equal((await values(output.bytes)).B1, "answer");
  });

  test("numeric and boolean answers remove the old inline/shared string type", async () => {
    const source = await xlsxFixture({
      sharedStrings: "<si><t>Old</t></si>",
      sheets: [
        {
          name: "Form",
          rows: '<row r="1"><c r="A1" t="s"><v>0</v></c>' + xlsxCell("B1", "old") + "</row>",
        },
      ],
    });
    const output = await editXlsx(source, [fill("A1", 0), fill("B1", false)]);
    assert.deepEqual(await values(output.bytes), { A1: 0, B1: false });
    assert.ok(!(await xml(output.bytes)).includes("<is>"));
  });

  test("new cells and rows are ordered numerically, including Z/AA boundaries", async () => {
    const source = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          rows:
            '<row r="2" spans="2:28">' +
            xlsxCell("B2", "old B") +
            xlsxCell("AB2", "old AB") +
            '</row><row r="20"><c r="A20"/></row>',
        },
      ],
    });
    const output = await editXlsx(source, [
      fill("AA2", "new AA"),
      fill("Z2", "new Z"),
      fill("A10", 10),
      fill("A1", 1),
      fill("A2", 2),
      fill("A30", 30),
    ]);
    const read = await readXlsx(output.bytes);
    assert.deepEqual(
      read.sheets[0].cells.map((cell) => cell.cell),
      ["A1", "A2", "B2", "Z2", "AA2", "AB2", "A10", "A20", "A30"],
    );
    assert.equal(read.sheets[0].dimension, "A1:AB30");
    assert.ok(!(await xml(output.bytes)).includes('spans="2:28"'));
  });

  for (const body of [
    "<sheetData/>",
    '<sheetData><row r="4" customHeight="1"/></sheetData>',
    '<sheetData><row r="4"><c r="B4" s="1"/></row></sheetData>',
  ]) {
    test(`fills an empty/self-closing shape: ${body}`, async () => {
      const source = await xlsxFixture({
        sheets: [{ name: "Form", xml: `<worksheet xmlns="${XLSX_NS}">${body}</worksheet>` }],
      });
      const output = await editXlsx(source, [fill("B4", "answer"), fill("C4", "second")]);
      assert.deepEqual(await values(output.bytes), { B4: "answer", C4: "second" });
      parseXml(await xml(output.bytes));
    });
  }

  test("supports namespace-prefixed worksheets and preserves their prefix", async () => {
    const source = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          xml: `<x:worksheet xmlns:x="${XLSX_NS}"><x:sheetData><x:row r="1"><x:c r="A1" s="1"/></x:row></x:sheetData></x:worksheet>`,
        },
      ],
    });
    const output = await editXlsx(source, [
      fill("A1", "first"),
      fill("B1", "second"),
      fill("A2", 2),
    ]);
    assert.deepEqual(await values(output.bytes), { A1: "first", B1: "second", A2: 2 });
    assert.ok((await xml(output.bytes)).includes('<x:c r="B1" t="inlineStr"><x:is><x:t'));
  });

  test("keeps inferred addresses stable when cells and rows are added", async () => {
    const source = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          rows: '<row><c><v>1</v></c><c r="C1"><v>3</v></c><c><v>4</v></c></row><row r="3"><c><v>30</v></c></row><row><c><v>40</v></c></row>',
        },
      ],
    });
    const output = await editXlsx(source, [fill("B1", 2), fill("B2", 20)]);
    assert.deepEqual(await values(output.bytes), {
      A1: 1,
      B1: 2,
      C1: 3,
      D1: 4,
      B2: 20,
      A3: 30,
      A4: 40,
    });
  });

  test("can edit two sheets, including a hidden sheet, in one batch", async () => {
    const source = await xlsxFixture({
      sheets: [
        { name: "Form", rows: '<row r="1"><c r="A1"/></row>' },
        { name: "Supporting data", state: "hidden", rows: '<row r="1"><c r="B1"/></row>' },
      ],
    });
    const output = await editXlsx(source, [fill("A1", "yes"), fill("B1", 12, "Supporting data")]);
    assert.deepEqual(await values(output.bytes), { A1: "yes" });
    assert.deepEqual(await values(output.bytes, "Supporting data"), { B1: 12 });
    assert.equal(
      (await readXlsx(output.bytes, { sheet: "Supporting data" })).sheets[0].state,
      "hidden",
    );
  });

  for (const value of [
    'Smith & Sons <Ltd> "quoted"',
    " leading\nline\ttab\r\ntrailing ",
    "😀 Málaga 東京",
    "_x000D_ _x005F_ _x0041_",
    "=SUM(A1:A8)",
    "+123",
    "@someone",
    "00001234567890123456789",
    "",
    "x".repeat(32_767),
  ]) {
    test(`round-trips literal text ${JSON.stringify(value.slice(0, 50))}`, async () => {
      const output = await editXlsx(await xlsxFixture(), [fill("B1", value)]);
      assert.equal((await values(output.bytes)).B1, value);
      assert.ok(!(await xml(output.bytes)).includes("<f>"));
    });
  }

  test("accepts absolute/lowercase addresses and the last Excel cell", async () => {
    const output = await editXlsx(await xlsxFixture(), [
      fill("$b$1", "answer"),
      fill("xfd1048576", "last"),
    ]);
    const result = await readXlsx(output.bytes, { sheet: "Form", range: "XFD1048576" });
    assert.equal(result.sheets[0].cells[0].value, "last");
    assert.deepEqual(output.applied, ["Form!B1", "Form!XFD1048576"]);
  });
});

describe("editXlsx preserves formulas and the workbook's controls", () => {
  const formulaRows =
    '<row r="1"><c r="A1"><v>3</v></c><c r="B1"><f>A1*2</f><v>6</v></c><c r="C1"><f t="array" ref="C1:D2">A1:B2*2</f><v>6</v></c><c r="D1"><v>8</v></c><c r="E1"><f t="shared" si="0" ref="E1:E2">A1*3</f><v>9</v></c></row><row r="2"><c r="E2"><f t="shared" si="0"/><v>12</v></c></row>';

  test("preserves formula/cached XML and requests full recalculation on open", async () => {
    const source = await xlsxFixture({ sheets: [{ name: "Form", rows: formulaRows }] });
    const output = await editXlsx(source, [fill("A1", 4)]);
    const result = await xml(output.bytes);
    assert.ok(result.includes('<c r="B1"><f>A1*2</f><v>6</v></c>'));
    assert.ok(result.includes('<f t="shared" si="0"/>'));
    const workbook = await xml(output.bytes, "xl/workbook.xml");
    const calc = parseXml(workbook).children.find((node) => node.local === "calcPr")!;
    assert.equal(calc.attrs.calcMode, "auto");
    assert.equal(calc.attrs.fullCalcOnLoad, "1");
    assert.equal(calc.attrs.forceFullCalc, "1");
    assert.equal(calc.attrs.calcId, "123");
    assert.ok(output.warnings.some((warning) => /stale/.test(warning)));
  });

  for (const cell of ["B1", "C1", "D1", "D2", "E1", "E2"]) {
    test(`refuses formula or formula-range write at ${cell}`, async () => {
      const source = await xlsxFixture({ sheets: [{ name: "Form", rows: formulaRows }] });
      await assert.rejects(editXlsx(source, [fill(cell, "bad")]), /belongs to a formula/);
    });
  }

  for (const suffix of [
    "<smartTagPr/>",
    "<smartTagTypes/>",
    "<webPublishing/>",
    "<fileRecoveryPr/>",
    "<webPublishObjects/>",
    "<extLst/>",
  ]) {
    test(`inserts missing calcPr before ${suffix}`, async () => {
      const source = await xlsxFixture();
      const pkg = await JSZip.loadAsync(source);
      const workbook = await pkg.file("xl/workbook.xml")!.async("string");
      pkg.file("xl/workbook.xml", workbook.replace('<calcPr calcId="123"/>', suffix));
      const output = await editXlsx(await pkg.generateAsync({ type: "nodebuffer" }), [
        fill("B1", "answer"),
      ]);
      const result = await xml(output.bytes, "xl/workbook.xml");
      assert.ok(result.indexOf("<calcPr ") < result.indexOf(suffix));
      parseXml(result);
    });
  }

  test("updates paired calcPr without damaging its closing tag or attributes", async () => {
    const pkg = await JSZip.loadAsync(await xlsxFixture());
    pkg.file(
      "xl/workbook.xml",
      (await pkg.file("xl/workbook.xml")!.async("string")).replace(
        '<calcPr calcId="123"/>',
        '<calcPr calcMode="manual" calcId="123"></calcPr>',
      ),
    );
    const output = await editXlsx(await pkg.generateAsync({ type: "nodebuffer" }), [
      fill("B1", "answer"),
    ]);
    const result = await xml(output.bytes, "xl/workbook.xml");
    assert.ok(result.includes("</calcPr>"));
    assert.equal(
      parseXml(result).children.find((node) => node.local === "calcPr")?.attrs.calcMode,
      "auto",
    );
  });

  test("fills only the anchor of a merged answer box", async () => {
    const source = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          rows: '<row r="1"><c r="A1" s="1"/></row>',
          afterData: '<mergeCells><mergeCell ref="A1:D2"/></mergeCells>',
        },
      ],
    });
    assert.equal(
      (await values((await editXlsx(source, [fill("A1", "Merged answer")])).bytes)).A1,
      "Merged answer",
    );
    await assert.rejects(editXlsx(source, [fill("B1", "lost")]), /top-left cell A1/);
    await assert.rejects(editXlsx(source, [fill("D2", null)]), /top-left cell A1/);
  });

  test("does not bypass sheet protection or invalidate document signatures", async () => {
    const protectedBytes = await xlsxFixture({
      sheets: [
        {
          name: "Form",
          rows: '<row r="1"><c r="A1"/></row>',
          afterData: '<sheetProtection sheet="1" password="ABCD"/>',
        },
      ],
    });
    await assert.rejects(editXlsx(protectedBytes, [fill("A1", "answer")]), /protected/);
    const signed = await xlsxFixture({ parts: { "_xmlsignatures/sig1.xml": "<Signature/>" } });
    await assert.rejects(editXlsx(signed, [fill("B1", "answer")]), /digital signature/);
  });

  test("a bad operation rejects the whole batch without changing the original", async () => {
    const source = await xlsxFixture();
    const original = Buffer.from(source);
    await assert.rejects(
      editXlsx(source, [fill("B1", "would succeed"), fill("A1", "bad", "Missing")]),
      /No sheet named/,
    );
    assert.deepEqual(source, original);
    assert.equal((await values(source)).B1, null);
  });
});

describe("editXlsx input limits", () => {
  for (const cell of [
    "",
    "A0",
    "A01",
    "1A",
    "A1:B2",
    "Form!A1",
    "XFE1",
    "A1048577",
    "AAAA1",
    "A-1",
    " B1",
  ]) {
    test(`rejects invalid address ${JSON.stringify(cell)}`, async () => {
      await assert.rejects(editXlsx(await xlsxFixture(), [fill(cell, "x")]), XlsxError);
    });
  }

  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    1_000_000_000_000_000,
    "x".repeat(32_768),
    "bad\0character",
    "lone\uD800surrogate",
    undefined,
    {},
    [],
  ]) {
    test(`rejects invalid value ${typeof value === "string" ? `string length ${value.length}` : String(value)}`, async () => {
      await assert.rejects(
        editXlsx(await xlsxFixture(), [fill("B1", value as XlsxCellEdit["value"])]),
        XlsxError,
      );
    });
  }

  test("requires a bounded nonempty batch and rejects normalized duplicates", async () => {
    const source = await xlsxFixture();
    await assert.rejects(editXlsx(source, []), /between 1 and 400/);
    await assert.rejects(
      editXlsx(
        source,
        Array.from({ length: 401 }, (_v, i) => fill(`A${i + 1}`, "x")),
      ),
      /between 1 and 400/,
    );
    await assert.rejects(
      editXlsx(source, [fill("B1", "first"), fill("$b$1", "second")]),
      /more than once/,
    );
  });

  test("fills a cell in a large sparse workbook without using an argument per cell", async () => {
    const rows: string[] = [];
    let remaining = 130_000;
    for (let row = 1; remaining > 0; row += 1) {
      const count = Math.min(16_384, remaining);
      const cells: string[] = [];
      for (let col = 1; col <= count; col += 1) cells.push(`<c r="${columnName(col)}${row}"/>`);
      rows.push(`<row r="${row}">${cells.join("")}</row>`);
      remaining -= count;
    }
    const source = await xlsxFixture({ sheets: [{ name: "Form", rows: rows.join("") }] });
    const output = await editXlsx(source, [fill("A1", "done")]);
    const result = await xml(output.bytes);
    assert.ok(result.includes('<t xml:space="preserve">done</t>'));
    assert.ok(result.includes('ref="A1:XFD8"'));
  });
});
