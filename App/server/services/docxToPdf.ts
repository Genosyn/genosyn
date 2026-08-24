import { DocxError, DocxPackage, DOCUMENT_PART } from "./docxPackage.js";
import { symbolCharacter } from "./docxModel.js";
import { decodeXmlText, escapeXmlText, firstChild, parseXml, type XmlNode } from "./docxXml.js";
import { htmlToPdf } from "./htmlToPdf.js";

/**
 * Word document → PDF, rendered in the Chromium the app already ships.
 *
 * ## Why this exists
 *
 * Everything downstream of a contract wants a PDF. Document signing takes a
 * PDF Resource and nothing else; `read_pdf_layout` / `overlay_pdf_text` work
 * on pages, not on WordprocessingML. So an NDA that arrives as a `.docx` —
 * which is how most of them arrive — used to stop the employee dead: it could
 * read the document, quote it, even edit it, and still had to ask a human to
 * open Word and press "Save as PDF" before any of the rest of the work could
 * start.
 *
 * ## Why not LibreOffice
 *
 * A headless LibreOffice is the highest-fidelity converter there is, and it
 * costs roughly half a gigabyte of image for one feature. Chromium is already
 * in the image, already renders the invoice and estimate PDFs, and already
 * has the font set. So this module maps WordprocessingML onto the HTML that
 * Chromium prints: styles, runs, lists, tables, images, page geometry.
 *
 * ## What that means for the result
 *
 * The output is a faithful *rendition*, not a byte-level reproduction. Word's
 * own line-breaking, hyphenation and widow control are not Chromium's, so
 * pagination can differ; fields that Word computes at open time (page numbers,
 * a table of contents, cross-references) render with the value last saved into
 * the file. Anything this module knowingly could not carry across comes back
 * in `warnings` rather than being dropped in silence — a converted contract
 * whose header disappeared should say so, because someone is about to sign it.
 */

/** A caller-fixable problem: the file is not a document we can render. */
export class DocxRenderError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "DocxRenderError";
    this.status = status;
  }
}

export type DocxRendition = {
  html: string;
  warnings: string[];
  paragraphCount: number;
  tableCount: number;
  imageCount: number;
  /** Page geometry read off `w:sectPr`, in CSS units. */
  page: { width: string; height: string; margin: DocxMargins };
};

export type DocxPdfResult = Omit<DocxRendition, "html"> & { bytes: Buffer };

type DocxMargins = { top: string; right: string; bottom: string; left: string };

/**
 * Ceiling on the embedded artwork one document may inline.
 *
 * Images become base64 in the HTML string, which costs a third again on top
 * of the bytes and is then held in memory twice while Chromium parses it. A
 * document over this budget still renders; the images past it are replaced
 * with a placeholder and named in `warnings`.
 */
const MAX_EMBEDDED_IMAGE_BYTES = 12 * 1024 * 1024;

/** Word measures most things in twentieths of a point. */
const TWIPS_PER_INCH = 1440;
/** …and drawing extents in English Metric Units. */
const EMU_PER_PIXEL = 9525;

const DEFAULT_PAGE: { width: string; height: string; margin: DocxMargins } = {
  // A4 portrait with Word's one-inch default margins.
  width: "8.27in",
  height: "11.69in",
  margin: { top: "1in", right: "1in", bottom: "1in", left: "1in" },
};

/**
 * Font stacks for the faces Word documents actually name.
 *
 * The container has Chrome's own font set — the Liberation family, DejaVu and
 * Noto — and none of the Microsoft faces. Mapping each named face onto its
 * metric-compatible substitute keeps line lengths close to the original;
 * falling through to a bare `serif` would not.
 */
const FONT_SUBSTITUTES: Record<string, string> = {
  "times new roman": '"Liberation Serif", "Times New Roman", Times, serif',
  cambria: '"Liberation Serif", Cambria, Georgia, serif',
  georgia: 'Georgia, "Liberation Serif", serif',
  garamond: 'Garamond, "Liberation Serif", serif',
  "book antiqua": '"Liberation Serif", "Book Antiqua", Palatino, serif',
  arial: '"Liberation Sans", Arial, Helvetica, sans-serif',
  helvetica: '"Liberation Sans", Helvetica, Arial, sans-serif',
  calibri: '"Carlito", Calibri, "Liberation Sans", Arial, sans-serif',
  verdana: '"DejaVu Sans", Verdana, "Liberation Sans", sans-serif',
  tahoma: '"DejaVu Sans", Tahoma, "Liberation Sans", sans-serif',
  "segoe ui": '"Liberation Sans", "Segoe UI", Arial, sans-serif',
  "courier new": '"Liberation Mono", "Courier New", Courier, monospace',
  consolas: '"Liberation Mono", Consolas, monospace',
};

