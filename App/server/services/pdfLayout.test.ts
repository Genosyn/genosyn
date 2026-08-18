import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PDFDocument, StandardFonts, degrees } from "pdf-lib";

import {
  PdfLayoutError,
  mergeAdjacentRuns,
  readPdfLayout,
  sortReadingOrder,
  type PdfLayoutTextItem,
} from "./pdfLayout.js";
import { overlayPdfText } from "./pdfOverlay.js";

async function printedForm(
  options: { rotation?: number; pages?: number; withFields?: boolean } = {},
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let index = 0; index < (options.pages ?? 1); index += 1) {
    const page = doc.addPage([612, 792]);
    if (options.rotation) page.setRotation(degrees(options.rotation));
    page.drawText("Full name:", { x: 72, y: 700, size: 12, font });
    page.drawText("Company:", { x: 72, y: 660, size: 12, font });
  }
  if (options.withFields) {
    doc.getForm().createTextField("applicant.name").addToPage(doc.getPage(0), {
      x: 200,
      y: 695,
      width: 200,
      height: 18,
    });
  }
  return doc.save();
}

const item = (over: Partial<PdfLayoutTextItem>): PdfLayoutTextItem => ({
  text: "x",
  x: 0,
  y: 0,
  width: 10,
  height: 12,
  baselineY: 100,
  fontSize: 12,
  ...over,
});

describe("sortReadingOrder", () => {
  test("goes down the page, then across", () => {
    const sorted = sortReadingOrder([
      item({ text: "c", baselineY: 200, x: 10 }),
      item({ text: "b", baselineY: 100, x: 300 }),
      item({ text: "a", baselineY: 100, x: 10 }),
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.text),
      ["a", "b", "c"],
    );
  });

  test("treats a sub-point wobble as the same line", () => {
    // Runs on one typeset line often differ by a fraction of a point; without
    // the band, a kerned word jumps ahead of the word it belongs after.
    const sorted = sortReadingOrder([
      item({ text: "second", baselineY: 100.4, x: 80 }),
      item({ text: "first", baselineY: 100, x: 10 }),
    ]);
    assert.deepEqual(
      sorted.map((entry) => entry.text),
      ["first", "second"],
    );
  });
});

describe("mergeAdjacentRuns", () => {
  test("stitches a label a content stream split for kerning", () => {
    const merged = mergeAdjacentRuns([
      item({ text: "Full", x: 72, width: 22 }),
      item({ text: " name", x: 94, width: 30 }),
      item({ text: ":", x: 124, width: 3 }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].text, "Full name:");
    assert.equal(merged[0].x, 72);
    assert.equal(merged[0].width, 127 - 72);
  });

  test("keeps a gap wide enough to write in as its own run", () => {
    // That gap is exactly where the answer goes, so collapsing it would hide
    // the one piece of geometry the caller came for.
    const merged = mergeAdjacentRuns([
      item({ text: "Full name:", x: 72, width: 55 }),
      item({ text: "Company:", x: 300, width: 50 }),
    ]);
    assert.equal(merged.length, 2);
  });

  test("does not merge across lines or across sizes", () => {
    assert.equal(
      mergeAdjacentRuns([
        item({ text: "a", x: 72, width: 10, baselineY: 700 }),
        item({ text: "b", x: 82, width: 10, baselineY: 680 }),
      ]).length,
      2,
    );
    assert.equal(
      mergeAdjacentRuns([
        item({ text: "a", x: 72, width: 10, fontSize: 12 }),
        item({ text: "b", x: 82, width: 10, fontSize: 24 }),
      ]).length,
      2,
    );
  });

  test("inserts a space when the gap is a word space, not a kern", () => {
    const merged = mergeAdjacentRuns([
      item({ text: "Ada", x: 72, width: 20, fontSize: 12 }),
      item({ text: "Lovelace", x: 94, width: 40, fontSize: 12 }),
    ]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].text, "Ada Lovelace");
  });
});

