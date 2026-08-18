import { createRequire } from "node:module";
import path from "node:path";

import { PDFDocument } from "pdf-lib";

import { pdfFontAssets } from "./pdfText.js";

/**
 * Reading a PDF's page geometry and its text *with positions*.
 *
 * `read_pdf_fields` answers "what can I set on this form", and on a form with
 * no fields the answer is nothing. This answers the question that replaces it:
 * where on the page is each label, and how big is the gap after it. Without
 * that, placing text on a non-fillable form is guesswork — an employee would
 * be picking coordinates out of the air and nobody would know the name landed
 * in the margin until the counterparty said so.
 *
 * Coordinates come back in **display space** (points from the top-left of the
 * page as displayed, `/Rotate` applied), the same space `overlay_pdf_text`
 * accepts, so a position read here can be handed straight back there. Both
 * anchors round-trip exactly: `y` re-drawn as `anchor: "top"` and `baselineY`
 * re-drawn as `anchor: "baseline"` land on the line they were read from.
 *
 * PDF.js does the extraction because it is the only thing in the tree that
 * reports where a glyph run sits; pdf-lib can write a page but not read one.
 * It is loaded through its legacy build and run on this thread — the worker
 * entry point assumes a browser.
 */

const require = createRequire(import.meta.url);

/** One run of text and where it sits, in display space. */
export interface PdfLayoutTextItem {
  text: string;
  /** Left edge, points from the page's left edge. */
  x: number;
  /** Top of the line box, points from the page's top edge. */
  y: number;
  width: number;
  height: number;
  /** The baseline the run actually sits on. */
  baselineY: number;
  /** Point size, as rendered. */
  fontSize: number;
}

export interface PdfLayoutPage {
  /** 1-based, matching what a reader would call it. */
  page: number;
  /** Displayed size in points, with `/Rotate` applied. */
  width: number;
  height: number;
  rotation: number;
  texts: PdfLayoutTextItem[];
  /** True when `maxItemsPerPage` clipped the list. */
  truncated: boolean;
}

export interface PdfLayout {
  pageCount: number;
  /**
   * Whether the document declares an AcroForm with fields. When it does,
   * `fill_pdf_form` is the better tool and overlaying is a workaround.
   */
  hasFormFields: boolean;
  pages: PdfLayoutPage[];
}

export class PdfLayoutError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "PdfLayoutError";
  }
}

export const MAX_LAYOUT_ITEMS_PER_PAGE = 800;

interface PdfjsTextItem {
  str?: string;
  width?: number;
  height?: number;
  transform?: number[];
}

interface PdfjsPage {
  getViewport(options: { scale: number }): { width: number; height: number; rotation: number; transform: number[] };
  getTextContent(): Promise<{ items: PdfjsTextItem[] }>;
}

interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
}

interface PdfjsModule {
  getDocument(options: Record<string, unknown>): { promise: Promise<PdfjsDocument>; destroy(): Promise<void> };
  Util: { transform(a: number[], b: number[]): number[] };
}

/**
 * The legacy build, resolved lazily.
 *
 * Static typing is deliberately avoided: PDF.js' published types assume DOM
 * globals the server tsconfig does not carry, and the surface used here is
 * four functions wide.
 */
let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs" as string).then(
    (mod) => mod as unknown as PdfjsModule,
  );
  return pdfjsPromise;
}

function standardFontDataUrl(): string {
  // PDF.js needs the Type1 metrics for the 14 standard fonts to lay out text
  // that relies on them; without this it warns and falls back to estimates.
  return path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts/");
}

/**
 * Merge runs that a content stream split but a reader sees as one phrase.
 *
 * PDF.js reports what the stream contains, and a stream routinely emits
 * "Full", " name", ":" as three runs so it can kern between them. A model
 * searching for the label "Full name:" would find none of those, so runs on
 * one baseline with no meaningful gap are stitched back together.
 */