const DEFAULT_FONT_STACK = '"Liberation Serif", "Times New Roman", Times, serif';

function fontStackFor(name: string | null | undefined): string | null {
  if (!name) return null;
  const mapped = FONT_SUBSTITUTES[name.trim().toLowerCase()];
  if (mapped) return mapped;
  // An unknown face still names itself first: a host that happens to have it
  // installed should use it, and everything else falls through the stack.
  return `"${name.replace(/["\\]/g, "")}", ${DEFAULT_FONT_STACK}`;
}

function twipsToIn(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n / TWIPS_PER_INCH;
}

function twipsToPt(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n / 20;
}

/** `w:val` on a toggle: absent means on, `0` / `false` means off. */
function toggleOn(properties: XmlNode | undefined, name: string): boolean {
  if (!properties) return false;
  const node = firstChild(properties, name);
  if (!node) return false;
  const value = node.attrs["w:val"];
  return value !== "0" && value !== "false" && value !== "off";
}

function cssColor(raw: string | undefined): string | null {
  if (!raw || raw.toLowerCase() === "auto") return null;
  if (/^[0-9a-f]{6}$/i.test(raw)) return `#${raw.toLowerCase()}`;
  return null;
}

// ───────────────────────── package-level reading ─────────────────────────

type StyleInfo = {
  /** 1–6 when the style is a heading, else null. */
  headingLevel: number | null;
  isTitle: boolean;
  isSubtitle: boolean;
  isQuote: boolean;
  name: string;
};

type NumberingInfo = {
  /** `bullet` or a numeric format name, keyed by `${numId}:${level}`. */
  formats: Map<string, string>;
};

function readStyles(source: string | null): {
  byId: Map<string, StyleInfo>;
  defaultFont: string | null;
  defaultSizePt: number | null;
} {
  const byId = new Map<string, StyleInfo>();
  let defaultFont: string | null = null;
  let defaultSizePt: number | null = null;
  if (!source) return { byId, defaultFont, defaultSizePt };

  let root: XmlNode;
  try {
    root = parseXml(source);
  } catch {
    return { byId, defaultFont, defaultSizePt };
  }

  const docDefaults = firstChild(root, "w:docDefaults");
  const runDefaults = docDefaults ? firstChild(docDefaults, "w:rPrDefault") : undefined;
  const defaultRunProperties = runDefaults ? firstChild(runDefaults, "w:rPr") : undefined;
  if (defaultRunProperties) {
    defaultFont = firstChild(defaultRunProperties, "w:rFonts")?.attrs["w:ascii"] ?? null;
    const halfPoints = Number(firstChild(defaultRunProperties, "w:sz")?.attrs["w:val"] ?? "");
    if (Number.isFinite(halfPoints) && halfPoints > 0) defaultSizePt = halfPoints / 2;
  }

  for (const style of root.children) {
    if (style.name !== "w:style") continue;
    const id = style.attrs["w:styleId"];
    if (!id) continue;
    const name = firstChild(style, "w:name")?.attrs["w:val"] ?? id;
    const normalized = name.trim().toLowerCase();
    // Both spellings occur: the style *name* is "heading 1", the id is
    // "Heading1", and documents from other producers use only one of them.
    const byName = normalized.match(/^heading\s*([1-9])$/);
    const byIdMatch = id.match(/^Heading([1-9])$/i);
    const level = byName ? Number(byName[1]) : byIdMatch ? Number(byIdMatch[1]) : null;
    byId.set(id, {
      name,
      headingLevel: level && level <= 6 ? level : null,
      isTitle: normalized === "title",
      isSubtitle: normalized === "subtitle",
      isQuote: normalized === "quote" || normalized === "intense quote",
    });
  }
  return { byId, defaultFont, defaultSizePt };
}

/**
 * Word's numbering formats, mapped onto the CSS counter styles that print the
 * same markers. A contract's clauses are numbered 1., then a., then i. — a
 * renderer that made every level decimal would renumber the agreement.
 */
const LIST_STYLE_BY_FORMAT: Record<string, string> = {
  decimal: "decimal",
  decimalZero: "decimal-leading-zero",
  lowerLetter: "lower-alpha",
  upperLetter: "upper-alpha",
  lowerRoman: "lower-roman",
  upperRoman: "upper-roman",
  ordinal: "decimal",
  cardinalText: "decimal",
  ordinalText: "decimal",
};

