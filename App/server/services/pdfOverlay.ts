import { PDFDocument, PDFPage, degrees, rgb } from "pdf-lib";

import {
  PdfTextRenderer,
  assertTextEmbeddable,
  embedPdfFontStacks,
  pdfSafeText,
  type EmbeddedPdfFont,
  type PdfErrorFactory,
} from "./pdfText.js";
import {
  displayPointToUser,
  displayRectToUserBox,
  displaySize,
  normalizePageRotation,
  pointInBox,
  type PageBox,
} from "./pdfGeometry.js";

/**
 * Writing onto a PDF that has no form fields.
 *
 * `fill_pdf_form` can only set values on fields the document already declares,
 * and most forms in the world declare none — they were laid out for a printer,
 * scanned, or exported from a word processor. For those, the only way to
 * complete the original document rather than retype it is to draw on top of
 * it: the source pages stay exactly as they are and become the background,
 * and answers are placed at coordinates over them.
 *
 * ## Coordinates
 *
 * Every coordinate in and out of here is **display space** — points from the
 * top-left corner of the page as it appears on screen, `/Rotate` already
 * applied. That is the space `read_pdf_layout` reports, so the intended motion
 * is to read a label's box from the layout and hand a point beside it straight
 * back here. `services/pdfGeometry.ts` does the conversion into the unrotated,
 * bottom-left user space that pdf-lib actually draws in.
 *
 * ## What it refuses
 *
 * Failing loudly beats a silently wrong document, because nobody re-reads a
 * form they asked an employee to fill. Anything unrenderable — a page that
 * does not exist, a character no shipped face covers, a nonsense size — is an
 * error before a single byte is drawn. Placement that is merely *suspicious*,
 * such as a line that runs off the page, is drawn but reported back as a
 * warning, since the caller may have meant it and only it can tell.
 */

export class PdfOverlayError extends Error {
  /** Read by `middleware/error.ts`; every one of these is a caller mistake. */
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "PdfOverlayError";
  }
}

const fail: PdfErrorFactory = (message) => new PdfOverlayError(message);

/** Ceilings that keep one tool call from producing an unusable document. */
export const MAX_OVERLAY_ITEMS = 500;
export const MAX_OVERLAY_TEXT_LENGTH = 4_000;
export const MIN_FONT_SIZE = 1;
export const MAX_FONT_SIZE = 300;
export const DEFAULT_FONT_SIZE = 11;
export const DEFAULT_MARK_SIZE = 12;

export interface OverlayItemBase {
  /** 1-based page number, matching what a reader would call it. */
  page: number;
  /** Points from the page's left edge, as displayed. */
  x: number;
  /** Points from the page's top edge, as displayed. */
  y: number;
  /** `#rgb`, `#rrggbb`, or a common colour name. Defaults to black. */
  color?: string;
}

export interface OverlayTextItem extends OverlayItemBase {
  type?: "text";
  text: string;
  /** Point size. Defaults to {@link DEFAULT_FONT_SIZE}. */
  size?: number;
  /** Wrap into a column this wide. Omit to draw a single line per newline. */
  maxWidth?: number;
  /** Baseline-to-baseline distance. Defaults to the font's natural leading. */
  lineHeight?: number;
  /** Horizontal placement relative to `x`, or to the `maxWidth` column. */
  align?: "left" | "center" | "right";
  /**
   * What `y` measures. `"top"` (the default) is the top of the line box, which
   * is what `read_pdf_layout` reports as `y`; `"baseline"` is the line the
   * glyphs sit on, which it reports as `baselineY`. Either one read from the
   * layout and handed back here lands on the line it came from.
   */
  anchor?: "top" | "baseline";
}

export interface OverlayMarkItem extends OverlayItemBase {
  type: "check" | "cross";
  /** Side length of the mark's square. Defaults to {@link DEFAULT_MARK_SIZE}. */
  size?: number;
  /** Stroke width. Defaults to a tenth of the mark size. */
  thickness?: number;
}

export type OverlayItem = OverlayTextItem | OverlayMarkItem;

export interface OverlayResult {
  bytes: Uint8Array;
  pageCount: number;
  /** Placements that worked but look like mistakes. Never fatal. */
  warnings: string[];
}

const NAMED_COLORS: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#d40000",
  green: "#00802b",
  blue: "#0000d4",
  navy: "#001f5b",
  grey: "#666666",
  gray: "#666666",
};

/**
 * Accept the colours a caller actually writes.
 *
 * A model asked to sign a form in blue writes `"blue"` far more often than
 * `"#0000d4"`, and refusing that would cost a round trip to learn a syntax
 * that buys nobody anything.
 */
