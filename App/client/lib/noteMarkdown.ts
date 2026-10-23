/**
 * Notes are stored as Markdown — the body AI Employees read and write through
 * their note tools — and edited as blocks. This module turns one into the
 * other without losing anything.
 *
 * **Nothing is rewritten that wasn't edited.** Every parsed block remembers
 * the exact source lines it came from and the blank lines before it. When a
 * note is saved, a block whose content is unchanged is written back
 * byte-for-byte, so editing one line of a page an AI Employee wrote leaves
 * the rest of its Markdown — tables, HTML, odd list markers, trailing spaces —
 * exactly as it was. Only edited blocks are written fresh, in conventional
 * Markdown. `serializeDoc(parseDoc(md)) === md` holds for every string.
 *
 * Blocks are a flat list with a `depth`, the way Notion presents nesting.
 * Children live under list items (indented, as Markdown nests them) and
 * toggles (inside `<details>`). The block types and how they are written:
 *
 *   paragraph   text                  heading   # … ###### (levels 1–6)
 *   bulleted    - text                numbered  1. text
 *   todo        - [ ] / - [x] text    toggle    <details><summary>…</summary>
 *   quote       > text                callout   > [!NOTE] / [!TIP] / …
 *   code        ```lang fences        divider   ---
 *   image       ![alt](src)           table     a GFM table, kept as source
 *   raw         anything else (HTML, setext headings, footnotes…), kept as source
 */

import {
  parseInline,
  plainText,
  type Run,
  serializeInline,
  textRuns,
} from "./noteInline.js";

export type BlockType =
  | "paragraph"
  | "heading"
  | "bulleted"
  | "numbered"
  | "todo"
  | "toggle"
  | "quote"
  | "callout"
  | "code"
  | "divider"
  | "image"
  | "table"
  | "raw";

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

export const CALLOUT_KINDS: readonly CalloutKind[] = ["note", "tip", "important", "warning", "caution"];

/** Where a parsed block came from, so an unedited block is written back verbatim. */
export type BlockOrigin = {
  /** The block's own source lines, exactly as written (a `\r` ending included). */
  lines: string[];
  /** The container indentation, in columns, those lines were written under. */
  indent: number;
  /** The block's content signature when it was read. */
  sig: string;
  /** Position among the source's segments (blocks and toggle closings). */
  index: number;
  /** The text between the previous segment's last line and this block's first. */
  gap: string;
  /** A toggle's `</details>` line, written after its last child. */
  close?: { lines: string[]; index: number; gap: string };
};

export type Block = {
  id: string;
  type: BlockType;
  depth: number;
  /** Rich text: paragraph, heading, list items, todo, toggle summary, quote, callout. */
  runs: Run[];
  /** Plain source: code, table, raw. */
  text: string;
  /** Heading level, 1–6. */
  level?: number;
  checked?: boolean;
  /** A numbered list's first number, on the list's first item only. */
  start?: number;
  /** A code block's info string (its language, usually). */
  lang?: string;
  kind?: CalloutKind;
  src?: string;
  alt?: string;
  title?: string;
  /** Whether a toggle shows its children. Screen state, never saved. */
  open?: boolean;
  origin?: BlockOrigin;
};

export type NoteDoc = {
  blocks: Block[];
  /** Whitespace before the first block. */
  leading: string;
  /** Whitespace after the last block. */
  trailing: string;
  /** How many segments the source had, to know which one was last. */
  segments: number;
};

let idCounter = 0;

/** A fresh block id: unique within the page, never saved. */
export function newBlockId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `b${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function isListItem(block: Pick<Block, "type">): boolean {
  return block.type === "bulleted" || block.type === "numbered" || block.type === "todo";
}

/** Block types that can hold children. */
export function isContainer(block: Pick<Block, "type">): boolean {
  return isListItem(block) || block.type === "toggle";
}

/** Block types edited as rich text. */
export function isRichText(type: BlockType): boolean {
  return (
    type === "paragraph" ||
    type === "heading" ||
    type === "bulleted" ||
    type === "numbered" ||
    type === "todo" ||
    type === "toggle" ||
    type === "quote" ||
    type === "callout"
  );
}

/** Block types edited as plain source text. */
export function isPlainText(type: BlockType): boolean {
  return type === "code" || type === "table" || type === "raw";
}

// ───────────────────────── Signatures ───────────────────────────────────────

const sigCache = new WeakMap<Block, string>();

/** A block's content, excluding position and screen state. */
function contentSignature(block: Block): string {
  const cached = sigCache.get(block);
  if (cached !== undefined) return cached;
  const sig = JSON.stringify([
    block.type,
    block.level ?? 0,
    block.checked ? 1 : 0,
    block.lang ?? "",
    block.kind ?? "",
    block.src ?? "",
    block.alt ?? "",
    block.title ?? "",
    block.text,
    block.runs,
  ]);
  sigCache.set(block, sig);
  return sig;
}

function signature(block: Block, ordinal: number | undefined): string {
  const base = contentSignature(block);
  return block.type === "numbered" ? `${base}#${ordinal ?? 1}` : base;
}