function readNumbering(source: string | null): NumberingInfo {
  const formats = new Map<string, string>();
  if (!source) return { formats };
  let root: XmlNode;
  try {
    root = parseXml(source);
  } catch {
    return { formats };
  }

  const abstractFormats = new Map<string, Map<string, string>>();
  for (const abstract of root.children) {
    if (abstract.name !== "w:abstractNum") continue;
    const abstractId = abstract.attrs["w:abstractNumId"];
    if (!abstractId) continue;
    const levels = new Map<string, string>();
    for (const level of abstract.children) {
      if (level.name !== "w:lvl") continue;
      const ilvl = level.attrs["w:ilvl"] ?? "0";
      levels.set(ilvl, firstChild(level, "w:numFmt")?.attrs["w:val"] ?? "bullet");
    }
    abstractFormats.set(abstractId, levels);
  }

  for (const num of root.children) {
    if (num.name !== "w:num") continue;
    const numId = num.attrs["w:numId"];
    const abstractId = firstChild(num, "w:abstractNumId")?.attrs["w:val"];
    if (!numId || !abstractId) continue;
    const levels = abstractFormats.get(abstractId);
    if (!levels) continue;
    for (const [ilvl, format] of levels) formats.set(`${numId}:${ilvl}`, format);
  }
  return { formats };
}

/** Relationship id → target, for the images and hyperlinks a part references. */
function readRelationships(
  source: string | null,
): Map<string, { target: string; external: boolean }> {
  const out = new Map<string, { target: string; external: boolean }>();
  if (!source) return out;
  let root: XmlNode;
  try {
    root = parseXml(source);
  } catch {
    return out;
  }
  for (const rel of root.children) {
    if (rel.local !== "Relationship") continue;
    const id = rel.attrs.Id;
    const target = rel.attrs.Target;
    if (!id || !target) continue;
    out.set(id, { target, external: (rel.attrs.TargetMode ?? "") === "External" });
  }
  return out;
}

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

// ───────────────────────────── the renderer ─────────────────────────────

type RenderContext = {
  source: string;
  styles: Map<string, StyleInfo>;
  numbering: NumberingInfo;
  relationships: Map<string, { target: string; external: boolean }>;
  media: Map<string, string>;
  warnings: Set<string>;
  counts: { paragraphs: number; tables: number; images: number };
};

/**
 * The children of a node with every `w:sdt` opened out.
 *
 * A content control is a container in more places than a reader expects:
 * Word wraps whole rows, whole cells and runs of block content in one. A
 * renderer that treated `w:sdt` as an unknown element would drop the answer
 * boxes on a form and the rows of a repeating table — the parts of the
 * document most likely to matter.
 */
function contentChildren(node: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (const child of node.children) {
    if (child.name === "w:sdt") {
      const content = firstChild(child, "w:sdtContent");
      if (content) out.push(...contentChildren(content));
      continue;
    }
    out.push(child);
  }
  return out;
}

function runStyleFor(properties: XmlNode | undefined): string {
  if (!properties) return "";
  const declarations: string[] = [];
  if (toggleOn(properties, "w:b")) declarations.push("font-weight:700");
  if (toggleOn(properties, "w:i")) declarations.push("font-style:italic");

  const underline = firstChild(properties, "w:u")?.attrs["w:val"];
  const struck = toggleOn(properties, "w:strike") || toggleOn(properties, "w:dstrike");
  const decorations: string[] = [];
  if (underline && underline !== "none") decorations.push("underline");
  if (struck) decorations.push("line-through");
  if (decorations.length > 0) declarations.push(`text-decoration:${decorations.join(" ")}`);

  if (toggleOn(properties, "w:caps")) declarations.push("text-transform:uppercase");
  if (toggleOn(properties, "w:smallCaps")) declarations.push("font-variant:small-caps");

  const color = cssColor(firstChild(properties, "w:color")?.attrs["w:val"]);
  if (color) declarations.push(`color:${color}`);

  const highlight = firstChild(properties, "w:highlight")?.attrs["w:val"];
  if (highlight && highlight !== "none") declarations.push(`background-color:${highlight}`);
  const shading = cssColor(firstChild(properties, "w:shd")?.attrs["w:fill"]);
  if (shading) declarations.push(`background-color:${shading}`);

  const halfPoints = Number(firstChild(properties, "w:sz")?.attrs["w:val"] ?? "");
  if (Number.isFinite(halfPoints) && halfPoints > 0) {
    declarations.push(`font-size:${halfPoints / 2}pt`);
  }

  const face = fontStackFor(firstChild(properties, "w:rFonts")?.attrs["w:ascii"]);
  if (face) declarations.push(`font-family:${face}`);

  const vertical = firstChild(properties, "w:vertAlign")?.attrs["w:val"];
  if (vertical === "superscript") declarations.push("vertical-align:super;font-size:0.75em");
  if (vertical === "subscript") declarations.push("vertical-align:sub;font-size:0.75em");

  return declarations.join(";");
}

