import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { PDFDocument } from "pdf-lib";

import {
  PdfTextError,
  PdfTextRenderer,
  assertTextEmbeddable,
  embedPdfFontStacks,
  escapeUnembeddableText,
  pdfFontAssets,
  pdfSafeText,
  type EmbeddedPdfFont,
} from "./pdfText.js";

const BELL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

async function latinStack(): Promise<EmbeddedPdfFont[]> {
  const pdf = await PDFDocument.create();
  const stacks = await embedPdfFontStacks(pdf, {
    body: { preferred: "regular", texts: ["Ada Lovelace"], fallback: ["arabic", "cjk"] },
  });
  return stacks.body;
}

describe("pdfSafeText", () => {
  test("passes ordinary text through untouched", () => {
    assert.equal(pdfSafeText("Ada Lovelace"), "Ada Lovelace");
  });

  test("rejects control characters", () => {
    assert.throws(() => pdfSafeText(`Ada${BELL}Lovelace`), PdfTextError);
    assert.throws(() => pdfSafeText(`Ada${DEL}Lovelace`), PdfTextError);
  });

  test("rejects a newline unless the caller opts in", () => {
    assert.throws(() => pdfSafeText("one\ntwo"), PdfTextError);
    assert.equal(pdfSafeText("one\ntwo", { allowNewlines: true }), "one\ntwo");
  });

  test("normalizes Windows and classic Mac line endings", () => {
    assert.equal(pdfSafeText("one\r\ntwo\rthree", { allowNewlines: true }), "one\ntwo\nthree");
  });

  test("uses the caller's error type and label", () => {
    class Custom extends Error {}
    assert.throws(
      () => pdfSafeText(`a${BELL}`, { fail: (m) => new Custom(m), label: "Signer name" }),
      (err: Error) => {
        assert.ok(err instanceof Custom);
        assert.match(err.message, /^Signer name/);
        return true;
      },
    );
  });
});

describe("assertTextEmbeddable", () => {
  test("accepts every script the shipped faces cover", async () => {
    for (const value of ["Ada Lovelace", "مرحبا", "你好", "Grüße, Ada"]) {
      await assert.doesNotReject(() => assertTextEmbeddable(value, "Text"));
    }
  });

  test("names the code point it cannot render", async () => {
    await assert.rejects(
      () => assertTextEmbeddable("Signed 😀", "Item 1 text"),
      (err: Error) => {
        assert.ok(err instanceof PdfTextError);
        assert.match(err.message, /Item 1 text/);
        assert.match(err.message, /U\+1F600/);
        return true;
      },
    );
  });

  test("runs before anything is drawn, so a newline is allowed when opted in", async () => {
    await assert.doesNotReject(() =>
      assertTextEmbeddable("12 High St\nLondon", "Address", { allowNewlines: true }),
    );
  });
});

describe("escapeUnembeddableText", () => {
  test("escapes rather than refuses, for text that describes an input", async () => {
    const escaped = await escapeUnembeddableText(`ok${BELL}😀`);
    assert.match(escaped, /^ok/);
    assert.match(escaped, /\\u\{7\}/);
    assert.match(escaped, /\\u\{1F600\}/);
  });
});

describe("embedPdfFontStacks", () => {
  test("embeds only the faces the text needs", async () => {
    const pdf = await PDFDocument.create();
    const stacks = await embedPdfFontStacks(pdf, {
      body: { preferred: "regular", texts: ["Ada Lovelace"], fallback: ["arabic", "cjk"] },
    });
    // Pure Latin: no reason to carry Arabic or a 10MB CJK face.
    assert.equal(stacks.body.length, 1);
  });

  test("adds a fallback face only when a character needs it", async () => {
    const pdf = await PDFDocument.create();
    const stacks = await embedPdfFontStacks(pdf, {
      body: { preferred: "regular", texts: ["Ada مرحبا"], fallback: ["arabic", "cjk"] },
    });
    assert.equal(stacks.body.length, 2);
  });

  test("embeds a shared fallback once across groups", async () => {
    const pdf = await PDFDocument.create();
    const stacks = await embedPdfFontStacks(pdf, {
      first: { preferred: "regular", texts: ["مرحبا"], fallback: ["arabic"] },
      second: { preferred: "italic", texts: ["مرحبا"], fallback: ["arabic"] },
    });
    const arabicFirst = stacks.first.at(-1);
    const arabicSecond = stacks.second.at(-1);
    assert.ok(arabicFirst && arabicSecond);
    // Same PDFFont object: embedding twice would double the file's font bytes.
    assert.equal(arabicFirst.font, arabicSecond.font);
  });

  test("an empty group embeds nothing", async () => {
    const pdf = await PDFDocument.create();
    const stacks = await embedPdfFontStacks(pdf, {
      body: { preferred: "regular", texts: [], fallback: ["arabic"] },
    });
    assert.deepEqual(stacks.body, []);
  });
});

