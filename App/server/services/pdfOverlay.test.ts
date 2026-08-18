import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PDFDocument, PDFName, PDFNumber, StandardFonts, degrees } from "pdf-lib";

import {
  MAX_OVERLAY_ITEMS,
  MAX_OVERLAY_TEXT_LENGTH,
  PdfOverlayError,
  overlayPdfText,
  pageBoxFor,
  parseOverlayColor,
  type OverlayItem,
} from "./pdfOverlay.js";
import { displaySize } from "./pdfGeometry.js";

/**
 * A stand-in for the documents this tool exists for: a form laid out for a
 * printer, with printed labels and not one interactive field.
 */
async function blankForm(
  options: { rotation?: number; pages?: number; size?: [number, number] } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < (options.pages ?? 1); index += 1) {
    const page = doc.addPage(options.size ?? [612, 792]);
    if (options.rotation) page.setRotation(degrees(options.rotation));
    page.drawText("Full name:", { x: 72, y: 700, size: 12, font });
    page.drawText("Company:", { x: 72, y: 660, size: 12, font });
  }
  return doc.save();
}

async function pageCountOf(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPageCount();
}

/**
 * Overrides are deliberately untyped: half of these tests hand the engine
 * values TypeScript would reject, because a model's arguments arrive as JSON
 * and the runtime guard is what actually has to catch them.
 */
const textItem = (over: Record<string, unknown> = {}): OverlayItem =>
  ({ page: 1, x: 200, y: 92, text: "Ada Lovelace", ...over }) as OverlayItem;

describe("parseOverlayColor", () => {
  test("defaults to black", () => {
    assert.deepEqual(parseOverlayColor(undefined), { type: "RGB", red: 0, green: 0, blue: 0 });
  });

  test("accepts long and short hex, case-insensitively", () => {
    assert.deepEqual(parseOverlayColor("#ffffff"), { type: "RGB", red: 1, green: 1, blue: 1 });
    assert.deepEqual(parseOverlayColor("#FFF"), { type: "RGB", red: 1, green: 1, blue: 1 });
    assert.deepEqual(parseOverlayColor("  #000  "), { type: "RGB", red: 0, green: 0, blue: 0 });
  });

  test("accepts the colour names a caller actually writes", () => {
    // A model asked to sign in blue writes "blue", not "#0000d4".
    for (const name of ["black", "white", "red", "green", "blue", "navy", "grey", "gray"]) {
      assert.doesNotThrow(() => parseOverlayColor(name));
    }
    assert.deepEqual(parseOverlayColor("BLUE"), parseOverlayColor("#0000d4"));
  });

  test("refuses anything else, and says what is allowed", () => {
    assert.throws(
      () => parseOverlayColor("chartreuse"),
      (err: Error) => {
        assert.ok(err instanceof PdfOverlayError);
        assert.match(err.message, /#rrggbb/);
        return true;
      },
    );
    assert.throws(() => parseOverlayColor("#12"), PdfOverlayError);
    assert.throws(() => parseOverlayColor("rgb(1,2,3)"), PdfOverlayError);
  });
});

describe("pageBoxFor", () => {
  test("reports the crop box and a normalized rotation", async () => {
    const doc = await PDFDocument.load(await blankForm({ rotation: 270 }));
    const box = pageBoxFor(doc.getPage(0));
    assert.equal(box.rotation, 270);
    assert.equal(box.width, 612);
    assert.equal(box.height, 792);
    assert.deepEqual(displaySize(box), { width: 792, height: 612 });
  });

  test("refuses a page rotated by something other than a quarter turn", async () => {
    // pdf-lib refuses to *write* this, so it is set on the page dictionary
    // directly — which is how such a file reaches us in the first place.
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of("Rotate"), PDFNumber.of(45));
    assert.throws(() => pageBoxFor(page), PdfOverlayError);
  });

  test("folds a full turn and a negative rotation onto a quarter turn", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of("Rotate"), PDFNumber.of(-90));
    assert.equal(pageBoxFor(page).rotation, 270);
    page.node.set(PDFName.of("Rotate"), PDFNumber.of(360));
    assert.equal(pageBoxFor(page).rotation, 0);
  });
});