function imageHtml(context: RenderContext, node: XmlNode): string {
  // Both the modern DrawingML shape and the legacy VML one point at a
  // relationship id; which element carries it is the only difference.
  const blip =
    findDescendant(node, (n) => n.local === "blip") ??
    findDescendant(node, (n) => n.local === "imagedata");
  const relationshipId = blip?.attrs["r:embed"] ?? blip?.attrs["r:id"];
  if (!relationshipId) return "";
  const dataUri = context.media.get(relationshipId);
  if (!dataUri) {
    context.warnings.add("An embedded image could not be read and was left out.");
    return "";
  }

  const extent = findDescendant(node, (n) => n.local === "extent");
  const cx = Number(extent?.attrs.cx ?? "");
  const cy = Number(extent?.attrs.cy ?? "");
  const style: string[] = ["max-width:100%"];
  if (Number.isFinite(cx) && cx > 0) style.push(`width:${Math.round(cx / EMU_PER_PIXEL)}px`);
  if (Number.isFinite(cy) && cy > 0) style.push(`height:auto`);

  const description =
    findDescendant(node, (n) => n.local === "docPr")?.attrs.descr ??
    findDescendant(node, (n) => n.local === "docPr")?.attrs.name ??
    "";
  context.counts.images += 1;
  return `<img src="${dataUri}" alt="${escapeXmlText(description)}" style="${style.join(";")}" />`;
}

function findDescendant(node: XmlNode, predicate: (n: XmlNode) => boolean): XmlNode | undefined {
  for (const child of node.children) {
    if (predicate(child)) return child;
    const nested = findDescendant(child, predicate);
    if (nested) return nested;
  }
  return undefined;
}

/** True when this paragraph should start a new printed page. */
type InlineResult = { html: string; pageBreak: boolean };

function renderInline(context: RenderContext, node: XmlNode): InlineResult {
  const pieces: string[] = [];
  let pageBreak = false;

  const walkRun = (run: XmlNode, style: string) => {
    const open = style ? `<span style="${style}">` : "";
    const close = style ? "</span>" : "";
    const inner: string[] = [];
    for (const child of run.children) {
      switch (child.name) {
        case "w:rPr":
          break;
        case "w:t":
          inner.push(
            escapeXmlText(
              child.selfClosing
                ? ""
                : decodeXmlText(context.source.slice(child.innerStart, child.innerEnd)),
            ),
          );
          break;
        case "w:tab":
          inner.push('<span class="tab"></span>');
          break;
        case "w:br":
          if ((child.attrs["w:type"] ?? "") === "page") pageBreak = true;
          else inner.push("<br />");
          break;
        case "w:cr":
          inner.push("<br />");
          break;
        case "w:noBreakHyphen":
          inner.push("&#8209;");
          break;
        case "w:softHyphen":
          break;
        case "w:sym":
          inner.push(
            escapeXmlText(
              symbolCharacter(child.attrs["w:font"] ?? "", child.attrs["w:char"] ?? ""),
            ),
          );
          break;
        case "w:drawing":
        case "w:pict":
        case "w:object":
          inner.push(imageHtml(context, child));
          break;
        case "w:footnoteReference":
        case "w:endnoteReference":
          context.warnings.add("Footnote and endnote markers are rendered without their notes.");
          break;
        default:
          break;
      }
    }
    if (inner.length > 0) pieces.push(`${open}${inner.join("")}${close}`);
  };

  const walk = (parent: XmlNode) => {
    for (const child of contentChildren(parent)) {
      switch (child.name) {
        case "w:pPr":
          break;
        case "w:r":
          walkRun(child, runStyleFor(firstChild(child, "w:rPr")));
          break;
        case "w:hyperlink": {
          const relationshipId = child.attrs["r:id"];
          const target = relationshipId ? context.relationships.get(relationshipId) : undefined;
          const anchor = child.attrs["w:anchor"];
          const href = target?.target ?? (anchor ? `#${anchor}` : "");
          const nested = renderInline(context, child);
          if (nested.pageBreak) pageBreak = true;
          if (!nested.html) break;
          pieces.push(href ? `<a href="${escapeXmlText(href)}">${nested.html}</a>` : nested.html);
          break;
        }
        case "w:ins": {
          // A revision the author accepted in spirit but never resolved in the
          // file still shows in Word as ordinary text, so it renders as one.
          const nested = renderInline(context, child);
          if (nested.pageBreak) pageBreak = true;
          if (nested.html) pieces.push(nested.html);
          context.warnings.add(
            "The document has tracked changes; insertions are rendered as accepted and deletions are left out.",
          );
          break;
        }
        case "w:del":
          context.warnings.add(
            "The document has tracked changes; insertions are rendered as accepted and deletions are left out.",
          );
          break;
        case "w:bookmarkStart":
        case "w:bookmarkEnd":
        case "w:proofErr":
        case "w:commentRangeStart":
        case "w:commentRangeEnd":
          break;
        default: {
          if (child.children.length === 0) break;
          const nested = renderInline(context, child);
          if (nested.pageBreak) pageBreak = true;
          if (nested.html) pieces.push(nested.html);
        }
      }
    }
  };

  walk(node);
  return { html: pieces.join(""), pageBreak };
}

