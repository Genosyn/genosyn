import path from "node:path";
import { decodeXmlText, parseXml, type XmlNode } from "./docxXml.js";
import { WORKBOOK_PART, XLSX_MAIN_TYPE, XlsxError, XlsxPackage } from "./xlsxPackage.js";

const MAIN_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
]);
const MAX_XML_ELEMENTS = 250_000;
const MAX_SHEETS = 256;
export const MAX_CELL_TEXT = 32_767;
export type CellAddress = { cell: string; row: number; column: number };
export type CellRange = { ref: string; first: CellAddress; last: CellAddress };
export type XlsxValue = string | number | boolean | null;

/** Excel's ST_Xstring escaping is separate from XML character references. */
export function decodeExcelText(value: string): string {
  return value.replace(/_x([0-9a-f]{4})_/gi, (_whole, digits: string) =>
    String.fromCharCode(Number.parseInt(digits, 16)),
  );
}

export function encodeExcelText(value: string): string {
  return value
    .replace(/_x[0-9a-f]{4}_/gi, (match) => `_x005F_${match.slice(1)}`)
    .replace(/\r/g, "_x000D_");
}

export function columnName(column: number): string {
  let out = "";
  for (let remaining = column; remaining > 0; remaining = Math.floor((remaining - 1) / 26)) {
    out = String.fromCharCode(65 + ((remaining - 1) % 26)) + out;
  }
  return out;
}

export function parseCellAddress(value: string): CellAddress {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/.exec(value);
  if (!match) throw new XlsxError(`Invalid cell address "${value}". Use an A1 address such as B7.`);
  const letters = match[1].toUpperCase();
  let column = 0;
  for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16_384 || row > 1_048_576)
    throw new XlsxError(`Cell ${value} is outside Excel's A1:XFD1048576 grid.`);
  return { cell: `${letters}${row}`, row, column };
}

export function parseCellRange(value: string): CellRange {
  const parts = value.split(":");
  if (parts.length > 2)
    throw new XlsxError(`Invalid range "${value}". Use a range such as A1:D20.`);
  const first = parseCellAddress(parts[0]);
  const last = parseCellAddress(parts[1] ?? parts[0]);
  if (first.row > last.row || first.column > last.column)
    throw new XlsxError(`Range ${value} is reversed. Give its top-left cell first.`);
  return { ref: first.cell === last.cell ? first.cell : `${first.cell}:${last.cell}`, first, last };
}

export function inRange(address: CellAddress, range: CellRange): boolean {
  return (
    address.row >= range.first.row &&
    address.row <= range.last.row &&
    address.column >= range.first.column &&
    address.column <= range.last.column
  );
}

export function child(node: XmlNode, local: string): XmlNode | undefined {
  return node.children.find((item) => item.local === local);
}

export function children(node: XmlNode, local: string): XmlNode[] {
  return node.children.filter((item) => item.local === local);
}

/** OOXML's scalar text nodes do not contain nested markup. */
export function scalarText(source: string, node: XmlNode | undefined): string {
  if (!node || node.selfClosing) return "";
  return source
    .slice(node.innerStart, node.innerEnd)
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->)/)
    .map((part) =>
      part.startsWith("<![CDATA[")
        ? part.slice(9, -3)
        : part.startsWith("<!--")
          ? ""
          : decodeXmlText(part),
    )
    .join("");
}

export function parsePart(source: string, part: string, expectedRoot: string): XmlNode {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source))
    throw new XlsxError(`${part} contains unsupported XML declarations. Save a fresh .xlsx copy.`);
  let elements = 0;
  const opening = /<(?=[A-Za-z_:])/g;
  while (opening.exec(source)) {
    elements += 1;
    if (elements > MAX_XML_ELEMENTS)
      throw new XlsxError(`${part} contains too many XML elements to process.`);
  }
  let root: XmlNode;
  try {
    root = parseXml(source);
  } catch {
    throw new XlsxError(
      `${part} contains malformed XML. Open the workbook in Excel and save a fresh .xlsx copy.`,
    );
  }
  if (root.local !== expectedRoot) throw new XlsxError(`${part} is not a ${expectedRoot} part.`);
  if (["workbook", "worksheet", "sst", "styleSheet"].includes(expectedRoot)) {
    const prefix = root.name.includes(":") ? root.name.split(":")[0] : "";
    const namespace = root.attrs[prefix ? `xmlns:${prefix}` : "xmlns"];
    if (!MAIN_NAMESPACES.has(namespace))
      throw new XlsxError(`${part} has an unsupported spreadsheet XML namespace.`);
  }
  return root;
}

