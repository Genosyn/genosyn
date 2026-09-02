import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resourceFileHeaders, safeFilename } from "./resourceFiles.js";

/**
 * `GET /resources/:slug/file` used to default to `Content-Disposition: inline`
 * and pin a Content-Type only for `pdf` and `epub`. Every other upload fell
 * through to `res.sendFile`, which types from the extension — and
 * `inferSourceKindFromFilename` classifies anything it does not recognise as
 * `text`, so a `.html` or `.svg` was served as itself, inline, from the origin
 * that holds the session cookie. Since M47 those bytes can arrive on an email
 * from a stranger.
 */
describe("resourceFileHeaders", () => {
  const base = { storageKey: "abcd.html", requested: "inline" as const };

  test("an uploaded HTML file downloads as opaque bytes", () => {
    const h = resourceFileHeaders({ ...base, sourceKind: "text", storedFilename: "notes.html" });
    assert.equal(h.contentType, "application/octet-stream");
    assert.equal(h.disposition, "attachment");
    assert.equal(h.sandbox, true);
  });

  test("asking for inline does not talk an unrenderable kind into rendering", () => {
    for (const filename of ["x.html", "x.svg", "x.js", "x.xhtml"]) {
      const h = resourceFileHeaders({
        sourceKind: "text",
        storedFilename: filename,
        storageKey: `k${filename}`,
        requested: "inline",
      });
      assert.equal(h.disposition, "attachment", `${filename} must not render inline`);
      assert.equal(h.contentType, "application/octet-stream", `${filename} must not be typed`);
    }
  });

  test("the three kinds with a viewer still render", () => {
    const pdf = resourceFileHeaders({
      sourceKind: "pdf",
      storedFilename: "contract.pdf",
      storageKey: "k.pdf",
      requested: "inline",
    });
    assert.equal(pdf.contentType, "application/pdf");
    assert.equal(pdf.disposition, "inline");
    // A bare `sandbox` would break the browser's own PDF viewer.
    assert.equal(pdf.sandbox, false);

    const epub = resourceFileHeaders({
      sourceKind: "epub",
      storedFilename: "book.epub",
      storageKey: "k.epub",
      requested: "inline",
    });
    assert.equal(epub.contentType, "application/epub+zip");
    assert.equal(epub.disposition, "inline");
  });

  test("every video extension the ingester recognises has a content type", () => {
    // `inferSourceKindFromFilename` maps these five to `video`; the MIME map
    // omitted .mkv and .avi, which broke the detail page's <video> element.
    for (const ext of [".mp4", ".mov", ".webm", ".mkv", ".avi"]) {
      const h = resourceFileHeaders({
        sourceKind: "video",
        storedFilename: `clip${ext}`,
        storageKey: `k${ext}`,
        requested: "inline",
      });
      assert.notEqual(h.contentType, "application/octet-stream", `${ext} has no content type`);
      assert.equal(h.disposition, "inline");
    }
  });

  test("a viewer may still ask a renderable kind to download", () => {
    const h = resourceFileHeaders({
      sourceKind: "pdf",
      storedFilename: "contract.pdf",
      storageKey: "k.pdf",
      requested: "attachment",
    });
    assert.equal(h.disposition, "attachment");
  });

  test("a filename carrying CR/LF cannot reach the header", () => {
    // `res.setHeader` throws ERR_INVALID_CHAR rather than escaping, and the
    // handler is async and unguarded — so this hung the request.
    const h = resourceFileHeaders({
      sourceKind: "pdf",
      storedFilename: "in\r\nX-Injected: yes\r\nvoice.pdf",
      storageKey: "k.pdf",
      requested: "inline",
    });
    assert.ok(!h.filename.includes("\r"));
    assert.ok(!h.filename.includes("\n"));
    assert.ok(!h.filename.includes('"'));
  });

  test("a filename that sanitizes away falls back rather than emitting nothing", () => {
    assert.equal(safeFilename('"""', "download"), "download");
    const h = resourceFileHeaders({
      sourceKind: "text",
      storedFilename: null,
      storageKey: "9f2c.bin",
      requested: "inline",
    });
    assert.equal(h.filename, "9f2c.bin");
  });
});