describe("PdfTextRenderer", () => {
  test("splits text into runs and measures them additively", async () => {
    const renderer = new PdfTextRenderer(await latinStack());
    const runs = renderer.runs("Ada", 12);
    assert.equal(runs.length, 1);
    assert.ok(runs[0].width > 0);
    const wide = renderer.width("Ada Lovelace", 12);
    const narrow = renderer.width("Ada", 12);
    assert.ok(wide > narrow, "longer text must measure wider");
  });

  test("width scales with point size", async () => {
    const renderer = new PdfTextRenderer(await latinStack());
    const small = renderer.width("Ada Lovelace", 10);
    const large = renderer.width("Ada Lovelace", 20);
    assert.ok(Math.abs(large - small * 2) < 0.01, `${large} vs ${small}`);
  });

  test("refuses a character the stack cannot render", async () => {
    const renderer = new PdfTextRenderer(await latinStack());
    assert.throws(() => renderer.runs("مرحبا", 12), /unsupported character/);
  });

  test("wraps on word boundaries and keeps every line inside the column", async () => {
    const renderer = new PdfTextRenderer(await latinStack());
    const lines = renderer.wrap("A rather long answer that will not fit on one line", 11, 120);
    assert.ok(lines.length > 1, "expected the text to wrap");
    for (const line of lines) {
      assert.ok(renderer.width(line, 11) <= 120.01, `line too wide: ${line}`);
    }
    assert.equal(
      lines.join(" ").replace(/\s+/g, " ").trim(),
      "A rather long answer that will not fit on one line",
    );
  });

  test("breaks a single word that is wider than the column", async () => {
    // A fixed-width box on a form cannot grow, so an unbreakable word has to
    // break rather than run into the next field.
    const renderer = new PdfTextRenderer(await latinStack());
    const lines = renderer.wrap(
      "Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch",
      11,
      60,
    );
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(renderer.width(line, 11) <= 60.01, `line too wide: ${line}`);
    }
  });

  test("keeps explicit paragraphs when wrapping", async () => {
    const renderer = new PdfTextRenderer(await latinStack(), { allowNewlines: true });
    const lines = renderer.wrap("12 High Street\nCambridge", 11, 400);
    assert.deepEqual(lines, ["12 High Street", "Cambridge"]);
  });

  test("keeps paragraphs in order when a later one has to wrap", async () => {
    // Guards the scoping of the over-wide break: it must only look at the
    // paragraph it is breaking, not re-flow everything emitted before it.
    const renderer = new PdfTextRenderer(await latinStack(), { allowNewlines: true });
    const lines = renderer.wrap("Ada Lovelace\nA much longer second line that wraps\nEnd", 11, 90);
    assert.equal(lines[0], "Ada Lovelace");
    assert.equal(lines.at(-1), "End");
    assert.ok(lines.length > 3, `expected the middle paragraph to wrap: ${JSON.stringify(lines)}`);
    for (const line of lines) {
      assert.ok(renderer.width(line, 11) <= 90.01, `line too wide: ${line}`);
    }
  });

  test("refuses a column with no width", async () => {
    const renderer = new PdfTextRenderer(await latinStack());
    assert.throws(() => renderer.wrap("Ada", 11, 0), /greater than zero/);
  });

  test("line metrics are positive and scale with size", async () => {
    const renderer = new PdfTextRenderer(await latinStack());
    assert.ok(renderer.ascent(12) > 0);
    assert.ok(renderer.lineHeight(12) > renderer.ascent(12));
    assert.ok(Math.abs(renderer.ascent(24) - renderer.ascent(12) * 2) < 0.01);
  });

  test("metrics stay sane with no font embedded", async () => {
    // A marks-only overlay builds a renderer with an empty stack.
    const renderer = new PdfTextRenderer([]);
    assert.ok(renderer.ascent(12) > 0);
    assert.ok(renderer.lineHeight(12) > 0);
  });

  test("the shipped faces parse and report usable metrics", async () => {
    const assets = await pdfFontAssets();
    for (const [key, asset] of Object.entries(assets)) {
      assert.ok(asset.bytes.length > 0, `${key} has no bytes`);
      assert.ok(asset.coverage.unitsPerEm > 0, `${key} has no unitsPerEm`);
    }
    assert.ok(assets.regular.coverage.hasGlyphForCodePoint(65));
    assert.ok(assets.arabic.coverage.hasGlyphForCodePoint(0x0645));
  });
});
