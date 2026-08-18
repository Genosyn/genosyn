import {
  descendantsNamed,
  decodeXmlText,
  firstChild,
  parseXml,
  type XmlNode,
} from "./docxXml.js";

/**
 * The structure of one WordprocessingML part: its paragraphs, its tables, and
 * the form fields sitting in them, each still holding the {@link XmlNode} it
 * came from.
 *
 * Reading and editing need exactly the same walk — an editor that located
 * paragraphs differently from the reader would hand out ids that address
 * something else by the time they came back — so the walk lives here once and
 * both sides project from it.
 *
 * ## The id scheme
 *
 * Ids are positional and derived only from the bytes: the third paragraph of
 * the body is `p3` whatever it contains. Two reads of the same file always
 * produce the same ids, and an edit built from a read is applied to the file
 * that read came from, so they cannot drift. They are *not* stable across an
 * edit — inserting a paragraph renumbers everything after it — which is why
 * {@link file://./docxEdit.ts} resolves every id in a batch against one parse
 * of the original and never re-reads between operations.
 *
 * Body ids are bare (`p7`, `t2`, `t2r1c3`). Anything in another part is
 * prefixed with that part's key (`header1:p2`), because a questionnaire's
 * answer boxes live in a header often enough that a reader ignoring them
 * would call the document empty.
 */

/** Formatting properties and machinery whose text is not document content. */
const NON_CONTENT: ReadonlySet<string> = new Set([
  "w:pPr",
  "w:rPr",
  "w:tblPr",
  "w:tblGrid",
  "w:trPr",
  "w:tcPr",
  "w:sectPr",
  "w:sdtPr",
  "w:sdtEndPr",
  "w:proofErr",
  "w:fldChar",
  "w:instrText",
  "w:delInstrText",
  // A tracked deletion's text is already gone as far as the reader is
  // concerned; including it would show the employee sentences the author
  // removed.
  "w:del",
  "w:delText",
  "mc:Fallback",
]);

/**
 * Glyphs Word stores as a font code point rather than a character.
 *
 * Tick boxes on real questionnaires are almost always one of these — a
 * Wingdings `F0A8` is the empty box a human sees, and a reader that rendered
 * it as nothing would show "Yes  No" with the boxes missing and no way for the
 * employee to tell which option was already ticked.
 */
const SYMBOL_GLYPHS: Record<string, string> = {
  "wingdings:f06f": "☐",
  "wingdings:f0a8": "☐",
  "wingdings:f0fc": "☑",
  "wingdings:f0fd": "☒",
  "wingdings:f0fe": "☑",
  "wingdings 2:f0a3": "☑",
  "wingdings 2:f0a2": "☐",
  "symbol:f0d8": "✔",
  "webdings:f0a3": "☑",
};

/** Render a `w:sym` the way a reader would see it. */
export function symbolCharacter(font: string, charCode: string): string {
  const key = `${font.trim().toLowerCase()}:${charCode.trim().toLowerCase()}`;
  const mapped = SYMBOL_GLYPHS[key];
  if (mapped) return mapped;
  const code = Number.parseInt(charCode, 16);
  if (!Number.isFinite(code)) return "";
  // Symbol fonts live in the private-use plane at F000 + the ASCII code. Strip
  // the offset so at least the shape of the character survives.
  const plain = code >= 0xf000 && code <= 0xf0ff ? code - 0xf000 : code;
  if (plain === 0xa8 || plain === 0x6f) return "☐";
  if (plain === 0xfe || plain === 0xfc) return "☑";
  if (plain === 0xfd) return "☒";
  if (plain < 0x20) return "";
  try {
    return String.fromCodePoint(plain);
  } catch {
    return "";
  }
}

/**
 * One run of characters and where it lives in the source.
 *
 * `srcStart`/`srcEnd` bound the *character data* inside a `w:t` — not the tags
 * — so a replacement can be spliced in without disturbing the run's
 * formatting. For a `w:tab` or `w:br`, which carry no character data, the
 * range covers the whole element.
 */
