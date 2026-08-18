import { packDocx } from "./docxPackage.js";
import { escapeXmlAttr, escapeXmlText, stripXmlIllegalChars } from "./docxXml.js";

/**
 * Writing a Word document from scratch.
 *
 * The input is Markdown because that is what a language model already writes
 * well — asking one to emit WordprocessingML by hand produces a file Word
 * refuses to open, and asking it to emit base64 of a zip produces nothing at
 * all. Headings, lists, tables and emphasis map onto real Word constructs
 * (`Heading1`, a numbering definition, a `w:tbl`, `w:b`), not onto text that
 * merely looks like them, so the result is a document a human can carry on
 * editing rather than a transcript with hashes in it.
 *
 * ## Scope
 *
 * Deliberately no images, footnotes, or fields. Those belong to documents that
 * already exist, which is {@link file://./docxEdit.ts}'s job; what this needs
 * to do well is turn a report, a memo or a letter into something that opens
 * cleanly and prints correctly.
 */

export type CreateDocxOptions = {
  markdown: string;
  /** Document title, written into the file's properties. */
  title?: string;
  author?: string;
  pageSize?: "a4" | "letter";
  landscape?: boolean;
};

/**
 * Ceiling on the source Markdown.
 *
 * Kept under the Express body limit rather than above it: a bound the request
 * can never reach is not a bound, and this parser walks the source character
 * by character on the event loop, which every other request in the process is
 * waiting on.
 */
export const MAX_MARKDOWN_CHARS = 800_000;

const PAGE_SIZES = {
  // Twentieths of a point, which is the only unit `w:pgSz` speaks.
  a4: { width: 11906, height: 16838 },
  letter: { width: 12240, height: 15840 },
};

const BULLET_NUM_ID = 1;
/** Ordered lists start here; each new list gets its own id so it restarts at 1. */
const FIRST_ORDERED_NUM_ID = 2;
const MAX_ORDERED_LISTS = 64;

type Inline = {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Relationship id of an external hyperlink this run belongs to. */
  link?: string;
};

type Block =
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[]; style?: string }
  | { kind: "list"; ordered: boolean; items: { level: number; inlines: Inline[] }[] }
  | { kind: "code"; lines: string[] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "table"; rows: Inline[][][]; align: ("left" | "center" | "right")[] }
  | { kind: "rule" }
  | { kind: "pageBreak" };

/**
 * How far past a `[` the link pattern is allowed to look.
 *
 * A `[` whose closing bracket is further away than this cannot be a link, so
 * the pattern is never run for it. Without that test, 320,000 open brackets
 * followed by one close ran the bounded pattern at every one of them; with it
 * the cost is linear. The parser runs on the event loop every other request in
 * the process is waiting on, and its input is model-authored.
 */
const MAX_LINK_CHARS = 2_000;

/** Relationship targets collected while parsing, written into the rels part. */
type LinkTable = { id: string; target: string }[];

// ───────────────────────────── Inline parsing ─────────────────────────────

/**
 * Split one line of Markdown into formatted runs.
 *
 * Code spans are taken first and never reinterpreted — a backticked
 * `**literal**` has to survive as asterisks, which is exactly the case a
 * single pass of regex replacements gets wrong.
 */