type ListRun = { numId: string; level: number; ordered: boolean; marker: string | null };

type ParagraphRender = {
  html: string;
  list: ListRun | null;
};

function renderParagraph(context: RenderContext, paragraph: XmlNode): ParagraphRender {
  context.counts.paragraphs += 1;
  const properties = firstChild(paragraph, "w:pPr");
  const styleId = properties ? firstChild(properties, "w:pStyle")?.attrs["w:val"] : undefined;
  const style = styleId ? context.styles.get(styleId) : undefined;

  const declarations: string[] = [];
  const alignment = properties ? firstChild(properties, "w:jc")?.attrs["w:val"] : undefined;
  if (alignment) {
    const mapped =
      alignment === "both" || alignment === "distribute"
        ? "justify"
        : alignment === "end"
          ? "right"
          : alignment === "start"
            ? "left"
            : alignment;
    if (["left", "right", "center", "justify"].includes(mapped)) {
      declarations.push(`text-align:${mapped}`);
    }
  }

  const spacing = properties ? firstChild(properties, "w:spacing") : undefined;
  const before = twipsToPt(spacing?.attrs["w:before"]);
  const after = twipsToPt(spacing?.attrs["w:after"]);
  if (before !== null) declarations.push(`margin-top:${before}pt`);
  if (after !== null) declarations.push(`margin-bottom:${after}pt`);
  const lineRule = spacing?.attrs["w:lineRule"];
  const line = Number(spacing?.attrs["w:line"] ?? "");
  if (Number.isFinite(line) && line > 0) {
    if (lineRule === "auto") declarations.push(`line-height:${(line / 240).toFixed(3)}`);
    else declarations.push(`line-height:${line / 20}pt`);
  }

  const indent = properties ? firstChild(properties, "w:ind") : undefined;
  const leftIn = twipsToIn(indent?.attrs["w:left"] ?? indent?.attrs["w:start"]);
  const rightIn = twipsToIn(indent?.attrs["w:right"] ?? indent?.attrs["w:end"]);
  const firstLineIn = twipsToIn(indent?.attrs["w:firstLine"]);
  const hangingIn = twipsToIn(indent?.attrs["w:hanging"]);
  if (leftIn !== null) declarations.push(`margin-left:${leftIn.toFixed(3)}in`);
  if (rightIn !== null) declarations.push(`margin-right:${rightIn.toFixed(3)}in`);
  if (firstLineIn !== null) declarations.push(`text-indent:${firstLineIn.toFixed(3)}in`);
  if (hangingIn !== null) declarations.push(`text-indent:-${hangingIn.toFixed(3)}in`);

  // Paragraph-level run properties apply to the marker and to any run that
  // did not override them; putting them on the block gets both.
  const paragraphRunStyle = properties ? runStyleFor(firstChild(properties, "w:rPr")) : "";
  if (paragraphRunStyle) declarations.push(paragraphRunStyle);

  const inline = renderInline(context, paragraph);
  const pageBreakBefore = (properties ? toggleOn(properties, "w:pageBreakBefore") : false) || false;
  if (pageBreakBefore) declarations.push("break-before:page");
  if (inline.pageBreak) declarations.push("break-after:page");

  const numbering = properties ? firstChild(properties, "w:numPr") : undefined;
  const numId = numbering ? firstChild(numbering, "w:numId")?.attrs["w:val"] : undefined;
  const levelRaw = numbering ? firstChild(numbering, "w:ilvl")?.attrs["w:val"] : undefined;
  const level = Number(levelRaw ?? "0");
  const format = context.numbering.formats.get(`${numId}:${levelRaw ?? "0"}`) ?? "bullet";
  const list: ListRun | null =
    numId && numId !== "0"
      ? {
          numId,
          level: Number.isFinite(level) ? level : 0,
          ordered: format !== "bullet" && format !== "none",
          marker: LIST_STYLE_BY_FORMAT[format] ?? null,
        }
      : null;

  const styleAttribute = declarations.length > 0 ? ` style="${declarations.join(";")}"` : "";
  // An empty paragraph is a blank line the author put there on purpose, and a
  // contract's spacing is part of how it reads — so it keeps its height.
  const body = inline.html || "&#160;";

  if (list) {
    return { html: `<li${styleAttribute}>${body}</li>`, list };
  }
  if (style?.headingLevel) {
    const tag = `h${style.headingLevel}`;
    return { html: `<${tag}${styleAttribute}>${body}</${tag}>`, list: null };
  }
  if (style?.isTitle) {
    return { html: `<h1 class="doc-title"${styleAttribute}>${body}</h1>`, list: null };
  }
  if (style?.isSubtitle) {
    return { html: `<p class="doc-subtitle"${styleAttribute}>${body}</p>`, list: null };
  }
  if (style?.isQuote) {
    return { html: `<blockquote${styleAttribute}>${body}</blockquote>`, list: null };
  }
  return { html: `<p${styleAttribute}>${body}</p>`, list: null };
}

