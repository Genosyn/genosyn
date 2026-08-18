import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fontkit, { type Font as FontkitFont } from "@pdf-lib/fontkit";
import { PDFDocument, PDFFont, PDFPage, degrees, rgb } from "pdf-lib";

/**
 * Drawing text into a PDF: which font can render a character, how wide the
 * result is, where the lines break, and how to put it on a rotated page.
 *
 * This started inside `signing.ts`, which needed it to stamp a signer's name
 * onto a contract. The PDF overlay tools need exactly the same thing to write
 * an answer onto a form that has no fields, and a second copy of glyph
 * coverage and line breaking would be a second copy of every bug — the sort
 * that only shows up on the one document written in Arabic. So the toolkit
 * lives here and both callers share it.
 *
 * ## Why fonts are a fallback stack, not a font
 *
 * The 14 standard PDF fonts are WinAnsi-encoded: hand one a Chinese character
 * and pdf-lib throws mid-draw, after the caller has already committed to
 * writing. Genosyn ships Noto instead — Latin, Arabic and SC — and picks per
 * character, because no single one of those covers a form that mixes a Latin
 * company name with an Arabic address. Coverage is checked *before* anything
 * is drawn so an unsupported character is a clean error rather than a
 * half-written page.
 */

export class PdfTextError extends Error {
  /** Read by `middleware/error.ts`; these are all caller-fixable inputs. */
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "PdfTextError";
  }
}

/** Lets a caller keep its own error contract — signing maps these to 400s. */
export type PdfErrorFactory = (message: string) => Error;

const defaultFail: PdfErrorFactory = (message) => new PdfTextError(message);

export const PDF_FONT_FILES = {
  regular: "NotoSans-Regular.ttf",
  italic: "NotoSans-Italic.ttf",
  arabic: "NotoSansArabic-Regular.ttf",
  cjk: "NotoSansSC-Regular.ttf",
} as const;

export type PdfFontKey = keyof typeof PDF_FONT_FILES;

export interface PdfFontAsset {
  bytes: Uint8Array;
  coverage: FontkitFont;
}

export interface EmbeddedPdfFont extends PdfFontAsset {
  font: PDFFont;
}

let fontAssetsPromise: Promise<Record<PdfFontKey, PdfFontAsset>> | null = null;

export function pdfFontAssetDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../assets/fonts");
}

/**
 * Read and parse the shipped Noto faces once per process. Parsing is the
 * expensive half and the result is immutable, so the promise is cached rather
 * than the bytes — concurrent first calls share one read.
 */
export async function pdfFontAssets(): Promise<Record<PdfFontKey, PdfFontAsset>> {
  fontAssetsPromise ??= Promise.all(
    Object.entries(PDF_FONT_FILES).map(async ([key, filename]) => {
      const bytes = await fs.promises.readFile(path.join(pdfFontAssetDirectory(), filename));
      return [key, { bytes, coverage: fontkit.create(bytes) }] as const;
    }),
  ).then(
    (entries) =>
      Object.fromEntries(entries) as unknown as Record<PdfFontKey, PdfFontAsset>,
  );
  return fontAssetsPromise;
}

/** Test seam: forget the cache so a fixture can stand in for the assets. */
export function resetPdfFontAssetsForTests(): void {
  fontAssetsPromise = null;
}

function isControlCharacter(codePoint: number): boolean {
  return codePoint < 32 || codePoint === 127;
}

/**
 * Reject text a PDF content stream cannot carry.
 *
 * Control characters are the ones that matter: they survive JSON, so a model
 * or a pasted cell can deliver them, and they either vanish or corrupt the
 * stream. Newlines are the one exception a caller may opt into, because a
 * postal address on a form is genuinely multi-line.
 */
export function pdfSafeText(
  value: string,
  options: { allowNewlines?: boolean; fail?: PdfErrorFactory; label?: string } = {},
): string {
  const fail = options.fail ?? defaultFail;
  const label = options.label ?? "PDF text";
  const normalized = options.allowNewlines ? value.replace(/\r\n?/g, "\n") : value;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (options.allowNewlines && codePoint === 10) continue;
    if (isControlCharacter(codePoint)) {
      throw fail(`${label} cannot contain control characters`);
    }
  }
  return normalized;
}

function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Fail before drawing if any character has no glyph in any shipped face.
 *
 * Worth its own pass: `PdfTextRenderer` would throw at the same character,
 * but only once some of the page had already been written.
 */