function parseInlines(source: string, links: LinkTable): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  let bold = false;
  let italic = false;
  let strike = false;
  let link: string | undefined;

  const flush = () => {
    if (buffer.length === 0) return;
    out.push({ text: buffer, bold: bold || undefined, italic: italic || undefined, strike: strike || undefined, link });
    buffer = "";
  };

  let i = 0;
  // The next `]` at or after the cursor, found once and re-found only when the
  // cursor passes it. Asking `indexOf` afresh at every character is a scan to
  // end-of-line each time, which is the quadratic this parser must not have.
  let nextClose = source.indexOf("]");
  while (i < source.length) {
    if (nextClose !== -1 && nextClose < i) nextClose = source.indexOf("]", i);
    if (source[i] === "\\" && i + 1 < source.length && /[\\`*_~[\]]/.test(source[i + 1])) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }

    if (source[i] === "`") {
      let width = 1;
      while (source[i + width] === "`") width += 1;
      const fence = "`".repeat(width);
      const close = source.indexOf(fence, i + fence.length);
      if (close !== -1) {
        flush();
        out.push({ text: source.slice(i + fence.length, close), code: true, link });
        i = close + fence.length;
        continue;
      }
    }

    // Only worth attempting where a link could actually start. Running the
    // pattern at every position made this quadratic — `[` repeated 160,000
    // times took 37 seconds of a single-threaded server, and the markdown is
    // model-authored, so text an employee just read could trigger it.
    const linkMatch =
      source[i] === "[" && nextClose !== -1 && nextClose - i <= MAX_LINK_CHARS
        ? source.slice(i, i + MAX_LINK_CHARS).match(/^\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/)
        : null;
    if (linkMatch && !link) {
      flush();
      const target = linkMatch[2];
      const id = `rIdLink${links.length + 1}`;
      links.push({ id, target });
      for (const inline of parseInlines(linkMatch[1], links)) {
        out.push({ ...inline, link: id, bold: inline.bold || bold, italic: inline.italic || italic });
      }
      i += linkMatch[0].length;
      continue;
    }

    const pair = source[i] + (source[i + 1] ?? "");
    if (pair === "**" || pair === "__") {
      flush();
      bold = !bold;
      i += 2;
      continue;
    }
    if (pair === "~~") {
      flush();
      strike = !strike;
      i += 2;
      continue;
    }
    if (source[i] === "*" || source[i] === "_") {
      // A lone underscore inside a word is a word, not emphasis — `snake_case`
      // must not turn half the identifier italic.
      const insideWord =
        source[i] === "_" && /\w/.test(source[i - 1] ?? "") && /\w/.test(source[i + 1] ?? "");
      if (!insideWord) {
        flush();
        italic = !italic;
        i += 1;
        continue;
      }
    }

    buffer += source[i];
    i += 1;
  }
  flush();
  return out;
}

// ───────────────────────────── Block parsing ─────────────────────────────

const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed[i] === "\\" && trimmed[i + 1] === "|") {
      current += "|";
      i += 1;
      continue;
    }
    if (trimmed[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += trimmed[i];
  }
  cells.push(current.trim());
  return cells;
}

