import { packDocx } from "../services/docxPackage.js";

/**
 * Word documents to test against, written the way Word writes them.
 *
 * The temptation is to build fixtures with the project's own `create_docx` and
 * call it covered. That proves only that the writer and the reader agree with
 * each other — and every hard case in this subsystem comes from documents
 * Genosyn did not write: a sentence Word split across four runs because the
 * spell-checker paused mid-word, a `w:rsidR` on every element, a paragraph
 * whose text lives inside a content control, an answer box that is a Word 97
 * form field. So the fixtures here are hand-authored to match real Word
 * output, including the parts that look like noise.
 */

export const W_NAMESPACES =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'mc:Ignorable="w14"';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** A run, optionally carrying run properties. */
export function run(text: string, properties = ""): string {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<w:r>${properties}<w:t${preserve}>${text}</w:t></w:r>`;
}

/** A paragraph of one run. `rsid` attributes mirror what Word emits. */
export function para(text: string, properties = ""): string {
  return `<w:p w:rsidR="00A12B34" w:rsidRDefault="00A12B34">${properties}${
    text.length > 0 ? run(text) : ""
  }</w:p>`;
}

/**
 * A paragraph whose text Word split across several runs.
 *
 * This is the ordinary case, not a pathological one: "Full name:" routinely
 * arrives as four `w:t` elements because a language change or a saved revision
 * fell in the middle of it.
 */
export function splitPara(pieces: string[], properties = ""): string {
  const runs = pieces
    .map((piece, index) =>
      run(piece, `<w:rPr><w:rFonts w:ascii="Calibri"/><w:noProof w:val="${index % 2}"/></w:rPr>`),
    )
    .join("");
  return `<w:p w:rsidR="00B45C67">${properties}${runs}</w:p>`;
}

/** A table cell holding one paragraph. */
export function cell(text: string, width = 2400): string {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${para(text)}</w:tc>`;
}

/** A table from a grid of cell texts; the first row is marked as a header. */
export function table(rows: string[][]): string {
  const grid = (rows[0] ?? [])
    .map(() => '<w:gridCol w:w="2400"/>')
    .join("");
  const body = rows
    .map((cells, index) => {
      const properties = index === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
      return `<w:tr w:rsidR="00C78D90">${properties}${cells.map((c) => cell(c)).join("")}</w:tr>`;
    })
    .join("");
  return (
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
  );
}

/** A modern plain-text content control. */
export function textControl(alias: string, tag: string, value: string): string {
  return (
    `<w:p><w:sdt><w:sdtPr><w:alias w:val="${alias}"/><w:tag w:val="${tag}"/>` +
    '<w:id w:val="1234567"/><w:showingPlcHdr/><w:text/></w:sdtPr>' +
    `<w:sdtContent><w:r><w:rPr><w:b/></w:rPr><w:t>${value}</w:t></w:r></w:sdtContent>` +
    "</w:sdt></w:p>"
  );
}

/** A modern checkbox content control, in Word's `w14` dialect. */
export function checkboxControl(alias: string, checked: boolean): string {
  return (
    `<w:p><w:sdt><w:sdtPr><w:alias w:val="${alias}"/><w:id w:val="7654321"/>` +
    `<w14:checkbox><w14:checked w14:val="${checked ? "1" : "0"}"/>` +
    '<w14:checkedState w14:val="2612" w14:font="MS Gothic"/>' +
    '<w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox>' +
    "</w:sdtPr><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii=\"MS Gothic\"/></w:rPr>" +
    `<w:t>${checked ? "☒" : "☐"}</w:t></w:r></w:sdtContent></w:sdt></w:p>`
  );
}