function resolveTarget(target: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new XlsxError("A workbook relationship has an invalid target.");
  }
  if (
    /^[a-z][a-z0-9+.-]*:/i.test(decoded) ||
    decoded.startsWith("//") ||
    /[\\\0?#]/.test(decoded)
  ) {
    throw new XlsxError("A workbook relationship does not name a local package part.");
  }
  return path.posix.normalize(decoded.startsWith("/") ? decoded.slice(1) : `xl/${decoded}`);
}

export type WorkbookSheet = {
  name: string;
  state: "visible" | "hidden" | "veryHidden";
  path: string;
  kind: "worksheet" | "other";
};
export type DefinedName = { name: string; formula: string; sheet?: string };
export type WorkbookModel = {
  pkg: XlsxPackage;
  source: string;
  root: XmlNode;
  sheets: WorkbookSheet[];
  strings: string[];
  numberFormats: (string | undefined)[];
  definedNames: DefinedName[];
  dateSystem: "1900" | "1904";
  warnings: string[];
};

function richText(source: string, node: XmlNode): string {
  return node.children
    .map((item) =>
      item.local === "t"
        ? decodeExcelText(scalarText(source, item))
        : item.local === "r"
          ? decodeExcelText(scalarText(source, child(item, "t")))
          : "",
    )
    .join("");
}

const BUILTIN_FORMATS: Record<number, string> = {
  0: "General",
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  49: "@",
};

