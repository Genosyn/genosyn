import {
  applyEdits,
  escapeXmlAttr,
  escapeXmlText,
  stripXmlIllegalChars,
  type XmlEdit,
  type XmlNode,
} from "./docxXml.js";
import {
  child,
  columnName,
  encodeExcelText,
  inRange,
  MAX_CELL_TEXT,
  openWorkbook,
  parseCellAddress,
  parseCellRange,
  readSheet,
  type CellAddress,
  type RowModel,
  type SheetModel,
  type XlsxValue,
} from "./xlsxModel.js";
import { WORKBOOK_PART, XlsxError } from "./xlsxPackage.js";

export type XlsxCellEdit = { sheet: string; cell: string; value: XlsxValue };
export type XlsxEditResult = { bytes: Buffer; applied: string[]; warnings: string[] };
type ResolvedEdit = CellAddress & { value: XlsxValue };

function qualified(node: XmlNode, local: string): string {
  return node.name.includes(":") ? `${node.name.split(":")[0]}:${local}` : local;
}

/** Change one unqualified attribute while retaining every other original byte. */
function attribute(openTag: string, name: string, value: string | null): string {
  let quote = "";
  let boundary = openTag.length;
  for (let index = 0; index < openTag.length; index += 1) {
    const ch = openTag[index];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") {
      boundary = index + 1;
      break;
    }
  }
  const opening = openTag.slice(0, boundary);
  const tail = openTag.slice(boundary);
  const replacement = value === null ? "" : ` ${name}="${escapeXmlAttr(value)}"`;
  // Consume complete quoted attributes in order. Searching for just `t=`
  // could find that text inside a vendor extension's quoted value.
  for (const match of opening.matchAll(
    /\s+([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"[^"]*"|'[^']*')/g,
  )) {
    if (match[1] !== name) continue;
    return (
      opening.slice(0, match.index) +
      replacement +
      opening.slice(match.index + match[0].length) +
      tail
    );
  }
  return value === null
    ? openTag
    : opening.replace(/\s*\/?>$/, (closing) => replacement + closing) + tail;
}

function valueXml(node: XmlNode, value: XlsxValue): string {
  if (value === null) return "";
  if (typeof value === "string") {
    const is = qualified(node, "is");
    const t = qualified(node, "t");
    return `<${is}><${t} xml:space="preserve">${escapeXmlText(encodeExcelText(value))}</${t}></${is}>`;
  }
  const v = qualified(node, "v");
  return `<${v}>${typeof value === "boolean" ? (value ? "1" : "0") : String(value)}</${v}>`;
}

function renderCell(sheet: SheetModel, edit: ResolvedEdit, explicitAddress: boolean): string {
  const existing = sheet.cells.get(edit.cell);
  if (!existing) {
    const c = qualified(sheet.root, "c");
    const type =
      typeof edit.value === "string"
        ? ' t="inlineStr"'
        : typeof edit.value === "boolean"
          ? ' t="b"'
          : "";
    return `<${c} r="${edit.cell}"${type}>${valueXml(sheet.root, edit.value)}</${c}>`;
  }
  const node = existing.node;
  let open = sheet.source.slice(node.start, node.selfClosing ? node.end : node.innerStart);
  open = attribute(
    open,
    "t",
    typeof edit.value === "string" ? "inlineStr" : typeof edit.value === "boolean" ? "b" : null,
  );
  if (explicitAddress && !node.attrs.r) open = attribute(open, "r", edit.cell);
  open = open.replace(/\/>$/, ">");
  const original = node.selfClosing ? "" : sheet.source.slice(node.innerStart, node.innerEnd);
  const oldValues = node.children.filter((item) => item.local === "v" || item.local === "is");
  const insert = oldValues[0]?.start ?? child(node, "extLst")?.start ?? node.innerEnd;
  const changes: XmlEdit[] = oldValues.map((item) => ({
    start: item.start - node.innerStart,
    end: item.end - node.innerStart,
    replacement: "",
  }));
  changes.push({
    start: node.selfClosing ? 0 : insert - node.innerStart,
    end: node.selfClosing ? 0 : insert - node.innerStart,
    replacement: valueXml(node, edit.value),
  });
  return `${open}${applyEdits(original, changes)}</${node.name}>`;
}