export function parseOverlayColor(raw: string | undefined): ReturnType<typeof rgb> {
  if (raw === undefined) return rgb(0, 0, 0);
  const value = raw.trim().toLowerCase();
  const hex = NAMED_COLORS[value] ?? value;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(hex);
  if (!match) {
    throw fail(
      `\`${raw}\` is not a colour. Use #rrggbb, or one of: ${Object.keys(NAMED_COLORS).join(", ")}.`,
    );
  }
  const digits =
    match[1].length === 3
      ? [...match[1]].map((character) => character + character).join("")
      : match[1];
  const channel = (offset: number) => parseInt(digits.slice(offset, offset + 2), 16) / 255;
  return rgb(channel(0), channel(2), channel(4));
}

function isMark(item: OverlayItem): item is OverlayMarkItem {
  return item.type === "check" || item.type === "cross";
}

function requireFinite(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw fail(`${label} must be a finite number`);
  }
  return value;
}

function resolveSize(raw: number | undefined, fallback: number, label: string): number {
  if (raw === undefined) return fallback;
  const size = requireFinite(raw, label);
  if (size < MIN_FONT_SIZE || size > MAX_FONT_SIZE) {
    throw fail(`${label} must be between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE} points`);
  }
  return size;
}

/** The page box a renderer displays, with its rotation folded to a quarter turn. */
export function pageBoxFor(page: PDFPage): PageBox {
  const crop = page.getCropBox();
  let rotation;
  try {
    rotation = normalizePageRotation(page.getRotation().angle);
  } catch {
    throw fail("This PDF has a page rotated by something other than a quarter turn");
  }
  if (!(crop.width > 0) || !(crop.height > 0)) {
    throw fail("This PDF has a page with no usable area");
  }
  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height, rotation };
}

function warnIfOffPage(
  warnings: string[],
  box: PageBox,
  index: number,
  rect: { x: number; y: number; width: number; height: number },
): void {
  const display = displaySize(box);
  const overflows =
    rect.x < -0.5 ||
    rect.y < -0.5 ||
    rect.x + rect.width > display.width + 0.5 ||
    rect.y + rect.height > display.height + 0.5;
  if (!overflows) return;
  warnings.push(
    `Item ${index + 1} extends outside page ${Math.round(display.width)}×` +
      `${Math.round(display.height)}pt — part of it will not be visible.`,
  );
}

function drawTextItem(
  page: PDFPage,
  box: PageBox,
  renderer: PdfTextRenderer,
  item: OverlayTextItem,
  index: number,
  warnings: string[],
): void {
  const size = resolveSize(item.size, DEFAULT_FONT_SIZE, `Item ${index + 1} size`);
  const lineHeight =
    item.lineHeight === undefined
      ? renderer.lineHeight(size)
      : resolveSize(item.lineHeight, size, `Item ${index + 1} lineHeight`);
  const color = parseOverlayColor(item.color);
  const x = requireFinite(item.x, `Item ${index + 1} x`);
  const y = requireFinite(item.y, `Item ${index + 1} y`);

  let lines: string[];
  if (item.maxWidth === undefined) {
    lines = pdfSafeText(item.text, { allowNewlines: true, fail }).split("\n");
  } else {
    const maxWidth = requireFinite(item.maxWidth, `Item ${index + 1} maxWidth`);
    if (maxWidth <= 0) throw fail(`Item ${index + 1} maxWidth must be greater than zero`);
    lines = renderer.wrap(item.text, size, maxWidth);
  }

  const ascent = item.anchor === "baseline" ? 0 : renderer.ascent(size);
  const align = item.align ?? "left";
  const column = item.maxWidth;
  let widest = 0;

  lines.forEach((line, lineIndex) => {
    const width = line ? renderer.width(line, size) : 0;
    widest = Math.max(widest, width);
    let left = x;
    if (align === "center") left = column === undefined ? x - width / 2 : x + (column - width) / 2;
    else if (align === "right") left = column === undefined ? x - width : x + column - width;
    if (!line) return;
    const baseline = displayPointToUser(box, {
      x: left,
      y: y + lineIndex * lineHeight + ascent,
    });
    renderer.draw(page, line, {
      x: baseline.x,
      y: baseline.y,
      size,
      rotate: degrees(box.rotation),
      color,
    });
  });

  const blockWidth = column ?? widest;
  const blockLeft = column === undefined && align !== "left" ? x - (align === "center" ? widest / 2 : widest) : x;
  warnIfOffPage(warnings, box, index, {
    x: blockLeft,
    y: item.anchor === "baseline" ? y - renderer.ascent(size) : y,
    width: blockWidth,
    height: Math.max(lines.length - 1, 0) * lineHeight + renderer.lineHeight(size),
  });
}