/** Has this block been edited since it was read from Markdown? New blocks count as edited. */
export function isUnchanged(block: Block, ordinal?: number): boolean {
  return block.origin !== undefined && block.origin.sig === signature(block, ordinal);
}

// ───────────────────────── Structure helpers ────────────────────────────────

/** Index just past the block at `index` and all its descendants. */
export function subtreeEnd(blocks: readonly Block[], index: number): number {
  const depth = blocks[index].depth;
  let end = index + 1;
  while (end < blocks.length && blocks[end].depth > depth) end++;
  return end;
}

/** Does the numbered item at `index` continue a list above it, rather than start one? */
export function continuesNumbering(blocks: readonly Block[], index: number): boolean {
  const block = blocks[index];
  let prev = index - 1;
  while (prev >= 0 && blocks[prev].depth > block.depth) prev--;
  return prev >= 0 && blocks[prev].type === "numbered" && blocks[prev].depth === block.depth;
}

/** The number each numbered item shows, by index (undefined for other blocks). */
export function listOrdinals(blocks: readonly Block[]): Array<number | undefined> {
  const out: Array<number | undefined> = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.type !== "numbered") continue;
    let prev = i - 1;
    while (prev >= 0 && blocks[prev].depth > block.depth) prev--;
    const before = prev >= 0 ? blocks[prev] : null;
    if (before && before.type === "numbered" && before.depth === block.depth) {
      out[i] = (out[prev] ?? 1) + 1;
    } else {
      out[i] = block.start ?? 1;
    }
  }
  return out;
}

// ───────────────────────── Line helpers ─────────────────────────────────────

function isBlank(text: string): boolean {
  return /^[ \t]*$/.test(text);
}

/** Columns of leading whitespace, tabs advancing to the next multiple of 4. */
function leadingColumns(text: string): number {
  let col = 0;
  for (const ch of text) {
    if (ch === " ") col++;
    else if (ch === "\t") col += 4 - (col % 4);
    else break;
  }
  return col;
}

/** Remove `columns` of leading whitespace, splitting a tab if it straddles the cut. */
function stripColumns(text: string, columns: number): string {
  let col = 0;
  let i = 0;
  while (i < text.length && col < columns) {
    const ch = text[i];
    if (ch === " ") col++;
    else if (ch === "\t") {
      const next = col + 4 - (col % 4);
      if (next > columns) return " ".repeat(next - columns) + text.slice(i + 1);
      col = next;
    } else break;
    i++;
  }
  return text.slice(i);
}

function reindent(lines: readonly string[], from: number, to: number): string[] {
  return lines.map((line) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    const cr = line.endsWith("\r") ? "\r" : "";
    if (isBlank(text)) return "";
    return " ".repeat(to) + stripColumns(text, Math.min(from, leadingColumns(text))) + cr;
  });
}

const ATX = /^(#{1,6})(?=[ \t]|$)(.*)$/;
const THEMATIC = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const BULLET = /^([-+*])(?=[ \t]|$)/;
const ORDERED = /^(\d{1,9})([.)])(?=[ \t]|$)/;
const SETEXT = /^(?:=+|-+)[ \t]*$/;
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*$/i;
const IMAGE_LINE =
  /^!\[((?:[^\]\\]|\\.)*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\)$/;

const HTML_BLOCK_TAGS = new Set(
  (
    "address article aside base basefont blockquote body caption center col colgroup dd details " +
    "dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 " +
    "head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option " +
    "p param search section summary table tbody td tfoot th thead title tr track ul"
  ).split(" "),
);

type HtmlKind = { end: RegExp | "blank"; interrupts: boolean };