function tableHasBorders(table: XmlNode, context: RenderContext): boolean {
  const properties = firstChild(table, "w:tblPr");
  if (!properties) return false;
  const borders = firstChild(properties, "w:tblBorders");
  if (borders) {
    return borders.children.some((edge) => {
      const value = edge.attrs["w:val"];
      return value !== undefined && value !== "none" && value !== "nil";
    });
  }
  // No explicit borders means they come from the table style, which we do not
  // resolve. "Table Grid" is Word's default gridded style and by far the most
  // common on a form or a schedule, so it is worth recognising by name.
  const styleId = firstChild(properties, "w:tblStyle")?.attrs["w:val"] ?? "";
  const styleName = context.styles.get(styleId)?.name ?? styleId;
  return /grid/i.test(styleName);
}

function renderTable(context: RenderContext, table: XmlNode): string {
  context.counts.tables += 1;
  const bordered = tableHasBorders(table, context);
  const rows: string[] = [];

  for (const row of contentChildren(table)) {
    if (row.name !== "w:tr") continue;
    const rowProperties = firstChild(row, "w:trPr");
    const header = rowProperties ? toggleOn(rowProperties, "w:tblHeader") : false;
    const cells: string[] = [];

    for (const cell of contentChildren(row)) {
      if (cell.name !== "w:tc") continue;
      const cellProperties = firstChild(cell, "w:tcPr");
      const span = Number(
        cellProperties ? (firstChild(cellProperties, "w:gridSpan")?.attrs["w:val"] ?? "1") : "1",
      );
      const declarations: string[] = [];
      const fill = cssColor(
        cellProperties ? firstChild(cellProperties, "w:shd")?.attrs["w:fill"] : undefined,
      );
      if (fill) declarations.push(`background-color:${fill}`);
      const verticalAlign = cellProperties
        ? firstChild(cellProperties, "w:vAlign")?.attrs["w:val"]
        : undefined;
      if (verticalAlign === "center") declarations.push("vertical-align:middle");
      if (verticalAlign === "bottom") declarations.push("vertical-align:bottom");
      const widthNode = cellProperties ? firstChild(cellProperties, "w:tcW") : undefined;
      if (widthNode?.attrs["w:type"] === "dxa") {
        const inches = twipsToIn(widthNode.attrs["w:w"]);
        if (inches !== null && inches > 0) declarations.push(`width:${inches.toFixed(3)}in`);
      } else if (widthNode?.attrs["w:type"] === "pct") {
        const percent = Number(widthNode.attrs["w:w"] ?? "");
        if (Number.isFinite(percent) && percent > 0) {
          declarations.push(`width:${(percent / 50).toFixed(2)}%`);
        }
      }

      const tag = header ? "th" : "td";
      const attributes = [
        span > 1 ? ` colspan="${span}"` : "",
        declarations.length > 0 ? ` style="${declarations.join(";")}"` : "",
      ].join("");
      cells.push(`<${tag}${attributes}>${renderBlocks(context, cell)}</${tag}>`);
    }
    if (cells.length > 0) rows.push(`<tr>${cells.join("")}</tr>`);
  }

  const className = bordered ? ' class="bordered"' : "";
  return `<table${className}>${rows.join("")}</table>`;
}

/**
 * Render the block children of a container — the body, a table cell, a
 * content control — grouping consecutive numbered paragraphs into real lists
 * so nesting and markers survive.
 */
function renderBlocks(context: RenderContext, container: XmlNode): string {
  const out: string[] = [];
  const openLists: ListRun[] = [];

  const closeTo = (depth: number) => {
    while (openLists.length > depth) {
      const closed = openLists.pop()!;
      out.push(closed.ordered ? "</ol>" : "</ul>");
    }
  };

  for (const child of contentChildren(container)) {
    if (child.name === "w:tbl") {
      closeTo(0);
      out.push(renderTable(context, child));
      continue;
    }
    if (child.name !== "w:p") continue;

    const rendered = renderParagraph(context, child);
    if (!rendered.list) {
      closeTo(0);
      out.push(rendered.html);
      continue;
    }

    const wanted = rendered.list.level + 1;
    // A different numbering definition at the same depth is a different list,
    // so it closes the old one rather than continuing it with new markers.
    if (
      openLists.length > 0 &&
      openLists.length === wanted &&
      openLists[openLists.length - 1].numId !== rendered.list.numId
    ) {
      closeTo(wanted - 1);
    }
    if (openLists.length > wanted) closeTo(wanted);
    while (openLists.length < wanted) {
      openLists.push(rendered.list);
      const marker = rendered.list.marker ? ` style="list-style-type:${rendered.list.marker}"` : "";
      out.push(rendered.list.ordered ? `<ol${marker}>` : "<ul>");
    }
    out.push(rendered.html);
  }

  closeTo(0);
  return out.join("\n");
}