export type TextSegment = {
  node: XmlNode;
  /** Offset of this segment's first character within the paragraph's text. */
  textStart: number;
  /** Offset one past its last character within the paragraph's text. */
  textEnd: number;
  /** Source range holding the characters, for `w:t`; the element otherwise. */
  srcStart: number;
  srcEnd: number;
  /** The decoded characters this segment contributes. */
  value: string;
  /** Only a `w:t` can have text spliced into it; the rest are atoms. */
  writable: boolean;
};

export type ParagraphModel = {
  id: string;
  node: XmlNode;
  /** The named paragraph style, e.g. `Heading1`. */
  style?: string;
  /** Set when the paragraph is a list item. */
  listLevel?: number;
  listNumId?: string;
  /** The paragraph's visible text, runs already stitched together. */
  text: string;
  segments: TextSegment[];
  /** The cell this paragraph sits in, when it is inside a table. */
  cellId?: string;
};

export type CellModel = {
  id: string;
  node: XmlNode;
  paragraphIds: string[];
  /** Cell text, paragraphs joined by newline. */
  text: string;
  /** Tables nested inside this cell, in document order. */
  tables: TableModel[];
  /** `w:gridSpan` when the cell spans columns. */
  gridSpan?: number;
  /** Set when the cell is a continuation of a vertical merge above it. */
  mergedUp?: boolean;
};

export type RowModel = {
  node: XmlNode;
  cells: CellModel[];
  /** True when the row carries `w:tblHeader`. */
  header: boolean;
};

export type TableModel = {
  id: string;
  node: XmlNode;
  rows: RowModel[];
};

/** How a field takes its value. */
export type FieldKind = "text" | "checkbox" | "dropdown" | "date" | "richText" | "picture";

export type FieldModel = {
  id: string;
  /** `sdt` for a modern content control, `legacy` for a Word 97 form field. */
  flavour: "sdt" | "legacy";
  kind: FieldKind;
  /** The label a human sees in Word: an SDT's alias, or a legacy field's name. */
  name: string;
  /** An SDT's `w:tag`, which is what a template author scripts against. */
  tag?: string;
  value: string;
  checked?: boolean;
  options?: string[];
  /** The paragraph or cell the field sits in, for orientation. */
  location?: string;
  /** The `w:sdt` element, or the run holding the legacy field's `w:ffData`. */
  node: XmlNode;
  /** For a legacy field, the source range holding its displayed result. */
  legacyResult?: { start: number; end: number; runs: XmlNode[] };
};

export type PartModel = {
  /** Short key used to prefix ids, e.g. `header1`. Empty for the body. */
  key: string;
  path: string;
  source: string;
  root: XmlNode;
  /** `w:body`, or the root itself for a header/footer part. */
  container: XmlNode;
  paragraphs: ParagraphModel[];
  tables: TableModel[];
  /** Top-level content in document order; nested tables live inside cells. */
  blocks: (ParagraphModel | TableModel)[];
  fields: FieldModel[];
  byId: Map<string, ParagraphModel | TableModel | CellModel | FieldModel>;
  hasTrackedChanges: boolean;
};

/** Is this model entry a paragraph? Narrows the `blocks` union. */
export function isParagraph(entry: ParagraphModel | TableModel): entry is ParagraphModel {
  return entry.node.name === "w:p";
}

/** A structural child, plus the content controls that were wrapped around it. */
type Wrapped = { node: XmlNode; wrappers: XmlNode[] };

/**
 * The children of a node, with any `w:sdt` wrapper opened out and remembered.
 *
 * Word uses a content control as a *container* in several places a reader
 * would never expect: a Repeating Section wraps whole `w:tr` rows, a
 * cell-level control wraps a `w:tc`, a Group wraps a run of block content.
 *
 * Two things go wrong if that is ignored. The rows or cells so wrapped
 * disappear from the outline, and the remaining cells shift left — so on a
 * questionnaire `t2r2c3` addresses a different column from the header it was
 * read against, and an employee told to mark row one as met writes into the
 * comments column instead. And the wrapper is itself the answer box: a tick-box
 * column is written as one control per cell, so a reader that treated the
 * wrapper as scaffolding would show the boxes and be unable to tick any of
 * them. Hence `wrappers` — the caller registers each as a field once it knows
 * which cell it belongs to.
 */