export async function assertTextEmbeddable(
  text: string,
  label: string,
  options: { allowNewlines?: boolean; fail?: PdfErrorFactory } = {},
): Promise<void> {
  const fail = options.fail ?? defaultFail;
  const safe = pdfSafeText(text, { ...options, fail, label });
  const assets = await pdfFontAssets();
  const candidates = [assets.regular, assets.arabic, assets.cjk];
  for (const character of safe) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint === 10) continue;
    if (!candidates.some((entry) => entry.coverage.hasGlyphForCodePoint(codePoint))) {
      throw fail(
        `${label} contains a character that cannot be embedded in the PDF ` +
          `(${formatCodePoint(codePoint)})`,
      );
    }
  }
}

/**
 * Render anything unprintable as an escape rather than refusing the document.
 *
 * Used where the text is evidence *about* an input rather than an input — a
 * certificate page has to describe what was submitted even when what was
 * submitted was a control character.
 */
export async function escapeUnembeddableText(value: string): Promise<string> {
  const assets = await pdfFontAssets();
  const candidates = [assets.regular, assets.arabic, assets.cjk];
  let result = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (isControlCharacter(codePoint)) {
      result += `\\u{${codePoint.toString(16).toUpperCase()}}`;
      continue;
    }
    result += candidates.some((entry) => entry.coverage.hasGlyphForCodePoint(codePoint))
      ? character
      : `\\u{${codePoint.toString(16).toUpperCase()}}`;
  }
  return result;
}

export interface PdfFontStackRequest {
  /** The face this group reads in when the characters allow it. */
  preferred: PdfFontKey;
  /** Every string that will be drawn with this stack. */
  texts: string[];
  /** Tried in order for characters `preferred` cannot render. */
  fallback: PdfFontKey[];
}

/**
 * Embed only the faces the supplied text actually needs, and return each
 * group's lookup order.
 *
 * Embedding is per document and each face costs real bytes, so the needed set
 * is computed across *all* groups first and each face embedded once — two
 * groups that both fall back to Arabic share one embed.
 */
export async function embedPdfFontStacks<K extends string>(
  pdf: PDFDocument,
  groups: Record<K, PdfFontStackRequest>,
): Promise<Record<K, EmbeddedPdfFont[]>> {
  const assets = await pdfFontAssets();
  pdf.registerFontkit(fontkit);

  const needed = new Set<PdfFontKey>();
  for (const request of Object.values<PdfFontStackRequest>(groups)) {
    if (request.texts.some(Boolean)) needed.add(request.preferred);
    for (const value of request.texts) {
      for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (
          codePoint === undefined ||
          assets[request.preferred].coverage.hasGlyphForCodePoint(codePoint)
        ) {
          continue;
        }
        const cover = request.fallback.find((key) =>
          assets[key].coverage.hasGlyphForCodePoint(codePoint),
        );
        // A character no face covers is left alone: callers either preflighted
        // it with assertTextEmbeddable or escape it before drawing.
        if (cover) needed.add(cover);
      }
    }
  }

  const embeddedEntries = await Promise.all(
    [...needed].map(
      async (key) =>
        [
          key,
          {
            ...assets[key],
            // fontkit's CJK subset output silently drops glyphs in common PDF
            // viewers. Embed Noto Sans SC intact whenever CJK text is present;
            // the smaller Latin and Arabic fonts remain compact subsets.
            font: await pdf.embedFont(assets[key].bytes, { subset: key !== "cjk" }),
          },
        ] as const,
    ),
  );
  const embedded = Object.fromEntries(embeddedEntries) as Partial<
    Record<PdfFontKey, EmbeddedPdfFont>
  >;

  const stacks = {} as Record<K, EmbeddedPdfFont[]>;
  for (const [name, request] of Object.entries<PdfFontStackRequest>(groups)) {
    stacks[name as K] = [request.preferred, ...request.fallback].flatMap((key) =>
      embedded[key] ? [embedded[key] as EmbeddedPdfFont] : [],
    );
  }
  return stacks;
}

export interface PdfTextRun {
  text: string;
  font: PDFFont;
  width: number;
}

export interface DrawPdfTextOptions {
  x: number;
  y: number;
  size: number;
  rotate?: ReturnType<typeof degrees>;
  color?: ReturnType<typeof rgb>;
}

/**
 * One embedded fallback stack, plus the error contract of whoever built it.
 *
 * Measuring and drawing have to agree about which face renders which
 * character or wrapped lines come out the wrong width, so both go through the
 * same run splitter here.
 */
export class PdfTextRenderer {
  constructor(
    private readonly fonts: EmbeddedPdfFont[],
    private readonly options: { fail?: PdfErrorFactory; allowNewlines?: boolean } = {},
  ) {}

