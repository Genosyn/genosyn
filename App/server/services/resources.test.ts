import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PDFDocument } from "pdf-lib";

import { pdfBufferToText } from "./resources.js";

/**
 * `pdfBufferToText` used to hand the caller's `Buffer` straight to the pdf.js
 * copy vendored inside `pdf-parse`, which does not survive the way Node
 * allocates small buffers — see the note on the function. It surfaced as
 * "Invalid PDF structure" thrown on a perfectly valid document, on some runs
 * and not others, on both the upload route and the AI `create_resource` path.
 *
 * Both tests below feed the parser exactly that shape: a PDF small enough that
 * `Buffer.from` serves it out of Node's shared allocation pool.
 */
describe("pdfBufferToText", () => {
  const SENTENCE = "Quarterly revenue summary";

  async function pooledPdfBytes(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    pdf.addPage([612, 792]).drawText(SENTENCE, { x: 48, y: 730, size: 18 });
    const bytes = Buffer.from(await pdf.save());
    assert.ok(
      bytes.byteLength < 4096,
      `fixture grew to ${bytes.byteLength} bytes and no longer comes from Node's buffer pool`,
    );
    return bytes;
  }

  test("extracts text from a pool-allocated buffer on every attempt", async () => {
    const bytes = await pooledPdfBytes();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const text = await pdfBufferToText(Buffer.from(bytes));
      assert.match(text, new RegExp(SENTENCE), `attempt ${attempt} lost the text`);
    }
  });

  test("extracts the same text from concurrent calls", async () => {
    const bytes = await pooledPdfBytes();
    const texts = await Promise.all(
      Array.from({ length: 6 }, () => pdfBufferToText(Buffer.from(bytes))),
    );
    for (const text of texts) assert.match(text, new RegExp(SENTENCE));
  });
});
