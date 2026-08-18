import { DocxError, DocxPackage, DOCUMENT_PART } from "./docxPackage.js";
import {
  buildPartModel,
  isParagraph,
  partKey,
  type CellModel,
  type PartModel,
  type TableModel,
} from "./docxModel.js";

/**
 * Reading a Word document: the outline an employee needs before it can change
 * anything, and the plain text every other surface needs when a `.docx` turns
 * up as an attachment.
 *
 * The outline is deliberately addressable. A reader that returned only prose
 * would leave the employee in exactly the position that prompted these tools —
 * able to see a questionnaire and unable to answer it — so every paragraph,
 * every table cell and every form field comes back with the id
 * {@link file://./docxEdit.ts} takes.
 */

/** One paragraph of the document. */
export type DocxParagraphBlock = {
  id: string;
  kind: "paragraph";
  text: string;
  /** The named style, when the paragraph has one — `Heading1`, `Title`, … */
  style?: string;
  /** Present when the paragraph is a list item; 0 is the outermost level. */
  listLevel?: number;
};

export type DocxCellView = {
  id: string;
  text: string;
  /** Only when the cell holds more than one paragraph, so each is addressable. */
  paragraphIds?: string[];
  /** `w:gridSpan` — how many columns the cell covers. */
  colspan?: number;
  /** True when the cell continues a vertical merge from the row above. */
  mergedUp?: boolean;
  /** Tables nested inside this cell. */
  tables?: DocxTableBlock[];
};

export type DocxTableBlock = {
  id: string;
  kind: "table";
  rows: { header?: boolean; cells: DocxCellView[] }[];
};

export type DocxBlock = DocxParagraphBlock | DocxTableBlock;

export type DocxFieldView = {
  id: string;
  /** `sdt` is a modern content control; `legacy` a Word 97 form field. */
  flavour: "sdt" | "legacy";
  kind: string;
  name: string;
  tag?: string;
  value: string;
  checked?: boolean;
  options?: string[];
  /** The paragraph the field sits in. */
  at?: string;
};

export type DocxPartView = {
  /** Id prefix for everything in this part; empty string for the body. */
  key: string;
  path: string;
  blocks: DocxBlock[];
};

export type DocxOutline = {
  parts: DocxPartView[];
  fields: DocxFieldView[];
  hasFormFields: boolean;
  hasTrackedChanges: boolean;
  paragraphCount: number;
  tableCount: number;
  wordCount: number;
  /** True when `maxChars` cut the outline short. */
  truncated: boolean;
};

/**
 * Default ceiling on an outline's size.
 *
 * Measured against the *serialized* result, not the text inside it, because
 * the agent loop clips a tool result at `TOOL_RESULT_CAP_DEFAULT` (60,000
 * chars) and a clip lands mid-JSON — taking the ids off the end of the
 * document with it, which are the one thing the caller came for. Ids and
 * structure run about a third again on top of prose and far more on a table,
 * so the budget charges for them and stops well short of the loop's cap.
 */
export const DOCX_OUTLINE_CHAR_CAP = 40_000;

/**
 * What one block costs once serialized, minus its own text.
 *
 * Measured across a corpus of real documents rather than counted off the type:
 * a paragraph pays for `id`, `kind` and often `style` or `listLevel`, and a
 * cell pays for its id plus its share of the row and table objects wrapping
 * it. Under-charging here is what lets a long document serialize past the
 * loop's cap after the budget said it had room.
 */
export const PARAGRAPH_ENVELOPE_CHARS = 52;
export const CELL_ENVELOPE_CHARS = 46;
/** A field carries an id, flavour, kind and name on top of its value. */
export const FIELD_ENVELOPE_CHARS = 70;

/** Ceiling for the plain-text extraction used by the attachment layer. */
export const DOCX_TEXT_CHAR_CAP = 400_000;

export type ReadDocxOptions = {
  /**
   * Which parts to read. `body` is `word/document.xml` alone; `all` adds
   * headers, footers, footnotes, endnotes and comments. Defaults to `all`,
   * because a questionnaire whose answer boxes live in a header reads as an
   * empty document otherwise.
   */
  scope?: "body" | "all";
  /** Character budget for the returned text. Defaults to the outline cap. */
  maxChars?: number;
};