  private get fail(): PdfErrorFactory {
    return this.options.fail ?? defaultFail;
  }

  /** Split text into maximal runs that share one face. */
  runs(text: string, size: number): PdfTextRun[] {
    const safe = pdfSafeText(text, { ...this.options, fail: this.fail });
    const runs: PdfTextRun[] = [];
    for (const character of safe) {
      const codePoint = character.codePointAt(0);
      if (codePoint === undefined) continue;
      if (codePoint === 10) {
        throw this.fail("PDF text runs cannot span a line break — wrap the text first");
      }
      const entry = this.fonts.find((candidate) =>
        candidate.coverage.hasGlyphForCodePoint(codePoint),
      );
      if (!entry) {
        throw this.fail(
          `PDF text contains an unsupported character (${formatCodePoint(codePoint)})`,
        );
      }
      const previous = runs.at(-1);
      if (previous?.font === entry.font) previous.text += character;
      else runs.push({ text: character, font: entry.font, width: 0 });
    }
    for (const run of runs) run.width = run.font.widthOfTextAtSize(run.text, size);
    return runs;
  }

  /**
   * Distance from the top of a line box down to the baseline.
   *
   * Taken from the primary face only, deliberately: a line that mixed Latin
   * and CJK would otherwise sit on two different baselines depending on which
   * character happened to come first.
   */
  ascent(size: number): number {
    const primary = this.fonts[0];
    if (!primary) return size;
    return (primary.coverage.ascent / primary.coverage.unitsPerEm) * size;
  }

  /** The face's own natural leading, used when a caller does not set one. */
  lineHeight(size: number): number {
    const primary = this.fonts[0];
    if (!primary) return size * 1.2;
    const { ascent, descent, lineGap, unitsPerEm } = primary.coverage;
    return ((ascent - descent + (lineGap ?? 0)) / unitsPerEm) * size;
  }

  width(text: string, size: number): number {
    return this.runs(text, size).reduce((sum, run) => sum + run.width, 0);
  }

  /**
   * Break text to fit `maxWidth`, preferring word boundaries.
   *
   * Falls back to breaking mid-word when a single word is wider than the
   * column: a form's box is a fixed width, and text that overflows it silently
   * is worse than text that breaks awkwardly inside it.
   */
  wrap(text: string, size: number, maxWidth: number): string[] {
    const safe = pdfSafeText(text, { ...this.options, fail: this.fail });
    if (!safe.length) return [""];
    if (!(maxWidth > 0)) throw this.fail("PDF text wrap width must be greater than zero");
    const lines: string[] = [];
    for (const paragraph of safe.split("\n")) {
      if (!paragraph.length) {
        lines.push("");
        continue;
      }
      // Break on word boundaries first. Split keeping the separators so a run
      // of spaces is a candidate break rather than something to re-guess.
      const broken: string[] = [];
      let line = "";
      for (const word of paragraph.split(/(\s+)/)) {
        if (!word) continue;
        const candidate = line + word;
        if (!line.trim() || this.width(candidate, size) <= maxWidth) {
          line = candidate;
          continue;
        }
        broken.push(line.trimEnd());
        line = /^\s+$/.test(word) ? "" : word;
      }
      broken.push(line.trimEnd());

      // Then break anything still too wide — a single word longer than the
      // column. Scoped to this paragraph on purpose: re-measuring every line
      // produced so far, once per paragraph, is quadratic in a long address.
      for (const pending of broken) {
        if (this.width(pending, size) <= maxWidth || pending.length <= 1) {
          lines.push(pending);
          continue;
        }
        let chunk = "";
        for (const character of pending) {
          if (chunk && this.width(chunk + character, size) > maxWidth) {
            lines.push(chunk);
            chunk = character;
            continue;
          }
          chunk += character;
        }
        if (chunk) lines.push(chunk);
      }
    }
    while (lines.length > 1 && lines.at(-1) === "") lines.pop();
    return lines;
  }

  /** Draw one line, walking the baseline across each run's own face. */
  draw(page: PDFPage, text: string, options: DrawPdfTextOptions): void {
    let advance = 0;
    const angle = options.rotate?.angle ?? 0;
    const radians = (angle * Math.PI) / 180;
    for (const run of this.runs(text, options.size)) {
      page.drawText(run.text, {
        x: options.x + advance * Math.cos(radians),
        y: options.y + advance * Math.sin(radians),
        size: options.size,
        font: run.font,
        rotate: options.rotate,
        color: options.color,
      });
      advance += run.width;
    }
  }
}