describe("overlayPdfText - validation", () => {
  test("refuses an empty item list", async () => {
    const source = await blankForm();
    await assert.rejects(() => overlayPdfText(source, []), PdfOverlayError);
  });

  test("refuses more items than the ceiling allows", async () => {
    const items = Array.from({ length: MAX_OVERLAY_ITEMS + 1 }, () => textItem());
    const source = await blankForm();
    await assert.rejects(
      () => overlayPdfText(source, items),
      (err: Error) => {
        assert.match(err.message, new RegExp(String(MAX_OVERLAY_ITEMS)));
        return true;
      },
    );
  });

  test("refuses a page number the document does not have", async () => {
    const source = await blankForm({ pages: 2 });
    for (const page of [0, -1, 3, 1.5]) {
      await assert.rejects(
        () => overlayPdfText(source, [textItem({ page })]),
        (err: Error) => {
          assert.ok(err instanceof PdfOverlayError);
          assert.match(err.message, /2 page\(s\)/);
          return true;
        },
      );
    }
  });

  test("refuses text that is missing, empty, or enormous", async () => {
    const source = await blankForm();
    await assert.rejects(() => overlayPdfText(source, [textItem({ text: "" })]), PdfOverlayError);
    await assert.rejects(
      () => overlayPdfText(source, [textItem({ text: undefined })]),
      PdfOverlayError,
    );
    await assert.rejects(
      () => overlayPdfText(source, [textItem({ text: "x".repeat(MAX_OVERLAY_TEXT_LENGTH + 1) })]),
      PdfOverlayError,
    );
  });

  test("refuses an unknown align or anchor", async () => {
    const source = await blankForm();
    await assert.rejects(
      () => overlayPdfText(source, [textItem({ align: "middle" })]),
      /unknown align/,
    );
    await assert.rejects(
      () => overlayPdfText(source, [textItem({ anchor: "centre" })]),
      /unknown anchor/,
    );
  });

  test("refuses coordinates and sizes that are not usable numbers", async () => {
    const source = await blankForm();
    await assert.rejects(() => overlayPdfText(source, [textItem({ x: Number.NaN })]), /finite/);
    await assert.rejects(
      () => overlayPdfText(source, [textItem({ y: Number.POSITIVE_INFINITY })]),
      /finite/,
    );
    await assert.rejects(() => overlayPdfText(source, [textItem({ size: 0 })]), /between/);
    await assert.rejects(() => overlayPdfText(source, [textItem({ size: 5_000 })]), /between/);
    await assert.rejects(() => overlayPdfText(source, [textItem({ maxWidth: -5 })]), /greater than/);
  });

  test("refuses control characters, but allows newlines", async () => {
    const source = await blankForm();
    const withBell = `Ada${String.fromCharCode(7)}Lovelace`;
    await assert.rejects(
      () => overlayPdfText(source, [textItem({ text: withBell })]),
      /control characters/,
    );
    await assert.doesNotReject(() =>
      overlayPdfText(source, [textItem({ text: "12 High St\nLondon" })]),
    );
  });

  test("refuses bytes that are not a PDF", async () => {
    await assert.rejects(
      () => overlayPdfText(Buffer.from("this is not a pdf"), [textItem()]),
      /Could not parse PDF/,
    );
  });

  test("nothing is drawn when any item is invalid", async () => {
    // The second item is bad; the first must not reach the page, because a
    // half-answered form is harder to recover from than a refused one.
    const source = await blankForm();
    await assert.rejects(() => overlayPdfText(source, [textItem(), textItem({ page: 99 })]));
    assert.equal(await pageCountOf(source), 1);
  });
});