const PAGE_BREAK = /^\s*\\pagebreak\s*$/i;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** True when line `index` opens a block, and so cannot continue a paragraph. */
function startsNewBlock(lines: string[], index: number): boolean {
  const line = lines[index];
  if (HEADING.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  if (PAGE_BREAK.test(line)) return true;
  if (HORIZONTAL_RULE.test(line)) return true;
  if (line.trimStart().startsWith(">")) return true;
  if (/^\s*(```|~~~)/.test(line)) return true;
  // A table announces itself only on its second line, where the divider is.
  return line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]);
}

function parseBlocks(markdown: string, links: LinkTable): Block[] {
  const lines = stripXmlIllegalChars(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().length === 0) {
      i += 1;
      continue;
    }

    // Fenced code.
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const marker = fence[1][0].repeat(3);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: "code", lines: body });
      continue;
    }

    if (PAGE_BREAK.test(line)) {
      blocks.push({ kind: "pageBreak" });
      i += 1;
      continue;
    }

    if (HORIZONTAL_RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        inlines: parseInlines(heading[2].trim(), links),
      });
      i += 1;
      continue;
    }

    // A GFM table: a header row, a divider, then body rows.
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        if (left && right) return "center" as const;
        if (right) return "right" as const;
        return "left" as const;
      });
      const rows: Inline[][][] = [header.map((cell) => parseInlines(cell, links))];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim().length > 0) {
        const cells = splitTableRow(lines[i]);
        // Ragged rows are common in hand-written Markdown; pad rather than
        // dropping the row, so no content silently disappears.
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length).map((cell) => parseInlines(cell, links)));
        i += 1;
      }
      blocks.push({ kind: "table", rows, align });
      continue;
    }

    if (line.trimStart().startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith(">")) {
        parts.push(lines[i].trimStart().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ kind: "quote", inlines: parseInlines(parts.join(" ").trim(), links) });
      continue;
    }

    const listItem = line.match(LIST_ITEM);
    if (listItem) {
      const ordered = /\d/.test(listItem[2]);
      const items: { level: number; inlines: Inline[] }[] = [];
      while (i < lines.length) {
        let at = i;
        // Blank lines between steps are how people write out a procedure, and
        // they do not end the list. Ending it here would start a second
        // numbering sequence, so a source that plainly reads 1., 2., 3. would
        // come out of Word as 1., 1., 1.
        while (at < lines.length && lines[at].trim().length === 0) at += 1;
        const match = at < lines.length ? lines[at].match(LIST_ITEM) : null;
        if (!match) break;
        if (/\d/.test(match[2]) !== ordered) break;
        items.push({
          // Two spaces per level is the common convention; four also works.
          level: Math.min(8, Math.floor(match[1].replace(/\t/g, "  ").length / 2)),
          inlines: parseInlines(match[3].trim(), links),
        });
        i = at + 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // A plain paragraph: consecutive lines until a blank line or the start of
    // the next block. Every block starter the loop above recognises has to end
    // a paragraph too — a table introduced by "Here are the results:" would
    // otherwise be swallowed into that sentence and delivered as a wall of
    // pipe characters, and a `\pagebreak` after a line of prose would be
    // printed as visible garbage instead of breaking the page.
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim().length > 0) {
      if (paragraph.length > 0 && startsNewBlock(lines, i)) break;
      paragraph.push(lines[i].trim());
      i += 1;
    }
    blocks.push({ kind: "paragraph", inlines: parseInlines(paragraph.join(" "), links) });
  }

  return blocks;
}

// ───────────────────────────── Rendering ─────────────────────────────

function renderRun(inline: Inline): string {
  const properties: string[] = [];
  if (inline.bold) properties.push("<w:b/>");
  if (inline.italic) properties.push("<w:i/>");
  if (inline.strike) properties.push("<w:strike/>");
  if (inline.code) {
    properties.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
    properties.push('<w:sz w:val="20"/>');
  }
  if (inline.link) properties.push('<w:rStyle w:val="Hyperlink"/>');
  const rPr = properties.length > 0 ? `<w:rPr>${properties.join("")}</w:rPr>` : "";
  const text = inline.text.replace(/\t/g, "    ");
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`;
}

/** Group adjacent runs that share a hyperlink into one `w:hyperlink`. */
function renderInlines(inlines: Inline[]): string {
  const out: string[] = [];
  let index = 0;
  while (index < inlines.length) {
    const link = inlines[index].link;
    if (!link) {
      out.push(renderRun(inlines[index]));
      index += 1;
      continue;
    }
    const group: Inline[] = [];
    while (index < inlines.length && inlines[index].link === link) {
      group.push(inlines[index]);
      index += 1;
    }
    out.push(`<w:hyperlink r:id="${escapeXmlAttr(link)}">${group.map(renderRun).join("")}</w:hyperlink>`);
  }
  return out.join("");
}

function paragraph(inlines: Inline[], properties = ""): string {
  const pPr = properties ? `<w:pPr>${properties}</w:pPr>` : "";
  return `<w:p>${pPr}${renderInlines(inlines)}</w:p>`;
}

function renderTable(block: Extract<Block, { kind: "table" }>): string {
  const columns = block.rows[0]?.length ?? 1;
  const grid = Array.from({ length: columns }, () => `<w:gridCol w:w="${Math.floor(9360 / columns)}"/>`).join("");
  const rows = block.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, cellIndex) => {
          const alignment = block.align[cellIndex] ?? "left";
          const jc = alignment === "left" ? "" : `<w:jc w:val="${alignment}"/>`;
          const inlines = rowIndex === 0 ? cell.map((run) => ({ ...run, bold: true })) : cell;
          return (
            `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9360 / columns)}" w:type="dxa"/></w:tcPr>` +
            `${paragraph(inlines, `<w:pStyle w:val="TableText"/>${jc}`)}</w:tc>`
          );
        })
        .join("");
      // Repeat the header row when a long table breaks across pages.
      const trPr = rowIndex === 0 ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
      return `<w:tr>${trPr}${cells}</w:tr>`;
    })
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/>` +
    `<w:tblW w:w="0" w:type="auto"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" ` +
    `w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${rows}</w:tbl>` +
    // Word renders two adjacent tables as one; a spacer keeps them apart and
    // gives the cursor somewhere to land after the last row.
    `<w:p/>`
  );
}