/** CommonMark's HTML block start conditions, with how each one ends. */
function htmlBlockKind(content: string): HtmlKind | null {
  if (/^<(?:script|pre|style|textarea)(?:[\s>]|$)/i.test(content)) {
    return { end: /<\/(?:script|pre|style|textarea)>/i, interrupts: true };
  }
  if (content.startsWith("<!--")) return { end: /-->/, interrupts: true };
  if (content.startsWith("<?")) return { end: /\?>/, interrupts: true };
  if (/^<![A-Za-z]/.test(content)) return { end: />/, interrupts: true };
  if (content.startsWith("<![CDATA[")) return { end: /\]\]>/, interrupts: true };
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[\s/>]|$)/.exec(content);
  if (tag && HTML_BLOCK_TAGS.has(tag[1].toLowerCase())) return { end: "blank", interrupts: true };
  if (
    /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/.test(
      content,
    )
  ) {
    return { end: "blank", interrupts: false };
  }
  return null;
}

type ListMarker = {
  ordered: boolean;
  number: number;
  /** Columns from the marker's first character to the item's content. */
  width: number;
  /** The item's text on its first line. */
  rest: string;
};

function matchListItem(content: string, column: number): ListMarker | null {
  if (THEMATIC.test(content)) return null;
  let ordered = false;
  let number = 0;
  let markerLength: number;
  const bullet = BULLET.exec(content);
  if (bullet) {
    markerLength = 1;
  } else {
    const ord = ORDERED.exec(content);
    if (!ord) return null;
    ordered = true;
    number = Number(ord[1]);
    markerLength = ord[1].length + 1;
  }
  const after = content.slice(markerLength);
  if (isBlank(after)) return { ordered, number, width: markerLength + 1, rest: "" };
  let col = column + markerLength;
  let i = 0;
  while (i < after.length && (after[i] === " " || after[i] === "\t")) {
    col += after[i] === "\t" ? 4 - (col % 4) : 1;
    i++;
  }
  const spaces = col - (column + markerLength);
  if (spaces >= 5) {
    return { ordered, number, width: markerLength + 1, rest: stripColumns(after, 1) };
  }
  return { ordered, number, width: markerLength + spaces, rest: after.slice(i) };
}

/** Would this line, at this relative indentation, end a paragraph? */
function interruptsParagraph(content: string, rel: number): boolean {
  if (rel >= 4) return false;
  if (ATX.test(content) || THEMATIC.test(content) || content.startsWith(">")) return true;
  const fence = FENCE.exec(content);
  if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) return true;
  const html = htmlBlockKind(content);
  if (html?.interrupts) return true;
  if (/^[-+*][ \t]+\S/.test(content)) return true;
  if (/^1[.)][ \t]+\S/.test(content)) return true;
  return false;
}

/** Does this line start a block construct a simple quote can't hold as text? */
function startsBlockConstruct(content: string): boolean {
  if (leadingColumns(content) >= 4) return true;
  const c = content.replace(/^[ \t]+/, "");
  if (ATX.test(c) || THEMATIC.test(c) || c.startsWith(">")) return true;
  if (FENCE.test(c)) return true;
  if (htmlBlockKind(c)) return true;
  if (BULLET.test(c) || ORDERED.test(c)) return true;
  return false;
}

function tableCells(line: string): number {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  return text.split(/(?<!\\)\|/).length;
}

const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isTableStart(header: string, delimiter: string | undefined): boolean {
  if (delimiter === undefined || !header.includes("|")) return false;
  const d = delimiter.trim();
  if (!DELIMITER_ROW.test(d)) return false;
  if (!d.includes("|") && tableCells(header) !== 1) return false;
  return tableCells(header) === tableCells(d);
}