describe("readPdfLayout", () => {
  test("reports page geometry and the printed labels", async () => {
    const layout = await readPdfLayout(await printedForm());
    assert.equal(layout.pageCount, 1);
    assert.equal(layout.hasFormFields, false);
    assert.equal(layout.pages.length, 1);
    const page = layout.pages[0];
    assert.equal(page.page, 1);
    assert.equal(page.width, 612);
    assert.equal(page.height, 792);
    assert.equal(page.rotation, 0);
    assert.equal(page.truncated, false);
    const labels = page.texts.map((entry) => entry.text);
    assert.deepEqual(labels, ["Full name:", "Company:"]);
  });

  test("measures from the top edge, the way a reader would", async () => {
    const layout = await readPdfLayout(await printedForm());
    const [fullName, company] = layout.pages[0].texts;
    // Drawn at user-space y=700 and y=660 on a 792pt page, so the first label
    // is ~92pt down and the second ~40pt below it.
    assert.ok(Math.abs(fullName.baselineY - 92) < 1, `baseline ${fullName.baselineY}`);
    assert.ok(Math.abs(company.baselineY - 132) < 1, `baseline ${company.baselineY}`);
    assert.ok(fullName.y < fullName.baselineY, "top of the box sits above the baseline");
    assert.ok(Math.abs(fullName.x - 72) < 1, `x ${fullName.x}`);
    assert.ok(Math.abs(fullName.fontSize - 12) < 0.5, `size ${fullName.fontSize}`);
  });

  test("swaps the reported page size on a rotated page", async () => {
    for (const rotation of [90, 270]) {
      const layout = await readPdfLayout(await printedForm({ rotation }));
      assert.equal(layout.pages[0].width, 792, `rotation ${rotation}`);
      assert.equal(layout.pages[0].height, 612, `rotation ${rotation}`);
      assert.equal(layout.pages[0].rotation, rotation);
    }
  });

  test("says when the document has real form fields", async () => {
    // The caller should reach for fill_pdf_form instead of overlaying.
    const layout = await readPdfLayout(await printedForm({ withFields: true }));
    assert.equal(layout.hasFormFields, true);
  });

  test("reads only the pages asked for", async () => {
    const layout = await readPdfLayout(await printedForm({ pages: 4 }), { pages: [3, 1, 3] });
    assert.equal(layout.pageCount, 4);
    assert.deepEqual(
      layout.pages.map((page) => page.page),
      [1, 3],
    );
  });

  test("refuses a page the document does not have", async () => {
    await assert.rejects(
      () => readPdfLayout(printedForm().then((bytes) => bytes) as never, { pages: [9] }),
      () => true,
    );
    const source = await printedForm({ pages: 2 });
    await assert.rejects(
      () => readPdfLayout(source, { pages: [9] }),
      (err: Error) => {
        assert.ok(err instanceof PdfLayoutError);
        assert.match(err.message, /2 page\(s\)/);
        return true;
      },
    );
  });

  test("flags a page whose text was clipped", async () => {
    const layout = await readPdfLayout(await printedForm(), { maxItemsPerPage: 1 });
    assert.equal(layout.pages[0].texts.length, 1);
    assert.equal(layout.pages[0].truncated, true);
  });

  test("leaves the caller's bytes usable afterwards", async () => {
    // PDF.js transfers the buffer it is given. Reading a layout and then
    // drawing on the same bytes is the ordinary motion, so the source has to
    // survive the read.
    const source = await printedForm();
    const before = source.length;
    await readPdfLayout(source);
    assert.equal(source.length, before, "source buffer was detached by the read");
    await assert.doesNotReject(() =>
      overlayPdfText(source, [{ page: 1, x: 200, y: 92, text: "Ada Lovelace" }]),
    );
  });

  test("refuses bytes that are not a PDF", async () => {
    await assert.rejects(
      () => readPdfLayout(Buffer.from("not a pdf at all")),
      (err: Error) => {
        assert.ok(err instanceof PdfLayoutError);
        assert.match(err.message, /Could not parse PDF/);
        return true;
      },
    );
  });
});

describe("read and write agree", () => {
  test("text written at a display coordinate reads back at that coordinate", async () => {
    // The whole contract in one assertion: a position read from the layout can
    // be handed to the overlay and lands where it was read from. Two different
    // PDF libraries have to agree about rotation and the crop box for this to
    // hold, which is why it is checked on all four.
    for (const rotation of [0, 90, 180, 270]) {
      const source = await printedForm({ rotation });
      const written = await overlayPdfText(source, [
        { page: 1, x: 210, y: 140, text: "Ada Lovelace", size: 14 },
      ]);
      const layout = await readPdfLayout(written.bytes);
      const found = layout.pages[0].texts.find((entry) => entry.text.includes("Ada"));
      assert.ok(found, `rotation ${rotation}: written text not found`);
      assert.ok(Math.abs(found.x - 210) < 0.6, `rotation ${rotation}: x was ${found.x}`);
      assert.ok(Math.abs(found.y - 140) < 0.6, `rotation ${rotation}: y was ${found.y}`);
      assert.ok(
        Math.abs(found.fontSize - 14) < 0.5,
        `rotation ${rotation}: size was ${found.fontSize}`,
      );
    }
  });

  test("the baseline anchor round-trips too", async () => {
    const source = await printedForm();
    const layout = await readPdfLayout(source);
    const label = layout.pages[0].texts[0];
    // Write an answer on the label's own baseline, as a caller would.
    const written = await overlayPdfText(source, [
      {
        page: 1,
        x: 200,
        y: label.baselineY,
        anchor: "baseline",
        text: "Ada Lovelace",
        size: label.fontSize,
      },
    ]);
    const after = await readPdfLayout(written.bytes);
    const answer = after.pages[0].texts.find((entry) => entry.text.includes("Ada"));
    assert.ok(answer);
    assert.ok(
      Math.abs(answer.baselineY - label.baselineY) < 0.6,
      `baseline drifted to ${answer.baselineY} from ${label.baselineY}`,
    );
  });

  test("the original page content survives the overlay", async () => {
    const source = await printedForm();
    const written = await overlayPdfText(source, [
      { page: 1, x: 200, y: 92, text: "Ada Lovelace" },
    ]);
    const layout = await readPdfLayout(written.bytes);
    const labels = layout.pages[0].texts.map((entry) => entry.text);
    assert.ok(
      labels.some((label) => label.includes("Full name:")),
      `original labels lost: ${JSON.stringify(labels)}`,
    );
    assert.ok(labels.some((label) => label.includes("Company:")));
  });
});
