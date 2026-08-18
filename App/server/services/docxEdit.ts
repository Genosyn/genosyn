import { DocxError, DocxPackage, DOCUMENT_PART } from "./docxPackage.js";
import {
  buildPartModel,
  type CellModel,
  type FieldModel,
  type ParagraphModel,
  type PartModel,
  type TableModel,
  type TextSegment,
} from "./docxModel.js";
import {
  applyEdits,
  descendantsNamed,
  escapeXmlAttr,
  escapeXmlText,
  firstChild,
  outerXml,
  stripXmlIllegalChars,
  type XmlEdit,
  type XmlNode,
} from "./docxXml.js";

/**
 * Changing a Word document without breaking it.
 *
 * Every operation is resolved against one parse of the original file, turned
 * into a splice, and applied in a single pass — so an id read out of
 * {@link file://./docxRead.ts} still addresses the same paragraph when the
 * edit lands, and a batch either applies whole or not at all. Nothing is
 * written if any operation cannot be resolved: a run of eight answers that
 * silently skipped the two whose ids were wrong would hand the human a
 * document that looks finished and is not, which is worse than a refusal.
 *
 * Formatting is inherited rather than invented. Replacing a paragraph's text
 * keeps the first run's `w:rPr`, and inserting one copies the reference
 * paragraph's `w:pPr` — so an answer typed after a bulleted line comes out as
 * another bullet, in the document's own font, rather than as Times New Roman
 * 10pt in the middle of someone's house style.
 */

/** A caller-fixable problem with the requested edit. */
export class DocxEditError extends Error {
  readonly status = 400;
  /** Every problem found, so one round trip fixes them all. */
  readonly problems: string[];

  constructor(problems: string[]) {
    super(problems.join(" "));
    this.name = "DocxEditError";
    this.problems = problems;
  }
}

export type DocxOperation =
  | { op: "set_paragraph"; id: string; text: string }
  | {
      op: "insert_paragraph";
      after?: string;
      before?: string;
      text: string | string[];
      style?: string;
    }
  | { op: "append_paragraph"; text: string | string[]; style?: string }
  | { op: "delete_paragraph"; id: string }
  | { op: "set_table_cell"; id: string; text: string }
  | { op: "set_field"; id?: string; name?: string; value?: string; checked?: boolean }
  | {
      op: "replace_text";
      find: string;
      replace: string;
      within?: string;
      all?: boolean;
      matchCase?: boolean;
    };

export type DocxEditResult = {
  bytes: Buffer;
  /** One line per operation, in the order given, for the model to read back. */
  applied: string[];
  warnings: string[];
};

/** Children of a `w:p` that survive a text replacement. */
const PARAGRAPH_KEEP: ReadonlySet<string> = new Set([
  "w:pPr",
  "w:bookmarkStart",
  "w:bookmarkEnd",
  "w:commentRangeStart",
  "w:commentRangeEnd",
]);

/** Turn plain text into run content, honouring newlines and tabs. */
function runContent(text: string): string {
  const clean = stripXmlIllegalChars(text).replace(/\r\n?/g, "\n");
  const pieces: string[] = [];
  let buffer = "";
  const flush = () => {
    pieces.push(`<w:t xml:space="preserve">${escapeXmlText(buffer)}</w:t>`);
    buffer = "";
  };
  for (const character of clean) {
    if (character === "\n") {
      flush();
      pieces.push("<w:br/>");
    } else if (character === "\t") {
      flush();
      pieces.push("<w:tab/>");
    } else {
      buffer += character;
    }
  }
  flush();
  return pieces.join("");
}

/** A complete run carrying `text`, formatted like `properties` if given. */
function buildRun(text: string, properties: string): string {
  return `<w:r>${properties}${runContent(text)}</w:r>`;
}

/** The `w:rPr` of a paragraph's first run, as source, or an empty string. */
function firstRunProperties(source: string, paragraph: XmlNode): string {
  for (const run of descendantsNamed(paragraph, "w:r", new Set(["w:tbl"]))) {
    const properties = firstChild(run, "w:rPr");
    if (properties) return outerXml(source, properties);
  }
  return "";
}