function readPageGeometry(body: XmlNode): {
  width: string;
  height: string;
  margin: DocxMargins;
} {
  const section = body.children.find((child) => child.name === "w:sectPr");
  if (!section) return DEFAULT_PAGE;

  const size = firstChild(section, "w:pgSz");
  let widthIn = twipsToIn(size?.attrs["w:w"]);
  let heightIn = twipsToIn(size?.attrs["w:h"]);
  if (widthIn === null || heightIn === null || widthIn <= 0 || heightIn <= 0) {
    widthIn = null;
    heightIn = null;
  }
  // `w:orient="landscape"` comes with w/h already swapped in well-formed
  // documents; the guard is for the producers that forget.
  if (widthIn !== null && heightIn !== null && size?.attrs["w:orient"] === "landscape") {
    if (heightIn > widthIn) [widthIn, heightIn] = [heightIn, widthIn];
  }

  const margins = firstChild(section, "w:pgMar");
  const edge = (name: string, fallback: string): string => {
    const inches = twipsToIn(margins?.attrs[name]);
    // Word stores a negative margin for content that bleeds off the page;
    // Chromium refuses one, so it clamps rather than failing the render.
    if (inches === null || inches < 0) return fallback;
    return `${inches.toFixed(3)}in`;
  };

  return {
    width: widthIn !== null ? `${widthIn.toFixed(3)}in` : DEFAULT_PAGE.width,
    height: heightIn !== null ? `${heightIn.toFixed(3)}in` : DEFAULT_PAGE.height,
    margin: {
      top: edge("w:top", DEFAULT_PAGE.margin.top),
      right: edge("w:right", DEFAULT_PAGE.margin.right),
      bottom: edge("w:bottom", DEFAULT_PAGE.margin.bottom),
      left: edge("w:left", DEFAULT_PAGE.margin.left),
    },
  };
}

/**
 * Inline every image the body references as a `data:` URI.
 *
 * Chromium never leaves `setContent`, so a relative `word/media/...` path
 * would resolve to nothing. Base64 is the only way the artwork reaches the
 * page, and the budget above is what stops a document full of scans from
 * taking the process with it.
 */