function renderBlocks(blocks: Block[]): { xml: string; orderedNumIds: number[] } {
  const orderedNumIds: number[] = [];
  const pieces: string[] = [];

  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        pieces.push(paragraph(block.inlines, `<w:pStyle w:val="Heading${block.level}"/>`));
        break;
      case "paragraph":
        pieces.push(paragraph(block.inlines, block.style ? `<w:pStyle w:val="${block.style}"/>` : ""));
        break;
      case "quote":
        pieces.push(paragraph(block.inlines, '<w:pStyle w:val="Quote"/>'));
        break;
      case "code":
        for (const line of block.lines) {
          pieces.push(
            paragraph([{ text: line, code: true }], '<w:pStyle w:val="CodeBlock"/>'),
          );
        }
        break;
      case "rule":
        pieces.push(
          '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/>' +
            "</w:pBdr></w:pPr></w:p>",
        );
        break;
      case "pageBreak":
        pieces.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
        break;
      case "list": {
        let numId = BULLET_NUM_ID;
        if (block.ordered) {
          numId = FIRST_ORDERED_NUM_ID + orderedNumIds.length;
          if (orderedNumIds.length >= MAX_ORDERED_LISTS) {
            numId = FIRST_ORDERED_NUM_ID + MAX_ORDERED_LISTS - 1;
          } else {
            orderedNumIds.push(numId);
          }
        }
        for (const item of block.items) {
          pieces.push(
            paragraph(
              item.inlines,
              '<w:pStyle w:val="ListParagraph"/>' +
                `<w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${numId}"/></w:numPr>`,
            ),
          );
        }
        break;
      }
      case "table":
        pieces.push(renderTable(block));
        break;
    }
  }
  return { xml: pieces.join(""), orderedNumIds };
}

// ───────────────────────────── Package parts ─────────────────────────────

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const W_NAMESPACES =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'mc:Ignorable="w14"';

function contentTypes(): string {
  return (
    XML_HEADER +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    "</Types>"
  );
}

function rootRels(): string {
  return (
    XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>"
  );
}

function documentRels(links: LinkTable): string {
  const base =
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>';
  const external = links
    .map(
      (link) =>
        `<Relationship Id="${escapeXmlAttr(link.id)}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" ' +
        `Target="${escapeXmlAttr(link.target)}" TargetMode="External"/>`,
    )
    .join("");
  return (
    XML_HEADER +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    base +
    external +
    "</Relationships>"
  );
}

const HEADING_SIZES = [32, 28, 24, 22, 21, 20];

function styles(): string {
  const headings = HEADING_SIZES.map((size, index) => {
    const level = index + 1;
    return (
      `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/>` +
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
      `<w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 240 : 200}" w:after="120"/>` +
      `<w:outlineLvl w:val="${index}"/></w:pPr>` +
      `<w:rPr><w:b/><w:color w:val="1F2933"/><w:sz w:val="${size}"/></w:rPr></w:style>`
    );
  }).join("");

  return (
    XML_HEADER +
    `<w:styles ${W_NAMESPACES}>` +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/>' +
    "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>" +
    '<w:spacing w:after="140" w:line="276" w:lineRule="auto"/>' +
    "</w:pPr></w:pPrDefault></w:docDefaults>" +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    headings +
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>' +
    '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/>' +
    '<w:contextualSpacing/></w:pPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>' +
    '<w:qFormat/><w:pPr><w:ind w:left="720"/><w:pBdr>' +
    '<w:left w:val="single" w:sz="12" w:space="8" w:color="C8CDD3"/></w:pBdr></w:pPr>' +
    '<w:rPr><w:i/><w:color w:val="4A5560"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/>' +
    '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>' +
    '<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/><w:ind w:left="240" w:right="240"/></w:pPr>' +
    '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/>' +
    '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr></w:style>' +
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>' +
    '<w:rPr><w:color w:val="0B63CE"/><w:u w:val="single"/></w:rPr></w:style>' +
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>' +
    '<w:tblPr><w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="C8CDD3"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="C8CDD3"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="C8CDD3"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="C8CDD3"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="C8CDD3"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="C8CDD3"/>' +
    "</w:tblBorders></w:tblPr></w:style>" +
    "</w:styles>"
  );
}

/**
 * The bullet Word draws at each list level, and the font that carries it.
 *
 * These are the three glyphs Word itself cycles through — a filled round
 * bullet, a hollow one, then a small square — and each lives at a private-use
 * code point inside its own symbol font. Written as escapes because the
 * characters themselves are invisible in an editor and get mangled by tools
 * that assume text is UTF-8 prose.
 */