async function modelsFor(pkg: DocxPackage, scope: "body" | "all"): Promise<PartModel[]> {
  const paths = scope === "body" ? [DOCUMENT_PART] : pkg.contentParts();
  const models: PartModel[] = [];
  for (const path of paths) {
    const source = await pkg.text(path);
    if (source === null) continue;
    try {
      models.push(buildPartModel(path, source));
    } catch (error) {
      // A malformed header should not make the whole document unreadable —
      // but a malformed body means we have nothing to say.
      if (path === DOCUMENT_PART) {
        throw new DocxError(
          `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (models.length === 0) throw new DocxError("This document has no readable content.");
  return models;
}

/**
 * The character budget an outline is allowed to spend, and whether it ran out.
 *
 * `left` reaching zero is not the same as text being lost — a document that
 * fits exactly spends its last character legitimately — and a caller that
 * re-read with a bigger budget on a false `truncated` would pay for a second
 * read that returns the same thing.
 */
type Budget = { left: number; clipped: boolean };

function viewCell(cell: CellModel, budget: Budget): DocxCellView {
  budget.left -= CELL_ENVELOPE_CHARS;
  const text = clip(cell.text, budget);
  const view: DocxCellView = { id: cell.id, text };
  if (cell.paragraphIds.length > 1) view.paragraphIds = cell.paragraphIds;
  if (cell.gridSpan) view.colspan = cell.gridSpan;
  if (cell.mergedUp) view.mergedUp = true;
  if (cell.tables.length > 0) view.tables = cell.tables.map((t) => viewTable(t, budget));
  return view;
}

function viewTable(table: TableModel, budget: Budget): DocxTableBlock {
  const rows: DocxTableBlock["rows"] = [];
  for (const row of table.rows) {
    // A single wide table can exhaust the budget on ids alone, so rows stop
    // being emitted the same way blocks do.
    if (budget.left <= 0) {
      budget.clipped = true;
      break;
    }
    rows.push({
      ...(row.header ? { header: true } : {}),
      cells: row.cells.map((cell) => viewCell(cell, budget)),
    });
  }
  return { id: table.id, kind: "table", rows };
}

function clip(text: string, budget: Budget): string {
  if (budget.left < 0) budget.left = 0;
  if (text.length <= budget.left) {
    budget.left -= text.length;
    return text;
  }
  const cut = text.slice(0, budget.left);
  budget.left = 0;
  budget.clipped = true;
  return cut;
}

/**
 * Read a `.docx` into an addressable outline.
 *
 * Blocks come back in document order, one group per part, with the body first.
 * Empty paragraphs are kept: they are the blank lines a human sees, and an
 * outline that silently dropped them would renumber every id after the first
 * one — ids the caller is about to send straight back in an edit.
 */
export async function readDocx(
  bytes: Buffer,
  options: ReadDocxOptions = {},
): Promise<DocxOutline> {
  const pkg = await DocxPackage.open(bytes);
  const models = await modelsFor(pkg, options.scope ?? "all");
  const budget: Budget = { left: options.maxChars ?? DOCX_OUTLINE_CHAR_CAP, clipped: false };

  const parts: DocxPartView[] = [];
  const fields: DocxFieldView[] = [];
  let paragraphCount = 0;
  let tableCount = 0;
  let wordCount = 0;

  for (const model of models) {
    const blocks: DocxBlock[] = [];
    for (const block of model.blocks) {
      // Once the budget is gone, stop emitting rather than emitting blocks
      // with their text removed. An id with no text is worse than nothing: it
      // reads as a blank paragraph, and on a long document those bare ids are
      // most of the result — the caller would pay for the whole structure of
      // a document it cannot see the words of.
      if (budget.left <= 0) {
        budget.clipped = true;
        break;
      }
      if (!isParagraph(block)) {
        blocks.push(viewTable(block, budget));
        continue;
      }
      budget.left -= PARAGRAPH_ENVELOPE_CHARS;
      const view: DocxParagraphBlock = {
        id: block.id,
        kind: "paragraph",
        text: clip(block.text, budget),
      };
      if (block.style) view.style = block.style;
      if (block.listLevel !== undefined) view.listLevel = block.listLevel;
      blocks.push(view);
    }
    parts.push({ key: model.key, path: model.path, blocks });
    paragraphCount += model.paragraphs.length;
    tableCount += model.tables.length;
    wordCount += model.paragraphs.reduce(
      (total, paragraph) => total + countWords(paragraph.text),
      0,
    );
    for (const field of model.fields) {
      // Fields are charged like blocks. A document declaring half a million
      // controls is a few hundred KB on disk and tens of megabytes of JSON
      // once every one of them is listed — a budget that counted paragraphs
      // and not fields would report `truncated: false` on the way out.
      if (budget.left <= 0) {
        budget.clipped = true;
        break;
      }
      budget.left -= FIELD_ENVELOPE_CHARS + field.name.length + field.value.length;
      const view: DocxFieldView = {
        id: field.id,
        flavour: field.flavour,
        kind: field.kind,
        name: field.name,
        value: field.value,
      };
      if (field.tag) view.tag = field.tag;
      if (field.checked !== undefined) view.checked = field.checked;
      if (field.options && field.options.length > 0) view.options = field.options;
      if (field.location) view.at = field.location;
      fields.push(view);
    }
  }

  return {
    parts,
    fields,
    hasFormFields: fields.length > 0,
    hasTrackedChanges: models.some((model) => model.hasTrackedChanges),
    paragraphCount,
    tableCount,
    wordCount,
    truncated: budget.clipped,
  };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Render a part's content as plain text.
 *
 * Tables become pipe-separated rows rather than being flattened into a
 * sentence: a questionnaire is nearly always a table, and "Question | Answer"
 * keeps the pairing that makes it answerable.
 */
function renderPart(model: PartModel): string {
  const lines: string[] = [];
  const renderTable = (table: TableModel, indent: string) => {
    for (const row of table.rows) {
      const cells = row.cells.map((cell) => cell.text.replace(/\s*\n\s*/g, " ").trim());
      lines.push(`${indent}| ${cells.join(" | ")} |`);
      for (const cell of row.cells) {
        for (const nested of cell.tables) renderTable(nested, `${indent}  `);
      }
    }
  };
  for (const block of model.blocks) {
    if (isParagraph(block)) {
      const prefix = block.listLevel !== undefined ? `${"  ".repeat(block.listLevel)}- ` : "";
      lines.push(`${prefix}${block.text}`);
    } else {
      renderTable(block, "");
    }
  }
  return lines.join("\n");
}

/**
 * Extract a `.docx` as plain text.
 *
 * This is the function the attachment layer reaches for, and it is the reason
 * this whole feature exists: before it, a Word document handed to an employee
 * came back as "no readable text", and the employee — correctly, given what it
 * could see — asked the human to send a PDF instead.
 *
 * Headers and footers are included once each and deduplicated by content:
 * Word writes up to three near-identical header parts for first / even / odd
 * pages, and repeating the company letterhead three times wastes context that
 * the document body needs.
 */
export async function docxBufferToText(
  bytes: Buffer,
  options: { maxChars?: number } = {},
): Promise<string> {
  const pkg = await DocxPackage.open(bytes);
  const cap = options.maxChars ?? DOCX_TEXT_CHAR_CAP;
  const models = await modelsFor(pkg, "all");

  const body: string[] = [];
  const chrome: string[] = [];
  const seen = new Set<string>();

  for (const model of models) {
    const rendered = renderPart(model).trim();
    if (rendered.length === 0) continue;
    if (model.path === DOCUMENT_PART) {
      body.push(rendered);
      continue;
    }
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    const key = partKey(model.path).replace(/\d+$/, "");
    chrome.push(`[${key}]\n${rendered}`);
  }

  const whole = [...body, ...chrome].join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  return whole.length > cap ? whole.slice(0, cap) : whole;
}