function unwrapContentControls(node: XmlNode): Wrapped[] {
  const out: Wrapped[] = [];
  const walk = (parent: XmlNode, wrappers: XmlNode[]) => {
    for (const child of parent.children) {
      if (child.name === "w:sdt") {
        const content = firstChild(child, "w:sdtContent");
        if (content) walk(content, [...wrappers, child]);
        continue;
      }
      out.push({ node: child, wrappers });
    }
  };
  walk(node, []);
  return out;
}

/** The short id prefix for a part path: `word/header1.xml` → `header1`. */
export function partKey(path: string): string {
  if (path === "word/document.xml") return "";
  const match = path.match(/^word\/([A-Za-z0-9]+)\.xml$/);
  return match ? match[1] : path;
}

/**
 * Collect the characters a paragraph shows, and where each came from.
 *
 * Word splits a sentence across runs for reasons that have nothing to do with
 * meaning — a spell-check boundary, a revision-save id, a language change
 * mid-word. So "Full name:" routinely lives in four `w:t` elements, and any
 * search that looked at one element at a time would miss it. Stitching first
 * and remembering the offsets is what lets a match found in the stitched text
 * be written back into the right runs.
 */
function collectSegments(source: string, paragraph: XmlNode): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;

  const push = (node: XmlNode, value: string, srcStart: number, srcEnd: number, writable: boolean) => {
    if (value.length === 0 && !writable) return;
    segments.push({
      node,
      textStart: cursor,
      textEnd: cursor + value.length,
      srcStart,
      srcEnd,
      value,
      writable,
    });
    cursor += value.length;
  };

  const walk = (node: XmlNode) => {
    for (const child of node.children) {
      if (NON_CONTENT.has(child.name)) continue;
      // A nested table's text belongs to the table, not to the paragraph that
      // happens to enclose it.
      if (child.name === "w:tbl") continue;
      switch (child.name) {
        case "w:t":
          push(
            child,
            child.selfClosing ? "" : decodeXmlText(source.slice(child.innerStart, child.innerEnd)),
            child.selfClosing ? child.start : child.innerStart,
            child.selfClosing ? child.end : child.innerEnd,
            true,
          );
          continue;
        case "w:tab":
          push(child, "\t", child.start, child.end, false);
          continue;
        case "w:br":
        case "w:cr":
          push(child, "\n", child.start, child.end, false);
          continue;
        case "w:noBreakHyphen":
          push(child, "-", child.start, child.end, false);
          continue;
        case "w:softHyphen":
          continue;
        case "w:sym":
          push(
            child,
            symbolCharacter(child.attrs["w:font"] ?? "", child.attrs["w:char"] ?? ""),
            child.start,
            child.end,
            false,
          );
          continue;
        default:
          walk(child);
      }
    }
  };

  walk(paragraph);
  return segments;
}

function paragraphStyle(paragraph: XmlNode): {
  style?: string;
  listLevel?: number;
  listNumId?: string;
} {
  const properties = firstChild(paragraph, "w:pPr");
  if (!properties) return {};
  const style = firstChild(properties, "w:pStyle")?.attrs["w:val"];
  const numbering = firstChild(properties, "w:numPr");
  const listLevel = numbering ? Number(firstChild(numbering, "w:ilvl")?.attrs["w:val"] ?? "0") : undefined;
  const listNumId = numbering ? firstChild(numbering, "w:numId")?.attrs["w:val"] : undefined;
  return {
    style,
    listLevel: Number.isFinite(listLevel) ? listLevel : undefined,
    listNumId,
  };
}

/** The `w:sdt` kinds we can read a value out of, keyed by their marker child. */
const SDT_KIND_BY_MARKER: Record<string, FieldKind> = {
  "w:text": "text",
  "w14:checkbox": "checkbox",
  "w:checkbox": "checkbox",
  "w:dropDownList": "dropdown",
  "w:comboBox": "dropdown",
  "w:date": "date",
  "w:richText": "richText",
  "w:picture": "picture",
};

