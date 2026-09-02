import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PDFDocument } from "pdf-lib";

import {
  RESOURCE_MAX_MATCHES,
  buildMatchSnippet,
  gradeExtraction,
  pdfBufferToText,
  windowText,
} from "./resources.js";

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

/**
 * M62 — passage retrieval and honest ingestion.
 *
 * These are pure functions over a string so they need no database: the point
 * of moving them out of the MCP handler was that the interesting behaviour is
 * arithmetic on offsets, and arithmetic is worth testing directly.
 */

describe("windowText", () => {
  const BODY = Array.from({ length: 500 }, (_, i) => `line ${i} of the document`).join("\n");

  test("pages a long body to completion without losing or repeating text", () => {
    let offset = 0;
    let seen = "";
    let guard = 0;
    for (;;) {
      const win = windowText(BODY, { offset, maxChars: 1_000 });
      seen += win.text;
      assert.equal(win.windowStart, offset === 0 ? 0 : win.windowStart);
      if (!win.hasMore) break;
      assert.ok(win.nextOffset !== null, "hasMore implies a nextOffset");
      assert.ok(win.nextOffset > offset, "nextOffset must advance");
      offset = win.nextOffset;
      guard += 1;
      assert.ok(guard < 1_000, "paging did not terminate");
    }
    assert.equal(seen, BODY, "concatenated windows must reconstruct the body exactly");
  });

  test("reports the whole length, not the window length", () => {
    const win = windowText(BODY, { maxChars: 100 });
    assert.equal(win.bodyLength, BODY.length);
    assert.ok(win.text.length <= 100);
    assert.equal(win.hasMore, true);
  });

  test("never splits a surrogate pair", () => {
    // Each emoji is two UTF-16 code units, so an odd cap lands mid-pair.
    const emoji = "🙂".repeat(50);
    const win = windowText(emoji, { maxChars: 7 });
    assert.equal(win.text.length % 2, 0, "a lone surrogate escaped the window");
    for (const ch of win.text) assert.notEqual(ch, "�");
    const rest = windowText(emoji, { offset: win.nextOffset ?? 0, maxChars: 7 });
    assert.equal(rest.text.length % 2, 0);
  });

  test("`around` centres the window on the phrase", () => {
    const body = "a".repeat(50_000) + " NEEDLE HERE " + "b".repeat(50_000);
    const win = windowText(body, { around: "needle here", maxChars: 2_000 });
    assert.ok(win.text.includes("NEEDLE HERE"), "the phrase must be inside the window");
    assert.ok(win.windowStart > 0, "the window should not start at the top of the body");
  });

  test("an offset past the end returns an empty final window", () => {
    const win = windowText("short", { offset: 999 });
    assert.equal(win.text, "");
    assert.equal(win.hasMore, false);
    assert.equal(win.nextOffset, null);
  });
});

describe("buildMatchSnippet", () => {
  test("finds a hit case-insensitively and reports where it is", () => {
    const body = "x".repeat(1_000) + " Our Refund Policy is thirty days. " + "y".repeat(1_000);
    const match = buildMatchSnippet(body, ["refund"]);
    assert.ok(match, "expected a match");
    assert.ok(match.snippet.toLowerCase().includes("refund"));
    assert.equal(body.slice(match.bodyOffset, match.bodyOffset + 6), "Refund");
  });

  test("bodyOffset round-trips through windowText", () => {
    const body = "z".repeat(80_000) + " the quarterly target is 40%. " + "z".repeat(80_000);
    const match = buildMatchSnippet(body, ["quarterly target"]);
    assert.ok(match);
    const win = windowText(body, { offset: match.bodyOffset, maxChars: 500 });
    assert.ok(
      win.text.includes("quarterly target"),
      "a search hit's offset must land the reader on the passage",
    );
  });

  test("stops counting at the cap rather than walking the whole body", () => {
    const match = buildMatchSnippet("needle ".repeat(5_000), ["needle"]);
    assert.ok(match);
    assert.equal(match.matchCount, RESOURCE_MAX_MATCHES);
  });

  test("returns null when nothing matches, and survives regex metacharacters", () => {
    assert.equal(buildMatchSnippet("plain text", ["absent"]), null);
    assert.equal(buildMatchSnippet("cost is $5 (net)", ["nomatch("]), null);
    const match = buildMatchSnippet("cost is $5 (net)", ["$5 (net)"]);
    assert.ok(match, "a query full of metacharacters must match literally");
  });
});

describe("gradeExtraction", () => {
  test("an empty extraction is a failure, not a Ready row", () => {
    // pdf-parse returns "\n\n" for a scan with no text layer — it does not
    // throw, which is how these rows used to be saved as Ready and silently
    // never matched a search.
    const graded = gradeExtraction("\n\n".trim(), "pdf");
    assert.equal(graded.status, "failed");
    assert.match(graded.errorMessage, /no text layer/i);
    assert.equal(graded.bodyText, "");
  });

  test("a JS-rendered page says so", () => {
    const graded = gradeExtraction("", "url");
    assert.equal(graded.status, "failed");
    assert.match(graded.errorMessage, /JavaScript/);
  });

  test("real text is still Ready", () => {
    const graded = gradeExtraction("The handbook says thirty days.", "pdf");
    assert.equal(graded.status, "ready");
    assert.equal(graded.errorMessage, "");
  });
});