function renderRow(sheet: SheetModel, row: RowModel, edits: ResolvedEdit[]): string {
  const additions = edits.filter((edit) => !sheet.cells.has(edit.cell) && edit.value !== null);
  const changes: XmlEdit[] = [];
  for (const edit of edits) {
    const existing = sheet.cells.get(edit.cell);
    if (existing)
      changes.push({
        start: existing.node.start,
        end: existing.node.end,
        replacement: renderCell(sheet, edit, additions.length > 0),
      });
  }
  for (const edit of additions.sort((a, b) => a.column - b.column)) {
    const next = row.cells.find((cell) => cell.column > edit.column);
    const at = next?.node.start ?? child(row.node, "extLst")?.start ?? row.node.innerEnd;
    changes.push({
      start: row.node.selfClosing ? row.node.end : at,
      end: row.node.selfClosing ? row.node.end : at,
      replacement: renderCell(sheet, edit, true),
    });
  }
  if (additions.length > 0) {
    // An inserted cell must not shift a following cell whose address was
    // implicit in the original file.
    for (const existing of row.cells) {
      if (existing.node.attrs.r || edits.some((edit) => edit.cell === existing.cell)) continue;
      const at = existing.node.start + 1 + existing.node.name.length;
      changes.push({ start: at, end: at, replacement: ` r="${existing.cell}"` });
    }
  }
  let open = sheet.source.slice(
    row.node.start,
    row.node.selfClosing ? row.node.end : row.node.innerStart,
  );
  if (additions.length > 0) open = attribute(open, "spans", null);
  if (!row.node.attrs.r) open = attribute(open, "r", String(row.row));
  open = open.replace(/\/>$/, ">");
  const offset = row.node.selfClosing ? row.node.end : row.node.innerStart;
  const inner = row.node.selfClosing
    ? ""
    : sheet.source.slice(row.node.innerStart, row.node.innerEnd);
  const updated = applyEdits(
    inner,
    changes.map((edit) => ({ ...edit, start: edit.start - offset, end: edit.end - offset })),
  );
  return `${open}${updated}</${row.node.name}>`;
}