async function collectMedia(
  pkg: DocxPackage,
  relationships: Map<string, { target: string; external: boolean }>,
  warnings: Set<string>,
): Promise<Map<string, string>> {
  const media = new Map<string, string>();
  let spent = 0;
  for (const [id, rel] of relationships) {
    if (rel.external) continue;
    const target = rel.target.replace(/^\.\//, "");
    if (!/^media\//i.test(target)) continue;
    const extension = target.slice(target.lastIndexOf(".")).toLowerCase();
    const mime = IMAGE_MIME_BY_EXTENSION[extension];
    if (!mime) {
      warnings.add(`An embedded ${extension || "image"} file is not a format we can render.`);
      continue;
    }
    const part = `word/${target}`;
    let bytes: Buffer | null = null;
    try {
      bytes = await pkg.binary(part);
    } catch {
      bytes = null;
    }
    if (!bytes) continue;
    if (spent + bytes.length > MAX_EMBEDDED_IMAGE_BYTES) {
      warnings.add("Some embedded images were too large to include and were left out.");
      continue;
    }
    spent += bytes.length;
    media.set(id, `data:${mime};base64,${bytes.toString("base64")}`);
  }
  return media;
}

function documentCss(
  page: { width: string; height: string; margin: DocxMargins },
  fontStack: string,
  fontSizePt: number,
): string {
  return `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  font-family: ${fontStack};
  font-size: ${fontSizePt}pt;
  line-height: 1.15;
  color: #000000;
  /* Word keeps every space an author typed; HTML would collapse them, and on
     a form that is the difference between a filled blank and a closed one. */
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
p, li, h1, h2, h3, h4, h5, h6, blockquote { margin: 0 0 0.34em; }
h1, h2, h3, h4, h5, h6 { font-weight: 700; line-height: 1.2; break-after: avoid; }
h1 { font-size: 1.6em; } h2 { font-size: 1.35em; } h3 { font-size: 1.18em; }
h4 { font-size: 1.06em; } h5 { font-size: 1em; } h6 { font-size: 0.94em; }
.doc-title { font-size: 2em; margin-bottom: 0.5em; }
.doc-subtitle { color: #444444; font-size: 1.1em; }
blockquote { margin-left: 0.5in; font-style: italic; }
ul, ol { margin: 0 0 0.34em; padding-left: 0.35in; }
li { break-inside: avoid; }
a { color: inherit; text-decoration: underline; }
img { max-width: 100%; }
.tab { display: inline-block; min-width: 0.5in; }
table { border-collapse: collapse; margin: 0.2em 0 0.4em; max-width: 100%; }
table td, table th { padding: 0.04in 0.06in; vertical-align: top; text-align: left; }
table.bordered td, table.bordered th { border: 1px solid #000000; }
th { font-weight: 700; }
tr { break-inside: avoid; }
@page {
  size: ${page.width} ${page.height};
  margin: ${page.margin.top} ${page.margin.right} ${page.margin.bottom} ${page.margin.left};
}
`.trim();
}

/**
 * Render a `.docx` to the self-contained HTML Chromium will print.
 *
 * Exported on its own because it is the half worth asserting against: a test
 * that reads the HTML can say a heading stayed a heading and a table kept its
 * columns, where a test that only had the PDF bytes could say neither.
 */
export async function docxToHtml(
  source: Buffer,
  options: { title?: string } = {},
): Promise<DocxRendition> {
  let pkg: DocxPackage;
  try {
    pkg = await DocxPackage.open(source);
  } catch (error) {
    if (error instanceof DocxError) throw new DocxRenderError(error.message, error.status);
    throw error;
  }

  const documentXml = await pkg.requireText(DOCUMENT_PART);
  let root: XmlNode;
  try {
    root = parseXml(documentXml);
  } catch (error) {
    throw new DocxRenderError(
      `Could not read ${DOCUMENT_PART}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const body = firstChild(root, "w:body");
  if (!body) throw new DocxRenderError("This document has no body to render.");

  const styles = readStyles(await pkg.text("word/styles.xml"));
  const numbering = readNumbering(await pkg.text("word/numbering.xml"));
  const relationships = readRelationships(await pkg.text("word/_rels/document.xml.rels"));
  const warnings = new Set<string>();
  const media = await collectMedia(pkg, relationships, warnings);

  const context: RenderContext = {
    source: documentXml,
    styles: styles.byId,
    numbering,
    relationships,
    media,
    warnings,
    counts: { paragraphs: 0, tables: 0, images: 0 },
  };

  const rendered = renderBlocks(context, body);
  const page = readPageGeometry(body);

  // Headers and footers repeat per printed page, which is a Word concept
  // Chromium's print pipeline has no equivalent for from `setContent`. Saying
  // so is the honest option — a converted contract that quietly lost the
  // confidentiality footer is worse than one that says the footer is gone.
  for (const part of pkg.parts) {
    if (!/^word\/(header|footer)\d*\.xml$/.test(part)) continue;
    const partXml = await pkg.text(part);
    if (!partXml) continue;
    if (!/<w:t[ >]/.test(partXml)) continue;
    warnings.add(
      "The document has running headers or footers; their text is not repeated on the converted pages.",
    );
    break;
  }

  if (context.counts.paragraphs === 0 && context.counts.tables === 0) {
    throw new DocxRenderError("This document has no readable content to convert.");
  }

  const fontStack = fontStackFor(styles.defaultFont) ?? DEFAULT_FONT_STACK;
  const fontSize = styles.defaultSizePt ?? 11;
  const title = escapeXmlText(options.title ?? "Document");
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8" />',
    `<title>${title}</title>`,
    `<style>${documentCss(page, fontStack, fontSize)}</style>`,
    "</head><body>",
    rendered,
    "</body></html>",
  ].join("\n");

  return {
    html,
    warnings: [...warnings],
    paragraphCount: context.counts.paragraphs,
    tableCount: context.counts.tables,
    imageCount: context.counts.images,
    page,
  };
}

/** Render a `.docx` to PDF bytes. */
export async function docxToPdf(
  source: Buffer,
  options: { title?: string } = {},
): Promise<DocxPdfResult> {
  const rendition = await docxToHtml(source, options);
  let bytes: Buffer;
  try {
    bytes = await htmlToPdf(rendition.html, {
      width: rendition.page.width,
      height: rendition.page.height,
      margin: rendition.page.margin,
      printBackground: true,
      // The page geometry is already expressed in `@page`, and letting the
      // stylesheet win is what keeps a landscape or legal-size original the
      // size its author chose.
      preferCSSPageSize: true,
    });
  } catch (error) {
    throw new DocxRenderError(
      `Converting the document to PDF failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      502,
    );
  }
  const { html: _html, ...rest } = rendition;
  return { ...rest, bytes };
}
