/**
 * Page geometry for every subsystem that reads coordinates off a PDF or
 * writes them back onto one.
 *
 * Two coordinate systems meet here and they agree about almost nothing:
 *
 * - **User space** is what PDF drawing operators consume, and what pdf-lib's
 *   `drawText` / `drawLine` expect. Its origin is the bottom-left of the page
 *   box, y grows *upwards*, and it ignores `/Rotate` entirely — a page that
 *   displays sideways still has upright user space.
 * - **Display space** is the page as a human or a renderer sees it: origin
 *   top-left, y grows *downwards*, `/Rotate` already applied, so a landscape
 *   scan reports its width and height swapped relative to the stored box.
 *
 * Everything crossing a tool or UI boundary is display space, because it is
 * the only system a reader can reason about from looking at the page: "the
 * signature box is two-thirds down" is a display-space sentence. PDF.js hands
 * the signature editor display space, `read_pdf_layout` hands the model
 * display space, and `overlay_pdf_text` takes display space back. This module
 * is the one conversion between the two, which is what makes those three
 * agree — a coordinate read from one can be handed straight to another.
 *
 * It deliberately knows nothing about pdf-lib or PDF.js. Plain numbers in,
 * plain numbers out, so the arithmetic is testable without a document, and so
 * the two libraries can never drift apart on which corner is the origin.
 */

/** `/Rotate`, normalized. Clockwise, as PDF viewers apply it. */
export type PageRotation = 0 | 90 | 180 | 270;

/** The box a renderer displays — the CropBox — plus the page's `/Rotate`. */
export interface PageBox {
  /** Lower-left corner in user space. Non-zero on cropped or imposed PDFs. */
  x: number;
  y: number;
  /** Box size *before* rotation is applied. */
  width: number;
  height: number;
  rotation: PageRotation;
}

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

/**
 * A rectangle placed in user space, carrying the rotation its content must be
 * drawn at. `x`/`y` is the rect's own bottom-left corner *as it appears on the
 * displayed page*, which is the anchor pdf-lib rotates around — so passing
 * `rotate: degrees(rotation)` alongside puts upright content on a sideways
 * page. Local offsets within the rect go through {@link pointInBox}.
 */
export interface StampBox extends Rect {
  rotation: PageRotation;
}

export class PdfGeometryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfGeometryError";
  }
}

/**
 * Fold any `/Rotate` onto one of the four quarter turns.
 *
 * The spec requires a multiple of 90 and real files still carry 360, -90, or
 * a stray 0.0000001 from a generator's float math. Negative and over-full
 * turns are unambiguous, so they are normalized rather than refused; anything
 * that is genuinely not a quarter turn is a file we cannot place text on
 * predictably, and guessing would silently put a name in the margin.
 */
export function normalizePageRotation(angle: number): PageRotation {
  if (!Number.isFinite(angle)) {
    throw new PdfGeometryError("PDF page rotation must be a finite number of degrees");
  }
  const rounded = Math.round(angle);
  if (Math.abs(angle - rounded) > 0.01 || rounded % 90 !== 0) {
    throw new PdfGeometryError(
      `PDF page rotation must be a multiple of 90 degrees (got ${angle})`,
    );
  }
  const wrapped = ((rounded % 360) + 360) % 360;
  return wrapped as PageRotation;
}

/** The page's size as displayed: width and height swap on a quarter turn. */
export function displaySize(box: PageBox): { width: number; height: number } {
  return box.rotation === 90 || box.rotation === 270
    ? { width: box.height, height: box.width }
    : { width: box.width, height: box.height };
}

/**
 * Display space (top-left origin, y down) → user space (bottom-left, y up).
 *
 * The two steps are worth naming because reviewers keep collapsing them: flip
 * y against the *displayed* height, then undo `/Rotate` against the *stored*
 * width and height. Mixing those two sets of dimensions is the bug this
 * function exists to make impossible.
 */
export function displayPointToUser(box: PageBox, point: Point): Point {
  const display = displaySize(box);
  const px = point.x;
  const py = display.height - point.y;
  switch (box.rotation) {
    case 0:
      return { x: box.x + px, y: box.y + py };
    case 90:
      return { x: box.x + (box.width - py), y: box.y + px };
    case 180:
      return { x: box.x + (box.width - px), y: box.y + (box.height - py) };
    case 270:
      return { x: box.x + py, y: box.y + (box.height - px) };
  }
}

/** User space → display space. The exact inverse of {@link displayPointToUser}. */
export function userPointToDisplay(box: PageBox, point: Point): Point {
  const display = displaySize(box);
  const dx = point.x - box.x;
  const dy = point.y - box.y;
  let px: number;
  let py: number;
  switch (box.rotation) {
    case 0:
      px = dx;
      py = dy;
      break;
    case 90:
      px = dy;
      py = box.width - dx;
      break;
    case 180:
      px = box.width - dx;
      py = box.height - dy;
      break;
    case 270:
      px = box.height - dy;
      py = dx;
      break;
  }
  return { x: px, y: display.height - py };
}

/**
 * A display-space rectangle → the user-space {@link StampBox} to draw it in.
 *
 * The anchor is the rect's *bottom-left as displayed*, not its top-left, so
 * that content drawn at local (0, 0) and rotated by `rotation` lands where a
 * reader expects the rectangle to start.
 */
export function displayRectToUserBox(box: PageBox, rect: Rect): StampBox {
  const anchor = displayPointToUser(box, { x: rect.x, y: rect.y + rect.height });
  return {
    x: anchor.x,
    y: anchor.y,
    width: rect.width,
    height: rect.height,
    rotation: box.rotation,
  };
}

/**
 * A point expressed in a {@link StampBox}'s own axes (x right, y up, origin at
 * the box's displayed bottom-left) → user space. This is how content inside a
 * rotated box is positioned without every caller redoing the trigonometry.
 */
export function pointInBox(box: StampBox, x: number, y: number): Point {
  const radians = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: box.x + x * cos - y * sin,
    y: box.y + x * sin + y * cos,
  };
}