export async function openWorkbook(bytes: Buffer): Promise<WorkbookModel> {
  const pkg = await XlsxPackage.open(bytes);
  const typeSource = await pkg.requireText("[Content_Types].xml");
  const types = parsePart(typeSource, "[Content_Types].xml", "Types");
  const workbookType = children(types, "Override").find(
    (item) => item.attrs.PartName === `/${WORKBOOK_PART}`,
  )?.attrs.ContentType;
  if (workbookType !== XLSX_MAIN_TYPE || pkg.parts.some((part) => /vbaProject\.bin$/i.test(part))) {
    throw new XlsxError(
      "Only ordinary .xlsx workbooks are supported. Save a copy as Excel Workbook (.xlsx), without macros or a template format.",
    );
  }
  const source = await pkg.requireText(WORKBOOK_PART);
  const root = parsePart(source, WORKBOOK_PART, "workbook");
  const relSource = await pkg.requireText("xl/_rels/workbook.xml.rels");
  const relRoot = parsePart(relSource, "xl/_rels/workbook.xml.rels", "Relationships");
  const relationships = new Map<string, { path: string; type: string }>();
  const warnings: string[] = [];
  for (const rel of children(relRoot, "Relationship")) {
    if (rel.attrs.TargetMode?.toLowerCase() === "external") {
      warnings.push(
        "External workbook relationships are preserved and are never fetched or refreshed.",
      );
      continue;
    }
    if (!rel.attrs.Id || !rel.attrs.Target || relationships.has(rel.attrs.Id))
      throw new XlsxError("The workbook contains missing or duplicate relationship identifiers.");
    relationships.set(rel.attrs.Id, {
      path: resolveTarget(rel.attrs.Target),
      type: rel.attrs.Type ?? "",
    });
  }
  const sheetsNode = child(root, "sheets");
  const sheetNodes = sheetsNode ? children(sheetsNode, "sheet") : [];
  if (sheetNodes.length === 0) throw new XlsxError("This workbook has no sheets.");
  if (sheetNodes.length > MAX_SHEETS)
    throw new XlsxError(
      "This workbook has more than 256 sheets. Save the needed sheets in a smaller .xlsx copy.",
    );
  const names = new Set<string>();
  const sheetPaths = new Set<string>();
  const sheets: WorkbookSheet[] = sheetNodes.map((node) => {
    const name = decodeExcelText(node.attrs.name ?? "");
    if (!name || name.length > 31 || names.has(name.toLowerCase()))
      throw new XlsxError("The workbook contains invalid or duplicate sheet names.");
    names.add(name.toLowerCase());
    const relId = Object.entries(node.attrs).find(([key]) => key.endsWith(":id"))?.[1];
    const rel = relId ? relationships.get(relId) : undefined;
    if (!rel || !pkg.has(rel.path) || sheetPaths.has(rel.path))
      throw new XlsxError(`Sheet "${name}" has a missing, duplicate or external worksheet part.`);
    sheetPaths.add(rel.path);
    const state = node.attrs.state ?? "visible";
    if (!["visible", "hidden", "veryHidden"].includes(state))
      throw new XlsxError(`Sheet "${name}" has an invalid visibility state.`);
    return {
      name,
      state: state as WorkbookSheet["state"],
      path: rel.path,
      kind: rel.type.endsWith("/worksheet") ? "worksheet" : "other",
    };
  });
  const strings: string[] = [];
  const stringsRel = [...relationships.values()].find((rel) => rel.type.endsWith("/sharedStrings"));
  if (stringsRel) {
    const shared = await pkg.requireText(stringsRel.path);
    const sharedRoot = parsePart(shared, stringsRel.path, "sst");
    for (const item of children(sharedRoot, "si")) strings.push(richText(shared, item));
  }
  const numberFormats: (string | undefined)[] = [];
  const stylesRel = [...relationships.values()].find((rel) => rel.type.endsWith("/styles"));
  if (stylesRel) {
    const styles = await pkg.requireText(stylesRel.path);
    const stylesRoot = parsePart(styles, stylesRel.path, "styleSheet");
    const formats = { ...BUILTIN_FORMATS };
    const custom = child(stylesRoot, "numFmts");
    for (const item of custom ? children(custom, "numFmt") : [])
      formats[Number(item.attrs.numFmtId)] = item.attrs.formatCode;
    const xfs = child(stylesRoot, "cellXfs");
    for (const item of xfs ? children(xfs, "xf") : [])
      numberFormats.push(formats[Number(item.attrs.numFmtId ?? 0)]);
  }
  const definedNames: DefinedName[] = [];
  const defined = child(root, "definedNames");
  for (const item of defined ? children(defined, "definedName") : []) {
    const localSheet = item.attrs.localSheetId;
    definedNames.push({
      name: item.attrs.name ?? "",
      formula: scalarText(source, item),
      ...(localSheet !== undefined && sheets[Number(localSheet)]
        ? { sheet: sheets[Number(localSheet)].name }
        : {}),
    });
  }
  const workbookPr = child(root, "workbookPr");
  const dateSystem = ["1", "true"].includes(workbookPr?.attrs.date1904 ?? "") ? "1904" : "1900";
  if (pkg.parts.some((part) => part.startsWith("xl/externalLinks/")))
    warnings.push(
      "External links are preserved; their values are cached and have not been refreshed.",
    );
  return {
    pkg,
    source,
    root,
    sheets,
    strings,
    numberFormats,
    definedNames,
    dateSystem,
    warnings: [...new Set(warnings)],
  };
}

export type CellModel = CellAddress & {
  node: XmlNode;
  value: XlsxValue;
  type: "string" | "number" | "boolean" | "blank" | "date" | "error";
  formula?: string;
  styleIndex?: number;
  numberFormat?: string;
};
export type RowModel = { row: number; node: XmlNode; cells: CellModel[] };
export type SheetModel = {
  spec: WorkbookSheet;
  source: string;
  root: XmlNode;
  sheetData: XmlNode;
  rows: RowModel[];
  cells: Map<string, CellModel>;
  mergedRanges: CellRange[];
  formulaRanges: CellRange[];
  protected: boolean;
  dimension?: string;
};

