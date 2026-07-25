import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decodeHtmlEntities, stripHtml } from "./gmailClient.js";

describe("decodeHtmlEntities", () => {
  test("decodes Gmail snippet character references as plain text", () => {
    assert.equal(
      decodeHtmlEntities("Letting me know. If there&#39;s anything &amp; everything"),
      "Letting me know. If there's anything & everything",
    );
    assert.equal(
      decodeHtmlEntities("&quot;hello&quot; &lt;tag&gt; &apos;ok&apos;&nbsp;"),
      `"hello" <tag> 'ok' `,
    );
  });

  test("decodes decimal and hexadecimal Unicode references", () => {
    assert.equal(decodeHtmlEntities("Ready &#128640; &#x1F680;"), "Ready 🚀 🚀");
  });

  test("preserves unknown and invalid references", () => {
    assert.equal(
      decodeHtmlEntities("Keep &copy; &#x110000; &#55296;"),
      "Keep &copy; &#x110000; &#55296;",
    );
  });

  test("keeps HTML stripping entity decoding behavior", () => {
    assert.equal(stripHtml("<p>Tom &amp; Jerry. It&#39;s fine.</p>"), "Tom & Jerry. It's fine.");
  });
});