function editSheet(sheet: SheetModel, edits: ResolvedEdit[]): string {
  const byRow = new Map<number, ResolvedEdit[]>();
  for (const edit of edits) {
    if (edit.value === null && !sheet.cells.has(edit.cell)) continue;
    const list = byRow.get(edit.row) ?? [];
    list.push(edit);
    byRow.set(edit.row, list);
  }
  const changes: XmlEdit[] = [];
  let addedRows = false;
  for (const [rowNumber, rowEdits] of [...byRow].sort(([a], [b]) => a - b)) {
    const row = sheet.rows.find((item) => item.row === rowNumber);
    if (row) {
      changes.push({
        start: row.node.start,
        end: row.node.end,
        replacement: renderRow(sheet, row, rowEdits),
      });
    } else {
      addedRows = true;
      const next = sheet.rows.find((item) => item.row > rowNumber);
      const at =
        next?.node.start ??
        (sheet.sheetData.selfClosing ? sheet.sheetData.end : sheet.sheetData.innerEnd);
      const r = qualified(sheet.root, "row");
      const content = rowEdits
        .sort((a, b) => a.column - b.column)
        .map((edit) => renderCell(sheet, edit, true))
        .join("");
      changes.push({ start: at, end: at, replacement: `<${r} r="${rowNumber}">${content}</${r}>` });
    }
  }
  if (addedRows) {
    for (const row of sheet.rows) {
      if (row.node.attrs.r || byRow.has(row.row)) continue;
      const at = row.node.start + 1 + row.node.name.length;
      changes.push({ start: at, end: at, replacement: ` r="${row.row}"` });
    }
  }
  const offset = sheet.sheetData.selfClosing ? sheet.sheetData.end : sheet.sheetData.innerStart;
  const inner = sheet.sheetData.selfClosing
    ? ""
    : sheet.source.slice(sheet.sheetData.innerStart, sheet.sheetData.innerEnd);
  const data = applyEdits(
    inner,
    changes.map((edit) => ({ ...edit, start: edit.start - offset, end: edit.end - offset })),
  );
  const dataOpen = sheet.source
    .slice(
      sheet.sheetData.start,
      sheet.sheetData.selfClosing ? sheet.sheetData.end : sheet.sheetData.innerStart,
    )
    .replace(/\/>$/, ">");
  const outerChanges: XmlEdit[] = [
    {
      start: sheet.sheetData.start,
      end: sheet.sheetData.end,
      replacement: `${dataOpen}${data}</${sheet.sheetData.name}>`,
    },
  ];
  const used = [...sheet.cells.values(), ...edits.filter((edit) => edit.value !== null)];
  if (used.length > 0) {
    let minRow = 1_048_576;
    let minColumn = 16_384;
    let maxRow = 1;
    let maxColumn = 1;
    for (const cell of used) {
      minRow = Math.min(minRow, cell.row);
      minColumn = Math.min(minColumn, cell.column);
      maxRow = Math.max(maxRow, cell.row);
      maxColumn = Math.max(maxColumn, cell.column);
    }
    if (sheet.dimension) {
      const original = parseCellRange(sheet.dimension);
      minRow = Math.min(minRow, original.first.row);
      minColumn = Math.min(minColumn, original.first.column);
      maxRow = Math.max(maxRow, original.last.row);
      maxColumn = Math.max(maxColumn, original.last.column);
    }
    const first = `${columnName(minColumn)}${minRow}`;
    const last = `${columnName(maxColumn)}${maxRow}`;
    const ref = first === last ? first : `${first}:${last}`;
    const dimension = child(sheet.root, "dimension");
    if (dimension && dimension.attrs.ref !== ref)
      outerChanges.push({
        start: dimension.start,
        end: dimension.end,
        replacement: attribute(sheet.source.slice(dimension.start, dimension.end), "ref", ref),
      });
    // Dimension is optional. Leaving an absent one absent lets Excel derive it.
  }
  return applyEdits(sheet.source, outerChanges);
}