/** A whole paragraph carrying `text`, formatted like `reference` if given. */
function buildParagraph(
  source: string,
  text: string,
  reference: XmlNode | null,
  style?: string,
): string {
  let paragraphProperties = "";
  if (style) {
    paragraphProperties = `<w:pPr><w:pStyle w:val="${escapeXmlAttr(style)}"/></w:pPr>`;
  } else if (reference) {
    const existing = firstChild(reference, "w:pPr");
    if (existing) paragraphProperties = outerXml(source, existing);
  }
  const runProperties = reference ? firstRunProperties(source, reference) : "";
  return `<w:p>${paragraphProperties}${buildRun(text, runProperties)}</w:p>`;
}

function asLines(text: string | string[]): string[] {
  return Array.isArray(text) ? text : [text];
}

/** Everything needed to resolve ids and stage edits for one part. */
type PartWork = {
  model: PartModel;
  edits: XmlEdit[];
};

/**
 * Replace a paragraph's content with a single run of `text`.
 *
 * Bookmarks and comment anchors are kept because deleting them silently
 * breaks cross-references and review threads elsewhere in the document;
 * everything else the paragraph was showing is what the caller asked to
 * replace.
 */
function setParagraphEdits(
  source: string,
  paragraph: ParagraphModel,
  text: string,
  problems: string[],
): XmlEdit[] {
  const node = paragraph.node;
  const control = descendantsNamed(node, "w:sdt", new Set(["w:tbl"]))[0];
  if (control) {
    problems.push(
      `${paragraph.id} contains a content control; set its value with set_field instead of set_paragraph.`,
    );
    return [];
  }

  const properties = firstRunProperties(source, node);
  const replaceable = node.children.filter((child) => !PARAGRAPH_KEEP.has(child.name));

  if (node.selfClosing) {
    return [{ start: node.start, end: node.end, replacement: `<w:p>${buildRun(text, "")}</w:p>` }];
  }
  if (replaceable.length === 0) {
    // An empty paragraph — a blank line on a printed questionnaire, and the
    // most common place an answer has to go. Insert a run after the
    // properties rather than replacing anything.
    const pPr = firstChild(node, "w:pPr");
    const at = pPr ? pPr.end : node.innerStart;
    return [{ start: at, end: at, replacement: buildRun(text, properties) }];
  }

  const edits: XmlEdit[] = [
    {
      start: replaceable[0].start,
      end: replaceable[0].end,
      replacement: buildRun(text, properties),
    },
  ];
  for (const child of replaceable.slice(1)) {
    edits.push({ start: child.start, end: child.end, replacement: "" });
  }
  return edits;
}

/**
 * Rewrite a table cell as one paragraph per line.
 *
 * A `w:tc` must end with a paragraph or Word reports the file as corrupt, so
 * the cell's first paragraph is reused as the carrier and any extras are
 * removed rather than the whole cell being rebuilt.
 */
function setCellEdits(
  model: PartModel,
  cell: CellModel,
  text: string,
  problems: string[],
): XmlEdit[] {
  const paragraphNodes = cell.node.children.filter((child) => child.name === "w:p");
  if (paragraphNodes.length === 0) {
    problems.push(`${cell.id} has no paragraph to write into.`);
    return [];
  }
  const first = model.paragraphs.find((p) => p.node === paragraphNodes[0]);
  if (!first) {
    problems.push(`${cell.id} could not be resolved.`);
    return [];
  }

  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const edits = setParagraphEdits(model.source, first, lines[0] ?? "", problems);
  if (problems.length > 0) return [];

  for (const extra of lines.slice(1)) {
    edits.push({
      start: paragraphNodes[0].end,
      end: paragraphNodes[0].end,
      replacement: buildParagraph(model.source, extra, paragraphNodes[0]),
    });
  }
  for (const node of paragraphNodes.slice(1)) {
    edits.push({ start: node.start, end: node.end, replacement: "" });
  }
  return edits;
}