/** A dropdown content control with a fixed option set. */
export function dropdownControl(alias: string, options: string[], value: string): string {
  const items = options
    .map((option) => `<w:listItem w:displayText="${option}" w:value="${option}"/>`)
    .join("");
  return (
    `<w:p><w:sdt><w:sdtPr><w:alias w:val="${alias}"/><w:id w:val="1111111"/>` +
    `<w:dropDownList>${items}</w:dropDownList></w:sdtPr>` +
    `<w:sdtContent><w:r><w:t>${value}</w:t></w:r></w:sdtContent></w:sdt></w:p>`
  );
}

/**
 * A Word 97 `FORMTEXT` field: begin, instruction, separate, result, end.
 *
 * Nothing in the markup groups these five runs — the value is simply whatever
 * sits between `separate` and `end`, which is why reading one means walking
 * the paragraph's runs in order rather than looking for an element.
 */
export function legacyTextField(name: string, value: string): string {
  return (
    "<w:p><w:r><w:fldChar w:fldCharType=\"begin\"><w:ffData>" +
    `<w:name w:val="${name}"/><w:enabled/><w:calcOnExit w:val="0"/>` +
    '<w:textInput><w:default w:val=""/></w:textInput></w:ffData></w:fldChar></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:rPr><w:i/></w:rPr><w:t>${value}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  );
}

/** A Word 97 `FORMCHECKBOX` field. */
export function legacyCheckbox(name: string, checked: boolean): string {
  const state = checked ? "<w:checked/>" : "";
  return (
    '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData>' +
    `<w:name w:val="${name}"/><w:enabled/>` +
    `<w:checkBox><w:sizeAuto/><w:default w:val="0"/>${state}</w:checkBox>` +
    "</w:ffData></w:fldChar></w:r>" +
    '<w:r><w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  );
}

/** A Word 97 dropdown form field. */
export function legacyDropdown(name: string, options: string[], selected: number): string {
  const entries = options.map((option) => `<w:listEntry w:val="${option}"/>`).join("");
  return (
    '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData>' +
    `<w:name w:val="${name}"/><w:enabled/>` +
    `<w:ddList><w:result w:val="${selected}"/>${entries}</w:ddList>` +
    "</w:ffData></w:fldChar></w:r>" +
    '<w:r><w:instrText xml:space="preserve"> FORMDROPDOWN </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r><w:t>${options[selected] ?? ""}</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  );
}

export type FixtureOptions = {
  /** Inner XML of `w:body`, without the trailing `w:sectPr`. */
  body: string;
  /** Extra WordprocessingML parts by short key, e.g. `{ header1: "<w:p/>" }`. */
  parts?: Record<string, string>;
  /** Replace the whole `word/document.xml`, for malformed-input tests. */
  rawDocument?: string;
  /** Extra package entries verbatim, for non-Word-package tests. */
  extraFiles?: Record<string, string>;
};

const MINIMAL_CONTENT_TYPES =
  XML_HEADER +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  "</Types>";

const MINIMAL_RELS =
  XML_HEADER +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  "</Relationships>";

const SECTION_PROPERTIES =
  '<w:sectPr w:rsidR="00A12B34"><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>';

/** Build a `.docx` around the given body. */
export async function docxFixture(options: FixtureOptions): Promise<Buffer> {
  const document =
    options.rawDocument ??
    XML_HEADER +
      `<w:document ${W_NAMESPACES}><w:body>${options.body}${SECTION_PROPERTIES}</w:body></w:document>`;

  const files: Record<string, string> = {
    "[Content_Types].xml": MINIMAL_CONTENT_TYPES,
    "_rels/.rels": MINIMAL_RELS,
    "word/document.xml": document,
    ...options.extraFiles,
  };
  for (const [key, xml] of Object.entries(options.parts ?? {})) {
    const root = key.startsWith("header")
      ? "w:hdr"
      : key.startsWith("footer")
        ? "w:ftr"
        : key === "footnotes"
          ? "w:footnotes"
          : key === "endnotes"
            ? "w:endnotes"
            : "w:comments";
    files[`word/${key}.xml`] =
      XML_HEADER + `<${root} ${W_NAMESPACES}>${xml}</${root}>`;
  }
  return packDocx(files);
}
