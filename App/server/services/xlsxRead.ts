import {
  inRange,
  openWorkbook,
  parseCellRange,
  readSheet,
  type DefinedName,
  type XlsxValue,
} from "./xlsxModel.js";
import { XlsxError } from "./xlsxPackage.js";

export type ReadXlsxOptions = {
  sheet?: string;
  range?: string;
  maxCells?: number;
  maxChars?: number;
};
export type XlsxCellView = {
  cell: string;
  value: XlsxValue;
  type: string;
  formula?: string;
  styleIndex?: number;
  numberFormat?: string;
  valueTruncated?: boolean;
  formulaTruncated?: boolean;
};
export type XlsxSheetView = {
  name: string;
  state: string;
  kind: string;
  dimension?: string;
  protected?: boolean;
  cells: XlsxCellView[];
  mergedRanges: string[];
  cellCount?: number;
};
export type XlsxOutline = {
  sheets: XlsxSheetView[];
  sheetCount: number;
  definedNames: DefinedName[];
  dateSystem: "1900" | "1904";
  warnings: string[];
  truncated: boolean;
  guidance: string;
};

/** Read sparse, addressable cells; never expand a worksheet's declared used range. */
export async function readXlsx(bytes: Buffer, options: ReadXlsxOptions = {}): Promise<XlsxOutline> {
  const maxCells = options.maxCells ?? 500;
  const maxChars = options.maxChars ?? 40_000;
  if (!Number.isSafeInteger(maxCells) || maxCells < 1 || maxCells > 1_000)
    throw new XlsxError("maxCells must be between 1 and 1000.");
  if (!Number.isSafeInteger(maxChars) || maxChars < 1_000 || maxChars > 50_000)
    throw new XlsxError("maxChars must be between 1000 and 50000.");
  const range = options.range ? parseCellRange(options.range) : undefined;
  if (range && !options.sheet)
    throw new XlsxError("Choose a sheet name when requesting a cell range.");
  const workbook = await openWorkbook(bytes);
  if (options.sheet && !workbook.sheets.some((sheet) => sheet.name === options.sheet))
    throw new XlsxError(
      `No sheet named "${options.sheet}". Read the workbook without a sheet filter to list its sheets.`,
    );
  const result: XlsxOutline = {
    sheets: [],
    sheetCount: workbook.sheets.length,
    definedNames: [],
    dateSystem: workbook.dateSystem,
    warnings: [
      "Formula values are saved caches and may be stale. Formulas and external links are never calculated or executed.",
    ],
    truncated: false,
    guidance:
      "If truncated, select a sheet and a smaller A1 range or raise maxCells/maxChars. Cells omitted from this sparse view may still be filled by address. Read the edited attachment to verify saved answers.",
  };
  const fits = () => JSON.stringify(result).length <= maxChars;
  const append = <T>(list: T[], value: T): boolean => {
    list.push(value);
    if (fits()) return true;
    list.pop();
    result.truncated = true;
    return false;
  };
  for (const warning of workbook.warnings) if (!append(result.warnings, warning)) break;
  const orderedSheets = options.sheet
    ? workbook.sheets.filter((spec) => spec.name === options.sheet)
    : workbook.sheets;
  for (const spec of orderedSheets) {
    if (
      !append(result.sheets, {
        name: spec.name,
        state: spec.state,
        kind: spec.kind,
        cells: [],
        mergedRanges: [],
      })
    )
      break;
  }
  let count = 0;
  for (const view of result.sheets) {
    if (options.sheet && options.sheet !== view.name) continue;
    const spec = workbook.sheets.find((sheet) => sheet.name === view.name)!;
    if (spec.kind !== "worksheet") continue;
    const sheet = await readSheet(workbook, spec);
    const metadata = {
      ...view,
      dimension: sheet.dimension,
      protected: sheet.protected,
      cellCount: sheet.cells.size,
    };
    const viewIndex = result.sheets.indexOf(view);
    result.sheets[viewIndex] = metadata;
    if (!fits()) {
      result.sheets[viewIndex] = view;
      result.truncated = true;
      continue;
    }
    for (const merge of sheet.mergedRanges) {
      if (
        range &&
        (merge.last.row < range.first.row ||
          merge.first.row > range.last.row ||
          merge.last.column < range.first.column ||
          merge.first.column > range.last.column)
      )
        continue;
      if (!append(metadata.mergedRanges, merge.ref)) break;
    }
    for (const cell of sheet.cells.values()) {
      if (range && !inRange(cell, range)) continue;
      if (count >= maxCells) {
        result.truncated = true;
        break;
      }
      const value: XlsxCellView = {
        cell: cell.cell,
        value: cell.value,
        type: cell.type,
        ...(cell.formula !== undefined ? { formula: cell.formula } : {}),
        ...(cell.styleIndex !== undefined ? { styleIndex: cell.styleIndex } : {}),
        ...(cell.numberFormat !== undefined ? { numberFormat: cell.numberFormat } : {}),
      };
      if (!append(metadata.cells, value)) {
        // Keep the address and an explicit clipping flag even when one long
        // answer consumes the remaining result budget.
        const clipped = { ...value };
        if (typeof clipped.value === "string") {
          clipped.value = "";
          clipped.valueTruncated = true;
        }
        if (clipped.formula !== undefined) {
          clipped.formula = "";
          clipped.formulaTruncated = true;
        }
        if (!append(metadata.cells, clipped)) break;
        if (typeof value.value === "string") {
          let low = 0;
          let high = value.value.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            clipped.value = value.value.slice(0, middle);
            if (fits()) low = middle;
            else high = middle - 1;
          }
          clipped.value = value.value.slice(0, low);
        }
        count += 1;
        break;
      }
      count += 1;
    }
  }
  for (const defined of workbook.definedNames) if (!append(result.definedNames, defined)) break;
  return result;
}