function unescapeText(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

// ───────────────────────── Parsing ──────────────────────────────────────────

type SourceLine = { raw: string; text: string };

type Segment =
  | { kind: "block"; start: number; end: number; block: Block }
  | { kind: "close"; start: number; end: number; block: Block };

type ParseState = { lines: SourceLine[]; blocks: Block[]; segments: Segment[] };

function makeBlock(type: BlockType, depth: number, extra: Partial<Block> = {}): Block {
  return { id: newBlockId(), type, depth, runs: [], text: "", ...extra };
}

function pushBlock(
  state: ParseState,
  block: Block,
  start: number,
  end: number,
  indent: number,
): void {
  block.origin = {
    lines: state.lines.slice(start, end).map((l) => l.raw),
    indent,
    sig: "",
    index: 0,
    gap: "",
  };
  state.blocks.push(block);
  state.segments.push({ kind: "block", start, end, block });
}

function contentOf(line: SourceLine): { col: number; content: string } {
  const col = leadingColumns(line.text);
  return { col, content: stripColumns(line.text, col) };
}

function paragraphText(lines: SourceLine[]): string {
  const parts = lines.map((l) => l.text.replace(/^[ \t]+/, ""));
  parts[parts.length - 1] = parts[parts.length - 1].replace(/[ \t]+$/, "");
  return parts.join("\n");
}

function parseLines(state: ParseState, start: number, end: number, indent: number, depth: number) {
  const { lines } = state;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line.text)) {
      i++;
      continue;
    }
    const { col, content } = contentOf(line);
    const rel = col - indent;

    // Indented code: kept as source.
    if (rel >= 4) {
      let j = i + 1;
      while (j < end && (isBlank(lines[j].text) || leadingColumns(lines[j].text) - indent >= 4)) j++;
      while (j > i + 1 && isBlank(lines[j - 1].text)) j--;
      pushBlock(state, makeBlock("raw", depth, { text: textOf(lines, i, j, indent) }), i, j, indent);
      i = j;
      continue;
    }

    const fence = FENCE.exec(content);
    if (fence && !(fence[1][0] === "`" && fence[2].includes("`"))) {
      const marker = fence[1];
      const closer = new RegExp(`^${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      let j = i + 1;
      let closed = false;
      while (j < end) {
        const t = lines[j].text;
        if (leadingColumns(t) - indent < 4 && closer.test(t.replace(/^[ \t]+/, ""))) {
          closed = true;
          break;
        }
        j++;
      }
      const body = lines
        .slice(i + 1, j)
        .map((l) => stripColumns(l.text, Math.min(leadingColumns(l.text), col)));
      const segEnd = closed ? j + 1 : j;
      pushBlock(
        state,
        makeBlock("code", depth, { text: body.join("\n"), lang: fence[2].trim() }),
        i,
        segEnd,
        indent,
      );
      i = segEnd;
      continue;
    }

    const atx = ATX.exec(content);
    if (atx) {
      const text = atx[2].trim().replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
      pushBlock(
        state,
        makeBlock("heading", depth, { level: atx[1].length, runs: parseInline(text) }),
        i,
        i + 1,
        indent,
      );
      i++;
      continue;
    }

    if (THEMATIC.test(content)) {
      pushBlock(state, makeBlock("divider", depth), i, i + 1, indent);
      i++;
      continue;
    }

    if (content.startsWith(">")) {
      let j = i;
      while (j < end) {
        const t = lines[j].text;
        if (isBlank(t)) break;
        const c = contentOf(lines[j]);
        if (c.col - indent >= 4 || !c.content.startsWith(">")) break;
        j++;
      }
      const inner = lines.slice(i, j).map((l) => contentOf(l).content.replace(/^>[ ]?/, ""));
      const callout = CALLOUT.exec(inner[0]);
      const body = callout ? inner.slice(1) : inner;
      if (body.some((l) => !isBlank(l) && startsBlockConstruct(l))) {
        pushBlock(state, makeBlock("raw", depth, { text: textOf(lines, i, j, indent) }), i, j, indent);
      } else {
        const text = body.map((l) => l.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "")).join("\n");
        const block = callout
          ? makeBlock("callout", depth, {
              kind: callout[1].toLowerCase() as CalloutKind,
              runs: parseInline(text),
            })
          : makeBlock("quote", depth, { runs: parseInline(text) });
        pushBlock(state, block, i, j, indent);
      }
      i = j;
      continue;
    }

    if (/^<details(?:\s[^>]*)?>/i.test(content)) {
      const next = parseToggle(state, i, end, indent, depth);
      if (next !== null) {
        i = next;
        continue;
      }
    }

    const html = htmlBlockKind(content);
    if (html) {
      let j = i;
      if (html.end === "blank") {
        while (j < end && !isBlank(lines[j].text)) j++;
      } else {
        const ender = html.end;
        while (j < end && !ender.test(lines[j].text)) j++;
        j = Math.min(j + 1, end);
      }
      pushBlock(state, makeBlock("raw", depth, { text: textOf(lines, i, j, indent) }), i, j, indent);
      i = j;
      continue;
    }

    const item = matchListItem(content, col);
    if (item) {
      i = parseListItem(state, i, end, indent, col, item, depth);
      continue;
    }

    if (isTableStart(content, lines[i + 1]?.text) && i + 1 < end) {
      let j = i + 2;
      while (j < end) {
        const t = lines[j].text;
        if (isBlank(t)) break;
        const c = contentOf(lines[j]);
        if (interruptsParagraph(c.content, c.col - indent)) break;
        j++;
      }
      pushBlock(state, makeBlock("table", depth, { text: textOf(lines, i, j, indent) }), i, j, indent);
      i = j;
      continue;
    }

    if (/^\[[^\]]+\]:/.test(content)) {
      let j = i + 1;
      while (j < end && !isBlank(lines[j].text) && leadingColumns(lines[j].text) - indent >= 4) j++;
      pushBlock(state, makeBlock("raw", depth, { text: textOf(lines, i, j, indent) }), i, j, indent);
      i = j;
      continue;
    }

    const image = IMAGE_LINE.exec(content.replace(/[ \t]+$/, ""));
    const nextLine = lines[i + 1];
    if (
      image &&
      (i + 1 >= end ||
        isBlank(nextLine.text) ||
        interruptsParagraph(contentOf(nextLine).content, contentOf(nextLine).col - indent))
    ) {
      const src = image[2].startsWith("<") ? image[2].slice(1, -1) : image[2];
      pushBlock(
        state,
        makeBlock("image", depth, {
          alt: unescapeText(image[1]),
          src: unescapeText(src),
          ...(image[3] !== undefined ? { title: unescapeText(image[3]) } : {}),
        }),
        i,
        i + 1,
        indent,
      );
      i++;
      continue;
    }

    // A paragraph runs until a blank line or a line that interrupts it.
    let j = i + 1;
    let setext = false;
    while (j < end) {
      const t = lines[j].text;
      if (isBlank(t)) break;
      const c = contentOf(lines[j]);
      if (c.col - indent < 4 && SETEXT.test(c.content)) {
        setext = true;
        j++;
        break;
      }
      if (interruptsParagraph(c.content, c.col - indent)) break;
      if (isTableStart(c.content, lines[j + 1]?.text) && j + 1 < end) break;
      j++;
    }
    if (setext) {
      pushBlock(state, makeBlock("raw", depth, { text: textOf(lines, i, j, indent) }), i, j, indent);
    } else {
      pushBlock(
        state,
        makeBlock("paragraph", depth, { runs: parseInline(paragraphText(lines.slice(i, j))) }),
        i,
        j,
        indent,
      );
    }
    i = j;
  }
}

/** Source lines, de-indented from their container: what a raw block shows. */
function textOf(lines: SourceLine[], start: number, end: number, indent: number): string {
  return lines
    .slice(start, end)
    .map((l) => stripColumns(l.text, Math.min(indent, leadingColumns(l.text))))
    .join("\n");
}

function parseListItem(
  state: ParseState,
  start: number,
  end: number,
  indent: number,
  col: number,
  item: ListMarker,
  depth: number,
): number {
  const { lines } = state;
  const contentCol = col + item.width;
  const textLines: string[] = [item.rest];
  let j = start + 1;
  while (j < end) {
    const t = lines[j].text;
    if (isBlank(t)) break;
    const c = contentOf(lines[j]);
    if (c.col >= contentCol) {
      if (interruptsParagraph(c.content, c.col - contentCol)) break;
      if (isTableStart(c.content, lines[j + 1]?.text)) break;
      textLines.push(c.content);
      j++;
      continue;
    }
    if (interruptsParagraph(c.content, Math.max(0, c.col - indent)) || matchListItem(c.content, c.col)) {
      break;
    }
    if (c.col < indent) break;
    textLines.push(c.content);
    j++;
  }
  const ownEnd = j;
  let k = ownEnd;
  let childEnd = ownEnd;
  while (k < end) {
    const t = lines[k].text;
    if (isBlank(t)) {
      k++;
      continue;
    }
    if (leadingColumns(t) >= contentCol) {
      k++;
      childEnd = k;
      continue;
    }
    break;
  }
  let type: BlockType = item.ordered ? "numbered" : "bulleted";
  let checked: boolean | undefined;
  let first = textLines[0];
  if (!item.ordered) {
    const task = /^\[([ xX])\](?:[ \t]+|$)(.*)$/.exec(first);
    if (task) {
      type = "todo";
      checked = task[1] !== " ";
      first = task[2];
    }
  }
  textLines[0] = first;
  const text = textLines
    .map((l, n) => (n === textLines.length - 1 ? l.replace(/[ \t]+$/, "") : l))
    .join("\n");
  const block = makeBlock(type, depth, {
    runs: parseInline(text),
    ...(type === "todo" ? { checked } : {}),
    ...(type === "numbered" ? { start: item.number } : {}),
  });
  pushBlock(state, block, start, ownEnd, indent);
  if (childEnd > ownEnd) parseLines(state, ownEnd, childEnd, contentCol, depth + 1);
  return childEnd;
}

function parseToggle(
  state: ParseState,
  start: number,
  end: number,
  indent: number,
  depth: number,
): number | null {
  const { lines } = state;
  const first = contentOf(lines[start]).content;
  const open = /^<details(\s[^>]*)?>(.*)$/i.exec(first);
  if (!open) return null;
  let summaryLine = start;
  let summary: string | null = null;
  const rest = open[2].trim();
  const inline = /^<summary>(.*)<\/summary>$/i.exec(rest);
  if (inline) summary = inline[1];
  else if (rest === "" && start + 1 < end) {
    const next = /^<summary>(.*)<\/summary>$/i.exec(contentOf(lines[start + 1]).content.trim());
    if (next) {
      summary = next[1];
      summaryLine = start + 1;
    }
  }
  if (summary === null) return null;
  let nest = 0;
  let closeLine = -1;
  let fence: RegExp | null = null;
  for (let j = summaryLine + 1; j < end; j++) {
    const c = contentOf(lines[j]).content.trim();
    // A `</details>` inside a code block is code, not the toggle's end.
    if (fence) {
      if (fence.test(c)) fence = null;
      continue;
    }
    const opener = FENCE.exec(c);
    if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
      fence = new RegExp(`^${opener[1][0] === "`" ? "`" : "~"}{${opener[1].length},}[ \\t]*$`);
      continue;
    }
    if (/^<details(?:\s[^>]*)?>/i.test(c)) nest++;
    else if (/^<\/details>$/i.test(c)) {
      if (nest === 0) {
        closeLine = j;
        break;
      }
      nest--;
    }
  }
  if (closeLine < 0) return null;
  const block = makeBlock("toggle", depth, {
    runs: parseInline(summary.trim()),
    open: /\sopen\b/i.test(open[1] ?? ""),
  });
  pushBlock(state, block, start, summaryLine + 1, indent);
  let a = summaryLine + 1;
  let b = closeLine;
  while (a < b && isBlank(lines[a].text)) a++;
  while (b > a && isBlank(lines[b - 1].text)) b--;
  if (b > a) parseLines(state, a, b, indent, depth + 1);
  state.segments.push({ kind: "close", start: closeLine, end: closeLine + 1, block });
  block.origin!.close = {
    lines: [lines[closeLine].raw],
    index: 0,
    gap: "",
  };
  return closeLine + 1;
}

/** Read Markdown into blocks, remembering where each came from. */
export function parseDoc(md: string): NoteDoc {
  const lines: SourceLine[] = md
    .split("\n")
    .map((raw) => ({ raw, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw }));
  const state: ParseState = { lines, blocks: [], segments: [] };
  parseLines(state, 0, lines.length, 0, 0);

  // A numbered list remembers its first number on its first item only.
  for (let i = 0; i < state.blocks.length; i++) {
    const block = state.blocks[i];
    if (block.type !== "numbered") continue;
    let prev = i - 1;
    while (prev >= 0 && state.blocks[prev].depth > block.depth) prev--;
    const before = prev >= 0 ? state.blocks[prev] : null;
    if (before && before.type === "numbered" && before.depth === block.depth) delete block.start;
  }
  const ordinals = listOrdinals(state.blocks);
  state.blocks.forEach((block, i) => {
    block.origin!.sig = signature(block, ordinals[i]);
  });

  const segments = state.segments;
  if (segments.length === 0) {
    return { blocks: [], leading: md, trailing: "", segments: 0 };
  }
  const gapText = (from: number, to: number) => {
    let gap = "\n";
    for (let k = from; k < to; k++) gap += `${lines[k].raw}\n`;
    return gap;
  };
  let leading = "";
  for (let k = 0; k < segments[0].start; k++) leading += `${lines[k].raw}\n`;
  segments.forEach((segment, index) => {
    const gap = index === 0 ? "" : gapText(segments[index - 1].end, segment.start);
    const origin = segment.block.origin!;
    if (segment.kind === "block") {
      origin.index = index;
      origin.gap = gap;
    } else {
      origin.close!.index = index;
      origin.close!.gap = gap;
    }
  });
  const lastEnd = segments[segments.length - 1].end;
  const trailing =
    lastEnd < lines.length ? `\n${lines.slice(lastEnd).map((l) => l.raw).join("\n")}` : "";
  return { blocks: state.blocks, leading, trailing, segments: segments.length };
}

// ───────────────────────── Serializing ──────────────────────────────────────

/**
 * Escape what would read as block syntax at the start of a line of text:
 * `# `, `> `, `- `, `1. `, `---`, a setext underline.
 */
function escapeLineStart(line: string, first: boolean): string {
  if (/^#{1,6}(?:[ \t]|$)/.test(line)) return `\\${line}`;
  if (line.startsWith(">")) return `\\${line}`;
  if (/^[-+*](?:[ \t]|$)/.test(line)) return `\\${line}`;
  if (THEMATIC.test(line)) return `\\${line}`;
  if (!first && SETEXT.test(line)) return `\\${line}`;
  if (!first && line.includes("-") && DELIMITER_ROW.test(line)) return `\\${line}`;
  const ordered = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(line);
  if (ordered) return `${ordered[1]}\\${line.slice(ordered[1].length)}`;
  return line;
}

/** Inline content as Markdown lines: no blank lines, no leading spaces, block syntax escaped. */
function textLines(runs: readonly Run[]): string[] {
  return serializeInline(runs)
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""))
    .filter((line) => line !== "")
    .map((line, n) => escapeLineStart(line, n === 0));
}

function codeFence(text: string, lang: string): string[] {
  let longest = 0;
  for (const line of text.split("\n")) {
    const m = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (m && m[1][0] === "`") longest = Math.max(longest, m[1].length);
  }
  const useTildes = lang.includes("`");
  let fence = useTildes ? "~~~" : "`".repeat(Math.max(3, longest + 1));
  if (useTildes) {
    let tildes = 0;
    for (const line of text.split("\n")) {
      const m = /^[ \t]{0,3}(~{3,})/.exec(line);
      if (m) tildes = Math.max(tildes, m[1].length);
    }
    fence = "~".repeat(Math.max(3, tildes + 1));
  }
  const body = text === "" ? [] : text.split("\n");
  return [`${fence}${lang}`, ...body, fence];
}

function escapeImageText(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

function imageLine(block: Block): string {
  const src = block.src ?? "";
  const dest = src === "" || /[\s<>()]/.test(src) ? `<${src.replace(/[<>]/g, "")}>` : src;
  const title = block.title ? ` "${block.title.replace(/["\\]/g, (c) => `\\${c}`)}"` : "";
  return `![${escapeImageText(block.alt ?? "")}](${dest}${title})`;
}

function quoteLines(runs: readonly Run[]): string[] {
  const lines = serializeInline(runs)
    .split("\n")
    .map((line) => line.replace(/^[ \t]+/, "").replace(/[ \t]+$/, ""));
  while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 1 && lines[0] === "") lines.shift();
  return lines.map((line, n) => (line === "" ? ">" : `> ${escapeLineStart(line, n === 0)}`));
}

function itemLines(marker: string, runs: readonly Run[]): string[] {
  const lines = textLines(runs);
  if (lines.length === 0) return [marker.trimEnd()];
  const pad = " ".repeat(marker.length);
  return [`${marker}${lines[0]}`, ...lines.slice(1).map((line) => `${pad}${line}`)];
}

/** A block written fresh, without its container indentation. */
export function blockLines(block: Block, ordinal?: number): string[] {
  switch (block.type) {
    case "paragraph":
      return textLines(block.runs);
    case "heading": {
      const text = serializeInline(block.runs)
        .replace(/[ \t]*\n[ \t]*/g, " ")
        .trim()
        .replace(/#+$/, (hashes) => `\\${hashes}`);
      const level = Math.min(6, Math.max(1, block.level ?? 1));
      return [`${"#".repeat(level)}${text ? ` ${text}` : ""}`];
    }
    case "bulleted":
      return itemLines("- ", block.runs);
    case "numbered":
      return itemLines(`${ordinal ?? block.start ?? 1}. `, block.runs);
    case "todo": {
      const lines = itemLines(`- [${block.checked ? "x" : " "}] `, block.runs);
      // Continuation lines align under the checkbox, where the item's text begins.
      return lines.map((line, n) => (n === 0 ? line : line.slice(4)));
    }
    case "quote":
      return quoteLines(block.runs);
    case "callout":
      return [`> [!${(block.kind ?? "note").toUpperCase()}]`, ...(plainText(block.runs) ? quoteLines(block.runs) : [])];
    case "toggle": {
      const summary = serializeInline(block.runs).replace(/[ \t]*\n[ \t]*/g, " ").trim();
      return ["<details>", `<summary>${summary}</summary>`];
    }
    case "code":
      return codeFence(block.text, block.lang ?? "");
    case "divider":
      return ["---"];
    case "image":
      return [imageLine(block)];
    case "table":
    case "raw":
      return block.text === "" ? [] : block.text.split("\n");
  }
}

/** The column a list item's children start at, read off its first written line. */
function childColumn(firstLine: string): number {
  const text = firstLine.endsWith("\r") ? firstLine.slice(0, -1) : firstLine;
  const col = leadingColumns(text);
  const item = matchListItem(stripColumns(text, col), col);
  return item ? col + item.width : col + 2;
}

type Emitted = {
  /** The source segment index just written, if it came from the source. */
  index: number | undefined;
  unchanged: boolean;
  listItem: boolean;
};

function hasBlankLine(gap: string): boolean {
  return (gap.match(/\n/g) ?? []).length >= 2;
}

/** Write blocks back as Markdown: unedited blocks verbatim, edited ones fresh. */
export function serializeDoc(doc: NoteDoc): string {
  const { blocks } = doc;
  const ordinals = listOrdinals(blocks);
  let out = "";
  let prev: Emitted | null = null;
  let firstIndex: number | undefined;
  let emittedAny = false;

  const gapBefore = (
    origin: { index: number; gap: string } | undefined,
    unchanged: boolean,
    canonical: string,
  ): string => {
    if (!prev) return "";
    if (origin && prev.index !== undefined && origin.index === prev.index + 1) {
      if ((prev.unchanged && unchanged) || hasBlankLine(origin.gap) || canonical === "\n") {
        return origin.gap;
      }
    }
    return canonical;
  };

  const write = (lines: string[], gap: string, emitted: Emitted) => {
    if (!emittedAny) firstIndex = emitted.index;
    out += (emittedAny ? gap : "") + lines.join("\n");
    emittedAny = true;
    prev = emitted;
  };

  const emitRange = (from: number, to: number, indent: number) => {
    let i = from;
    while (i < to) {
      const block = blocks[i];
      const end = Math.min(subtreeEnd(blocks, i), to);
      const ordinal = ordinals[i];
      const unchanged = isUnchanged(block, ordinal);
      const origin = block.origin;
      let lines: string[];
      if (unchanged && origin) {
        lines = origin.indent === indent ? origin.lines : reindent(origin.lines, origin.indent, indent);
      } else {
        lines = blockLines(block, ordinal).map((line) => (line === "" ? "" : `${" ".repeat(indent)}${line}`));
      }
      const listItem = isListItem(block);
      if (lines.length > 0) {
        const previous = prev as Emitted | null;
        // A numbered list that doesn't start at 1 can't interrupt the item
        // before it, so it needs a blank line to start; other list items
        // follow each other tightly.
        const startsList = block.type === "numbered" && !continuesNumbering(blocks, i);
        const canonical =
          previous && previous.listItem && listItem && !startsList ? "\n" : "\n\n";
        write(lines, gapBefore(origin, unchanged, canonical), {
          index: origin?.index,
          unchanged,
          listItem,
        });
      }
      const childIndent = listItem && lines.length > 0 ? childColumn(lines[0]) : indent;
      emitRange(i + 1, end, childIndent);
      if (block.type === "toggle") {
        const close = origin?.close;
        const closeUnchanged = unchanged && close !== undefined;
        let closeLines = [`${" ".repeat(indent)}</details>`];
        if (closeUnchanged && close && origin) {
          closeLines = origin.indent === indent ? close.lines : reindent(close.lines, origin.indent, indent);
        }
        write(closeLines, gapBefore(close, closeUnchanged, "\n\n"), {
          index: close?.index,
          unchanged: closeUnchanged,
          listItem: false,
        });
      }
      i = end;
    }
  };

  emitRange(0, blocks.length, 0);
  if (!emittedAny) return doc.leading + doc.trailing;
  const last = prev as Emitted | null;
  const leading = firstIndex === 0 ? doc.leading : "";
  const trailing = last && last.index === doc.segments - 1 ? doc.trailing : "";
  return leading + out + trailing;
}

/** Blocks written as Markdown on their own — for copying a selection. */
export function blocksToMarkdown(blocks: readonly Block[]): string {
  const minDepth = blocks.reduce((m, b) => Math.min(m, b.depth), Infinity);
  const shifted = blocks.map((b) => {
    const copy: Block = { ...b, depth: b.depth - (Number.isFinite(minDepth) ? minDepth : 0) };
    delete copy.origin;
    return copy;
  });
  return serializeDoc({ blocks: shifted, leading: "", trailing: "", segments: 0 });
}

/** Plain text of a block, for previews and search. */
export function blockPlainText(block: Block): string {
  if (isRichText(block.type)) return plainText(block.runs);
  if (block.type === "image") return block.alt ?? "";
  return block.text;
}

export { textRuns };