function drawMarkItem(
  page: PDFPage,
  box: PageBox,
  item: OverlayMarkItem,
  index: number,
  warnings: string[],
): void {
  const size = resolveSize(item.size, DEFAULT_MARK_SIZE, `Item ${index + 1} size`);
  const thickness = resolveSize(item.thickness, Math.max(size / 10, 0.5), `Item ${index + 1} thickness`);
  const color = parseOverlayColor(item.color);
  const x = requireFinite(item.x, `Item ${index + 1} x`);
  const y = requireFinite(item.y, `Item ${index + 1} y`);

  // Marks are stroked as geometry rather than set as a glyph: a tick is not in
  // WinAnsi, and the faces that do carry one disagree about where it sits in
  // its em box, which is exactly the wrong thing to discover inside a
  // pre-printed checkbox.
  const stamp = displayRectToUserBox(box, { x, y, width: size, height: size });
  const segments: [number, number, number, number][] =
    item.type === "check"
      ? [
          [0.14, 0.52, 0.4, 0.2],
          [0.4, 0.2, 0.88, 0.76],
        ]
      : [
          [0.16, 0.16, 0.84, 0.84],
          [0.16, 0.84, 0.84, 0.16],
        ];
  for (const [x1, y1, x2, y2] of segments) {
    page.drawLine({
      start: pointInBox(stamp, x1 * size, y1 * size),
      end: pointInBox(stamp, x2 * size, y2 * size),
      thickness,
      color,
    });
  }
  warnIfOffPage(warnings, box, index, { x, y, width: size, height: size });
}

/**
 * Draw `items` onto `source` and return the new document's bytes.
 *
 * The source is modified in place rather than copied page by page, so
 * everything the original carries — its fonts, its images, its existing form
 * fields — is exactly what comes out the other side with the overlay on top.
 */
export async function overlayPdfText(
  source: Uint8Array | Buffer,
  items: OverlayItem[],
): Promise<OverlayResult> {
  if (!Array.isArray(items) || items.length === 0) {
    throw fail("Give at least one item to draw");
  }
  if (items.length > MAX_OVERLAY_ITEMS) {
    throw fail(`Too many items in one call — ${items.length} given, ${MAX_OVERLAY_ITEMS} allowed`);
  }

  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(source, { ignoreEncryption: true });
  } catch (err) {
    throw fail(`Could not parse PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pageCount = pdf.getPageCount();
  if (pageCount === 0) throw fail("This PDF has no pages");

  // Validate every item before drawing any of them: a document half-covered in
  // answers is harder to recover from than one that was refused.
  items.forEach((item, index) => {
    const label = `Item ${index + 1}`;
    if (!item || typeof item !== "object") throw fail(`${label} is not an object`);
    if (!Number.isInteger(item.page) || item.page < 1 || item.page > pageCount) {
      throw fail(`${label} names page ${item.page}, but this PDF has ${pageCount} page(s)`);
    }
    if (isMark(item)) return;
    if (typeof item.text !== "string" || item.text.length === 0) {
      throw fail(`${label} has no text to draw`);
    }
    if (item.text.length > MAX_OVERLAY_TEXT_LENGTH) {
      throw fail(`${label} is longer than ${MAX_OVERLAY_TEXT_LENGTH} characters`);
    }
    if (item.align && !["left", "center", "right"].includes(item.align)) {
      throw fail(`${label} has an unknown align "${item.align}"`);
    }
    if (item.anchor && !["top", "baseline"].includes(item.anchor)) {
      throw fail(`${label} has an unknown anchor "${item.anchor}"`);
    }
  });

  const texts = items.flatMap((item) => (isMark(item) ? [] : [item.text]));
  for (const [index, text] of texts.entries()) {
    await assertTextEmbeddable(text, `Item ${index + 1} text`, { allowNewlines: true, fail });
  }

  let stacks: { body: EmbeddedPdfFont[] } = { body: [] };
  if (texts.length > 0) {
    stacks = await embedPdfFontStacks(pdf, {
      body: { preferred: "regular", texts, fallback: ["arabic", "cjk"] },
    });
  }
  const renderer = new PdfTextRenderer(stacks.body, { fail, allowNewlines: true });

  const warnings: string[] = [];
  items.forEach((item, index) => {
    const page = pdf.getPage(item.page - 1);
    const box = pageBoxFor(page);
    if (isMark(item)) drawMarkItem(page, box, item, index, warnings);
    else drawTextItem(page, box, renderer, item, index, warnings);
  });

  return { bytes: await pdf.save(), pageCount, warnings };
}