/** Set a modern content control's value. */
function setSdtEdits(
  model: PartModel,
  field: FieldModel,
  value: string | undefined,
  checked: boolean | undefined,
  problems: string[],
): XmlEdit[] {
  const source = model.source;
  const properties = firstChild(field.node, "w:sdtPr");
  const content = firstChild(field.node, "w:sdtContent");
  if (!properties || !content) {
    problems.push(`${field.id} is a malformed content control.`);
    return [];
  }
  const edits: XmlEdit[] = [];

  // A control still showing its placeholder renders in grey placeholder
  // style; leaving the flag on would make a real answer look unfilled.
  const placeholder = firstChild(properties, "w:showingPlcHdr");
  if (placeholder) {
    edits.push({ start: placeholder.start, end: placeholder.end, replacement: "" });
  }

  let display = value ?? "";

  if (field.kind === "checkbox") {
    if (checked === undefined) {
      problems.push(`${field.id} ("${field.name}") is a checkbox — pass \`checked\`, not \`value\`.`);
      return [];
    }
    const marker = firstChild(properties, "w14:checkbox") ?? firstChild(properties, "w:checkbox");
    if (!marker) {
      problems.push(`${field.id} declares no checkbox state.`);
      return [];
    }
    const prefix = marker.name.startsWith("w14:") ? "w14" : "w";
    const existing = firstChild(marker, `${prefix}:checked`);
    const replacement = `<${prefix}:checked ${prefix}:val="${checked ? "1" : "0"}"/>`;
    if (existing) {
      edits.push({ start: existing.start, end: existing.end, replacement });
    } else {
      const at = marker.selfClosing ? marker.end : marker.innerStart;
      if (marker.selfClosing) {
        edits.push({
          start: marker.start,
          end: marker.end,
          replacement: `<${marker.name}>${replacement}</${marker.name}>`,
        });
      } else {
        edits.push({ start: at, end: at, replacement });
      }
    }
    const stateName = checked ? `${prefix}:checkedState` : `${prefix}:uncheckedState`;
    const state = firstChild(marker, stateName);
    const code = state?.attrs[`${prefix}:val`] ?? (checked ? "2612" : "2610");
    display = glyphForCode(code, checked);
  } else if (field.kind === "dropdown") {
    if (value === undefined) {
      problems.push(`${field.id} ("${field.name}") needs a \`value\`.`);
      return [];
    }
    const options = field.options ?? [];
    const match = options.find((option) => option.toLowerCase() === value.trim().toLowerCase());
    if (options.length > 0 && !match) {
      problems.push(
        `"${value}" is not one of ${field.id}'s options (${options.join(", ")}).`,
      );
      return [];
    }
    display = match ?? value;
  } else if (value === undefined) {
    problems.push(`${field.id} ("${field.name}") needs a \`value\`.`);
    return [];
  }

  const runProperties = firstRunProperties(source, content);
  const paragraph = content.children.find((child) => child.name === "w:p");
  if (content.children.some((child) => child.name === "w:tbl")) {
    // The control wraps a whole table. Replacing it with a run would delete
    // the table outright — and its value reads as empty, so the caller has no
    // way to see what it was about to destroy. A bare `w:r` is not valid block
    // content either, so Word would call the result unreadable.
    problems.push(
      `${field.id} ("${field.name}") wraps a table, not a value. ` +
        `Write into the table's cells with set_table_cell instead.`,
    );
    return [];
  }
  const replacement = paragraph
    ? buildParagraph(source, display, paragraph)
    : buildRun(display, runProperties);

  if (content.selfClosing) {
    edits.push({
      start: content.start,
      end: content.end,
      replacement: `<w:sdtContent>${replacement}</w:sdtContent>`,
    });
  } else {
    edits.push({ start: content.innerStart, end: content.innerEnd, replacement });
  }
  return edits;
}

/**
 * The character Word draws for a checkbox state.
 *
 * `w14:checkedState` stores a code point in hex plus the font that carries it.
 * `2612` is ☒ in any modern font; the older templates that name MS Gothic use
 * the same code points, so the glyph is all we need.
 */
function glyphForCode(code: string, checked: boolean): string {
  const parsed = Number.parseInt(code, 16);
  if (!Number.isFinite(parsed) || parsed <= 0) return checked ? "☒" : "☐";
  try {
    return String.fromCodePoint(parsed);
  } catch {
    return checked ? "☒" : "☐";
  }
}