describe("overlayPdfText - drawing", () => {
  test("returns a longer document that still parses and keeps its pages", async () => {
    const source = await blankForm({ pages: 3 });
    const result = await overlayPdfText(source, [textItem(), textItem({ page: 3 })]);
    assert.equal(result.pageCount, 3);
    assert.deepEqual(result.warnings, []);
    assert.equal(await pageCountOf(result.bytes), 3);
    assert.ok(result.bytes.length > 0);
  });

  test("draws on every rotation without complaint", async () => {
    for (const rotation of [0, 90, 180, 270]) {
      const source = await blankForm({ rotation });
      const result = await overlayPdfText(source, [textItem({ x: 100, y: 100 })]);
      assert.deepEqual(result.warnings, [], `rotation ${rotation}`);
      assert.equal(await pageCountOf(result.bytes), 1);
    }
  });

  test("draws checks and crosses", async () => {
    const source = await blankForm();
    const result = await overlayPdfText(source, [
      { page: 1, x: 90, y: 200, type: "check" },
      { page: 1, x: 90, y: 220, type: "cross", size: 8, thickness: 1.2, color: "red" },
    ]);
    assert.deepEqual(result.warnings, []);
    assert.equal(await pageCountOf(result.bytes), 1);
  });

  test("wraps into a column and honours explicit newlines", async () => {
    const source = await blankForm();
    const wrapped = await overlayPdfText(source, [
      textItem({ text: "A rather long answer that will not fit on one line", maxWidth: 120 }),
    ]);
    assert.deepEqual(wrapped.warnings, []);
    const multiline = await overlayPdfText(source, [
      textItem({ text: "12 High Street\nCambridge\nCB2 1TN" }),
    ]);
    assert.deepEqual(multiline.warnings, []);
  });

  test("aligns without running off the column", async () => {
    const source = await blankForm();
    for (const align of ["left", "center", "right"] as const) {
      const result = await overlayPdfText(source, [textItem({ x: 200, maxWidth: 200, align })]);
      assert.deepEqual(result.warnings, [], align);
    }
  });

  test("writes non-Latin text by falling back to a face that covers it", async () => {
    const source = await blankForm();
    const result = await overlayPdfText(source, [textItem({ text: "مرحبا" })]);
    assert.deepEqual(result.warnings, []);
    assert.equal(await pageCountOf(result.bytes), 1);
  });

  test("refuses a character no shipped face can render, naming the code point", async () => {
    const source = await blankForm();
    await assert.rejects(
      () => overlayPdfText(source, [textItem({ text: "Signed 😀" })]),
      (err: Error) => {
        assert.ok(err instanceof PdfOverlayError);
        assert.match(err.message, /U\+1F600/);
        return true;
      },
    );
  });
});

describe("overlayPdfText - warnings", () => {
  test("warns when an item runs off the page but still produces the document", async () => {
    const source = await blankForm();
    const result = await overlayPdfText(source, [textItem({ x: 590, y: 92, text: "Overflowing" })]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /outside page 612/);
    assert.equal(await pageCountOf(result.bytes), 1);
  });

  test("warns about a negative coordinate", async () => {
    const source = await blankForm();
    const result = await overlayPdfText(source, [textItem({ x: -20 })]);
    assert.equal(result.warnings.length, 1);
  });

  test("names the item that overflowed", async () => {
    const source = await blankForm();
    const result = await overlayPdfText(source, [
      textItem({ x: 100, y: 100 }),
      textItem({ x: 100, y: 5_000 }),
    ]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /^Item 2/);
  });

  test("the displayed page size is what a rotated page is measured against", async () => {
    // 700pt across is inside a rotated Letter page (792 wide) and outside an
    // upright one (612 wide). Measuring against the stored box would get this
    // backwards on every scanned landscape form.
    const uprightSource = await blankForm();
    const upright = await overlayPdfText(uprightSource, [textItem({ x: 700, y: 100, text: "x" })]);
    assert.equal(upright.warnings.length, 1);
    const rotatedSource = await blankForm({ rotation: 90 });
    const rotated = await overlayPdfText(rotatedSource, [textItem({ x: 700, y: 100, text: "x" })]);
    assert.deepEqual(rotated.warnings, []);
  });
});