function readSdtField(
  source: string,
  sdt: XmlNode,
  id: string,
  location: string | undefined,
  textOf: (node: XmlNode) => string,
): FieldModel | null {
  const properties = firstChild(sdt, "w:sdtPr");
  if (!properties) return null;

  let kind: FieldKind = "richText";
  let marker: XmlNode | undefined;
  for (const child of properties.children) {
    const mapped = SDT_KIND_BY_MARKER[child.name];
    if (mapped) {
      kind = mapped;
      marker = child;
      break;
    }
  }

  const alias = firstChild(properties, "w:alias")?.attrs["w:val"] ?? "";
  const tag = firstChild(properties, "w:tag")?.attrs["w:val"];
  const content = firstChild(sdt, "w:sdtContent");
  const value = content ? textOf(content) : "";

  const field: FieldModel = {
    id,
    flavour: "sdt",
    kind,
    name: alias || tag || id,
    tag: tag || undefined,
    value,
    location,
    node: sdt,
  };

  if (kind === "checkbox" && marker) {
    const checkedNode = firstChild(marker, "w14:checked") ?? firstChild(marker, "w:checked");
    const raw = checkedNode?.attrs["w14:val"] ?? checkedNode?.attrs["w:val"] ?? "0";
    field.checked = raw === "1" || raw === "true";
  }
  if (kind === "dropdown" && marker) {
    field.options = descendantsNamed(marker, "w:listItem")
      .map((item) => item.attrs["w:displayText"] ?? item.attrs["w:value"] ?? "")
      .filter((option) => option.length > 0);
  }
  return field;
}

/**
 * Read a Word 97 form field — the `FORMTEXT` / `FORMCHECKBOX` machinery.
 *
 * These are three runs and a wish: a `begin` field character carrying the
 * field's definition in `w:ffData`, a `separate`, the runs currently displayed,
 * and an `end`. Nothing marks them as a group, so the value is whatever sits
 * between `separate` and `end` — which is also the range an edit has to
 * replace.
 */
function readLegacyFields(
  paragraph: XmlNode,
  nextId: () => string,
  location: string | undefined,
  textOf: (node: XmlNode) => string,
): FieldModel[] {
  const runs = descendantsNamed(paragraph, "w:r", new Set(["w:tbl"]));
  const out: FieldModel[] = [];

  for (let i = 0; i < runs.length; i += 1) {
    const begin = firstChild(runs[i], "w:fldChar");
    if (begin?.attrs["w:fldCharType"] !== "begin") continue;
    const data = firstChild(begin, "w:ffData");
    if (!data) continue;

    let separateAt = -1;
    let endAt = -1;
    for (let j = i + 1; j < runs.length; j += 1) {
      const type = firstChild(runs[j], "w:fldChar")?.attrs["w:fldCharType"];
      if (type === "separate" && separateAt === -1) separateAt = j;
      if (type === "end") {
        endAt = j;
        break;
      }
    }
    if (endAt === -1) continue;

    const checkBox = firstChild(data, "w:checkBox");
    const ddList = firstChild(data, "w:ddList");
    const kind: FieldKind = checkBox ? "checkbox" : ddList ? "dropdown" : "text";
    const name = firstChild(data, "w:name")?.attrs["w:val"] ?? "";

    const resultRuns = separateAt === -1 ? [] : runs.slice(separateAt + 1, endAt);
    const value = resultRuns.map((run) => textOf(run)).join("");
    // The region between `separate` and `end` is only a safe thing to replace
    // when both markers sit at the same depth. Tracked-changes editing of a
    // form puts a `w:ins` around part of the field, and a span that contains
    // the wrapper's closing tag but not its opening one would be replaced by a
    // single run — deleting the `</w:ins>` and leaving `word/document.xml`
    // unbalanced. The tool would report success and hand back a file Word
    // cannot open.
    const sameDepth =
      separateAt !== -1 && runs[separateAt].parent === runs[endAt].parent;

    const field: FieldModel = {
      id: nextId(),
      flavour: "legacy",
      kind,
      name: name || `field${out.length + 1}`,
      value: kind === "checkbox" ? "" : value,
      location,
      node: runs[i],
      legacyResult: sameDepth
        ? {
            start: runs[separateAt].end,
            end: runs[endAt].start,
            runs: resultRuns,
          }
        : undefined,
    };

    if (checkBox) {
      const checked = firstChild(checkBox, "w:checked");
      // `<w:checked/>` with no value means ticked; Word only writes the
      // attribute when it is turning the box off.
      field.checked = checked !== undefined && checked.attrs["w:val"] !== "0";
    }
    if (ddList) {
      field.options = childrenNamedVal(ddList, "w:listEntry");
      const selected = Number(firstChild(ddList, "w:result")?.attrs["w:val"] ?? "0");
      field.value = field.options[selected] ?? "";
    }
    out.push(field);
    i = endAt;
  }
  return out;
}