function cellValue(
  source: string,
  node: XmlNode,
  workbook: WorkbookModel,
): Pick<CellModel, "value" | "type"> {
  const raw = scalarText(source, child(node, "v"));
  switch (node.attrs.t) {
    case "inlineStr":
      return {
        value: child(node, "is") ? richText(source, child(node, "is")!) : "",
        type: "string",
      };
    case "s": {
      if (!/^\d+$/.test(raw) || workbook.strings[Number(raw)] === undefined)
        throw new XlsxError(
          `Cell ${node.attrs.r ?? "(unaddressed)"} has an invalid shared-string reference.`,
        );
      return { value: workbook.strings[Number(raw)], type: "string" };
    }
    case "str":
      return { value: decodeExcelText(raw), type: "string" };
    case "b": {
      if (raw !== "0" && raw !== "1")
        throw new XlsxError(
          `Cell ${node.attrs.r ?? "(unaddressed)"} has an invalid boolean value.`,
        );
      return { value: raw === "1", type: "boolean" };
    }
    case "e":
      return { value: raw, type: "error" };
    case "d":
      return { value: raw, type: "date" };
    case undefined:
    case "n": {
      if (raw === "") return { value: null, type: "blank" };
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw)))
        throw new XlsxError(`Cell ${node.attrs.r ?? "(unaddressed)"} has an invalid number.`);
      return { value: Number(raw), type: "number" };
    }
    default:
      throw new XlsxError(`Cell ${node.attrs.r ?? "(unaddressed)"} has an unsupported value type.`);
  }
}

export async function readSheet(workbook: WorkbookModel, spec: WorkbookSheet): Promise<SheetModel> {
  if (spec.kind !== "worksheet")
    throw new XlsxError(
      `"${spec.name}" is a chart or another non-grid sheet. Choose a worksheet by name.`,
    );
  const source = await workbook.pkg.requireText(spec.path);
  const root = parsePart(source, spec.path, "worksheet");
  const sheetData = child(root, "sheetData");
  if (!sheetData)
    throw new XlsxError(`Sheet "${spec.name}" has no sheetData element. Save a fresh .xlsx copy.`);
  const rows: RowModel[] = [];
  const cells = new Map<string, CellModel>();
  const formulaRanges: CellRange[] = [];
  let priorRow = 0;
  for (const rowNode of children(sheetData, "row")) {
    const row = rowNode.attrs.r === undefined ? priorRow + 1 : Number(rowNode.attrs.r);
    if (!Number.isSafeInteger(row) || row <= priorRow || row > 1_048_576)
      throw new XlsxError(`Sheet "${spec.name}" contains invalid or unordered row numbers.`);
    priorRow = row;
    const rowCells: CellModel[] = [];
    let priorColumn = 0;
    for (const node of children(rowNode, "c")) {
      const address = parseCellAddress(node.attrs.r ?? `${columnName(priorColumn + 1)}${row}`);
      if (address.row !== row || address.column <= priorColumn || cells.has(address.cell))
        throw new XlsxError(
          `Sheet "${spec.name}" contains duplicate, unordered or misplaced cells.`,
        );
      priorColumn = address.column;
      const formulaNode = child(node, "f");
      if (formulaNode?.attrs.ref) formulaRanges.push(parseCellRange(formulaNode.attrs.ref));
      const styleIndex = node.attrs.s === undefined ? undefined : Number(node.attrs.s);
      if (styleIndex !== undefined && (!Number.isSafeInteger(styleIndex) || styleIndex < 0))
        throw new XlsxError(`Cell ${address.cell} has an invalid style index.`);
      const model: CellModel = {
        ...address,
        node,
        ...cellValue(source, node, workbook),
        ...(formulaNode ? { formula: scalarText(source, formulaNode) } : {}),
        ...(styleIndex !== undefined
          ? { styleIndex, numberFormat: workbook.numberFormats[styleIndex] }
          : {}),
      };
      cells.set(address.cell, model);
      rowCells.push(model);
    }
    rows.push({ row, node: rowNode, cells: rowCells });
  }
  const merges = child(root, "mergeCells");
  const mergedRanges = (merges ? children(merges, "mergeCell") : []).map((node) =>
    parseCellRange(node.attrs.ref ?? ""),
  );
  const dimension = child(root, "dimension")?.attrs.ref;
  return {
    spec,
    source,
    root,
    sheetData,
    rows,
    cells,
    mergedRanges,
    formulaRanges,
    protected: Boolean(child(root, "sheetProtection")),
    ...(dimension ? { dimension } : {}),
  };
}
