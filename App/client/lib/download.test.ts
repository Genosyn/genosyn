import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { attachmentFilename } from "./download.js";

describe("attachmentFilename", () => {
  test("reads the quoted name an invoice or estimate PDF is sent with", () => {
    assert.equal(
      attachmentFilename('attachment; filename="ACME-CORP-INV-0001.pdf"'),
      "ACME-CORP-INV-0001.pdf",
    );
    assert.equal(attachmentFilename('attachment; filename="draft.pdf"'), "draft.pdf");
  });

  test("reads an unquoted name, and one with escaped quotes", () => {
    assert.equal(attachmentFilename("attachment; filename=report.csv"), "report.csv");
    assert.equal(
      attachmentFilename('attachment; filename="say \\"hi\\".txt"; size=12'),
      'say "hi".txt',
    );
  });

  test("prefers the UTF-8 name over the plain fallback", () => {
    assert.equal(
      attachmentFilename(
        "attachment; filename=\"Cafe.pdf\"; filename*=UTF-8''Caf%C3%A9%20No%201.pdf",
      ),
      "Café No 1.pdf",
    );
  });

  test("falls back to the plain name when the UTF-8 one cannot be decoded", () => {
    assert.equal(
      attachmentFilename("attachment; filename=\"plain.pdf\"; filename*=UTF-8''bad%E0%A4%A.pdf"),
      "plain.pdf",
    );
  });

  test("gives null when there is no name to read", () => {
    assert.equal(attachmentFilename(null), null);
    assert.equal(attachmentFilename("attachment"), null);
    assert.equal(attachmentFilename('attachment; filename=""'), null);
  });
});