/** Fill the existing workbook in one validated batch; all source bytes remain untouched. */
export async function editXlsx(
  bytes: Buffer,
  edits: readonly XlsxCellEdit[],
): Promise<XlsxEditResult> {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 400)
    throw new XlsxError("Give between 1 and 400 cell edits in one batch.");
  const duplicate = new Set<string>();
  const normalized = edits.map((edit) => {
    if (typeof edit.sheet !== "string" || !edit.sheet || typeof edit.cell !== "string")
      throw new XlsxError("Each edit needs a sheet name and an A1 cell address.");
    const address = parseCellAddress(edit.cell);
    const key = JSON.stringify([edit.sheet, address.cell]);
    if (duplicate.has(key))
      throw new XlsxError(
        `Cell ${edit.sheet}!${address.cell} appears more than once. Give its final value once.`,
      );
    duplicate.add(key);
    if (typeof edit.value === "string") {
      if (edit.value.length > MAX_CELL_TEXT)
        throw new XlsxError(`Cell ${address.cell} exceeds Excel's 32767-character text limit.`);
      if (stripXmlIllegalChars(edit.value) !== edit.value)
        throw new XlsxError(
          `Cell ${address.cell} contains characters that Excel XML cannot represent. Remove control characters or invalid Unicode.`,
        );
    } else if (typeof edit.value === "number") {
      if (
        !Number.isFinite(edit.value) ||
        (Number.isInteger(edit.value) && Math.abs(edit.value) > 999_999_999_999_999)
      )
        throw new XlsxError(
          `Cell ${address.cell} needs a finite number with at most 15 integer digits. Use text for long identifiers to preserve every digit.`,
        );
    } else if (edit.value !== null && typeof edit.value !== "boolean")
      throw new XlsxError(
        `Cell ${address.cell} needs text, a number, a boolean or null to clear it.`,
      );
    return { ...address, sheet: edit.sheet, value: edit.value };
  });
  const workbook = await openWorkbook(bytes);
  if (workbook.pkg.parts.some((part) => part.startsWith("_xmlsignatures/")))
    throw new XlsxError(
      "This workbook has a digital signature. Save an unsigned .xlsx copy before editing so the original signature is not invalidated.",
    );
  const work = new Map<string, { sheet: SheetModel; edits: ResolvedEdit[] }>();
  for (const edit of normalized) {
    let entry = work.get(edit.sheet);
    if (!entry) {
      const spec = workbook.sheets.find((sheet) => sheet.name === edit.sheet);
      if (!spec)
        throw new XlsxError(
          `No sheet named "${edit.sheet}". Read the workbook to check the exact name.`,
        );
      entry = { sheet: await readSheet(workbook, spec), edits: [] };
      work.set(edit.sheet, entry);
    }
    if (entry.sheet.protected)
      throw new XlsxError(
        `Sheet "${edit.sheet}" is protected. Ask its owner for an unprotected .xlsx copy.`,
      );
    const merge = entry.sheet.mergedRanges.find(
      (range) => inRange(edit, range) && range.first.cell !== edit.cell,
    );
    if (merge)
      throw new XlsxError(
        `${edit.sheet}!${edit.cell} is inside merged range ${merge.ref}. Write to its top-left cell ${merge.first.cell}.`,
      );
    if (
      entry.sheet.cells.get(edit.cell)?.formula !== undefined ||
      entry.sheet.formulaRanges.some((range) => inRange(edit, range))
    )
      throw new XlsxError(
        `${edit.sheet}!${edit.cell} belongs to a formula. Fill its input cells instead; edit_xlsx preserves formulas.`,
      );
    entry.edits.push(edit);
  }
  // Nothing is written until every sheet, address and value has been checked.
  const outputs = [...work.values()].map((entry) => ({
    path: entry.sheet.spec.path,
    source: editSheet(entry.sheet, entry.edits),
  }));
  const calc = child(workbook.root, "calcPr");
  let calcXml = calc
    ? workbook.source.slice(calc.start, calc.end)
    : `<${qualified(workbook.root, "calcPr")}/>`;
  for (const [name, value] of [
    ["calcMode", "auto"],
    ["fullCalcOnLoad", "1"],
    ["forceFullCalc", "1"],
  ])
    calcXml = attribute(calcXml, name, value);
  const calcSuccessors = new Set([
    "oleSize",
    "customWorkbookViews",
    "pivotCaches",
    "smartTagPr",
    "smartTagTypes",
    "webPublishing",
    "fileRecoveryPr",
    "webPublishObjects",
    "extLst",
  ]);
  const calcAt =
    calc?.start ??
    workbook.root.children.find((node) => calcSuccessors.has(node.local))?.start ??
    workbook.root.innerEnd;
  workbook.pkg.setText(
    WORKBOOK_PART,
    applyEdits(workbook.source, [
      { start: calcAt, end: calc?.end ?? calcAt, replacement: calcXml },
    ]),
  );
  for (const output of outputs) workbook.pkg.setText(output.path, output.source);
  return {
    bytes: await workbook.pkg.save(),
    applied: normalized.map((edit) => `${edit.sheet}!${edit.cell}`),
    warnings: [
      ...workbook.warnings,
      "Formulas and their saved caches were preserved. Cached results may be stale until Excel recalculates; automatic full recalculation is requested when the workbook opens. No formulas, macros or external links were executed.",
    ],
  };
}