/** Set a Word 97 form field's value. */
function setLegacyEdits(
  model: PartModel,
  field: FieldModel,
  value: string | undefined,
  checked: boolean | undefined,
  problems: string[],
): XmlEdit[] {
  const source = model.source;
  const data = firstChild(firstChild(field.node, "w:fldChar")!, "w:ffData");
  if (!data) {
    problems.push(`${field.id} is a malformed form field.`);
    return [];
  }
  const edits: XmlEdit[] = [];

  if (field.kind === "checkbox") {
    if (checked === undefined) {
      problems.push(`${field.id} ("${field.name}") is a checkbox — pass \`checked\`, not \`value\`.`);
      return [];
    }
    const box = firstChild(data, "w:checkBox");
    if (!box) {
      problems.push(`${field.id} declares no checkbox state.`);
      return [];
    }
    const replacement = `<w:checked w:val="${checked ? "1" : "0"}"/>`;
    const existing = firstChild(box, "w:checked");
    if (existing) {
      edits.push({ start: existing.start, end: existing.end, replacement });
    } else if (box.selfClosing) {
      edits.push({
        start: box.start,
        end: box.end,
        replacement: `<w:checkBox>${replacement}</w:checkBox>`,
      });
    } else {
      edits.push({ start: box.innerEnd, end: box.innerEnd, replacement });
    }
    return edits;
  }

  if (value === undefined) {
    problems.push(`${field.id} ("${field.name}") needs a \`value\`.`);
    return [];
  }

  let display = value;
  if (field.kind === "dropdown") {
    const list = firstChild(data, "w:ddList");
    const options = field.options ?? [];
    const index = options.findIndex(
      (option) => option.toLowerCase() === value.trim().toLowerCase(),
    );
    if (index === -1) {
      problems.push(`"${value}" is not one of ${field.id}'s options (${options.join(", ")}).`);
      return [];
    }
    display = options[index];
    if (list) {
      const result = firstChild(list, "w:result");
      const replacement = `<w:result w:val="${index}"/>`;
      if (result) edits.push({ start: result.start, end: result.end, replacement });
      else if (!list.selfClosing) {
        // `CT_FFDDList` declares `result?, default?, listEntry*` in that order,
        // so a new result goes at the front. Appended after the entries it is
        // out of sequence, which is the kind of thing Word offers to repair
        // rather than open.
        edits.push({ start: list.innerStart, end: list.innerStart, replacement });
      }
    }
  }

  const region = field.legacyResult;
  if (!region) {
    problems.push(
      `${field.id} ("${field.name}") has no result region that can be replaced on its own — ` +
        `its field markers sit at different nesting depths, which is what a tracked edit of a ` +
        `form looks like. Accept or reject the revisions first.`,
    );
    return [];
  }
  const properties = region.runs.length > 0 ? firstRunProperties(source, region.runs[0]) : "";
  edits.push({ start: region.start, end: region.end, replacement: buildRun(display, properties) });
  return edits;
}

type Match = { start: number; end: number };

function findMatches(haystack: string, needle: string, matchCase: boolean, all: boolean): Match[] {
  const source = matchCase ? haystack : haystack.toLowerCase();
  const target = matchCase ? needle : needle.toLowerCase();
  const out: Match[] = [];
  let from = 0;
  for (;;) {
    const at = source.indexOf(target, from);
    if (at === -1) break;
    out.push({ start: at, end: at + target.length });
    from = at + target.length;
    if (!all) break;
  }
  return out;
}

/**
 * Rewrite occurrences of `find` inside one paragraph.
 *
 * Word splits a sentence across runs wherever it likes — a spell-check
 * boundary, a saved revision, a language switch — so "Full name:" routinely
 * lives in four `w:t` elements and a search that looked at one element at a
 * time would report no match. Matching happens on the paragraph's stitched
 * text and the result is written back into the runs the match actually
 * covered, with the replacement landing in the first of them so it inherits
 * that run's formatting.
 */