const BULLET_LEVELS: { glyph: string; font: string }[] = [
  { glyph: "\uF0B7", font: "Symbol" },
  { glyph: "o", font: "Courier New" },
  { glyph: "\uF0A7", font: "Wingdings" },
];

function numbering(orderedNumIds: number[]): string {
  const levels = (ordered: boolean) =>
    Array.from({ length: 9 }, (_, level) => {
      const indent = 720 * (level + 1);
      if (ordered) {
        const formats = ["decimal", "lowerLetter", "lowerRoman"];
        return (
          `<w:lvl w:ilvl="${level}"><w:start w:val="1"/>` +
          `<w:numFmt w:val="${formats[level % 3]}"/>` +
          `<w:lvlText w:val="%${level + 1}."/><w:lvlJc w:val="left"/>` +
          `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`
        );
      }
      const bullet = BULLET_LEVELS[level % BULLET_LEVELS.length];
      return (
        `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>` +
        `<w:lvlText w:val="${escapeXmlAttr(bullet.glyph)}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>` +
        `<w:rPr><w:rFonts w:ascii="${bullet.font}" w:hAnsi="${bullet.font}" w:hint="default"/></w:rPr></w:lvl>`
      );
    }).join("");

  // Every ordered list gets its own concrete `w:num` pointing at the same
  // abstract definition, which is how Word restarts numbering at 1 instead of
  // continuing from the previous list.
  const nums =
    `<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>` +
    orderedNumIds
      .map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/></w:num>`)
      .join("");

  return (
    XML_HEADER +
    `<w:numbering ${W_NAMESPACES}>` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>` +
    nums +
    "</w:numbering>"
  );
}

function settings(): string {
  return (
    XML_HEADER +
    `<w:settings ${W_NAMESPACES}><w:compat>` +
    '<w:compatSetting w:name="compatibilityMode" ' +
    'w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>' +
    "</w:compat></w:settings>"
  );
}

function coreProperties(title: string, author: string): string {
  // A fixed timestamp: these tools run inside a Run whose output should be
  // reproducible, and a real modification date is not information anyone uses.
  const stamp = "2020-01-01T00:00:00Z";
  return (
    XML_HEADER +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${escapeXmlText(title)}</dc:title>` +
    `<dc:creator>${escapeXmlText(author)}</dc:creator>` +
    `<cp:lastModifiedBy>${escapeXmlText(author)}</cp:lastModifiedBy>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    "</cp:coreProperties>"
  );
}

function appProperties(): string {
  return (
    XML_HEADER +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>Genosyn</Application></Properties>"
  );
}

/**
 * Build a `.docx` from Markdown.
 *
 * Every part is generated fresh, so the result opens in Word, Pages, Google
 * Docs and LibreOffice alike; nothing here depends on a template file shipping
 * alongside the server.
 */
export async function createDocx(options: CreateDocxOptions): Promise<Buffer> {
  const markdown = options.markdown ?? "";
  if (markdown.length > MAX_MARKDOWN_CHARS) {
    throw new Error(
      `The document source is ${markdown.length} characters, over the ${MAX_MARKDOWN_CHARS} limit.`,
    );
  }
  const links: LinkTable = [];
  const blocks = parseBlocks(markdown, links);
  const { xml, orderedNumIds } = renderBlocks(blocks);

  const size = PAGE_SIZES[options.pageSize ?? "a4"];
  const [width, height] = options.landscape ? [size.height, size.width] : [size.width, size.height];
  const sectPr =
    `<w:sectPr><w:pgSz w:w="${width}" w:h="${height}"` +
    `${options.landscape ? ' w:orient="landscape"' : ""}/>` +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" ' +
    'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

  // A body with no paragraph at all is invalid; an empty one is a blank page.
  const body = xml.length > 0 ? xml : "<w:p/>";

  const document =
    XML_HEADER + `<w:document ${W_NAMESPACES}><w:body>${body}${sectPr}</w:body></w:document>`;

  return packDocx({
    "[Content_Types].xml": contentTypes(),
    "_rels/.rels": rootRels(),
    "docProps/core.xml": coreProperties(options.title ?? "Document", options.author ?? "Genosyn"),
    "docProps/app.xml": appProperties(),
    "word/document.xml": document,
    "word/_rels/document.xml.rels": documentRels(links),
    "word/styles.xml": styles(),
    "word/numbering.xml": numbering(orderedNumIds),
    "word/settings.xml": settings(),
  });
}