export function mergeAdjacentRuns(items: PdfLayoutTextItem[]): PdfLayoutTextItem[] {
  const merged: PdfLayoutTextItem[] = [];
  for (const item of items) {
    const previous = merged.at(-1);
    const sameLine =
      previous !== undefined &&
      Math.abs(previous.baselineY - item.baselineY) < 0.6 &&
      Math.abs(previous.fontSize - item.fontSize) < 0.6;
    const gap = previous ? item.x - (previous.x + previous.width) : 0;
    if (previous && sameLine && gap > -item.fontSize && gap < item.fontSize * 0.35) {
      // A gap wide enough to be a column, not a kern, stays a separate run —
      // that gap is exactly where an answer goes.
      const needsSpace = gap > item.fontSize * 0.08 && !/\s$/.test(previous.text);
      previous.text += (needsSpace ? " " : "") + item.text;
      previous.width = item.x + item.width - previous.x;
      previous.height = Math.max(previous.height, item.height);
      continue;
    }
    merged.push({ ...item });
  }
  return merged;
}

/** Reading order: down the page, then across. */
export function sortReadingOrder(items: PdfLayoutTextItem[]): PdfLayoutTextItem[] {
  return [...items].sort((left, right) => {
    // Bucket into lines before comparing x, so a run that sits a third of a
    // point higher than its neighbour does not jump the queue.
    const line = left.baselineY - right.baselineY;
    if (Math.abs(line) > 1.5) return line;
    return left.x - right.x;
  });
}

export interface ReadPdfLayoutOptions {
  /** 1-based page numbers to read. Defaults to every page. */
  pages?: number[];
  maxItemsPerPage?: number;
}

export async function readPdfLayout(
  source: Uint8Array | Buffer,
  options: ReadPdfLayoutOptions = {},
): Promise<PdfLayout> {
  const maxItems = options.maxItemsPerPage ?? MAX_LAYOUT_ITEMS_PER_PAGE;

  let hasFormFields = false;
  let pdfLibPageCount = 0;
  try {
    const doc = await PDFDocument.load(source, { ignoreEncryption: true });
    pdfLibPageCount = doc.getPageCount();
    hasFormFields = doc.getForm().getFields().length > 0;
  } catch (err) {
    throw new PdfLayoutError(
      `Could not parse PDF: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const assets = await pdfFontAssets();
  const ascentRatio = assets.regular.coverage.ascent / assets.regular.coverage.unitsPerEm;
  const descentRatio = assets.regular.coverage.descent / assets.regular.coverage.unitsPerEm;

  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    // Always a copy: PDF.js transfers the buffer it is handed and leaves the
    // caller holding a detached one. Reading a layout must not destroy the
    // bytes the caller is about to draw on.
    data: new Uint8Array(source),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: standardFontDataUrl(),
  });

  let document: PdfjsDocument;
  try {
    document = await task.promise;
  } catch (err) {
    await task.destroy().catch(() => {});
    throw new PdfLayoutError(
      `Could not read PDF text: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const pageCount = document.numPages || pdfLibPageCount;
    const wanted = options.pages?.length
      ? [...new Set(options.pages)].sort((a, b) => a - b)
      : Array.from({ length: pageCount }, (_, index) => index + 1);
    for (const pageNumber of wanted) {
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
        throw new PdfLayoutError(
          `Page ${pageNumber} does not exist — this PDF has ${pageCount} page(s)`,
        );
      }
    }

    const pages: PdfLayoutPage[] = [];
    for (const pageNumber of wanted) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const raw: PdfLayoutTextItem[] = [];
      for (const item of content.items) {
        const text = item.str ?? "";
        if (!text || !item.transform) continue;
        if (!text.trim()) continue;
        const matrix = pdfjs.Util.transform(viewport.transform, item.transform);
        const fontSize = Math.hypot(matrix[2], matrix[3]);
        if (!Number.isFinite(fontSize) || fontSize <= 0) continue;
        const baselineY = matrix[5];
        const width = item.width ?? 0;
        raw.push({
          text,
          x: matrix[4],
          y: baselineY - fontSize * ascentRatio,
          width,
          height: fontSize * (ascentRatio - descentRatio),
          baselineY,
          fontSize,
        });
      }
      const ordered = mergeAdjacentRuns(sortReadingOrder(raw));
      pages.push({
        page: pageNumber,
        width: viewport.width,
        height: viewport.height,
        rotation: ((viewport.rotation % 360) + 360) % 360,
        texts: ordered.slice(0, maxItems),
        truncated: ordered.length > maxItems,
      });
    }

    return { pageCount, hasFormFields, pages };
  } finally {
    await task.destroy().catch(() => {});
  }
}