function replaceInParagraph(
  source: string,
  paragraph: ParagraphModel,
  find: string,
  replace: string,
  matchCase: boolean,
  all: boolean,
): { edits: XmlEdit[]; count: number } {
  const matches = findMatches(paragraph.text, find, matchCase, all);
  if (matches.length === 0) return { edits: [], count: 0 };

  type SegmentOp = { start: number; end: number; text: string };
  const perSegment = new Map<number, SegmentOp[]>();
  const dropped = new Set<number>();

  for (const match of matches) {
    const affected: number[] = [];
    paragraph.segments.forEach((segment, index) => {
      if (segment.textStart < match.end && segment.textEnd > match.start) affected.push(index);
    });
    if (affected.length === 0) continue;
    const carrier = affected.find((index) => paragraph.segments[index].writable) ?? affected[0];

    for (const index of affected) {
      const segment = paragraph.segments[index];
      const localStart = Math.max(0, match.start - segment.textStart);
      const localEnd = Math.min(segment.value.length, match.end - segment.textStart);
      if (!segment.writable) {
        // A tab, break or symbol swallowed by the match. It carries no
        // character data to splice, so the element itself goes.
        if (index === carrier) {
          perSegment.set(index, [{ start: 0, end: 0, text: replace }]);
        } else {
          dropped.add(index);
        }
        continue;
      }
      const ops = perSegment.get(index) ?? [];
      ops.push({ start: localStart, end: localEnd, text: index === carrier ? replace : "" });
      perSegment.set(index, ops);
    }
  }

  const edits: XmlEdit[] = [];
  for (const [index, ops] of perSegment) {
    const segment = paragraph.segments[index];
    if (!segment.writable) {
      // The carrier was an atom: put a text element where it stood.
      edits.push({
        start: segment.srcStart,
        end: segment.srcEnd,
        replacement: `<w:t xml:space="preserve">${textRunContent(ops[0].text)}</w:t>`,
      });
      continue;
    }
    let value = segment.value;
    for (const op of [...ops].sort((a, b) => b.start - a.start)) {
      value = value.slice(0, op.start) + op.text + value.slice(op.end);
    }
    edits.push(...writeSegment(source, segment, value));
  }
  for (const index of dropped) {
    const segment = paragraph.segments[index];
    edits.push({ start: segment.srcStart, end: segment.srcEnd, replacement: "" });
  }
  return { edits, count: matches.length };
}

/**
 * Put `value` into a `w:t`, adding `xml:space="preserve"` if it is now needed.
 *
 * Without the attribute, Word collapses leading and trailing whitespace — so
 * an answer written as " Yes" beside a printed label would lose the space that
 * separates it from the label.
 */
function writeSegment(source: string, segment: TextSegment, value: string): XmlEdit[] {
  const node = segment.node;
  if (node.selfClosing) {
    return [
      {
        start: node.start,
        end: node.end,
        replacement: `<w:t xml:space="preserve">${textRunContent(value)}</w:t>`,
      },
    ];
  }
  const edits: XmlEdit[] = [
    { start: segment.srcStart, end: segment.srcEnd, replacement: textRunContent(value) },
  ];
  const needsPreserve = /^\s|\s$/.test(value) || value.length === 0;
  if (needsPreserve && node.attrs["xml:space"] !== "preserve") {
    if (node.attrs["xml:space"] === undefined) {
      // Slot the attribute in right after the element name, which is inside
      // the open tag and so cannot collide with the character-data edit above.
      const at = node.start + 1 + node.name.length;
      edits.push({ start: at, end: at, replacement: ' xml:space="preserve"' });
    } else {
      // `xml:space="default"` is the other legal value, and several non-Word
      // producers write it. Adding a second attribute rather than replacing
      // this one puts two of the same name in one start tag, which is not
      // well-formed XML — Word calls the file unreadable, and nothing
      // downstream re-validates before it is mailed out.
      const existing = existingSpaceAttributeRange(source, node);
      if (existing) edits.push({ ...existing, replacement: ' xml:space="preserve"' });
    }
  }
  return edits;
}

/**
 * The source range of an `xml:space` attribute, its leading whitespace included.
 *
 * The parser keeps decoded attribute values rather than their offsets, so the
 * range is recovered from the open tag — the only place an attribute can be.
 */
