import JSZip from "jszip";
import { escapeXmlAttr, escapeXmlText } from "../services/docxXml.js";
import { XLSX_MAIN_TYPE } from "../services/xlsxPackage.js";

export const XLSX_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export type XlsxFixtureOptions = {
  sheets?: {
    name: string;
    rows?: string;
    xml?: string;
    state?: string;
    afterData?: string;
    beforeData?: string;
    target?: string;
  }[];
  sharedStrings?: string;
  styles?: string;
  definedNames?: string;
  workbookProperties?: string;
  parts?: Record<string, string | Buffer>;
  mainType?: string;
};

/** Hand-authored Office XML keeps the tests independent of the production editor. */
export async function xlsxFixture(options: XlsxFixtureOptions = {}): Promise<Buffer> {
  const sheets = options.sheets ?? [
    {
      name: "Form",
      rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" s="1"/></row>',
    },
  ];
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${options.mainType ?? XLSX_MAIN_TYPE}"/>` +
      sheets
        .map(
          (_sheet, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      "</Types>",
    { createFolders: false },
  );
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    { createFolders: false },
  );
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns="${XLSX_NS}" xmlns:r="${REL_NS}">${options.workbookProperties ?? ""}<sheets>` +
      sheets
        .map(
          (sheet, index) =>
            `<sheet name="${escapeXmlAttr(sheet.name)}" sheetId="${index + 1}" r:id="sheet${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ""}/>`,
        )
        .join("") +
      `</sheets>${options.definedNames ? `<definedNames>${options.definedNames}</definedNames>` : ""}<calcPr calcId="123"/></workbook>`,
    { createFolders: false },
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (sheet, index) =>
            `<Relationship Id="sheet${index + 1}" Type="${REL_NS}/worksheet" Target="${sheet.target ?? `worksheets/sheet${index + 1}.xml`}"/>`,
        )
        .join("") +
      (options.sharedStrings !== undefined
        ? `<Relationship Id="strings" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>`
        : "") +
      (options.styles !== undefined
        ? `<Relationship Id="styles" Type="${REL_NS}/styles" Target="styles.xml"/>`
        : "") +
      "</Relationships>",
    { createFolders: false },
  );
  sheets.forEach((sheet, index) =>
    zip.file(
      `xl/worksheets/sheet${index + 1}.xml`,
      sheet.xml ??
        `<worksheet xmlns="${XLSX_NS}">${sheet.beforeData ?? '<dimension ref="A1:B1"/>'}<sheetData>${sheet.rows ?? ""}</sheetData>${sheet.afterData ?? ""}</worksheet>`,
      { createFolders: false },
    ),
  );
  if (options.sharedStrings !== undefined)
    zip.file("xl/sharedStrings.xml", `<sst xmlns="${XLSX_NS}">${options.sharedStrings}</sst>`, {
      createFolders: false,
    });
  if (options.styles !== undefined)
    zip.file("xl/styles.xml", `<styleSheet xmlns="${XLSX_NS}">${options.styles}</styleSheet>`, {
      createFolders: false,
    });
  for (const [part, body] of Object.entries(options.parts ?? {}))
    zip.file(part, body, { createFolders: false });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export function xlsxCell(
  cell: string,
  value: string | number | boolean | null,
  styleIndex?: number,
): string {
  const attrs = `r="${cell}"${styleIndex === undefined ? "" : ` s="${styleIndex}"`}`;
  if (value === null) return `<c ${attrs}/>`;
  if (typeof value === "string")
    return `<c ${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXmlText(value)}</t></is></c>`;
  if (typeof value === "boolean") return `<c ${attrs} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c ${attrs}><v>${value}</v></c>`;
}