function childrenNamedVal(node: XmlNode, name: string): string[] {
  return node.children.filter((c) => c.name === name).map((c) => c.attrs["w:val"] ?? "");
}

/**
 * Walk one part into paragraphs, tables and fields.
 *
 * `w:sdt` wrappers are transparent to the walk: a content control around a
 * table is still a table in the outline, because the human who sees a table
 * would never guess it was wrapped in one.
 */
export function buildPartModel(path: string, source: string): PartModel {
  const root = parseXml(source);
  const container = findBody(root);
  const key = partKey(path);
  const prefix = key ? `${key}:` : "";

  const paragraphs: ParagraphModel[] = [];
  const tables: TableModel[] = [];
  const fields: FieldModel[] = [];
  const byId = new Map<string, ParagraphModel | TableModel | CellModel | FieldModel>();

  let paragraphCount = 0;
  let tableCount = 0;
  let fieldCount = 0;
  const nextFieldId = () => `${prefix}f${(fieldCount += 1)}`;

  const textOf = (node: XmlNode): string =>
    collectSegments(source, node)
      .map((segment) => segment.value)
      .join("");

  /**
   * Record a `w:sdt` as a field, if it declares what kind of field it is.
   *
   * The id is taken only when the control turns out to be one — taking it
   * first and rolling the counter back afterwards would re-issue an id that
   * something nested had already been given, and two answer boxes answering
   * to one id means `set_field` fills the wrong one and reports success.
   */
  const registerSdtField = (sdt: XmlNode, location: string | undefined): FieldModel | null => {
    if (!firstChild(sdt, "w:sdtPr")) return null;
    const field = readSdtField(source, sdt, nextFieldId(), location, textOf);
    if (!field) return null;
    fields.push(field);
    byId.set(field.id, field);
    return field;
  };

  const readParagraph = (node: XmlNode, cellId?: string): ParagraphModel => {
    const id = `${prefix}p${(paragraphCount += 1)}`;
    const segments = collectSegments(source, node);
    const model: ParagraphModel = {
      id,
      node,
      ...paragraphStyle(node),
      text: segments.map((segment) => segment.value).join(""),
      segments,
      cellId,
    };
    paragraphs.push(model);
    byId.set(id, model);

    for (const sdt of descendantsNamed(node, "w:sdt", new Set(["w:tbl"]))) {
      registerSdtField(sdt, id);
    }
    for (const field of readLegacyFields(node, nextFieldId, id, textOf)) {
      fields.push(field);
      byId.set(field.id, field);
    }
    return model;
  };

  const readTable = (node: XmlNode): TableModel => {
    const id = `${prefix}t${(tableCount += 1)}`;
    const table: TableModel = { id, node, rows: [] };
    tables.push(table);
    byId.set(id, table);

    const rowNodes = unwrapContentControls(node).filter(
      (entry) => entry.node.name === "w:tr",
    );
    rowNodes.forEach(({ node: rowNode, wrappers: rowWrappers }, rowIndex) => {
      const cells: CellModel[] = [];
      const cellNodes = unwrapContentControls(rowNode).filter(
        (entry) => entry.node.name === "w:tc",
      );
      cellNodes.forEach(({ node: cellNode, wrappers: cellWrappers }, cellIndex) => {
        const cellId = `${id}r${rowIndex + 1}c${cellIndex + 1}`;
        // Ids are taken before the cell's own contents are read, so a wrapper
        // is numbered ahead of anything inside it and the field list stays in
        // document order.
        for (const wrapper of [...(cellIndex === 0 ? rowWrappers : []), ...cellWrappers]) {
          registerSdtField(wrapper, cellId);
        }
        const properties = firstChild(cellNode, "w:tcPr");
        const gridSpan = properties
          ? Number(firstChild(properties, "w:gridSpan")?.attrs["w:val"] ?? "1")
          : 1;
        const vMerge = properties ? firstChild(properties, "w:vMerge") : undefined;
        const cell: CellModel = {
          id: cellId,
          node: cellNode,
          paragraphIds: [],
          text: "",
          tables: [],
          gridSpan: gridSpan > 1 ? gridSpan : undefined,
          mergedUp: vMerge ? (vMerge.attrs["w:val"] ?? "continue") === "continue" : undefined,
        };
        byId.set(cellId, cell);
        const lines: string[] = [];
        const readCellChildren = (parent: XmlNode) => {
          for (const child of parent.children) {
            if (child.name === "w:p") {
              const paragraph = readParagraph(child, cellId);
              cell.paragraphIds.push(paragraph.id);
              lines.push(paragraph.text);
            } else if (child.name === "w:tbl") {
              const nested = readTable(child);
              cell.tables.push(nested);
              lines.push(
                nested.rows.map((row) => row.cells.map((c) => c.text).join(" | ")).join("\n"),
              );
            } else if (child.name === "w:sdt") {
              registerSdtField(child, cellId);
              const content = firstChild(child, "w:sdtContent");
              if (content) readCellChildren(content);
            }
          }
        };
        readCellChildren(cellNode);
        cell.text = lines.join("\n").trim();
        cells.push(cell);
      });
      const properties = firstChild(rowNode, "w:trPr");
      table.rows.push({
        node: rowNode,
        cells,
        header: Boolean(properties && firstChild(properties, "w:tblHeader")),
      });
    });
    return table;
  };

  const blocks: (ParagraphModel | TableModel)[] = [];
  const readChildren = (node: XmlNode) => {
    for (const child of node.children) {
      if (child.name === "w:p") blocks.push(readParagraph(child));
      else if (child.name === "w:tbl") blocks.push(readTable(child));
      else if (CONTENT_WRAPPERS.has(child.name)) readChildren(child);
      else if (child.name === "w:sdt") {
        const content = firstChild(child, "w:sdtContent");
        if (!content) continue;
        // A content control that *wraps* whole paragraphs rather than sitting
        // inside one. `readParagraph` only ever sees a control among a
        // paragraph's descendants, so without this a template built the
        // block-level way — a very common Word shape — would report no fields
        // at all and `set_field` could never address it.
        // The id has to be taken before recursing, so a wrapper is numbered
        // ahead of the controls it wraps — but it must not be taken at all for
        // a `w:sdt` that turns out not to be a field. Rolling the counter back
        // afterwards, as this once did, re-issues an id the recursion has
        // already given to a nested control, and two different answer boxes
        // then answer to the same id: `set_field` fills the wrong one and
        // reports success.
        const field = registerSdtField(child, undefined);
        const before = paragraphCount;
        readChildren(content);
        // Point the field at the first paragraph it wraps, so the caller can
        // see where in the document it sits.
        if (field) field.location = paragraphs[before]?.id;
      }
    }
  };
  readChildren(container);

  const hasTrackedChanges =
    descendantsNamed(container, "w:ins").length > 0 ||
    descendantsNamed(container, "w:del").length > 0;

  return {
    key,
    path,
    source,
    root,
    container,
    paragraphs,
    tables,
    blocks,
    fields,
    byId,
    hasTrackedChanges,
  };
}

/**
 * Containers whose children are content rather than the content themselves.
 *
 * A header or footer part puts its paragraphs straight under the root, but a
 * footnotes part wraps each note in `w:footnote` and a comments part wraps
 * each comment in `w:comment`. A walk that stopped at the root found no
 * paragraphs in either and reported the part as empty — so an employee asked
 * what a reviewer objected to would answer that the document has no comments,
 * with the comments sitting right there in the file.
 */
const CONTENT_WRAPPERS: ReadonlySet<string> = new Set([
  "w:footnote",
  "w:endnote",
  "w:comment",
]);

/**
 * The element that holds a part's content.
 *
 * `word/document.xml` wraps everything in `w:body`; a header or footer part
 * puts its paragraphs straight under the root.
 */
function findBody(root: XmlNode): XmlNode {
  return firstChild(root, "w:body") ?? root;
}