function existingSpaceAttributeRange(
  source: string,
  node: XmlNode,
): { start: number; end: number } | null {
  const openTagEnd = node.selfClosing ? node.end : node.innerStart;
  const match = source
    .slice(node.start, openTagEnd)
    .match(/\s+xml:space\s*=\s*("[^"]*"|'[^']*')/);
  if (!match || match.index === undefined) return null;
  return { start: node.start + match.index, end: node.start + match.index + match[0].length };
}

/**
 * Character data for a `w:t`, with the breaks the caller asked for.
 *
 * `replace_text` used to escape and nothing else, so a newline in the
 * replacement went in as a raw newline and Word collapsed it — the caller
 * asked for two lines and got one. Splitting the element the way
 * {@link runContent} does keeps the two paths saying the same thing.
 */
function textRunContent(value: string): string {
  const clean = value.replace(/\r\n?/g, "\n");
  if (!clean.includes("\n") && !clean.includes("\t")) return escapeXmlText(clean);
  return clean
    .split("\n")
    .map((line) =>
      line
        .split("\t")
        .map((piece) => escapeXmlText(piece))
        .join('</w:t><w:tab/><w:t xml:space="preserve">'),
    )
    .join('</w:t><w:br/><w:t xml:space="preserve">');
}

/** Paragraphs covered by a `within` scope: a paragraph, cell, table or part. */
function scopeParagraphs(
  works: PartWork[],
  within: string | undefined,
  problems: string[],
): { work: PartWork; paragraphs: ParagraphModel[] }[] {
  if (!within) {
    return works.map((work) => ({ work, paragraphs: work.model.paragraphs }));
  }
  for (const work of works) {
    if (work.model.key === within) {
      return [{ work, paragraphs: work.model.paragraphs }];
    }
    const entry = work.model.byId.get(within);
    if (!entry) continue;
    if ("segments" in entry) return [{ work, paragraphs: [entry] }];
    if ("rows" in entry) {
      const ids = new Set(collectCellParagraphIds(entry));
      return [{ work, paragraphs: work.model.paragraphs.filter((p) => ids.has(p.id)) }];
    }
    if ("paragraphIds" in entry) {
      const ids = new Set(entry.paragraphIds);
      return [{ work, paragraphs: work.model.paragraphs.filter((p) => ids.has(p.id)) }];
    }
  }
  problems.push(`No paragraph, cell, table or part called "${within}".`);
  return [];
}

function collectCellParagraphIds(table: TableModel): string[] {
  const out: string[] = [];
  for (const row of table.rows) {
    for (const cell of row.cells) {
      out.push(...cell.paragraphIds);
      for (const nested of cell.tables) out.push(...collectCellParagraphIds(nested));
    }
  }
  return out;
}

/** Find a field by id, then by exact name, then by tag. */
function resolveField(
  works: PartWork[],
  spec: { id?: string; name?: string },
  problems: string[],
): { work: PartWork; field: FieldModel } | null {
  if (spec.id) {
    for (const work of works) {
      const entry = work.model.byId.get(spec.id);
      if (entry && "flavour" in entry) return { work, field: entry };
    }
    problems.push(`No form field called "${spec.id}".`);
    return null;
  }
  if (!spec.name) {
    problems.push("set_field needs an `id` or a `name`.");
    return null;
  }
  const wanted = spec.name.trim().toLowerCase();
  const hits: { work: PartWork; field: FieldModel }[] = [];
  for (const work of works) {
    for (const field of work.model.fields) {
      if (
        field.name.trim().toLowerCase() === wanted ||
        (field.tag ?? "").trim().toLowerCase() === wanted
      ) {
        hits.push({ work, field });
      }
    }
  }
  if (hits.length === 0) {
    problems.push(`No form field named "${spec.name}".`);
    return null;
  }
  if (hits.length > 1) {
    problems.push(
      `"${spec.name}" matches ${hits.length} fields (${hits
        .map((hit) => hit.field.id)
        .join(", ")}) — address one by id.`,
    );
    return null;
  }
  return hits[0];
}

/**
 * The `w:tc` a paragraph sits in, looking through the wrappers Word puts
 * between them.
 *
 * A cell-level content control, or a tracked insertion, stands between the
 * cell and its paragraph — so a guard that only looked at the direct parent
 * would let the last paragraph be deleted out of such a cell, leaving a `w:tc`
 * with no block content at all, which Word reports as a corrupt file.
 */
function enclosingCell(node: XmlNode): XmlNode | null {
  const transparent = new Set(["w:sdt", "w:sdtContent", "w:ins", "w:del"]);
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "w:tc") return parent;
    if (!transparent.has(parent.name)) return null;
  }
  return null;
}

/** Where a new paragraph goes when appended: before the body's final `w:sectPr`. */
function bodyAppendOffset(model: PartModel): { start: number; end: number; wrap: boolean } {
  const sectionProperties = firstChild(model.container, "w:sectPr");
  if (sectionProperties) {
    return { start: sectionProperties.start, end: sectionProperties.start, wrap: false };
  }
  if (model.container.selfClosing) {
    // `<w:body/>` has no inside to append to. Writing at `end` would put the
    // paragraph after the closing bracket — a sibling of the body rather than
    // content of it — and the tool would report success on a document Word
    // shows as empty. Rewrite the element with an inside instead.
    return { start: model.container.start, end: model.container.end, wrap: true };
  }
  return { start: model.container.innerEnd, end: model.container.innerEnd, wrap: false };
}

function findParagraph(
  works: PartWork[],
  id: string,
  problems: string[],
  operation: string,
): { work: PartWork; paragraph: ParagraphModel } | null {
  for (const work of works) {
    const entry = work.model.byId.get(id);
    if (!entry) continue;
    if ("segments" in entry) return { work, paragraph: entry };
    problems.push(`${id} is not a paragraph, so ${operation} cannot act on it.`);
    return null;
  }
  problems.push(`No paragraph called "${id}".`);
  return null;
}

/**
 * Apply a batch of operations to a `.docx` and return the new bytes.
 *
 * Operations are independent: each is resolved against the original document,
 * so `insert_paragraph after p4` twice inserts two paragraphs after the
 * original `p4` in the order given, and no operation has to reason about what
 * an earlier one did to the numbering.
 */
export async function editDocx(
  bytes: Buffer,
  operations: readonly DocxOperation[],
): Promise<DocxEditResult> {
  if (operations.length === 0) {
    throw new DocxEditError(["No operations were given, so there is nothing to change."]);
  }
  const pkg = await DocxPackage.open(bytes);
  const works: PartWork[] = [];
  for (const path of pkg.contentParts()) {
    const source = await pkg.text(path);
    if (source === null) continue;
    try {
      works.push({ model: buildPartModel(path, source), edits: [] });
    } catch (error) {
      if (path === DOCUMENT_PART) {
        throw new DocxError(
          `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (works.length === 0) throw new DocxError("This document has no editable content.");
  const body = works[0];

  const problems: string[] = [];
  const applied: string[] = [];
  const warnings: string[] = [];

  for (const operation of operations) {
    switch (operation.op) {
      case "set_paragraph": {
        const found = findParagraph(works, operation.id, problems, "set_paragraph");
        if (!found) break;
        found.work.edits.push(
          ...setParagraphEdits(found.work.model.source, found.paragraph, operation.text, problems),
        );
        applied.push(`set_paragraph ${operation.id}`);
        break;
      }
      case "delete_paragraph": {
        const found = findParagraph(works, operation.id, problems, "delete_paragraph");
        if (!found) break;
        const parent = found.paragraph.node.parent;
        const siblings = parent?.children.filter((child) => child.name === "w:p") ?? [];
        const cell = enclosingCell(found.paragraph.node);
        if (cell && descendantsNamed(cell, "w:p", new Set(["w:tbl"])).length <= 1) {
          problems.push(
            `${operation.id} is the only paragraph in its table cell, and Word requires one — ` +
              `clear it with set_table_cell instead of deleting it.`,
          );
          break;
        }
        if (parent === body.model.container && siblings.length <= 1) {
          problems.push(
            `${operation.id} is the document's only paragraph and cannot be deleted; ` +
              `set_paragraph with an empty string clears it.`,
          );
          break;
        }
        found.work.edits.push({
          start: found.paragraph.node.start,
          end: found.paragraph.node.end,
          replacement: "",
        });
        applied.push(`delete_paragraph ${operation.id}`);
        break;
      }
      case "insert_paragraph": {
        const anchor = operation.after ?? operation.before;
        if (!anchor) {
          problems.push("insert_paragraph needs `after` or `before`.");
          break;
        }
        if (operation.after && operation.before) {
          problems.push("insert_paragraph takes `after` or `before`, not both.");
          break;
        }
        const found = findParagraph(works, anchor, problems, "insert_paragraph");
        if (!found) break;
        const at = operation.after ? found.paragraph.node.end : found.paragraph.node.start;
        const lines = asLines(operation.text);
        for (const line of lines) {
          found.work.edits.push({
            start: at,
            end: at,
            replacement: buildParagraph(
              found.work.model.source,
              line,
              found.paragraph.node,
              operation.style,
            ),
          });
        }
        applied.push(
          `insert_paragraph ${lines.length} ${operation.after ? "after" : "before"} ${anchor}`,
        );
        break;
      }
      case "append_paragraph": {
        const at = bodyAppendOffset(body.model);
        const last = body.model.paragraphs[body.model.paragraphs.length - 1] ?? null;
        const lines = asLines(operation.text);
        const built = lines
          .map((line) =>
            buildParagraph(
              body.model.source,
              line,
              operation.style ? null : (last?.node ?? null),
              operation.style,
            ),
          )
          .join("");
        body.edits.push({
          start: at.start,
          end: at.end,
          replacement: at.wrap
            ? `<${body.model.container.name}>${built}</${body.model.container.name}>`
            : built,
        });
        applied.push(`append_paragraph ${lines.length}`);
        break;
      }
      case "set_table_cell": {
        let handled = false;
        for (const work of works) {
          const entry = work.model.byId.get(operation.id);
          if (!entry) continue;
          if (!("paragraphIds" in entry)) {
            problems.push(`${operation.id} is not a table cell.`);
          } else {
            work.edits.push(...setCellEdits(work.model, entry, operation.text, problems));
            applied.push(`set_table_cell ${operation.id}`);
          }
          handled = true;
          break;
        }
        if (!handled) problems.push(`No table cell called "${operation.id}".`);
        break;
      }
      case "set_field": {
        const found = resolveField(works, operation, problems);
        if (!found) break;
        const edits =
          found.field.flavour === "sdt"
            ? setSdtEdits(
                found.work.model,
                found.field,
                operation.value,
                operation.checked,
                problems,
              )
            : setLegacyEdits(
                found.work.model,
                found.field,
                operation.value,
                operation.checked,
                problems,
              );
        found.work.edits.push(...edits);
        applied.push(`set_field ${found.field.id} ("${found.field.name}")`);
        break;
      }
      case "replace_text": {
        if (operation.find.length === 0) {
          problems.push("replace_text needs a non-empty `find`.");
          break;
        }
        const scopes = scopeParagraphs(works, operation.within, problems);
        let total = 0;
        for (const scope of scopes) {
          for (const paragraph of scope.paragraphs) {
            const result = replaceInParagraph(
              scope.work.model.source,
              paragraph,
              operation.find,
              operation.replace,
              operation.matchCase ?? false,
              operation.all ?? true,
            );
            if (result.count === 0) continue;
            scope.work.edits.push(...result.edits);
            total += result.count;
            if (operation.all === false) break;
          }
          if (operation.all === false && total > 0) break;
        }
        if (total === 0 && problems.length === 0) {
          problems.push(
            `Found no "${operation.find}"${operation.within ? ` in ${operation.within}` : ""}. ` +
              `Read the document again — Word may split it across runs differently than you expect, ` +
              `or the punctuation may not match.`,
          );
          break;
        }
        applied.push(`replace_text ${total}x "${operation.find}"`);
        break;
      }
      default: {
        problems.push(`Unknown operation ${JSON.stringify((operation as { op: string }).op)}.`);
      }
    }
  }

  if (problems.length > 0) throw new DocxEditError(problems);

  for (const work of works) {
    if (work.edits.length === 0) continue;
    let updated: string;
    try {
      updated = applyEdits(work.model.source, work.edits);
    } catch (error) {
      throw new DocxEditError([
        `Two operations changed the same part of ${work.model.path}: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          `Split them across separate edit_docx calls.`,
      ]);
    }
    pkg.setText(work.model.path, updated);
  }

  return { bytes: await pkg.save(), applied, warnings };
}
